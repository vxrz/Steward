/**
 * Contract of the public REST API (/api/v1): every response body and query
 * string is defined here as a zod schema, converted to JSON Schema
 * (draft 2019-09, compatible with OpenAPI 3.1) and registered as Fastify route
 * schemas. The response schemas also drive serialization, so a field that is
 * not declared here never leaves the server.
 *
 * Compatibility rules (see docs/API.md): within v1 only additive changes –
 * new endpoints, new optional query parameters, new response fields. Clients
 * must ignore unknown fields.
 */
import { z, type ZodTypeAny } from 'zod';
import { zodJsonSchema, type JsonSchema } from '../../jsonSchema.js';
import {
  API_DOCS_MODES,
  DATASET_STATUSES,
  PLATFORM_PERMISSIONS,
  PROCESS_PERMISSIONS,
  QUERY_LIST_MAX,
  ROLES,
  type RunStatus,
  type RunSummary,
  type StepStatus,
} from '@sm/shared';
import { MONITOR_COMPONENTS } from '../../monitors/api-schemas.js';
import { CREDENTIAL_COMPONENTS } from '../../credentials/api-schemas.js';
import { RECORD_COMPONENTS } from '../../records/api-schemas.js';
import { TICKET_COMPONENTS } from '../../tickets/api-schemas.js';
import { COMPLIANCE_COMPONENTS } from '../../compliance/api-schemas.js';
import { SERVICE_COMPONENTS } from '../../catalogue/api-schemas.js';

export const RUN_STATUSES = ['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const satisfies readonly RunStatus[];
export const RUN_TRIGGERS = ['manual', 'schedule', 'resume', 'subprocess', 'webhook', 'monitor'] as const satisfies readonly RunSummary['trigger'][];
export const STEP_STATUSES = ['running', 'succeeded', 'failed', 'skipped', 'waiting', 'dryrun'] as const satisfies readonly StepStatus[];
export const TASK_STATUSES = ['open', 'completed', 'cancelled'] as const;
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

// ---------- building blocks ----------

const ts = () => z.string().datetime({ offset: true }).describe('ISO 8601 timestamp (UTC)');
const nullableTs = (d: string) => ts().nullable().describe(d);
/** Free-form JSON value (process definitions, inputs, step output …). */
const json = (d: string) => z.unknown().describe(d);
const jsonObject = (d: string) => z.record(z.string(), z.unknown()).describe(d);

const cursorDescription = 'Opaque cursor for the next page; null on the last page. Pass it unchanged as `cursor` together with the same filters.';

// ---------- component schemas ----------

export const Problem = z
  .object({
    type: z.string().describe('URI reference identifying the problem type'),
    title: z.string().describe('Short, human-readable summary of the problem type'),
    status: z.number().int().describe('HTTP status code'),
    detail: z.string().optional().describe('Explanation specific to this occurrence'),
    instance: z.string().optional().describe('Request path of this occurrence'),
    errors: z
      .array(z.object({ in: z.string(), name: z.string(), message: z.string() }))
      .optional()
      .describe('Validation problems (400 only)'),
  })
  .describe('Problem details (RFC 9457), served as application/problem+json');

export const Health = z.object({
  status: z.enum(['ok', 'unavailable']).describe('"unavailable" while the vault is locked: data endpoints answer 503 until an administrator unlocks it'),
  apiVersion: z.string().describe('Semantic version of this API description'),
  time: ts(),
});

export const Me = z.object({
  user: z.object({
    id: z.string(),
    username: z.string(),
    displayName: z.string(),
    roles: z.array(z.enum(ROLES)),
    teams: z.array(z.string()),
  }),
  token: z.object({
    id: z.string(),
    name: z.string(),
    scope: z.enum(['read', 'full']).describe('Both scopes may call every /api/v1 endpoint (all are read-only)'),
    createdAt: ts(),
    expiresAt: nullableTs('Expiry; null = never'),
    lastUsedAt: nullableTs('Previous use (updated at most once a minute)'),
  }),
  capabilities: z.object({
    viewAudit: z.boolean().describe('May read /audit (auditor, admin)'),
    manageUsers: z.boolean().describe('May read /users and /teams (admin)'),
  }),
  serverVersion: z.string(),
  apiVersion: z.string(),
});

const LastRun = z.object({ id: z.string(), status: z.enum(RUN_STATUSES), startedAt: ts() }).nullable();

export const Process = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  currentVersion: z.number().int(),
  updatedAt: ts(),
  owner: z.string().nullable().describe('User name of the owner (full rights)'),
  permissions: z.array(z.enum(PROCESS_PERMISSIONS)).describe('What the token owner may do with this process'),
  lastRun: LastRun,
});

