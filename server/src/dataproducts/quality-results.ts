import { DATA_QUALITY_RESULT_STATUSES, ISO_25012_DIMENSIONS, type DataQualityResult, type DataQualityResultStatus, type Iso25012Dimension } from '@sm/shared';
import { db } from '../db.js';
import { nowIso } from '../util.js';
import { chunks, marks } from './store.js';

/**
 * Quality results per element (ADR 0036 parts 10 and 13, phase 2): the newest result of each test or rule that checks an
 * element, by origin (`dbt` from run_results.json, and whatever else reports one – Snowflake Data Metric Functions,
 * contract tests) and key (the test's unique id). Only the outcome is kept – status, failing row count, the ISO/IEC
 * 25012 dimension – never a message, a query or a value (decision 13).
 *
 * `recordQualityResult` is the one seam through which results are written, shared by the lineage sources (dbt tests,
 * package A) and the quality checks and scorecard mapping (package B): one place decides what is kept. Reads are bulk
 * (`qualityResultsOf`: one statement per chunk of 500 elements).
 */

export interface QualityResultInput {
  elementId: string;
  /** Where it comes from: `dbt`, `dmf`, `contract` … (≤ 40 characters) */
  origin: string;
  /** Unique within the origin and element: the test's unique id, the metric's name (≤ 1,000 characters) */
  key: string;
  /** In words, for people (≤ 200 characters) */
  name: string;
  status: DataQualityResultStatus;
  dimension?: Iso25012Dimension | null;
  /** Failing rows or violations (a count, never the rows) */
  failures?: number | null;
  observedAt?: string;
  /** The lineage source (or discovery source) it came through: deleted with it */
  sourceId?: string | null;
}

const isStatus = (s: string): s is DataQualityResultStatus => (DATA_QUALITY_RESULT_STATUSES as readonly string[]).includes(s);
const isDimension = (d: unknown): d is Iso25012Dimension => typeof d === 'string' && (ISO_25012_DIMENSIONS as readonly string[]).includes(d);

/**
 * Records the newest result of a test on an element (replaces the earlier one of the same origin and key; an older
 * observation than the stored one is ignored). Call it inside the caller's transaction when writing many.
 */
export function recordQualityResult(r: QualityResultInput): void {
  if (!isStatus(r.status)) throw new Error(`Unknown quality result status ${r.status}`);
  const at = r.observedAt ?? nowIso();
  const failures = r.failures === null || r.failures === undefined || !Number.isFinite(r.failures) ? null : Math.max(0, Math.round(r.failures));
  const args = [
    r.elementId,
    r.origin.slice(0, 40),
    r.key.slice(0, 1_000),
    r.name.slice(0, 200),
    r.status,
    isDimension(r.dimension) ? r.dimension : null,
    failures,
    at,
    r.sourceId ?? null,
  ];
  db().run(
    `INSERT INTO dp_quality_results (element_id, origin, result_key, name, status, dimension, failures, observed_at, source_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (element_id, origin, result_key) DO UPDATE SET name = excluded.name, status = excluded.status, dimension = excluded.dimension,
       failures = excluded.failures, observed_at = excluded.observed_at, source_id = excluded.source_id
     WHERE excluded.observed_at >= dp_quality_results.observed_at`,
    ...args,
  );
}

interface Row {
  element_id: string;
  origin: string;
  result_key: string;
  name: string;
  status: DataQualityResultStatus;
  dimension: Iso25012Dimension | null;
  failures: number | null;
  observed_at: string;
  source_id: string | null;
}

/** The newest results of these elements, by element (bulk: one statement per chunk of 500). */
export function qualityResultsOf(elementIds: readonly string[]): Map<string, DataQualityResult[]> {
  const out = new Map<string, DataQualityResult[]>();
  for (const part of chunks([...new Set(elementIds)]))
    for (const r of db().all<Row>(
      `SELECT * FROM dp_quality_results WHERE element_id IN (${marks(part.length)}) ORDER BY element_id, origin, result_key`,
      ...part,
    ))
      out.set(r.element_id, [
        ...(out.get(r.element_id) ?? []),
        {
          elementId: r.element_id,
          origin: r.origin,
          key: r.result_key,
          name: r.name,
          status: r.status,
          dimension: r.dimension,
          failures: r.failures === null ? null : Number(r.failures),
          observedAt: r.observed_at,
          sourceId: r.source_id,
        },
      ]);
  return out;
}

/** Forgets the results that came through a source (the source is deleted). */
export function forgetQualityResults(sourceId: string): number {
  return db().run('DELETE FROM dp_quality_results WHERE source_id = ?', sourceId).changes;
}
