import { SUPPLIER_LIMITS } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { logger } from '../log.js';
import { normVendor } from '../plant/advisories/match.js';
import { catalogueTeams, owningTeams } from '../auth/policy.js';
import { nowIso, parseJson } from '../util.js';
import { insertSupplier } from './service.js';

/**
 * Free-text vendors become suppliers (0.17.0, ADR 0029 part 1). Before 0.17 a supplier was free text in five places;
 * on upgrade each distinct normalised text (normVendor of the advisories: letters and digits, legal forms left out)
 * becomes one supplier with status "unconfirmed" and the original spellings as aliases, the rows are linked, and the
 * text is recorded per table with its outcome in supplier_text_migrations – so a text is handled once. A text that
 * normalises to an existing supplier (its name or a spelling) links to that supplier. People then confirm, merge or
 * mark "not a supplier" under Suppliers → To confirm; the free text stays as a fallback either way.
 *
 * Team scope (security review 0.17.0, L6): a supplier is never seen by more people than the rows it is made from. Rows
 * are grouped by their text and by the teams that own the item they belong to (an application or system, the service
 * of a cost plan line, the platform of a page watch, a ticket reference); a new supplier gets exactly those owning
 * teams – none for items of the whole instance. The same text in items of different teams makes one supplier per team
 * set, which people merge under To confirm. A text that matches an existing supplier links to it as before (the
 * supplier is there already); its spellings join the supplier's only from items of the whole instance.
 *
 * Runs once the vault is open (the audit log needs its key) and after a migration package is imported, like
 * migrateMonitorWindows (ADR 0018). Returns the number of suppliers made.
 */

/** The five free-text vendors: table, the columns that identify a row, the text column. */
export const VENDOR_TEXT_TABLES = [
  { table: 'applications', key: ['id'] },
  { table: 'systems', key: ['id'] },
  { table: 'ticket_refs', key: ['id'] },
  { table: 'cd_watches', key: ['platform_id', 'uuid'] },
  { table: 'cost_plan_lines', key: ['id'] },
] as const;

type TextRow = Record<string, string> & { vendor: string };

/** The owning teams of the item a row belongs to (ids, sorted); empty: the whole instance's. */
function rowTeams(table: string, r: TextRow): string[] {
  const ids = (l: { id: string }[]) => [...new Set(l.map((t) => t.id))].sort();
  switch (table) {
    case 'applications':
      return ids(catalogueTeams('application', r.id!));
    case 'systems':
      return ids(catalogueTeams('system', r.id!));
    case 'ticket_refs':
      return ids(owningTeams('ticket', r.id!));
    case 'cd_watches':
      return ids(owningTeams('platform', r.platform_id!));
    case 'cost_plan_lines': {
      const l = db().get<{ service_id: string }>('SELECT service_id FROM cost_plan_lines WHERE id = ?', r.id!);
      return l ? ids(owningTeams('service', l.service_id)) : [];
    }
    default:
      return [];
  }
}

