import { useCallback, useState } from 'react';
import { signedInUserId } from './recent';

/**
 * Small per-user settings kept in this browser (a list's sort order, the table/card choice, folded editor panels,
 * folded sections). The key carries the signed-in user's id, so two people sharing a browser keep their own choices.
 * Storage can be blocked (private windows): reading then gives null, writing does nothing.
 */
const keyOf = (name: string, userId = signedInUserId()) => (userId ? `sm.pref.${userId}.${name}` : `sm.pref.${name}`);

/** `legacyKey`: where an older version kept the value; read while the new key has none (no migration step needed). */
export function readPref(name: string, legacyKey?: string, userId?: string): string | null {
  try {
    return localStorage.getItem(keyOf(name, userId)) ?? (legacyKey ? localStorage.getItem(legacyKey) : null);
  } catch {
    return null;
  }
}

export function writePref(name: string, value: string | null, userId?: string): void {
  try {
    if (value === null) localStorage.removeItem(keyOf(name, userId));
    else localStorage.setItem(keyOf(name, userId), value);
  } catch {
    /* storage blocked: the choice lasts for this page view */
  }
}

/** A stored JSON value, or `fallback` when there is none or it does not pass `valid`. */
export function readJsonPref<T>(name: string, valid: (v: unknown) => v is T, fallback: T, opts: { legacyKey?: string; userId?: string } = {}): T {
  const raw = readPref(name, opts.legacyKey, opts.userId);
  if (raw === null) return fallback;
  try {
    const v = JSON.parse(raw) as unknown;
    return valid(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

/** A remembered yes/no ("1"/"0"); `fallback` while nothing is stored. */
export function readFlagPref<T extends boolean | null>(name: string, fallback: T, legacyKey?: string): boolean | T {
  const raw = readPref(name, legacyKey);
  return raw === '1' ? true : raw === '0' ? false : fallback;
}

/**
 * A remembered yes/no of a section (open, folded, hidden) for the signed-in user: the value and a setter that stores
 * it. `fallback` applies while the user has not chosen (null: the caller decides, e.g. by screen width).
 */
export function useSectionPref(name: string, fallback: boolean, legacyKey?: string): [boolean, (v: boolean) => void];
export function useSectionPref(name: string, fallback: null, legacyKey?: string): [boolean | null, (v: boolean) => void];
export function useSectionPref(name: string, fallback: boolean | null, legacyKey?: string): [boolean | null, (v: boolean) => void] {
  const [value, setValue] = useState<boolean | null>(() => readFlagPref(name, fallback, legacyKey));
  const set = useCallback(
    (v: boolean) => {
      setValue(v);
      writePref(name, v ? '1' : '0');
    },
    [name],
  );
  return [value, set];
}
