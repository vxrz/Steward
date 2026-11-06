import { EventEmitter } from 'node:events';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { DB_CATALOGS, effectiveDbLimits, readOnlyStatementProblem, sqlProblemParam, validateProcess, type DbDialect } from '@sm/shared';
import { PG_SESSION_RESET, pgRun, type PgQueryable } from '../src/dbms/postgres.js';
import { killQuery, mysqlRun, timeLimitStatement, type MyKillConnection, type MyQueryable } from '../src/dbms/mysql.js';
import { mssqlRun, msType, type MsLib, type MsQueryable, type MsRequest } from '../src/dbms/sqlserver.js';
import { CATALOG, catalogSql, mapCatalogRows, myAccount, msIdent, pgIdent } from '../src/dbms/catalog.js';
import { mapDriverError } from '../src/dbms/errors.js';
import { ConnectionPool } from '../src/dbms/pool.js';
import { DbError, RowCollector, cellValue, type DriverConnection, type RunLimits } from '../src/dbms/types.js';
import { bindValue, redactDbError } from '../src/dbms/service.js';
import { assertNotOwnDatabase, isOwnDatabase, ownDatabaseEndpoint, type AddressLookup } from '../src/dbms/own.js';

/**
 * Database platforms (#203, ADR 0008) without a database: the statement check per dialect, the read-only wrapping and
 * parameter binding of each driver against a fake connection, the limits, the catalog queries and their generated
 * statements, error mapping and the pool. The drivers against real servers: dbms-integration.test.ts.
 */

const LIMITS: RunLimits = { maxRows: 100, maxBytes: 1024 * 1024, timeoutMs: 5000, truncate: false };
const never = new AbortController().signal;
const ALL: DbDialect[] = ['postgresql', 'mysql', 'sqlserver'];

