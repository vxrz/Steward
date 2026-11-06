import { qualifiedTable, type DbSchemaDialect, type DbSchemaDoc, type DbSchemaExportFormat, type DbSchemaSource, type DbSchemaTable } from '@sm/shared';

/**
 * Exports of a schema snapshot (#222): DBML (https://dbml.dbdiagram.io/docs – written here, no library), SQL DDL in
 * the dialect of the source (standard SQL for databases Steward does not speak), and Steward's schema model as JSON.
 * The files open in dbdiagram, drawDB, ChartDB or Azimutt; Steward bundles none of them.
 *
 * The output is text for people and their tools, and the DDL is meant to be run elsewhere – while everything in it
 * comes from the database or a tbls file that anyone with a CREATE right or a push token wrote. So nothing from the
 * snapshot can end a statement or a comment:
 * - every comment (`--`, `//`) is one line (`oneLine`);
 * - names are quoted for the dialect (PostgreSQL and standard SQL "…" with "", MariaDB/MySQL `…` with ``, SQL
 *   Server […] with ]]) and are single-line already (model.ts writes their line breaks as ␊);
 * - texts are string literals of the dialect, on one line (MariaDB/MySQL also escape \, PostgreSQL uses E'…' for a
 *   text with a \ – safe whatever standard_conforming_strings says);
 * - a data type, a default or an identity clause is written only when it passes a strict allow-list
 *   (`safeType`, `safeExpression`), otherwise as a one-line comment above the table;
 * - an index definition is copied only from Steward's own read of PostgreSQL (pg_get_indexdef), never from a tbls
 *   file.
 */

/** Line breaks and other control characters (C0, C1, the Unicode line and paragraph separators) as one space. */
// eslint-disable-next-line no-control-regex -- the point is to find control characters
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029]+/g;
export const oneLine = (s: string): string => s.replace(CONTROL, ' ');
// eslint-disable-next-line no-control-regex -- the point is to find control characters
const HAS_CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029]/;

// ---------- DBML ----------

/** A DBML name in double quotes ("public"."orders"). */
const dq = (s: string) => `"${oneLine(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
/** A DBML string in single quotes, on one line. */
const sq = (s: string) => `'${oneLine(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const dbmlTable = (t: Pick<DbSchemaTable, 'schema' | 'name'>) => (t.schema ? `${dq(t.schema)}.${dq(t.name)}` : dq(t.name));
/** A column type DBML takes as it is (varchar(120), numeric(10,2)); others in double quotes. */
const dbmlType = (type: string) => (/^[A-Za-z_][A-Za-z0-9_]*(\(\s*\d+\s*(,\s*\d+\s*)?\))?$/.test(type) ? type : dq(type));
/** A default: numbers and booleans as they are, everything else as an expression in backticks. */
function dbmlDefault(v: string): string {
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  if (/^(true|false|null)$/i.test(v)) return v.toLowerCase();
  return `\`${oneLine(v).replace(/`/g, "'")}\``;
}
const ACTIONS = new Set(['CASCADE', 'RESTRICT', 'SET NULL', 'SET DEFAULT', 'NO ACTION']);
const dbmlAction = (a: string | null) => (a && ACTIONS.has(a) ? a.toLowerCase() : null);
const DB_TYPE: Record<DbSchemaDialect, string> = { postgresql: 'PostgreSQL', mysql: 'MySQL', sqlserver: 'SQL Server', sqlite: 'SQLite', other: 'Generic' };

/** "shop (PostgreSQL 16.4)" for the first comment line of a file. */
const titleOf = (d: DbSchemaDoc) => oneLine(`${d.database ?? 'Database'}${d.product ? ` (${d.product}${d.serverVersion ? ` ${d.serverVersion}` : ''})` : ''}`);

