import { INFLUX_CONTROL_RE, INFLUX_LIMITS, influxSeriesName, type InfluxVersion } from '@sm/shared';

/**
 * The queries of the freshness check's InfluxDB source (0.18.0, docs/MONITORS.md#freshness-in-influxdb) and the parsers
 * of their answers – pure, no I/O. Steward writes every query itself: names are quoted identifiers, values are string
 * literals, both escaped for the dialect (InfluxQL, Flux, SQL); a control character in either is refused, never
 * passed on. Durations and limits are integers Steward computed.
 */

export class InfluxQueryError extends Error {}

export type InfluxDialect = 'influxql' | 'flux' | 'sql';

/** What the check reads: one series per value of `groupBy` (and per field, with fields). */
export interface InfluxReadSpec {
  version: InfluxVersion;
  dialect: InfluxDialect;
  /** 1.x and 3.x: the database; 2.x: the bucket */
  database: string;
  retentionPolicy?: string;
  measurement: string;
  fields: string[];
  tags: Record<string, string>;
  groupBy?: string;
  lookbackSeconds: number;
}

/** The series read: name ('' for one series), newest timestamp (ms; null: none within the look-back). */
export interface InfluxSeries {
  name: string;
  newest: number | null;
}

function clean(v: string, what: string): string {
  if (typeof v !== 'string') throw new InfluxQueryError(`${what} must be text`);
  if (INFLUX_CONTROL_RE.test(v)) throw new InfluxQueryError(`${what} contains a control character or a line break`);
  return v;
}

// ---------- quoting per dialect ----------

/** InfluxQL identifier: double quotes, \ and " escaped with a backslash. */
export const influxQlIdent = (name: string): string => `"${clean(name, 'A name').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
/** InfluxQL string literal: single quotes, \ and ' escaped with a backslash. */
export const influxQlString = (value: string): string => `'${clean(value, 'A value').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
/** Flux string literal: double quotes; \, " and the start of an interpolation ${ escaped with a backslash. */
export const fluxString = (value: string): string => `"${clean(value, 'A value').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$\{/g, '\\${')}"`;
/** SQL identifier (DataFusion): double quotes, " doubled – the name keeps its case. */
export const sqlIdent = (name: string): string => `"${clean(name, 'A name').replace(/"/g, '""')}"`;
/** SQL string literal (DataFusion): single quotes, ' doubled (a backslash is an ordinary character). */
export const sqlString = (value: string): string => `'${clean(value, 'A value').replace(/'/g, "''")}'`;

/** The look-back of a check's query in seconds: lookbackHours, else 24 h or the freshness window and a half when longer. */
export function lookbackSeconds(lookbackHours: number | undefined, freshnessLookback: number): number {
  const max = INFLUX_LIMITS.maxLookbackHours * 3600;
  if (lookbackHours) return Math.min(max, lookbackHours * 3600);
  return Math.min(max, Math.max(INFLUX_LIMITS.defaultLookbackHours * 3600, Math.ceil(freshnessLookback)));
}

const seconds = (s: number): number => {
  if (!Number.isInteger(s) || s < 1 || s > INFLUX_LIMITS.maxLookbackHours * 3600) throw new InfluxQueryError('The look-back is out of range');
  return s;
};
/** Rows read per query: one more than the cap, to tell "more than the cap" */
const ROWS = INFLUX_LIMITS.series + 1;

// ---------- InfluxQL (1.x /query, 3.x /api/v3/query_influxql) ----------

/**
 * One statement per field (`last()` gives the time of the newest point of that field), or with no field the newest
 * point of any field (`SELECT *`, newest first, one row per series). 1.x caps the series with SLIMIT; InfluxDB 3 has
 * no SLIMIT, the answer is capped when read.
 */
export function influxQlStatements(spec: InfluxReadSpec): string[] {
  const from =
    spec.version === '1' && spec.retentionPolicy
      ? `${influxQlIdent(spec.database)}.${influxQlIdent(spec.retentionPolicy)}.${influxQlIdent(spec.measurement)}`
      : influxQlIdent(spec.measurement);
  const where = [
    `time > now() - ${seconds(spec.lookbackSeconds)}s`,
    ...Object.entries(spec.tags).map(([k, v]) => `${influxQlIdent(k)} = ${influxQlString(v)}`),
  ].join(' AND ');
  const group = spec.groupBy ? ` GROUP BY ${influxQlIdent(spec.groupBy)}` : '';
  const slimit = spec.groupBy && spec.version === '1' ? ` SLIMIT ${ROWS}` : '';
  if (!spec.fields.length) return [`SELECT * FROM ${from} WHERE ${where}${group} ORDER BY time DESC LIMIT 1${slimit}`];
  return spec.fields.map((f) => `SELECT last(${influxQlIdent(f)}) FROM ${from} WHERE ${where}${group}${slimit}`);
}

