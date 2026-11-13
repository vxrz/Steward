import { z } from 'zod';
import { mdCodeSpan, mdText } from './markdown.js';

/**
 * Data contracts (0.9.0, #221, docs/DATA-CONTRACTS.md): what a data source promises – schema, quality rules, owner,
 * terms – as an Open Data Contract Standard v3 document (ODCS, https://bitol-io.github.io/open-data-contract-standard/,
 * Bitol / Linux Foundation AI & Data). Steward keeps every saved version as YAML, checks it against the official JSON
 * Schema of ODCS v3.0.2 on save, compares versions (breaking changes marked), links a contract to what Steward knows
 * (applications, systems, datasets, API specifications, database tables, the database platforms of its servers) and
 * tests it through the datacontract CLI's API (https://cli.datacontract.com, run as its own container).
 */

/** The platform kind of the data contract service: the datacontract CLI's API (`datacontract api`). */
export const DATA_CONTRACT_SERVICE_KIND = 'datacontract';

/** The ODCS version whose JSON Schema Steward ships (server/assets/odcs). */
export const ODCS_SCHEMA_VERSION = 'v3.0.2';
/** The apiVersion a new draft gets. */
export const ODCS_DRAFT_API_VERSION = 'v3.0.2';

/**
 * relax: switch off "breaking changes need a change record" (administrators and approvers – who approve changes; the
 * action right _relax the breaking-change rule_ of a share, 0.23.0, ADR 0033 decision 12). manage: the same right under
 * its former name – deprecated, kept in `permissions` for one release; who changes a contract's shares is the Access
 * tab's `canManage`.
 */
export const DATA_CONTRACT_PERMISSIONS = ['view', 'test', 'edit', 'relax', 'manage'] as const;
export type DataContractPermission = (typeof DATA_CONTRACT_PERMISSIONS)[number];

export const DATA_CONTRACT_LIMITS = {
  /** A contract as YAML (bytes): contracts are small; this one limit also bounds the JSON Schema check and the diff */
  yamlBytes: 1024 * 1024,
  /** Upper bound of mapping keys (':' and '?'), aliases expanded, nesting depth – as for the plant registry import */
  keys: 50_000,
  aliases: 100,
  depth: 32,
  /** Schema objects (tables, topics …) and their properties (all levels together) */
  schemaObjects: 500,
  properties: 20_000,
  /** Quality rules (all schema objects and properties together) and values in the whole document (every mapping, list and
   * scalar): generous for real contracts, they bound the JSON Schema check and the comparison of versions */
  qualityRules: 10_000,
  nodes: 250_000,
  /** Lint findings kept per version, changes listed per comparison (more are counted) */
  lintFindings: 200,
  changes: 2_000,
  /** Links per contract */
  links: 200,
  /** A test report as stored (bytes); a larger one is cut and marked truncated */
  reportBytes: 2 * 1024 * 1024,
  /** Test runs kept per contract: the newest real runs; failed ones (and errors) beyond them; dry runs on their own */
  runsKept: 500,
  failedRunsKept: 500,
  dryRunsKept: 100,
  note: 500,
  nameChars: 200,
  /** Rows of a dataset or a recorded response a draft looks at */
  draftSampleRows: 200,
  /** "No test for N days" (Steward's own check) */
  testedWithinDays: { default: 7, max: 365 },
} as const;

/** What a contract links to. `server`: the database platform that answers for one of the contract's servers (tests). */
export const DATA_CONTRACT_LINK_KINDS = ['application', 'system', 'dataset', 'spec', 'table', 'server'] as const;
export type DataContractLinkKind = (typeof DATA_CONTRACT_LINK_KINDS)[number];

/** Where a draft comes from. */
export const DATA_CONTRACT_DRAFT_SOURCES = ['openapi', 'recording', 'dataset', 'table'] as const;
export type DataContractDraftSource = (typeof DATA_CONTRACT_DRAFT_SOURCES)[number];

/** The result of a test run, as the datacontract CLI reports it (`error`: the run itself failed). */
export const DATA_CONTRACT_RESULTS = ['passed', 'warning', 'failed', 'error'] as const;
export type DataContractResult = (typeof DATA_CONTRACT_RESULTS)[number];