describe('statement check (sqlcheck.ts)', () => {
  const ok = (sql: string, dialects = ALL, params = 0) => {
    for (const d of dialects) expect(readOnlyStatementProblem(sql, d, params), `${d}: ${sql}`).toBeNull();
  };
  const refused = (sql: string, code: string, dialects = ALL, params?: number) => {
    for (const d of dialects) expect(readOnlyStatementProblem(sql, d, params)?.code, `${d}: ${sql}`).toBe(code);
  };

  it('accepts one query', () => {
    ok('SELECT 1');
    ok('select id, name from orders where total > 10 order by id');
    ok('WITH x AS (SELECT 1 AS a) SELECT a FROM x');
    ok('(SELECT 1) UNION ALL (SELECT 2)');
    ok('SELECT 1;');
    ok('SELECT 1 ;  ;\n');
    ok("SELECT 'DELETE FROM orders; DROP TABLE x' AS harmless");
    ok('SELECT 1 -- DELETE FROM orders\n');
    ok('SELECT /* ; DELETE */ 1');
  });

  it('accepts names that are refused words when they are quoted', () => {
    ok('SELECT "update", "delete" FROM t', ['postgresql', 'sqlserver']);
    ok('SELECT [update] FROM [delete]', ['sqlserver']);
    ok('SELECT `update` FROM `delete`', ['mysql']);
    ok('SELECT $$DELETE FROM t$$ AS body', ['postgresql']);
    ok('SELECT $tag$ ; DROP $tag$', ['postgresql']);
  });

  it('refuses anything but a single SELECT', () => {
    refused('DELETE FROM orders', 'notSelect');
    refused('UPDATE orders SET total = 0', 'notSelect');
    refused('EXPLAIN ANALYZE SELECT 1', 'notSelect');
    refused('SHOW GRANTS', 'notSelect');
    refused('VALUES (1)', 'notSelect');
    refused('', 'empty');
    refused('SELECT 1; SELECT 2', 'multipleStatements');
    refused('SELECT 1; DELETE FROM orders', 'multipleStatements');
  });

  it('refuses words that change something, also inside a query', () => {
    refused('WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d', 'refusedWord', ['postgresql']);
    refused('SELECT * INTO copy FROM orders', 'refusedWord');
    refused('SELECT * FROM orders FOR UPDATE', 'refusedWord');
    refused('SELECT * FROM orders LOCK IN SHARE MODE', 'refusedWord', ['mysql']);
    refused("SELECT * FROM t INTO OUTFILE '/tmp/x'", 'refusedWord', ['mysql']);
    // T-SQL needs no semicolon between statements
    refused('SELECT 1 DELETE FROM orders', 'refusedWord', ['sqlserver']);
    refused('SELECT 1 EXEC xp_cmdshell', 'refusedWord', ['sqlserver']);
    refused("SELECT * FROM OPENROWSET('SQLNCLI', 'x', 'SELECT 1')", 'refusedWord', ['sqlserver']);
    refused('SELECT 1 WAITFOR DELAY 1', 'refusedWord', ['sqlserver']);
    refused('SELECT set_config(1, 2, false)', 'refusedFunction', ['postgresql']);
  });

  it('refuses functions with effects outside the transaction', () => {
    refused('SELECT pg_terminate_backend(42)', 'refusedFunction', ['postgresql']);
    refused('SELECT pg_advisory_lock(1)', 'refusedFunction', ['postgresql']);
    refused("SELECT lo_export(1, '/tmp/x')", 'refusedFunction', ['postgresql']);
    refused("SELECT dblink_exec('x', 'y')", 'refusedFunction', ['postgresql']);
    refused("SELECT GET_LOCK('x', 1)", 'refusedFunction', ['mysql']);
    refused("SELECT LOAD_FILE('/etc/passwd')", 'refusedFunction', ['mysql']);
    refused('SELECT xp_dirtree', 'refusedFunction', ['sqlserver']);
  });

  it('refuses what the DBMS would read differently from the check', () => {
    refused('SELECT /*! 1; DELETE FROM t */ 1', 'executableComment', ['mysql']);
    refused('SELECT 1 --x\n', 'ambiguousComment', ['mysql']);
    refused("SELECT 'a\\' , 1", 'backslash');
    refused("SELECT 'open", 'unterminated');
    refused('SELECT /* open', 'unterminated');
    refused('SELECT $a$ open', 'unterminated', ['postgresql']);
    refused('SELECT `x` FROM t', 'invalidCharacter', ['postgresql', 'sqlserver']);
    // # is a comment in MariaDB/MySQL – and hides nothing there; elsewhere it is checked as code
    ok('SELECT 1 # DELETE\n', ['mysql']);
  });

  it('counts the dialect’s placeholders against the parameters', () => {
    ok('SELECT * FROM t WHERE a = $1 AND b = $2', ['postgresql'], 2);
    ok('SELECT * FROM t WHERE a = ? AND b = ?', ['mysql'], 2);
    ok('SELECT * FROM t WHERE a = @p1 AND b = @p2', ['sqlserver'], 2);
    ok("SELECT '?' AS q, '$1' AS d", ['mysql', 'postgresql'], 0);
    refused('SELECT $1, $3', 'placeholders', ['postgresql'], 3);
    refused('SELECT ?', 'placeholders', ['mysql'], 2);
    refused('SELECT @p1', 'placeholders', ['sqlserver'], 0);
  });

  it('checks quoted function names, refusing them without regard to case', () => {
    refused('SELECT "pg_advisory_lock"(1)', 'refusedFunction', ['postgresql']);
    refused('SELECT "PG_Terminate_Backend"(42)', 'refusedFunction', ['postgresql']);
    refused('SELECT "pg_catalog"."pg_advisory_lock" (1)', 'refusedFunction', ['postgresql']);
    refused('SELECT [xp_dirtree](1)', 'refusedFunction', ['sqlserver']);
    refused('SELECT "sp_who"(1)', 'refusedFunction', ['sqlserver']);
    refused("SELECT `GET_LOCK`('x', 1)", 'refusedFunction', ['mysql']);
    refused('SELECT "get_lock"(\'x\', 1)', 'refusedFunction', ['mysql']);
    // a quoted name that is not called stays a name
    ok('SELECT "pg_advisory_lock", "sp_name" FROM t', ['postgresql', 'sqlserver']);
    ok('SELECT [lo_value] FROM t', ['sqlserver']);
    ok('SELECT `lo_value` FROM t', ['mysql']);
    // escapes the check would not see
    refused('SELECT U&"x" UESCAPE \'!\'', 'refusedWord', ['postgresql']);
  });

  it('refuses functions that run SQL given as text, and dblink', () => {
    for (const f of [
      'query_to_xml',
      'query_to_xml_and_xmlschema',
      'query_to_xmlschema',
      'cursor_to_xml',
      'table_to_xml',
      'schema_to_xml',
      'database_to_xml',
      'ts_stat',
      'crosstab',
      'crosstab3',
    ])
      refused(`SELECT ${f}('x', true, true, '')`, 'refusedFunction', ['postgresql']);
    refused('SELECT dblink(1)', 'refusedFunction', ['postgresql']);
    refused('SELECT dblink_exec(1)', 'refusedFunction', ['postgresql']);
    refused('SELECT dblinkx(1)', 'refusedFunction', ['postgresql']);
    refused('SELECT * FROM "dblink"(1) AS t(a int)', 'refusedFunction', ['postgresql']);
    refused('SELECT NEXTVAL(s)', 'refusedFunction', ['mysql']);
  });

  it('refuses optimizer hints in MariaDB/MySQL', () => {
    refused('SELECT /*+ MAX_EXECUTION_TIME(1) */ 1', 'optimizerHint', ['mysql']);
    refused('SELECT /*+ SET_VAR(x = 1) */ 1', 'optimizerHint', ['mysql']);
    // an ordinary comment elsewhere
    ok('SELECT /*+ x */ 1', ['postgresql', 'sqlserver']);
    ok('SELECT /* + */ 1', ['mysql']);
  });

  it('refuses row locks: FOR SHARE and its variants, SQL Server lock hints', () => {
    for (const lock of ['FOR SHARE', 'FOR SHARE NOWAIT', 'FOR SHARE SKIP LOCKED', 'FOR SHARE OF t'])
      refused(`SELECT * FROM t ${lock}`, 'rowLock', ['mysql', 'postgresql']);
    refused('SELECT * FROM t FOR KEY SHARE', 'rowLock', ['postgresql']);
    refused('SELECT * FROM t FOR NO KEY UPDATE', 'rowLock', ['postgresql']);
    refused('SELECT * FROM t FOR UPDATE SKIP LOCKED', 'refusedWord', ['mysql', 'postgresql']);
    for (const hint of ['UPDLOCK', 'XLOCK', 'HOLDLOCK', 'TABLOCK', 'TABLOCKX']) refused(`SELECT * FROM t WITH (${hint})`, 'rowLock', ['sqlserver']);
    ok('SELECT * FROM t WITH (NOLOCK)', ['sqlserver']);
    ok('SELECT * FROM t FOR XML PATH', ['sqlserver']);
  });

  it('refuses what starts another T-SQL statement without a semicolon', () => {
    for (const w of [
      'IF 1 = 1 SELECT 2',
      "RAISERROR('x', 16, 1) WITH LOG",
      'ENABLE TRIGGER t ON x',
      'DISABLE TRIGGER t ON x',
      'RECEIVE * FROM q',
      "THROW 50000, 'x', 1",
      "PRINT 'x'",
      'GOTO x',
      'CLOSE c',
      'WHILE 1 = 1 BREAK',
    ])
      refused(`SELECT 1 ${w}`, 'refusedWord', ['sqlserver']);
    refused('SELECT NEXT VALUE FOR seq', 'refusedWord', ['sqlserver', 'mysql']);
    // a second SELECT outside parentheses is a second statement
    refused('SELECT 1 SELECT 2', 'multipleStatements', ['sqlserver']);
    refused('SELECT a FROM t SELECT b FROM u', 'multipleStatements', ['sqlserver']);
    refused('(SELECT 1) SELECT 2', 'multipleStatements', ['sqlserver']);
    refused('WITH a AS (SELECT 1 AS x) SELECT x FROM a SELECT 2', 'multipleStatements', ['sqlserver']);
    // … unless UNION, EXCEPT or INTERSECT joins it, or it is the query of a WITH
    ok('SELECT 1 UNION ALL SELECT 2 EXCEPT SELECT 3 INTERSECT SELECT 4', ['sqlserver']);
    ok('WITH a AS (SELECT 1 AS x), b (y) AS (SELECT 2) SELECT x FROM a UNION SELECT y FROM b', ['sqlserver']);
    ok('SELECT x FROM (SELECT 1 AS x) d WHERE x IN (SELECT 1) ORDER BY x OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY', ['sqlserver']);
    ok('SELECT CASE WHEN 1 = 1 THEN 1 ELSE 2 END', ['sqlserver']);
    ok('SELECT [if], [print] FROM t', ['sqlserver']);
  });

  it('describes a refusal for the translated text', () => {
    const p = readOnlyStatementProblem('SELECT 1 FROM t FOR SHARE', 'mysql')!;
    expect(sqlProblemParam(p)).toEqual({ code: 'DB_SQL_ROW_LOCK', message: p.message, params: { word: 'FOR SHARE', at: 17 } });
    const c = readOnlyStatementProblem('SELECT ?', 'mysql', 2)!;
    expect(sqlProblemParam(c)).toMatchObject({ code: 'DB_SQL_PLACEHOLDERS', params: { context: 'count', need: 1, given: 2 } });
  });

  it('is part of process validation', () => {
    const def = (step: Record<string, unknown>) => ({
      name: 'x',
      connections: [{ slot: 'db', kind: 'database' }],
      steps: [{ id: 'q', type: 'query', connection: 'db', ...step }],
    });
    expect(validateProcess(def({ catalog: 'accounts' })).ok).toBe(true);
    expect(validateProcess(def({ sql: 'SELECT 1' })).ok).toBe(true);
    const both = validateProcess(def({ sql: 'SELECT 1', catalog: 'accounts' }));
    expect(both.issues.map((i) => i.code)).toContain('querySqlOrCatalog');
    const none = validateProcess(def({}));
    expect(none.issues.map((i) => i.code)).toContain('querySqlOrCatalog');
    const del = validateProcess(def({ sql: 'DELETE FROM orders' }));
    expect(del.issues.map((i) => i.code)).toContain('queryRefused');
    // refused for one DBMS only (a backtick): the run checks the platform's DBMS
    expect(validateProcess(def({ sql: 'SELECT `a` FROM t' })).ok).toBe(true);
    expect(validateProcess(def({ sql: 'SELECT `a` FROM t', dialect: 'postgresql' })).ok).toBe(false);
    expect(validateProcess(def({ catalog: 'accounts', params: ['x'] })).issues.map((i) => i.code)).toContain('queryCatalogParams');
  });
});