// ---------- Flux (2.x /api/v2/query) ----------

/**
 * The newest point per series (`last()` on each table, pushed down to storage), then the newest per group (the
 * grouping tag, and `_field` with fields), merged into one table of at most ROWS rows: `_time`, the tag, `_field`.
 */
export function fluxQuery(spec: InfluxReadSpec): string {
  const lines = [`from(bucket: ${fluxString(spec.database)})`, `  |> range(start: -${seconds(spec.lookbackSeconds)}s)`];
  lines.push(`  |> filter(fn: (r) => r._measurement == ${fluxString(spec.measurement)})`);
  for (const [k, v] of Object.entries(spec.tags)) lines.push(`  |> filter(fn: (r) => r[${fluxString(k)}] == ${fluxString(v)})`);
  if (spec.fields.length) lines.push(`  |> filter(fn: (r) => ${spec.fields.map((f) => `r._field == ${fluxString(f)}`).join(' or ')})`);
  const columns = [...(spec.groupBy ? [spec.groupBy] : []), ...(spec.fields.length ? ['_field'] : [])];
  lines.push(
    '  |> last()',
    `  |> group(columns: [${columns.map(fluxString).join(', ')}])`,
    '  |> sort(columns: ["_time"], desc: true)',
    '  |> limit(n: 1)',
    '  |> group()',
    `  |> keep(columns: [${['_time', ...columns].map(fluxString).join(', ')}])`,
    `  |> limit(n: ${ROWS})`,
  );
  return lines.join('\n');
}

// ---------- SQL (3.x /api/v3/query_sql) ----------

/** Column names of the SQL answer (aliases Steward chose, never a name from the check). */
export const SQL_SERIES = 'steward_series';
export const sqlNewest = (i: number): string => `steward_newest_${i}`;

/** `max(time)` per value of the grouping tag – per field, the newest time the field has a value. */
export function sqlQuery(spec: InfluxReadSpec): string {
  const newest = spec.fields.length
    ? spec.fields.map((f, i) => `max(CASE WHEN ${sqlIdent(f)} IS NOT NULL THEN time END) AS ${sqlIdent(sqlNewest(i))}`)
    : [`max(time) AS ${sqlIdent(sqlNewest(0))}`];
  const select = [...(spec.groupBy ? [`${sqlIdent(spec.groupBy)} AS ${sqlIdent(SQL_SERIES)}`] : []), ...newest].join(', ');
  const where = [
    `time >= now() - INTERVAL '${seconds(spec.lookbackSeconds)} seconds'`,
    ...Object.entries(spec.tags).map(([k, v]) => `${sqlIdent(k)} = ${sqlString(v)}`),
  ].join(' AND ');
  const group = spec.groupBy ? ` GROUP BY ${sqlIdent(spec.groupBy)} ORDER BY ${sqlIdent(spec.groupBy)} LIMIT ${ROWS}` : '';
  return `SELECT ${select} FROM ${sqlIdent(spec.measurement)} WHERE ${where}${group}`;
}

// ---------- timestamps ----------

const ISO_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * A timestamp of an answer in ms: RFC 3339 with up to nanoseconds (a time without a zone is UTC – InfluxDB 3's JSON
 * writes them so), or a Unix epoch number – nanoseconds, microseconds, milliseconds or seconds by its size. null: none.
 */
export function parseInfluxTime(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? epochMillis(v) : null;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (/^-?\d{1,20}$/.test(t)) return epochMillis(Number(t));
  const m = ISO_RE.exec(t);
  if (!m) return null;
  const frac = (m[3] ?? '').slice(0, 3).padEnd(3, '0');
  const zone = !m[4] || m[4].toUpperCase() === 'Z' ? 'Z' : m[4].includes(':') ? m[4] : `${m[4].slice(0, 3)}:${m[4].slice(3)}`;
  const ms = Date.parse(`${m[1]}T${m[2]}.${frac}${zone}`);
  return Number.isNaN(ms) ? null : ms;
}

function epochMillis(n: number): number | null {
  const a = Math.abs(n);
  if (a >= 1e17) return Math.floor(n / 1e6);
  if (a >= 1e14) return Math.floor(n / 1e3);
  if (a >= 1e11) return Math.floor(n);
  return Math.floor(n * 1000);
}

// ---------- answers ----------