/** The most frequent spelling (ties: the first in alphabetical order), trimmed – the name of a new supplier. */
function nameOf(spellings: Map<string, number>): string {
  return [...spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
}

export function migrateVendorTexts(): number {
  // nothing to do (the common case after the first start): one cheap query per table
  const pending = VENDOR_TEXT_TABLES.map((t) => ({
    ...t,
    rows: db().all<TextRow>(`SELECT ${t.key.join(', ')}, vendor FROM ${t.table} WHERE supplier_id IS NULL AND vendor <> ''`),
  })).filter((t) => t.rows.length);
  if (!pending.length) return 0;
  const done = db().all<{ table_name: string; norm_text: string; outcome: string }>('SELECT table_name, norm_text, outcome FROM supplier_text_migrations');
  const handled = new Set(done.map((r) => `${r.table_name}\u0000${r.norm_text}`));
  // a text someone marked "not a supplier" is not made a supplier again from another table
  const notSupplier = new Set(done.filter((r) => r.outcome === 'notSupplier').map((r) => r.norm_text));
  // per table, the texts not handled yet: normalised text → spellings (with counts) and rows
  // … and by the owning teams of their items (a supplier is seen by no more people than its rows)
  const work: { table: string; key: readonly string[]; norm: string; teams: string[]; spellings: Map<string, number>; rows: TextRow[] }[] = [];
  for (const t of pending) {
    const groups = new Map<string, { norm: string; teams: string[]; spellings: Map<string, number>; rows: TextRow[] }>();
    for (const r of t.rows) {
      const text = r.vendor.trim().replace(/\s+/g, ' ');
      if (!text) continue;
      const norm = normVendor(text);
      if (handled.has(`${t.table}\u0000${norm}`)) continue;
      const teams = rowTeams(t.table, r);
      const k = `${norm}\u0000${teams.join(',')}`;
      const g = groups.get(k) ?? { norm, teams, spellings: new Map<string, number>(), rows: [] };
      g.spellings.set(text, (g.spellings.get(text) ?? 0) + 1);
      g.rows.push(r);
      groups.set(k, g);
    }
    for (const g of groups.values()) work.push({ table: t.table, key: t.key, ...g });
  }
  if (!work.length) return 0;
  let made = 0;
  db().tx(() => {
    // existing suppliers by their normalised name and spellings (archived ones too: a text is not split off them)
    const known = new Map<string, string>();
    for (const s of db().all<{ id: string; name: string; norm_name: string; aliases: string }>(
      'SELECT id, name, norm_name, aliases FROM suppliers ORDER BY created_at, id',
    )) {
      for (const n of [s.norm_name, ...parseJson<string[]>(s.aliases, []).map(normVendor)]) if (n && !known.has(n)) known.set(n, s.id);
    }
    // the same normalised text in several tables (of items of the same teams) becomes one supplier: all their spellings
    const scopeOf = (w: { norm: string; teams: string[] }) => `${w.norm}\u0000${w.teams.join(',')}`;
    const allSpellings = new Map<string, Map<string, number>>();
    for (const w of work) {
      const m = allSpellings.get(scopeOf(w)) ?? new Map<string, number>();
      for (const [k, v] of w.spellings) m.set(k, (m.get(k) ?? 0) + v);
      allSpellings.set(scopeOf(w), m);
    }
    const created = new Map<string, string>();
    const at = nowIso();
    let unlinkable = 0;
    for (const w of work) {
      const spellings = [...w.spellings.keys()].sort();
      // a text of legal forms or punctuation only ("GmbH", "–") names nobody; one marked "not a supplier" stays text
      if (!w.norm || notSupplier.has(w.norm)) {
        db().run(
          `INSERT INTO supplier_text_migrations (table_name, norm_text, spellings, outcome, supplier_id, rows_linked, migrated_at) VALUES (?, ?, ?, ?, NULL, 0, ?)
           ON CONFLICT DO NOTHING`,
          w.table,
          w.norm,
          JSON.stringify(spellings.slice(0, SUPPLIER_LIMITS.aliases)),
          w.norm ? 'notSupplier' : 'ignored',
          at,
        );
        unlinkable += w.rows.length;
        continue;
      }
      let id = known.get(w.norm) ?? created.get(scopeOf(w));
      const isNew = !id;
      if (!id) {
        const all = allSpellings.get(scopeOf(w))!;
        const name = nameOf(all).slice(0, SUPPLIER_LIMITS.name);
        id = insertSupplier({ name, status: 'unconfirmed', aliases: [...all.keys()].filter((x) => x !== name).sort() }, 'system', at);
        // owned by the teams that own the rows' items: seen by no more people than the texts were
        for (const team of w.teams) db().run("INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('supplier', ?, ?, ?)", id, team, at);
        created.set(scopeOf(w), id);
        made++;
      } else if (known.get(w.norm) === id && !w.teams.length) {
        // a known supplier: the new spellings join its aliases
        const s = db().get<{ name: string; aliases: string }>('SELECT name, aliases FROM suppliers WHERE id = ?', id)!;
        const aliases = parseJson<string[]>(s.aliases, []);
        const more = spellings.filter((x) => x !== s.name && !aliases.includes(x));
        if (more.length) db().run('UPDATE suppliers SET aliases = ? WHERE id = ?', JSON.stringify([...aliases, ...more].slice(0, SUPPLIER_LIMITS.aliases)), id);
      }
      const where = w.key.map((k) => `${k} = ?`).join(' AND ');
      let linked = 0;
      for (const r of w.rows)
        linked += db().run(`UPDATE ${w.table} SET supplier_id = ? WHERE ${where} AND supplier_id IS NULL`, id, ...w.key.map((k) => r[k])).changes;
      db().run(
        `INSERT INTO supplier_text_migrations (table_name, norm_text, spellings, outcome, supplier_id, rows_linked, migrated_at) VALUES (?, ?, ?, 'linked', ?, ?, ?)
         ON CONFLICT DO NOTHING`,
        w.table,
        w.norm,
        JSON.stringify(spellings.slice(0, SUPPLIER_LIMITS.aliases)),
        id,
        linked,
        at,
      );
      const name = db().get<{ name: string }>('SELECT name FROM suppliers WHERE id = ?', id)!.name;
      audit({
        actor: 'system',
        action: 'supplier.migrated',
        entityType: 'supplier',
        entityId: id,
        summary: `${isNew ? `Supplier "${name}" made from` : `Supplier "${name}" linked to`} the free-text vendor ${spellings.map((x) => `"${x}"`).join(', ')} of ${linked} ${w.table} row${linked === 1 ? '' : 's'}${isNew ? ' – waiting for confirmation' : ''} (0.17: suppliers)`,
        details: {
          table: w.table,
          normalised: w.norm,
          spellings,
          rows: linked,
          created: isNew,
          status: isNew ? 'unconfirmed' : undefined,
          owningTeams: isNew && w.teams.length ? w.teams : undefined,
        },
      });
    }
    if (unlinkable) logger.info({ rows: unlinkable }, 'free-text vendors without letters or digits left as text (not a supplier)');
  });
  return made;
}
