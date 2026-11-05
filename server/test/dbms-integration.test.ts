import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_KIND, type DbDialect } from '@sm/shared';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Database platforms against real servers (#203, ADR 0008). Each DBMS runs when its admin URL is set and is skipped
 * otherwise; the test creates its own database, a read-only account and an account that may write, and removes them:
 *
 * - PostgreSQL: SM_TEST_DATABASE_URL (the suite's PostgreSQL, `npm run test:pg`), or SM_TEST_PG_ADMIN_URL;
 * - MariaDB/MySQL: SM_TEST_MYSQL_URL, e.g. mysql://root:secret@127.0.0.1:3306/
 * - SQL Server: SM_TEST_MSSQL_URL, e.g. mssql://sa:Secret-1@127.0.0.1:1433/
 *
 * Checks: the connection test (read-only session, a writing account found), own SQL with bound parameters, the catalog
 * queries with their generated statements, writes refused by the session even for an account that may write (a
 * function that writes on PostgreSQL and MariaDB/MySQL; SQL Server rolls back), the row limit and the time limit, the
 * outbound policy, and that the password never reaches the run.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const require = createRequire(import.meta.url);
const suffix = crypto.randomBytes(3).toString('hex');
const RO_PW = `Ro-${crypto.randomBytes(9).toString('hex')}-1a`;
const RW_PW = `Rw-${crypto.randomBytes(9).toString('hex')}-1a`;

interface Target {
  dialect: DbDialect;
  host: string;
  port: number;
  database: string;
  ro: string;
  rw: string;
  /** Rows in the orders table (also after every test: nothing may change them) */
  count: () => Promise<number>;
  cleanup: () => Promise<void>;
  /** A statement that writes through a function the statement check cannot see (null: SQL Server has none) */
  writingSelect: string | null;
  sleep: string;
  placeholder: string;
}

const URLS: Record<DbDialect, string | undefined> = {
  postgresql: process.env.SM_TEST_PG_ADMIN_URL || process.env.SM_TEST_DATABASE_URL || undefined,
  mysql: process.env.SM_TEST_MYSQL_URL || undefined,
  sqlserver: process.env.SM_TEST_MSSQL_URL || undefined,
};

// ---------- set-up per DBMS (admin connections, not Steward's code) ----------

async function pgTarget(url: string): Promise<Target> {
  const pg = require('pg') as typeof import('pg');
  const u = new URL(url);
  const admin = (database: string) =>
    new pg.Client({ host: u.hostname, port: Number(u.port || 5432), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database });
  const database = `steward_it_${suffix}`;
  const ro = `steward_ro_${suffix}`;
  const rw = `steward_rw_${suffix}`;
  const writer = `shop_writer_${suffix}`;
  const root = admin(u.pathname.slice(1) || 'postgres');
  await root.connect();
  await root.query(`CREATE DATABASE ${database}`);
  await root.query(`CREATE ROLE ${ro} LOGIN PASSWORD '${RO_PW}'`);
  await root.query(`CREATE ROLE ${rw} LOGIN PASSWORD '${RW_PW}'`);
  await root.query(`CREATE ROLE ${writer} NOLOGIN`);
  await root.end();
  const c = admin(database);
  await c.connect();
  for (const sql of [
    `CREATE TABLE orders (id int PRIMARY KEY, customer text, total numeric)`,
    `INSERT INTO orders SELECT g, 'customer-' || g, g * 1.5 FROM generate_series(1, 3000) g`,
    `CREATE SEQUENCE order_numbers`,
    `CREATE FUNCTION add_order() RETURNS int LANGUAGE sql VOLATILE AS 'INSERT INTO orders VALUES (99999, ''x'', 1) RETURNING id'`,
    `GRANT CONNECT ON DATABASE ${database} TO ${ro}, ${rw}`,
    `GRANT USAGE ON SCHEMA public TO ${ro}, ${rw}`,
    `GRANT SELECT ON orders TO ${ro}`,
    `GRANT pg_read_all_stats TO ${ro}`,
    `GRANT SELECT, INSERT, UPDATE ON orders TO ${writer}`,
    `GRANT USAGE ON SEQUENCE order_numbers TO ${writer}`,
    `GRANT ${writer} TO ${rw}`,
  ])
    await c.query(sql);
  return {
    dialect: 'postgresql',
    host: u.hostname,
    port: Number(u.port || 5432),
    database,
    ro,
    rw,
    count: async () => Number((await c.query('SELECT count(*) AS n FROM orders')).rows[0].n),
    writingSelect: 'SELECT add_order()',
    sleep: 'SELECT pg_sleep(5)',
    placeholder: '$1',
    cleanup: async () => {
      await c.end();
      const r = admin(u.pathname.slice(1) || 'postgres');
      await r.connect();
      await r.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      for (const role of [rw, ro, writer]) await r.query(`DROP ROLE IF EXISTS ${role}`);
      await r.end();
    },
  };
}

async function mysqlTarget(url: string): Promise<Target> {
  const mysql = require('mysql2/promise') as typeof import('mysql2/promise');
  const u = new URL(url);
  const c = await mysql.createConnection({
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
  });
  const database = `steward_it_${suffix}`;
  const ro = `steward_ro_${suffix}`;
  const rw = `steward_rw_${suffix}`;
  const writer = `shop_writer_${suffix}`;
  // the least-privilege grants of docs/DATABASES.md, per flavour
  const [[{ v }]] = (await c.query('SELECT VERSION() AS v')) as unknown as [[{ v: string }]];
  const maria = /mariadb/i.test(v);
  const catalogGrants = maria
    ? ['mysql.user', 'mysql.global_priv', 'mysql.roles_mapping', 'mysql.db', 'mysql.tables_priv']
        .map((t) => `GRANT SELECT ON ${t} TO '${ro}'@'%'`)
        .concat(`GRANT REPLICA MONITOR ON *.* TO '${ro}'@'%'`)
    : ['mysql.user', 'mysql.role_edges', 'mysql.db', 'mysql.tables_priv']
        .map((t) => `GRANT SELECT ON ${t} TO '${ro}'@'%'`)
        .concat(`GRANT REPLICATION CLIENT ON *.* TO '${ro}'@'%'`);
  for (const sql of [
    `CREATE DATABASE ${database}`,
    `CREATE TABLE ${database}.orders (id int PRIMARY KEY, customer varchar(40), total decimal(10,2))`,
    `INSERT INTO ${database}.orders WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 3000) SELECT n, CONCAT('customer-', n), n * 1.5 FROM g`,
    `CREATE FUNCTION ${database}.add_order() RETURNS int MODIFIES SQL DATA BEGIN INSERT INTO orders VALUES (99999, 'x', 1); RETURN 1; END`,
    `CREATE USER '${ro}'@'%' IDENTIFIED BY '${RO_PW}'`,
    `CREATE USER '${rw}'@'%' IDENTIFIED BY '${RW_PW}'`,
    `CREATE ROLE ${writer}`,
    `GRANT SELECT ON ${database}.* TO '${ro}'@'%'`,
    ...catalogGrants,
    `GRANT SELECT, INSERT, UPDATE, EXECUTE ON ${database}.* TO '${rw}'@'%'`,
    `GRANT INSERT ON ${database}.orders TO ${writer}`,
    `GRANT ${writer} TO '${rw}'@'%'`,
  ])
    await c.query(sql);
  return {
    dialect: 'mysql',
    host: u.hostname,
    port: Number(u.port || 3306),
    database,
    ro,
    rw,
    count: async () => Number(((await c.query(`SELECT count(*) AS n FROM ${database}.orders`)) as [{ n: number }[], unknown])[0][0]!.n),
    writingSelect: 'SELECT add_order()',
    sleep: 'SELECT SLEEP(5)',
    placeholder: '?',
    cleanup: async () => {
      for (const sql of [
        `DROP DATABASE IF EXISTS ${database}`,
        `DROP USER IF EXISTS '${ro}'@'%'`,
        `DROP USER IF EXISTS '${rw}'@'%'`,
        `DROP ROLE IF EXISTS ${writer}`,
      ])
        await c.query(sql);
      await c.end();
    },
  };
}

async function mssqlTarget(url: string): Promise<Target> {
  const tedious = require('tedious') as typeof import('tedious');
  const u = new URL(url);
  const open = (database: string) =>
    new Promise<import('tedious').Connection>((resolve, reject) => {
      const c = new tedious.Connection({
        server: u.hostname,
        authentication: { type: 'default', options: { userName: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } },
        options: { port: Number(u.port || 1433), database, encrypt: true, trustServerCertificate: true },
      });
      c.connect((e) => (e ? reject(e) : resolve(c)));
    });
  const exec = (c: import('tedious').Connection, sql: string) =>
    new Promise<unknown[][]>((resolve, reject) => {
      const rows: unknown[][] = [];
      const r = new tedious.Request(sql, (e) => (e ? reject(e) : resolve(rows)));
      r.on('row', (cols: { value: unknown }[]) => rows.push(cols.map((x) => x.value)));
      c.execSqlBatch(r);
    });
  const database = `steward_it_${suffix}`;
  const ro = `steward_ro_${suffix}`;
  const rw = `steward_rw_${suffix}`;
  const master = await open('master');
  await exec(master, `CREATE DATABASE ${database}`);
  await exec(master, `CREATE LOGIN ${ro} WITH PASSWORD = '${RO_PW}', CHECK_POLICY = OFF`);
  await exec(master, `CREATE LOGIN ${rw} WITH PASSWORD = '${RW_PW}', CHECK_POLICY = OFF`);
  await exec(master, `GRANT VIEW SERVER STATE TO ${ro}; GRANT VIEW ANY DEFINITION TO ${ro}`);
  const c = await open(database);
  for (const sql of [
    `CREATE TABLE orders (id int PRIMARY KEY, customer nvarchar(40), total decimal(10,2))`,
    `WITH g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 3000) INSERT INTO orders SELECT n, CONCAT('customer-', n), n * 1.5 FROM g OPTION (MAXRECURSION 3000)`,
    `CREATE USER ${ro} FOR LOGIN ${ro}`,
    `CREATE USER ${rw} FOR LOGIN ${rw}`,
    `ALTER ROLE db_datareader ADD MEMBER ${ro}`,
    `ALTER ROLE db_datareader ADD MEMBER ${rw}`,
    `ALTER ROLE db_datawriter ADD MEMBER ${rw}`,
  ])
    await exec(c, sql);
  return {
    dialect: 'sqlserver',
    host: u.hostname,
    port: Number(u.port || 1433),
    database,
    ro,
    rw,
    count: async () => Number((await exec(c, 'SELECT count(*) FROM orders'))[0]![0]),
    writingSelect: null,
    sleep: 'SELECT 1 AS slept FROM orders WHERE id = 1',
    placeholder: '@p1',
    cleanup: async () => {
      c.close();
      await exec(master, `ALTER DATABASE ${database} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${database}`);
      await exec(master, `DROP LOGIN ${ro}; DROP LOGIN ${rw}`);
      master.close();
    },
  };
}

const FACTORIES: Record<DbDialect, (url: string) => Promise<Target>> = { postgresql: pgTarget, mysql: mysqlTarget, sqlserver: mssqlTarget };

let s: TestServer;
const DONE = ['succeeded', 'failed', 'cancelled', 'waiting'];
const n = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, ...extra });

