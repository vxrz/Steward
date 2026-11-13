import type { CheckOf } from '@sm/shared';
import { ISO, type SnowflakeClient } from '../../snowflake/client.js';
import { latestQualityResults, recordQualityResults } from '../quality.js';
import type { ElementRow } from '../store.js';
import { snowflakeParts, type CheckResult } from './freshness.js';

/**
 * Quality of an element (0.24.0, ADR 0036 part 10 phase 2):
 *
 *  - **dmf** – the newest result of each Snowflake Data Metric Function on the table within `withinHours`, read from
 *    `SNOWFLAKE.LOCAL.DATA_QUALITY_MONITORING_RESULTS` (read-only: a view of measured metrics, never the table's rows;
 *    the role needs the application role `SNOWFLAKE.DATA_QUALITY_MONITORING_VIEWER`), judged by the check's `metrics`
 *    limits – without any, the null, blank and duplicate counts and percentages must be 0. Each judged metric becomes a
 *    quality result (source `dmf`) with its ISO/IEC 25012 dimension.
 *  - **results** – the quality results Steward recorded for the element within `withinHours` (dbt tests, contract
 *    tests, DMF results; not the volume checks): a failed test is `failAs`, a warning `warningAs`.
 */

type Check = CheckOf<'data-element'>;

const DEFAULT_ZERO = new Set(['NULL_COUNT', 'NULL_PERCENT', 'BLANK_COUNT', 'BLANK_PERCENT', 'DUPLICATE_COUNT']);
const MAX_METRICS = 500;

export interface DmfRow {
  metric: string;
  column: string;
  value: number | null;
  measured: string;
}

/** The verdict on DMF results (pure; exported for the tests): judged metrics with their limits. */
export function judgeDmf(
  c: Pick<Check, 'metrics' | 'failAs'>,
  what: string,
  rows: readonly DmfRow[],
): CheckResult & { judged: { row: DmfRow; ok: boolean; limit: string }[] } {
  const judged: { row: DmfRow; ok: boolean; limit: string }[] = [];
  for (const r of rows) {
    const short = r.metric.split('.').pop()!.toUpperCase();
    const rules = c.metrics?.length
      ? c.metrics.filter(
          (m) =>
            (m.metric.toUpperCase() === short || m.metric.toUpperCase() === r.metric.toUpperCase()) &&
            (!m.column || m.column.toUpperCase() === r.column.toUpperCase()),
        )
      : DEFAULT_ZERO.has(short)
        ? [{ metric: short, max: 0, min: undefined }]
        : [];
    for (const rule of rules) {
      const ok = r.value !== null && (rule.min === undefined || r.value >= rule.min) && (rule.max === undefined || r.value <= rule.max);
      const limit = [rule.min !== undefined ? `≥ ${rule.min}` : '', rule.max !== undefined ? `≤ ${rule.max}` : ''].filter(Boolean).join(' and ');
      judged.push({ row: r, ok, limit });
    }
  }
  const value = { metrics: rows.length, judged: judged.length, failed: judged.filter((j) => !j.ok).length };
  if (!rows.length) return { status: 'unknown', message: `${what}: no Data Metric Function results in the window`, value, judged };
  if (!judged.length) return { status: 'unknown', message: `${what}: ${rows.length} metric results, none with a limit – set the metrics to judge`, value, judged };
  const bad = judged.filter((j) => !j.ok);
  if (bad.length)
    return {
      status: c.failAs,
      message: `${what}: ${bad.length} of ${judged.length} metrics outside their limits – ${bad
        .slice(0, 5)
        .map((j) => `${j.row.metric.split('.').pop()}${j.row.column ? `(${j.row.column})` : ''} = ${j.row.value ?? 'no value'} (${j.limit})`)
        .join('; ')}${bad.length > 5 ? ` and ${bad.length - 5} more` : ''}`,
      value,
      judged,
    };
  return { status: 'up', message: `${what}: all ${judged.length} metrics within their limits`, value, judged };
}

