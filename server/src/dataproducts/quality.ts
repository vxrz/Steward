import {
  DATA_QUALITY_DIMENSIONS,
  DATA_QUALITY_LIMITS as Q,
  dataQualityResultInput,
  qualityDimensionOf,
  type DataElementQuality,
  type DataQualityDimension,
  type DataQualityDimensionSummary,
  type DataQualityResult,
  type DataQualityResultInput,
  type DataQualitySource,
  type DataQualityStatus,
} from '@sm/shared';
import { db } from '../db.js';
import { me } from '../auth/access.js';
import { newId, nowIso } from '../util.js';
import { actorName, elementNotFound } from './common.js';
import { elementAccess } from './access.js';
import { chunks, elementRow, elementTeamIds, marks } from './store.js';

/**
 * Quality results of elements (0.24.0, ADR 0036 part 10 phase 2, docs/DATA-PRODUCTS.md#quality-results) – the one
 * place they are stored (`dp_quality_results`) and the one function that writes them, **recordQualityResults**:
 *
 *  - dbt tests from `run_results.json` (the dbt import of package A calls it with source `dbt`),
 *  - Snowflake Data Metric Function results and the volume readings of the `data-element` check (source `check`,
 *    checks/quality.ts and checks/volume.ts),
 *  - contract tests through the datacontract CLI, for the elements of the output ports bound to the contract (source
 *    `contract`, contract-hooks.ts).
 *
 * Each result is mapped to an ISO/IEC 25012 dimension (accuracy, completeness, consistency, currentness – shared
 * qualityDimensionOf) and read in bulk by the scorecard (its quality dimensions and the completeness objective of
 * ports) and the report section. At most one row per element, source, name and hour is kept (the newest of the hour
 * wins), for 400 days – a check that runs every minute writes one row an hour. No rights are checked here: callers
 * decide (an element must exist; unknown ids are skipped and counted).
 */

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const hourOf = (iso: string): string => new Date(Math.floor(Date.parse(iso) / HOUR) * HOUR).toISOString();

interface QualityRow {
  id: string;
  element_id: string;
  source: DataQualitySource;
  name: string;
  dimension: DataQualityDimension | null;
  status: DataQualityStatus;
  value: number | string | null;
  message: string;
  run_ref: string | null;
  bucket: string;
  observed_at: string;
  recorded_at: string;
  recorded_by: string;
}

const toResult = (r: QualityRow): DataQualityResult => ({
  id: r.id,
  elementId: r.element_id,
  source: r.source,
  name: r.name,
  dimension: r.dimension,
  status: r.status,
  value: r.value === null || r.value === undefined ? null : Number(r.value),
  message: r.message,
  runRef: r.run_ref,
  observedAt: r.observed_at,
});

let lastPrune = 0;

/** Removes results older than the retention (at most once an hour; the scorecard job calls it daily as well). */
export function pruneQualityResults(now = Date.now(), force = false): number {
  if (!force && now - lastPrune < HOUR) return 0;
  lastPrune = now;
  return db().run('DELETE FROM dp_quality_results WHERE observed_at < ?', new Date(now - Q.keepDays * DAY).toISOString()).changes;
}

/**
 * **The write function for quality results** (package A's dbt `run_results.json` import calls it; so do the checks and
 * the contract hooks): validates each result (shared `dataQualityResultInput`), maps its dimension, and stores it –
 * one row per element, source, name and hour (a later result of the same hour replaces the earlier one). Elements that
 * do not exist are skipped and counted; nothing is checked against rights (the caller's job). One transaction per
 * call, at most DATA_QUALITY_LIMITS.batch results; statements: one read of the elements per 500 ids, one write per
 * result.
 */
export function recordQualityResults(input: readonly DataQualityResultInput[]): { recorded: number; skipped: number } {
  if (input.length > Q.batch) throw new Error(`At most ${Q.batch} quality results per call`);
  const rows = input.map((x) => dataQualityResultInput.parse(x));
  if (!rows.length) return { recorded: 0, skipped: 0 };
  const ids = [...new Set(rows.map((r) => r.elementId))];
  const known = new Set(
    chunks(ids).flatMap((part) =>
      db()
        .all<{ id: string }>(`SELECT id FROM dp_elements WHERE id IN (${marks(part.length)})`, ...part)
        .map((r) => r.id),
    ),
  );
  const now = nowIso();
  const by = actorName();
  let recorded = 0;
  db().tx(() => {
    for (const r of rows) {
      if (!known.has(r.elementId)) continue;
      const observed = r.observedAt ? new Date(r.observedAt).toISOString() : now;
      const dimension = qualityDimensionOf(r.dimension, r.name);
      db().run(
        `INSERT INTO dp_quality_results (id, element_id, source, name, dimension, status, value, message, run_ref, bucket, observed_at, recorded_at, recorded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (element_id, source, name, bucket) DO UPDATE SET dimension = excluded.dimension, status = excluded.status, value = excluded.value,
           message = excluded.message, run_ref = excluded.run_ref, observed_at = excluded.observed_at, recorded_at = excluded.recorded_at,
           recorded_by = excluded.recorded_by
         WHERE excluded.observed_at >= dp_quality_results.observed_at`,
        newId('dpy_'),
        r.elementId,
        r.source,
        r.name,
        dimension,
        r.status,
        r.value ?? null,
        (r.message ?? '').replace(/\s+/g, ' ').trim().slice(0, Q.message),
        r.runRef ?? null,
        hourOf(observed),
        observed,
        now,
        by,
      );
      recorded++;
    }
  });
  pruneQualityResults();
  return { recorded, skipped: rows.length - recorded };
}

