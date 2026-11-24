/**
 * What a failing check is about, for deciding whether a result is news (0.27.0).
 *
 * As alerting tools do it (Alertmanager labels, PagerDuty and Opsgenie dedup keys), a failing check is identified by
 * *what* fails – its severity and the set of affected items – not by the words of its message. While the identity
 * stays, the check is "still failing": it is told again only as a reminder. The identity of one result is a list of
 * keys, taken from the first of:
 *   1. `changeKey` of the check step: the author's stable keys, used as they are;
 *   2. `items` of the check step: each item, normalised (below);
 *   3. the message, normalised.
 *
 * The normaliser masks what changes from run to run although nothing else did, and keeps what names things:
 *   - UUIDs and long hexadecimal ids (8+ characters with a digit and a letter) → <id>
 *   - dates and times (2026-11-19, 2026-11-19T10:15:00Z, 19.11.2026) → <time>
 *   - generated suffixes of Kubernetes pod names (web-7d9f8b6c5d-x2k9p, agent-x2k9p) → web-<id>, agent-<id>
 *   - durations, also several in a row (5 min, 3 days, 1 h 20 min, 90s) → <duration>
 *   - numbers that stand alone, with their sign (12, -2.5, 99.5, 1/3, 10:15) → #; a number that is part of a name
 *     (plc-01, node7, v2) stays, and so do IPv4 addresses
 *   - exception for items (not messages): a plain integer that names something – right after a capitalised word and a
 *     single space, and not followed by a unit (Line 2, Machine 17 – PowerMeter, Linie 3 steht) – stays, so another
 *     line or machine is another item; Disk 91%, Tank 3 bar, usage 91, 3 endpoints, (14 restarts), 1/3 are still masked.
 *     A lowercase name ("line 2") is masked: use `changeKey` for those
 *   - a word right after a masked number loses a plural "s" (1 endpoint, 2 endpoints → # endpoint)
 *   - runs of spaces → one space
 */

export type IdentityBasis = 'key' | 'items' | 'message';

export interface CheckIdentity {
  by: IdentityBasis;
  /** As shown (changeKey values, items or the message) */
  list: string[];
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISO_TIME = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;
const DOTTED_DATE = /\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/g;
// Kubernetes builds pod names from the owner's name, the ReplicaSet's hash and a random part, in this alphabet
const K8S_SAFE = '[bcdfghjklmnpqrstvwxz2456789]';
const K8S_SUFFIX = new RegExp(`(?<=[A-Za-z0-9])(?:-${K8S_SAFE}{6,10})?-${K8S_SAFE}{5}(?![A-Za-z0-9-])`, 'g');
const HEX_ID = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi;
const UNITS =
  'ms|s|sec|secs|seconds?|m|min|mins|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?|months?|y|yrs?|years?|sek|sekunden?|minuten?|std|stunden?|tagen?|tage?|wochen?|monaten?|monate?|jahren?|jahre?';
const ONE_DURATION = `\\d+(?:[.,]\\d+)?\\s?(?:${UNITS})\\b`;
const DURATION = new RegExp(`(?<![\\w.-])${ONE_DURATION}(?:,?\\s*(?:and\\s+|und\\s+)?${ONE_DURATION})*`, 'gi');
const NUMBER = /(?<![\w.\-/:+])[-+]?\d+(?:[.,:/]\d+)*(?![\w-])/g;
const IPV4 = /^[-+]?\d{1,3}(?:\.\d{1,3}){3}$/;
// A unit right after a number makes it a quantity, not a name (Disk 91%, Tank 3 bar)
const QUANTITY_UNIT = /(?:[%‰°]|[ \u00a0]?(?:mbar|bar|Pa|kPa|MPa|mV|kV|V|mA|A|kWh|Wh|kW|MW|W|Hz|rpm|kB|KB|MB|GB|TB|KiB|MiB|GiB|TiB|B)\b)/y;
const LETTER = /\p{L}/u;
const UPPER = /\p{Lu}/u;
const PLURAL = /# ([A-Za-z]{2,})s\b/g;

/** Whether a number is part of a name: a plain integer after a capitalised word and one space, without a unit. Linear. */
function namesSomething(n: string, offset: number, str: string): boolean {
  if (!/^\d+$/.test(n)) return false;
  const sep = str[offset - 1];
  if (sep !== ' ' && sep !== '\u00a0') return false;
  let start = offset - 1;
  while (start > 0 && LETTER.test(str[start - 1]!)) start--;
  if (start === offset - 1 || !UPPER.test(str[start]!)) return false;
  QUANTITY_UNIT.lastIndex = offset + n.length;
  return !QUANTITY_UNIT.test(str);
}

/** The text with its volatile parts masked (see above). Deterministic; the same input always gives the same key. */
export function normalise(text: string, opts: { names?: boolean } = {}): string {
  return text
    .replace(UUID, '<id>')
    .replace(ISO_TIME, '<time>')
    .replace(DOTTED_DATE, '<time>')
    .replace(K8S_SUFFIX, '-<id>')
    .replace(HEX_ID, '<id>')
    .replace(DURATION, '<duration>')
    .replace(NUMBER, (n, offset: number, str: string) => {
      if (IPV4.test(n)) return n;
      return opts.names && namesSomething(n, offset, str) ? n : '#';
    })
    .replace(PLURAL, '# $1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The key of one entry of an identity: changeKey values as they are, items and messages normalised. */
export const keyOf = (by: IdentityBasis, s: string): string => (by === 'key' ? s.trim() : normalise(s, { names: by === 'items' }));

/** The identity of a failing result. */
export function identityOf(o: { changeKey?: string[]; items?: string[]; message: string }): CheckIdentity {
  if (o.changeKey?.length) return { by: 'key', list: o.changeKey };
  if (o.items?.length) return { by: 'items', list: o.items };
  return { by: 'message', list: [o.message] };
}

/** Most entries an identity keeps (what was told grows by changes until the next reminder). */
const TOLD_MAX = 500;

/** What is new and what is gone, compared with what was told. Entries are returned as shown. */
export function compareIdentity(told: CheckIdentity, now: CheckIdentity): { added: string[]; removed: string[] } {
  const keysNow = new Map(now.list.map((s) => [keyOf(now.by, s), s]));
  const keysTold = new Map(told.list.map((s) => [keyOf(told.by, s), s]));
  return {
    added: [...keysNow].filter(([k]) => !keysTold.has(k)).map(([, s]) => s),
    removed: [...keysTold].filter(([k]) => !keysNow.has(k)).map(([, s]) => s),
  };
}

/** What was told after a change: the current entries, and – unless the gone ones were told as gone – those as well. */
export function toldAfter(told: CheckIdentity, now: CheckIdentity, removalsTold: boolean): CheckIdentity {
  if (removalsTold || told.by !== now.by) return now;
  const keys = new Set(now.list.map((s) => keyOf(now.by, s)));
  const kept = told.list.filter((s) => !keys.has(keyOf(told.by, s)));
  const list = [...now.list, ...kept];
  return { by: now.by, list: list.length > TOLD_MAX ? now.list : list };
}

/** The stored identity, or null when it is missing (a row from before 0.27.0) or unreadable. */
export function parseIdentity(raw: string | null | undefined): CheckIdentity | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<CheckIdentity>;
    if ((v.by === 'key' || v.by === 'items' || v.by === 'message') && Array.isArray(v.list) && v.list.every((x) => typeof x === 'string'))
      return { by: v.by, list: v.list };
  } catch {
    // unreadable: treated as missing
  }
  return null;
}