/** Who started a test run. */
export const DATA_CONTRACT_RUN_VIA = ['ui', 'monitor', 'process'] as const;
export type DataContractRunVia = (typeof DATA_CONTRACT_RUN_VIA)[number];

/** The ODCS server types Steward can test: a database platform of that DBMS answers for them (its credentials, its host). */
export const DATA_CONTRACT_SERVER_DIALECTS: Record<string, 'postgresql' | 'mysql' | 'sqlserver'> = {
  postgresql: 'postgresql',
  postgres: 'postgresql',
  mysql: 'mysql',
  sqlserver: 'sqlserver',
};

/** Steward's own checks of a contract (no service needed), also modes of the monitor check. */
export const DATA_CONTRACT_FINDING_KINDS = ['noOwner', 'notTested', 'lastTestFailed', 'columnsMissing', 'columnsExtra', 'lint'] as const;
export type DataContractFindingKind = (typeof DATA_CONTRACT_FINDING_KINDS)[number];

// ---------- the document ----------

/** A lint finding: the JSON Schema check (Steward) or the CLI's lint (`source: service`). */
export interface DataContractLintFinding {
  /** JSON Pointer-like path in the document: /schema/0/properties/2/logicalType */
  path: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
  source: 'schema' | 'yaml' | 'service';
}

/** What Steward reads from a contract for lists, links and checks. */
export interface DataContractFacts {
  /** ODCS `id` */
  key: string;
  name: string;
  /** ODCS `version` */
  version: string;
  apiVersion: string;
  /** ODCS `status`: proposed, draft, active, deprecated, retired … */
  status: string;
  domain: string | null;
  /** Schema objects with their property paths (customer.address.city) */
  schemas: { name: string; physicalName: string | null; properties: string[] }[];
  /** Servers: their `server` name and `type` */
  servers: { server: string; type: string }[];
  /** People of the ODCS `team` section (usernames) */
  team: string[];
}

// ---------- changes ----------

export const DATA_CONTRACT_CHANGE_KINDS = [
  'schema-added',
  'schema-removed',
  'field-added',
  'field-removed',
  'type-changed',
  'type-narrowed',
  'type-widened',
  'required-added',
  'required-removed',
  'unique-added',
  'unique-removed',
  'quality-added',
  'quality-removed',
  'quality-tightened',
  'quality-loosened',
  'quality-changed',
  'server-added',
  'server-removed',
  'server-changed',
  'physical-name-changed',
  'status-changed',
  'version-changed',
] as const;
export type DataContractChangeKind = (typeof DATA_CONTRACT_CHANGE_KINDS)[number];

/** Why a change is breaking (docs/DATA-CONTRACTS.md#breaking-changes). */
export const DATA_CONTRACT_BREAKING_REASONS = [
  'schemaRemoved',
  'fieldRemoved',
  'typeChanged',
  'typeNarrowed',
  'requiredAdded',
  'uniqueAdded',
  'qualityAdded',
  'qualityTightened',
  'physicalNameChanged',
  'serverChanged',
] as const;
export type DataContractBreakingReason = (typeof DATA_CONTRACT_BREAKING_REASONS)[number];

export interface DataContractChange {
  kind: DataContractChangeKind;
  /** The schema object, the property path (customer.address.city), the quality rule */
  schema?: string;
  field?: string;
  rule?: string;
  before?: string | null;
  after?: string | null;
  breaking: boolean;
  reason?: DataContractBreakingReason;
}

export interface DataContractDiff {
  changes: DataContractChange[];
  /** All changes and the breaking ones (also beyond the changes listed) */
  total: number;
  breaking: number;
}

// ---------- API ----------

export interface DataContractLink {
  id: string;
  kind: DataContractLinkKind;
  /** application / system id, dataset key, spec id, platform id (table: the database platform or system, server: the database platform) */
  targetId: string;
  /** table: platform | system */
  targetKind: 'platform' | 'system' | null;
  /** table: the qualified table (public.orders); spec: "GET /orders"; server: the ODCS server name */
  detail: string | null;
  /** The contract's schema object it describes (null: the whole contract) */
  schema: string | null;
  /** The target's name; null when the reader may not see it (then only that a link exists is shown) */
  name: string | null;
  createdAt: string;
  createdBy: string;
}

