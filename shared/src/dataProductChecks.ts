import { z } from 'zod';
import {
  DATA_CHECK_PURPOSES,
  DATA_HEALTH_ORDER,
  DATA_PRODUCT_LIMITS,
  type DataHealthStatus,
  type DataCheckLinkOrigin,
  type DataCheckPurpose,
  type DataElementKind,
  type DataMemberRole,
  type ElementHealth,
} from './dataProducts.js';
import type { MonitorStatus } from './monitors.js';

/**
 * Checks and health of the data products module (ADR 0036 part 10, WP3): the monitor check type `data-element`, the
 * checks linked to an element, and the draft monitor a product gets from _Create monitor_ / _Update monitor_. The
 * health types themselves (`ElementHealth`, `ProductHealth`) are in dataProducts.ts.
 */

export const DATA_ELEMENT_CHECK_MODES = ['freshness', 'schema', 'volume', 'quality'] as const;
export type DataElementCheckMode = (typeof DATA_ELEMENT_CHECK_MODES)[number];

/** Element kinds whose freshness the `data-element` check reads (metadata only; decision 13). */
const FRESHNESS_KINDS: readonly DataElementKind[] = [
  'snowflake.table',
  'snowflake.view',
  'snowflake.dynamicTable',
  'snowflake.task',
  'snowflake.schema',
  'snowflake.database',
  'kafka.topic',
  'kafka.topicBundle',
];

/** Element kinds whose columns or fields the `data-element` check compares with a contract. */
const SCHEMA_KINDS: readonly DataElementKind[] = ['snowflake.table', 'snowflake.view', 'snowflake.dynamicTable', 'kafka.topic', 'sql.table', 'sql.view'];

/**
 * Element kinds whose volume the `data-element` check reads (phase 2): Snowflake `ROW_COUNT` and `BYTES` from the same
 * metadata as freshness, a Kafka topic's end offsets (messages added per window).
 */
const VOLUME_KINDS: readonly DataElementKind[] = ['snowflake.table', 'snowflake.dynamicTable', 'kafka.topic'];

/**
 * Element kinds whose quality the `data-element` check judges (phase 2): Snowflake Data Metric Function results, and
 * the quality results Steward has recorded for the element (dbt tests, contract tests, DMF results).
 */
const QUALITY_KINDS: readonly DataElementKind[] = ['snowflake.table', 'snowflake.view', 'snowflake.dynamicTable', 'kafka.topic', 'sql.table', 'sql.view'];

const KINDS_OF: Record<DataElementCheckMode, readonly DataElementKind[]> = {
  freshness: FRESHNESS_KINDS,
  schema: SCHEMA_KINDS,
  volume: VOLUME_KINDS,
  quality: QUALITY_KINDS,
};

/** The modes of the `data-element` check an element of this kind supports (none: link a check of your own instead). */
export function elementCheckModes(kind: DataElementKind): DataElementCheckMode[] {
  return DATA_ELEMENT_CHECK_MODES.filter((m) => KINDS_OF[m].includes(kind));
}

// ---------- checks linked to an element ----------

/** A check linked to an element (or found by its fields), as the element's page shows it. */
export interface DataElementCheck {
  /** null: found by its fields (it names the element, or its platform and object) and not linked yet – Link stores it */
  linkId: string | null;
  purpose: DataCheckPurpose;
  origin: DataCheckLinkOrigin;
  /** The check's stored status (never read from the platform on a page load) */
  status: MonitorStatus;
  since: string | null;
  /** The check runs: its monitor is enabled and so is the check – only such checks count for health */
  active: boolean;
  /** A check of a monitor the reader may not see: its status only, no monitor, check or message */
  hidden: boolean;
  monitor: { id: string; key: string; name: string; enabled: boolean } | null;
  check: { id: string; name: string; type: string } | null;
  /** The last result's message (visible checks only) */
  message: string | null;
  createdAt: string;
  createdBy: string;
}

export interface DataElementChecks {
  elementId: string;
  health: ElementHealth;
  checks: DataElementCheck[];
}

export const dataCheckLinkAddInput = z
  .object({
    /** The monitor (its id or key) and the check id in it */
    monitor: z.string().trim().min(1).max(100),
    checkId: z.string().trim().min(1).max(100),
    purpose: z.enum(DATA_CHECK_PURPOSES).default('other'),
  })
  .strict();
export type DataCheckLinkAddInput = z.input<typeof dataCheckLinkAddInput>;

// ---------- Create monitor / Update monitor ----------

/** A check the draft monitor gets: a data-element check (freshness or schema) or a data-contract check (findings). */
export interface DataMonitorDraftCheck {
  /** The check id in the monitor */
  id: string;
  name: string;
  type: 'data-element' | 'data-contract';
  mode: DataElementCheckMode | 'findings';
  /** The element it watches (null for a contract's check) */
  elementId: string | null;
  elementName: string | null;
  role: DataMemberRole | null;
  /** Output-port checks are critical; the others only degrade the monitor */
  critical: boolean;
  maxAgeMinutes: number | null;
  contractId: string | null;
}

/** Why an element got no check in the draft. */
export const DATA_MONITOR_SKIP_REASONS = ['watched', 'unsupported', 'hidden', 'limit', 'noContractModule'] as const;
export type DataMonitorSkipReason = (typeof DATA_MONITOR_SKIP_REASONS)[number];

export interface DataMonitorProposal {
  productId: string;
  environment: string;
  /** The product's monitor in this environment (null: none yet – Create monitor); hidden: one the reader may not see */
  monitor: { id: string; key: string; name: string; enabled: boolean } | null;
  monitorHidden: boolean;
  /** The checks Create monitor makes, or the ones Update monitor adds */
  checks: DataMonitorDraftCheck[];
  /** Soft links along the steps (check ids – new ones and the monitor's existing ones): upstream → downstream */
  links: { from: string; to: string }[];
  /** Elements left out, by reason (at most 20 named per reason; the rest counted) */
  skipped: { reason: DataMonitorSkipReason; count: number; elements: { id: string; name: string }[] }[];
  /** The reader may apply it: edit on the product, the right to create (or edit) the monitor */
  canApply: boolean;
}

export interface DataMonitorResult {
  monitor: { id: string; key: string; name: string; enabled: boolean };
  created: boolean;
  /** Checks added (all of them when created) and check links stored */
  added: number;
  linked: number;
  proposal: DataMonitorProposal;
}

export const dataMonitorInput = z
  .object({
    /** The environment (default: production, or the product's first) */
    environment: z.string().trim().min(1).max(DATA_PRODUCT_LIMITS.short).optional(),
    /** The name of a new monitor (default: "<product> (<environment>)") */
    name: z.string().trim().min(1).max(160).optional(),
  })
  .strict();
export type DataMonitorInput = z.input<typeof dataMonitorInput>;

// ---------- health of several products ----------

export const dataHealthQuery = z
  .object({
    /** Product ids, comma-separated (at most a page) */
    ids: z
      .string()
      .max(DATA_PRODUCT_LIMITS.page * 40)
      .default('')
      .transform((s) =>
        [
          ...new Set(
            s
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean),
          ),
        ].slice(0, DATA_PRODUCT_LIMITS.page),
      ),
    environment: z.string().trim().min(1).max(DATA_PRODUCT_LIMITS.short).optional(),
  })
  .strict();

/** Health statuses best first, for sorting and filtering: the module's one order (DATA_HEALTH_ORDER) reversed. */
export const HEALTH_STATUSES: readonly DataHealthStatus[] = [...DATA_HEALTH_ORDER].reverse();