// ---------- PostgreSQL ----------

function fakePg(rows: unknown[][], opts: { failOn?: string; fields?: string[] } = {}) {
  const calls: { text: string; values?: unknown[] }[] = [];
  let pos = 0;
  const client: PgQueryable = {
    async query(c) {
      calls.push({ text: c.text, values: c.values });
      if (opts.failOn && c.text.includes(opts.failOn)) throw Object.assign(new Error('permission denied for table orders'), { code: '42501' });
      if (c.text.startsWith('FETCH')) {
        const n = Number(/FETCH (\d+)/.exec(c.text)![1]);
        const batch = rows.slice(pos, pos + n);
        pos += batch.length;
        return { rows: batch, fields: (opts.fields ?? ['id', 'name']).map((name) => ({ name })) };
      }
      return { rows: [], fields: [] };
    },
  };
  return { client, calls };
}

describe('PostgreSQL session (postgres.ts)', () => {
  const stmt = { sql: 'SELECT id, name FROM orders WHERE id > $1', params: [5], trusted: false };

  it('reads through a cursor in a read-only transaction and always rolls back', async () => {
    const { client, calls } = fakePg([
      [6, 'a'],
      [7, 'b'],
    ]);
    const r = await pgRun(client, stmt, LIMITS, never);
    expect(r.rows).toEqual([
      { id: 6, name: 'a' },
      { id: 7, name: 'b' },
    ]);
    expect(r.columns).toEqual(['id', 'name']);
    expect(calls.map((c) => c.text.split(' ').slice(0, 3).join(' '))).toEqual([
      'BEGIN TRANSACTION READ',
      "SELECT set_config('statement_timeout', $1,",
      'DECLARE steward_q NO',
      'FETCH 500 FROM',
      'ROLLBACK',
      'SELECT pg_advisory_unlock_all()',
    ]);
    // the statement time limit is a bound value, the parameters are bound – never in the text
    expect(calls[1]!.values).toEqual(['5000']);
    expect(calls[2]!.text).toBe('DECLARE steward_q NO SCROLL CURSOR FOR SELECT id, name FROM orders WHERE id > $1');
    expect(calls[2]!.values).toEqual([5]);
  });

  it('rolls back after an error', async () => {
    const { client, calls } = fakePg([], { failOn: 'DECLARE' });
    await expect(pgRun(client, stmt, LIMITS, never)).rejects.toThrow(/permission denied/);
    expect(calls.slice(-2).map((c) => c.text)).toEqual(['ROLLBACK', PG_SESSION_RESET]);
  });

  it('reads in batches and enforces the row limit (fail or truncate)', async () => {
    const many = Array.from({ length: 1200 }, (_, i) => [i, `n${i}`]);
    const all = await pgRun(fakePg(many).client, stmt, { ...LIMITS, maxRows: 5000 }, never);
    expect(all.rowCount).toBe(1200);
    await expect(pgRun(fakePg(many).client, stmt, { ...LIMITS, maxRows: 700 }, never)).rejects.toMatchObject({ code: 'DB_ROW_LIMIT' });
    const cut = fakePg(many);
    const r = await pgRun(cut.client, stmt, { ...LIMITS, maxRows: 700, truncate: true }, never);
    expect(r).toMatchObject({ rowCount: 700, truncated: true });
    // it stopped fetching once enough rows were there
    expect(cut.calls.filter((c) => c.text.startsWith('FETCH'))).toHaveLength(2);
    expect(cut.calls.slice(-2).map((c) => c.text)).toEqual(['ROLLBACK', PG_SESSION_RESET]);
  });

  it('enforces the size limit', async () => {
    const big = Array.from({ length: 50 }, (_, i) => [i, 'x'.repeat(10_000)]);
    await expect(pgRun(fakePg(big).client, stmt, { ...LIMITS, maxBytes: 100_000 }, never)).rejects.toMatchObject({ code: 'DB_SIZE_LIMIT' });
    const r = await pgRun(fakePg(big).client, stmt, { ...LIMITS, maxBytes: 100_000, truncate: true }, never);
    expect(r.truncated).toBe(true);
    expect(r.rowCount).toBeLessThan(10);
  });
});

