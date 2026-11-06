import crypto from 'node:crypto';
import {
  DB_SCHEMA_LIMITS,
  qualifiedTable,
  type DbSchemaCheck,
  type DbSchemaColumn,
  type DbSchemaDialect,
  type DbSchemaDoc,
  type DbSchemaForeignKey,
  type DbSchemaIndex,
  type DbSchemaKey,
  type DbSchemaTable,
} from '@sm/shared';

/**
 * The schema model of #222 (shared/src/dbschema.ts) as both sources build it: names, types and texts clipped to their
 * limits, tables sorted by schema and name (columns keep their position), indexes and foreign keys sorted, duplicates
 * dropped, and the table and column limits applied (a read keeps the first tables and is marked truncated).
 */

const L = DB_SCHEMA_LIMITS;

const clip = (v: unknown, max: number): string => {
  const s = typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
  // eslint-disable-next-line no-control-regex -- control characters (but tabs and line breaks) never belong in a name or type
  const clean = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return clean.length > max ? clean.slice(0, max) : clean;
};
const optText = (v: unknown, max: number): string | null => {
  if (v === null || v === undefined) return null;
  const s = clip(v, max);
  return s === '' ? null : s;
};
const names = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => clip(x, L.nameChars)).filter(Boolean) : []);

/** A table as the sources hand it over (loosely typed). */
export interface TableInput {
  schema?: string | null;
  name: string;
  type?: string | null;
  comment?: string | null;
  columns?: Partial<DbSchemaColumn>[];
  primaryKey?: Partial<DbSchemaKey> | null;
  foreignKeys?: Partial<DbSchemaForeignKey>[];
  indexes?: Partial<DbSchemaIndex>[];
}

export interface DocInput {
  dialect: DbSchemaDialect;
  product?: string | null;
  serverVersion?: string | null;
  database?: string | null;
  tables: TableInput[];
  truncated?: boolean;
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Builds a schema document within the limits. `truncated` is set when anything had to be left out. */
export function buildDoc(input: DocInput): DbSchemaDoc {
  let truncated = !!input.truncated;
  const seen = new Set<string>();
  const tables: DbSchemaTable[] = [];
  for (const t of input.tables) {
    const name = clip(t.name, L.nameChars);
    if (!name) continue;
    const schema = optText(t.schema, L.nameChars);
    const key = `${schema ?? ''}\u0000${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const colSeen = new Set<string>();
    let columns: DbSchemaColumn[] = [];
    for (const c of t.columns ?? []) {
      const cn = clip(c.name, L.nameChars);
      if (!cn || colSeen.has(cn)) continue;
      colSeen.add(cn);
      columns.push({
        name: cn,
        type: clip(c.type, L.typeChars) || 'unknown',
        nullable: c.nullable !== false,
        default: optText(c.default, L.defaultChars),
        comment: optText(c.comment, L.commentChars),
      });
    }
    if (columns.length > L.columnsPerTable) {
      columns = columns.slice(0, L.columnsPerTable);
      truncated = true;
    }
    const pkCols = names(t.primaryKey?.columns);
    let foreignKeys: DbSchemaForeignKey[] = (t.foreignKeys ?? [])
      .map((f) => ({
        name: optText(f.name, L.nameChars),
        columns: names(f.columns),
        refSchema: optText(f.refSchema, L.nameChars),
        refTable: clip(f.refTable, L.nameChars),
        refColumns: names(f.refColumns),
        onUpdate: optText(f.onUpdate, 40)?.toUpperCase() ?? null,
        onDelete: optText(f.onDelete, 40)?.toUpperCase() ?? null,
      }))
      .filter((f) => f.columns.length && f.refTable);
    const fkSeen = new Set<string>();
    foreignKeys = foreignKeys
      .filter((f) => {
        const k = fkSignature(f);
        if (fkSeen.has(k)) return false;
        fkSeen.add(k);
        return true;
      })
      .sort((a, b) => byText(a.name ?? '', b.name ?? '') || byText(fkSignature(a), fkSignature(b)));
    if (foreignKeys.length > L.foreignKeysPerTable) {
      foreignKeys = foreignKeys.slice(0, L.foreignKeysPerTable);
      truncated = true;
    }
    const ixSeen = new Set<string>();
    let indexes: DbSchemaIndex[] = (t.indexes ?? [])
      .map((i) => ({
        name: clip(i.name, L.nameChars),
        columns: names(i.columns),
        unique: !!i.unique || !!i.primary,
        primary: !!i.primary,
        definition: optText(i.definition, L.definitionChars),
      }))
      .filter((i) => i.name && !ixSeen.has(i.name) && ixSeen.add(i.name))
      .sort((a, b) => byText(a.name, b.name));
    if (indexes.length > L.indexesPerTable) {
      indexes = indexes.slice(0, L.indexesPerTable);
      truncated = true;
    }
    tables.push({
      schema,
      name,
      type: (clip(t.type, 40) || 'table').toLowerCase(),
      comment: optText(t.comment, L.commentChars),
      columns,
      primaryKey: pkCols.length ? { name: optText(t.primaryKey?.name, L.nameChars), columns: pkCols } : null,
      foreignKeys,
      indexes,
    });
  }
  tables.sort((a, b) => byText(a.schema ?? '', b.schema ?? '') || byText(a.name, b.name));
  let kept = tables;
  if (kept.length > L.tables) {
    kept = kept.slice(0, L.tables);
    truncated = true;
  }
  let total = 0;
  const within: DbSchemaTable[] = [];
  for (const t of kept) {
    if (total + t.columns.length > L.columns) {
      truncated = true;
      break;
    }
    total += t.columns.length;
    within.push(t);
  }
  return {
    format: 'steward-db-schema',
    version: 1,
    dialect: input.dialect,
    product: optText(input.product, 80),
    serverVersion: optText(input.serverVersion, 200),
    database: optText(input.database, L.nameChars),
    tables: within,
    truncated,
  };
}

/** Columns → referenced table (columns): the same foreign key whatever it is called. */
export const fkSignature = (f: Pick<DbSchemaForeignKey, 'columns' | 'refSchema' | 'refTable' | 'refColumns'>): string =>
  `(${f.columns.join(',')})>${f.refSchema ? `${f.refSchema}.` : ''}${f.refTable}(${f.refColumns.join(',')})`;

export const columnCount = (d: DbSchemaDoc): number => d.tables.reduce((n, t) => n + t.columns.length, 0);

/**
 * What decides whether two snapshots hold the same schema: the tables (and whether they were cut) and the checks,
 * not the server version or the time of the read.
 */
export function contentHash(d: DbSchemaDoc, checks: DbSchemaCheck[]): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ tables: d.tables, truncated: d.truncated, dialect: d.dialect }))
    .update('\n')
    .update(JSON.stringify(checks))
    .digest('hex');
}

export { qualifiedTable };