export interface DataContractRunSummary {
  id: string;
  version: number;
  result: DataContractResult;
  via: DataContractRunVia;
  /** The monitor or the process run that started it */
  sourceId: string | null;
  server: string | null;
  checks: { total: number; passed: number; warning: number; failed: number };
  /** The first problems, for lists and messages */
  headline: string;
  startedAt: string;
  durationMs: number;
  actor: string;
  dryRun: boolean;
}

/** A run with its full report (the CLI's answer, secrets masked). */
export interface DataContractRun extends DataContractRunSummary {
  report: unknown;
  reportSha256: string;
  truncated: boolean;
  /** The service platform (null when the reader may not see it) */
  service: { id: string; name: string } | null;
}

export interface DataContractFinding {
  kind: DataContractFindingKind;
  /** The schema object or link it is about */
  schema?: string;
  link?: string;
  /** Column or field names (columnsMissing / columnsExtra) */
  fields?: string[];
  /** The days since the last test (notTested), the problems counted (lint) */
  count?: number;
  severity: 'error' | 'warning';
}

export interface DataContractSummary {
  id: string;
  key: string;
  name: string;
  status: string;
  /** ODCS version of the current version */
  version: string;
  /** Steward's number of the current version (1, 2, …) */
  currentVersion: number;
  owningTeams: { id: string; name: string }[];
  lintErrors: number;
  lastRun: Pick<DataContractRunSummary, 'id' | 'result' | 'startedAt'> | null;
  findingCount: number;
  linkCount: number;
  updatedAt: string;
  updatedBy: string;
}

export interface DataContractSettings {
  /** The data contract service (platform kind datacontract) the tests run on */
  servicePlatformId: string | null;
  /** The ODCS server to test (null: the only one) */
  testServer: string | null;
  /** A version with a breaking change needs an approved change record */
  requireChangeRecord: boolean;
}

export interface DataContractDetail extends DataContractSummary, DataContractSettings {
  yaml: string;
  facts: DataContractFacts;
  lint: DataContractLintFinding[];
  links: DataContractLink[];
  findingList: DataContractFinding[];
  /** The service platform's name (null: none or not visible) */
  serviceName: string | null;
  permissions: DataContractPermission[];
  createdAt: string;
  createdBy: string;
}

export interface DataContractVersionSummary {
  version: number;
  odcsVersion: string;
  status: string;
  sha256: string;
  changes: number;
  breaking: number;
  lintErrors: number;
  note: string;
  changeRecord: { id: string; number: string; title: string } | null;
  createdAt: string;
  createdBy: string;
}

export interface DataContractVersion extends DataContractVersionSummary {
  yaml: string;
  lint: DataContractLintFinding[];
  diff: DataContractDiff | null;
}

/** The check of a text before it is saved: parse, JSON Schema, and the changes against the current version. */
export interface DataContractPreview {
  facts: DataContractFacts | null;
  lint: DataContractLintFinding[];
  diff: DataContractDiff | null;
  /** Same text as the current version */
  unchanged: boolean;
  /** Saving needs an approved change record (a breaking change and the setting on) */
  needsChangeRecord: boolean;
}

export interface DataContractDraft {
  yaml: string;
  /** Links the draft suggests (saved with the new contract) */
  links: DataContractLinkInput[];
  warnings: string[];
}

export interface DataContractImportResult {
  action: 'created' | 'version' | 'unchanged';
  contract: DataContractSummary;
  diff: DataContractDiff | null;
}

// ---------- inputs ----------

const id = z.string().trim().min(1).max(200);

export const dataContractLinkInput = z
  .object({
    kind: z.enum(DATA_CONTRACT_LINK_KINDS),
    targetId: id,
    targetKind: z.enum(['platform', 'system']).nullable().optional(),
    detail: z.string().trim().max(300).nullable().optional(),
    schema: z.string().trim().max(DATA_CONTRACT_LIMITS.nameChars).nullable().optional(),
  })
  .strict();