export function toDbml(d: DbSchemaDoc): string {
  const out: string[] = [];
  out.push(`// ${titleOf(d)} – exported by Steward`);
  if (d.truncated) out.push('// The snapshot is truncated: it holds the first tables and columns only');
  out.push(`Project ${dq(d.database ?? 'database')} {`, `  database_type: ${sq(DB_TYPE[d.dialect])}`, '}', '');
  const refs: string[] = [];
  for (const t of d.tables) {
    out.push(`Table ${dbmlTable(t)}${t.type !== 'table' ? ` [note: ${sq(t.type)}]` : ''} {`);
    const pk = t.primaryKey?.columns ?? [];
    const singleUnique = new Set(t.indexes.filter((i) => i.unique && !i.primary && i.columns.length === 1).map((i) => i.columns[0]!));
    for (const c of t.columns) {
      const settings: string[] = [];
      if (pk.length === 1 && pk[0] === c.name) settings.push('pk');
      if (!c.nullable) settings.push('not null');
      if (singleUnique.has(c.name)) settings.push('unique');
      if (c.default !== null) settings.push(`default: ${dbmlDefault(c.default)}`);
      if (c.comment) settings.push(`note: ${sq(c.comment)}`);
      out.push(`  ${dq(c.name)} ${dbmlType(c.type)}${settings.length ? ` [${settings.join(', ')}]` : ''}`);
    }
    const idx: string[] = [];
    if (pk.length > 1) idx.push(`    (${pk.map(dq).join(', ')}) [pk]`);
    for (const i of t.indexes) {
      if (i.primary || !i.columns.length || (i.unique && i.columns.length === 1)) continue;
      const cols = i.columns.length === 1 ? dq(i.columns[0]!) : `(${i.columns.map(dq).join(', ')})`;
      idx.push(`    ${cols} [name: ${sq(i.name)}${i.unique ? ', unique' : ''}]`);
    }
    if (idx.length) out.push('', '  indexes {', ...idx, '  }');
    if (t.comment) out.push('', `  Note: ${sq(t.comment)}`);
    out.push('}', '');
    for (const f of t.foreignKeys) {
      const ref = { schema: f.refSchema, name: f.refTable };
      const from = f.columns.length === 1 ? `${dbmlTable(t)}.${dq(f.columns[0]!)}` : `${dbmlTable(t)}.(${f.columns.map(dq).join(', ')})`;
      const to = f.refColumns.length === 1 ? `${dbmlTable(ref)}.${dq(f.refColumns[0]!)}` : `${dbmlTable(ref)}.(${f.refColumns.map(dq).join(', ')})`;
      const settings = [dbmlAction(f.onDelete) && `delete: ${dbmlAction(f.onDelete)}`, dbmlAction(f.onUpdate) && `update: ${dbmlAction(f.onUpdate)}`].filter(
        Boolean,
      );
      const name = f.name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(f.name) ? ` ${f.name}` : '';
      refs.push(`Ref${name}: ${from} > ${to}${settings.length ? ` [${settings.join(', ')}]` : ''}`);
    }
  }
  if (refs.length) out.push(...refs, '');
  return out.join('\n');
}

// ---------- SQL DDL ----------

type DdlDialect = 'postgresql' | 'mysql' | 'sqlserver' | 'standard';
const ddlDialect = (d: DbSchemaDialect): DdlDialect => (d === 'postgresql' || d === 'mysql' || d === 'sqlserver' ? d : 'standard');

/** A quoted identifier of the dialect (the closing quote doubled inside). Exported for the unit tests. */
export const quoteFor = (d: DdlDialect) =>
  d === 'mysql'
    ? (s: string) => `\`${s.replace(/`/g, '``')}\``
    : d === 'sqlserver'
      ? (s: string) => `[${s.replace(/]/g, ']]')}]`
      : (s: string) => `"${s.replace(/"/g, '""')}"`;

/**
 * A string literal of the dialect, on one line. MariaDB/MySQL read \ as an escape (unless NO_BACKSLASH_ESCAPES): it is
 * doubled too. PostgreSQL reads \ as an escape when standard_conforming_strings is off: a text with a \ is written as
 * E'…', which escapes it under either setting. Exported for the unit tests.
 */