/** One result (a convenience over recordQualityResults). */
export const recordQualityResult = (r: DataQualityResultInput): boolean => recordQualityResults([r]).recorded === 1;

/**
 * Forgets the dbt results that came through a lineage source (the source is deleted; package A): the results of
 * source `dbt` whose element and test name are among the source's remembered dbt tests (`dp_lineage_tests`) – call it
 * before those are deleted. One statement.
 */
export function forgetQualityResults(lineageSourceId: string): number {
  return db().run(
    `DELETE FROM dp_quality_results WHERE source = 'dbt' AND EXISTS (SELECT 1 FROM dp_lineage_tests t
       WHERE t.source_id = ? AND t.element_id = dp_quality_results.element_id AND t.name = dp_quality_results.name)`,
    lineageSourceId,
  ).changes;
}

// ---------- reads (bulk) ----------

/**
 * The latest result of each test (element, source, name) of these elements since `since` – one statement per 500
 * elements, whatever the number of results.
 */
export function latestQualityResults(elementIds: readonly string[], since: string): DataQualityResult[] {
  return chunks([...new Set(elementIds)]).flatMap((part) =>
    db()
      .all<QualityRow>(
        `SELECT q.* FROM dp_quality_results q WHERE q.element_id IN (${marks(part.length)}) AND q.observed_at >= ?
           AND q.observed_at = (SELECT MAX(x.observed_at) FROM dp_quality_results x WHERE x.element_id = q.element_id AND x.source = q.source AND x.name = q.name)`,
        ...part,
        since,
      )
      .map(toResult),
  );
}

/** Per element, the completeness results since `since` by status (the completeness objective: one statement per 500 elements). */
export function completenessCounts(elementIds: readonly string[], since: string): Map<string, { passed: number; total: number }> {
  const out = new Map<string, { passed: number; total: number }>();
  for (const part of chunks([...new Set(elementIds)]))
    for (const r of db().all<{ element_id: string; status: string; n: number | string }>(
      `SELECT element_id, status, COUNT(*) AS n FROM dp_quality_results WHERE element_id IN (${marks(part.length)}) AND observed_at >= ?
         AND dimension = 'completeness' GROUP BY element_id, status`,
      ...part,
      since,
    )) {
      const x = out.get(r.element_id) ?? { passed: 0, total: 0 };
      x.total += Number(r.n);
      if (r.status === 'passed') x.passed += Number(r.n);
      out.set(r.element_id, x);
    }
  return out;
}

/** The latest results summarised per ISO dimension (only the dimensions results map to). */
export function summariseQuality(results: readonly DataQualityResult[]): DataQualityDimensionSummary[] {
  return DATA_QUALITY_DIMENSIONS.map((dimension) => {
    const xs = results.filter((r) => r.dimension === dimension);
    return {
      dimension,
      tests: xs.length,
      passed: xs.filter((r) => r.status === 'passed').length,
      warning: xs.filter((r) => r.status === 'warning').length,
      failed: xs.filter((r) => r.status === 'failed' || r.status === 'error').length,
      latest: xs.reduce<string | null>((m, r) => (!m || r.observedAt > m ? r.observedAt : m), null),
    };
  });
}

/** GET /api/data-elements/:id/quality: the element's quality results of the last 30 days (who may see the element). */
export function elementQuality(elementId: string, now = Date.now()): DataElementQuality {
  const el = elementRow(elementId);
  if (!el || !elementAccess(me(), elementTeamIds([el.id]).get(el.id) ?? []).permissions.includes('view')) throw elementNotFound(elementId);
  const since = new Date(now - 30 * DAY).toISOString();
  const latest = latestQualityResults([el.id], since);
  const results = db()
    .all<QualityRow>('SELECT * FROM dp_quality_results WHERE element_id = ? AND observed_at >= ? ORDER BY observed_at DESC, id LIMIT ?', el.id, since, Q.listed)
    .map(toResult);
  return { elementId: el.id, summary: summariseQuality(latest), results };
}
