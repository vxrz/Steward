import { z } from 'zod';
import { DATA_PRODUCT_LIMITS, DATA_STEP_KINDS, type DataElementKind, type DataStepKind, type Iso25012Dimension } from './dataProducts.js';

/**
 * Lineage from tools (0.24.0, ADR 0036 phase 2, part 9 _Steps from tools_, docs/DATA-PRODUCTS.md#lineage-from-tools):
 *
 * - **OpenLineage push** – a lineage source of kind `openlineage` takes run events (spec 2-0-x) from Airflow, dbt, Spark
 *   and the like at POST /api/hooks/data-lineage/<sourceId> with a push token of its own (`sdl_…`, hashed, bound to
 *   the source; API tokens are refused – least privilege). Datasets are matched to elements by their OpenLineage
 *   namespace and name (filled by discovery), jobs become **proposed steps**, and the last run per job is kept (state
 *   and time – freshness evidence); facets are never stored.
 * - **dbt** – a lineage source of kind `dbt` takes `manifest.json` (models, seeds, snapshots and sources with their
 *   relations → elements of its platform, `depends_on` → proposed steps, tests → which element they check) and
 *   `run_results.json` (model runs → the last run, test results → quality results per element), uploaded in the app or
 *   pushed from CI with its push token.
 * - **Snowflake `OBJECT_DEPENDENCIES`** – a discovery source in _account usage_ mode reads the dependencies of the views
 *   and dynamic tables of its scope after a complete run and proposes a step per referencing object.
 *
 * Proposals wait in an inbox (the Discovery page) until a person accepts (a step is made, or the documented one changed)
 * or rejects them – nothing is applied silently.
 */

export const DATA_LINEAGE_ID_PREFIX = { source: 'dpl_', token: 'dlt_', proposal: 'dpx_' } as const;

/** Push tokens of lineage sources: `Authorization: Bearer sdl_…` (only a SHA-256 is stored, the secret is shown once). */
export const DATA_LINEAGE_TOKEN_PREFIX = 'sdl_';

export const DATA_LINEAGE_SOURCE_KINDS = ['openlineage', 'dbt'] as const;
export type DataLineageSourceKind = (typeof DATA_LINEAGE_SOURCE_KINDS)[number];

/** Where a proposal comes from: an OpenLineage source, a dbt source, or a Snowflake discovery source. */
export const DATA_LINEAGE_ORIGINS = ['openlineage', 'dbt', 'snowflake'] as const;
export type DataLineageOrigin = (typeof DATA_LINEAGE_ORIGINS)[number];

/**
 * open: waits for a person; accepted: a step was made from it (or the documented one changed); rejected: a person said
 * no (it stays so until its datasets change); documented: the steps say the same already (nothing to do).
 */
export const DATA_LINEAGE_PROPOSAL_STATUSES = ['open', 'accepted', 'rejected', 'documented'] as const;
export type DataLineageProposalStatus = (typeof DATA_LINEAGE_PROPOSAL_STATUSES)[number];

/** The state of a job's last run (OpenLineage eventType in lower case; dbt: success → complete, error → fail, skipped → other). */
export const DATA_LINEAGE_RUN_STATES = ['start', 'running', 'complete', 'abort', 'fail', 'other'] as const;
export type DataLineageRunState = (typeof DATA_LINEAGE_RUN_STATES)[number];

export const DATA_LINEAGE_LIMITS = {
  sources: 50,
  tokensPerSource: 5,
  name: 200,
  /** One OpenLineage push (an event, or an array of events): checked from Content-Length before the body is read */
  eventBytes: 1024 * 1024,
  /** Events in one push (an array) */
  eventsPerPush: 100,
  /** Datasets of one event's inputs and outputs each (more is refused as not a run event Steward takes) */
  datasetsPerEvent: 500,
  /** Matched elements per side of a proposal (a step's ends) */
  ends: DATA_PRODUCT_LIMITS.stepEnds,
  /** Unmatched dataset names kept per side of a proposal (the rest counted) */
  unmatchedKept: 20,
  /** Proposals per source (jobs, models, referencing objects) */
  proposalsPerSource: 20_000,
  /** dbt files */
  manifestBytes: 40 * 1024 * 1024,
  runResultsBytes: 20 * 1024 * 1024,
  /** Nodes and sources of a manifest Steward reads (more: refused) */
  dbtNodes: 50_000,
  namespaceAliases: 20,
  teams: 20,
  /** Push tokens */
  tokenName: 100,
  cidrs: 20,
  expiresInDays: 730,
  rateLimitPerMinute: { default: 120, max: 1_200 },
  /** A page of proposals */
  page: 100,
  /** Proposals written per transaction (dbt, Snowflake), with a turn of the event loop between */
  batch: 250,
  /** OBJECT_DEPENDENCIES rows one discovery run reads */
  dependencies: 50_000,
  /** Text of a job key and a dataset name as kept */
  key: 1_000,
} as const;

