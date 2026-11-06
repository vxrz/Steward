import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DATABASE_KIND } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Database platforms through the API (#203, ADR 0008), on the demo database (a fake PostgreSQL with canned catalog
 * rows): the connection settings (own route, "manage", audited, kept by the general settings form), the connection
 * test, the query step in real, dry and test runs (recorded responses), the monitor check, the MCP gateway (read-only,
 * statements checked, audited) and the templates. The drivers against real servers: dbms-integration.test.ts.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
let db: any;
let olivia: Client;
const PW = 'Demo-password-1';
const DONE = ['succeeded', 'failed', 'cancelled', 'waiting'];
const n = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, ...extra });
const w = (from: string, to: string, port = 'out') => ({ from, to, port });

async function processWith(name: string, nodes: unknown[]) {
  const ids = (nodes as { id: string }[]).map((x) => x.id);
  return s.api('POST', '/processes', {
    definition: {
      name,
      connections: [{ slot: 'db', kind: DATABASE_KIND }],
      nodes: [n('start', 'start'), ...nodes],
      wires: ['start', ...ids].slice(0, -1).map((from, i) => w(from, ids[i]!)),
    },
  });
}
const run = async (processId: string, opts: Record<string, unknown> = {}) => {
  const { id } = await s.api('POST', '/runs', { processId, bindings: { db: db.id }, ...opts });
  return s.waitRun(id, DONE);
};
const stepOf = async (runId: string, stepId: string) => {
  const d = await s.api('GET', `/runs/${runId}`);
  const st = d.steps.find((x: any) => x.stepId === stepId);
  return s.api('GET', `/runs/${runId}/steps/${st.id}`);
};

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  olivia = await s.as('olivia', PW);
  db = (await s.api('GET', '/platforms')).find((p: any) => p.kind === DATABASE_KIND);
}, 120_000);
afterAll(async () => {
  await s?.app.close();
});

describe('database platform settings', () => {
  it('has presets for PostgreSQL, MariaDB/MySQL and SQL Server', async () => {
    const presets = (await s.api('GET', '/platform-presets')).filter((p: any) => p.kind === DATABASE_KIND);
    expect(presets.map((p: any) => p.config.database.dialect)).toEqual(['postgresql', 'mysql', 'sqlserver']);
    expect(presets.every((p: any) => p.secretFields.map((f: any) => f.key).join() === 'username,password')).toBe(true);
  });

  it('changes the connection only through its own route, with the manage right, audited', async () => {
    expect(db.config.database).toMatchObject({ dialect: 'postgresql', host: 'postgres.demo.invalid', database: 'shop' });
    await expect(olivia('PUT', `/platforms/${db.id}/database`, { ...db.config.database, port: 5433 })).rejects.toMatchObject({ status: 403 });
    await expect(s.api('PUT', `/platforms/${db.id}/database`, { ...db.config.database, host: 'db.example.com:5432' })).rejects.toMatchObject({ status: 400 });
    await expect(s.api('PUT', `/platforms/${db.id}/database`, { ...db.config.database, database: 'x; DROP' })).rejects.toMatchObject({ status: 400 });
    const p = await s.api('PUT', `/platforms/${db.id}/database`, { ...db.config.database, limits: { maxRows: 500 } });
    expect(p.config.database.limits).toEqual({ maxRows: 500 });
    const [entry] = await s.api('GET', `/audit?action=platform.database_changed&entityId=${db.id}`);
    expect(entry.summary).toContain('PostgreSQL at postgres.demo.invalid:5432/shop, TLS verify');
    // the general settings form neither changes nor drops it
    const after = await s.api('PUT', `/platforms/${db.id}`, {
      name: db.name,
      config: { ...p.config, database: { dialect: 'mysql', host: 'evil.example', database: 'x' } },
    });
    expect(after.config.database).toMatchObject({ dialect: 'postgresql', host: 'postgres.demo.invalid', limits: { maxRows: 500 } });
    db = after;
  });

  it('refuses database settings on other platform kinds and invalid ones on create', async () => {
    const other = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'gatus');
    await expect(s.api('PUT', `/platforms/${other.id}/database`, db.config.database)).rejects.toMatchObject({
      status: 400,
      body: { code: 'DB_NOT_A_DATABASE' },
    });
    await expect(
      s.api('POST', '/platforms', {
        name: 'Bad DB',
        kind: DATABASE_KIND,
        config: { auth: { type: 'none' }, variables: {}, http: {}, database: { dialect: 'oracle', host: 'x', database: 'y' } },
      }),
    ).rejects.toMatchObject({ status: 400, body: { code: 'DB_SETTINGS_INVALID' } });
  });

  it('tests the connection: sign-in, read-only session, account, catalog queries', async () => {
    const r = await s.api('POST', `/platforms/${db.id}/test`);
    expect(r).toMatchObject({ ok: true, status: 0 });
    expect(r.message).toContain('Connected to PostgreSQL 16.4 (demo)');
    expect(r.checks.map((c: any) => [c.name, c.ok])).toEqual([
      ['Sign-in', true],
      ['Read-only', true],
      ['Account', true],
      ['Catalog: accounts', true],
      ['Catalog: role-members', true],
      ['Catalog: privileges', true],
      ['Catalog: replication', true],
    ]);
    const [entry] = await s.api('GET', `/audit?action=platform.tested&entityId=${db.id}`);
    expect(entry.details.ok).toBe(true);
    expect(JSON.stringify(entry)).not.toContain('demo-reader-password');
  });

  it('reports a wrong password and closes the old connections when the credentials change', async () => {
    await s.api('PUT', `/platforms/${db.id}/secrets`, { password: 'wrong-password' });
    const r = await s.api('POST', `/platforms/${db.id}/test`);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('refused the sign-in');
    expect(r.message).not.toContain('wrong-password');
    await s.api('PUT', `/platforms/${db.id}/secrets`, { password: 'demo-reader-password' });
    expect((await s.api('POST', `/platforms/${db.id}/test`)).ok).toBe(true);
  });

  it('keeps the MCP gateway read-only for database platforms', async () => {
    await expect(s.api('PUT', `/platforms/${db.id}/mcp-gateway`, { enabled: true, writes: 'confirm' })).rejects.toMatchObject({
      status: 400,
      body: { code: 'MCP_WRITES_NOT_AVAILABLE' },
    });
    expect((await s.api('PUT', `/platforms/${db.id}/mcp-gateway`, { enabled: false })).config.mcpGateway).toEqual({ enabled: false });
  });
});

