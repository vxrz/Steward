import { z } from 'zod';

/**
 * Tags with an optional value (#143), like labels: `pci` or `env=prod`. Stored as `key` or `key=value`; tags from
 * before stay as keys. A filter `env` matches `env` and every `env=…`, a filter `env=prod` only that value; case does
 * not matter.
 */

/** A key: letters, digits, `.` `_` `-` `/` (checked for tags with a value; plain tags keep the rules they had). */
export const TAG_KEY_RE = /^[\p{L}\p{N}._/-]+$/u;
export const TAG_LIMITS = { key: 60, value: 100 } as const;

export interface TagParts {
  key: string;
  value: string | null;
}

/** `env=prod` → { key: 'env', value: 'prod' }; `pci` → { key: 'pci', value: null }. */
export function splitTag(tag: string): TagParts {
  const i = tag.indexOf('=');
  if (i < 0) return { key: tag.trim(), value: null };
  const value = tag.slice(i + 1).trim();
  return { key: tag.slice(0, i).trim(), value: value || null };
}

/** The stored form: `key` or `key=value`, spaces around the `=` removed; also takes `key: value`. */
export function normalizeTag(input: string): string {
  const s = input.trim();
  // `key: value` (a space after the colon), split by hand: a regex here would backtrack on long runs of spaces
  const c = s.indexOf(':');
  const before = c > 0 ? s.slice(0, c).trim() : '';
  const after = c > 0 ? s.slice(c + 1) : '';
  const colon = !!before && TAG_KEY_RE.test(before) && /^\s/.test(after) && !!after.trim();
  const { key, value } = colon ? { key: before, value: after.trim() } : splitTag(s);
  return value ? `${key}=${value}` : key;
}

/** Why a tag is not valid (null: valid). */
export function tagProblem(tag: string): 'empty' | 'key' | 'long' | null {
  const { key, value } = splitTag(tag);
  if (!key) return 'empty';
  if (value !== null && !TAG_KEY_RE.test(key)) return 'key';
  if (key.length > TAG_LIMITS.key || (value?.length ?? 0) > TAG_LIMITS.value) return 'long';
  return null;
}

/** `env: prod`, or the key alone. */
export function tagLabel(tag: string): string {
  const { key, value } = splitTag(tag);
  return value ? `${key}: ${value}` : key;
}

/** Does a list of tags match a filter (`key` or `key=value`)? */
export function tagsMatch(tags: readonly string[], filter: string | null | undefined): boolean {
  if (!filter?.trim()) return true;
  const f = splitTag(normalizeTag(filter));
  const key = f.key.toLowerCase();
  const value = f.value?.toLowerCase() ?? null;
  return tags.some((t) => {
    const p = splitTag(t);
    return p.key.toLowerCase() === key && (value === null || p.value?.toLowerCase() === value);
  });
}

/** A tag in an input: normalised to `key` or `key=value`, a key with a value checked (`lower`: stored in lower case). */
export const tagInput = (o: { lower?: boolean } = {}) =>
  z
    .string()
    .trim()
    .min(1)
    .max(TAG_LIMITS.key + 1 + TAG_LIMITS.value)
    .transform((t) => (o.lower ? normalizeTag(t).toLowerCase() : normalizeTag(t)))
    .refine((t) => !tagProblem(t), { message: 'A tag is a key (letters, digits, . _ - /) with an optional value: key or key=value' });
