import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * What the OT network (#220) and the plant visualizations (#230) show of Steward items the reader may not see
 * (0.8.0 security review): a dataset or monitor someone may not see cannot be linked by them, and a linked one still
 * counts towards an asset's live status – as "a check you may not see" with its state only (no name, key, check,
 * reason, time or filter), the same rule on both pages. A VLAN's other sites name only sites the reader may see. The
 * chains of data paths stay cheap with many paths.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Plant-password-1';
const users: Record<string, Client> = {};
const db = async () => (await import('../src/db.js')).db();
const status = async (p: Promise<unknown>): Promise<{ status: number; message?: string }> =>
  p.then(
    () => ({ status: 200 }),
    (e: { status: number; body?: { params?: { message?: string } } }) => ({
      status: e.status,
      ...(e.body?.params?.message ? { message: e.body.params.message } : {}),
    }),
  );
const file = (name: string, content: object) => ({ name, content: YAML.stringify(content) });
const assetNet = (asset: string, c: Client = s.api) => c('GET', `/plant/assets/${asset}/network`);
const HIDDEN = { ref: '', check: '', reason: 'hidden', label: '', path: null, visible: false, at: null };
const PLACEHOLDER = { ref: '', check: '', column: '', value: '', timeColumn: '', maxAgeMinutes: null, note: '' };

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const { createUser } = await import('../src/auth/users.js');
  for (const [name, role] of [
    ['dana', 'designer'],
    ['vera', 'viewer'],
    ['pia', 'plant'],
  ] as const) {
    createUser({ username: name, roles: [role], password: PW });
    users[name] = await s.as(name, PW);
  }
  await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
  const fs = await import('node:fs');
  const path = await import('node:path');
  const content = fs.readFileSync(path.resolve(__dirname, '../../examples/plant/brightwater-ot-network.plant.yaml'), 'utf8');
  await s.api('POST', '/plant/import', { files: [{ name: 'n.plant.yaml', content }], mode: 'add' });
});
afterAll(async () => {
  await s?.app.close();
});