/** DMF results of a Snowflake table (one statement on the results view, by bindings). */
export async function snowflakeDmf(c: Check, el: ElementRow, sf: SnowflakeClient): Promise<CheckResult> {
  const parts = snowflakeParts(el.qualified_name);
  if (!parts || parts.length !== 3) return { status: 'unknown', message: `"${el.qualified_name}" is not DATABASE.SCHEMA.TABLE` };
  const [d, s, t] = parts as [string, string, string];
  const hours = c.withinHours ?? 48;
  const rows = await sf.query(
    `/* steward:dp-dmf-results */ SELECT METRIC_DATABASE || '.' || METRIC_SCHEMA || '.' || METRIC_NAME AS METRIC, ARRAY_TO_STRING(ARGUMENT_NAMES, ',') AS ARGS,
     VALUE, TO_VARCHAR(MEASUREMENT_TIME, ${ISO}) AS MEASURED FROM SNOWFLAKE.LOCAL.DATA_QUALITY_MONITORING_RESULTS
     WHERE TABLE_DATABASE = ? AND TABLE_SCHEMA = ? AND TABLE_NAME = ? AND MEASUREMENT_TIME >= DATEADD(hour, ?, CURRENT_TIMESTAMP())
     QUALIFY ROW_NUMBER() OVER (PARTITION BY METRIC_DATABASE, METRIC_SCHEMA, METRIC_NAME, ARRAY_TO_STRING(ARGUMENT_NAMES, ',') ORDER BY MEASUREMENT_TIME DESC) = 1
     ORDER BY METRIC, ARGS LIMIT ${MAX_METRICS}`,
    [d, s, t, -hours],
  );
  const dmf: DmfRow[] = rows.map((r) => ({
    metric: String(r.METRIC ?? ''),
    column: String(r.ARGS ?? ''),
    value: r.VALUE === null || r.VALUE === undefined || !Number.isFinite(Number(r.VALUE)) ? null : Number(r.VALUE),
    measured: String(r.MEASURED ?? new Date().toISOString()),
  }));
  const r = judgeDmf(c, `Snowflake: data metric functions of ${parts.join('.')}`, dmf);
  if (r.judged.length)
    recordQualityResults(
      r.judged.map((j) => ({
        elementId: el.id,
        source: 'dmf' as const,
        name: `${j.row.metric}${j.row.column ? `(${j.row.column})` : ''}`.slice(0, 255),
        status: j.ok ? ('passed' as const) : ('failed' as const),
        value: j.row.value,
        message: j.limit ? `limit ${j.limit}` : '',
        observedAt: Date.parse(j.row.measured) ? new Date(j.row.measured).toISOString() : undefined,
      })),
    );
  const { judged: _judged, ...out } = r;
  return out;
}

/** The quality results Steward recorded for the element (dbt, contract tests, DMF) within the window. */
export function storedQuality(c: Check, el: ElementRow, now: number): CheckResult {
  const hours = c.withinHours ?? 48;
  const results = latestQualityResults([el.id], new Date(now - hours * 3600_000).toISOString()).filter((r) => r.source !== 'check');
  const failed = results.filter((r) => r.status === 'failed' || r.status === 'error');
  const warning = results.filter((r) => r.status === 'warning');
  const value = { tests: results.length, failed: failed.length, warning: warning.length };
  const what = `${el.qualified_name}`;
  if (!results.length) return { status: 'unknown', message: `${what}: no quality results in the last ${hours} hours`, value };
  const names = (xs: typeof results) =>
    xs
      .slice(0, 5)
      .map((x) => `${x.name} (${x.source})`)
      .join(', ') + (xs.length > 5 ? ` and ${xs.length - 5} more` : '');
  if (failed.length) return { status: c.failAs, message: `${what}: ${failed.length} of ${results.length} quality tests failed – ${names(failed)}`, value };
  if (warning.length) return { status: c.warningAs, message: `${what}: ${warning.length} of ${results.length} quality tests warn – ${names(warning)}`, value };
  return { status: 'up', message: `${what}: all ${results.length} quality tests passed`, value };
}
