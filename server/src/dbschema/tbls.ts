import { z } from 'zod';
import { DB_SCHEMA_LIMITS, TBLS_LINT_RULES, type DbSchemaCheck, type DbSchemaDialect, type DbSchemaDoc } from '@sm/shared';
import { HttpError } from '../util.js';
import { buildDoc, type TableInput } from './model.js';

/**
 * The tbls import (#222): a `schema.json` written by tbls (https://github.com/k1LoW/tbls, MIT – `tbls out -t json`),
 * checked against the tbls JSON format (spec/tbls.schema.json_schema.json of tbls: the required fields and their
 * types; fields Steward does not use, such as viewpoints and functions, are left out), within the import limits, and
 * mapped to Steward's schema model. The output of `tbls lint` becomes checks named by their rule.
 *
 * tbls itself is not part of Steward: it runs where the database is (a CI job, a job in a separated network) and its
 * file is uploaded (POST /api/db-schemas/:kind/:id/import) or pushed from CI with a push token
 * (POST /api/hooks/db-schema/:kind/:id, push.ts).
 */

const L = DB_SCHEMA_LIMITS;
const str = (max: number) => z.string().max(max);
const names = z.array(str(L.nameChars)).max(L.columnsPerTable);

const column = z.object({
  name: str(L.nameChars),
  type: str(L.typeChars),
  nullable: z.boolean(),
  default: z.union([z.string().max(L.defaultChars), z.null()]).optional(),
  extra_def: z.string().max(L.defaultChars).optional(),
  comment: z.string().max(L.commentChars).optional(),
});
const index = z.object({
  name: str(L.nameChars),
  def: z.string().max(L.definitionChars),
  table: str(L.nameChars * 2 + 1),
  columns: names,
  comment: z.string().max(L.commentChars).optional(),
});
const constraint = z.object({
  name: str(L.nameChars),
  type: str(60),
  def: z.string().max(L.definitionChars),
  table: str(L.nameChars * 2 + 1),
  referenced_table: str(L.nameChars * 2 + 1).optional(),
  columns: names.optional(),
  referenced_columns: names.optional(),
  comment: z.string().max(L.commentChars).optional(),
});
const table = z.object({
  name: str(L.nameChars * 2 + 1),
  type: str(60),
  comment: z.string().max(L.commentChars).optional(),
  columns: z.array(column).max(L.columnsPerTable),
  indexes: z.array(index).max(L.indexesPerTable).optional(),
  constraints: z
    .array(constraint)
    .max(L.indexesPerTable + L.foreignKeysPerTable + 10)
    .optional(),
  def: z.string().max(200_000).optional(),
});
const relation = z.object({
  table: str(L.nameChars * 2 + 1),
  columns: names,
  parent_table: str(L.nameChars * 2 + 1),
  parent_columns: names,
  def: z.string().max(L.definitionChars),
  virtual: z.boolean().optional(),
});
/** The parts of the tbls format Steward reads; the others (functions, enums, labels, viewpoints) may be there. */
export const tblsSchema = z.object({
  name: z.string().max(L.nameChars).optional(),
  desc: z.string().max(L.commentChars).optional(),
  tables: z.array(table).max(L.tables),
  relations: z
    .array(relation)
    .max(L.tables * 20)
    .optional(),
  driver: z
    .object({
      name: z.string().max(60),
      database_version: z.string().max(200).optional(),
      meta: z.object({ current_schema: z.string().max(L.nameChars).optional() }).optional(),
    })
    .optional(),
});

const invalid = (message: string, params?: Record<string, string | number>) =>
  new HttpError(400, message, 'DB_SCHEMA_TBLS_INVALID', { problem: message, ...params });

/** The tbls driver (postgres, mysql, mssql, sqlite, …) as a dialect of Steward. */
export function tblsDialect(driver: string | undefined): DbSchemaDialect {
  const d = (driver ?? '').toLowerCase();
  if (d === 'postgres' || d === 'postgresql' || d === 'redshift') return 'postgresql';
  if (d === 'mysql' || d === 'mariadb') return 'mysql';
  if (d === 'mssql' || d === 'sqlserver') return 'sqlserver';
  if (d === 'sqlite' || d === 'sqlite3') return 'sqlite';
  return 'other';
}

/** "public.orders" → schema public, name orders; a bare name gets the default schema. */
function splitName(qualified: string, fallback: string | null): { schema: string | null; name: string } {
  const dot = qualified.indexOf('.');
  if (dot > 0 && dot < qualified.length - 1) return { schema: qualified.slice(0, dot), name: qualified.slice(dot + 1) };
  return { schema: fallback, name: qualified };
}

/** ON DELETE / ON UPDATE of a constraint definition ("… ON DELETE CASCADE"). */
function action(def: string, what: 'DELETE' | 'UPDATE'): string | null {
  const m = /\bON\s+(DELETE|UPDATE)\s+(CASCADE|RESTRICT|NO\s+ACTION|SET\s+NULL|SET\s+DEFAULT)/gi;
  for (const x of def.matchAll(m)) if (x[1]!.toUpperCase() === what) return x[2]!.toUpperCase().replace(/\s+/g, ' ');
  return null;
}