export const ProcessDetail = Process.extend({
  definition: jsonObject('Current process definition (nodes, wires, inputs, connections …)'),
  definitionHash: z.string().describe('SHA-256 of the canonical definition'),
});

export const ProcessVersion = z.object({
  version: z.number().int(),
  hash: z.string(),
  author: z.string(),
  comment: z.string(),
  createdAt: ts(),
});

export const ProcessVersionDetail = ProcessVersion.extend({
  processId: z.string(),
  definition: jsonObject('Process definition of this version'),
});

const RunStats = z.object({
  steps: z.number().int(),
  failedSteps: z.number().int(),
  writes: z.number().int().describe('Write calls (POST/PUT/PATCH/DELETE) sent to platforms'),
  skippedWrites: z.number().int().describe('Write calls only recorded because of a dry run'),
  checksPassed: z.number().int(),
  checksFailed: z.number().int(),
  openTasks: z.number().int(),
});

export const Run = z.object({
  id: z.string(),
  processId: z.string(),
  processName: z.string(),
  processVersion: z.number().int(),
  status: z.enum(RUN_STATUSES),
  dryRun: z.boolean(),
  trigger: z.enum(RUN_TRIGGERS),
  scheduleId: z.string().nullable(),
  parentRunId: z.string().nullable().describe('Run that started this one through a sub-process node'),
  parentStepKey: z.string().nullable(),
  actor: z.string().describe('User who started the run (schedule owner for scheduled runs)'),
  startedAt: ts(),
  finishedAt: nullableTs('Null while the run is not finished'),
  error: z.string().nullable(),
  stats: RunStats,
});

const RunChild = z.object({
  id: z.string(),
  processId: z.string(),
  processName: z.string(),
  status: z.enum(RUN_STATUSES),
  parentStepKey: z.string().nullable(),
  startedAt: ts(),
  finishedAt: nullableTs('Null while the run is not finished'),
});

const Decision = z.object({
  taskId: z.string(),
  stepKey: z.string(),
  mode: z.enum(['select', 'approve']),
  title: z.string(),
  status: z.enum(TASK_STATUSES),
  approved: z.boolean().nullable(),
  selectedKeys: z.array(z.string()).nullable(),
  comment: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: nullableTs('When the decision was made'),
  createdAt: ts(),
});

const Check = z.object({
  stepKey: z.string(),
  name: z.string(),
  passed: z.boolean(),
  severity: z.string(),
  message: z.string(),
  finishedAt: nullableTs('When the check was evaluated'),
});

export const RunDetail = Run.extend({
  inputs: jsonObject('Inputs the run was started with'),
  bindings: z
    .record(z.string(), z.object({ platformId: z.string(), platformName: z.string(), baseUrl: z.string() }))
    .describe('Connection slot → platform used by this run'),
  definitionHash: z.string().describe('Hash of the pinned process version'),
  outputs: jsonObject('Evaluated process outputs').nullable(),
  steps: z
    .object({ total: z.number().int(), byStatus: z.record(z.string(), z.number().int()) })
    .describe('Summary of the step journal; page through GET /runs/{runId}/steps for the entries'),
  decisions: z.array(Decision).describe('User tasks of this run and their decisions'),
  checks: z.array(Check),
  protocol: z
    .object({
      hash: z.string().describe('SHA-256 fingerprint of everything recorded for the run'),
      recordedHash: z.string().nullable().describe('Fingerprint sealed in the audit log when the run finished'),
      intact: z.boolean().nullable().describe('hash = recordedHash; null while the run is not finished'),
    })
    .describe('Tamper evidence of the run protocol'),
  children: z.array(RunChild).describe('Sub-process runs started by this run (only those you may view)'),
});

