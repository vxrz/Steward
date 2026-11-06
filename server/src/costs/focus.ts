import { COST_LIMITS, FOCUS_COLUMNS, FOCUS_REQUIRED, fromMicros, toMicros, type CostImportPreview, type FocusColumn } from '@sm/shared';
import { sha256 } from '../util.js';
import { readCsv } from './csv.js';
import type { CostLine } from './store.js';

/**
 * FOCUS files (#226, docs/COSTS.md#focus-files): CSV exports in the FinOps Open Cost and Usage Specification, as AWS
 * (Data Exports), Azure (Cost Management exports), Google Cloud (FOCUS BigQuery view) and others write them. Steward
 * reads the columns of FOCUS_COLUMNS (by their FOCUS ids, case-insensitive) and ignores the rest.
 *
 * Rows are summed per charge day (rows of an hour or a day; a row over more than a day keeps its own period), currency,
 * provider, service, category, resource, sub account, charge category and tags – so an hourly export becomes about one
 * line per resource and day. Tags (a JSON object) keep string, number and boolean values; keys that could change an
 * object's prototype are dropped, and every object is built with Object.fromEntries.
 */

const DAY = 86_400_000;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const BY_LOWER = new Map(FOCUS_COLUMNS.map((c) => [c.toLowerCase(), c]));

export interface ParsedFocus {
  sha256: string;
  bytes: number;
  rows: number;
  lines: CostLine[];
  columns: { found: FocusColumn[]; missing: FocusColumn[]; ignored: number };
  periodStart: string | null;
  periodEnd: string | null;
  warnings: string[];
}

export class FocusError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly params: Record<string, string | number> = {},
  ) {
    super(message);
  }
}

/** An ISO 8601 date or date-time (UTC when no offset is given) → ISO string; null when it is not one. */
export function isoOf(v: string): string | null {
  const s = v.trim();
  if (s.length < 10 || s.length > 40) return null;
  // a plain date, or a date-time without zone, is UTC (FOCUS writes UTC)
  const withZone = s.length === 10 ? `${s}T00:00:00Z` : s.endsWith('Z') || s.includes('+', 10) || s.lastIndexOf('-') > 9 ? s : `${s}Z`;
  const t = Date.parse(withZone.replace(' ', 'T'));
  if (!Number.isFinite(t)) return null;
  const year = new Date(t).getUTCFullYear();
  if (year < 2000 || year > 2200) return null;
  return new Date(t).toISOString();
}

/** The tags of a cell (a JSON object): string values, at most COST_LIMITS.tags, without prototype keys. */
export function parseTags(cell: string): Record<string, string> | null {
  const s = cell.trim();
  if (!s) return {};
  let v: unknown;
  try {
    v = JSON.parse(s);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const entries: [string, string][] = [];
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(k) || !k || k.length > COST_LIMITS.tagChars) continue;
    if (typeof x !== 'string' && typeof x !== 'number' && typeof x !== 'boolean') continue;
    entries.push([k, String(x).slice(0, COST_LIMITS.tagChars)]);
    if (entries.length >= COST_LIMITS.tags) break;
  }
  return Object.fromEntries(entries);
}

const monthStart = (iso: string) => `${iso.slice(0, 7)}-01T00:00:00.000Z`;
const nextMonth = (iso: string) => {
  const d = new Date(monthStart(iso));
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
};

