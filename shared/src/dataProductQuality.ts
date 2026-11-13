import { z } from 'zod';
import type { DataMaturityLevel, DataScorecardState, Iso25012Dimension } from './dataProducts.js';

/**
 * Quality, field-level personal data and the scorecard over time of the data products module (0.24.0, ADR 0036 phase
 * 2, docs/DATA-PRODUCTS.md#quality-results): quality results of elements – dbt tests pushed from CI, Snowflake Data
 * Metric Function results, contract tests, the `data-element` check's volume and quality modes – mapped to the ISO/IEC
 * 25012 dimensions accuracy, completeness and consistency; the fields of bound contracts that hold personal data; daily
 * scorecard snapshots and their history.
 */

// ---------- quality results ----------

/** Where a quality result comes from. */
export const DATA_QUALITY_SOURCES = ['dbt', 'dmf', 'contract', 'check', 'other'] as const;
export type DataQualitySource = (typeof DATA_QUALITY_SOURCES)[number];

export const DATA_QUALITY_STATUSES = ['passed', 'warning', 'failed', 'error'] as const;
export type DataQualityStatus = (typeof DATA_QUALITY_STATUSES)[number];

/** The ISO/IEC 25012 dimensions quality results are mapped to (others count as no evidence). */
export const DATA_QUALITY_DIMENSIONS = ['accuracy', 'completeness', 'consistency', 'currentness'] as const satisfies readonly Iso25012Dimension[];
export type DataQualityDimension = (typeof DATA_QUALITY_DIMENSIONS)[number];

export const DATA_QUALITY_LIMITS = {
  /** Results per call of recordQualityResults (a dbt run of a large project is several calls) */
  batch: 5_000,
  name: 255,
  message: 500,
  runRef: 200,
  /** Days a result is kept */
  keepDays: 400,
  /** Results of one element listed on its page */
  listed: 200,
  /** Days of scorecard history kept and shown at most */
  historyDays: 400,
} as const;

/**
 * The ISO/IEC 25012 dimension of a quality result: an ODCS quality rule's `dimension` (accuracy, completeness,
 * conformity, consistency, coverage, timeliness, uniqueness), a dbt test (not_null, unique, accepted_values,
 * relationships, dbt_utils and dbt_expectations names), a Snowflake system DMF (NULL_COUNT, DUPLICATE_COUNT,
 * ACCEPTED_VALUES, ROW_COUNT, FRESHNESS …) or a datacontract CLI check type. Null: no mapping – the result is listed
 * but is evidence of no dimension.
 */
export function qualityDimensionOf(hint: string | null | undefined, name?: string | null): DataQualityDimension | null {
  const norm = (x: string | null | undefined) =>
    (x ?? '')
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_');
  const h = norm(hint);
  const BY_HINT: Record<string, DataQualityDimension> = {
    accuracy: 'accuracy',
    conformity: 'accuracy',
    validity: 'accuracy',
    completeness: 'completeness',
    coverage: 'completeness',
    consistency: 'consistency',
    uniqueness: 'consistency',
    integrity: 'consistency',
    timeliness: 'currentness',
    currentness: 'currentness',
    freshness: 'currentness',
  };
  if (h && Object.hasOwn(BY_HINT, h)) return BY_HINT[h]!;
  const n = norm(name);
  if (!n) return null;
  // the test or metric name, possibly namespaced (dbt_utils.not_null_proportion, SNOWFLAKE.CORE.NULL_COUNT) or prefixed
  // by the model (not_null_orders_id) – the first known word wins
  const words: [string, DataQualityDimension][] = [
    ['not_null', 'completeness'],
    ['null_count', 'completeness'],
    ['null_percent', 'completeness'],
    ['blank_count', 'completeness'],
    ['blank_percent', 'completeness'],
    ['row_count', 'completeness'],
    ['not_empty', 'completeness'],
    ['required', 'completeness'],
    ['unique', 'consistency'],
    ['duplicate', 'consistency'],
    ['relationships', 'consistency'],
    ['referential', 'consistency'],
    ['accepted_values', 'accuracy'],
    ['accepted_range', 'accuracy'],
    ['expect_column_values', 'accuracy'],
    ['regex', 'accuracy'],
    ['pattern', 'accuracy'],
    ['field_type', 'accuracy'],
    ['freshness', 'currentness'],
    ['recency', 'currentness'],
  ];
  for (const [w, d] of words) if (n.includes(w)) return d;
  return null;
}

