import type { VersionBehind, VersionLag } from '@sm/shared';

/**
 * Version comparison by the rules of each ecosystem (#241), written as string parsers – no regular expressions on
 * registry data, so a hostile version string cannot make a pattern backtrack:
 *
 *   semver  Semantic Versioning 2.0.0 (§11 precedence; build metadata ignored). Also NuGet (up to four numbers), Go
 *           modules (a leading "v"; pseudo-versions are pre-releases) and Cargo. Missing parts count as 0 ("1.2").
 *   pep440  Python's PEP 440: epoch, release, pre (a, b, rc), post, dev and local versions, with the spec's spellings
 *           (alpha, beta, c, pre, preview, rev, r, implicit post "1.0-1"), normalised before comparing.
 *   maven   Maven's ComparableVersion: items split at ".", "-" and between digits and letters; the qualifiers
 *           alpha < beta < milestone < rc = cr < snapshot < "" = ga = final = release < sp, others after them.
 *   loose   numbers separated by dots; whatever follows makes a pre-release when it names one (alpha, beta, rc …).
 */

export type Scheme = 'semver' | 'pep440' | 'maven' | 'loose';

export interface Version {
  raw: string;
  scheme: Scheme;
  /** The release numbers (major, minor, patch, …) as written */
  release: number[];
  /** A pre-release (or a development release) */
  pre: boolean;
  /** Scheme-specific, for compare() */
  key: unknown;
}

const MAX_LEN = 128;
const isDigits = (s: string) => s.length > 0 && s.length <= 15 && [...s].every((c) => c >= '0' && c <= '9');
const isAlnumDash = (s: string) => s.length > 0 && [...s].every((c) => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '-');
const cmpNum = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0);
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const stripV = (s: string) => (s.length > 1 && (s[0] === 'v' || s[0] === 'V') && s[1]! >= '0' && s[1]! <= '9' ? s.slice(1) : s);

function cmpRelease(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const c = cmpNum(a[i] ?? 0, b[i] ?? 0);
    if (c) return c;
  }
  return 0;
}

// ---------- SemVer ----------

interface SemverKey {
  pre: (number | string)[];
}

function parseSemver(raw: string): Version | null {
  let s = stripV(raw.trim());
  const plus = s.indexOf('+');
  if (plus >= 0) s = s.slice(0, plus);
  const dash = s.indexOf('-');
  const main = dash >= 0 ? s.slice(0, dash) : s;
  const preText = dash >= 0 ? s.slice(dash + 1) : '';
  const parts = main.split('.');
  if (parts.length > 4 || !parts.every(isDigits)) return null;
  if (dash >= 0 && !preText) return null;
  const pre: (number | string)[] = [];
  if (preText)
    for (const id of preText.split('.')) {
      if (!isAlnumDash(id)) return null;
      pre.push(isDigits(id) ? Number(id) : id);
    }
  return { raw, scheme: 'semver', release: parts.map(Number), pre: pre.length > 0, key: { pre } satisfies SemverKey };
}

function cmpSemver(a: Version, b: Version): number {
  const r = cmpRelease(a.release, b.release);
  if (r) return r;
  const pa = (a.key as SemverKey).pre;
  const pb = (b.key as SemverKey).pre;
  if (!pa.length || !pb.length) return pa.length === pb.length ? 0 : pa.length ? -1 : 1;
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i]!;
    const y = pb[i]!;
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return cmpNum(x, y);
    } else if (typeof x === 'number') return -1;
    else if (typeof y === 'number') return 1;
    else if (x !== y) return cmpStr(x, y);
  }
  return cmpNum(pa.length, pb.length);
}

// ---------- PEP 440 ----------

interface Pep440Key {
  epoch: number;
  release: number[];
  /** [rank, n]: dev-only -Infinity, a 0, b 1, rc 2, none +Infinity */
  pre: [number, number];
  post: number;
  dev: number;
  local: (number | string)[];
}

const PEP_PRE: [string, number][] = [
  ['preview', 2],
  ['alpha', 0],
  ['beta', 1],
  ['pre', 2],
  ['rc', 2],
  ['a', 0],
  ['b', 1],
  ['c', 2],
];
const PEP_POST = ['post', 'rev', 'r'];