const stepFields = {
  id: z.string().describe('Journal entry id (increasing in execution order)'),
  key: z.string().describe('Activation key (loop scope + node id)'),
  parentKey: z.string().nullable(),
  nodeId: z.string(),
  type: z.string(),
  name: z.string(),
  status: z.enum(STEP_STATUSES),
  startedAt: ts(),
  finishedAt: nullableTs('Null while the step runs'),
  durationMs: z.number().int().nullable(),
  summary: z.string().nullable(),
  error: z.string().nullable(),
};

export const RunStep = z.object({
  ...stepFields,
  input: json('Resolved request or configuration (secrets redacted); truncated preview'),
  output: json('Output; truncated preview in lists, complete from GET /runs/{runId}/steps/{stepId}'),
  outputTruncated: z.boolean(),
});

export const RunLog = z.object({
  id: z.string(),
  ts: ts(),
  level: z.enum(LOG_LEVELS),
  stepKey: z.string().nullable(),
  message: z.string(),
  data: json('Structured data attached to the log entry (may be absent)'),
});

const taskFields = {
  id: z.string(),
  runId: z.string(),
  processId: z.string(),
  processName: z.string(),
  stepKey: z.string(),
  mode: z.enum(['select', 'approve']).describe('select: pick items; approve: approve or reject'),
  title: z.string(),
  instructions: z.string().nullable(),
  status: z.enum(TASK_STATUSES),
  assignees: z.array(z.string()).describe('user:/team:/role: subjects; empty = everyone with run or approve rights'),
  fourEyes: z.boolean(),
  dryRun: z.boolean(),
  startedBy: z.string().nullable(),
  createdAt: ts(),
  decidedBy: z.string().nullable(),
  decidedAt: nullableTs('When the task was decided'),
  approved: z.boolean().nullable(),
  itemCount: z.number().int(),
  canDecide: z.boolean().describe('Whether the token owner may decide it (in the web UI)'),
  cannotDecideReason: z.string().nullable(),
};

export const Task = z.object(taskFields);

export const TaskDetail = z.object({
  ...taskFields,
  columns: z.array(z.string()).describe('Column labels of the items'),
  items: z.array(z.object({ key: z.string(), cells: z.array(z.string()), preselected: z.boolean() })),
  selectedKeys: z.array(z.string()).nullable(),
  comment: z.string().nullable(),
});

export const Schedule = z.object({
  id: z.string(),
  name: z.string(),
  processId: z.string(),
  processName: z.string(),
  cron: z.string(),
  timezone: z.string().nullable(),
  enabled: z.boolean(),
  dryRun: z.boolean(),
  allowOverlap: z.boolean(),
  inputs: jsonObject('Preset inputs'),
  bindings: z.record(z.string(), z.string()).describe('Connection slot → platform id'),
  owner: z.string().nullable().describe('Scheduled runs use the rights of this user'),
  nextRunAt: nullableTs('Next planned run (null when disabled or the scheduler is stopped)'),
  lastRunAt: nullableTs('Last run'),
  lastRunId: z.string().nullable(),
  lastRunStatus: z.enum(RUN_STATUSES).nullable(),
  createdAt: ts(),
});

export const Trigger = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    processId: z.string(),
    processName: z.string(),
    processVersion: z.number().int().nullable().describe('Pinned process version (null: always the current version)'),
    enabled: z.boolean(),
    dryRun: z.boolean(),
    authMode: z.string().describe('How callers authenticate (the secret itself is never part of the API)'),
    owner: z.string().describe('Runs use the rights of this user'),
    createdAt: ts(),
    updatedAt: ts(),
    lastFiredAt: nullableTs('Last accepted call'),
    lastRunId: z.string().nullable(),
    lastRunStatus: z.string().nullable(),
    fireCount: z.number().int().describe('Accepted calls'),
    rejectedCount: z.number().int().describe('Rejected calls (wrong secret, address, rate limit …)'),
  })
  .describe('Webhook trigger metadata. The secret, its prefix, the input mapping and the allowed addresses are not part of the API.');

