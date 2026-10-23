/**
 * Copies all data from one database to another, e.g. from the SQLite file to PostgreSQL:
 *
 *   npm run db:copy -- --from sqlite:./data/service-manager.db --to postgres://user:pass@host:5432/db [--to-schema s] [--force]
 *
 * Defaults: --from is the SQLite file in SM_DATA_DIR, --to is SM_DATABASE_URL (with
 * SM_DATABASE_SCHEMA / SM_DATABASE_CA). Both databases are first brought to the current schema
 * version; rows are copied verbatim (the audit hash chain stays valid) in foreign-key order,
 * in batches, inside one transaction on the target; identity sequences are reset afterwards.
 * A target that already holds data is refused unless --force (which replaces it).
 *
 * Stop the app first. The vault file (vault.json), artifacts, reports and uploaded docs stay
 * in the data directory – keep using the same SM_DATA_DIR.
 */
import '../bootstrap.js';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Db } from '../db.js';
import { describeTarget, parseDatabaseTarget, quoteIdent, type DatabaseTarget } from '../database/sql.js';
import { EVIDENCE_TABLES, noDeleteTrigger } from '../migrations/compliance.js';

export interface CopyOptions {
  from: DatabaseTarget;
  to: DatabaseTarget;
  force?: boolean;
  log?: (line: string) => void;
}
export interface CopyResult {
  tables: { name: string; rows: number }[];
}

/** Tables maintained by the migrations themselves. */
const META = new Set(['schema_version', 'schema_migrations']);
const FETCH = 1000;
/** Bound parameters per INSERT (PostgreSQL allows 65535, SQLite 32766). */
const MAX_PARAMS = 30000;

function tables(d: Db): string[] {
  const rows =
    d.dialect === 'sqlite'
      ? d.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name")
      : d.all<{ name: string }>(
          "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name",
        );
  return rows.map((r) => r.name).filter((t) => !META.has(t));
}

function columns(d: Db, table: string): string[] {
  const rows =
    d.dialect === 'sqlite'
      ? d.all<{ name: string }>('SELECT name FROM pragma_table_info(?) ORDER BY cid', table)
      : d.all<{ name: string }>(
          'SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? ORDER BY ordinal_position',
          table,
        );
  return rows.map((r) => r.name);
}

const pgRegclass = "(quote_ident(current_schema()) || '.' || quote_ident(?))::regclass";

function parents(d: Db, table: string): string[] {
  const rows =
    d.dialect === 'sqlite'
      ? d.all<{ name: string }>('SELECT DISTINCT "table" AS name FROM pragma_foreign_key_list(?)', table)
      : d.all<{ name: string }>(
          `SELECT DISTINCT cl.relname AS name FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.confrelid WHERE c.contype = 'f' AND c.conrelid = ${pgRegclass}`,
          table,
        );
  return rows.map((r) => r.name).filter((p) => p !== table);
}

/** Parents before children. */
function fkOrder(d: Db, list: string[]): string[] {
  const deps = new Map(list.map((t) => [t, parents(d, t).filter((p) => list.includes(p))]));
  const out: string[] = [];
  const visit = (t: string, path: string[]) => {
    if (out.includes(t)) return;
    if (path.includes(t)) throw new Error(`Foreign key cycle: ${[...path, t].join(' → ')}`);
    for (const p of deps.get(t) ?? []) visit(p, [...path, t]);
    out.push(t);
  };
  for (const t of list) visit(t, []);
  return out;
}

function primaryKey(d: Db, table: string): string[] {
  return d
    .all<{ name: string }>(
      `SELECT a.attname AS name FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = ${pgRegclass} AND i.indisprimary ORDER BY a.attnum`,
      table,
    )
    .map((r) => r.name);
}