/** Reads digits at i; returns [value, next index] or null. */
function digitsAt(s: string, i: number): [number, number] | null {
  let j = i;
  while (j < s.length && j - i < 15 && s[j]! >= '0' && s[j]! <= '9') j++;
  return j > i ? [Number(s.slice(i, j)), j] : null;
}
const sepAt = (s: string, i: number) => (s[i] === '.' || s[i] === '-' || s[i] === '_' ? i + 1 : i);

function parsePep440(raw: string): Version | null {
  let s = raw.trim().toLowerCase();
  if (s.startsWith('v')) s = s.slice(1);
  let local: (number | string)[] = [];
  const plus = s.indexOf('+');
  if (plus >= 0) {
    const l = s.slice(plus + 1);
    s = s.slice(0, plus);
    const segs = l.split(/[._-]/);
    if (!segs.every((x) => x.length > 0 && [...x].every((c) => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z')))) return null;
    local = segs.map((x) => (isDigits(x) ? Number(x) : x));
  }
  let epoch = 0;
  const bang = s.indexOf('!');
  if (bang >= 0) {
    if (!isDigits(s.slice(0, bang))) return null;
    epoch = Number(s.slice(0, bang));
    s = s.slice(bang + 1);
  }
  // release: N(.N)*
  const release: number[] = [];
  let i = 0;
  for (;;) {
    const d = digitsAt(s, i);
    if (!d) return null;
    release.push(d[0]);
    i = d[1];
    if (s[i] === '.' && s[i + 1] !== undefined && s[i + 1]! >= '0' && s[i + 1]! <= '9') i++;
    else break;
  }
  let pre: [number, number] | null = null;
  let post: number | null = null;
  let dev: number | null = null;
  // pre-release
  {
    const j = sepAt(s, i);
    const hit = PEP_PRE.find(([w]) => s.startsWith(w, j));
    if (hit) {
      const k = sepAt(s, j + hit[0].length);
      const d = digitsAt(s, k);
      pre = [hit[1], d ? d[0] : 0];
      i = d ? d[1] : j + hit[0].length;
    }
  }
  // post-release: [sep]post[sep]N, or -N
  {
    const j = sepAt(s, i);
    const word = PEP_POST.find((w) => s.startsWith(w, j) && !s.startsWith('rc', j));
    if (word) {
      const k = sepAt(s, j + word.length);
      const d = digitsAt(s, k);
      post = d ? d[0] : 0;
      i = d ? d[1] : j + word.length;
    } else if (s[i] === '-') {
      const d = digitsAt(s, i + 1);
      if (d) {
        post = d[0];
        i = d[1];
      }
    }
  }
  // development release
  {
    const j = sepAt(s, i);
    if (s.startsWith('dev', j)) {
      const k = sepAt(s, j + 3);
      const d = digitsAt(s, k);
      dev = d ? d[0] : 0;
      i = d ? d[1] : j + 3;
    }
  }
  if (i !== s.length) return null;
  const trimmed = [...release];
  while (trimmed.length > 1 && trimmed[trimmed.length - 1] === 0) trimmed.pop();
  const key: Pep440Key = {
    epoch,
    release: trimmed,
    pre: pre ?? (post === null && dev !== null ? [-Infinity, 0] : [Infinity, 0]),
    post: post ?? -Infinity,
    dev: dev ?? Infinity,
    local,
  };
  return { raw, scheme: 'pep440', release, pre: pre !== null || dev !== null, key };
}

function cmpPep440(a: Version, b: Version): number {
  const x = a.key as Pep440Key;
  const y = b.key as Pep440Key;
  return (
    cmpNum(x.epoch, y.epoch) ||
    cmpRelease(x.release, y.release) ||
    cmpNum(x.pre[0], y.pre[0]) ||
    cmpNum(x.pre[1], y.pre[1]) ||
    cmpNum(x.post, y.post) ||
    cmpNum(x.dev, y.dev) ||
    cmpLocal(x.local, y.local)
  );
}

/** Local versions: a version with one is newer; segments: numbers above letters, numbers by value. */
function cmpLocal(a: (number | string)[], b: (number | string)[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (typeof x === typeof y) {
      const c = typeof x === 'number' ? cmpNum(x, y as number) : cmpStr(x as string, y as string);
      if (c) return c;
    } else return typeof x === 'number' ? 1 : -1;
  }
  return cmpNum(a.length, b.length);
}

// ---------- Maven ----------

type MItem = { t: 'int'; v: number } | { t: 'str'; v: string } | { t: 'list'; v: MItem[] };

const QUALIFIERS = ['alpha', 'beta', 'milestone', 'rc', 'snapshot', '', 'sp'];
const ALIASES: Record<string, string> = { ga: '', final: '', release: '', cr: 'rc' };
const RELEASE_RANK = QUALIFIERS.indexOf('');

/** The sort key of a qualifier: its rank, unknown ones after all known ones (then by name). */
function qualifierKey(q: string): string {
  const v = ALIASES[q] ?? q;
  const i = QUALIFIERS.indexOf(v);
  return i >= 0 ? String(i) : `${QUALIFIERS.length}-${v}`;
}

const isNull = (it: MItem): boolean => (it.t === 'int' ? it.v === 0 : it.t === 'str' ? qualifierKey(it.v) === String(RELEASE_RANK) : it.v.length === 0);

function normalize(list: MItem[]): void {
  for (let i = list.length - 1; i >= 0; i--) {
    const it = list[i]!;
    if (isNull(it)) list.splice(i, 1);
    else if (it.t !== 'list') break;
  }
}

function parseMavenItems(raw: string): MItem[] | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  const root: MItem[] = [];
  let list = root;
  const stack: MItem[][] = [root];
  let start = 0;
  let digit = false;
  const item = (text: string, wasDigit: boolean): MItem => {
    if (wasDigit) return { t: 'int', v: Number(text.slice(0, 15)) };
    return { t: 'str', v: text };
  };
  const strItem = (text: string, followedByDigit: boolean): MItem => {
    // a1, b1, m1 are alpha-1, beta-1, milestone-1
    if (followedByDigit && text.length === 1) return { t: 'str', v: text === 'a' ? 'alpha' : text === 'b' ? 'beta' : text === 'm' ? 'milestone' : text };
    return { t: 'str', v: text };
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const isD = c >= '0' && c <= '9';
    if (c === '.') {
      list.push(i === start ? { t: 'int', v: 0 } : item(s.slice(start, i), digit));
      start = i + 1;
    } else if (c === '-') {
      list.push(i === start ? { t: 'int', v: 0 } : item(s.slice(start, i), digit));
      start = i + 1;
      const sub: MItem[] = [];
      list.push({ t: 'list', v: sub });
      list = sub;
      stack.push(sub);
    } else if (isD) {
      if (!digit && i > start) {
        list.push(strItem(s.slice(start, i), true));
        start = i;
        const sub: MItem[] = [];
        list.push({ t: 'list', v: sub });
        list = sub;
        stack.push(sub);
      }
      digit = true;
    } else {
      if (digit && i > start) {
        list.push(item(s.slice(start, i), true));
        start = i;
        const sub: MItem[] = [];
        list.push({ t: 'list', v: sub });
        list = sub;
        stack.push(sub);
      }
      digit = false;
    }
  }
  if (s.length > start) list.push(item(s.slice(start), digit));
  for (const l of stack.reverse()) normalize(l);
  return root;
}

function cmpItem(a: MItem | undefined, b: MItem | undefined): number {
  if (!a && !b) return 0;
  if (!a) return -cmpItem(b, undefined);
  if (a.t === 'int') {
    if (!b) return a.v === 0 ? 0 : 1;
    if (b.t === 'int') return cmpNum(a.v, b.v);
    return 1;
  }
  if (a.t === 'str') {
    const ka = qualifierKey(a.v);
    if (!b) return cmpStr(ka, String(RELEASE_RANK));
    if (b.t === 'int' || b.t === 'list') return -1;
    return cmpStr(ka, qualifierKey(b.v));
  }
  if (!b) return a.v.length ? cmpItem(a.v[0], undefined) : 0;
  if (b.t === 'int') return -1;
  if (b.t === 'str') return 1;
  for (let i = 0; i < Math.max(a.v.length, b.v.length); i++) {
    const c = cmpItem(a.v[i], b.v[i]);
    if (c) return c;
  }
  return 0;
}

function parseMaven(raw: string): Version | null {
  if (raw.trim().length > MAX_LEN) return null;
  const items = parseMavenItems(raw);
  if (!items) return null;
  const first = raw.trim()[0];
  if (!first || first < '0' || first > '9') return null;
  const release: number[] = [];
  for (const it of items) {
    if (it.t !== 'int') break;
    release.push(it.v);
  }
  // keep the numbers as written (1.0 stays [1, 0] for "behind")
  const written: number[] = [];
  for (const part of raw.trim().split(/[.-]/)) {
    if (!isDigits(part)) break;
    written.push(Number(part));
  }
  const pre = hasPreQualifier(items);
  return { raw, scheme: 'maven', release: written.length ? written : release, pre, key: items };
}

function hasPreQualifier(items: MItem[]): boolean {
  for (const it of items) {
    if (it.t === 'str') {
      const k = qualifierKey(it.v);
      const rank = Number(k);
      if (Number.isInteger(rank) && rank < RELEASE_RANK) return true;
    } else if (it.t === 'list' && hasPreQualifier(it.v)) return true;
  }
  return false;
}

const cmpMaven = (a: Version, b: Version) => cmpItem({ t: 'list', v: a.key as MItem[] }, { t: 'list', v: b.key as MItem[] });

// ---------- loose ----------

const PRE_WORDS = ['alpha', 'beta', 'rc', 'pre', 'preview', 'dev', 'snapshot', 'nightly', 'canary', 'next', 'insiders', 'ea', 'b', 'a', 'm'];

function parseLoose(raw: string): Version | null {
  const s = stripV(raw.trim());
  const release: number[] = [];
  let i = 0;
  for (;;) {
    const d = digitsAt(s, i);
    if (!d) return null;
    release.push(d[0]);
    i = d[1];
    if (s[i] === '.' && s[i + 1] !== undefined && s[i + 1]! >= '0' && s[i + 1]! <= '9' && release.length < 6) i++;
    else break;
  }
  const rest = s.slice(i).toLowerCase();
  const words = rest.split(/[^a-z]+/).filter(Boolean);
  const pre = words.some((w) => PRE_WORDS.includes(w));
  return { raw, scheme: 'loose', release, pre, key: rest };
}

function cmpLoose(a: Version, b: Version): number {
  const r = cmpRelease(a.release, b.release);
  if (r) return r;
  if (a.pre !== b.pre) return a.pre ? -1 : 1;
  return cmpStr(a.key as string, b.key as string);
}

// ---------- API ----------

const PARSERS: Record<Scheme, (s: string) => Version | null> = { semver: parseSemver, pep440: parsePep440, maven: parseMaven, loose: parseLoose };
const COMPARE: Record<Scheme, (a: Version, b: Version) => number> = { semver: cmpSemver, pep440: cmpPep440, maven: cmpMaven, loose: cmpLoose };

/** A version of this scheme, or null when the text is none. */
export function parseVersion(text: string, scheme: Scheme): Version | null {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_LEN) return null;
  return PARSERS[scheme](text);
}

/** Compares two versions of the same scheme: negative when a is older. */
export function compareVersions(a: Version, b: Version): number {
  if (a.scheme !== b.scheme) return cmpRelease(a.release, b.release);
  return COMPARE[a.scheme](a, b);
}

/**
 * How far the installed version is behind the newest: the first of major, minor, patch that differs (the others 0).
 * Parts the installed version leaves out match any ("24" is not behind 24.11.1). A newer version with the same three
 * numbers (a fourth number, a final release after a pre-release) counts as a patch.
 */
export function behindOf(installed: Version, newest: Version): { lag: VersionLag; behind: VersionBehind | null } {
  const zero = { major: 0, minor: 0, patch: 0 };
  const names = ['major', 'minor', 'patch'] as const;
  for (let i = 0; i < 3; i++) {
    if (i >= installed.release.length) return { lag: 'current', behind: zero };
    const a = installed.release[i]!;
    const b = newest.release[i] ?? 0;
    if (b > a) return { lag: names[i]!, behind: { ...zero, [names[i]!]: b - a } };
    if (b < a) return { lag: 'current', behind: zero };
  }
  return compareVersions(installed, newest) < 0 ? { lag: 'patch', behind: zero } : { lag: 'current', behind: zero };
}

/** The newest of these versions (pre-releases only when `prereleases`). */
export function newestOf<T extends { version: Version }>(list: T[], prereleases: boolean): T | null {
  let best: T | null = null;
  for (const x of list) {
    if (x.version.pre && !prereleases) continue;
    if (!best || compareVersions(x.version, best.version) > 0) best = x;
  }
  return best;
}
