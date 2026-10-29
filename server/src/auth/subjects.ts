import { db } from '../db.js';
import { HttpError } from '../util.js';
import { columns } from '../cli/db-copy.js';
import { USER_REFS } from '../migration/tables.js';
import { mapValue, type NameMaps } from '../migration/refs.js';
import { aliasTarget, teamAliasTarget } from './aliases.js';

/**
 * Users and teams named as owners, responsibles, recipients and in access lists (#143): only ones that exist; where a
 * user or team is still named (before a team is deleted or a user deactivated); and the references kept consistent
 * when a team is renamed or deleted. The columns are those a migration package maps (USER_REFS).
 */

const lower = (s: string) => s.trim().toLowerCase();

/** Does `user:<name>` / `team:<name>` (or a role) name something that exists? Former names of imported accounts count. */
function exists(subject: string): boolean {
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
    if (!exists(s)) {
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
      if (next !== mapValue(ref.kind, r.v, NONE)) changed += db().run(`UPDATE ${ref.table} SET ${ref.column} = ? WHERE ${ref.column} = ?`, next, r.v).changes;
    }
  }
  return changed;
}