describe('PostgreSQL session reset (postgres.ts)', () => {
  const stmt = { sql: 'SELECT 1', params: [], trusted: false };
  it('releases session advisory locks after every statement, also after an error', async () => {
    const ok = fakePg([[1, 'a']]);
    await pgRun(ok.client, stmt, LIMITS, never);
    expect(ok.calls.at(-1)!.text).toBe('SELECT pg_advisory_unlock_all()');
    const failed = fakePg([], { failOn: 'DECLARE' });
    await pgRun(failed.client, stmt, LIMITS, never).catch(() => undefined);
    expect(failed.calls.at(-1)!.text).toBe(PG_SESSION_RESET);
  });

  it('marks the connection unclean when the reset fails', async () => {
    const f = fakePg([[1, 'a']], { failOn: 'pg_advisory_unlock_all' });
    let unclean = false;
    const r = await pgRun(f.client, stmt, LIMITS, never, () => (unclean = true));
    expect(r.rowCount).toBe(1);
    expect(unclean).toBe(true);
  });
});

// ---------- MariaDB / MySQL ----------

function fakeMy(rows: unknown[][], opts: { sets?: number; error?: { errno: number; message: string }; hang?: boolean } = {}) {
  const log: string[] = [];
  const executed: { kind: string; sql: string; values?: unknown[] }[] = [];
  let destroyed = false;
  let hung: (() => void) | undefined;
  const emitter = (kind: string, sql: string, values?: unknown[]) => {
    executed.push({ kind, sql, values });
    const e = new EventEmitter();
    setImmediate(() => {
      if (opts.error) return void e.emit('error', Object.assign(new Error(opts.error.message), { errno: opts.error.errno }));
      for (let s = 0; s < (opts.sets ?? 1); s++) e.emit('fields', [{ name: 'id' }, { name: 'name' }]);
      if (opts.hang) {
        // a statement the server keeps running: KILL QUERY ends it with an error, rows come no more
        hung = () => e.emit('error', Object.assign(new Error('Query execution was interrupted'), { errno: 1317 }));
        return;
      }
      for (const r of rows) {
        if (destroyed) return;
        e.emit('result', r);
      }
      e.emit('end');
    });
    return e;
  };
  const conn = {
    query(a: string | { sql: string }, cb?: (err: Error | null) => void) {
      if (typeof a === 'string') {
        log.push(a);
        setImmediate(() => cb!(null));
        return undefined;
      }
      return emitter('query', a.sql);
    },
    execute(o: { sql: string; values?: unknown[] }) {
      return emitter('execute', o.sql, o.values);
    },
    destroy() {
      destroyed = true;
      log.push('<destroyed>');
    },
  } as unknown as MyQueryable;
  /** KILL QUERY, as the server would answer it */
  const kill = async () => {
    log.push('<kill>');
    hung?.();
  };
  return { conn, log, executed, kill };
}

