import { formatLocale } from './i18n';

// Formatting follows the UI language (see formatLocale). Intl objects are cached
// per locale and options because tables call these helpers for every row.
type Formatter = Intl.DateTimeFormat | Intl.NumberFormat | Intl.RelativeTimeFormat | Intl.ListFormat;
const cache = new Map<string, Formatter>();
function cached<T extends Formatter>(kind: string, opts: object, make: (loc: string) => T): T {
  const loc = formatLocale();
  const key = `${kind}|${loc}|${JSON.stringify(opts)}`;
  let f = cache.get(key) as T | undefined;
  if (!f) cache.set(key, (f = make(loc)));
  return f;
}

export const dateTimeFormat = (opts: Intl.DateTimeFormatOptions) => cached('dt', opts, (l) => new Intl.DateTimeFormat(l, opts));
export const numberFormat = (opts: Intl.NumberFormatOptions = {}) => cached('n', opts, (l) => new Intl.NumberFormat(l, opts));
/** "A, B and C" / "A, B und C" */
export const listFormat = (opts: Intl.ListFormatOptions = { type: 'conjunction' }) => cached('l', opts, (l) => new Intl.ListFormat(l, opts));

/**
 * Today in the browser's time zone as `YYYY-MM-DD` (or `days` later), for date inputs, their limits and day counts.
 * Not `new Date().toISOString().slice(0, 10)`: that is the day in UTC, yesterday between midnight and 01:00/02:00 in
 * Europe (ESLint refuses it in web/).
 */
export function localToday(days = 0): string {
  const n = new Date();
  if (days) n.setDate(n.getDate() + days);
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

/**
 * The first letter upper-case, for names stored in lower case that start a line or a heading (the neutral topic names
 * of the built-in control catalogues: "5.1 Information security policies").
 */
export function capFirst(s: string): string {
  return s ? s.charAt(0).toLocaleUpperCase() + s.slice(1) : s;
}

/** Number in the UI language, e.g. 1,284 / 1.284 */
export function fmtNumber(n: number | null | undefined, opts: Intl.NumberFormatOptions = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  return numberFormat(opts).format(n);
}

export function fmtDate(s?: string | null): string {
  if (!s) return '–';
  return dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' }).format(new Date(s));
}

/**
 * A span of date and time, the day once when it is the same: "16 Nov 2026, 21:00 – 23:00" (not "16 Nov 2026, 21:00 –
 * 16 Nov 2026, 23:00"); across days both in full.
 */
export function fmtDateRange(from: string, to: string): string {
  const a = new Date(from);
  const b = new Date(to);
  if (!(b.getTime() >= a.getTime())) return `${fmtDate(from)} – ${fmtDate(to)}`;
  return dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' }).formatRange(a, b);
}

/** Calendar date without time. */
export function fmtDay(s?: string | number | Date | null): string {
  if (s === null || s === undefined || s === '') return '–';
  return dateTimeFormat({ dateStyle: 'medium' }).format(new Date(s));
}

/**
 * A calendar day stored as `YYYY-MM-DD` (validity, end dates) in the UI language: "1 Feb 2027" / "01.02.2027". Read
 * as local midnight – `new Date('2027-02-01')` is UTC midnight, the day before west of Greenwich. Anything else as is.
 */
export function fmtDayOnly(s?: string | null): string {
  if (!s) return '–';
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? fmtDay(`${s}T00:00:00`) : s;
}

/** A decimal text (a percentage, a unit price) in the UI language with every digit it has: "12.5" → "12,5" in German. */
export function fmtDecimal(s?: string | null): string {
  if (s === null || s === undefined || s.trim() === '') return '–';
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  const digits = /\.(\d+)$/.exec(s.trim())?.[1]?.length ?? 0;
  return numberFormat({ maximumFractionDigits: Math.min(digits, 20) }).format(n);
}

/** Time of day with seconds (logs). */
export function fmtTime(s: string | number | Date): string {
  return dateTimeFormat({ timeStyle: 'medium' }).format(new Date(s));
}

export function fmtRelative(s?: string | null): string {
  if (!s) return '–';
  const diff = (new Date(s).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const rtf = cached('rt', { numeric: 'auto' }, (l) => new Intl.RelativeTimeFormat(l, { numeric: 'auto' }));
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

/** 850 ms · 1.2 s · 3 min 4 s (unit symbols are the same in all supported languages; numbers follow the locale). */
export function fmtDuration(ms?: number | null): string {
  if (ms == null) return '';
  if (ms < 1000) return `${fmtNumber(ms)} ms`;
  if (ms < 60000) return `${fmtNumber(ms / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
  return `${fmtNumber(Math.floor(ms / 60000))} min ${Math.round((ms % 60000) / 1000)} s`;
}

export function runDuration(start: string, end?: string | null): string {
  return fmtDuration((end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime());
}

/** 1536 → "1.5 KB" (binary steps, locale decimal separator). */
export function fmtBytes(n?: number | null): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${fmtNumber(v, { maximumFractionDigits: v < 10 && i > 0 ? 1 : 0 })} ${units[i]}`;
}