/** The OpenLineage spec versions taken: 2-0-x (`schemaURL` …/spec/2-0-<n>/OpenLineage.json…). */
export const OPENLINEAGE_SCHEMA_RE = /^https:\/\/openlineage\.io\/spec\/2-0-\d{1,3}\/OpenLineage\.json(#.*)?$/;

export interface DataLineageNamespaceAlias {
  /** An OpenLineage namespace as a tool sends it (`snowflake://invented-org-shop`) */
  from: string;
  /** The namespace discovery gives the elements (`snowflake://demo12345`) */
  to: string;
}

export interface DataLineageSourceStats {
  /** Events (or dbt files) taken */
  received: number;
  /** Pushes refused after the token was accepted (not a valid event, too large) */
  refused: number;
  lastEventAt: string | null;
  /** Why the last refused push was refused (English; the web app shows errors:codes.<code>) */
  lastError: string | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
}

/** What the last dbt import of a source did (no file content: counts and the file's SHA-256). */
export interface DataLineageImport {
  file: 'manifest' | 'runResults';
  at: string;
  by: string;
  sha256: string;
  /** manifest: nodes read, proposals added/changed, nodes without an element; run results: results, runs, tests recorded */
  counts: Record<string, number>;
}

export interface DataLineageSource {
  id: string;
  name: string;
  kind: DataLineageSourceKind;
  /** dbt: the platform its models live on (elements are matched by qualified name there); OpenLineage: none */
  platformId: string | null;
  platformName: string | null;
  namespaceAliases: DataLineageNamespaceAlias[];
  /** Owning teams: who sees the source, its tokens and proposals ([]: every user of the module) */
  teamIds: string[];
  enabled: boolean;
  stats: DataLineageSourceStats;
  lastImport: DataLineageImport | null;
  /** Proposals by status (the reader's view of the counts is the source's: elements are named on the proposals only) */
  proposals: Record<DataLineageProposalStatus, number>;
  /** The push address (relative to the instance; OpenLineage clients append nothing to it) */
  pushPath: string;
  permissions: ('view' | 'manage')[];
  revision: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface DataLineageToken {
  id: string;
  name: string;
  prefix: string;
  allowedCidrs: string[];
  rateLimitPerMinute: number;
  expiresAt: string | null;
  createdAt: string;
  createdBy: string;
  rotatedAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  expired: boolean;
  /** The creator is deactivated or may no longer manage the source: the token stops working */
  creatorInactive: boolean;
}

export interface DataLineageTokenCreated extends DataLineageToken {
  token: string;
  path: string;
}

/** An end of a proposal the reader may see. */
export interface DataLineageEnd {
  id: string;
  kind: DataElementKind;
  qualifiedName: string;
  displayName: string;
  environment: string;
}

export interface DataLineageRun {
  state: DataLineageRunState;
  at: string;
  /** The last complete run (freshness evidence of its outputs) */
  completeAt: string | null;
}

export interface DataLineageProposal {
  id: string;
  origin: DataLineageOrigin;
  sourceId: string;
  sourceName: string;
  /** The job (`namespace/name`), the dbt node's unique id or the referencing Snowflake object */
  key: string;
  name: string;
  kind: DataStepKind;
  /** The tool in words (Airflow, dbt, Spark, Snowflake …) */
  tool: string;
  status: DataLineageProposalStatus;
  /** The datasets differ from the step it was accepted as (or that documents it): accepting again changes that step */
  changed: boolean;
  /** Matched elements the reader may see; the others counted */
  inputs: DataLineageEnd[];
  outputs: DataLineageEnd[];
  hiddenInputs: number;
  hiddenOutputs: number;
  /** Datasets no element matches (names as the tool sent them, at most DATA_LINEAGE_LIMITS.unmatchedKept; the rest counted) */
  unmatchedInputs: string[];
  unmatchedOutputs: string[];
  unmatchedInputCount: number;
  unmatchedOutputCount: number;
  /** The step it became or that documents it (null: none, or a step the reader may not see) */
  stepId: string | null;
  lastRun: DataLineageRun | null;
  firstSeenAt: string;
  lastSeenAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  /** The reader may accept it (sees every end, may change the products of its outputs) and why not */
  canAccept: boolean;
  cannotAccept: 'noOutputs' | 'hiddenEnds' | 'notAllowed' | null;
  canReject: boolean;
}

export interface DataLineageProposalPage {
  items: DataLineageProposal[];
  next: string | null;
}

/**
 * The ISO/IEC 25012 dimension of a dbt test by its generic test name (custom tests: none). not_null → completeness,
 * unique and relationships → consistency, accepted_values → accuracy. The dbt import passes it to recordQualityResults
 * (package B), which falls back to the test's name (qualityDimensionOf) for the others.
 */
export function dbtTestDimension(testName: string | null | undefined): Iso25012Dimension | null {
  const n = (testName ?? '').toLowerCase();
  if (n === 'not_null') return 'completeness';
  if (n === 'unique' || n === 'relationships') return 'consistency';
  if (n === 'accepted_values') return 'accuracy';
  return null;
}

/** The push address of a lineage source (OpenLineage events, and `…/dbt/manifest`, `…/dbt/run-results`). */
export const dataLineagePushPath = (sourceId: string): string => `/api/hooks/data-lineage/${encodeURIComponent(sourceId)}`;

/** An OpenLineage namespace as Steward compares it: trimmed, without a trailing slash, lower case. */
export const normaliseOlNamespace = (ns: string): string => ns.trim().replace(/\/+$/, '').toLowerCase();

// ---------- inputs ----------

const name = () => z.string().trim().min(1).max(DATA_LINEAGE_LIMITS.name);
const namespace = () =>
  z
    .string()
    .trim()
    .min(3)
    .max(500)
    .regex(/^[a-z][a-z0-9+.-]*:\/\/\S+$/i, 'an OpenLineage namespace such as snowflake://account');

export const dataLineageSourceInput = z
  .object({
    name: name(),
    kind: z.enum(DATA_LINEAGE_SOURCE_KINDS),
    platformId: z.string().trim().min(1).max(100).nullable().default(null),
    namespaceAliases: z
      .array(z.object({ from: namespace(), to: namespace() }).strict())
      .max(DATA_LINEAGE_LIMITS.namespaceAliases)
      .default([]),
    /** Owning teams; left out: the creator's teams (a new source) or the teams it has (a change) */
    teamIds: z.array(z.string().trim().min(1).max(100)).max(DATA_LINEAGE_LIMITS.teams).optional(),
    enabled: z.boolean().default(true),
  })
  .strict();
export type DataLineageSourceInput = z.input<typeof dataLineageSourceInput>;

export const dataLineageTokenInput = z
  .object({
    name: z.string().trim().min(1).max(DATA_LINEAGE_LIMITS.tokenName),
    expiresInDays: z.number().int().min(1).max(DATA_LINEAGE_LIMITS.expiresInDays).optional(),
    allowedCidrs: z.array(z.string().trim().min(1).max(64)).max(DATA_LINEAGE_LIMITS.cidrs).default([]),
    rateLimitPerMinute: z.number().int().min(1).max(DATA_LINEAGE_LIMITS.rateLimitPerMinute.max).default(DATA_LINEAGE_LIMITS.rateLimitPerMinute.default),
  })
  .strict();
export type DataLineageTokenInput = z.input<typeof dataLineageTokenInput>;

/** Accepting a proposal: the step's name and kind may be changed on the way. */
export const dataLineageAcceptInput = z
  .object({
    name: name().optional(),
    kind: z.enum(DATA_STEP_KINDS).optional(),
  })
  .strict();
export type DataLineageAcceptInput = z.input<typeof dataLineageAcceptInput>;
