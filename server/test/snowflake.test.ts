import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Snowflake (#115) against the demo account: key-pair JWT sign-in (the mock verifies the signature with the
 * registered public key), database components, access reviews through the role hierarchy, and the monitor check.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
let sf: string;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup');
  sf = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'snowflake').id;
});
afterAll(async () => {
  await s?.app.close();
});

describe('Snowflake platform', () => {
  it('signs in with the key-pair JWT and tests the connection', async () => {
    const t = await s.api('POST', `/platforms/${sf}/test`, {});
    expect(t).toMatchObject({ ok: true });
    expect(t.message).toMatch(
      /Snowflake account DEMO12345 as STEWARD_READER \(role STEWARD_READ, warehouse STEWARD_WH\) – the ACCOUNT_USAGE views can be read/,
    );
  });

  it('reads a database component: tables, failing tasks, warehouse credits', async () => {
    const app = await s.api('POST', '/applications', { name: 'Shop analytics', owners: [] });
    await expect(s.api('POST', `/applications/${app.id}/components`, { type: 'snowflake-database', name: 'shop-db', platformId: sf })).rejects.toThrow(
      /Snowflake database name/,
    );
    const other = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'kafka').id;
    await expect(s.api('POST', `/applications/${app.id}/components`, { type: 'snowflake-database', name: 'SHOP', platformId: other })).rejects.toThrow(
      /Snowflake platform/,
    );
    const a = await s.api('POST', `/applications/${app.id}/components`, { type: 'snowflake-database', name: 'shop', platformId: sf });
    const cmp = a.components.find((c: any) => c.name === 'shop');
    const read = await s.api('POST', `/applications/${app.id}/components/${cmp.id}/snowflake`, {});
    const r = read.components.find((c: any) => c.id === cmp.id).snowflake;
    expect(r).toMatchObject({ error: null, account: 'DEMO12345', database: 'SHOP', tableCount: 4, bytes: 2_333_000_000 });
    // the stalest first
    expect(r.tables.map((t: any) => `${t.schema}.${t.name}`)).toEqual(['REPORTING.DAILY_REVENUE', 'STAGING.RAW_EVENTS', 'SALES.CUSTOMERS', 'SALES.ORDERS']);
    expect(r.failedTasks).toEqual([expect.objectContaining({ schema: 'STAGING', name: 'LOAD_EVENTS', error: expect.stringContaining('does not exist') })]);
    expect(r.warehouses).toEqual([
      { warehouse: 'TRANSFORM_WH', credits: 120.5, credits7d: 31.25 },
      { warehouse: 'BI_WH', credits: 40, credits7d: 9.5 },
    ]);
    const { runSnowflakeJob } = await import('../src/snowflake/service.js');
    expect(await runSnowflakeJob(Date.now())).toBe(0);
    expect(await runSnowflakeJob(Date.now() + 7 * 3_600_000)).toBe(1);
  });

  it('refuses a key that does not belong to the user', async () => {
    const crypto = await import('node:crypto');
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const p = await s.api('POST', '/platforms', { ...(await s.api('GET', `/platforms/${sf}`)), name: 'Snowflake other key', secrets: { privateKey: other } });
    const t = await s.api('POST', `/platforms/${p.id}/test`, {});
    expect(t).toMatchObject({ ok: false, message: expect.stringMatching(/HTTP 401.*JWT token is invalid/) });
  });
});

describe('access reviews with the Snowflake source', () => {
  const run = async (scope: string) => {
    const c = await s.api('POST', '/compliance/access-checks', { name: `Snowflake ${scope || 'roles'}`, platformId: sf, source: 'snowflake', scope });
    expect(c).toMatchObject({ source: 'snowflake', datasetKey: null });
    const r = await s.api('POST', `/compliance/access-checks/${c.id}/run`, {});
    const snap = await s.api('GET', `/compliance/access-checks/${c.id}/snapshots/${r.snapshot.id}`);
    return Object.fromEntries(snap.data.map((x: any) => [x.id, { type: x.type, rights: x.rights }]));
  };

  it('lists the roles of every user, technical and disabled users marked', async () => {
    expect(await run('')).toEqual({
      ALICE: { type: 'user', rights: ['role:ANALYST'] },
      BOB: { type: 'user', rights: ['role:SYSADMIN'] },
      ETL_SVC: { type: 'technical', rights: ['role:LOADER'] },
      OLD_BI: { type: 'disabled', rights: ['role:REPORTER'] },
    });
  });

  it('lists who reaches a schema or a table, through the role hierarchy', async () => {
    const schema = await run('SHOP.SALES');
    // ALICE: ANALYST ⊃ REPORTER; BOB: SYSADMIN ⊃ ANALYST ⊃ REPORTER, and owns the database
    const reporter = ['SELECT TABLE SHOP.SALES.ORDERS', 'USAGE DATABASE SHOP', 'USAGE SCHEMA SHOP.SALES'];
    expect(schema.ALICE).toEqual({ type: 'user', rights: reporter });
    expect(schema.BOB).toEqual({ type: 'user', rights: ['OWNERSHIP DATABASE SHOP', ...reporter] });
    expect(schema.ETL_SVC).toEqual({ type: 'technical', rights: ['USAGE DATABASE SHOP'] });
    expect(schema.OLD_BI).toEqual({ type: 'disabled', rights: reporter });
    const table = await run('SHOP.STAGING.RAW_EVENTS');
    expect(table.ETL_SVC.rights).toEqual(['INSERT TABLE SHOP.STAGING.RAW_EVENTS', 'USAGE DATABASE SHOP', 'USAGE SCHEMA SHOP.STAGING']);
    expect(table.ALICE.rights).toEqual(['USAGE DATABASE SHOP']);
  });

  it('refuses a scope that is no Snowflake name, and a platform that is not Snowflake', async () => {
    await expect(s.api('POST', '/compliance/access-checks', { name: 'bad', platformId: sf, source: 'snowflake', scope: "SHOP'; DROP" })).rejects.toThrow(
      /DATABASE\.SCHEMA/,
    );
    const other = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'kafka').id;
    await expect(s.api('POST', '/compliance/access-checks', { name: 'wrong', platformId: other, source: 'snowflake', scope: '' })).rejects.toThrow(
      /Snowflake source/,
    );
  });
});

