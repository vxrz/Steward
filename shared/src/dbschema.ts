import { z } from 'zod';

/**
 * Database schemas (0.8.0, #222, docs/DATABASES.md#database-schemas): the structure of a database – schemas, tables,
 * views, columns, keys, indexes, comments – as Steward reads it from a database platform (the catalog read of #203) or
 * imports it from a tbls `schema.json` (https://github.com/k1LoW/tbls) for a database platform or a system. Every read
 * or import is a snapshot; consecutive snapshots are compared (added, removed and changed tables and columns, breaking
 * or not). Exported as DBML, SQL DDL for the source dialect, or this model as JSON.
 */

/** What a schema belongs to: a database platform, or a system of the service catalogue that has no platform. */
export const DB_SCHEMA_SUBJECTS = ['platform', 'system'] as const;
export type DbSchemaSubjectKind = (typeof DB_SCHEMA_SUBJECTS)[number];

/** Where a snapshot came from: Steward's own read of a database platform, or an imported tbls schema.json. */
export const DB_SCHEMA_SOURCES = ['read', 'tbls'] as const;
export type DbSchemaSource = (typeof DB_SCHEMA_SOURCES)[number];

/** The SQL dialect of a schema (DDL export). tbls knows more databases: they export as standard SQL ("other"). */
export const DB_SCHEMA_DIALECTS = ['postgresql', 'mysql', 'sqlserver', 'sqlite', 'other'] as const;
export type DbSchemaDialect = (typeof DB_SCHEMA_DIALECTS)[number];

export const DB_SCHEMA_EXPORT_FORMATS = ['dbml', 'sql', 'json'] as const;
export type DbSchemaExportFormat = (typeof DB_SCHEMA_EXPORT_FORMATS)[number];

export const DB_SCHEMA_LIMITS = {
  /** Tables and views of one schema (a read keeps the first ones and marks the snapshot truncated; an import is refused) */
  tables: 2_000,
  /** Columns of all tables together */
  columns: 50_000,
  columnsPerTable: 1_000,
  indexesPerTable: 200,
  foreignKeysPerTable: 200,
  /** Characters of a name, a data type, a default expression, a comment, an index definition */
  nameChars: 256,
  typeChars: 256,
  defaultChars: 2_000,
  commentChars: 4_000,
  definitionChars: 4_000,
  /** A tbls schema.json (bytes), like an SBOM */
  importBytes: 10 * 1024 * 1024,
  /** The output of `tbls lint` (bytes) and the findings kept */
  lintBytes: 1024 * 1024,
  lintFindings: 5_000,
  /** Snapshots kept per database (the newest ones) */
  retention: { default: 30, max: 500 },
  /** Scheduled reads of a database platform, in hours (0: off) */
  readIntervalHours: { max: 720 },
  /** A whole read, all statements together (seconds) */
  readSeconds: 180,
  /** Changes stored per snapshot (more are counted, not listed) */
  changes: 5_000,
} as const;

export interface DbSchemaColumn {
  name: string;
  /** The data type as the database writes it: varchar(120), numeric(10,2), timestamp with time zone … */
  type: string;
  nullable: boolean;
  /** The default expression (or identity / generated), as text */
  default: string | null;
  comment: string | null;
}

export interface DbSchemaKey {
  name: string | null;
  columns: string[];
}

export interface DbSchemaForeignKey extends DbSchemaKey {
  refSchema: string | null;
  refTable: string;
  refColumns: string[];
  onUpdate: string | null;
  onDelete: string | null;
}

export interface DbSchemaIndex {
  name: string;
  columns: string[];
  unique: boolean;
  /** The index of the primary key */
  primary: boolean;
  /** The definition as the database writes it (CREATE INDEX …), when known */
  definition: string | null;
}

export interface DbSchemaTable {
  /** The schema (PostgreSQL, SQL Server) or database (MariaDB/MySQL); null when the source has none */
  schema: string | null;
  name: string;
  /** table, view, materialized view, foreign table … */
  type: string;
  comment: string | null;
  columns: DbSchemaColumn[];
  primaryKey: DbSchemaKey | null;
  foreignKeys: DbSchemaForeignKey[];
  indexes: DbSchemaIndex[];
}