/** Collects the newest timestamp per series name. */
class Collector {
  readonly newest = new Map<string, number | null>();
  constructor(readonly grouped: boolean) {}
  add(group: unknown, field: string | undefined, time: unknown): void {
    const name = influxSeriesName(group === null || group === undefined ? null : String(group), field, this.grouped);
    const t = parseInfluxTime(time);
    const prev = this.newest.get(name);
    if (prev === undefined || (t !== null && (prev === null || t > prev))) this.newest.set(name, t ?? prev ?? null);
  }
  list(): InfluxSeries[] {
    return [...this.newest].map(([name, newest]) => ({ name, newest }));
  }
}

type V1Series = { name?: string; tags?: Record<string, string>; columns?: string[]; values?: unknown[][] };
type V1Result = { statement_id?: number; series?: V1Series[]; error?: string };

const isRecord = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** An error InfluxDB put into a 200 answer (a statement's error), or null. */
export function influxQlError(body: unknown): string | null {
  if (!isRecord(body)) return null;
  if (typeof body.error === 'string') return body.error;
  const results = Array.isArray(body.results) ? (body.results as V1Result[]) : [];
  const failed = results.find((r) => isRecord(r) && typeof r.error === 'string');
  return failed ? String(failed.error) : null;
}

/**
 * The answer of InfluxQL statements: the 1.x JSON (`results[i].series[]` with `tags`, `columns`, `values`) – result i
 * belongs to statement i, so to field i – or rows as InfluxDB 3 writes them (objects, the tag as a column).
 */
export function parseInfluxQl(body: unknown, spec: Pick<InfluxReadSpec, 'fields' | 'groupBy'>, statement = 0): InfluxSeries[] {
  const err = influxQlError(body);
  if (err) throw new InfluxQueryError(err.slice(0, 300));
  const out = new Collector(!!spec.groupBy);
  const fieldOf = (i: number) => spec.fields[i];
  const rows = rowsOf(body);
  if (rows) {
    for (const r of rows) out.add(spec.groupBy ? r[spec.groupBy] : null, fieldOf(statement), r.time);
    return out.list();
  }
  if (!isRecord(body) || !Array.isArray(body.results)) throw new InfluxQueryError('The answer is not an InfluxQL result (no "results")');
  (body.results as V1Result[]).forEach((res, i) => {
    const field = fieldOf(typeof res?.statement_id === 'number' ? res.statement_id : i) ?? fieldOf(statement);
    for (const s of Array.isArray(res?.series) ? res.series : []) {
      const cols = Array.isArray(s.columns) ? s.columns : [];
      const ti = cols.indexOf('time');
      if (ti < 0) throw new InfluxQueryError('The answer has no time column');
      // a tag InfluxDB grouped by is in `tags`; without GROUP BY it may be a column
      const gi = spec.groupBy ? cols.indexOf(spec.groupBy) : -1;
      for (const row of Array.isArray(s.values) ? s.values : []) {
        if (!Array.isArray(row)) continue;
        out.add(spec.groupBy ? (s.tags?.[spec.groupBy] ?? (gi >= 0 ? row[gi] : null)) : null, field, row[ti]);
      }
    }
  });
  return out.list();
}

/**
 * Rows of a JSON answer of InfluxDB 3 (`format=json`: a list of objects; `jsonl`: one object per line; or a
 * `results[].series[]` envelope with columns and values) – null when the body is none of these.
 */
export function rowsOf(body: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(body)) return body.filter(isRecord);
  if (typeof body === 'string') {
    const lines = body.split('\n').filter((l) => l.trim());
    if (!lines.length) return [];
    try {
      const parsed = lines.map((l) => JSON.parse(l) as unknown);
      if (parsed.length === 1 && Array.isArray(parsed[0])) return (parsed[0] as unknown[]).filter(isRecord);
      return parsed.every(isRecord) ? (parsed as Record<string, unknown>[]) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** The answer of the SQL query (InfluxDB 3): rows with steward_series and steward_newest_<i>. */
export function parseSql(body: unknown, spec: Pick<InfluxReadSpec, 'fields' | 'groupBy'>): InfluxSeries[] {
  if (isRecord(body) && typeof body.error === 'string') throw new InfluxQueryError(body.error.slice(0, 300));
  let rows = rowsOf(body);
  if (!rows && isRecord(body) && Array.isArray(body.results)) {
    // the envelope of InfluxDB 3's API description: results[].series[] with columns and values
    rows = [];
    for (const res of body.results as V1Result[])
      for (const s of Array.isArray(res?.series) ? res.series : [])
        for (const v of Array.isArray(s.values) ? s.values : []) rows.push(Object.fromEntries((s.columns ?? []).map((c, i) => [c, v[i]])));
  }
  if (!rows) throw new InfluxQueryError('The answer is not a list of rows (format json)');
  const out = new Collector(!!spec.groupBy);
  const fields = spec.fields.length ? spec.fields : [undefined];
  for (const r of rows) fields.forEach((f, i) => out.add(spec.groupBy ? r[SQL_SERIES] : null, f, r[sqlNewest(i)]));
  return out.list();
}

// ---------- Flux annotated CSV ----------

export interface CsvTable {
  columns: string[];
  rows: string[][];
}

/** Records of RFC 4180 CSV (quotes, doubled quotes, line breaks inside quotes); an empty line is an empty record. */
function csvRecords(text: string, maxRecords: number): string[][] {
  const out: string[][] = [];
  let rec: string[] = [];
  let cell = '';
  let quoted = false;
  let wasQuoted = false;
  let i = 0;
  const endCell = () => {
    rec.push(cell);
    cell = '';
    wasQuoted = false;
  };
  const endRecord = () => {
    endCell();
    out.push(rec.length === 1 && rec[0] === '' ? [] : rec);
    rec = [];
    if (out.length > maxRecords) throw new InfluxQueryError(`The answer has more than ${maxRecords} lines`);
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else cell += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      if (cell !== '' || wasQuoted) throw new InfluxQueryError('Invalid CSV: a quote inside an unquoted value');
      quoted = true;
      wasQuoted = true;
    } else if (ch === ',') endCell();
    else if (ch === '\r' && text[i + 1] === '\n') {
      endRecord();
      i++;
    } else if (ch === '\n') endRecord();
    else if (wasQuoted) throw new InfluxQueryError('Invalid CSV: text after a closing quote');
    else cell += ch;
    i++;
  }
  if (quoted) throw new InfluxQueryError('Invalid CSV: a quoted value is not closed');
  if (cell !== '' || rec.length) endRecord();
  return out;
}

/**
 * Flux's annotated CSV (docs: "Annotated CSV"): tables separated by an empty line, each with annotation rows (#group,
 * #datatype, #default – the first column holds the annotation's name), one header row and its records. An error
 * table (columns error and reference) throws its message – InfluxDB sends one after partial results with HTTP 200.
 */
export function parseAnnotatedCsv(text: string, maxRecords = 20000): CsvTable[] {
  if (typeof text !== 'string') throw new InfluxQueryError('The answer is not CSV');
  const tables: CsvTable[] = [];
  let current: CsvTable | null = null;
  for (const rec of csvRecords(text, maxRecords)) {
    if (!rec.length) {
      current = null; // a table boundary
      continue;
    }
    if (rec[0]!.startsWith('#')) {
      if (current?.rows.length) current = null; // annotations start a new table
      continue;
    }
    if (!current) {
      current = { columns: rec, rows: [] };
      tables.push(current);
      continue;
    }
    if (rec.length !== current.columns.length)
      throw new InfluxQueryError(`Invalid CSV: a record has ${rec.length} values for ${current.columns.length} columns`);
    current.rows.push(rec);
  }
  for (const t of tables) {
    const ei = t.columns.indexOf('error');
    if (ei >= 0 && t.columns.includes('reference')) throw new InfluxQueryError(`InfluxDB: ${(t.rows[0]?.[ei] ?? 'error').slice(0, 300)}`);
  }
  return tables;
}

/** The Flux answer: `_time` per value of the grouping tag (and `_field`). */
export function parseFlux(text: string, spec: Pick<InfluxReadSpec, 'fields' | 'groupBy'>): InfluxSeries[] {
  const out = new Collector(!!spec.groupBy);
  for (const t of parseAnnotatedCsv(text)) {
    const ti = t.columns.indexOf('_time');
    if (ti < 0) {
      if (t.rows.length) throw new InfluxQueryError('The answer has no _time column');
      continue;
    }
    const gi = spec.groupBy ? t.columns.indexOf(spec.groupBy) : -1;
    const fi = spec.fields.length ? t.columns.indexOf('_field') : -1;
    for (const r of t.rows) out.add(gi >= 0 ? r[gi] || null : null, fi >= 0 ? r[fi] : undefined, r[ti]);
  }
  return out.list();
}

/**
 * The series of a read, capped: sorted by name, at most INFLUX_LIMITS.series (`total` says how many there were), with
 * the expected group values that are missing added as series without data.
 */
export function capSeries(
  series: InfluxSeries[],
  spec: Pick<InfluxReadSpec, 'fields' | 'groupBy'>,
  expected: readonly string[] = [],
): { series: InfluxSeries[]; total: number; truncated: boolean } {
  const byName = new Map(series.map((s) => [s.name, s]));
  for (const g of expected)
    for (const f of spec.fields.length ? spec.fields : [undefined]) {
      const name = influxSeriesName(g, f, !!spec.groupBy);
      if (!byName.has(name)) byName.set(name, { name, newest: null });
    }
  const all = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { series: all.slice(0, INFLUX_LIMITS.series), total: all.length, truncated: all.length > INFLUX_LIMITS.series };
}
