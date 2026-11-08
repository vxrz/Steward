import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * The visualizations of the plant registry (#230): a site's structure, an asset's data flow, a data point's lineage,
 * the KPI coverage matrix and the site overview tiles – on the invented demo enterprise. What they show is what the
 * registry documents; status only from linked Steward items (a monitor the asset links to, the dataset a KPI instance
 * names); unknown stays unknown. Hidden sites are never drawn or counted; the Plant viewer sees the views, without
 * the monitors and datasets they may not see.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Plant-password-1';
const users: Record<string, Client> = {};
const status = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> =>
  p.then(
    () => ({ status: 200 }),
    (e: { status: number; body?: { code?: string } }) => ({ status: e.status, code: e.body?.code }),
  );
const enable = (enabled = true) => s.api('PUT', '/settings/plant', { enabled, enterprise: 'Brightwater Components', labels: {}, fields: {} });
const byId = (list: { id: string }[], id: string): any => {
  const x = list.find((n) => n.id === id);
  if (!x) throw new Error(`${id} not in ${list.map((n) => n.id).join(', ')}`);
  return x;
};

async function monitor(name: string, state: string): Promise<string> {
  const r = await s.api('POST', '/monitors', {
    definition: {
      name,
      checks: [{ id: 'hb', name: 'Heartbeat', type: 'heartbeat', key: `plant.${name.toLowerCase().replace(/\W+/g, '-')}`, mode: 'maxAge', maxAgeSeconds: 600 }],
    },
  });
  const id = r.monitor?.id ?? r.id;
  const { db } = await import('../src/db.js');
  db().run('DELETE FROM monitor_state WHERE monitor_id = ?', id);
  db().run(
    'INSERT INTO monitor_state (monitor_id, status, since, last_evaluated_at) VALUES (?, ?, ?, ?)',
    id,
    state,
    new Date().toISOString(),
    new Date().toISOString(),
  );
  return id;
}

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
});

describe('module switch', () => {
  it('every view answers 404 PLANT_MODULE_OFF while the module is off', async () => {
    for (const url of [
      '/plant/views/overview',
      '/plant/views/coverage',
      '/plant/sites/riverside/structure',
      '/plant/assets/rvs-mill-01/flow',
      '/plant/profiles/example-controls-c80/points/program_status/lineage',
    ])
      expect(await status(s.api('GET', url)), url).toEqual({ status: 404, code: 'PLANT_MODULE_OFF' });
    await enable();
  });
});

