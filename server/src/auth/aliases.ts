import { db } from '../db.js';

/**
 * Former names of users and teams that came with an imported migration package (server/src/migration).
 *
 * Imported history is never rewritten: audit entries, protocols, process versions (hashed), approvals and
 * other evidence keep the names of the source instance. The import maps every source user and team to one
 * on this instance and records the mapping here, so that
 *   - subjects in imported content ("user:arvid" in a process step, a monitor subscriber, an access list)
 *     still reach the person they meant (subjectsOf in permissions.ts adds the aliases),
 *   - the four-eyes rules treat a former name as the same person (sameIdentity): whoever started a run as
 *     "arvid" on the laptop cannot approve it as "arvid@corp.example" after the move.
 * A name only becomes an alias when it differs from the target's own name; the import refuses names that
 * belong to another (non-administrator) account here, and new accounts cannot take an alias as their name.
 */

interface Cache {
  /** user id → former user names (lower case) */
  userAliases: Map<string, string[]>;
  /** former user name (lower case) → user id */
  userByAlias: Map<string, string>;
  /** current team name (lower case) → former team names (lower case) */
  teamAliases: Map<string, string[]>;
  loadedAt: number;
}

let cache: Cache | null = null;
/** Team renames are rare; the cache is also dropped on every team change and import (invalidateAliases). */
const MAX_AGE_MS = 60_000;

function load(): Cache {
  if (cache && Date.now() - cache.loadedAt < MAX_AGE_MS) return cache;
  const next: Cache = { userAliases: new Map(), userByAlias: new Map(), teamAliases: new Map(), loadedAt: Date.now() };
  let rows: { kind: string; alias: string; target_id: string; team_name: string | null }[];
  try {
    rows = db().all(
      `SELECT a.kind, a.alias, a.target_id, t.name AS team_name FROM identity_aliases a LEFT JOIN teams t ON a.kind = 'team' AND t.id = a.target_id`,
    );
  } catch {
    rows = []; // before the migration that creates the table (e.g. while a test database is set up)
  }
  for (const r of rows) {
    const alias = r.alias.toLowerCase();
    if (r.kind === 'user') {
      next.userAliases.set(r.target_id, [...(next.userAliases.get(r.target_id) ?? []), alias]);
      next.userByAlias.set(alias, r.target_id);
    } else if (r.kind === 'team' && r.team_name) {
      const key = r.team_name.toLowerCase();
      next.teamAliases.set(key, [...(next.teamAliases.get(key) ?? []), alias]);
    }
  }
  cache = next;
  return next;
}

export function invalidateAliases(): void {
  cache = null;
}

/** Extra subjects of a signed-in user: "user:<former name>" and "team:<former team name>" for their teams. */
export function aliasSubjects(u: { id: string; teams: string[] }): string[] {
  const c = load();
  if (!c.userAliases.size && !c.teamAliases.size) return [];
  const out = (c.userAliases.get(u.id) ?? []).map((a) => `user:${a}`);
  for (const t of u.teams) for (const a of c.teamAliases.get(t.toLowerCase()) ?? []) out.push(`team:${a}`);
  return out;
}

/** The user id a former user name stands for (undefined: not an alias). */
export function aliasTarget(name: string): string | undefined {
  return load().userByAlias.get(name.trim().toLowerCase());
}

/** Whether `name` (a user name recorded somewhere) means the user `u`: their own name or one of their former names. */
export function sameIdentity(name: string | null | undefined, u: { id: string; username: string }): boolean {
  if (!name) return false;
  const n = name.trim().toLowerCase();
  return n === u.username.toLowerCase() || load().userByAlias.get(n) === u.id;
}