describe('a dataset the reader may not see', () => {
  let platformId = '';
  beforeAll(async () => {
    const proc = await s.api('POST', '/processes', { definition: { name: 'HR export', steps: [{ id: 'n', type: 'log', message: 'x' }] } });
    const { publishDataset } = await import('../src/dashboards/datasets.js');
    publishDataset({
      key: 'hr.salaries',
      title: 'Salaries',
      processId: proc.id,
      processName: 'HR export',
      runId: '',
      dryRun: false,
      columns: ['emp', 'salary', 'seen'],
      rows: [
        { emp: 'alice', salary: 123456, seen: new Date().toISOString() },
        { emp: 'bob', salary: 98765, seen: new Date().toISOString() },
      ],
      metrics: {},
    });
    // its only partition belongs to a platform only administrators may use
    const pf = await s.api('POST', '/platforms', { name: 'HR system', kind: 'generic', baseUrl: 'http://127.0.0.1:9/api' });
    platformId = pf.id;
    await s.api('PUT', `/platforms/${pf.id}/access`, { acl: [{ subject: 'role:admin', permissions: ['use', 'manage'] }] });
    (await db()).run('UPDATE dataset_parts SET platform_ids = ? WHERE dataset_key = ?', JSON.stringify([pf.id]), 'hr.salaries');
    expect((await status(users.dana!('GET', '/datasets/hr.salaries'))).status).toBe(404);
  });

  it('cannot be linked as a check by a site manager who may not see it – asset, device, API or import', async () => {
    const check = { kind: 'dataset', ref: 'hr.salaries', column: 'emp', value: 'alice', timeColumn: 'salary', maxAgeMinutes: 1 };
    // the same answer as for a dataset that does not exist
    const missing = await status(users.dana!('PUT', '/plant/assets/rvs-mill-01/checks', { checks: [{ ...check, ref: 'hr.nothing' }] }));
    const hidden = await status(users.dana!('PUT', '/plant/assets/rvs-mill-01/checks', { checks: [check] }));
    expect(hidden).toEqual({ status: 400, message: 'There is no dataset "hr.salaries"' });
    expect(missing).toEqual({ status: 400, message: 'There is no dataset "hr.nothing"' });
    const dev = (await assetNet('rvs-mill-01', users.dana!)).devices[0];
    const keys = ['id', 'assetId', 'assetName', 'live', 'hints', 'importId', 'notInSource'];
    const values = Object.fromEntries(Object.entries(dev).filter(([k]) => !keys.includes(k)));
    expect(await status(users.dana!('PUT', `/plant/assets/rvs-mill-01/devices/${dev.id}`, { ...values, checks: [check] }))).toMatchObject({ status: 400 });
    const preview = await users.dana!('POST', '/plant/import/preview', {
      files: [file('c.yaml', { version: 1, asset_network: { asset: 'rvs-mill-01', checks: [{ dataset: 'hr.salaries', column: 'emp', value: 'alice' }] } })],
      mode: 'update',
    });
    expect(preview.problems.map((p: { message: string }) => p.message)).toEqual(['There is no dataset "hr.salaries"']);
  });

  it('once linked by someone who may see it, shows only its state to the others – no values, times or filter', async () => {
    // the administrator links it twice: a row's time column, and a column that holds no time (an amount)
    const a = await s.api('PUT', '/plant/assets/rvs-mill-01/checks', {
      checks: [
        { kind: 'dataset', ref: 'hr.salaries', column: 'emp', value: 'alice', timeColumn: 'seen', maxAgeMinutes: 60 },
        { kind: 'dataset', ref: 'hr.salaries', column: 'emp', value: 'alice', timeColumn: 'salary', maxAgeMinutes: 1 },
        { kind: 'dataset', ref: 'hr.salaries', column: 'emp', value: 'carol', maxAgeMinutes: 1 },
      ],
    });
    // an amount is no time: no date from 1970 out of it
    expect(a.live.checks.map((c: { reason: string }) => c.reason)).toEqual(['fresh', 'no_time', 'no_row']);
    expect(a.live.checks[0]).toMatchObject({ visible: true, label: 'Salaries', ref: 'hr.salaries' });
    for (const who of ['dana', 'vera', 'pia']) {
      const n = await assetNet('rvs-mill-01', users[who]!);
      expect(n.live.checks, who).toEqual([
        { kind: 'dataset', state: 'online', ...HIDDEN },
        { kind: 'dataset', state: 'unknown', ...HIDDEN },
        { kind: 'dataset', state: 'unknown', ...HIDDEN },
      ]);
      // the stored checks: their place only
      expect(n.checks, who).toEqual([0, 1, 2].map((i) => ({ kind: 'dataset', ...PLACEHOLDER, hiddenSlot: i })));
      const text = JSON.stringify(n);
      for (const leak of ['hr.salaries', 'alice', 'carol', 'salary', 'Salaries', '1970-']) expect(text.includes(leak), `${who}: ${leak}`).toBe(false);
      // the site's overview counts it too
      const site = await users[who]!('GET', '/plant/sites/riverside/network');
      expect(site.assets.find((x: { id: string }) => x.id === 'rvs-mill-01').live.checks).toEqual(n.live.checks);
    }
    // the public API and the export likewise
    const t = await users.vera!('POST', '/me/tokens', { name: 'ot', scope: 'read' });
    const v1 = await (await fetch(`${s.base}/api/v1/plant/assets/rvs-mill-01/network`, { headers: { authorization: `Bearer ${t.token}` } })).json();
    expect(v1.live.checks[0]).toEqual({ kind: 'dataset', state: 'online', ...HIDDEN });
    expect(JSON.stringify(v1).includes('hr.salaries')).toBe(false);
    const y: string = await users.vera!('GET', '/plant/export?site=riverside');
    expect(y.includes('hr.salaries')).toBe(false);
  });

  it('a manager who may not see it keeps or removes it, but cannot change what it reads', async () => {
    const before = (await assetNet('rvs-mill-01')).checks;
    const mine = (await assetNet('rvs-mill-01', users.dana!)).checks;
    // sent back as read: nothing changes (no audit entry)
    const audits = (await s.api('GET', '/audit?action=asset.checks_set')).length;
    await users.dana!('PUT', '/plant/assets/rvs-mill-01/checks', { checks: mine });
    expect((await assetNet('rvs-mill-01')).checks).toEqual(before);
    expect((await s.api('GET', '/audit?action=asset.checks_set')).length).toBe(audits);
    // another filter or time column is a new link: refused, the same answer as for a missing dataset
    expect(await status(users.dana!('PUT', '/plant/assets/rvs-mill-01/checks', { checks: [{ ...before[0], value: 'bob' }, mine[1], mine[2]] }))).toEqual({
      status: 400,
      message: 'There is no dataset "hr.salaries"',
    });
    // a slot that holds no hidden check (the list changed meanwhile) is refused
    expect((await status(users.dana!('PUT', '/plant/assets/rvs-mill-01/checks', { checks: [{ ...mine[0], hiddenSlot: 7 }] }))).status).toBe(400);
    // leaving one out removes it
    await users.dana!('PUT', '/plant/assets/rvs-mill-01/checks', { checks: [mine[0]] });
    expect((await assetNet('rvs-mill-01')).checks).toEqual([before[0]]);
  });

  it('is read as the reader where they may see it: only the partitions they may read', async () => {
    // a second partition on a platform everyone may use, without Alice
    const d = await db();
    d.run(
      `INSERT INTO dataset_parts (dataset_key, source, platform_ids, run_id, dry_run, updated_at, row_count, columns, rows, status_counts, metrics)
       VALUES (?, ?, ?, '', 0, ?, 1, ?, ?, '{}', '{}')`,
      'hr.salaries',
      'open-part',
      '[]',
      new Date().toISOString(),
      JSON.stringify(['emp', 'salary', 'seen']),
      JSON.stringify([{ emp: 'bob', salary: 1, seen: new Date().toISOString() }]),
    );
    // vera may now see the dataset (her partition): it is named, and Alice is not in her rows
    expect((await status(users.vera!('GET', '/datasets/hr.salaries'))).status).toBe(200);
    const n = await assetNet('rvs-mill-01', users.vera!);
    expect(n.live.checks[0]).toMatchObject({ visible: true, ref: 'hr.salaries', reason: 'no_row', state: 'unknown' });
    expect((await assetNet('rvs-mill-01')).live.checks[0]).toMatchObject({ reason: 'fresh', state: 'online' });
    d.run("DELETE FROM dataset_parts WHERE dataset_key = ? AND source = 'open-part'", 'hr.salaries');
    await s.api('PUT', '/plant/assets/rvs-mill-01/checks', { checks: [] });
    expect(platformId).not.toBe('');
  });
});