describe('the query step', () => {
  it('runs catalog queries and own SQL with bound parameters, results stored like an HTTP answer', async () => {
    const p = await processWith('DB read', [
      n('acc', 'query', { connection: 'db', catalog: 'accounts', saveAs: 'acc' }),
      n('own', 'query', {
        connection: 'db',
        dialect: 'postgresql',
        sql: 'SELECT datname AS database, state, count(*) AS connections FROM pg_stat_activity WHERE backend_type = $1 AND datname IS NOT NULL GROUP BY datname, state ORDER BY datname, state',
        params: ['{{ "client " & "backend" }}'],
        saveAs: 'own',
      }),
    ]);
    const r = await run(p.id);
    expect(r.status).toBe('succeeded');
    const acc = await stepOf(r.id, 'acc');
    expect(acc.output.columns).toContain('disable');
    expect(acc.output.rows.find((x: any) => x.name === 'postgres')).toMatchObject({
      superuser: true,
      defaultAccount: true,
      disable: 'ALTER ROLE "postgres" NOLOGIN;',
    });
    expect(acc.input).toMatchObject({ platform: db.name, catalog: 'accounts' });
    expect(acc.input.statement).toContain('-- catalog query "accounts" for postgresql');
    const own = await stepOf(r.id, 'own');
    expect(own.input).toMatchObject({ params: ['client backend'], dialect: 'postgresql' });
    expect(own.output).toMatchObject({ columns: ['database', 'state', 'connections'], rowCount: 3, truncated: false });
    // the password never reaches the run
    expect(JSON.stringify(await s.api('GET', `/runs/${r.id}`))).not.toContain('demo-reader-password');
  });

  it('runs in dry runs (it only reads) and refuses what is not a single query, without connecting', async () => {
    const p = await processWith('DB dry', [n('q', 'query', { connection: 'db', catalog: 'tables', saveAs: 'q' })]);
    const dry = await run(p.id, { dryRun: true });
    expect(dry.status).toBe('succeeded');
    expect((await stepOf(dry.id, 'q')).output.rowCount).toBe(5);
    // a statement that is refused cannot even be saved …
    await expect(processWith('DB bad', [n('q', 'query', { connection: 'db', sql: 'DELETE FROM orders' })])).rejects.toMatchObject({ status: 400 });
    // … and a platform of another DBMS is refused at run time
    const mismatch = await processWith('DB mysql', [n('q', 'query', { connection: 'db', dialect: 'mysql', sql: 'SELECT 1' })]);
    const r = await run(mismatch.id);
    expect(r.status).toBe('failed');
    expect((await stepOf(r.id, 'q')).error).toContain('written for MariaDB / MySQL');
  });

  it('never sends another bound platform’s secret to the database', async () => {
    const other = await s.api('POST', '/platforms', {
      name: 'Leaky API',
      kind: 'generic',
      baseUrl: 'https://api.example.com',
      secrets: { token: 'leak-me-token-123' },
    });
    const p = await s.api('POST', '/processes', {
      definition: {
        name: 'DB leak',
        connections: [
          { slot: 'db', kind: DATABASE_KIND },
          { slot: 'api', kind: 'generic' },
        ],
        inputs: [{ name: 'value', type: 'string' }],
        nodes: [n('start', 'start'), n('q', 'query', { connection: 'db', sql: 'SELECT $1 AS v', params: ['{{ inputs.value }}'], saveAs: 'q' })],
        wires: [w('start', 'q')],
      },
    });
    const { id } = await s.api('POST', '/runs', { processId: p.id, bindings: { db: db.id, api: other.id }, inputs: { value: 'leak-me-token-123' } });
    const r = await s.waitRun(id, DONE);
    expect(r.status).toBe('failed');
    expect((await stepOf(r.id, 'q')).error).toContain('would send a secret of platform "Leaky API"');
    await s.api('DELETE', `/platforms/${other.id}`);
  });

  it('enforces the platform’s row limit as the ceiling', async () => {
    await s.api('PUT', `/platforms/${db.id}/database`, { ...db.config.database, limits: { maxRows: 3 } });
    const p = await processWith('DB limit', [
      n('fail', 'query', { connection: 'db', catalog: 'accounts', maxRows: 1000, onError: 'continue', saveAs: 'fail' }),
      n('cut', 'query', { connection: 'db', catalog: 'accounts', onLimit: 'truncate', saveAs: 'cut' }),
    ]);
    const r = await run(p.id);
    expect((await stepOf(r.id, 'fail')).error).toContain('more than 3 rows');
    expect((await stepOf(r.id, 'cut')).output).toMatchObject({ rowCount: 3, truncated: true });
    await s.api('PUT', `/platforms/${db.id}/database`, { ...db.config.database, limits: {} });
  });

  it('uses the recorded response in a test run and never connects', async () => {
    const p = await processWith('DB test run', [n('q', 'query', { connection: 'db', sql: 'SELECT name FROM customers', saveAs: 'q' })]);
    const missing = await run(p.id, { recorded: true });
    expect(missing.status).toBe('failed');
    expect((await stepOf(missing.id, 'q')).error).toContain('no recorded response for POST /sql/q');
    await s.api('POST', `/platforms/${db.id}/recordings`, { method: 'POST', path: '/sql/q', status: 200, body: { rows: [{ name: 'Recorded Ltd' }] } });
    const r = await run(p.id, { recorded: true });
    expect(r.status).toBe('succeeded');
    expect((await stepOf(r.id, 'q')).output).toMatchObject({ columns: ['name'], rows: [{ name: 'Recorded Ltd' }] });
  });
});