describe('MariaDB / MySQL session (mysql.ts)', () => {
  const mysql = { flavour: 'mysql' as const, version: '8.4.3' };
  const mariadb = { flavour: 'mariadb' as const, version: '11.4.4-MariaDB' };

  it('sets the time limit of the flavour', () => {
    expect(timeLimitStatement(mysql, 30_000)).toBe('SET SESSION MAX_EXECUTION_TIME = 30000');
    expect(timeLimitStatement(mariadb, 30_000)).toBe('SET SESSION max_statement_time = 30');
    expect(timeLimitStatement(mariadb, 1500)).toBe('SET SESSION max_statement_time = 2');
  });

  it('runs a prepared statement in START TRANSACTION READ ONLY and rolls back', async () => {
    const f = fakeMy([
      [1, 'a'],
      [2, 'b'],
    ]);
    const r = await mysqlRun(f.conn, mysql, { sql: 'SELECT id, name FROM t WHERE id > ?', params: [0], trusted: false }, LIMITS, never);
    expect(r.result.rows).toEqual([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ]);
    expect(r.destroyed).toBe(false);
    expect(f.log).toEqual(['SET SESSION MAX_EXECUTION_TIME = 5000', 'START TRANSACTION READ ONLY', 'ROLLBACK']);
    expect(f.executed).toEqual([{ kind: 'execute', sql: 'SELECT id, name FROM t WHERE id > ?', values: [0] }]);
  });

  it('sends catalog statements without parameters as text (SHOW … is not always preparable)', async () => {
    const f = fakeMy([]);
    await mysqlRun(f.conn, mariadb, { sql: 'SHOW REPLICA STATUS', params: [], trusted: true }, LIMITS, never);
    expect(f.executed[0]).toMatchObject({ kind: 'query', sql: 'SHOW REPLICA STATUS' });
  });

  it('closes the connection when a limit is reached', async () => {
    const many = Array.from({ length: 20 }, (_, i) => [i, 'x']);
    const cut = fakeMy(many);
    const r = await mysqlRun(cut.conn, mysql, { sql: 'SELECT 1', params: [], trusted: false }, { ...LIMITS, maxRows: 5, truncate: true }, never);
    expect(r).toMatchObject({ destroyed: true, result: { rowCount: 5, truncated: true } });
    expect(cut.log).toContain('<destroyed>');
    expect(cut.log).not.toContain('ROLLBACK');
    const fail = fakeMy(many);
    await expect(mysqlRun(fail.conn, mysql, { sql: 'SELECT 1', params: [], trusted: false }, { ...LIMITS, maxRows: 5 }, never)).rejects.toMatchObject({
      code: 'DB_ROW_LIMIT',
    });
    expect(fail.log).toContain('<destroyed>');
  });

  it('refuses a second result set and maps server errors', async () => {
    await expect(mysqlRun(fakeMy([], { sets: 2 }).conn, mysql, { sql: 'SELECT 1', params: [], trusted: false }, LIMITS, never)).rejects.toMatchObject({
      code: 'DB_MULTIPLE_RESULTS',
    });
    const f = fakeMy([], { error: { errno: 1792, message: 'Cannot execute statement in a READ ONLY transaction.' } });
    const e = await mysqlRun(f.conn, mysql, { sql: 'SELECT 1', params: [], trusted: false }, LIMITS, never).catch((x) => x);
    expect(mapDriverError('mysql', e, 'query').code).toBe('DB_READ_ONLY_VIOLATION');
    expect(f.log.at(-1)).toBe('ROLLBACK');
  });

  it('kills the statement on the server before it closes the connection at the time limit', async () => {
    const f = fakeMy([], { hang: true });
    const ctl = new AbortController();
    const done = mysqlRun(f.conn, mysql, { sql: 'SELECT SLEEP(60)', params: [], trusted: false }, LIMITS, ctl.signal, f.kill).catch((x) => x);
    await new Promise((r) => setTimeout(r, 20));
    ctl.abort(new DbError('DB_TIMEOUT', 'The statement ran longer than 5 s (the limit)'));
    const e = await done;
    expect(e).toMatchObject({ code: 'DB_TIMEOUT' });
    // KILL QUERY first, then the connection is dropped (not rolled back and reused)
    expect(f.log.slice(-2)).toEqual(['<kill>', '<destroyed>']);
    expect(f.log).not.toContain('ROLLBACK');
  });

  it('sends KILL QUERY over a second connection and closes it, best effort', async () => {
    const fake = (opts: { fail?: boolean; slow?: boolean } = {}) => {
      const log: string[] = [];
      const conn: MyKillConnection = {
        query(sql, cb) {
          log.push(sql);
          if (!opts.slow) setImmediate(() => cb(opts.fail ? new Error('Unknown thread id: 42') : null));
          return undefined;
        },
        end(cb) {
          log.push('<end>');
          cb();
        },
        destroy() {
          log.push('<destroyed>');
        },
      };
      return { log, open: async () => conn };
    };
    const a = fake();
    expect(await killQuery(a.open, 42)).toBe(true);
    expect(a.log).toEqual(['KILL QUERY 42', '<end>']);
    // no thread id: nothing to kill, no connection
    let opened = false;
    expect(
      await killQuery(async () => {
        opened = true;
        return a.open();
      }, undefined),
    ).toBe(false);
    expect(opened).toBe(false);
    // the server refuses or the second connection fails: the caller closes its socket anyway
    const b = fake({ fail: true });
    expect(await killQuery(b.open, 42)).toBe(false);
    expect(b.log).toContain('<end>');
    expect(await killQuery(() => Promise.reject(new Error('ECONNREFUSED')), 42)).toBe(false);
    // no answer within the time: given up, the connection closed
    const c = fake({ slow: true });
    expect(await killQuery(c.open, 42, 30)).toBe(false);
    expect(c.log).toContain('<end>');
  });
});

// ---------- SQL Server ----------

function fakeMs(rows: unknown[][], opts: { sets?: number; error?: Error } = {}) {
  const log: string[] = [];
  const params: { name: string; type: unknown; value: unknown }[] = [];
  let pending: { req: MsRequest & { cb: (e: Error | null) => void }; stop: boolean } | null = null;
  const TYPES = { Int: 'Int', BigInt: 'BigInt', Float: 'Float', Bit: 'Bit', NVarChar: 'NVarChar', DateTimeOffset: 'DateTimeOffset' };
  class Req extends EventEmitter {
    timeout = 0;
    constructor(
      public sql: string,
      public cb: (e: Error | null) => void,
    ) {
      super();
    }
    addParameter(name: string, type: unknown, value: unknown) {
      params.push({ name, type, value });
    }
    setTimeout(ms: number) {
      this.timeout = ms;
    }
  }
  const lib: MsLib = { Request: Req as unknown as MsLib['Request'], TYPES };
  const conn: MsQueryable = {
    beginTransaction: (cb) => {
      log.push('BEGIN');
      setImmediate(() => cb(null));
    },
    rollbackTransaction: (cb) => {
      log.push('ROLLBACK');
      setImmediate(() => cb(null));
    },
    execSql: (req) => {
      const r = req as unknown as Req;
      log.push(`EXEC ${r.sql}`);
      pending = { req: r as never, stop: false };
      setImmediate(() => {
        if (opts.error) return r.cb(opts.error);
        for (let s = 0; s < (opts.sets ?? 1); s++) r.emit('columnMetadata', [{ colName: 'id' }, { colName: 'name' }]);
        for (const row of rows) {
          if (pending?.stop) return r.cb(Object.assign(new Error('Canceled.'), { code: 'ECANCEL' }));
          r.emit(
            'row',
            row.map((value) => ({ value })),
          );
        }
        r.cb(null);
      });
    },
    cancel: () => {
      log.push('CANCEL');
      if (pending) pending.stop = true;
      return true;
    },
  };
  return { conn, lib, log, params };
}