/** Reads a FOCUS CSV file into cost lines (summed per day and dimension). Throws FocusError or CsvError. */
export function parseFocus(csv: string): ParsedFocus {
  const bytes = Buffer.byteLength(csv, 'utf8');
  if (bytes > COST_LIMITS.importBytes)
    throw new FocusError(`The file has more than ${COST_LIMITS.importBytes / 1024 / 1024} MB`, 'COST_IMPORT_TOO_LARGE', {
      maxMb: COST_LIMITS.importBytes / 1024 / 1024,
    });
  let index: Partial<Record<FocusColumn, number>> = {};
  let ignored = 0;
  const warnings: string[] = [];
  let skipped = 0;
  let badTags = 0;
  const sums = new Map<string, CostLine>();
  let first: string | null = null;
  let last: string | null = null;
  const skip = (line: number, why: string) => {
    if (skipped++ < 10) warnings.push(`Line ${line}: ${why} – the row is left out`);
  };
  const rows = readCsv(csv, { rows: COST_LIMITS.importRows, columns: COST_LIMITS.importColumns, cellChars: COST_LIMITS.cellChars }, (cells, line, i) => {
    if (i < 0) {
      const found: [FocusColumn, number][] = [];
      cells.forEach((h, n) => {
        const c = BY_LOWER.get(h.trim().toLowerCase());
        if (c && !found.some(([x]) => x === c)) found.push([c, n]);
        else ignored++;
      });
      index = Object.fromEntries(found) as Partial<Record<FocusColumn, number>>;
      const missing = FOCUS_REQUIRED.filter((c) => index[c] === undefined);
      if (missing.length)
        throw new FocusError(`Not a FOCUS file: the column(s) ${missing.join(', ')} are missing`, 'COST_IMPORT_COLUMNS', { missing: missing.join(', ') });
      return;
    }
    const get = (c: FocusColumn) => {
      const n = index[c];
      return n === undefined ? '' : (cells[n] ?? '').trim();
    };
    const text = (c: FocusColumn) => get(c).slice(0, COST_LIMITS.textChars);
    const start = isoOf(get('ChargePeriodStart'));
    const end = isoOf(get('ChargePeriodEnd'));
    if (!start || !end || end < start) return skip(line, 'ChargePeriodStart or ChargePeriodEnd is not a date');
    const billed = toMicros(get('BilledCost'));
    if (billed === null) return skip(line, `BilledCost "${get('BilledCost').slice(0, 40)}" is not a number`);
    const effRaw = get('EffectiveCost');
    const effective = effRaw ? toMicros(effRaw) : billed;
    if (effective === null) return skip(line, `EffectiveCost "${effRaw.slice(0, 40)}" is not a number`);
    const currency = get('BillingCurrency').toUpperCase();
    if (currency.length !== 3 || [...currency].some((ch) => ch < 'A' || ch > 'Z'))
      return skip(line, `BillingCurrency "${currency.slice(0, 10)}" is not a currency code`);
    const tags = parseTags(get('Tags'));
    if (tags === null) badTags++;
    const spansDay = Date.parse(end) - Date.parse(start) <= DAY;
    const cps = spansDay ? `${start.slice(0, 10)}T00:00:00.000Z` : start;
    const cpe = spansDay ? new Date(Date.parse(cps) + DAY).toISOString() : end;
    const bps = isoOf(get('BillingPeriodStart')) ?? monthStart(start);
    const bpe = isoOf(get('BillingPeriodEnd')) ?? nextMonth(start);
    const provider = text('ProviderName') || text('ServiceProviderName');
    const line0: Omit<CostLine, 'key' | 'billed' | 'effective'> = {
      granularity: spansDay ? 'day' : 'month',
      billingPeriodStart: bps,
      billingPeriodEnd: bpe,
      chargePeriodStart: cps,
      chargePeriodEnd: cpe,
      currency,
      provider,
      service: text('ServiceName'),
      category: text('ServiceCategory'),
      resourceId: text('ResourceId'),
      resourceName: text('ResourceName'),
      subAccountId: text('SubAccountId'),
      chargeCategory: text('ChargeCategory'),
      tags: tags ?? {},
    };
    const k = JSON.stringify([
      cps,
      cpe,
      bps,
      currency,
      provider,
      line0.service,
      line0.category,
      line0.resourceId,
      line0.subAccountId,
      line0.chargeCategory,
      Object.entries(line0.tags).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ]);
    const s = sums.get(k);
    if (s) {
      s.billed += billed;
      s.effective += effective;
    } else sums.set(k, { ...line0, key: sha256(k).slice(0, 40), billed, effective });
    if (!first || cps < first) first = cps;
    if (!last || cpe > last) last = cpe;
  });
  if (index.BilledCost === undefined) throw new FocusError('The file is empty', 'COST_IMPORT_EMPTY');
  if (skipped > 10) warnings.push(`… ${skipped - 10} more rows left out`);
  if (badTags) warnings.push(`${badTags} row(s) with Tags that are not a JSON object: their tags are left out`);
  const found = FOCUS_COLUMNS.filter((c) => index[c] !== undefined);
  return {
    sha256: sha256(csv),
    bytes,
    rows,
    lines: [...sums.values()],
    columns: { found, missing: FOCUS_COLUMNS.filter((c) => index[c] === undefined && c !== 'ServiceProviderName' && c !== 'ProviderName'), ignored },
    periodStart: first,
    periodEnd: last,
    warnings,
  };
}

/** Totals per currency, providers and a sample of a parsed file (the preview). */
export function summarize(p: ParsedFocus): Pick<CostImportPreview, 'totals' | 'providers' | 'sample'> {
  const totals = new Map<string, { billed: number; effective: number }>();
  for (const l of p.lines) {
    const t = totals.get(l.currency) ?? { billed: 0, effective: 0 };
    t.billed += l.billed;
    t.effective += l.effective;
    totals.set(l.currency, t);
  }
  return {
    totals: [...totals.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, t]) => ({ currency, billed: fromMicros(t.billed), effective: fromMicros(t.effective) })),
    providers: [...new Set(p.lines.map((l) => l.provider).filter(Boolean))].sort().slice(0, 20),
    sample: [...p.lines]
      .sort((a, b) => b.effective - a.effective)
      .slice(0, COST_LIMITS.previewRows)
      .map((l) => ({
        chargePeriodStart: l.chargePeriodStart,
        provider: l.provider,
        service: l.service,
        resourceId: l.resourceId,
        billed: fromMicros(l.billed),
        effective: fromMicros(l.effective),
        currency: l.currency,
      })),
  };
}
