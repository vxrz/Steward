import { parseJson } from '../util.js';
import type { RefKind } from './tables.js';

/**
 * Mapping of the columns that name who owns something or who may do something (USER_REFS in tables.ts): used when a
 * migration package is imported (source names → names here) and when a team is renamed or deleted (#143).
 */

const lower = (s: string) => s.trim().toLowerCase();

export interface NameMaps {
  /** source user name (lower case) → user name here */
  users: Map<string, string>;
  /** source team name (lower case) → team name here, or null (dropped) */
  teams: Map<string, string | null>;
}

export function mapSubject(s: unknown, maps: NameMaps): string | null {
  if (typeof s !== 'string') return s as null;
  const m = /^(user|team):(.+)$/i.exec(s.trim());
  if (!m) return s;
  const name = lower(m[2]!);
  if (m[1]!.toLowerCase() === 'user') {
    const to = maps.users.get(name);
    return to ? `user:${lower(to)}` : s;
  }
  if (!maps.teams.has(name)) return s;
  const to = maps.teams.get(name);
  return to ? `team:${lower(to)}` : null;
}

export function mapValue(kind: RefKind, raw: unknown, maps: NameMaps): unknown {
  if (raw === null || raw === undefined) return raw;
  if (kind === 'username') {
    const to = maps.users.get(lower(String(raw)));
    return to ?? raw;
  }
  const json = parseJson<unknown>(String(raw), undefined);
  if (json === undefined) return raw;
  let out: unknown = json;
  if (kind === 'subjects' && Array.isArray(json)) {
    out = [...new Set(json.map((s) => mapSubject(s, maps)).filter((s) => s !== null))];
  } else if (kind === 'acl' && Array.isArray(json)) {
    out = json
      .map((e) => (e && typeof e === 'object' ? { ...(e as object), subject: mapSubject((e as { subject?: unknown }).subject, maps) } : e))
      .filter((e) => !(e && typeof e === 'object' && (e as { subject: unknown }).subject === null));
  } else if (kind === 'recipients' && json && typeof json === 'object') {
    const r = json as { users?: unknown[]; teams?: unknown[] };
    out = {
      ...r,
      users: Array.isArray(r.users) ? [...new Set(r.users.map((x) => (typeof x === 'string' ? (maps.users.get(lower(x)) ?? x) : x)))] : r.users,
      teams: Array.isArray(r.teams)
        ? r.teams.map((x) => (typeof x === 'string' && maps.teams.has(lower(x)) ? maps.teams.get(lower(x)) : x)).filter((x) => x !== null && x !== undefined)
        : r.teams,
    };
  } else if (kind === 'monitorDefinition' && json && typeof json === 'object') {
    const def = json as { outputs?: { subscribers?: unknown[] }[] };
    if (Array.isArray(def.outputs)) {
      out = {
        ...def,
        outputs: def.outputs.map((o) =>
          o && Array.isArray(o.subscribers) ? { ...o, subscribers: [...new Set(o.subscribers.map((s) => mapSubject(s, maps)).filter((s) => s !== null))] } : o,
        ),
      };
    }
  }
  return JSON.stringify(out);
}
