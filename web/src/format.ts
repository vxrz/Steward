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

/** Number in the UI language, e.g. 1,284 / 1.284 */
export function fmtNumber(n: number | null | undefined, opts: Intl.NumberFormatOptions = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  return numberFormat(opts).format(n);
}

export function fmtDate(s?: string | null): string {
  if (!s) return '–';
  return dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' }).format(new Date(s));
}

/** Calendar date without time. */
export function fmtDay(s?: string | number | Date | null): string {
  if (s === null || s === undefined || s === '') return '–';
  return dateTimeFormat({ dateStyle: 'medium' }).format(new Date(s));
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
