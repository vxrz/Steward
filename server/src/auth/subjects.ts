import { db } from '../db.js';
import { HttpError } from '../util.js';
import { columns } from '../cli/db-copy.js';
import { USER_REFS } from '../migration/tables.js';
import { mapValue, type NameMaps } from '../migration/refs.js';
import { aliasTarget, teamAliasTarget } from './aliases.js';
import { audit } from '../audit.js';
import { currentStore } from './context.js';
import { sharesChanged } from './share-store.js';

/**
 * Users and teams named as owners, responsibles, recipients and in access lists (#143): only ones that exist; where a
 * user or team is still named (before a team is deleted or a user deactivated); and the references kept consistent
 * when a team is renamed or deleted. The columns are those a migration package maps (USER_REFS).
 */

const lower = (s: string) => s.trim().toLowerCase();

/** Does `user:<name>` / `team:<name>` (or a role) name something that exists? Former names of imported accounts count. */
export function subjectExists(subject: string): boolean {
  const m = /^(user|team|role):(.+)$/i.exec(subject.trim());
  if (!m) return false;
  const kind = m[1]!.toLowerCase();
  const name = lower(m[2]!);
  if (kind === 'role') return true;
  if (kind === 'user') return !!db().get('SELECT 1 FROM users WHERE lower(username) = ?', name) || !!aliasTarget(name);
  return !!db().get('SELECT 1 FROM teams WHERE lower(name) = ?', name) || !!teamAliasTarget(name);
}

/**
 * 400 SUBJECT_UNKNOWN for a user or team that does not exist. Values stored before stay accepted (a deactivated
 * account, or one from before the check), so saving an entry never fails because of an owner it already had.
 */
export function assertKnownSubjects(next: readonly string[], before: readonly string[] = []): void {
  const kept = new Set(before.map(lower));
  for (const s of next) {
    if (kept.has(lower(s))) continue;
    if (!subjectExists(s)) {
      const name = s.replace(/^(user|team):/i, '');
      throw new HttpError(400, `${/^team:/i.test(s) ? 'Team' : 'User'} "${name}" does not exist`, /^team:/i.test(s) ? 'TEAM_UNKNOWN' : 'USER_UNKNOWN', {
        name,
      });
    }
  }
}

export interface SubjectReference {
  /** The table, e.g. services, applications, credentials */
  table: string;
  /** The column, e.g. owners, acl */
  column: string;
  count: number;
  /** Names of some of the entries (when the table has a name or title) */
  examples: string[];
}

