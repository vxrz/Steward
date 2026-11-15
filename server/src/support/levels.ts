import { SUPPORT_LIMITS as SL, supportLevelInput, supportLevelOrderInput, type SupportLevel, type SupportLevelRef } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { requireAdmin } from '../auth/access.js';
import { currentUser } from '../auth/context.js';
import { HttpError, newId, nowIso } from '../util.js';

/**
 * The support level catalogue (0.26.0, ADR 0039 part 5, docs/SUPPORT.md): a short list administrators keep under
 * _Settings → Support levels_ – what the providing teams promise (hours, one first-response time, a note, the SLA
 * document). Data products, services and applications pick one. Every signed-in reader reads the list (the pickers and
 * the items' pages show it); administrators add, change, order and remove levels (audited `support.level_*`).
 *
 * The list is read once and kept until it changes (a change here clears it), like the technology list: an item's page
 * and the lists show the level without a statement of their own.
 */

export interface LevelRow {
  id: string;
  name_en: string;
  name_de: string;
  hours: string;
  first_response: string;
  note: string;
  sla_url: string;
  position: number;
  legacy_tier: number | null;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

/** The tables of the items that pick a level. */
export const LEVEL_TABLES = { data_product: 'dp_products', service: 'services', application: 'applications' } as const;

export const ID_PREFIX = 'spl_';

let cached: { at: number; rows: LevelRow[] } | null = null;
/** How long the list is kept without a change here (another process of the instance may have changed it). */
const KEEP_MS = 60_000;

/** The catalogue as stored, in its order (kept). */
export function levelRows(now = Date.now()): LevelRow[] {
  if (cached && now - cached.at < KEEP_MS) return cached.rows;
  const rows = db()
    .all<LevelRow>('SELECT * FROM support_levels ORDER BY position, name_en, id')
    .map((r) => ({ ...r, position: Number(r.position), legacy_tier: r.legacy_tier === null ? null : Number(r.legacy_tier) }));
  cached = { at: now, rows };
  return rows;
}

/** Forgets the kept list (tests, and after a change). */
export function forgetLevels(): void {
  cached = null;
}

export const levelRef = (r: LevelRow): SupportLevelRef => ({
  id: r.id,
  nameEn: r.name_en,
  nameDe: r.name_de,
  hours: r.hours,
  firstResponse: r.first_response,
  note: r.note,
  slaUrl: r.sla_url,
});

/** The level of this id (kept list; undefined: none). */
export const levelRow = (id: string | null | undefined): LevelRow | undefined => (id ? levelRows().find((r) => r.id === id) : undefined);

/** How many items pick each level. */
function usage(): Map<string, number> {
  const out = new Map<string, number>();
  for (const table of Object.values(LEVEL_TABLES))
    for (const r of db().all<{ id: string; n: number }>(
      `SELECT support_level_id AS id, COUNT(*) AS n FROM ${table} WHERE support_level_id IS NOT NULL GROUP BY support_level_id`,
    ))
      out.set(r.id, (out.get(r.id) ?? 0) + Number(r.n));
  return out;
}

/** The catalogue (GET /api/support/levels): every signed-in reader; the usage only for administrators. */
export function listLevels(withUsage = false): SupportLevel[] {
  const n = withUsage ? usage() : new Map<string, number>();
  return levelRows().map((r) => ({ ...levelRef(r), position: r.position, usage: n.get(r.id) ?? 0, updatedAt: r.updated_at, updatedBy: r.updated_by }));
}

const levelNotFound = (id: string) => new HttpError(404, `Support level ${id} not found`, 'SUPPORT_LEVEL_NOT_FOUND', { id });

/** A level that exists (404 SUPPORT_LEVEL_NOT_FOUND otherwise). */
export function usableLevel(id: string): LevelRow {
  const r = levelRows(0).find((x) => x.id === id) ?? levelRows().find((x) => x.id === id);
  if (!r) throw levelNotFound(id);
  return r;
}

function refuseTakenName(name: string, except = ''): void {
  const n = name.trim().toLowerCase();
  const clash = levelRows(0).find((r) => r.id !== except && r.name_en.trim().toLowerCase() === n);
  if (clash) throw new HttpError(409, `A support level named "${name}" exists already`, 'SUPPORT_LEVEL_EXISTS', { name });
}

const summaryOf = (r: { name_en: string; hours: string; first_response: string }) =>
  [r.hours && `hours ${r.hours}`, r.first_response && `first response ${r.first_response}`].filter(Boolean).join(', ');

/** Writes a level (no rights checked: the routes, the upgrade and the deprecated `tier` call it). */
export function insertLevel(input: ReturnType<typeof supportLevelInput.parse> & { legacyTier?: number | null }, actor: string, why = ''): LevelRow {
  const id = newId(ID_PREFIX);
  const now = nowIso();
  const position = levelRows(0).reduce((m, r) => Math.max(m, r.position + 1), 0);
  db().tx(() => {
    db().run(
      `INSERT INTO support_levels (id, name_en, name_de, hours, first_response, note, sla_url, position, legacy_tier, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.nameEn,
      input.nameDe,
      input.hours,
      input.firstResponse,
      input.note,
      input.slaUrl,
      position,
      input.legacyTier ?? null,
      now,
      actor,
      now,
      actor,
    );
    const facts = summaryOf({ name_en: input.nameEn, hours: input.hours, first_response: input.firstResponse });
    audit({
      ...(actor === 'system' ? { actor: 'system' } : {}),
      action: 'support.level_created',
      entityType: 'support_level',
      entityId: id,
      summary: `Support level "${input.nameEn}" added${facts ? ` (${facts})` : ''}${why ? ` – ${why}` : ''}`,
      details: { nameEn: input.nameEn, nameDe: input.nameDe, hours: input.hours, firstResponse: input.firstResponse, slaUrl: input.slaUrl },
    });
  });
  forgetLevels();
  return levelRows(0).find((r) => r.id === id)!;
}

/** Adds a level (POST /api/support/levels, administrators). */
export function createLevel(body: unknown): SupportLevel {
  const u = requireAdmin('change the support levels', 'supportLevels');
  const input = supportLevelInput.parse(body);
  if (levelRows(0).length >= SL.levels)
    throw new HttpError(409, `Limit reached: at most ${SL.levels} support levels`, 'SUPPORT_LIMIT', { context: 'levels', max: SL.levels });
  refuseTakenName(input.nameEn);
  const r = insertLevel(input, u.username);
  return listLevels(true).find((l) => l.id === r.id)!;
}

/** Changes a level (PUT /api/support/levels/:id, administrators): every item that picks it shows the change. */
export function updateLevel(id: string, body: unknown): SupportLevel {
  const u = requireAdmin('change the support levels', 'supportLevels');
  const cur = usableLevel(id);
  const input = supportLevelInput.parse(body);
  refuseTakenName(input.nameEn, id);
  const before = { nameEn: cur.name_en, nameDe: cur.name_de, hours: cur.hours, firstResponse: cur.first_response, note: cur.note, slaUrl: cur.sla_url };
  const changes = (Object.keys(before) as (keyof typeof before)[]).filter((k) => before[k] !== input[k]);
  if (changes.length)
    db().tx(() => {
      db().run(
        'UPDATE support_levels SET name_en = ?, name_de = ?, hours = ?, first_response = ?, note = ?, sla_url = ?, updated_at = ?, updated_by = ? WHERE id = ?',
        input.nameEn,
        input.nameDe,
        input.hours,
        input.firstResponse,
        input.note,
        input.slaUrl,
        nowIso(),
        u.username,
        id,
      );
      audit({
        action: 'support.level_updated',
        entityType: 'support_level',
        entityId: id,
        summary: `Support level "${input.nameEn}" changed (${changes.join(', ')})`,
        details: { changes, before, after: input },
      });
    });
  forgetLevels();
  return listLevels(true).find((l) => l.id === id)!;
}

/** Orders the catalogue (PUT /api/support/levels/order, administrators): every level once. */
export function orderLevels(body: unknown): SupportLevel[] {
  requireAdmin('change the support levels', 'supportLevels');
  const { ids } = supportLevelOrderInput.parse(body);
  const rows = levelRows(0);
  if (ids.length !== rows.length || new Set(ids).size !== ids.length || !ids.every((id) => rows.some((r) => r.id === id)))
    throw new HttpError(400, 'Name every support level once', 'SUPPORT_LEVEL_ORDER');
  db().tx(() => {
    ids.forEach((id, i) => db().run('UPDATE support_levels SET position = ? WHERE id = ?', i, id));
    audit({
      action: 'support.level_reordered',
      entityType: 'support_level',
      summary: `Support levels ordered: ${ids.map((id) => `"${rows.find((r) => r.id === id)!.name_en}"`).join(', ')}`,
      details: { ids },
    });
  });
  forgetLevels();
  return listLevels(true);
}

/**
 * Removes a level (DELETE /api/support/levels/:id, administrators). Items that pick it move to `replaceWith` (merging
 * two levels), else they have no level; a level in use is only removed when the caller says which (`replaceWith`, or
 * `clear`), so nothing loses its level by a slip.
 */
export function deleteLevel(id: string, opts: { replaceWith?: string | null; clear?: boolean }): void {
  requireAdmin('change the support levels', 'supportLevels');
  const cur = usableLevel(id);
  const target = opts.replaceWith ? usableLevel(opts.replaceWith) : null;
  if (target?.id === id) throw new HttpError(400, 'A level cannot be merged into itself', 'SUPPORT_LEVEL_ORDER', { context: 'self' });
  const used = usage().get(id) ?? 0;
  if (used && !target && !opts.clear)
    throw new HttpError(409, `${used} items use the support level "${cur.name_en}" – choose a level for them, or remove it from them`, 'SUPPORT_LEVEL_IN_USE', {
      count: used,
    });
  db().tx(() => {
    for (const table of Object.values(LEVEL_TABLES)) db().run(`UPDATE ${table} SET support_level_id = ? WHERE support_level_id = ?`, target?.id ?? null, id);
    db().run('DELETE FROM support_levels WHERE id = ?', id);
    audit({
      action: 'support.level_deleted',
      entityType: 'support_level',
      entityId: id,
      summary: `Support level "${cur.name_en}" removed${used ? (target ? ` – its ${used} items now use "${target.name_en}"` : ` – ${used} items have no level now`) : ''}`,
      details: { name: cur.name_en, items: used, replacedBy: target?.id ?? null },
    });
  });
  forgetLevels();
}

/**
 * The level made from a support tier (1–3) – the upgrade's and the deprecated `tier`'s: "Tier n" (German "Stufe n"), made
 * when missing.
 */
export function levelOfTier(tier: number): LevelRow {
  const found = levelRows(0).find((r) => r.legacy_tier === tier);
  if (found) return found;
  const actor = currentUser()?.username ?? 'system';
  return insertLevel(
    { nameEn: `Tier ${tier}`, nameDe: `Stufe ${tier}`, hours: '', firstResponse: '', note: '', slaUrl: '', legacyTier: tier },
    actor,
    'made from the support tier, for administrators to rename or merge',
  );
}

/**
 * The example levels of a new installation, as made (by the system, never changed, made from no tier). A migration
 * package is imported into a new instance: these are no data of it – the package's levels replace them.
 */
const EXAMPLE_WHERE = "created_by = 'system' AND updated_by = 'system' AND updated_at = created_at AND legacy_tier IS NULL";

/** Whether the catalogue holds nothing but the untouched examples (or nothing). */
export function onlyExampleLevels(): boolean {
  return !db().get(`SELECT 1 FROM support_levels WHERE NOT (${EXAMPLE_WHERE})`);
}

/**
 * Before a migration package is imported: the untouched examples go, and so does the note that they were made – the
 * package's levels come instead, and a package from before 0.26.0 is upgraded after the import as that instance would
 * have been (examples only without levels and tiers).
 */
export function dropExampleLevels(seededKey: string): void {
  db().run(`DELETE FROM support_levels WHERE ${EXAMPLE_WHERE}`);
  db().run('DELETE FROM settings WHERE key = ?', seededKey);
  forgetLevels();
}