describe('a monitor the reader may not see', () => {
  let id = '';
  const setState = async (st: string) =>
    (await db()).run('UPDATE monitor_state SET status = ?, last_evaluated_at = ? WHERE monitor_id = ?', st, new Date().toISOString(), id);
  beforeAll(async () => {
    const m = await s.api('POST', '/monitors', {
      key: 'secret-mon',
      definition: {
        name: 'Secret',
        checks: [
          { id: 'hb', name: 'HB', type: 'heartbeat', key: 'secret.hb', mode: 'maxAge', maxAgeSeconds: 600 },
          { id: 'hb2', name: 'HB 2', type: 'heartbeat', key: 'secret.hb2', mode: 'maxAge', maxAgeSeconds: 600 },
        ],
      },
    });
    id = m.monitor?.id ?? m.id;
    await s.api('PUT', `/monitors/${id}/access`, { acl: [{ subject: 'role:admin', permissions: ['view', 'edit', 'manage'] }] });
    const d = await db();
    if (!d.get('SELECT 1 FROM monitor_state WHERE monitor_id = ?', id))
      d.run("INSERT INTO monitor_state (monitor_id, status, last_evaluated_at) VALUES (?, 'down', ?)", id, new Date().toISOString());
    await setState('down');
    await s.api('PUT', '/plant/assets/rvs-mill-02/checks', { checks: [{ kind: 'monitor', ref: 'secret-mon' }] });
    expect((await status(users.vera!('GET', `/monitors/${id}`))).status).toBe(404);
  });

  it('counts towards the status, with its state only: no key, check, reason or time', async () => {
    const admin = await assetNet('rvs-mill-02');
    expect(admin.live.checks[0]).toMatchObject({ ref: 'secret-mon', reason: 'down', visible: true, label: 'Secret' });
    for (const who of ['dana', 'vera', 'pia']) {
      const n = await assetNet('rvs-mill-02', users[who]!);
      expect(n.live.state, who).toBe('offline');
      expect(n.live.checks, who).toEqual([{ kind: 'monitor', state: 'offline', ...HIDDEN }]);
      expect(n.checks, who).toEqual([{ kind: 'monitor', ...PLACEHOLDER, hiddenSlot: 0 }]);
      expect(JSON.stringify(n).includes('secret'), who).toBe(false);
    }
    // maintenance or a disabled monitor reads "unknown" – the reason is not told
    await s.api('POST', `/monitors/${id}/enabled`, { enabled: false });
    expect((await assetNet('rvs-mill-02', users.vera!)).live.checks).toEqual([{ kind: 'monitor', state: 'unknown', ...HIDDEN }]);
    await s.api('POST', `/monitors/${id}/enabled`, { enabled: true });
    // a monitor that no longer exists reads like a hidden one
    await s.api('PUT', '/plant/assets/rvs-mill-03/checks', { checks: [{ kind: 'monitor', ref: 'secret-mon' }] });
    (await db()).run(
      "UPDATE plant_asset_checks SET checks = ? WHERE asset_id = 'rvs-mill-03'",
      JSON.stringify([{ ...PLACEHOLDER, kind: 'monitor', ref: 'gone-mon' }]),
    );
    expect((await assetNet('rvs-mill-03', users.vera!)).live.checks).toEqual([{ kind: 'monitor', state: 'unknown', ...HIDDEN }]);
    await s.api('PUT', '/plant/assets/rvs-mill-03/checks', { checks: [] });
  });

  it('another check of it is a new link: who may not see the monitor cannot change it', async () => {
    const mine = (await assetNet('rvs-mill-02', users.dana!)).checks;
    for (const check of ['hb', 'hb2', 'nope'])
      expect(await status(users.dana!('PUT', '/plant/assets/rvs-mill-02/checks', { checks: [{ kind: 'monitor', ref: 'secret-mon', check }] }))).toEqual({
        status: 400,
        message: 'There is no monitor "secret-mon"',
      });
    // kept as read, next to a check of their own
    const dm = await s.api('POST', '/monitors', {
      key: 'dana-mon',
      definition: { name: 'Dana', checks: [{ id: 'hb', name: 'HB', type: 'heartbeat', key: 'dana.hb', mode: 'maxAge', maxAgeSeconds: 600 }] },
    });
    await s.api('PUT', `/monitors/${dm.monitor?.id ?? dm.id}/access`, { acl: [{ subject: 'user:dana', permissions: ['view'] }] });
    const r = await users.dana!('PUT', '/plant/assets/rvs-mill-02/checks', { checks: [...mine, { kind: 'monitor', ref: 'dana-mon' }] });
    expect(r.checks.map((c: { ref: string }) => c.ref)).toEqual(['', 'dana-mon']);
    expect((await assetNet('rvs-mill-02')).checks.map((c: { ref: string; check: string }) => c.ref)).toEqual(['secret-mon', 'dana-mon']);
    // an import keeps it too (the file cannot name it)
    const y: string = await users.dana!('GET', '/plant/export?site=riverside');
    expect(y.includes('secret-mon')).toBe(false);
    await users.dana!('POST', '/plant/import', { files: [{ name: 'round.plant.yaml', content: y }], mode: 'update' });
    expect((await assetNet('rvs-mill-02')).checks.map((c: { ref: string }) => c.ref)).toEqual(['secret-mon', 'dana-mon']);
    await s.api('PUT', '/plant/assets/rvs-mill-02/checks', { checks: [{ kind: 'monitor', ref: 'secret-mon' }] });
  });

  it('reads the same in the visualizations as on the OT network', async () => {
    const link = await s.api('POST', '/plant/assets/rvs-mill-02/links', { kind: 'monitor', id });
    try {
      for (const [st, ot, view] of [
        ['down', 'offline', 'fail'],
        ['degraded', 'online', 'ok'],
        ['maintenance', 'unknown', 'unknown'],
      ] as const) {
        await setState(st);
        const n = await assetNet('rvs-mill-02', users.vera!);
        expect(n.live.state).toBe(ot);
        const flow = await users.vera!('GET', '/plant/assets/rvs-mill-02/flow');
        expect(flow.nodes.find((x: { id: string }) => x.id === 'asset').live).toEqual({
          source: 'monitor',
          state: view,
          status: 'hidden',
          label: '',
          path: null,
          at: null,
        });
        const structure = await users.vera!('GET', '/plant/sites/riverside/structure');
        expect(structure.assets.find((x: { id: string }) => x.id === 'rvs-mill-02').live).toBe(view);
        expect(JSON.stringify(structure).includes('Secret')).toBe(false);
      }
    } finally {
      await s.api('DELETE', `/plant/assets/rvs-mill-02/links/${link.id}`);
      await setState('down');
    }
  });
});
