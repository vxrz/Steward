import { compareVersions, parseVersion, type Scheme, type Version } from '../../versions/compare.js';

/**
 * Versions and version ranges of CSAF products (docs/ADVISORIES.md "Matching"), written as string parsers – no regular
 * expressions on document data:
 *
 *   product_version         one version: equal when both parse and compare equal ("V2.3.1" = "2.3.1" = "2.3.1.0")
 *   product_version_range   1. vers (CSAF 2.0 §3.1.2.3.2 option 1): `vers:<scheme>/<constraint>|…`, `vers:all/*`;
 *                           2. vers-like constraints (option 2, "best effort"): `<V3.0.29`, `>=8.1.5`, `<=2`;
 *                           3. the few free-text forms advisories still use: "All versions", "All versions < V3.0",
 *                              "prior to 4.2", "before 4.2", "4.2 and later", "1.0 - 2.0", and a constraint followed
 *                              by words ("<V4.00_Utilizes_…": the version ends at the first character no version has).
 *   Anything else is "not understood": the product can then only be a possible match.
 *
 * vers schemes map to the comparison rules of the version watch (versions/compare.ts): npm, cargo, golang, nuget,
 * semver → semver; pypi → pep440; maven → maven; everything else (generic, firmware) → loose: numbers separated by
 * dots, whatever follows ordered after them (a pre-release word before).
 */

export type Op = '<' | '<=' | '>' | '>=' | '=' | '!=';
export interface Constraint {
  op: Op;
  version: Version;
}
export type Range = { kind: 'all' } | { kind: 'constraints'; scheme: Scheme; list: Constraint[]; text: string } | { kind: 'unparsed'; text: string };

const MAX = 300;
const SCHEMES: Record<string, Scheme> = { npm: 'semver', cargo: 'semver', golang: 'semver', nuget: 'semver', semver: 'semver', pypi: 'pep440', maven: 'maven' };
const isVersionChar = (c: string) => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '.' || c === '-' || c === '+';
const isDigit = (c: string | undefined) => !!c && c >= '0' && c <= '9';

/** A firmware or version text as Steward compares it: without "firmware", "fw", "version" in front. */
export function cleanVersion(text: string): string {
  let s = text.trim();
  for (;;) {
    const lower = s.toLowerCase();
    const word = ['firmware', 'version', 'fw', 'ver.', 'ver'].find((w) => lower.startsWith(w) && !isVersionLetter(lower[w.length]));
    if (!word) break;
    s = s.slice(word.length).trim();
    if (s.startsWith(':')) s = s.slice(1).trim();
  }
  return s;
}
const isVersionLetter = (c: string | undefined) => !!c && ((c >= 'a' && c <= 'z') || c === '_');

/** A version of the scheme (loose falls back for texts the scheme does not read). */
export function version(text: string, scheme: Scheme = 'loose'): Version | null {
  const s = cleanVersion(text);
  if (!s || s.length > 128) return null;
  // "3.x", "2.*": a family of versions, not one
  if (s.split(/[.\-_ ]/).some((part) => part === 'x' || part === 'X' || part === '*')) return null;
  return parseVersion(s, scheme) ?? (scheme !== 'loose' ? parseVersion(s, 'loose') : null);
}

const cmp = (a: Version, b: Version) => compareVersions(a, b);

/** Reads `<op><version>` at the start of s; the version ends at the first character no version has. */
function constraintAt(text: string, scheme: Scheme): Constraint | null {
  let s = text.trim();
  let op: Op = '=';
  for (const o of ['<=', '>=', '!=', '<', '>', '=='] as const) {
    if (s.startsWith(o)) {
      op = o === '==' ? '=' : o;
      s = s.slice(o.length).trim();
      break;
    }
  }
  if (s.startsWith('=')) s = s.slice(1).trim();
  let end = 0;
  while (end < s.length && isVersionChar(s[end]!)) end++;
  let token = s.slice(0, end);
  // "V4.00_Utilizes_…": the words after the version are not part of it; a trailing separator neither
  while (token.endsWith('.') || token.endsWith('-') || token.endsWith('+')) token = token.slice(0, -1);
  if (!token) return null;
  let decoded = token;
  try {
    decoded = decodeURIComponent(token);
  } catch {
    /* as written */
  }
  const v = version(decoded, scheme);
  return v ? { op, version: v } : null;
}

/** The constraints of a vers or vers-like text, separated by "|"; null when one of them does not read. */
function constraints(text: string, scheme: Scheme, strict: boolean): Constraint[] | null {
  const parts = text
    .split('|')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length || parts.length > 50) return null;
  const out: Constraint[] = [];
  for (const p of parts) {
    // a vers constraint is the whole part; elsewhere words may follow the version
    const c = constraintAt(p, scheme);
    if (!c) return null;
    if (strict) {
      let rest = p.trim();
      for (const o of ['<=', '>=', '!=', '<', '>', '=']) if (rest.startsWith(o)) rest = rest.slice(o.length).trim();
      if ([...rest].some((ch) => !isVersionChar(ch) && ch !== '%')) return null;
    }
    out.push(c);
  }
  return out;
}

const lower = (s: string) => s.trim().toLowerCase();