/** recordQualityResults: one result of an element (the write function the dbt import and the contract hooks call). */
export const dataQualityResultInput = z
  .object({
    elementId: z.string().trim().min(1).max(100),
    source: z.enum(DATA_QUALITY_SOURCES),
    /** The test, rule or metric (`not_null_orders_id`, `SNOWFLAKE.CORE.NULL_COUNT(CUSTOMER_ID)`) */
    name: z.string().trim().min(1).max(DATA_QUALITY_LIMITS.name),
    status: z.enum(DATA_QUALITY_STATUSES),
    /** An ODCS dimension or ISO/IEC 25012 dimension; empty: derived from the name (qualityDimensionOf) */
    dimension: z.string().trim().max(60).nullable().optional(),
    /** A measured value (a failing row count, a metric) – never a data value */
    value: z.number().finite().nullable().optional(),
    message: z.string().max(5_000).nullable().optional(),
    /** The run it belongs to (a dbt invocation id, a contract test run id) */
    runRef: z.string().trim().max(DATA_QUALITY_LIMITS.runRef).nullable().optional(),
    /** When it was measured (ISO 8601; default now) */
    observedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type DataQualityResultInput = z.input<typeof dataQualityResultInput>;

/** A stored quality result. */
export interface DataQualityResult {
  id: string;
  elementId: string;
  source: DataQualitySource;
  name: string;
  dimension: DataQualityDimension | null;
  status: DataQualityStatus;
  value: number | null;
  message: string;
  runRef: string | null;
  observedAt: string;
}

/** Per ISO dimension, the latest result of each test (source and name) of the last 30 days. */
export interface DataQualityDimensionSummary {
  dimension: DataQualityDimension;
  tests: number;
  passed: number;
  warning: number;
  failed: number;
  /** The newest result counted */
  latest: string | null;
}

/** GET /api/data-elements/:id/quality: an element's recent quality results and their summary. */
export interface DataElementQuality {
  elementId: string;
  summary: DataQualityDimensionSummary[];
  /** The newest results (at most DATA_QUALITY_LIMITS.listed) */
  results: DataQualityResult[];
}

// ---------- field-level personal data from contracts ----------

/**
 * A field of a bound contract's schema object that is marked personal (the Steward convention
 * `customProperties: [{ property: personalData, value: true }]`) or classified (the ODCS property's `classification`,
 * other than public).
 */
export interface DataPersonalField {
  /** The schema object (`orders`) and the property's path (`customer.email`) */
  schema: string;
  field: string;
  classification: string | null;
  personal: boolean;
}

/** The personal and classified fields of one contract version, where it is bound. */
export interface DataPersonalFieldGroup {
  contract: { id: string; key: string; name: string } | null;
  /** A contract the reader may not see: counted, never named – its fields are not shown */
  hidden: boolean;
  version: number;
  /** Bound to: the port and the environment (product pages), else empty */
  ports: { productId: string; portId: string; portName: string; environment: string }[];
  fields: DataPersonalField[];
  /** Fields beyond the limit are counted */
  more: number;
}

/** GET …/personal-fields (a product, an element, a data object). */
export interface DataPersonalFields {
  groups: DataPersonalFieldGroup[];
  /** Personal fields in all groups the reader may see */
  personal: number;
  classified: number;
  /** Contracts the reader may not see */
  hiddenContracts: number;
}

// ---------- scorecard history ----------

/** One day of a product's scorecard in one environment (the daily snapshot). */
export interface DataScorecardHistoryPoint {
  day: string;
  maturity: DataMaturityLevel;
  met: number;
  partial: number;
  notMet: number;
  /** The state of each part and dimension that day */
  states: Record<string, DataScorecardState>;
}

/** GET /api/data-products/:id/scorecard/history?environment=&days= */
export interface DataScorecardHistory {
  productId: string;
  environment: string | null;
  days: number;
  points: DataScorecardHistoryPoint[];
}

export const dataScorecardHistoryQuery = z
  .object({
    environment: z.string().trim().min(1).max(60).optional(),
    days: z.coerce.number().int().min(7).max(DATA_QUALITY_LIMITS.historyDays).default(90),
  })
  .strict();