describe('monitor check snowflake', () => {
  it('checks the freshness of a table, failing tasks and warehouse credits', async () => {
    const { snowflakeCheck } = await import('../src/snowflake/service.js');
    const { getPlatform, getSecrets } = await import('../src/platforms/service.js');
    const { setSnowflakeTableAge } = await import('../src/mock/mockSnowflake.js');
    const p = getPlatform(sf);
    const sec = getSecrets(sf);
    expect(await snowflakeCheck(p, sec, { mode: 'freshness', object: 'SHOP.SALES.ORDERS', maxAgeMinutes: 60, failAs: 'down' })).toMatchObject({ status: 'up' });
    expect(await snowflakeCheck(p, sec, { mode: 'freshness', object: 'shop.staging.raw_events', maxAgeMinutes: 1440, failAs: 'degraded' })).toMatchObject({
      status: 'degraded',
      message: expect.stringMatching(/SHOP\.STAGING\.RAW_EVENTS last changed 4320 minutes ago \(at most 1440\)/),
    });
    setSnowflakeTableAge('SHOP.SALES.ORDERS', 3);
    expect(await snowflakeCheck(p, sec, { mode: 'freshness', object: 'SHOP.SALES.ORDERS', maxAgeMinutes: 60, failAs: 'down' })).toMatchObject({
      status: 'down',
    });
    setSnowflakeTableAge('SHOP.SALES.ORDERS', 0.2);
    expect(await snowflakeCheck(p, sec, { mode: 'freshness', object: 'SHOP.SALES.NOPE', failAs: 'down' })).toMatchObject({ status: 'unknown' });
    expect(await snowflakeCheck(p, sec, { mode: 'tasks', object: 'SHOP', failAs: 'down' })).toMatchObject({
      status: 'down',
      message: expect.stringContaining('STAGING.LOAD_EVENTS'),
    });
    expect(await snowflakeCheck(p, sec, { mode: 'tasks', object: 'SHOP.SALES', failAs: 'down' })).toMatchObject({ status: 'up' });
    expect(await snowflakeCheck(p, sec, { mode: 'tasks', object: 'SHOP', withinHours: 1, failAs: 'down' })).toMatchObject({ status: 'up' });
    expect(await snowflakeCheck(p, sec, { mode: 'credits', object: 'TRANSFORM_WH', withinHours: 168, maxCredits: 30, failAs: 'degraded' })).toMatchObject({
      status: 'degraded',
      value: { credits: 31.25 },
    });
    expect(await snowflakeCheck(p, sec, { mode: 'credits', object: 'BI_WH', withinHours: 168, maxCredits: 30, failAs: 'degraded' })).toMatchObject({
      status: 'up',
    });
    await expect(snowflakeCheck(p, sec, { mode: 'freshness', object: 'SHOP.SALES', failAs: 'down' })).rejects.toThrow(/DATABASE.SCHEMA.TABLE/);
  });

  it('runs in a monitor', async () => {
    const { monitor } = await s.api('POST', '/monitors', {
      definition: {
        name: 'Shop data fresh',
        failuresBeforeDown: 1,
        checks: [
          {
            id: 'orders',
            name: 'Orders fresh',
            type: 'snowflake',
            platform: 'Snowflake (demo)',
            mode: 'freshness',
            object: 'SHOP.SALES.ORDERS',
            maxAgeMinutes: 60,
          },
          { id: 'tasks', name: 'Shop tasks', type: 'snowflake', platform: 'Snowflake (demo)', mode: 'tasks', object: 'SHOP', failAs: 'degraded' },
        ],
      },
    });
    const eng = await import('../src/monitors/engine.js');
    await eng.evaluateMonitorNow(monitor.id);
    const st = await s.api('GET', `/monitors/${monitor.id}`);
    expect(st.status).toBe('degraded');
  });
});