export const Platform = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.string(),
    description: z.string(),
    environment: z.string(),
    baseUrl: z.string().describe('Base URL without user info and query string'),
    authType: z.string().describe('Authentication method (none, basic, bearer, apiKey, oauth2_client_credentials, token_request)'),
    permissions: z.array(z.enum(PLATFORM_PERMISSIONS)).describe('What the token owner may do with this platform'),
    createdAt: ts(),
    updatedAt: ts(),
  })
  .describe('Platform metadata. Credentials, variables and authentication settings are never part of the API.');

export const Dataset = z.object({
  key: z.string(),
  title: z.string(),
  processId: z.string(),
  processName: z.string(),
  runId: z.string().describe('Run that published the current snapshot'),
  dryRun: z.boolean(),
  updatedAt: ts(),
  rowCount: z.number().int(),
  columns: z.array(z.string()),
  statusCounts: z.record(z.string(), z.number().int()).describe('Rows per status (good, warning, serious, critical, unknown)'),
  metrics: z.record(z.string(), z.number()).describe('Latest value per metric'),
  staleAfterMinutes: z.number().int().nullable(),
  stale: z.boolean(),
});

export const DatasetRow = z
  .record(z.string(), z.unknown())
  .describe('One row of the snapshot. Reserved fields: _key, _status (good | warning | serious | critical | unknown), _statusText.');

export const MetricSeries = z.object({
  name: z.string(),
  points: z.array(z.object({ ts: ts(), value: z.number() })),
});

export const Dashboard = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  definition: jsonObject('Dashboard definition (widgets referencing datasets)'),
  owner: z.string().nullable(),
  createdAt: ts(),
  updatedAt: ts(),
});

export const AuditEntry = z.object({
  seq: z.number().int().describe('Position in the hash chain (1, 2, 3 …)'),
  ts: ts(),
  actor: z.string(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  runId: z.string().nullable(),
  summary: z.string(),
  details: json('Structured details (never contains secret values)'),
  hash: z.string().describe('HMAC-SHA-256 chained to the previous entry'),
});

export const AuditVerifyResult = z.object({
  ok: z.boolean(),
  checked: z.number().int(),
  firstBadSeq: z.number().int().nullable(),
  message: z.string(),
});

export const User = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  email: z.string().nullable(),
  roles: z.array(z.enum(ROLES)),
  teams: z.array(z.string()),
  active: z.boolean(),
  authSource: z.string().describe('"local" or the id of the single sign-on provider'),
  mustChangePassword: z.boolean(),
  lastLoginAt: nullableTs('Last sign-in'),
  createdAt: ts(),
});

export const Team = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  members: z.array(z.string()).describe('User names'),
  createdAt: ts(),
});

/** Named components (#/components/schemas/<name>), in the order they appear in the document. */
export const COMPONENTS: Record<string, ZodTypeAny> = {
  Problem,
  Health,
  Me,
  Process,
  ProcessDetail,
  ProcessVersion,
  ProcessVersionDetail,
  Run,
  RunDetail,
  RunStep,
  RunLog,
  Task,
  TaskDetail,
  Schedule,
  Platform,
  Trigger,
  Dataset,
  DatasetRow,
  MetricSeries,
  Dashboard,
  AuditEntry,
  AuditVerifyResult,
  User,
  Team,
  ...MONITOR_COMPONENTS,
  ...CREDENTIAL_COMPONENTS,
  ...RECORD_COMPONENTS,
  ...TICKET_COMPONENTS,
  ...COMPLIANCE_COMPONENTS,
  ...SERVICE_COMPONENTS,
};

