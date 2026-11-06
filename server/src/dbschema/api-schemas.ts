import { z, type ZodTypeAny } from 'zod';
import { DB_SCHEMA_BREAKING_REASONS, DB_SCHEMA_CHANGE_KINDS, DB_SCHEMA_DIALECTS, DB_SCHEMA_EXPORT_FORMATS, DB_SCHEMA_SOURCES } from '@sm/shared';

/** Response and query schemas of database schemas in the public API (/api/v1/…/schema, #222). */

const ts = () => z.string().datetime({ offset: true }).describe('ISO 8601 timestamp (UTC)');
const limit = z.number().int().min(1).max(200).default(50).describe('Page size (1–200, default 50)');
const cursor = z.string().max(2000).optional().describe('Cursor from the previous page (`nextCursor`)');

export const DbSchemaSnapshot = z.object({
  id: z.string(),
  source: z.enum(DB_SCHEMA_SOURCES).describe('read: Steward read the database platform; tbls: an imported tbls schema.json'),
  takenAt: ts(),
  checkedAt: ts().describe('The last read or import that found the same schema'),
  actor: z.string().describe('Who read or imported it (system for scheduled reads)'),
  via: z.string().describe('ui, api, job or monitor'),
  dialect: z.enum(DB_SCHEMA_DIALECTS),
  product: z.string().nullable(),
  serverVersion: z.string().nullable(),
  database: z.string().nullable(),
  tables: z.number().int(),
  columns: z.number().int(),
  truncated: z.boolean().describe('More tables or columns than Steward keeps: the first ones are in the snapshot'),
  sha256: z.string().nullable().describe('SHA-256 of the imported file (tbls)'),
  fileName: z.string().nullable(),
  checks: z.number().int().describe('Findings of tbls lint'),
  changes: z.number().int().describe('Changes against the snapshot before'),
  breaking: z.number().int().describe('Breaking changes among them'),
  previousId: z.string().nullable(),
});

const Column = z.object({
  name: z.string(),
  type: z.string(),
  nullable: z.boolean(),
  default: z.string().nullable(),
  comment: z.string().nullable(),
});
const Key = z.object({ name: z.string().nullable(), columns: z.array(z.string()) });
const ForeignKey = Key.extend({
  refSchema: z.string().nullable(),
  refTable: z.string(),
  refColumns: z.array(z.string()),
  onUpdate: z.string().nullable(),
  onDelete: z.string().nullable(),
});
const Index = z.object({ name: z.string(), columns: z.array(z.string()), unique: z.boolean(), primary: z.boolean(), definition: z.string().nullable() });
const Table = z.object({
  schema: z.string().nullable(),
  name: z.string(),
  type: z.string().describe('table, view, materialized view, foreign table …'),
  comment: z.string().nullable(),
  columns: z.array(Column),
  primaryKey: Key.nullable(),
  foreignKeys: z.array(ForeignKey),
  indexes: z.array(Index),
});
export const DbSchemaDocument = z.object({
  format: z.literal('steward-db-schema'),
  version: z.literal(1),
  dialect: z.enum(DB_SCHEMA_DIALECTS),
  product: z.string().nullable(),
  serverVersion: z.string().nullable(),
  database: z.string().nullable(),
  tables: z.array(Table),
  truncated: z.boolean(),
});

const Change = z.object({
  kind: z.enum(DB_SCHEMA_CHANGE_KINDS),
  table: z.string().describe('The table with its schema'),
  column: z.string().optional(),
  name: z.string().optional().describe('The key or index'),
  before: z.string().nullable().optional(),
  after: z.string().nullable().optional(),
  breaking: z.boolean(),
  reason: z.enum(DB_SCHEMA_BREAKING_REASONS).optional(),
});
export const DbSchemaDiff = z.object({
  changes: z.array(Change),
  total: z.number().int().describe('All changes (more than listed when there are very many)'),
  breaking: z.number().int(),
  incomplete: z.boolean().describe('A snapshot was truncated: removals are not listed'),
});

export const DbSchemaSnapshotDetail = DbSchemaSnapshot.extend({
  schema: DbSchemaDocument,
  lint: z.array(z.object({ rule: z.string(), target: z.string(), message: z.string() })).describe('Findings of tbls lint, named by their rule'),
  diff: DbSchemaDiff.nullable().describe('The changes against the snapshot before (null for the first one)'),
});

export const DbSchemaChangeSet = z.object({
  snapshot: DbSchemaSnapshot,
  diff: DbSchemaDiff,
});
export const DbSchemaComparison = DbSchemaDiff.extend({ from: z.string(), to: z.string() });

export const DB_SCHEMA_COMPONENTS: Record<string, ZodTypeAny> = {
  DbSchemaSnapshot,
  DbSchemaSnapshotDetail,
  DbSchemaDocument,
  DbSchemaDiff,
  DbSchemaChangeSet,
  DbSchemaComparison,
};

export const DbSchemaSnapshotListQuery = z.object({ limit, cursor });
export const DbSchemaChangeListQuery = z.object({
  limit,
  cursor,
  since: ts().optional().describe('Snapshots taken at or after this time'),
  breaking: z.boolean().optional().describe('Only snapshots with breaking changes'),
});
export const DbSchemaCompareQuery = z.object({
  from: z.string().min(1).max(100).describe('A snapshot id (usually the older one)'),
  to: z.string().min(1).max(100).describe('Another snapshot id of the same database'),
});
export const DbSchemaExportQuery = z.object({
  format: z.enum(DB_SCHEMA_EXPORT_FORMATS).default('json').describe('dbml, sql (DDL of the source dialect) or json'),
});