const count = (d: Db, table: string) => d.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`)!.n;

/** Reads a table in batches, in insertion order where known. `rowid` carries SQLite's implicit row id. */
function* readBatches(src: Db, table: string, cols: string[]): Generator<Record<string, unknown>[]> {
  if (src.dialect === 'sqlite') {
    let last = Number.MIN_SAFE_INTEGER;
    for (;;) {
      const rows = src.all<Record<string, unknown>>(
        `SELECT rowid AS "__rowid", * FROM ${quoteIdent(table)} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
        last,
        FETCH,
      );
      if (!rows.length) return;
      last = rows[rows.length - 1]!.__rowid as number;
      for (const r of rows) {
        r.rowid = r.__rowid;
        delete r.__rowid;
      }
      yield rows;
      if (rows.length < FETCH) return;
    }
  }
  const order = cols.includes('rowid') ? ['rowid'] : primaryKey(src, table);
  src.exec(`DECLARE sm_copy NO SCROLL CURSOR FOR SELECT * FROM ${quoteIdent(table)}${order.length ? ' ORDER BY ' + order.map(quoteIdent).join(', ') : ''}`);
  try {
    for (;;) {
      const rows = src.all<Record<string, unknown>>(`FETCH ${FETCH} FROM sm_copy`);
      if (!rows.length) return;
      yield rows;
    }
  } finally {
    src.exec('CLOSE sm_copy');
  }
}

export function copyDatabase(opts: CopyOptions): CopyResult {
  const log = opts.log ?? (() => undefined);
  if (describeTarget(opts.from) === describeTarget(opts.to)) throw new Error('Source and target are the same database');
  if (opts.from.kind === 'sqlite' && !fs.existsSync(opts.from.file)) throw new Error(`SQLite database not found: ${opts.from.file}`);
  // Statements on large tables may take a while.
  const slow = <T extends DatabaseTarget>(t: T): T => (t.kind === 'postgres' ? { ...t, timeoutMs: t.timeoutMs ?? 600000 } : t);
  const src = new Db(slow(opts.from));
  let dst: Db | undefined;
  try {
    dst = new Db(slow(opts.to));
    const target = dst;
    const srcTables = tables(src);
    const dstTables = tables(target);
    const missing = srcTables.filter((t) => !dstTables.includes(t));
    if (missing.length) throw new Error(`The target has no table(s) ${missing.join(', ')} – are both on the same app version?`);
    const order = fkOrder(target, dstTables);
    const filled = order.filter((t) => count(target, t) > 0);
    if (filled.length && !opts.force) {
      throw new Error(`The target already holds data (${filled.join(', ')}). Use --force to replace it.`);
    }

    const result: CopyResult = { tables: [] };
    // consistent snapshot of the source
    src.exec(src.dialect === 'sqlite' ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      target.tx(() => {
        // evidence tables refuse deletes (trigger): lifted only while their old rows are replaced
        const guarded = EVIDENCE_TABLES.filter((t) => filled.includes(t));
        for (const t of guarded) target.exec(noDeleteTrigger(target.dialect, t).drop);
        for (const t of [...order].reverse()) if (filled.includes(t)) target.run(`DELETE FROM ${quoteIdent(t)}`);
        for (const t of guarded) target.exec(noDeleteTrigger(target.dialect, t).create);
        for (const t of order) {
          if (!srcTables.includes(t)) {
            result.tables.push({ name: t, rows: 0 });
            continue;
          }
          const srcCols = columns(src, t);
          const dstCols = columns(target, t);
          const extra = srcCols.filter((c) => !dstCols.includes(c) && c !== 'rowid');
          if (extra.length) throw new Error(`Table ${t}: the target has no column(s) ${extra.join(', ')}`);
          // SQLite's implicit rowid goes into the PostgreSQL `rowid` column where there is one
          const cols = dstCols.filter((c) => srcCols.includes(c) || (c === 'rowid' && src.dialect === 'sqlite'));
          const perInsert = Math.max(1, Math.min(500, Math.floor(MAX_PARAMS / cols.length)));
          const head = `INSERT INTO ${quoteIdent(t)} (${cols.map(quoteIdent).join(', ')}) VALUES `;
          const tuple = `(${cols.map(() => '?').join(', ')})`;
          let n = 0;
          for (const batch of readBatches(src, t, srcCols)) {
            for (let i = 0; i < batch.length; i += perInsert) {
              const chunk = batch.slice(i, i + perInsert);
              target.run(head + chunk.map(() => tuple).join(', '), ...chunk.flatMap((r) => cols.map((c) => r[c] ?? null)));
            }
            n += batch.length;
          }
          result.tables.push({ name: t, rows: n });
          log(`  ${t.padEnd(22)} ${n} row(s)`);
        }
        if (target.dialect === 'postgres') {
          const ids = target.all<{ table_name: string; column_name: string }>(
            "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND is_identity = 'YES'",
          );
          for (const { table_name: t, column_name: c } of ids) {
            target.get(
              `SELECT setval(pg_get_serial_sequence(?, ?), COALESCE((SELECT MAX(${quoteIdent(c)}) FROM ${quoteIdent(t)}), 0) + 1, false)`,
              quoteIdent(t),
              c,
            );
          }
        }
        // verify inside the transaction: nothing is committed on a mismatch
        for (const { name, rows } of result.tables) {
          const have = count(target, name);
          if (have !== rows) throw new Error(`Table ${name}: copied ${rows} row(s) but the target has ${have}`);
        }
      });
    } finally {
      src.exec('COMMIT');
    }
    return result;
  } finally {
    dst?.close();
    src.close();
  }
}