export function literalFor(d: DdlDialect): (s: string) => string {
  const quoted = (s: string) => oneLine(s).replace(/'/g, "''");
  if (d === 'mysql') return (s) => `'${quoted(s).replace(/\\/g, '\\\\')}'`;
  if (d === 'postgresql') return (s) => (s.includes('\\') ? `E'${quoted(s).replace(/\\/g, '\\\\')}'` : `'${quoted(s)}'`);
  return (s) => `'${quoted(s)}'`;
}

/** A name in a type: a plain identifier or one in double quotes without anything but letters, digits, _ and spaces. */
const TYPE_WORD = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*|"[A-Za-z_][A-Za-z0-9_ ]*")`;
const TYPE_NAME = String.raw`${TYPE_WORD}(?:\.${TYPE_WORD})?`;
/** An argument: a whole number, a name (max, Point) or a string literal without \ or control characters (enum('a','b')). */
const TYPE_ARG = String.raw`(?:-?\d+|[A-Za-z_][A-Za-z0-9_]*|'(?:[^'\\\u0000-\u001f\u007f]|'')*')`;
const TYPE_RE = new RegExp(String.raw`^${TYPE_NAME}(?: ${TYPE_NAME})*(?: ?\( ?${TYPE_ARG}(?: ?, ?${TYPE_ARG})* ?\))?(?: ${TYPE_NAME})*(?:\[\d*\])*$`);
/**
 * Whether a data type can be written as it is: names separated by single spaces, optionally qualified, with at most
 * one list of arguments and array brackets – varchar(120), numeric(10,2), timestamp(3) with time zone, integer[],
 * enum('a','b'), nvarchar(max), public.citext. Nothing that could end the column or the statement.
 */
export const safeType = (type: string): boolean => type.length <= 256 && TYPE_RE.test(type);

/**
 * Whether a default (or identity, generated) expression can be written as it is: one line, the quotes of the dialect
 * ('…' and "…", MariaDB/MySQL also `…`, SQL Server also […]) and the brackets balanced, and outside quotes no ; (the
 * end of a statement), no comment (-- /* and MariaDB/MySQL's #), no dollar quoting ($) – and no backslash anywhere
 * (E'…' and MariaDB/MySQL strings read it as an escape, which would end a quote elsewhere than counted here).
 */