/** Example values shown in the documentation. */
const EXAMPLES: Record<string, unknown> = {
  Run: {
    id: 'run_8xQ2mK1pZt4a',
    processId: 'ih-health-check',
    processName: 'Insights Hub – Platform health check',
    processVersion: 3,
    status: 'succeeded',
    dryRun: false,
    trigger: 'schedule',
    scheduleId: 'sch_Hn3r0dYw1kQe',
    parentRunId: null,
    parentStepKey: null,
    actor: 'olivia',
    startedAt: '2026-10-22T06:00:00.012Z',
    finishedAt: '2026-10-22T06:00:04.871Z',
    error: null,
    stats: { steps: 12, failedSteps: 0, writes: 0, skippedWrites: 0, checksPassed: 5, checksFailed: 0, openTasks: 0 },
  },
  Platform: {
    id: 'pf_2bV9xLq0aYc1',
    name: 'Insights Hub (production)',
    kind: 'insights-hub',
    description: 'EU1 tenant',
    environment: 'production',
    baseUrl: 'https://gateway.eu1.mindsphere.io',
    authType: 'oauth2_client_credentials',
    permissions: ['use'],
    createdAt: '2026-09-01T08:15:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
  },
  Problem: {
    type: 'https://github.com/vxrz/steward/blob/main/docs/API.md#invalid-token',
    title: 'Unauthorized',
    status: 401,
    detail: 'Invalid, expired or revoked API token',
    instance: '/api/v1/runs',
  },
};

// ---------- query strings & path parameters ----------

const limit = z.number().int().min(1).max(200).default(50).describe('Page size (1–200, default 50)');
const cursor = z.string().max(2000).optional().describe('Cursor from the previous page (`nextCursor`)');
const page = { limit, cursor };

export const PageQuery = z.object(page);

export const ProcessListQuery = z.object({
  ...page,
  tag: z.string().max(200).optional().describe('Only processes with this tag'),
  q: z.string().max(200).optional().describe('Case-insensitive search in id, name and description'),
});

export const RunListQuery = z.object({
  ...page,
  processId: z.string().max(200).optional(),
  status: z.array(z.enum(RUN_STATUSES)).max(QUERY_LIST_MAX).optional().describe('One or more statuses (repeat the parameter)'),
  trigger: z.array(z.enum(RUN_TRIGGERS)).max(QUERY_LIST_MAX).optional().describe('One or more triggers (repeat the parameter)'),
  scheduleId: z.string().max(200).optional(),
  dryRun: z.boolean().optional().describe('true: only dry runs, false: only real runs'),
  from: ts().optional().describe('Started at or after this time (ISO 8601)'),
  to: ts().optional().describe('Started before this time (ISO 8601)'),
});

export const StepListQuery = z.object({
  ...page,
  status: z.array(z.enum(STEP_STATUSES)).max(QUERY_LIST_MAX).optional().describe('One or more step statuses (repeat the parameter)'),
  type: z.string().max(100).optional().describe('Node type, e.g. http, check, userTask'),
});

export const LogListQuery = z.object({
  ...page,
  level: z.array(z.enum(LOG_LEVELS)).max(QUERY_LIST_MAX).optional().describe('One or more levels (repeat the parameter)'),
});

export const TaskListQuery = z.object({
  ...page,
  status: z.array(z.enum(TASK_STATUSES)).max(QUERY_LIST_MAX).optional().describe('open, completed, cancelled (repeat the parameter); default all'),
  processId: z.string().max(200).optional(),
  runId: z.string().max(200).optional(),
});

export const ScheduleListQuery = z.object({
  ...page,
  processId: z.string().max(200).optional(),
  enabled: z.boolean().optional(),
});