describe('monitor check, MCP gateway and templates', () => {
  it('checks the connection, the replication lag and a query value', async () => {
    const preview = (check: Record<string, unknown>) =>
      s.api('POST', '/monitors/check-preview', { check: { id: 'c', name: 'c', platform: db.id, type: 'database', ...check } });
    expect(await preview({ mode: 'connection' })).toMatchObject({ status: 'up' });
    const lag = await preview({ mode: 'replication', warn: 1, crit: 300 });
    expect(lag.status).toBe('degraded');
    expect(lag.message).toMatch(/replication lag \d/);
    const q = await preview({ mode: 'query', sql: 'SELECT count(*) AS connections FROM pg_stat_activity', warn: 1000, crit: 2000 });
    expect(q).toMatchObject({ status: 'up' });
    expect(q.message).toContain('connections');
    expect((await preview({ mode: 'query', sql: 'SELECT count(*) AS connections FROM pg_stat_activity', crit: 1 })).status).toBe('down');
  });

  it('masks the password in driver errors of monitor checks, query steps and refusals', async () => {
    const { demoDriver } = await import('../src/dbms/demo.js');
    const { closePool } = await import('../src/dbms/pool.js');
    const { DbError } = await import('../src/dbms/types.js');
    const real = demoDriver.connect.bind(demoDriver);
    // a driver whose server echoes the password in its error (as a syntax error near a value can)
    const spy = vi.spyOn(demoDriver, 'connect').mockImplementation(async (t, signal) => {
      const c = await real(t, signal);
      return {
        server: c.server,
        usable: true,
        close: () => c.close(),
        run: async () => {
          throw new DbError('DB_QUERY_FAILED', `The database answered with an error: syntax error at "${t.password}"`, { detail: `at "${t.password}"` }, 422);
        },
      };
    });
    closePool(db.id);
    try {
      const preview = (check: Record<string, unknown>) =>
        s.api('POST', '/monitors/check-preview', { check: { id: 'c', name: 'c', platform: db.id, type: 'database', ...check } });
      for (const mode of [{ mode: 'connection' }, { mode: 'query', sql: 'SELECT 1 AS one' }]) {
        const r = await preview(mode);
        expect(r.message).toContain('syntax error at "***"');
        expect(JSON.stringify(r)).not.toContain('demo-reader-password');
      }
      const p = await processWith('DB leak', [n('q', 'query', { connection: 'db', sql: 'SELECT 1 AS one' })]);
      const r = await run(p.id);
      expect(r.status).toBe('failed');
      expect((await stepOf(r.id, 'q')).error).toContain('***');
      expect(
        JSON.stringify(await s.api('GET', `/runs/${r.id}/steps/${(await s.api('GET', `/runs/${r.id}`)).steps.find((x: any) => x.stepId === 'q').id}`)),
      ).not.toContain('demo-reader-password');
    } finally {
      spy.mockRestore();
      closePool(db.id);
    }
  });

  it('answers a refused statement with the reason as a translatable text', async () => {
    const { runQuery } = await import('../src/dbms/service.js');
    const { getPlatform, getSecrets } = await import('../src/platforms/service.js');
    const e = await runQuery(getPlatform(db.id), getSecrets(db.id), { sql: 'SELECT * FROM t FOR SHARE' }, AbortSignal.timeout(10_000)).catch((x) => x);
    expect(e).toMatchObject({
      code: 'DB_STATEMENT_REFUSED',
      params: { reason: 'rowLock', problem: { code: 'DB_SQL_ROW_LOCK', params: { word: 'FOR SHARE', at: 17 } } },
    });
  });

  it('answers database_query read-only through MCP, checks the statement and audits', async () => {
    await s.api('PUT', '/mcp-server', { enabled: true });
    await s.api('PUT', `/platforms/${db.id}/mcp-gateway`, { enabled: true });
    const token = (await s.api('POST', '/me/tokens', { name: 'mcp db', scope: 'mcp' })).token;
    const call = async (args: Record<string, unknown>) => {
      const res = await fetch(`${s.base}/api/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
          'mcp-protocol-version': '2025-11-25',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'database_query', arguments: { platformId: db.id, ...args } } }),
      });
      const body = await res.json();
      return body.result as { isError?: boolean; structuredContent?: any; content: { text: string }[] };
    };
    const ok = await call({ catalog: 'privileges' });
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent.rows.find((r: any) => r.grantee === 'PUBLIC' && r.object === 'customers')).toBeTruthy();
    const bad = await call({ sql: 'DELETE FROM orders' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain('refused');
    const audit = await s.api('GET', `/audit?entityId=${db.id}`);
    expect(audit.some((e: any) => e.action === 'mcp.gateway_call' && e.summary.includes('SQL catalog:privileges'))).toBe(true);
    expect(audit.some((e: any) => e.action === 'mcp.gateway_refused' && e.details.outcome === 'statement_refused')).toBe(true);
    await s.api('PUT', `/platforms/${db.id}/mcp-gateway`, { enabled: false });
  });

  it('sets up the database templates and fills the datasets on the demo database', async () => {
    const templates = await s.api('GET', '/templates');
    for (const id of ['66-database-access-review', '67-database-account-hygiene', '68-database-table-sizes', '69-postgresql-connections'])
      expect(templates.some((t: any) => t.id === id)).toBe(true);
    const hygiene = (await s.api('GET', '/processes')).find((p: any) => p.name === 'Database – Account hygiene');
    const r = await run(hygiene.id);
    expect(r.status).toBe('succeeded');
    const ds = await s.api('GET', '/datasets/database.accounts');
    expect(ds.metrics).toMatchObject({ accounts: 6, superusers: 1, defaultLogins: 1, expired: 1 });
    expect(ds.rows.find((x: any) => x._key === 'ana')._status).toBe('serious');
    expect(ds.rows.find((x: any) => x._key === 'postgres')._statusText).toContain('default account can sign in');
    const review = (await s.api('GET', '/processes')).find((p: any) => p.name === 'Database – Access review (roles and grants)');
    const rv = await run(review.id);
    expect(rv.status).toBe('waiting');
    const rows = (await stepOf(rv.id, 'rows')).output.rows as any[];
    expect(rows.find((x) => x.member === 'PUBLIC' && x.object === 'table public.customers')).toMatchObject({
      revoke: 'REVOKE SELECT ON TABLE "public"."customers" FROM PUBLIC;',
    });
    expect(rows.find((x) => x.member === 'ana' && x.grant === 'shop_reader')).toMatchObject({ state: 'password expired' });
  });
});