describe('site structure', () => {
  it('rolls the assets up the ISA-95 hierarchy and the buildings, by status', async () => {
    const x = await s.api('GET', '/plant/sites/riverside/structure');
    expect(x.site).toMatchObject({ id: 'riverside', code: 'RVS' });
    const total = Object.values(x.counts as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(x.total).toBe(total);
    expect(x.assets).toHaveLength(total);
    expect(x.assetsTruncated).toBe(false);
    const machining = byId(x.function, 'rvs-machining');
    expect(machining).toMatchObject({ level: 'area', parentId: null });
    expect(machining.childIds).toEqual(['rvs-mill-line-1', 'rvs-mill-line-2']);
    // an area counts the assets of its work centers and units
    const children = machining.childIds.map((id: string) => byId(x.function, id).total).reduce((a: number, b: number) => a + b, 0);
    expect(machining.total).toBe(children + machining.own);
    expect(machining.total).toBeGreaterThanOrEqual(3);
    // every asset is either in a root area or unplaced
    const roots = x.function.filter((n: { parentId: string | null }) => !n.parentId);
    const unplaced = Object.values(x.unplaced.function as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(roots.reduce((a: number, n: { total: number }) => a + n.total, 0) + unplaced).toBe(total);
    // the location axis: a floor counts toward its building
    const hall2 = byId(x.location, 'rvs-hall-2');
    expect(hall2.childIds).toContain('rvs-hall-2-mezzanine');
    expect(hall2.total).toBeGreaterThanOrEqual(byId(x.location, 'rvs-hall-2-mezzanine').total);
    // no monitor is linked: no live status anywhere, not "ok"
    expect(x.live).toEqual({});
    expect(x.assets.every((a: { live: unknown }) => a.live === null)).toBe(true);
  });

  it('counts a linked monitor as live status – named only for who may see the monitor', async () => {
    const down = await monitor('Mill 1 controller', 'down');
    const link = await s.api('POST', '/plant/assets/rvs-mill-01/links', { kind: 'monitor', id: down });
    try {
      const x = await s.api('GET', '/plant/sites/riverside/structure');
      expect(x.live).toEqual({ fail: 1 });
      expect(byId(x.assets, 'rvs-mill-01').live).toBe('fail');
      expect(byId(x.function, 'rvs-machining').live).toEqual({ fail: 1 });
      // the Plant viewer may not see monitors: it still counts, by its state only (the OT network's rule)
      const pia = await users.pia!('GET', '/plant/sites/riverside/structure');
      expect(pia.live).toEqual({ fail: 1 });
      expect(byId(pia.assets, 'rvs-mill-01').live).toBe('fail');
      // the flow shows it on the asset, with the monitor's own word
      const flow = await s.api('GET', '/plant/assets/rvs-mill-01/flow');
      expect(byId(flow.nodes, 'asset').live).toMatchObject({
        source: 'monitor',
        state: 'fail',
        status: 'down',
        label: 'Mill 1 controller',
        path: `/monitors/${down}`,
      });
      expect(byId((await users.pia!('GET', '/plant/assets/rvs-mill-01/flow')).nodes, 'asset').live).toEqual({
        source: 'monitor',
        state: 'fail',
        status: 'hidden',
        label: '',
        path: null,
        at: null,
      });
      // a monitor in maintenance is a warning, an unknown one unknown – never ok
      const { db } = await import('../src/db.js');
      db().run('UPDATE monitor_state SET status = ? WHERE monitor_id = ?', 'unknown', down);
      expect((await s.api('GET', '/plant/sites/riverside/structure')).live).toEqual({ unknown: 1 });
      // a reader who may not see it learns the OT network's three states only: degraded reads ok, not a warning
      db().run('UPDATE monitor_state SET status = ? WHERE monitor_id = ?', 'degraded', down);
      expect((await s.api('GET', '/plant/sites/riverside/structure')).live).toEqual({ warn: 1 });
      expect((await users.pia!('GET', '/plant/sites/riverside/structure')).live).toEqual({ ok: 1 });
      db().run('UPDATE monitor_state SET status = ? WHERE monitor_id = ?', 'unknown', down);
      const tiles = await s.api('GET', '/plant/views/overview');
      expect(
        byId(
          tiles.map((t: { siteId: string }) => ({ ...t, id: t.siteId })),
          'riverside',
        ).live,
      ).toEqual({ unknown: 1 });
    } finally {
      await s.api('DELETE', `/plant/assets/rvs-mill-01/links/${link.id}`);
      await s.api('DELETE', `/monitors/${down}`);
    }
  });

  it('a site that does not exist or that the reader may not see answers 404', async () => {
    expect(await status(s.api('GET', '/plant/sites/nope/structure'))).toEqual({ status: 404, code: 'PLANT_SITE_NOT_FOUND' });
  });
});

describe('data flow of an asset', () => {
  it('goes from the asset over its interfaces, the gateway and the publications to the KPI job and its dataset', async () => {
    const g = await s.api('GET', '/plant/assets/rvs-mill-01/flow');
    expect(g.empty).toBeNull();
    const kinds = Object.fromEntries(g.nodes.map((n: { id: string; kind: string }) => [n.id, n.kind]));
    expect(kinds).toMatchObject({
      asset: 'asset',
      'if:opc-ua': 'interface',
      'if:nc-files': 'interface',
      'if:web-ui': 'interface',
      'col:opc ua gateway': 'collector',
      'tgt:iot-platform': 'target',
      'kpi:rvs-mill-01-machine-state': 'kpi',
      'ds:plant.machine-state': 'dataset',
    });
    const opc = byId(g.nodes, 'if:opc-ua');
    expect(opc).toMatchObject({ protocol: 'opc_ua', detail: 'opc.tcp://rvs-mill-01.ot.example.com:4840', inactive: false, live: null });
    // the web UI is documented, not active: dashed
    expect(byId(g.nodes, 'if:web-ui').inactive).toBe(true);
    expect(byId(g.edges, 'asset>if:web-ui')).toMatchObject({ inactive: true, points: 0 });
    // the file share has no data points, but files
    expect(byId(g.edges, 'asset>if:nc-files')).toMatchObject({ points: 0, files: 1, inactive: false });
    // edges carry the number of data points: all 8 of the OPC UA server reach the gateway, two are published
    expect(byId(g.edges, 'asset>if:opc-ua').points).toBe(8);
    expect(byId(g.edges, 'if:opc-ua>col:opc ua gateway').points).toBe(8);
    expect(byId(g.edges, 'col:opc ua gateway>tgt:iot-platform').points).toBe(2);
    expect(byId(g.nodes, 'tgt:iot-platform').detail).toBe('rvs-mill-01/machine-state / ProgramStatus\nrvs-mill-01/counters / PartCounter');
    // the KPI job reads the program status where it arrives, and shows its result in a dataset
    expect(byId(g.edges, 'tgt:iot-platform>kpi:rvs-mill-01-machine-state')).toMatchObject({ points: 1, problem: false });
    expect(byId(g.edges, 'kpi:rvs-mill-01-machine-state>ds:plant.machine-state')).toMatchObject({ result: true, points: 0 });
    // the dataset has no data yet: "no data", not ok
    expect(byId(g.nodes, 'ds:plant.machine-state').live).toEqual({
      source: 'dataset',
      state: 'unknown',
      status: 'no_data',
      label: 'plant.machine-state',
      path: null,
      at: null,
    });
    // hovering a data point highlights its path end to end
    const ps = byId(g.paths, 'program_status');
    expect(ps).toMatchObject({ kind: 'point', delivers: true });
    expect(ps.nodes).toEqual(['asset', 'if:opc-ua', 'col:opc ua gateway', 'tgt:iot-platform', 'kpi:rvs-mill-01-machine-state', 'ds:plant.machine-state']);
    expect(ps.edges).toContain('kpi:rvs-mill-01-machine-state>ds:plant.machine-state');
    expect(byId(g.paths, 'operating_mode').nodes).toEqual(['asset', 'if:opc-ua', 'col:opc ua gateway']);
  });

  it('marks an inactive interface and the failing check of the KPI job that reads through it', async () => {
    const g = await s.api('GET', '/plant/assets/rvs-mill-02/flow');
    expect(byId(g.nodes, 'if:opc-ua').inactive).toBe(true);
    expect(byId(g.edges, 'if:opc-ua>kpi:rvs-mill-02-machine-state')).toMatchObject({ problem: true });
    const kpi = byId(g.nodes, 'kpi:rvs-mill-02-machine-state');
    expect(kpi.checks.map((c: { code: string }) => c.code)).toEqual(['kpi_interface_inactive']);
    expect(byId(g.paths, 'program_status')).toMatchObject({ delivers: false, reason: 'interface_inactive' });
    // nothing flows past an inactive interface
    expect(g.edges.some((e: { from: string }) => e.from === 'if:opc-ua' && !e.from.startsWith('kpi'))).toBe(true);
    expect(g.nodes.some((n: { kind: string }) => n.kind === 'collector')).toBe(false);
  });

  it('a dataset with data shows its freshness; an override leaves a data point out', async () => {
    const proc = await s.api('POST', '/processes', { definition: { name: 'Machine state KPI', steps: [{ id: 'n', type: 'log', message: 'x' }] } });
    const { publishDataset } = await import('../src/dashboards/datasets.js');
    publishDataset({
      key: 'plant.machine-state',
      title: 'Machine state',
      processId: proc.id,
      processName: 'Machine state KPI',
      runId: 'run-plant-views',
      dryRun: false,
      columns: ['machine'],
      rows: [{ machine: 'rvs-mill-01', _status: 'good' } as never],
      metrics: {},
    });
    const g = await s.api('GET', '/plant/assets/rvs-mill-01/flow');
    expect(byId(g.nodes, 'ds:plant.machine-state').live).toMatchObject({ source: 'dataset', state: 'ok', status: 'fresh', path: '/dashboards' });
    // a viewer who may not see the process's datasets: "no data", the same as none
    await s.api('PUT', `/processes/${proc.id}/access`, { acl: [{ subject: 'user:dana', permissions: ['view'] }] });
    expect(byId((await users.vera!('GET', '/plant/assets/rvs-mill-01/flow')).nodes, 'ds:plant.machine-state').live).toMatchObject({
      state: 'unknown',
      status: 'no_data',
      at: null,
    });
    // the meter lacks its power factor (override): that data point has no way
    const m = await s.api('GET', '/plant/assets/rvs-mill-01-meter/flow');
    expect(byId(m.paths, 'power_factor')).toMatchObject({ delivers: false, reason: 'unavailable', nodes: ['asset'], edges: [] });
    expect(byId(m.edges, 'asset>if:modbus-tcp').points).toBe(8);
  });

  it('an asset without an assignment, or one the reader may not see', async () => {
    const g = await s.api('GET', '/plant/assets/rvs-compressor-01/flow');
    expect(g).toMatchObject({ empty: 'no_assignment', edges: [], paths: [] });
    expect(g.nodes.map((n: { id: string }) => n.id)).toEqual(['asset']);
    expect(await status(s.api('GET', '/plant/assets/nope/flow'))).toEqual({ status: 404, code: 'PLANT_ASSET_NOT_FOUND' });
  });
});

describe('lineage of a data point', () => {
  it('fans out from the point to the assets that deliver it, their publications and the KPIs that read it', async () => {
    const g = await s.api('GET', '/plant/profiles/example-controls-c80/points/program_status/lineage');
    expect(g).toMatchObject({ grouped: false, empty: null });
    expect(byId(g.nodes, 'point')).toMatchObject({ kind: 'point', label: 'Program status', protocol: 'opc_ua' });
    expect(byId(g.nodes, 'asset:rvs-mill-01')).toMatchObject({ inactive: false, path: '/plant/assets/rvs-mill-01/flow' });
    expect(byId(g.nodes, 'asset:rvs-mill-02').inactive).toBe(true);
    expect(byId(g.edges, 'point>asset:rvs-mill-02')).toMatchObject({ inactive: true, assets: 1 });
    expect(byId(g.edges, 'asset:rvs-mill-01>tgt:iot-platform').assets).toBe(1);
    const kpi = byId(g.nodes, 'kpi:machine-state-time');
    expect(kpi).toMatchObject({ instances: 2, path: '/plant/kpis/machine-state-time' });
    expect(kpi.checks).toHaveLength(1);
    expect(byId(g.edges, 'asset:rvs-mill-02>kpi:machine-state-time').problem).toBe(true);
    expect(byId(g.paths, 'rvs-mill-01').nodes).toEqual(['point', 'asset:rvs-mill-01', 'tgt:iot-platform', 'kpi:machine-state-time', 'ds:plant.machine-state']);
  });

  it('a profile no visible asset has: an empty picture; unknown points answer 404', async () => {
    await s.api('PUT', '/plant/sites/hillcrest/access', { acl: [{ subject: 'user:vera', permissions: ['view'] }] });
    try {
      const g = await users.dana!('GET', '/plant/profiles/example-plastics-mc6/points/cycle_counter/lineage');
      expect(g).toMatchObject({ empty: 'no_assets', edges: [], paths: [] });
      expect(JSON.stringify(g)).not.toContain('hlc');
    } finally {
      await s.api('PUT', '/plant/sites/hillcrest/access', { acl: [] });
    }
    expect(await status(s.api('GET', '/plant/profiles/example-controls-c80/points/nope/lineage'))).toEqual({ status: 404, code: 'PLANT_POINT_NOT_FOUND' });
    expect(await status(s.api('GET', '/plant/profiles/nope/points/x/lineage'))).toEqual({ status: 404, code: 'PLANT_PROFILE_NOT_FOUND' });
  });

  it('many assets: one node per site (level of detail), every asset still a path', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `lod-mill-${String(i).padStart(2, '0')}`);
    for (const id of ids) {
      await s.api('POST', '/plant/assets', { id, siteId: 'riverside', name: `LOD mill ${id.slice(-2)}` });
      await s.api('PUT', `/plant/assets/${id}/assignment`, {
        profileId: 'example-controls-c80',
        interfaces: [{ interface: 'opc-ua', active: id.endsWith('0') ? false : true, endpoint: '' }],
      });
    }
    try {
      const g = await s.api('GET', '/plant/profiles/example-controls-c80/points/program_status/lineage');
      expect(g.grouped).toBe(true);
      expect(g.nodes.filter((n: { kind: string }) => n.kind === 'asset')).toEqual([]);
      expect(byId(g.nodes, 'site:riverside').count).toEqual({ total: 32, delivering: 28 });
      expect(byId(g.edges, 'point>site:riverside').assets).toBe(32);
      expect(g.paths).toHaveLength(32);
    } finally {
      for (const id of ids) await s.api('DELETE', `/plant/assets/${id}`);
    }
  });
});