/** The schema of a database, the same model for both sources. Exported as JSON as it is. */
export interface DbSchemaDoc {
  format: 'steward-db-schema';
  version: 1;
  dialect: DbSchemaDialect;
  /** PostgreSQL, MariaDB, MySQL, SQL Server, or the tbls driver name */
  product: string | null;
  serverVersion: string | null;
  database: string | null;
  tables: DbSchemaTable[];
  /** More tables or columns than DB_SCHEMA_LIMITS: the first ones are kept */
  truncated: boolean;
}

/** A finding of `tbls lint`, with its rule name (requireColumnComment …; tbls-lint when the message is not known). */
export interface DbSchemaCheck {
  rule: string;
  target: string;
  message: string;
}

/** The rules of `tbls lint` (config/lint.go of tbls). */
export const TBLS_LINT_RULES = [
  'requireTableComment',
  'requireColumnComment',
  'requireIndexComment',
  'requireConstraintComment',
  'requireTriggerComment',
  'requireTableLabels',
  'unrelatedTable',
  'columnCount',
  'requireColumns',
  'duplicateRelations',
  'requireForeignKeyIndex',
  'labelStyleBigQuery',
  'requireViewpoints',
] as const;

// ---------- changes ----------

export const DB_SCHEMA_CHANGE_KINDS = [
  'table-added',
  'table-removed',
  'table-type',
  'column-added',
  'column-removed',
  'column-type',
  'column-nullable',
  'column-default',
  'primary-key-added',
  'primary-key-removed',
  'primary-key-changed',
  'foreign-key-added',
  'foreign-key-removed',
  'unique-added',
  'unique-removed',
  'index-added',
  'index-removed',
] as const;
export type DbSchemaChangeKind = (typeof DB_SCHEMA_CHANGE_KINDS)[number];

/** Why a change is breaking (docs/DATABASES.md#changes-between-snapshots). */
export const DB_SCHEMA_BREAKING_REASONS = ['tableRemoved', 'columnRemoved', 'typeNarrowed', 'typeChanged', 'notNullWithoutDefault', 'keyRemoved'] as const;
export type DbSchemaBreakingReason = (typeof DB_SCHEMA_BREAKING_REASONS)[number];

export interface DbSchemaChange {
  kind: DbSchemaChangeKind;
  /** The table, with its schema: public.orders */
  table: string;
  column?: string;
  /** The key or index */
  name?: string;
  before?: string | null;
  after?: string | null;
  breaking: boolean;
  reason?: DbSchemaBreakingReason;
}

export interface DbSchemaDiff {
  changes: DbSchemaChange[];
  /** All changes and the breaking ones (also beyond the changes listed) */
  total: number;
  breaking: number;
  /** A snapshot was truncated: removed tables and columns cannot be told from the ones left out, and are not listed */
  incomplete: boolean;
}

// ---------- API ----------

export interface DbSchemaSettings {
  /** Snapshots kept (the newest) */
  retention: number;
  /** Read the database platform every N hours (0: off) */
  readIntervalHours: number;
}

export const dbSchemaSettingsInput = z
  .object({
    retention: z.number().int().min(1).max(DB_SCHEMA_LIMITS.retention.max),
    readIntervalHours: z.number().int().min(0).max(DB_SCHEMA_LIMITS.readIntervalHours.max),
  })
  .strict();

/** An upload of the web app: the schema.json as text (its SHA-256 is recorded), optionally the output of tbls lint. */
export const dbSchemaImportInput = z
  .object({
    schema: z.string().min(1).max(DB_SCHEMA_LIMITS.importBytes),
    lint: z.string().max(DB_SCHEMA_LIMITS.lintBytes).optional(),
    fileName: z.string().trim().max(255).optional(),
  })
  .strict();
export type DbSchemaImportInput = z.infer<typeof dbSchemaImportInput>;