export function safeExpression(v: string, d: DdlDialect): boolean {
  if (!v || v.length > 2000 || HAS_CONTROL.test(v) || v.includes('\\')) return false;
  let depth = 0;
  for (let i = 0; i < v.length; i++) {
    const ch = v[i]!;
    const close = ch === "'" || ch === '"' || (ch === '`' && d === 'mysql') ? ch : ch === '[' && d === 'sqlserver' ? ']' : null;
    if (close) {
      // to the closing quote; a doubled one is part of the text
      let j = i + 1;
      for (;;) {
        if (j >= v.length) return false;
        if (v[j] === close) {
          if (v[j + 1] === close) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      i = j;
      continue;
    }
    if (ch === ';' || ch === '$' || (ch === '#' && d === 'mysql')) return false;
    if ((ch === '-' && v[i + 1] === '-') || (ch === '/' && v[i + 1] === '*')) return false;
    if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

/** Identity and generated columns are written as they are, other defaults after DEFAULT. */
const isClause = (v: string) => /^(GENERATED\s|AUTO_INCREMENT$|IDENTITY\b)/i.test(v);

export interface DdlOptions {
  /**
   * The index definitions (CREATE INDEX …) are the database's own: Steward read them from PostgreSQL
   * (pg_get_indexdef). Only then is an expression index written from its definition.
   */
  ownIndexDefinitions?: boolean;
}

export function toDdl(d: DbSchemaDoc, opts: DdlOptions = {}): string {
  const dialect = ddlDialect(d.dialect);
  const q = quoteFor(dialect);
  const lit = literalFor(dialect);
  const name = (schema: string | null, n: string) => (schema ? `${q(schema)}.${q(n)}` : q(n));
  const label = dialect === 'standard' ? `standard SQL (source: ${oneLine(d.product ?? d.dialect)})` : DB_TYPE[d.dialect];
  const out: string[] = [`-- ${titleOf(d)} – exported by Steward`, `-- Dialect: ${label}`];
  if (d.truncated) out.push('-- The snapshot is truncated: it holds the first tables and columns only');
  out.push('');
  const after: string[] = [];
  const ownDefinitions = !!opts.ownIndexDefinitions && dialect === 'postgresql';
  for (const t of d.tables) {
    const tn = name(t.schema, t.name);
    const label = oneLine(qualifiedTable(t));
    if (t.type !== 'table') {
      out.push(
        `-- ${oneLine(t.type)} ${label}: the definition is not part of the snapshot`,
        oneLine(`--   columns: ${t.columns.map((c) => `${c.name} ${c.type}`).join(', ')}`),
        '',
      );
      continue;
    }
    // what cannot be written as it is: one comment line each, above the table
    const notes: string[] = [];
    const lines: string[] = [];
    for (const c of t.columns) {
      if (!safeType(c.type)) {
        notes.push(oneLine(`-- column ${label}.${c.name} left out: its type is not a plain type name: ${c.type}`));
        continue;
      }
      const parts = [`  ${q(c.name)} ${c.type}`];
      if (!c.nullable) parts.push('NOT NULL');
      if (c.default !== null) {
        if (safeExpression(c.default, dialect)) parts.push(isClause(c.default) ? c.default : `DEFAULT ${c.default}`);
        else notes.push(oneLine(`-- default of ${label}.${c.name} left out: it is not a plain expression: ${c.default}`));
      }
      if (c.comment && dialect === 'mysql') parts.push(`COMMENT ${lit(c.comment)}`);
      lines.push(parts.join(' '));
    }
    if (t.primaryKey) lines.push(`  ${t.primaryKey.name ? `CONSTRAINT ${q(t.primaryKey.name)} ` : ''}PRIMARY KEY (${t.primaryKey.columns.map(q).join(', ')})`);
    if (t.comment && dialect !== 'mysql' && dialect !== 'postgresql') out.push(`-- ${oneLine(t.comment)}`);
    out.push(...notes, `CREATE TABLE ${tn} (`, lines.join(',\n'), `)${t.comment && dialect === 'mysql' ? ` COMMENT=${lit(t.comment)}` : ''};`);
    if (dialect === 'postgresql') {
      if (t.comment) out.push(`COMMENT ON TABLE ${tn} IS ${lit(t.comment)};`);
      for (const c of t.columns) if (c.comment) out.push(`COMMENT ON COLUMN ${tn}.${q(c.name)} IS ${lit(c.comment)};`);
    } else if (dialect !== 'mysql') {
      for (const c of t.columns) if (c.comment) out.push(oneLine(`-- ${t.name}.${c.name}: ${c.comment}`));
    }
    for (const i of t.indexes) {
      if (i.primary) continue;
      if (i.columns.length) {
        out.push(`CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${q(i.name)} ON ${tn} (${i.columns.map(q).join(', ')});`);
      } else if (
        ownDefinitions &&
        i.definition &&
        /^CREATE (UNIQUE )?INDEX /.test(i.definition) &&
        !HAS_CONTROL.test(i.definition) &&
        !i.definition.includes(';')
      )
        out.push(`${i.definition};`);
      else out.push(oneLine(`-- index ${i.name}: an expression index without its definition`));
    }
    out.push('');
    for (const f of t.foreignKeys) {
      const acts = [
        f.onDelete && ACTIONS.has(f.onDelete) ? ` ON DELETE ${f.onDelete}` : '',
        f.onUpdate && ACTIONS.has(f.onUpdate) ? ` ON UPDATE ${f.onUpdate}` : '',
      ].join('');
      after.push(
        `ALTER TABLE ${tn} ADD ${f.name ? `CONSTRAINT ${q(f.name)} ` : ''}FOREIGN KEY (${f.columns.map(q).join(', ')}) REFERENCES ${name(f.refSchema, f.refTable)} (${f.refColumns.map(q).join(', ')})${acts};`,
      );
    }
  }
  if (after.length) out.push('-- foreign keys', ...after, '');
  return out.join('\n');
}

// ---------- files ----------

export interface ExportFile {
  body: string;
  contentType: string;
  fileName: string;
}

const safeName = (s: string) =>
  s
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'schema';

/**
 * A snapshot as a download: `<name>-<date>.dbml | .sql | .json`. `source` is where the snapshot came from: only
 * Steward's own read of PostgreSQL gives index definitions the DDL takes as they are.
 */
export function exportSchema(d: DbSchemaDoc, format: DbSchemaExportFormat, base: string, takenAt: string, source: DbSchemaSource = 'tbls'): ExportFile {
  const fileName = `${safeName(base)}-${takenAt.slice(0, 10)}`;
  if (format === 'dbml') return { body: toDbml(d), contentType: 'text/plain; charset=utf-8', fileName: `${fileName}.dbml` };
  if (format === 'sql')
    return { body: toDdl(d, { ownIndexDefinitions: source === 'read' }), contentType: 'application/sql; charset=utf-8', fileName: `${fileName}.sql` };
  return { body: `${JSON.stringify(d, null, 2)}\n`, contentType: 'application/json; charset=utf-8', fileName: `${fileName}.json` };
}