/** The columns in the first brackets of a definition: "PRIMARY KEY (a, b)" → [a, b] (older tbls files have no columns field). */
function defColumns(def: string, after = 0): string[] {
  const open = def.indexOf('(', after);
  const close = open < 0 ? -1 : def.indexOf(')', open);
  if (open < 0 || close < 0) return [];
  return def
    .slice(open + 1, close)
    .split(',')
    .map((s) => s.trim().replace(/^["`[]|["`\]]$/g, ''))
    .filter(Boolean);
}

export interface TblsParsed {
  doc: DbSchemaDoc;
  warnings: string[];
}

/** Parses and checks a tbls schema.json (text). 400 DB_SCHEMA_TBLS_INVALID when it is not one; 413 when it is too big. */
export function parseTbls(text: string): TblsParsed {
  if (Buffer.byteLength(text, 'utf8') > L.importBytes)
    throw new HttpError(413, `The schema file is larger than ${L.importBytes / 1024 / 1024} MB`, 'DB_SCHEMA_TOO_LARGE', { limit: L.importBytes / 1024 / 1024 });
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (e) {
    throw invalid(`The file is not JSON: ${(e as Error).message.slice(0, 200)}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('The file is not a tbls schema (an object with "tables" is expected)');
  const r = tblsSchema.safeParse(raw);
  if (!r.success) {
    const first = r.error.issues[0]!;
    const path = first.path.join('.');
    const tooBig = first.code === 'too_big' && first.path.length <= 3;
    if (tooBig)
      throw new HttpError(413, `The schema is larger than Steward takes: ${path || 'the file'} – ${first.message}`, 'DB_SCHEMA_TOO_LARGE', {
        limit: L.tables,
        path,
      });
    throw invalid(`Not a tbls schema: ${path ? `${path}: ` : ''}${first.message}`, { path });
  }
  const s = r.data;
  const columns = s.tables.reduce((n, t) => n + t.columns.length, 0);
  if (columns > L.columns)
    throw new HttpError(413, `The schema has ${columns} columns – Steward takes at most ${L.columns}`, 'DB_SCHEMA_TOO_LARGE', {
      limit: L.columns,
      path: 'columns',
    });
  const dialect = tblsDialect(s.driver?.name);
  const fallback =
    dialect === 'mysql' ? (s.name ?? null) : (s.driver?.meta?.current_schema ?? (dialect === 'postgresql' ? 'public' : dialect === 'sqlserver' ? 'dbo' : null));
  const warnings: string[] = [];
  const tables = new Map<string, TableInput>();
  for (const t of s.tables) {
    const { schema, name } = splitName(t.name, fallback);
    const pk = t.constraints?.find((c) => c.type.toUpperCase() === 'PRIMARY KEY' || c.type.toUpperCase() === 'P');
    const pkColumns = pk ? (pk.columns?.length ? pk.columns : defColumns(pk.def)) : [];
    const fks = (t.constraints ?? [])
      .filter((c) => c.type.toUpperCase() === 'FOREIGN KEY' || c.type.toUpperCase() === 'F')
      .map((c) => {
        const ref = splitName(c.referenced_table ?? '', schema);
        const refAt = c.def.toUpperCase().indexOf('REFERENCES');
        return {
          name: c.name,
          columns: c.columns?.length ? c.columns : defColumns(c.def),
          refSchema: ref.schema,
          refTable: ref.name,
          refColumns: c.referenced_columns?.length ? c.referenced_columns : refAt >= 0 ? defColumns(c.def, refAt) : [],
          onDelete: action(c.def, 'DELETE'),
          onUpdate: action(c.def, 'UPDATE'),
        };
      })
      .filter((f) => f.refTable);
    const indexes = (t.indexes ?? []).map((i) => ({
      name: i.name,
      columns: i.columns,
      unique: /\bUNIQUE\b/i.test(i.def) || /\bPRIMARY\s+KEY\b/i.test(i.def),
      primary: (!!pk && i.name === pk.name) || /\bPRIMARY\s+KEY\b/i.test(i.def),
      definition: i.def || null,
    }));
    // unique constraints whose index the file does not list (MariaDB/MySQL and SQL Server list both)
    for (const c of t.constraints ?? []) {
      if (c.type.toUpperCase() !== 'UNIQUE' && c.type.toUpperCase() !== 'U') continue;
      const cols = c.columns?.length ? c.columns : defColumns(c.def);
      if (!indexes.some((i) => i.unique && i.columns.join(',') === cols.join(',')))
        indexes.push({ name: c.name, columns: cols, unique: true, primary: false, definition: c.def || null });
    }
    tables.set(`${schema ?? ''}\u0000${name}`, {
      schema,
      name,
      type: t.type.toLowerCase().replace(/^base table$/, 'table'),
      comment: t.comment ?? null,
      columns: t.columns.map((c) => ({
        name: c.name,
        type: c.type,
        nullable: c.nullable,
        default: c.default ?? (c.extra_def ? c.extra_def : null),
        comment: c.comment ?? null,
      })),
      primaryKey: pkColumns.length ? { name: pk!.name, columns: pkColumns } : null,
      foreignKeys: fks,
      indexes,
    });
  }
  // relations of databases whose tables carry no foreign key constraints (virtual relations are tbls' own additions)
  let fromRelations = 0;
  for (const rel of s.relations ?? []) {
    if (rel.virtual) continue;
    const child = splitName(rel.table, fallback);
    const parent = splitName(rel.parent_table, fallback);
    const t = tables.get(`${child.schema ?? ''}\u0000${child.name}`);
    if (!t) continue;
    const known = (t.foreignKeys ?? []).some(
      (f) =>
        (f.columns ?? []).join(',') === rel.columns.join(',') && f.refTable === parent.name && (f.refColumns ?? []).join(',') === rel.parent_columns.join(','),
    );
    if (known) continue;
    (t.foreignKeys ??= []).push({
      name: null,
      columns: rel.columns,
      refSchema: parent.schema,
      refTable: parent.name,
      refColumns: rel.parent_columns,
      onDelete: action(rel.def, 'DELETE'),
      onUpdate: action(rel.def, 'UPDATE'),
    });
    fromRelations++;
  }
  if (fromRelations) warnings.push(`${fromRelations} foreign key(s) taken from the relations of the file`);
  if (dialect === 'other') warnings.push(`tbls driver "${s.driver?.name ?? 'unknown'}": the SQL export is written in standard SQL`);
  const doc = buildDoc({
    dialect,
    product: s.driver?.name ?? null,
    serverVersion: s.driver?.database_version ?? null,
    database: s.name ?? null,
    tables: [...tables.values()],
  });
  if (doc.truncated) warnings.push('Some indexes or foreign keys beyond the limits were left out');
  return { doc, warnings };
}

// ---------- tbls lint ----------

/** The rule of a `tbls lint` message (config/lint.go of tbls); "tbls-lint" when the message is not known. */
export function lintRule(message: string): string {
  const m = message.trim();
  const exact: Record<string, (typeof TBLS_LINT_RULES)[number]> = {
    'table comment required.': 'requireTableComment',
    'column comment required.': 'requireColumnComment',
    'index comment required.': 'requireIndexComment',
    'constraint comment required.': 'requireConstraintComment',
    'trigger comment required.': 'requireTriggerComment',
    'table labels required.': 'requireTableLabels',
  };
  if (exact[m]) return exact[m];
  if (m.startsWith('unrelated (isolated) table exists.')) return 'unrelatedTable';
  if (m.startsWith('too many columns.')) return 'columnCount';
  if (m.startsWith("column '") && m.endsWith("' required.")) return 'requireColumns';
  if (m.startsWith('duplicate relations.')) return 'duplicateRelations';
  if (m.startsWith('foreign key columns do not have an index.')) return 'requireForeignKeyIndex';
  if (m.includes('BigQuery `key:value` style')) return 'labelStyleBigQuery';
  if (m.endsWith('is not included in any viewpoints.')) return 'requireViewpoints';
  return 'tbls-lint';
}

const lintItem = z.object({ rule: z.string().max(100).optional(), target: z.string().max(1000).optional(), message: z.string().max(2000) });

/**
 * The output of `tbls lint` ("target: message" per line, "N detected" at the end, ANSI colours) – or a JSON list of
 * { rule?, target, message } – as checks.
 */
export function parseTblsLint(text: string | undefined): DbSchemaCheck[] {
  if (!text?.trim()) return [];
  if (Buffer.byteLength(text, 'utf8') > L.lintBytes)
    throw new HttpError(413, `The lint output is larger than ${L.lintBytes / 1024 / 1024} MB`, 'DB_SCHEMA_TOO_LARGE', { limit: L.lintBytes / 1024 / 1024 });
  const trimmed = text.trim();
  const out: DbSchemaCheck[] = [];
  if (trimmed.startsWith('[')) {
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch (e) {
      throw invalid(`The lint results are not JSON: ${(e as Error).message.slice(0, 200)}`);
    }
    const r = z.array(lintItem).max(L.lintFindings).safeParse(raw);
    if (!r.success) throw invalid(`The lint results are not a list of { rule, target, message }: ${r.error.issues[0]!.message}`);
    for (const x of r.data) {
      const rule = x.rule && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(x.rule) ? x.rule : lintRule(x.message);
      out.push({ rule, target: x.target ?? '', message: x.message });
    }
    return out;
  }
  // eslint-disable-next-line no-control-regex -- the colour codes tbls writes around target and message
  const lines = text.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/);
  for (const line of lines) {
    const l = line.trim();
    if (!l || /^\d+ detected$/.test(l)) continue;
    if (out.length >= L.lintFindings) break;
    const at = l.indexOf(': ');
    const target = at > 0 ? l.slice(0, at) : '';
    const message = at > 0 ? l.slice(at + 2) : l;
    out.push({ rule: lintRule(message), target: target.slice(0, 1000), message: message.slice(0, 2000) });
  }
  return out;
}
