import { signedInUserId } from './recent';

/**
 * Small per-user settings kept in this browser (a list's sort order, the table/card choice, folded editor panels).
 * The key carries the signed-in user's id, so two people sharing a browser keep their own choices. Storage can be
 * blocked (private windows): reading then gives null, writing does nothing.
 */
const keyOf = (name: string, userId = signedInUserId()) => (userId ? `sm.pref.${userId}.${name}` : `sm.pref.${name}`);

export function readPref(name: string, legacyKey?: string): string | null {
  try {
    return localStorage.getItem(keyOf(name)) ?? (legacyKey ? localStorage.getItem(legacyKey) : null);
  } catch {
    return null;
  }
}

export function writePref(name: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(keyOf(name));
    else localStorage.setItem(keyOf(name), value);
  } catch {
    /* storage blocked: the choice lasts for this page view */
  }
}

/** A stored JSON value, or `fallback` when there is none or it does not pass `valid`. */
export function readJsonPref<T>(name: string, valid: (v: unknown) => v is T, fallback: T): T {
  const raw = readPref(name);
  if (raw === null) return fallback;
  try {
    const v = JSON.parse(raw) as unknown;
    return valid(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
