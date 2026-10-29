import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Datasets per source platform (#142): one partition per source, so three schedules on three tenants keep every
 * tenant's rows; rows carry `_source`; metrics per source; a reader who may not use a restricted platform does not
 * see its partition; staleness follows the schedule; existing datasets become one partition.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
let vera: Client;
let audrey: Client;
const platforms: string[] = [];
let processId: string;
const DONE = ['succeeded', 'failed'];

const platform = async (name: string, environment: string) =>
  (
    await s.api('POST', '/platforms', {
      name,
      kind: 'generic',
      environment,
      baseUrl: 'http://127.0.0.1:9/api',
      config: { auth: { type: 'none' }, variables: {}, http: { proxy: 'none' } },
      secrets: {},
    })
  ).id as string;

const publisher = (name: string, connections: { slot: string }[], extra: Record<string, unknown> = {}) =>
  s.api('POST', '/processes', {
    definition: {
      name,
      connections,
      inputs: [{ name: 'users', type: 'list' }],
      steps: [
        {
          id: 'publish',
          type: 'publish',
          dataset: extra.dataset ?? 'test.users',
          rows: 'inputs.users',
          key: '$',
          columns: [{ label: 'User', value: '$' }],
          metrics: { total: '$count(inputs.users)' },
          ...extra,
        },
      ],
    },
  });

async function run(proc: string, bindings: Record<string, string>, users: string[]) {
  const { id } = await s.api('POST', '/runs', { processId: proc, bindings, inputs: { users } });
  return s.waitRun(id, DONE);
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  vera = await s.as('vera', 'Demo-password-1');
  audrey = await s.as('audrey', 'Demo-password-1');
  platforms.push(await platform('Tenant EU', 'prod'), await platform('Tenant US', 'prod'), await platform('Tenant Dev', 'dev'));
  processId = (await publisher('User inventory', [{ slot: 'hub' }])).id;
});
afterAll(async () => {
  await s?.app.close();
});

