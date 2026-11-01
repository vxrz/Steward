/**
 * CSV for spreadsheets (#18): one writer for the audit export, the credential register and evidence packs.
 *
 * Cells a spreadsheet would read as a formula (= + - @, tab, carriage return) get a leading apostrophe (OWASP "CSV
 * injection"): the user name of a failed sign-in, for example, is chosen by whoever tries to sign in.
 */

export interface CsvOptions {
  /** "always" quotes every cell (audit export, evidence packs); "needed" only cells with a quote, comma, semicolon or line break */
  quote?: 'always' | 'needed';
  /** A byte order mark first, so Excel reads the file as UTF-8 */
  bom?: boolean;
}

const text = (v: unknown): string =>
  v === null || v === undefined
    ? ''
    : typeof v === 'string'
      ? v
      : typeof v === 'number' || typeof v === 'boolean'
        ? String(v)
        : Array.isArray(v)
          ? v.map(text).join('; ')
          : JSON.stringify(v);

/** One cell: lists joined with "; ", objects as JSON, formulas defused. */
export function csvCell(v: unknown, quote: CsvOptions['quote'] = 'always'): string {
  let s = text(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return quote === 'always' || /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A whole file: the header row, then one row per item, lines ending in CRLF. */
export function csvTable(head: readonly string[], rows: readonly (readonly unknown[])[], o: CsvOptions = {}): string {
  const lines = [head.join(','), ...rows.map((r) => r.map((v) => csvCell(v, o.quote)).join(','))];
  return (o.bom ? '﻿' : '') + lines.join('\r\n') + '\r\n';
}