const PROBE = '\u0000probe';
const NONE: NameMaps = { users: new Map(), teams: new Map() };
const likeName = (n: string) => `%${n.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Where a user or team is named now: per table and column, with a few names. */
export function subjectReferences(kind: 'user' | 'team', name: string): SubjectReference[] {
  const n = lower(name);
  const maps: NameMaps = kind === 'user' ? { users: new Map([[n, PROBE]]), teams: new Map() } : { users: new Map(), teams: new Map([[n, PROBE]]) };
  const out: SubjectReference[] = [];
  for (const ref of USER_REFS) {
    let cols: string[];
    try {
      cols = columns(db(), ref.table);
    } catch {
      continue;
    }
    if (!cols.includes(ref.column)) continue;
    const label = ['name', 'title', 'number', 'key'].find((c) => cols.includes(c));
    const rows = db().all<{ v: string; label?: string }>(
      `SELECT ${ref.column} AS v${label ? `, ${label} AS label` : ''} FROM ${ref.table} WHERE lower(${ref.column}) LIKE ? ESCAPE '\\'`,
      likeName(n),
    );
    // a user name in a plain owner column, or a subject inside JSON: the mapping tells
    const hits = rows.filter((r) => mapValue(ref.kind, r.v, maps) !== mapValue(ref.kind, r.v, NONE));
    if (hits.length)
      out.push({ table: ref.table, column: ref.column, count: hits.length, examples: hits.flatMap((h) => (h.label ? [String(h.label)] : [])).slice(0, 5) });
  }
  return out;
}

/**
 * A team was renamed (`to`: the new name) or deleted (`to`: null): every reference follows – owners, responsibles,
 * access lists, recipients, monitor subscribers. Returns the number of changed rows. Inside the caller's transaction.
 */
export function rewriteTeamReferences(from: string, to: string | null): number {
  const maps: NameMaps = { users: new Map(), teams: new Map([[lower(from), to]]) };
  let changed = 0;
  for (const ref of USER_REFS) {
    if (ref.kind === 'username') continue;
    // a deleted team stays in access lists: an entry that matches nobody keeps the list restricted, while removing
    // the last entry would leave the default access (everyone with the role's rights). The same for columns where a
    // team restricts who sees the row – a contract's owners (ADR 0031): without a team it is seen by every supplier reader
    if (to === null && (ref.kind === 'acl' || ref.keepDeletedTeams)) continue;
    let cols: string[];
    try {
      cols = columns(db(), ref.table);
    } catch {
      continue;
    }
    if (!cols.includes(ref.column)) continue;
    const rows = db().all<{ v: string }>(
      `SELECT DISTINCT ${ref.column} AS v FROM ${ref.table} WHERE lower(${ref.column}) LIKE ? ESCAPE '\\'`,
      likeName(lower(from)),
    );
    for (const r of rows) {
      const next = mapValue(ref.kind, r.v, maps);
      if (next === mapValue(ref.kind, r.v, NONE)) continue;
      // a share of the renamed team where the same resource keeps one for a former team of the new name (it matched
      // nobody): the renamed team's share stays, so the rename gives nobody a right on that resource
      if (ref.kind === 'subject' && ref.key?.length)
        db().run(
          `DELETE FROM ${ref.table} WHERE ${ref.column} = ? AND EXISTS (SELECT 1 FROM ${ref.table} o WHERE o.${ref.column} = ? AND ${ref.key
            .map((k) => `o.${k} = ${ref.table}.${k}`)
            .join(' AND ')})`,
          next,
          r.v,
        );
      changed += db().run(`UPDATE ${ref.table} SET ${ref.column} = ? WHERE ${ref.column} = ?`, next, r.v).changes;
    }
  }
  return changed;
}

/**
 * A team takes a name – created with it, or renamed to it – that a deleted team had (ADR 0033, 0034; security review
 * 0.21.0): the deleted team's shares and module grants stay as entries that match nobody, and would match the new
 * team's members – a widening nobody granted or confirmed. They are removed first, each audited as an access change;
 * nobody loses anything, as they matched nobody. While another team has the name (a different `teamId`), they are not
 * stale and stay. Inside the caller's transaction. Returns the number removed.
 */
export function forgetStaleTeamGrants(name: string, teamId: string): number {
  const n = lower(name);
  if (db().get('SELECT 1 FROM teams WHERE lower(name) = ? AND id <> ?', n, teamId)) return 0;
  const subject = `team:${n}`;
  let removed = 0;
  const shares = db().all<{ kind: string; resource_id: string; subject: string; level: string; actions: string; expires_at: string | null }>(
    'SELECT kind, resource_id, subject, level, actions, expires_at FROM resource_shares WHERE lower(subject) = ? ORDER BY kind, resource_id',
    subject,
  );
  for (const r of shares) {
    removed += db().run('DELETE FROM resource_shares WHERE kind = ? AND resource_id = ? AND subject = ?', r.kind, r.resource_id, r.subject).changes;
    audit({
      action: 'access.share_removed',
      entityType: r.kind,
      entityId: r.resource_id,
      summary: `Share of ${r.kind} ${r.resource_id} with ${r.subject} removed: it was a deleted team's, and a new team takes the name "${name}"`,
      details: { subject: r.subject, before: { level: r.level, actions: r.actions, expiresAt: r.expires_at }, reason: 'teamNameReused' },
    });
  }
  const grants = db().all<{ module_id: string; subject: string }>(
    'SELECT module_id, subject FROM module_grants WHERE lower(subject) = ? ORDER BY module_id',
    subject,
  );
  for (const g of grants) {
    removed += db().run('DELETE FROM module_grants WHERE module_id = ? AND subject = ?', g.module_id, g.subject).changes;
    audit({
      action: 'access.module_access_changed',
      entityType: 'settings',
      entityId: `module:${g.module_id}`,
      summary: `Who uses the module "${g.module_id}": ${g.subject} removed – it was a deleted team's, and a new team takes the name "${name}"`,
      details: { module: g.module_id, granted: [], removed: [g.subject], reason: 'teamNameReused' },
    });
  }
  if (removed) {
    sharesChanged();
    const store = currentStore();
    if (store) store.moduleAccess = undefined;
  }
  return removed;
}