describe('datasets per source platform', () => {
  it('keeps one partition per source: three schedules on three platforms', async () => {
    const users = [['ada', 'bob'], ['cyd'], ['dan', 'eve', 'fay']];
    for (const [i, p] of platforms.entries()) {
      const sch = await s.api('POST', '/schedules', {
        name: `Inventory ${i}`,
        processId,
        cron: '0 * * * *',
        inputs: { users: users[i] },
        bindings: { hub: p },
        enabled: false,
      });
      const { id } = await s.api('POST', `/schedules/${sch.id}/run`, {});
      await s.waitRun(id, DONE);
    }
    const d = await s.api('GET', '/datasets/test.users');
    expect(d.rowCount).toBe(6);
    expect(d.sources.map((x: any) => x.name).sort()).toEqual(['Tenant Dev', 'Tenant EU', 'Tenant US']);
    // a schedule every hour: stale after 2.5 hours
    expect(d.sources[0]).toMatchObject({ expectedMinutes: 60, staleAfterMinutes: 150, stale: false });
    const eu = d.rows.filter((r: any) => r._source.platformId === platforms[0]);
    expect(eu.map((r: any) => r.User)).toEqual(['ada', 'bob']);
    expect(eu[0]._source).toMatchObject({ platform: 'Tenant EU', environment: 'prod' });

    // a new run of one tenant replaces only its own rows
    await run(processId, { hub: platforms[0] }, ['ada']);
    const after = await s.api('GET', '/datasets/test.users');
    expect(after.rowCount).toBe(5);
    expect(after.rows.filter((r: any) => r._source.platformId === platforms[2]).map((r: any) => r.User)).toEqual(['dan', 'eve', 'fay']);

    // metrics per source; the source filter
    const series = await s.api('GET', '/datasets/test.users/metrics?names=total');
    expect(series.map((x: any) => x.sourceName).sort()).toEqual(['Tenant Dev', 'Tenant EU', 'Tenant US']);
    const euSeries = series.find((x: any) => x.source === platforms[0]);
    expect(euSeries.points.map((p: any) => p.value)).toEqual([2, 1]);
    const one = await s.api('GET', `/datasets/test.users?source=${platforms[1]}`);
    expect(one.rows.map((r: any) => r.User)).toEqual(['cyd']);
    expect(one.sources).toHaveLength(1);
    // the public API filters the same way
    const token = await s.api('POST', '/me/tokens', { name: 'read', scope: 'read' });
    const api = await (
      await fetch(`${s.base}/api/v1/datasets/test.users/rows?source=${platforms[2]}`, { headers: { authorization: `Bearer ${token.token}` } })
    ).json();
    expect(api.items.map((r: any) => r.User)).toEqual(['dan', 'eve', 'fay']);
  });

  it('hides the partition of a platform whose access list leaves the reader out; auditors see all', async () => {
    await s.api('PUT', `/platforms/${platforms[2]}/access`, { acl: [{ subject: 'role:admin', permissions: ['use', 'manage'] }] });
    const d = await vera('GET', '/datasets/test.users');
    expect(d.sources.map((x: any) => x.name).sort()).toEqual(['Tenant EU', 'Tenant US']);
    expect(d.rows.some((r: any) => r._source.platformId === platforms[2])).toBe(false);
    expect((await vera('GET', '/datasets/test.users/metrics?names=total')).some((x: any) => x.source === platforms[2])).toBe(false);
    // asking for the hidden source gives nothing, without a hint
    expect((await vera('GET', `/datasets/test.users?source=${platforms[2]}`)).rows).toEqual([]);
    expect((await audrey('GET', '/datasets/test.users')).sources).toHaveLength(3);
  });

  it('finds the source: the step names the connection; several connections; no connection', async () => {
    const two = (await publisher('Cross report', [{ slot: 'hub' }, { slot: 'other' }], { dataset: 'test.cross' })).id;
    await run(two, { hub: platforms[0], other: platforms[1] }, ['x']);
    expect((await s.api('GET', '/datasets/test.cross')).sources[0]).toMatchObject({
      id: [platforms[0], platforms[1]].sort().join('+'),
      name: expect.stringContaining(' + '),
    });
    const named = (await publisher('Cross by hub', [{ slot: 'hub' }, { slot: 'other' }], { dataset: 'test.byhub', source: 'other' })).id;
    await run(named, { hub: platforms[0], other: platforms[1] }, ['y']);
    expect((await s.api('GET', '/datasets/test.byhub')).sources[0]).toMatchObject({ id: platforms[1], name: 'Tenant US' });
    const none = (await publisher('Catalogue overview', [], { dataset: 'test.none' })).id;
    await run(none, {}, ['z']);
    // started by hand: the step's setting or a day
    expect((await s.api('GET', '/datasets/test.none')).sources[0]).toMatchObject({
      id: 'instance',
      name: 'This instance',
      expectedMinutes: null,
      staleAfterMinutes: 1440,
    });
  });

  it('turns an existing dataset into one partition of its last run, with its metric history', async () => {
    const r = await run(processId, { hub: platforms[1] }, ['old']);
    const { db } = await import('../src/db.js');
    // a dataset as 0.2.3 stored it: no partitions, history without a source
    db().run('DELETE FROM dataset_parts WHERE dataset_key = ?', 'test.legacy');
    db().run(
      `INSERT INTO datasets (key, title, process_id, process_name, run_id, dry_run, updated_at, row_count, columns, rows, status_counts, metrics, stale_after_minutes)
       VALUES ('test.legacy', 'Legacy', ?, 'User inventory', ?, 0, ?, 2, '["User"]', '[{"_key":"a","User":"a"},{"_key":"b","User":"b"}]', '{}', '{"total":2}', 30)`,
      processId,
      r.id,
      new Date().toISOString(),
    );
    db().run("INSERT INTO dataset_metrics (dataset_key, name, ts, value, run_id) VALUES ('test.legacy', 'total', ?, 2, ?)", new Date().toISOString(), r.id);
    const d = await s.api('GET', '/datasets/test.legacy');
    expect(d.sources).toHaveLength(1);
    expect(d.sources[0]).toMatchObject({ id: platforms[1], name: 'Tenant US', staleAfterMinutes: 30 });
    expect(d.rows.map((x: any) => [x.User, x._source.platformId])).toEqual([
      ['a', platforms[1]],
      ['b', platforms[1]],
    ]);
    const series = await s.api('GET', '/datasets/test.legacy/metrics?names=total');
    expect(series).toEqual([expect.objectContaining({ name: 'total', source: platforms[1] })]);
  });
});