export interface DbSchemaSnapshotSummary {
  id: string;
  source: DbSchemaSource;
  takenAt: string;
  /** The last read or import that found the same schema */
  checkedAt: string;
  actor: string;
  /** ui, api, job, monitor */
  via: string;
  dialect: DbSchemaDialect;
  product: string | null;
  serverVersion: string | null;
  database: string | null;
  tables: number;
  columns: number;
  truncated: boolean;
  /** SHA-256 of the imported file (tbls) */
  sha256: string | null;
  fileName: string | null;
  checks: number;
  changes: number;
  breaking: number;
  previousId: string | null;
}

export interface DbSchemaSnapshot extends DbSchemaSnapshotSummary {
  schema: DbSchemaDoc;
  lint: DbSchemaCheck[];
  /** The changes against the snapshot before (null for the first one) */
  diff: DbSchemaDiff | null;
}

export interface DbSchemaOverview {
  subject: { kind: DbSchemaSubjectKind; id: string; name: string };
  settings: DbSchemaSettings;
  /** Read the database now (database platforms; the platform's "use" right) */
  canRead: boolean;
  /** Import a tbls schema.json and change the settings (the platform's "manage" right, or who may change the system) */
  canImport: boolean;
  /** Imports are refused: the system is a Steward platform (its schema belongs there) */
  importBlocked: 'systemIsPlatform' | null;
  lastRead: { at: string; error: string | null } | null;
  snapshots: DbSchemaSnapshotSummary[];
}

/** What an import would change (the preview of the web app). */
export interface DbSchemaImportPreview {
  sha256: string;
  tables: number;
  columns: number;
  checks: number;
  /** Same schema and checks as the latest snapshot: the import adds none */
  unchanged: boolean;
  diff: DbSchemaDiff | null;
  warnings: string[];
}

export const qualifiedTable = (t: Pick<DbSchemaTable, 'schema' | 'name'>): string => (t.schema ? `${t.schema}.${t.name}` : t.name);

// ---------- push tokens (tbls from CI) ----------

/**
 * A push token (#222): bound to one database platform or system, it can do nothing but push a tbls schema.json (and
 * the output of tbls lint) for it – POST /api/hooks/db-schema/<kind>/<id> with "Authorization: Bearer sdbp_…". Stored
 * as a SHA-256 hash only; the secret is shown once, when it is created or rotated.
 */
export const DB_SCHEMA_PUSH_TOKEN_PREFIX = 'sdbp_';
export const DB_SCHEMA_PUSH_LIMITS = {
  tokensPerTarget: 20,
  nameChars: 100,
  cidrs: 20,
  expiresInDays: 730,
  rateLimitPerMinute: { default: 10, max: 120 },
} as const;

export interface DbSchemaPushToken {
  id: string;
  name: string;
  /** The first characters of the secret, to tell tokens apart */
  prefix: string;
  allowedCidrs: string[];
  rateLimitPerMinute: number;
  expiresAt: string | null;
  createdAt: string;
  createdBy: string;
  rotatedAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  /** expired: past expiresAt */
  expired: boolean;
}

/** A token as it is created or rotated: with its secret, this once. */
export interface DbSchemaPushTokenCreated extends DbSchemaPushToken {
  token: string;
  /** The path to push to (below the server's base path) */
  path: string;
}

export const dbSchemaPushTokenInput = z
  .object({
    name: z.string().trim().min(1).max(DB_SCHEMA_PUSH_LIMITS.nameChars),
    expiresInDays: z.number().int().min(1).max(DB_SCHEMA_PUSH_LIMITS.expiresInDays).optional(),
    allowedCidrs: z.array(z.string().trim().min(1).max(64)).max(DB_SCHEMA_PUSH_LIMITS.cidrs).default([]),
    rateLimitPerMinute: z.number().int().min(1).max(DB_SCHEMA_PUSH_LIMITS.rateLimitPerMinute.max).default(DB_SCHEMA_PUSH_LIMITS.rateLimitPerMinute.default),
  })
  .strict();
export type DbSchemaPushTokenInput = z.input<typeof dbSchemaPushTokenInput>;

export const dbSchemaPushPath = (kind: DbSchemaSubjectKind, id: string): string => `/api/hooks/db-schema/${kind}/${encodeURIComponent(id)}`;