describe('SQL Server session (sqlserver.ts)', () => {
  it('runs in a transaction that is always rolled back, parameters bound as @p1 …', async () => {
    const f = fakeMs([[1, 'a']]);
    const r = await mssqlRun(
      f.conn,
      f.lib,
      { sql: 'SELECT id, name FROM t WHERE id = @p1 AND n = @p2 AND ok = @p3', params: [1, 'x', true], trusted: false },
      LIMITS,
      never,
    );
    expect(r.result.rows).toEqual([{ id: 1, name: 'a' }]);
    expect(f.log).toEqual(['BEGIN', 'EXEC SELECT id, name FROM t WHERE id = @p1 AND n = @p2 AND ok = @p3', 'ROLLBACK']);
    expect(f.params).toEqual([
      { name: 'p1', type: 'Int', value: 1 },
      { name: 'p2', type: 'NVarChar', value: 'x' },
      { name: 'p3', type: 'Bit', value: true },
    ]);
  });

  it('picks the TDS type of a value', () => {
    const T = { Int: 'Int', BigInt: 'BigInt', Float: 'Float', Bit: 'Bit', NVarChar: 'NVarChar', DateTimeOffset: 'DateTimeOffset' };
    expect(msType(T, 3_000_000_000)).toBe('BigInt');
    expect(msType(T, 1.5)).toBe('Float');
    expect(msType(T, null)).toBe('NVarChar');
    expect(msType(T, new Date())).toBe('DateTimeOffset');
  });

  it('cancels the request at a limit and rolls back after errors', async () => {
    const many = Array.from({ length: 20 }, (_, i) => [i, 'x']);
    const cut = fakeMs(many);
    const r = await mssqlRun(cut.conn, cut.lib, { sql: 'SELECT 1', params: [], trusted: false }, { ...LIMITS, maxRows: 3, truncate: true }, never);
    expect(r).toMatchObject({ cancelled: true, result: { rowCount: 3, truncated: true } });
    expect(cut.log).toEqual(['BEGIN', 'EXEC SELECT 1', 'CANCEL', 'ROLLBACK']);
    const two = fakeMs([[1, 'a']], { sets: 2 });
    await expect(mssqlRun(two.conn, two.lib, { sql: 'SELECT 1', params: [], trusted: false }, LIMITS, never)).rejects.toMatchObject({
      code: 'DB_MULTIPLE_RESULTS',
    });
    expect(two.log.at(-1)).toBe('ROLLBACK');
    const err = fakeMs([], { error: Object.assign(new Error("The SELECT permission was denied on the object 'orders'"), { number: 229 }) });
    const e = await mssqlRun(err.conn, err.lib, { sql: 'SELECT 1', params: [], trusted: false }, LIMITS, never).catch((x) => x);
    expect(mapDriverError('sqlserver', e, 'query').code).toBe('DB_PERMISSION_DENIED');
    expect(err.log.at(-1)).toBe('ROLLBACK');
  });
});

// ---------- catalog ----------

describe('catalog queries (catalog.ts)', () => {
  it('has a statement for every catalog and flavour, none of them changing anything', () => {
    for (const name of DB_CATALOGS)
      for (const flavour of ['postgresql', 'mysql', 'mariadb', 'sqlserver'] as const) {
        const sql = catalogSql(name, { flavour });
        expect(sql.length, `${name}/${flavour}`).toBeGreaterThan(10);
        // Steward's own statements pass the check too (SHOW REPLICA STATUS is the one exception)
        if (!sql.startsWith('SHOW')) {
          const dialect = flavour === 'mariadb' ? 'mysql' : flavour;
          expect(readOnlyStatementProblem(sql, dialect), `${name}/${flavour}`).toBeNull();
        }
      }
  });

  it('quotes the generated statements for each DBMS', () => {
    expect(pgIdent('we"ird')).toBe('"we""ird"');
    expect(msIdent('a]b')).toBe('[a]]b]');
    expect(myAccount('a`b', '%')).toBe('`a``b`@`%`');
    const [pg] = mapCatalogRows('role-members', { flavour: 'postgresql' }, [{ scope: 'server', role_name: 'app"; DROP', member: 'x', member_type: 'user' }], {
      database: 'd',
    });
    expect(pg!.revoke).toBe('REVOKE "app""; DROP" FROM "x";');
    const [ms] = mapCatalogRows(
      'role-members',
      { flavour: 'sqlserver' },
      [{ scope: 'database', role_name: 'db_datawriter', member: 'svc]x', member_type: 'SQL_USER' }],
      {
        database: 'd',
      },
    );
    expect(ms).toMatchObject({ scope: 'database', memberType: 'sql user', revoke: 'ALTER ROLE [db_datawriter] DROP MEMBER [svc]]x];' });
    const [my] = mapCatalogRows(
      'role-members',
      { flavour: 'mysql' },
      [{ scope: 'server', role_name: 'app_read', role_host: '%', member: 'ana', member_host: '10.%' }],
      {
        database: 'd',
      },
    );
    expect(my).toMatchObject({ member: 'ana@10.%', revoke: 'REVOKE `app_read`@`%` FROM `ana`@`10.%`;' });
    const [maria] = mapCatalogRows(
      'role-members',
      { flavour: 'mariadb' },
      [{ scope: 'server', role_name: 'app_read', member: 'ana', member_host: 'localhost', member_type: 'user' }],
      {
        database: 'd',
      },
    );
    expect(maria!.revoke).toBe('REVOKE `app_read` FROM `ana`@`localhost`;');
  });

  it('maps privileges and writes their REVOKE statements', () => {
    const pg = mapCatalogRows(
      'privileges',
      { flavour: 'postgresql' },
      [
        { grantee: 'PUBLIC', privilege: 'SELECT', object_type: 'table', schema_name: 'public', object_name: 'customers', grantable: false },
        { grantee: 'reader', privilege: 'USAGE', object_type: 'schema', schema_name: 'sales', object_name: null, grantable: true },
        { grantee: 'reader', privilege: 'CONNECT', object_type: 'database', schema_name: null, object_name: 'shop' },
        { grantee: 'x', privilege: 'SELECT; DROP', object_type: 'table', schema_name: 's', object_name: 't' },
      ],
      { database: 'shop' },
    );
    expect(pg.map((r) => r.revoke)).toEqual([
      'REVOKE SELECT ON TABLE "public"."customers" FROM PUBLIC;',
      'REVOKE USAGE ON SCHEMA "sales" FROM "reader";',
      'REVOKE CONNECT ON DATABASE "shop" FROM "reader";',
      // a privilege name that is not one: no statement
      null,
    ]);
    const my = mapCatalogRows(
      'privileges',
      { flavour: 'mysql' },
      [{ grantee: "'o''neil'@'%'", privilege: 'SELECT', object_type: 'table', schema_name: 'shop', object_name: 'orders' }],
      {
        database: 'shop',
      },
    );
    expect(my[0]).toMatchObject({ grantee: "o'neil@%", revoke: "REVOKE SELECT ON `shop`.`orders` FROM `o'neil`@`%`;" });
    const ms = mapCatalogRows(
      'privileges',
      { flavour: 'sqlserver' },
      [
        { grantee: 'app', privilege: 'SELECT', object_type: 'SCHEMA', schema_name: 'dbo', object_name: null, state: 'GRANT' },
        { grantee: 'app', privilege: 'DELETE', object_type: 'OBJECT_OR_COLUMN', schema_name: 'dbo', object_name: 'orders', state: 'DENY' },
      ],
      { database: 'shop' },
    );
    expect(ms.map((r) => [r.privilege, r.revoke])).toEqual([
      ['SELECT', 'REVOKE SELECT ON SCHEMA::[dbo] FROM [app];'],
      ['DENY DELETE', 'REVOKE DELETE ON [dbo].[orders] FROM [app];'],
    ]);
  });

  it('maps accounts and replication the same way for every DBMS', () => {
    const [root] = mapCatalogRows(
      'accounts',
      { flavour: 'mysql' },
      [
        {
          name: 'root',
          host: 'localhost',
          can_login: 1,
          superuser: 1,
          admin: 1,
          locked: 0,
          password_changed_at: '2020-01-01T00:00:00.000Z',
          password_expired: 0,
          roles: 'r1@%,r2@%',
        },
      ],
      { database: 'd' },
    );
    expect(root).toMatchObject({
      defaultAccount: true,
      superuser: true,
      canLogin: true,
      roles: ['r1@%', 'r2@%'],
      disable: 'ALTER USER `root`@`localhost` ACCOUNT LOCK;',
    });
    const [sa] = mapCatalogRows('accounts', { flavour: 'sqlserver' }, [{ name: 'sa', can_login: true, superuser: true, locked: false }], { database: 'd' });
    expect(sa).toMatchObject({ defaultAccount: true, disable: 'ALTER LOGIN [sa] DISABLE;' });
    const [pg] = mapCatalogRows('accounts', { flavour: 'postgresql' }, [{ name: 'app', can_login: true, roles: '{shop_reader,"odd name"}' }], {
      database: 'd',
    });
    expect(pg).toMatchObject({ defaultAccount: false, roles: ['shop_reader', 'odd name'], disable: 'ALTER ROLE "app" NOLOGIN;' });
    const [rep] = mapCatalogRows(
      'replication',
      { flavour: 'mariadb' },
      [{ Master_Host: 'db1', Slave_IO_Running: 'Yes', Slave_SQL_Running: 'Yes', Seconds_Behind_Master: '4' }],
      {
        database: 'd',
      },
    );
    expect(rep).toEqual({ role: 'replica', name: 'db1', state: 'IO Yes, SQL Yes', lagSeconds: 4 });
    const [rep8] = mapCatalogRows('replication', { flavour: 'mysql' }, [{ Source_Host: 'db2', Seconds_Behind_Source: null }], { database: 'd' });
    expect(rep8!.lagSeconds).toBeNull();
    expect(Object.keys(CATALOG)).toEqual([...DB_CATALOGS]);
  });
});

