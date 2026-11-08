import type { Db } from '../src/db.js';

/**
 * A normalised description of a database schema, for comparing an upgraded database with a new one (A6 of the 0.10
 * review; server/test/upgrade.test.ts): tables, columns (type, NOT NULL, default, primary key, collation, identity),
 * indexes, constraints (primary and unique keys, foreign keys, CHECKs) and triggers – on SQLite and on PostgreSQL.
 *
 * Normalised:
 * - the PostgreSQL schema name (`smt_x.runs` → `runs`), so two schemas of one database compare;
 * - whitespace and the case of SQL keywords in stored SQL text (SQLite keeps the CREATE statements as written);
 * - columns are sorted by name: their position differs when two migrations of different modules add columns to one
 *   table, because an old installation ran them in another order than a new one (the review's point about module
 *   order) – `SELECT *` and INSERT without a column list are not used for that reason;
 * - SQLite's names of automatic indexes (sqlite_autoindex_<table>_<n>, numbered in the order of the constraints):
 *   their columns stand for them.
 * Left out: the meta tables of the migrations themselves (schema_version, schema_migrations) and the single-instance
 * lease, which the lease worker creates on PostgreSQL when an instance starts, not a migration (database/lease.ts).
 */
export interface SchemaSnapshot {
  tables: Record<string, TableSnapshot>;
  /** Indexes that are not part of a table's primary or unique key, by name: normalised definition */
  indexes: Record<string, string>;
  /** Triggers by name: normalised definition */
  triggers: Record<string, string>;
  /** PostgreSQL: functions of the schema (trigger functions), by name: normalised definition */
  functions: Record<string, string>;
  /** Views by name: normalised definition */
  views: Record<string, string>;
}

export interface TableSnapshot {
  columns: Record<string, string>;
  /** Primary key, unique keys, foreign keys and CHECK constraints, normalised and sorted */
  constraints: string[];
}

const META = new Set(['schema_version', 'schema_migrations', 'sm_instance_lease']);

/** Whitespace collapsed, spaces around punctuation removed, outside of quoted strings lower-cased. */
export function normaliseSql(sql: string, schema?: string): string {
  let s = sql;
  if (schema) {
    const q = schema.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(`"${q}"\\.`, 'g'), '').replace(new RegExp(`\\b${q}\\.`, 'g'), '');
  }
  // lower-case everything outside '…' literals (identifiers in "…" are case-sensitive, but the migrations write them
  // in lower case anyway)
  s = s
    .split(/('(?:[^']|'')*')/)
    .map((part, i) => (i % 2 ? part : part.toLowerCase()))
    .join('');
  return s
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),=])\s*/g, '$1')
    .replace(/\bif not exists\s*/g, '')
    .replace(/;\s*$/, '')
    .trim();
}

/** The CHECK (…) clauses of a CREATE TABLE statement (SQLite keeps no catalogue of them). */
function checkClauses(createSql: string): string[] {
  const out: string[] = [];
  const re = /\bcheck\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(createSql))) {
    let depth = 1;
    let i = m.index + m[0].length;
    let quote: string | null = null;
    for (; i < createSql.length && depth > 0; i++) {
      const c = createSql[i]!;
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === "'" || c === '"') quote = c;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
    }
    out.push(`check(${normaliseSql(createSql.slice(m.index + m[0].length, i - 1))})`);
    re.lastIndex = i;
  }
  return out;
}