export type DataContractLinkInput = z.infer<typeof dataContractLinkInput>;

export const dataContractSettingsInput = z
  .object({
    servicePlatformId: id.nullable(),
    testServer: z.string().trim().max(DATA_CONTRACT_LIMITS.nameChars).nullable(),
    requireChangeRecord: z.boolean(),
  })
  .strict();

export const dataContractCreateInput = z
  .object({
    yaml: z.string().min(1).max(DATA_CONTRACT_LIMITS.yamlBytes),
    links: z.array(dataContractLinkInput).max(DATA_CONTRACT_LIMITS.links).default([]),
    settings: dataContractSettingsInput.partial().optional(),
    note: z.string().trim().max(DATA_CONTRACT_LIMITS.note).default(''),
  })
  .strict();
export type DataContractCreateInput = z.input<typeof dataContractCreateInput>;

export const dataContractVersionInput = z
  .object({
    yaml: z.string().min(1).max(DATA_CONTRACT_LIMITS.yamlBytes),
    note: z.string().trim().max(DATA_CONTRACT_LIMITS.note).default(''),
    changeRecordId: z.string().trim().min(1).max(100).nullable().optional(),
  })
  .strict();
export type DataContractVersionInput = z.input<typeof dataContractVersionInput>;

export const dataContractYamlInput = z.object({ yaml: z.string().min(1).max(DATA_CONTRACT_LIMITS.yamlBytes) }).strict();

export const dataContractDraftInput = z.discriminatedUnion('source', [
  z
    .object({ source: z.literal('openapi'), platformId: id, specId: id, method: z.string().trim().min(1).max(10), path: z.string().trim().min(1).max(500) })
    .strict(),
  z.object({ source: z.literal('recording'), platformId: id, recordingId: id }).strict(),
  z.object({ source: z.literal('dataset'), dataset: id }).strict(),
  /** An element of the data products catalogue (ADR 0036 part 7): a Snowflake table's columns, a Kafka topic's schema, a database table */
  z.object({ source: z.literal('element'), elementId: id }).strict(),
  z
    .object({
      source: z.literal('table'),
      subjectKind: z.enum(['platform', 'system']),
      subjectId: id,
      tables: z.array(z.string().trim().min(1).max(300)).min(1).max(50),
    })
    .strict(),
]);
export type DataContractDraftInput = z.infer<typeof dataContractDraftInput>;

export const dataContractTestInput = z
  .object({
    /** The ODCS server to test (default: the contract's setting, or the only server) */
    server: z.string().trim().max(DATA_CONTRACT_LIMITS.nameChars).optional(),
  })
  .strict();

// ---------- changes as text ----------

export type DataContractTx = (key: string, values?: Record<string, unknown>) => string;

/** A change as one line: `orders.total – type narrowed: decimal(12,2) → decimal(10,2)`. */
export function dataContractChangeLine(t: DataContractTx, c: DataContractChange): string {
  const where = [c.schema, c.field].filter(Boolean).join('.') + (c.rule ? ` (${c.rule})` : '');
  const values = c.before || c.after ? `: ${[c.before ?? '–', c.after ?? '–'].join(' → ')}` : '';
  return `${where ? `${where} – ` : ''}${t(`changeKinds.${c.kind}`)}${values}`;
}

/** The changes as Markdown for a change record; every change is one code span (names come from the YAML). */
export function dataContractChangesMarkdown(t: DataContractTx, name: string, d: DataContractDiff, from: number, to: number): string {
  const lines = [
    `## ${t('mdTitle', { name: mdText(name), from, to })}`,
    '',
    t('mdSummary', { count: d.total, breaking: d.breaking }),
    '',
    ...d.changes.map((c) => `- ${c.breaking ? `**${t('breaking')}** (${t(`reasons.${c.reason}`)}) ` : ''}${mdCodeSpan(dataContractChangeLine(t, c))}`),
  ];
  if (d.total > d.changes.length) lines.push('', t('mdMore', { count: d.total - d.changes.length }));
  return lines.join('\n');
}