beforeAll(async () => {
  if (!Object.values(URLS).some(Boolean)) return;
  s = await startTestServer();
  await setup(s);
}, 60_000);
afterAll(async () => {
  await s?.app.close();
  await (await import('../src/dbms/pool.js')).closeAllPools();
});

for (const dialect of ['postgresql', 'mysql', 'sqlserver'] as DbDialect[]) {
  describe.skipIf(!URLS[dialect])(`${dialect} (real server)`, () => {
    let t: Target;
    let ro: any;
    let rw: any;
    let before = 0;

    const platform = async (name: string, user: string, password: string) =>
      s.api('POST', '/platforms', {
        name,
        kind: DATABASE_KIND,
        config: {
          auth: { type: 'none' },
          variables: {},
          http: {},
          // the test servers speak plain TCP or TLS with a self-signed certificate
          database: { dialect, host: t.host, port: t.port, database: t.database, tls: { mode: dialect === 'sqlserver' ? 'require' : 'off' } },
        },
        secrets: { username: user, password },
      });
    const processWith = (name: string, nodes: unknown[]) => {
      const ids = (nodes as { id: string }[]).map((x) => x.id);
      return s.api('POST', '/processes', {
        definition: {
          name: `${name} (${dialect})`,
          connections: [{ slot: 'db', kind: DATABASE_KIND }],
          nodes: [n('start', 'start'), ...nodes],
          wires: ['start', ...ids].slice(0, -1).map((from, i) => ({ from, to: ids[i]!, port: 'out' })),
        },
      });
    };
    const run = async (processId: string, platformId: string) => {
      const { id } = await s.api('POST', '/runs', { processId, bindings: { db: platformId } });
      return s.waitRun(id, DONE);
    };
    const stepOf = async (runId: string, stepId: string) => {
      const d = await s.api('GET', `/runs/${runId}`);
      const st = d.steps.find((x: any) => x.stepId === stepId);
      return s.api('GET', `/runs/${runId}/steps/${st.id}`);
    };

    beforeAll(async () => {
      t = await FACTORIES[dialect](URLS[dialect]!);
      before = await t.count();
      ro = await platform(`DB ro ${dialect}`, t.ro, RO_PW);
      rw = await platform(`DB rw ${dialect}`, t.rw, RW_PW);
    }, 120_000);
    afterAll(async () => {
      await t?.cleanup();
    }, 60_000);

    it('tests the connection and finds an account that can write', async () => {
      const r = await s.api('POST', `/platforms/${ro.id}/test`);
      expect(r.ok, r.message).toBe(true);
      const checks = Object.fromEntries(r.checks.map((c: any) => [c.name, c]));
      expect(checks['Sign-in'].ok).toBe(true);
      expect(checks['Read-only'].ok).toBe(true);
      expect(checks.Account.ok, checks.Account.message).toBe(true);
      expect(checks['Catalog: accounts'].ok, checks['Catalog: accounts'].message).toBe(true);
      const w = await s.api('POST', `/platforms/${rw.id}/test`);
      expect(w.ok).toBe(true);
      expect(w.message).toContain('the account can write');
    });

    it('runs own SQL with bound parameters and the catalog queries', async () => {
      const p = await processWith('read', [
        n('own', 'query', {
          connection: 'db',
          dialect,
          sql: `SELECT id, customer FROM orders WHERE customer = ${t.placeholder}`,
          params: ["customer-7' OR '1'='1"],
          saveAs: 'own',
        }),
        n('own2', 'query', { connection: 'db', sql: `SELECT id, customer FROM orders WHERE id = ${t.placeholder}`, params: ['{{ 3 + 4 }}'], saveAs: 'own2' }),
        n('status', 'query', { connection: 'db', catalog: 'status' }),
        n('accounts', 'query', { connection: 'db', catalog: 'accounts' }),
        n('members', 'query', { connection: 'db', catalog: 'role-members' }),
        n('privileges', 'query', { connection: 'db', catalog: 'privileges' }),
        n('tables', 'query', { connection: 'db', catalog: 'tables' }),
        n('replication', 'query', { connection: 'db', catalog: 'replication', onError: 'continue' }),
      ]);
      const r = await run(p.id, ro.id);
      expect(r.status, JSON.stringify(r.error ?? r)).toBe('succeeded');
      // the injection attempt is a value: no row matches it
      expect((await stepOf(r.id, 'own')).output).toMatchObject({ rowCount: 0 });
      expect((await stepOf(r.id, 'own2')).output.rows).toEqual([{ id: 7, customer: 'customer-7' }]);
      const status = (await stepOf(r.id, 'status')).output.rows[0];
      expect(status).toMatchObject({ readOnly: dialect !== 'sqlserver', canWrite: false });
      const accounts = (await stepOf(r.id, 'accounts')).output.rows as any[];
      // the platform's own user name is one of its credentials: masked in the run like every credential
      expect(accounts.some((a) => a.name === t.ro)).toBe(false);
      expect(
        accounts.some((a) => a.name === '***' && a.canLogin),
        JSON.stringify(accounts),
      ).toBe(true);
      expect(accounts.find((a) => a.name === t.rw)?.disable).toBeTruthy();
      const tables = (await stepOf(r.id, 'tables')).output.rows as any[];
      expect(tables.find((x) => x.name === 'orders')).toMatchObject({ type: 'table' });
      const members = (await stepOf(r.id, 'members')).output.rows as any[];
      const privileges = (await stepOf(r.id, 'privileges')).output.rows as any[];
      if (dialect === 'postgresql') {
        expect(members.find((m) => m.member === t.rw && m.role === `shop_writer_${suffix}`)?.revoke).toBe(`REVOKE "shop_writer_${suffix}" FROM "${t.rw}";`);
        expect(privileges.find((x) => x.grantee === `shop_writer_${suffix}` && x.privilege === 'INSERT')?.revoke).toBe(
          `REVOKE INSERT ON TABLE "public"."orders" FROM "shop_writer_${suffix}";`,
        );
      } else if (dialect === 'mysql') {
        expect(members.find((m) => m.member.startsWith(`${t.rw}@`))?.revoke).toMatch(new RegExp(`^REVOKE \`shop_writer_${suffix}\``));
        expect(privileges.find((x) => x.grantee === `${t.rw}@%` && x.privilege === 'INSERT')?.revoke).toBe(
          `REVOKE INSERT ON \`${t.database}\`.* FROM \`${t.rw}\`@\`%\`;`,
        );
      } else {
        expect(members.find((m) => m.member === t.rw && m.role === 'db_datawriter')?.revoke).toBe(`ALTER ROLE [db_datawriter] DROP MEMBER [${t.rw}];`);
      }
      expect(JSON.stringify(await s.api('GET', `/runs/${r.id}`))).not.toContain(RO_PW);
      expect(await t.count()).toBe(before);
    });

    it('refuses writes in the session, even for an account that may write', async () => {
      const { runQuery } = await import('../src/dbms/service.js');
      const { getPlatform, getSecrets } = await import('../src/platforms/service.js');
      const p = getPlatform(rw.id);
      if (t.writingSelect) {
        // passes the statement check: the read-only transaction refuses it
        const e = await runQuery(p, getSecrets(rw.id), { sql: t.writingSelect }, AbortSignal.timeout(30_000)).catch((x) => x);
        expect(e.code, e.message).toBe('DB_READ_ONLY_VIOLATION');
      }
      if (dialect === 'postgresql') {
        const e = await runQuery(p, getSecrets(rw.id), { sql: "SELECT nextval('order_numbers')" }, AbortSignal.timeout(30_000)).catch((x) => x);
        expect(e.code).toBe('DB_READ_ONLY_VIOLATION');
      }
      // below the statement check: the session itself (a statement Steward would never send)
      const { postgresDriver } = await import('../src/dbms/postgres.js');
      const { mysqlDriver } = await import('../src/dbms/mysql.js');
      const { sqlserverDriver } = await import('../src/dbms/sqlserver.js');
      const driver = { postgresql: postgresDriver, mysql: mysqlDriver, sqlserver: sqlserverDriver }[dialect];
      const conn = await driver.connect(
        {
          dialect,
          host: t.host,
          port: t.port,
          database: t.database,
          user: t.rw,
          password: RW_PW,
          tls: { mode: dialect === 'sqlserver' ? 'require' : 'off' },
          connectTimeoutMs: 10_000,
          socket: () => net.connect({ host: t.host, port: t.port }),
        },
        AbortSignal.timeout(30_000),
      );
      const write =
        dialect === 'postgresql' ? 'WITH d AS (DELETE FROM orders RETURNING id) SELECT count(*) FROM d' : "INSERT INTO orders VALUES (99998, 'x', 1)";
      const res = await conn
        .run({ sql: write, params: [], trusted: true }, { maxRows: 10, maxBytes: 100_000, timeoutMs: 10_000, truncate: false }, AbortSignal.timeout(30_000))
        .catch((x) => x);
      // SQL Server has no read-only transaction: the statement runs and is rolled back
      if (dialect !== 'sqlserver') expect(res).toBeInstanceOf(Error);
      await conn.close();
      expect(await t.count()).toBe(before);
    });

    it('enforces the row limit and the time limit', async () => {
      const p = await processWith('limits', [
        n('all', 'query', { connection: 'db', sql: 'SELECT id FROM orders ORDER BY id', maxRows: 100, onError: 'continue' }),
        n('cut', 'query', { connection: 'db', sql: 'SELECT id FROM orders ORDER BY id', maxRows: 100, onLimit: 'truncate', saveAs: 'cut' }),
      ]);
      const r = await run(p.id, ro.id);
      expect((await stepOf(r.id, 'all')).error).toContain('more than 100 rows');
      expect((await stepOf(r.id, 'cut')).output).toMatchObject({ rowCount: 100, truncated: true });
      expect((await stepOf(r.id, 'cut')).output.rows[99]).toEqual({ id: 100 });
      if (dialect !== 'sqlserver') {
        const { runQuery } = await import('../src/dbms/service.js');
        const { getPlatform, getSecrets } = await import('../src/platforms/service.js');
        const t0 = Date.now();
        const e = await runQuery(getPlatform(ro.id), getSecrets(ro.id), { sql: t.sleep, limits: { timeoutSeconds: 1 } }, AbortSignal.timeout(30_000)).catch(
          (x) => x,
        );
        expect(Date.now() - t0).toBeLessThan(4500);
        // MariaDB/MySQL may end SLEEP early without an error; PostgreSQL cancels the statement
        if (dialect === 'postgresql') expect(e.code).toBe('DB_TIMEOUT');
      }
    });

    it('follows the outbound policy for host:port', async () => {
      if (dialect !== 'postgresql' && URLS.postgresql) return; // once is enough
      await s.api('PUT', '/settings', { outboundPolicy: 'allowList', outboundAllowList: [] });
      try {
        const r = await s.api('POST', `/platforms/${ro.id}/test`);
        expect(r.ok).toBe(false);
        expect(r.message).toContain('Blocked by the outbound policy');
        await s.api('PUT', '/settings', { outboundAllowList: [net.isIP(t.host) ? t.host : `${t.host}:${t.port}`] });
        expect((await s.api('POST', `/platforms/${ro.id}/test`)).ok).toBe(true);
      } finally {
        await s.api('PUT', '/settings', { outboundPolicy: 'platforms', outboundAllowList: [] });
      }
    });
  });
}

it.skipIf(Object.values(URLS).some(Boolean))('runs against real servers only with SM_TEST_DATABASE_URL, SM_TEST_MYSQL_URL or SM_TEST_MSSQL_URL', () => {
  expect(true).toBe(true);
});
