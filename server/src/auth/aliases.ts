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
 * The four-eyes rules also treat two accounts linked to the same single sign-on identity (issuer + sub, users.external_sub,
 * e.g. through two providers of one identity provider) as one person (#210, auth/assurance.ts).
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
  /** former team name (lower case) → team id */
  teamByAlias: Map<string, string>;
  /** user id → the linked single sign-on identity (issuer + sub, without the provider) */
  subjectOf: Map<string, string>;
  /** user name (lower case) → user id, for accounts with a linked identity */
  idByName: Map<string, string>;
  loadedAt: number;
}

/** issuer + sub of a link (users.external_sub is `<provider>#iss=…#sub=…`): the same person through any provider of the issuer. */
const subjectTail = (key: string): string | null => {
  const i = key.indexOf('#');
  return i > 0 && key.startsWith('#iss=', i) ? key.slice(i) : null;
};

let cache: Cache | null = null;
/** Team renames are rare; the cache is also dropped on every team change and import (invalidateAliases). */
const MAX_AGE_MS = 60_000;

function load(): Cache {
  if (cache && Date.now() - cache.loadedAt < MAX_AGE_MS) return cache;
  const next: Cache = {
    userAliases: new Map(),
    userByAlias: new Map(),
    teamAliases: new Map(),
    teamByAlias: new Map(),
    subjectOf: new Map(),
    idByName: new Map(),
    loadedAt: Date.now(),
  };
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
    } else if (r.kind === 'team') {
      next.teamByAlias.set(alias, r.target_id);
      if (r.team_name) {
        const key = r.team_name.toLowerCase();
        next.teamAliases.set(key, [...(next.teamAliases.get(key) ?? []), alias]);
      }
    }
  }
  let linked: { id: string; username: string; external_sub: string }[];
  try {
    linked = db().all('SELECT id, username, external_sub FROM users WHERE external_sub IS NOT NULL');
  } catch {
    linked = []; // before the column exists (a test database being set up)
  }
  for (const r of linked) {
    const tail = subjectTail(r.external_sub);
    if (!tail) continue;
    next.subjectOf.set(r.id, tail);
    next.idByName.set(r.username.toLowerCase(), r.id);
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

/** The former names of a user (lower case). */
export function aliasesOf(userId: string): string[] {
  return load().userAliases.get(userId) ?? [];
}

/** The team id a former team name stands for (undefined: not an alias). */
export function teamAliasTarget(name: string): string | undefined {
  return load().teamByAlias.get(name.trim().toLowerCase());
}

/** The user id a former user name stands for (undefined: not an alias). */
export function aliasTarget(name: string): string | undefined {
  return load().userByAlias.get(name.trim().toLowerCase());
}

/**
 * Whether `name` (a user name recorded somewhere) means the user `u`: their own name, one of their former names, or
 * another account linked to the same single sign-on identity (issuer + sub).
 */
export function sameIdentity(name: string | null | undefined, u: { id: string; username: string }): boolean {
  if (!name) return false;
  const n = name.trim().toLowerCase();
  if (n === u.username.toLowerCase()) return true;
  const c = load();
  if (c.userByAlias.get(n) === u.id) return true;
  const mine = c.subjectOf.get(u.id);
  if (!mine) return false;
  const other = c.idByName.get(n) ?? c.userByAlias.get(n);
  return !!other && c.subjectOf.get(other) === mine;
}

/** How two people were told apart (the four-eyes proof): user id and name, former names, linked identity. */
export const IDENTITY_CHECKS = ['user', 'aliases', 'ssoSubject'] as const;