describe('KPI coverage', () => {
  it('has, could, cannot (with the missing inputs) and problem, per asset and KPI definition', async () => {
    const c = await s.api('GET', '/plant/views/coverage?site=riverside');
    expect(c.kpis.map((k: { id: string }) => k.id)).toEqual(['energy-consumption', 'machine-state-time']);
    const cell = (asset: string, kpi: string) => {
      const row = c.rows.find((r: { asset: { id: string } }) => r.asset.id === asset);
      return row.cells[c.kpis.findIndex((k: { id: string }) => k.id === kpi)];
    };
    expect(cell('rvs-mill-01', 'machine-state-time')).toEqual({ state: 'has', jobs: ['rvs-mill-01-machine-state'] });
    expect(cell('rvs-mill-02', 'machine-state-time')).toMatchObject({ state: 'problem', jobs: ['rvs-mill-02-machine-state'] });
    expect(cell('rvs-mill-02', 'machine-state-time').checks[0].code).toBe('kpi_interface_inactive');
    expect(cell('rvs-mill-01-meter', 'energy-consumption')).toEqual({ state: 'has', jobs: ['rvs-mill-01-energy'] });
    // a CNC controller cannot have the energy KPI: it reads another profile
    expect(cell('rvs-mill-01', 'energy-consumption')).toEqual({
      state: 'cannot',
      gaps: [
        { code: 'kpi_other_profile', params: { kpi: 'Energy consumption', profile: 'example-meters-pm200', assigned: 'Example Controls C80 CNC controller' } },
      ],
    });
    // without an assignment: no profile
    expect(cell('rvs-compressor-01', 'energy-consumption')).toEqual({
      state: 'cannot',
      gaps: [{ code: 'kpi_no_profile', params: { kpi: 'Energy consumption' } }],
    });
    expect(c.rows.find((r: { asset: { id: string } }) => r.asset.id === 'rvs-mill-01').profile).toEqual({
      id: 'example-controls-c80',
      name: 'Example Controls C80 CNC controller',
    });
    expect(c.total).toBe(c.rows.length);
    expect(c.truncated).toBe(false);
    const sum = Object.values(c.totals as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(sum).toBe(c.rows.length * c.kpis.length);
    expect(c.options.sites.map((x: { id: string }) => x.id).sort()).toEqual(['hillcrest', 'riverside']);
    expect(c.options.areas.some((a: { id: string; siteId: string }) => a.id === 'rvs-machining' && a.siteId === 'riverside')).toBe(true);
  });

  it('filters by area, profile and KPI; could have once an interface is set up', async () => {
    const byArea = await s.api('GET', '/plant/views/coverage?site=riverside&area=rvs-utilities');
    expect(byArea.rows.map((r: { asset: { id: string } }) => r.asset.id)).toEqual(['rvs-compressor-01']);
    const byProfile = await s.api('GET', '/plant/views/coverage?profile=example-controls-c80&kpi=machine-state-time');
    expect(byProfile.kpis.map((k: { id: string }) => k.id)).toEqual(['machine-state-time']);
    expect(byProfile.rows.map((r: { asset: { id: string } }) => r.asset.id).sort()).toEqual(['rvs-mill-01', 'rvs-mill-02']);
    expect(byProfile.totals).toEqual({ has: 1, problem: 1, could: 0, cannot: 0, unchecked: 0 });
    // milling centre 3 gets the profile with an active OPC UA interface: it could have the KPI
    await s.api('PUT', '/plant/assets/rvs-mill-03/assignment', {
      profileId: 'example-controls-c80',
      interfaces: [{ interface: 'opc-ua', active: true, endpoint: '' }],
    });
    try {
      const after = await s.api('GET', '/plant/views/coverage?profile=example-controls-c80&kpi=machine-state-time');
      expect(after.totals).toMatchObject({ has: 1, problem: 1, could: 1 });
    } finally {
      await s.api('DELETE', '/plant/assets/rvs-mill-03/assignment');
    }
    expect(await status(s.api('GET', '/plant/views/coverage?kpi=nope'))).toEqual({ status: 404, code: 'PLANT_KPI_NOT_FOUND' });
  });

  it('hidden sites are neither listed, counted nor offered as a filter', async () => {
    await s.api('PUT', '/plant/sites/hillcrest/access', { acl: [{ subject: 'user:vera', permissions: ['view'] }] });
    try {
      const c = await users.dana!('GET', '/plant/views/coverage');
      expect(c.rows.every((r: { asset: { siteId: string } }) => r.asset.siteId === 'riverside')).toBe(true);
      expect(c.options.sites.map((x: { id: string }) => x.id)).toEqual(['riverside']);
      expect(JSON.stringify(c)).not.toContain('hlc');
      expect(JSON.stringify(c)).not.toContain('hillcrest');
      // a hidden site as a filter reads like one that does not exist
      expect(await status(users.dana!('GET', '/plant/views/coverage?site=hillcrest'))).toEqual(
        await status(users.dana!('GET', '/plant/views/coverage?site=nope')),
      );
      expect(await status(users.dana!('GET', '/plant/sites/hillcrest/structure'))).toEqual({ status: 404, code: 'PLANT_SITE_NOT_FOUND' });
      expect(await status(users.dana!('GET', '/plant/assets/hlc-im-01/flow'))).toEqual({ status: 404, code: 'PLANT_ASSET_NOT_FOUND' });
      const tiles = await users.dana!('GET', '/plant/views/overview');
      expect(tiles.map((t: { siteId: string }) => t.siteId)).toEqual(['riverside']);
      // vera sees both
      expect((await users.vera!('GET', '/plant/views/overview')).map((t: { siteId: string }) => t.siteId).sort()).toEqual(['hillcrest', 'riverside']);
    } finally {
      await s.api('PUT', '/plant/sites/hillcrest/access', { acl: [] });
    }
  });

  it('a large selection stays within the cell limit and says so', async () => {
    const shared = await import('@sm/shared');
    const limits = shared.PLANT_VIEW_LIMITS as { coverageCells: number };
    const before = limits.coverageCells;
    // two KPI definitions: a limit of 6 cells leaves 3 rows, the totals still count every asset
    (limits as { coverageCells: number }).coverageCells = 6;
    try {
      const c = await s.api('GET', '/plant/views/coverage?site=riverside');
      expect(c.rows).toHaveLength(3);
      expect(c.truncated).toBe(true);
      expect(c.total).toBeGreaterThan(3);
      expect(Object.values(c.totals as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(c.total * 2);
    } finally {
      limits.coverageCells = before;
    }
  });
});

describe('site overview tiles', () => {
  it('per site: assets by status, KPI coverage and failing checks; the Plant viewer sees them too', async () => {
    const tiles = await users.pia!('GET', '/plant/views/overview');
    const rvs = tiles.find((t: { siteId: string }) => t.siteId === 'riverside');
    const site = await s.api('GET', '/plant/sites/riverside');
    expect(rvs.counts).toEqual(site.statusCounts);
    expect(rvs.total).toBe(site.assetCount);
    expect(rvs.checks).toBe(1);
    expect(rvs.coverage).toMatchObject({ has: 2, problem: 1 });
    expect(rvs.coverage.has + rvs.coverage.problem + rvs.coverage.could + rvs.coverage.cannot + rvs.coverage.unchecked).toBe(site.assetCount * 2);
    const { coveragePct } = await import('@sm/shared');
    expect(coveragePct(rvs.coverage)).toBe(100);
    expect(coveragePct({ has: 0, problem: 0, could: 0 })).toBeNull();
  });
});