// ---------- the rest ----------

describe('limits, values, errors and the pool', () => {
  it('takes the platform’s limits as the ceiling', () => {
    expect(effectiveDbLimits(undefined)).toEqual({ timeoutSeconds: 30, maxRows: 1000, maxMb: 5, truncate: false });
    expect(effectiveDbLimits({ maxRows: 200 }, { maxRows: 5000, onLimit: 'truncate' })).toMatchObject({ maxRows: 200, truncate: true });
    expect(effectiveDbLimits({ maxRows: 200 }, { maxRows: 50 }).maxRows).toBe(50);
    expect(effectiveDbLimits({ timeoutSeconds: 300 }, { timeoutSeconds: 900 }).timeoutSeconds).toBe(300);
  });

  it('binds only scalars (lists on PostgreSQL)', () => {
    expect(bindValue('x', 'mysql', 0)).toBe('x');
    expect(bindValue(true, 'mysql', 0)).toBe(1);
    expect(bindValue(undefined, 'sqlserver', 0)).toBeNull();
    expect(bindValue(['a', 1], 'postgresql', 0)).toEqual(['a', 1]);
    expect(() => bindValue(['a'], 'mysql', 0)).toThrow(DbError);
    expect(() => bindValue({ a: 1 }, 'postgresql', 2)).toThrow(/Parameter 3 is an object/);
    expect(() => bindValue(Number.NaN, 'postgresql', 0)).toThrow(/finite/);
    expect(() => bindValue('x'.repeat(20_000), 'postgresql', 0)).toThrow(/longer/);
  });

  it('maps driver errors to stable codes', () => {
    expect(mapDriverError('postgresql', Object.assign(new Error('password authentication failed for user "x"'), { code: '28P01' }), 'connect').code).toBe(
      'DB_AUTH_FAILED',
    );
    expect(mapDriverError('postgresql', Object.assign(new Error('cannot execute INSERT in a read-only transaction'), { code: '25006' }), 'query').code).toBe(
      'DB_READ_ONLY_VIOLATION',
    );
    expect(mapDriverError('postgresql', Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }), 'query').statusCode).toBe(
      504,
    );
    expect(mapDriverError('mysql', Object.assign(new Error('Access denied'), { errno: 1045 }), 'connect').code).toBe('DB_AUTH_FAILED');
    expect(mapDriverError('sqlserver', Object.assign(new Error('Login failed'), { code: 'ELOGIN' }), 'connect').code).toBe('DB_AUTH_FAILED');
    expect(mapDriverError('postgresql', Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }), 'connect').code).toBe(
      'DB_CONNECT_FAILED',
    );
    expect(mapDriverError('postgresql', new Error('self-signed certificate in certificate chain'), 'connect').code).toBe('DB_TLS_FAILED');
    expect(mapDriverError('mysql', new Error('weird'), 'query')).toMatchObject({ code: 'DB_QUERY_FAILED', params: { detail: 'weird' } });
  });

  it('keeps cells as JSON and names duplicate columns apart', () => {
    expect(cellValue(10n)).toBe(10);
    expect(cellValue(2n ** 70n)).toBe('1180591620717411303424');
    expect(cellValue(new Date('2026-01-02T03:04:05Z'))).toBe('2026-01-02T03:04:05.000Z');
    expect(cellValue(Buffer.from('hi'))).toBe('base64:aGk=');
    const c = new RowCollector(LIMITS);
    c.setColumns(['id', 'id', '', '__proto__']);
    c.add([1, 2, 3, 4]);
    expect(c.columns).toEqual(['id', 'id_2', 'column', '__proto__']);
    expect(Object.getPrototypeOf(c.rows[0])).toBe(Object.prototype);
    expect(Object.keys(c.rows[0]!)).toEqual(['id', 'id_2', 'column', '__proto__']);
  });

  it('pools a few connections, drops unusable ones and closes', async () => {
    let opened = 0;
    let closed = 0;
    const make = (): DriverConnection => {
      opened++;
      const c = { usable: true, server: { flavour: 'postgresql' as const, version: '' }, run: async () => ({}) as never, close: async () => void closed++ };
      return c;
    };
    const pool = new ConnectionPool(async () => make(), 2, 50);
    const a = await pool.acquire(never);
    const b = await pool.acquire(never);
    let third: DriverConnection | null = null;
    const waiting = pool.acquire(never).then((c) => (third = c));
    await new Promise((r) => setTimeout(r, 10));
    expect(third).toBeNull();
    pool.release(a);
    await waiting;
    expect(third).toBe(a);
    expect(opened).toBe(2);
    (b as { usable: boolean }).usable = false;
    pool.release(b);
    expect(closed).toBe(1);
    pool.release(third!);
    // idle connections are closed after the idle time
    await new Promise((r) => setTimeout(r, 120));
    expect(closed).toBe(2);
    expect(pool.stats).toMatchObject({ open: 0, idle: 0 });
    await pool.close();
    await expect(pool.acquire(never)).rejects.toMatchObject({ code: 'DB_CONNECT_FAILED' });
  });
});

