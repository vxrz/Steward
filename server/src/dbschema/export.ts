import { qualifiedTable, type DbSchemaDialect, type DbSchemaDoc, type DbSchemaExportFormat, type DbSchemaTable } from '@sm/shared';

/**
 * Exports of a schema snapshot (#222): DBML (https://dbml.dbdiagram.io/docs – written here, no library), SQL DDL in
 * the dialect of the source (standard SQL for databases Steward does not speak), and Steward's schema model as JSON.
 * The files open in dbdiagram, drawDB, ChartDB or Azimutt; Steward bundles none of them.
 *
 * The output is text for people and their tools: names are quoted for the target syntax, and nothing of it is ever
 * run by Steward.
 */

// ---------- DBML ----------

/** A DBML name in double quotes ("public"."orders"). */
const dq = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
/** A DBML string in single quotes, on one line. */
const sq = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ')}'`;
const dbmlTable = (t: Pick<DbSchemaTable, 'schema' | 'name'>) => (t.schema ? `${dq(t.schema)}.${dq(t.name)}` : dq(t.name));
/** A column type DBML takes as it is (varchar(120), numeric(10,2)); others in double quotes. */
const dbmlType = (type: string) => (/^[A-Za-z_][A-Za-z0-9_]*(\(\s*\d+\s*(,\s*\d+\s*)?\))?$/.test(type) ? type : dq(type));
/** A default: numbers and booleans as they are, everything else as an expression in backticks. */
function dbmlDefault(v: string): string {
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  if (/^(true|false|null)$/i.test(v)) return v.toLowerCase();
  return `\`${v.replace(/`/g, "'").replace(/\r?\n/g, ' ')}\``;
}
const ACTIONS = new Set(['CASCADE', 'RESTRICT', 'SET NULL', 'SET DEFAULT', 'NO ACTION']);
const dbmlAction = (a: string | null) => (a && ACTIONS.has(a) ? a.toLowerCase() : null);
const DB_TYPE: Record<DbSchemaDialect, string> = { postgresql: 'PostgreSQL', mysql: 'MySQL', sqlserver: 'SQL Server', sqlite: 'SQLite', other: 'Generic' };

export function toDbml(d: DbSchemaDoc): string {
  const out: string[] = [];
  out.push(`// ${d.database ?? 'Database'}${d.product ? ` (${d.product}${d.serverVersion ? ` ${d.serverVersion}` : ''})` : ''} – exported by Steward`);
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

const quoteFor = (d: DdlDialect) =>
  d === 'mysql'
    ? (s: string) => `\`${s.replace(/`/g, '``')}\``
    : d === 'sqlserver'
      ? (s: string) => `[${s.replace(/]/g, ']]')}]`
      : (s: string) => `"${s.replace(/"/g, '""')}"`;
const lit = (s: string) => `'${s.replace(/'/g, "''").replace(/\r?\n/g, ' ')}'`;
/** Identity and generated columns are written as they are, other defaults after DEFAULT. */
const isClause = (v: string) => /^(GENERATED\s|AUTO_INCREMENT$|IDENTITY\b)/i.test(v);

export function toDdl(d: DbSchemaDoc): string {
  const dialect = ddlDialect(d.dialect);
  const q = quoteFor(dialect);
  const name = (schema: string | null, n: string) => (schema ? `${q(schema)}.${q(n)}` : q(n));
  const label = dialect === 'standard' ? `standard SQL (source: ${d.product ?? d.dialect})` : DB_TYPE[d.dialect];
  const out: string[] = [
    `-- ${d.database ?? 'Database'}${d.product ? ` (${d.product}${d.serverVersion ? ` ${d.serverVersion}` : ''})` : ''} – exported by Steward`,
    `-- Dialect: ${label}`,
  ];
  if (d.truncated) out.push('-- The snapshot is truncated: it holds the first tables and columns only');
  out.push('');
  const after: string[] = [];
  for (const t of d.tables) {
    const tn = name(t.schema, t.name);
    if (t.type !== 'table') {
      out.push(
        `-- ${t.type} ${qualifiedTable(t)}: the definition is not part of the snapshot`,
        `--   columns: ${t.columns.map((c) => `${c.name} ${c.type}`).join(', ')}`,
        '',
      );
      continue;
    }
    const lines = t.columns.map((c) => {
      const parts = [`  ${q(c.name)} ${c.type}`];
      if (!c.nullable) parts.push('NOT NULL');
      if (c.default !== null) parts.push(isClause(c.default) ? c.default : `DEFAULT ${c.default}`);
      if (c.comment && dialect === 'mysql') parts.push(`COMMENT ${lit(c.comment)}`);
      return parts.join(' ');
    });
    if (t.primaryKey) lines.push(`  ${t.primaryKey.name ? `CONSTRAINT ${q(t.primaryKey.name)} ` : ''}PRIMARY KEY (${t.primaryKey.columns.map(q).join(', ')})`);
    if (t.comment && dialect !== 'mysql' && dialect !== 'postgresql') out.push(`-- ${t.comment.replace(/\r?\n/g, ' ')}`);
    out.push(`CREATE TABLE ${tn} (`, lines.join(',\n'), `)${t.comment && dialect === 'mysql' ? ` COMMENT=${lit(t.comment)}` : ''};`);
    if (dialect === 'postgresql') {
      if (t.comment) out.push(`COMMENT ON TABLE ${tn} IS ${lit(t.comment)};`);
      for (const c of t.columns) if (c.comment) out.push(`COMMENT ON COLUMN ${tn}.${q(c.name)} IS ${lit(c.comment)};`);
    } else if (dialect !== 'mysql') {
      for (const c of t.columns) if (c.comment) out.push(`-- ${t.name}.${c.name}: ${c.comment.replace(/\r?\n/g, ' ')}`);
    }
    for (const i of t.indexes) {
      if (i.primary) continue;
      if (i.columns.length) {
        out.push(`CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${q(i.name)} ON ${tn} (${i.columns.map(q).join(', ')});`);
      } else if (i.definition && /^CREATE\s/i.test(i.definition)) out.push(`${i.definition.replace(/;?\s*$/, '')};`);
      else out.push(`-- index ${i.name}: an expression index without its definition`);
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

/** A snapshot as a download: `<name>-<date>.dbml | .sql | .json`. */
export function exportSchema(d: DbSchemaDoc, format: DbSchemaExportFormat, base: string, takenAt: string): ExportFile {
  const fileName = `${safeName(base)}-${takenAt.slice(0, 10)}`;
  if (format === 'dbml') return { body: toDbml(d), contentType: 'text/plain; charset=utf-8', fileName: `${fileName}.dbml` };
  if (format === 'sql') return { body: toDdl(d), contentType: 'application/sql; charset=utf-8', fileName: `${fileName}.sql` };
  return { body: `${JSON.stringify(d, null, 2)}\n`, contentType: 'application/json; charset=utf-8', fileName: `${fileName}.json` };
}