/** Response schema of /semantic-model: an Ossie document (validated against the vendored Ossie schemas in the tests). */
export const ossieDocumentSchema = {
  type: 'object',
  description: 'Apache Ossie semantic model document (0.1.1: `semantic_model` array; 0.2.0.dev0: one model at the root)',
  required: ['version'],
  properties: {
    version: { type: 'string', enum: ['0.1.1', '0.2.0.dev0'], description: 'Ossie specification version' },
    semantic_model: { type: 'array', items: { type: 'object', additionalProperties: true } },
    name: { type: 'string' },
    datasets: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
  additionalProperties: true,
};

export const TriggerListQuery = z.object({
  ...page,
  processId: z.string().max(200).optional(),
  enabled: z.boolean().optional(),
});

export const SemanticModelQuery = z.object({
  format: z.enum(['json', 'yaml']).optional().describe('Response format; default from the Accept header (application/yaml or application/json), else JSON'),
  version: z.enum(['0.1.1', '0.2.0.dev0']).default('0.1.1').describe('Apache Ossie revision: 0.1.1 (released, default) or 0.2.0.dev0 (in development)'),
});

export const PlatformListQuery = z.object({
  ...page,
  kind: z.string().max(100).optional(),
  environment: z.string().max(100).optional(),
});

export const DatasetRowsQuery = z.object({
  ...page,
  limit: z.number().int().min(1).max(1000).default(100).describe('Page size (1–1000, default 100)'),
  status: z.array(z.enum(DATASET_STATUSES)).max(QUERY_LIST_MAX).optional().describe('Only rows with these statuses (repeat the parameter)'),
});

export const MetricsQuery = z.object({
  names: z.array(z.string().max(200)).max(QUERY_LIST_MAX).optional().describe('Metric names (repeat the parameter); default all'),
  days: z.number().int().min(1).max(400).default(30).describe('History window in days (1–400, default 30)'),
  points: z.number().int().min(2).max(2000).default(200).describe('Maximum points per series (downsampled, default 200)'),
});

export const AuditListQuery = z.object({
  ...page,
  action: z.string().max(200).optional().describe('Action prefix, e.g. "run." or "platform.secrets_changed"'),
  actor: z.string().max(200).optional().describe('Exact user name (or "system")'),
  entityType: z.string().max(100).optional(),
  entityId: z.string().max(200).optional(),
  runId: z.string().max(200).optional(),
  q: z.string().max(200).optional().describe('Search in summary, actor and action'),
  from: ts().optional().describe('At or after this time (ISO 8601)'),
  to: ts().optional().describe('Before this time (ISO 8601)'),
});

export const UserListQuery = z.object({ ...page, active: z.boolean().optional() });

// ---------- conversion ----------

/** zod → JSON Schema (draft 2020-12, the dialect of OpenAPI 3.1). */
export function toJsonSchema(schema: ZodTypeAny, io: 'input' | 'output' = 'output'): JsonSchema {
  return zodJsonSchema(schema, io);
}

/** Shared schemas to register with `app.addSchema` (referenced as `<Name>#`). */
export function componentSchemas(): JsonSchema[] {
  return Object.entries(COMPONENTS).map(([name, schema]) => {
    const js = toJsonSchema(schema);
    return { $id: name, title: name, ...js, ...(EXAMPLES[name] ? { examples: [EXAMPLES[name]] } : {}) };
  });
}

export const ref = (name: keyof typeof COMPONENTS & string) => ({ $ref: `${name}#` });

/** Envelope of a paginated list. */
export function pageOf(name: keyof typeof COMPONENTS & string, description: string): JsonSchema {
  return {
    type: 'object',
    description,
    required: ['items', 'nextCursor'],
    properties: {
      items: { type: 'array', items: ref(name) },
      nextCursor: { type: ['string', 'null'], description: cursorDescription },
    },
    additionalProperties: false,
  };
}

/** Query-string schema: query parameters are optional, arrays come from repeated parameters. */
export function querySchema(schema: ZodTypeAny): JsonSchema {
  return toJsonSchema(schema, 'input');
}

/** Path parameters (all strings). */
export function pathParams(names: Record<string, string>): JsonSchema {
  return {
    type: 'object',
    required: Object.keys(names),
    properties: Object.fromEntries(Object.entries(names).map(([n, d]) => [n, { type: 'string', minLength: 1, maxLength: 200, description: d }])),
  };
}

export { API_DOCS_MODES };