function sqliteSnapshot(d: Db): SchemaSnapshot {
  const snap: SchemaSnapshot = { tables: {}, indexes: {}, triggers: {}, functions: {}, views: {} };
  const objects = d.all<{ type: string; name: string; tbl_name: string; sql: string | null }>(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name",
  );
  for (const o of objects) {
    if (o.type === 'table' && !META.has(o.name)) {
      const columns: Record<string, string> = {};
      for (const c of d.all<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number; hidden: number }>(
        'SELECT name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?)',
        o.name,
      ))
        columns[c.name] = [
          c.type.toUpperCase(),
          Number(c.notnull) ? 'not null' : 'null',
          c.dflt_value === null ? '' : `default ${normaliseSql(c.dflt_value)}`,
          Number(c.pk) ? `pk${c.pk}` : '',
          Number(c.hidden) ? `hidden${c.hidden}` : '',
        ]
          .filter(Boolean)
          .join(' ');
      const constraints: string[] = [];
      for (const i of d.all<{ name: string; unique: number; origin: string; partial: number }>(
        'SELECT name, "unique", origin, partial FROM pragma_index_list(?)',
        o.name,
      )) {
        if (i.origin === 'c') continue; // CREATE INDEX: below, by name
        const cols = d
          .all<{ name: string | null; desc: number; coll: string; key: number }>(
            'SELECT name, "desc", coll, "key" FROM pragma_index_xinfo(?) ORDER BY seqno',
            i.name,
          )
          .filter((c) => Number(c.key))
          .map((c) => `${c.name}${Number(c.desc) ? ' desc' : ''}${c.coll && c.coll !== 'BINARY' ? ` collate ${c.coll.toLowerCase()}` : ''}`);
        constraints.push(`${i.origin === 'pk' ? 'primary key' : 'unique'}(${cols.join(',')})`);
      }
      // an INTEGER PRIMARY KEY is the rowid: no index, the column's pk flag says it
      const fks = new Map<number, { table: string; from: string[]; to: (string | null)[]; onUpdate: string; onDelete: string }>();
      for (const f of d.all<{ id: number; seq: number; table: string; from: string; to: string | null; on_update: string; on_delete: string }>(
        'SELECT id, seq, "table", "from", "to", on_update, on_delete FROM pragma_foreign_key_list(?) ORDER BY id, seq',
        o.name,
      )) {
        const fk = fks.get(f.id) ?? { table: f.table, from: [], to: [], onUpdate: f.on_update, onDelete: f.on_delete };
        fk.from.push(f.from);
        fk.to.push(f.to);
        fks.set(f.id, fk);
      }
      for (const fk of fks.values())
        constraints.push(
          `foreign key(${fk.from.join(',')}) references ${fk.table.toLowerCase()}(${fk.to.map((t) => t ?? '').join(',')}) on update ${fk.onUpdate.toLowerCase()} on delete ${fk.onDelete.toLowerCase()}`,
        );
      constraints.push(...checkClauses(o.sql ?? ''));
      snap.tables[o.name] = { columns: sortKeys(columns), constraints: constraints.sort() };
    } else if (o.type === 'index' && o.sql) snap.indexes[o.name] = normaliseSql(o.sql);
    else if (o.type === 'trigger' && o.sql) snap.triggers[o.name] = normaliseSql(o.sql);
    else if (o.type === 'view' && o.sql) snap.views[o.name] = normaliseSql(o.sql);
  }
  return snap;
}