/** Parses a product_version_range name (see the module comment). */
export function parseRange(raw: string): Range {
  const text = raw.trim();
  if (!text || text.length > MAX) return { kind: 'unparsed', text };
  const l = lower(text);
  if (l === 'vers:all/*' || l === '*' || l === 'all' || l === 'all versions' || l === 'all versions.') return { kind: 'all' };
  if (l.startsWith('vers:')) {
    const slash = text.indexOf('/');
    if (slash < 0) return { kind: 'unparsed', text };
    const schemeName = lower(text.slice(5, slash));
    const body = text.slice(slash + 1).trim();
    if (body === '*') return { kind: 'all' };
    const scheme = SCHEMES[schemeName] ?? 'loose';
    const list = constraints(body, scheme, true);
    return list ? { kind: 'constraints', scheme, list, text } : { kind: 'unparsed', text };
  }
  // free text: "All versions < V3.0", "prior to 4.2", "4.2 and later", "1.0 - 2.0"
  let s = text;
  for (const prefix of ['all versions', 'all versions of', 'versions', 'version']) {
    if (lower(s).startsWith(prefix) && !isDigit(s[prefix.length])) {
      const rest = s.slice(prefix.length).trim();
      if (
        rest.startsWith('<') ||
        rest.startsWith('>') ||
        rest.startsWith('=') ||
        rest.toLowerCase().startsWith('prior') ||
        rest.toLowerCase().startsWith('before')
      )
        s = rest;
    }
  }
  const ls = lower(s);
  for (const [words, op] of [
    ['prior to', '<'],
    ['before', '<'],
    ['earlier than', '<'],
    ['up to and including', '<='],
    ['up to', '<='],
  ] as const) {
    if (ls.startsWith(words)) {
      const c = constraintAt(s.slice(words.length), 'loose');
      return c && c.op === '=' ? { kind: 'constraints', scheme: 'loose', list: [{ op, version: c.version }], text } : { kind: 'unparsed', text };
    }
  }
  for (const [words, op] of [
    [' and later', '>='],
    [' or later', '>='],
    [' and above', '>='],
    [' and newer', '>='],
    [' and earlier', '<='],
    [' or earlier', '<='],
  ] as const) {
    if (ls.endsWith(words)) {
      const c = constraintAt(s.slice(0, s.length - words.length), 'loose');
      return c && c.op === '=' ? { kind: 'constraints', scheme: 'loose', list: [{ op, version: c.version }], text } : { kind: 'unparsed', text };
    }
  }
  // "1.0 - 2.0": from … to, both included
  const dash = s.indexOf(' - ');
  if (dash > 0) {
    const a = constraintAt(s.slice(0, dash), 'loose');
    const b = constraintAt(s.slice(dash + 3), 'loose');
    if (a && b && a.op === '=' && b.op === '=')
      return {
        kind: 'constraints',
        scheme: 'loose',
        list: [
          { op: '>=', version: a.version },
          { op: '<=', version: b.version },
        ],
        text,
      };
    return { kind: 'unparsed', text };
  }
  // vers-like: "<V3.0.29", ">=8.1.5", "<=2", ">=1.0|<2.0"; a lone version is no range
  if (!(s.startsWith('<') || s.startsWith('>') || s.startsWith('!=') || s.startsWith('='))) return { kind: 'unparsed', text };
  const list = constraints(s.replaceAll(',', '|'), 'loose', false);
  return list ? { kind: 'constraints', scheme: 'loose', list, text } : { kind: 'unparsed', text };
}

/** Whether a version is in the range (the vers specification's algorithm); null when the version does not read. */
export function inRange(range: Range, versionText: string): boolean | null {
  if (range.kind === 'all') return true;
  if (range.kind === 'unparsed') return null;
  const v = version(versionText, range.scheme);
  if (!v) return null;
  const eq = range.list.filter((c) => c.op === '=' || c.op === '!=');
  for (const c of range.list) if ((c.op === '=' || c.op === '<=' || c.op === '>=') && cmp(v, c.version) === 0) return true;
  for (const c of eq) if (c.op === '!=' && cmp(v, c.version) === 0) return false;
  const list = range.list.filter((c) => c.op !== '=' && c.op !== '!=').sort((a, b) => cmp(a.version, b.version));
  if (!list.length) return false;
  const first = list[0]!;
  const last = list[list.length - 1]!;
  if ((first.op === '<' || first.op === '<=') && cmp(v, first.version) < 0) return true;
  if ((last.op === '>' || last.op === '>=') && cmp(v, last.version) > 0) return true;
  for (let i = 0; i + 1 < list.length; i++) {
    const a = list[i]!;
    const b = list[i + 1]!;
    if ((a.op === '>' || a.op === '>=') && (b.op === '<' || b.op === '<=') && cmp(v, a.version) > 0 && cmp(v, b.version) < 0) return true;
  }
  return false;
}

/** Whether two versions are the same (both must read). */
export function sameVersion(a: string, b: string): boolean | null {
  const x = version(a);
  const y = version(b);
  if (!x || !y) return null;
  return cmp(x, y) === 0;
}

/** a > b; null when either does not read. */
export function newer(a: string, b: string): boolean | null {
  const x = version(a);
  const y = version(b);
  if (!x || !y) return null;
  return cmp(x, y) > 0;
}

/** The first version outside an affected range above it: the upper end of `<X` (the fix the range implies). */
export function upperBound(range: Range): string | null {
  if (range.kind !== 'constraints') return null;
  const lows = range.list.filter((c) => c.op === '<').sort((a, b) => cmp(b.version, a.version));
  if (!lows.length || range.list.some((c) => (c.op === '>' || c.op === '>=') && cmp(c.version, lows[0]!.version) > 0)) return null;
  return lows[0]!.version.raw;
}