describe('Steward’s own database server (own.ts) and redaction', () => {
  const own = ownDatabaseEndpoint({ kind: 'postgres', url: 'postgres://steward:pw@db.internal:5544/steward', schema: 'public' })!;
  const lookup: AddressLookup = async (h) =>
    ({ 'db.internal': ['10.9.8.7'], 'db-alias.internal': ['10.9.8.7'], localhost: ['127.0.0.1', '::1'], 'other.internal': ['10.9.8.6'] })[h] ??
    (net.isIP(h) ? [h] : []);

  it('reads host and port from the database URL (SQLite has none)', () => {
    expect(own).toEqual({ hosts: ['db.internal'], port: 5544, database: 'steward' });
    expect(ownDatabaseEndpoint({ kind: 'sqlite', file: 'x.db' })).toBeNull();
    expect(ownDatabaseEndpoint({ kind: 'postgres', url: 'postgres://u@/steward?host=/var/run/postgresql', schema: 'public' })).toEqual({
      hosts: ['localhost'],
      port: 5432,
      database: 'steward',
    });
    expect(ownDatabaseEndpoint({ kind: 'postgres', url: 'postgres://u@[::1]/s', schema: 'public' })).toEqual({ hosts: ['::1'], port: 5432, database: 's' });
    // no database in the URL: PostgreSQL's default, the user name
    expect(ownDatabaseEndpoint({ kind: 'postgres', url: 'postgres://app@db.internal', schema: 'public' })?.database).toBe('app');
  });

  it('refuses Steward’s database on the same server by name or address, and every local address for a local server', async () => {
    for (const host of ['db.internal', 'DB.internal', 'db-alias.internal', '10.9.8.7'])
      await expect(assertNotOwnDatabase(host, 5544, 'steward', own, lookup), host).rejects.toMatchObject({ code: 'DB_OWN_DATABASE', statusCode: 403 });
    await expect(assertNotOwnDatabase('db.internal', 5545, 'steward', own, lookup)).resolves.toBeUndefined();
    await expect(assertNotOwnDatabase('other.internal', 5544, 'steward', own, lookup)).resolves.toBeUndefined();
    // another database on Steward's server is allowed (no queries across databases; dblink is refused)
    for (const host of ['db.internal', '10.9.8.7']) await expect(assertNotOwnDatabase(host, 5544, 'shop', own, lookup), host).resolves.toBeUndefined();
    // names are compared as the server does: exactly
    await expect(assertNotOwnDatabase('db.internal', 5544, 'Steward', own, lookup)).resolves.toBeUndefined();
    const local = ownDatabaseEndpoint({ kind: 'postgres', url: 'postgres://u@localhost:5432/s', schema: 'public' })!;
    for (const host of ['127.0.0.1', '127.0.0.2', '::1', '0.0.0.0', 'localhost'])
      await expect(assertNotOwnDatabase(host, 5432, 's', local, lookup), host).rejects.toMatchObject({ code: 'DB_OWN_DATABASE' });
    await expect(assertNotOwnDatabase('127.0.0.1', 5432, 'shop', local, lookup)).resolves.toBeUndefined();
    expect(await isOwnDatabase(['10.9.8.6'], 5432, local, lookup)).toBe(false);
    expect(await isOwnDatabase(['127.0.0.1'], 5432, null, lookup)).toBe(false);
  });

  it('masks the platform’s secrets in driver errors', () => {
    const secrets = { username: 'reader', password: 'S3cret-pass' };
    const e = redactDbError(new DbError('DB_QUERY_FAILED', 'syntax error at "S3cret-pass"', { detail: 'near "S3cret-pass"' }), secrets) as DbError;
    expect(e.message).toBe('syntax error at "***"');
    expect(e.params).toEqual({ detail: 'near "***"' });
    expect((redactDbError(new Error('x S3cret-pass'), secrets) as Error).message).toBe('x ***');
    // the driver's message is masked before it is cut to one line of 500 characters (a cut secret would stay half visible)
    const long = mapDriverError('postgresql', new Error(`${'x'.repeat(495)} S3cret-pass`), 'query', ['S3cret-pass']);
    expect(long.message).not.toContain('S3cr');
    expect(long.params).toEqual({ detail: `${'x'.repeat(495)} ***` });
  });
});