function pgSnapshot(d: Db): SchemaSnapshot {
  const schema = d.get<{ s: string }>('SELECT current_schema() AS s')!.s;
  const n = (sql: string | null) => normaliseSql(sql ?? '', schema);
  const snap: SchemaSnapshot = { tables: {}, indexes: {}, triggers: {}, functions: {}, views: {} };
  const tables = d
    .all<{ name: string }>("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'")
    .map((r) => r.name)
    .filter((t) => !META.has(t));
  for (const t of tables) snap.tables[t] = { columns: {}, constraints: [] };
  for (const c of d.all<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
    collation_name: string | null;
    is_identity: string;
    identity_generation: string | null;
  }>(
    `SELECT table_name, column_name, data_type, is_nullable, column_default, collation_name, is_identity, identity_generation
     FROM information_schema.columns WHERE table_schema = current_schema()`,
  )) {
    const t = snap.tables[c.table_name];
    if (!t) continue;
    t.columns[c.column_name] = [
      c.data_type,
      c.is_nullable === 'NO' ? 'not null' : 'null',
      c.column_default === null ? '' : `default ${n(c.column_default)}`,
      c.collation_name ? `collate ${c.collation_name}` : '',
      c.is_identity === 'YES' ? `identity ${String(c.identity_generation).toLowerCase()}` : '',
    ]
      .filter(Boolean)
      .join(' ');
  }
  for (const c of d.all<{ tbl: string; name: string; def: string }>(
    `SELECT cl.relname AS tbl, c.conname AS name, pg_get_constraintdef(c.oid) AS def
     FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace ns ON ns.oid = c.connamespace
     WHERE ns.nspname = current_schema() AND c.contype IN ('p', 'u', 'f', 'c', 'x')`,
  )) {
    const t = snap.tables[c.tbl];
    if (t) t.constraints.push(`${c.name}: ${n(c.def)}`);
  }
  for (const t of Object.values(snap.tables)) {
    t.columns = sortKeys(t.columns);
    t.constraints.sort();
  }
  // indexes that back a constraint are described by it
  for (const i of d.all<{ name: string; def: string }>(
    `SELECT i.indexname AS name, i.indexdef AS def FROM pg_indexes i
     WHERE i.schemaname = current_schema() AND i.tablename NOT IN ('schema_version', 'schema_migrations', 'sm_instance_lease')
       AND NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_namespace ns ON ns.oid = c.connamespace
                       WHERE ns.nspname = current_schema() AND c.conname = i.indexname)`,
  ))
    snap.indexes[i.name] = n(i.def);
  for (const t of d.all<{ name: string; tbl: string; def: string }>(
    `SELECT t.tgname AS name, cl.relname AS tbl, pg_get_triggerdef(t.oid) AS def
     FROM pg_trigger t JOIN pg_class cl ON cl.oid = t.tgrelid JOIN pg_namespace ns ON ns.oid = cl.relnamespace
     WHERE ns.nspname = current_schema() AND NOT t.tgisinternal`,
  ))
    snap.triggers[`${t.tbl}.${t.name}`] = n(t.def);
  for (const f of d.all<{ name: string; def: string }>(
    `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS name, pg_get_functiondef(p.oid) AS def
     FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE ns.nspname = current_schema() AND p.prokind = 'f'`,
  ))
    snap.functions[f.name] = n(f.def);
  for (const v of d.all<{ name: string; def: string }>('SELECT viewname AS name, definition AS def FROM pg_views WHERE schemaname = current_schema()'))
    snap.views[v.name] = n(v.def);
  snap.indexes = sortKeys(snap.indexes);
  snap.triggers = sortKeys(snap.triggers);
  snap.functions = sortKeys(snap.functions);
  snap.views = sortKeys(snap.views);
  snap.tables = sortKeys(snap.tables);
  return snap;
}

function sortKeys<T>(o: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function schemaSnapshot(d: Db): SchemaSnapshot {
  return d.dialect === 'sqlite' ? sqliteSnapshot(d) : pgSnapshot(d);
}

/**
 * The differences between two snapshots, one line each ("table runs: column x: … ≠ …"), for a readable test failure.
 * `allow` lists lines that are expected (a documented, intentional difference).
 */
export function schemaDiff(actual: SchemaSnapshot, expected: SchemaSnapshot, allow: readonly string[] = []): string[] {
  const out: string[] = [];
  const cmp = (what: string, a: Record<string, string>, e: Record<string, string>) => {
    for (const k of new Set([...Object.keys(a), ...Object.keys(e)])) {
      if (a[k] === e[k]) continue;
      out.push(
        a[k] === undefined
          ? `${what} ${k}: missing (new: ${e[k]})`
          : e[k] === undefined
            ? `${what} ${k}: extra (${a[k]})`
            : `${what} ${k}: ${a[k]} ≠ new: ${e[k]}`,
      );
    }
  };
  for (const t of new Set([...Object.keys(actual.tables), ...Object.keys(expected.tables)])) {
    const a = actual.tables[t];
    const e = expected.tables[t];
    if (!a || !e) {
      out.push(`table ${t}: ${a ? 'extra' : 'missing'}`);
      continue;
    }
    cmp(`table ${t}: column`, a.columns, e.columns);
    const ac = new Set(a.constraints);
    const ec = new Set(e.constraints);
    for (const c of ac) if (!ec.has(c)) out.push(`table ${t}: constraint extra: ${c}`);
    for (const c of ec) if (!ac.has(c)) out.push(`table ${t}: constraint missing: ${c}`);
  }
  cmp('index', actual.indexes, expected.indexes);
  cmp('trigger', actual.triggers, expected.triggers);
  cmp('function', actual.functions, expected.functions);
  cmp('view', actual.views, expected.views);
  return out.filter((l) => !allow.some((a) => l.startsWith(a)));
}