// ---------- command line ----------

const HELP = `Copy all data between databases (stop the app first).

  npm run db:copy -- [--from <db>] [--to <db>] [--from-schema <s>] [--to-schema <s>] [--force]

  <db> is postgres://user:password@host:5432/database or sqlite:<file>
  --from         default: sqlite:<SM_DATA_DIR>/service-manager.db
  --to           default: SM_DATABASE_URL
  --*-schema     PostgreSQL schema (default: SM_DATABASE_SCHEMA or public)
  --force        replace data that is already in the target

The vault file, artifacts, reports and docs stay in the data directory (SM_DATA_DIR).`;

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  return argv.find((a) => a.startsWith(name + '='))?.slice(name.length + 1);
}

export function main(argv: string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) return (console.log(HELP), 0);
  const cwd = process.env.INIT_CWD ?? process.cwd(); // npm runs scripts in the package folder
  const dataDir = path.resolve(process.env.SM_DATA_DIR ?? path.join(cwd, 'data'));
  const target = (spec: string | undefined, schema: string | undefined, what: string): DatabaseTarget => {
    if (!spec) throw new Error(`Missing --${what}`);
    const t = parseDatabaseTarget(spec, { schema: schema ?? process.env.SM_DATABASE_SCHEMA, ca: process.env.SM_DATABASE_CA });
    return t.kind === 'sqlite' ? { kind: 'sqlite', file: path.resolve(cwd, t.file) } : t;
  };
  try {
    const from = target(arg(argv, '--from') ?? `sqlite:${path.join(dataDir, 'service-manager.db')}`, arg(argv, '--from-schema'), 'from');
    const to = target(arg(argv, '--to') ?? process.env.SM_DATABASE_URL, arg(argv, '--to-schema'), 'to');
    console.log(`Copying ${describeTarget(from)} → ${describeTarget(to)}`);
    const t0 = Date.now();
    const r = copyDatabase({ from, to, force: argv.includes('--force'), log: console.log });
    const rows = r.tables.reduce((s, t) => s + t.rows, 0);
    console.log(`Done: ${rows} row(s) in ${r.tables.length} table(s), ${((Date.now() - t0) / 1000).toFixed(1)} s.`);
    console.log('Keep the data directory (vault.json, artifacts, reports, docs) and start the app with the new database.');
    return 0;
  } catch (e) {
    console.error(`db:copy failed: ${(e as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
