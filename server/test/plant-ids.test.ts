import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Changing the ids of plant registry entries (0.11.0, docs/PLANT.md#changing-ids): the rename core for every kind of
 * entry, every reference that follows, the aliases that keep old ids working (internal reads, /api/v1, the web app's
 * redirect reads the new id from them), chains, conflicts, rights, the audit entry – and the registry of reference
 * columns, which fails when a column that may hold a plant id is not classified.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
let dana: Client;
let vera: Client;
let token = '';
const PW = 'Plant-password-1';
const OT = fs.readFileSync(path.resolve(__dirname, '../../examples/plant/brightwater-ot-network.plant.yaml'), 'utf8');

const status = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> =>
  p.then(
    () => ({ status: 200 }),
    (e: { status: number; body?: { code?: string } }) => ({ status: e.status, code: e.body?.code }),
  );
const rename = (c: Client, kind: string, id: string, newId: string, scope = '') => c('POST', '/plant/ids/rename', { kind, scope, id, newId });
const count = (refs: { what: string; count: number }[], what: string) => refs.find((r) => r.what === what)?.count ?? 0;
const v1 = async (url: string) => {
  const res = await fetch(`${s.base}/api/v1${url}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json()) as any };
};
const db = async () => (await import('../src/db.js')).db();

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const { createUser } = await import('../src/auth/users.js');
  createUser({ username: 'dana', roles: ['designer'], password: PW });
  createUser({ username: 'vera', roles: ['viewer'], password: PW });
  dana = await s.as('dana', PW);
  vera = await s.as('vera', PW);
  token = (await s.api('POST', '/me/tokens', { name: 'read', scope: 'read' })).token;
  await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
  await s.api('POST', '/plant/import', { files: [{ name: 'ot.plant.yaml', content: OT }], mode: 'add' });
});

describe('the registry of reference columns', () => {
  /** Columns of plant tables that hold no plant id (or the entry's own data); a new column fails until it is listed. */
  const PLAIN: Record<string, string[]> = {
    plant_sites: ['code', 'name', 'names', 'description', 'lat', 'lon', 'zoom', 'contacts', 'fields', 'acl'],
    plant_nodes: ['level', 'name', 'names', 'type', 'domain', 'description', 'position', 'fields'],
    plant_buildings: ['name', 'names', 'kind', 'description', 'position', 'fields'],
    plant_assets: [
      'name',
      'manufacturer',
      'model',
      'status',
      'domain',
      'process_area',
      'role',
      'tags',
      'commissioned',
      'end_of_support',
      'description',
      'capabilities',
      'image_name',
      'fields',
    ],
    plant_asset_images: ['mime', 'size', 'width', 'height', 'sha256', 'data'],
    // kind: site or asset (registered as pairs)
    plant_refs: ['kind', 'position', 'system', 'ref_id', 'url', 'label'],
    plant_imports: ['id', 'mode', 'missing', 'replaces', 'files', 'sha256', 'counts'],
    plant_profiles: ['name', 'manufacturer', 'model', 'version', 'category', 'description', 'notes', 'template'],
    plant_kpis: [
      'name',
      'names',
      'category',
      'kind',
      'description',
      'formula',
      'unit',
      'range_min',
      'range_max',
      'trend',
      'timing',
      'audience',
      'methodology',
      'strategy',
      'implementation',
      'dynamic_columns',
      'parameters',
      'result_columns',
      'computation',
      'notes',
      // 0.13: none or parts
      'roll_up',
    ],
    plant_assignments: ['firmware', 'notes'],
    plant_vlans: [
      'name',
      'vid',
      'type',
      'owner',
      'description',
      'subnets',
      'restricted',
      'managed_by',
      'rules_at',
      'location',
      'segment_id',
      'notes',
      'position',
    ],
    plant_zones: ['name', 'description', 'criticality', 'level', 'owner', 'sl_target', 'risk_assessment', 'assessed_at', 'notes', 'position'],
    plant_conduits: ['name', 'description', 'direction', 'protocols', 'controls', 'notes', 'position'],
    plant_devices: [
      'hostname',
      'domain',
      'purpose',
      'mac',
      'serial',
      'address_type',
      'address',
      'switch_name',
      'switch_port',
      'wall_outlet',
      'cmdb_port',
      'state',
      'flags',
      'confidence',
      'owner',
      'monitoring',
      // live-status checks name monitors and datasets; a dataset filter's value names rows of an outside dataset
      'checks',
      'notes',
      'position',
    ],
    plant_data_paths: ['subject', 'description', 'collector', 'destinations', 'notes', 'position'],
    // live-status checks of an asset (monitors, datasets)
    plant_asset_checks: ['checks'],
    // data collections (0.11.0): the collector is a Steward item or a job name, its destination a system or dataset;
    // triggers name addresses as the collector writes them
    plant_collections: [
      'id',
      'name',
      'collector',
      'mode',
      'interval_ms',
      'debounce_ms',
      'triggers',
      'composition',
      'destination',
      'access',
      'settings',
      'description',
      'notes',
      'format',
      'source_file',
      'position',
      // 0.12: where the data goes (sinks name Steward items and text, not plant entries); the gateway configuration record
      'sinks',
      'document_id',
    ],
    plant_collection_mappings: ['collector_key', 'gateway_name'],
    // 0.12: the kept files of collection imports (their asset is in REFERENCES; `collections` are ids within the asset)
    plant_collection_sources: [
      'id',
      'collector_key',
      'collector',
      'version',
      'file_name',
      'format',
      'sha256',
      'size',
      'content',
      'redacted_sha256',
      'redacted_paths',
      'collections',
      'imported_by',
      'imported_at',
    ],
    // 0.12.0: an assistant's proposal – its document names plant ids as a file does; an old id in it is read through the
    // aliases when it is applied (as in a file), so a rename never needs to rewrite it
    plant_proposals: ['id', 'title', 'document', 'sha256', 'preview', 'fingerprint'],
    // written by the rename core itself (ids.ts writeAlias)
    plant_id_aliases: ['kind', 'old_id', 'new_id', 'renamed_at'],
  };
  const SOURCE = ['import_id', 'not_in_source', 'created_at', 'created_by', 'updated_at', 'updated_by', 'renamed_by'];
  /**
   * Tables outside the module with a kind column (polymorphic references) that never hold a plant kind – the ones
   * that do are in REFERENCES (item_links, resource_teams, copied_from, plant_refs; credentials' used_by by its JSON).
   */
  const OTHER_KINDS: Record<string, string> = {
    platforms: 'the platform type',
    platform_docs: 'a document kind',
    platform_types: 'the platform type',
    run_artifacts: 'an artifact kind',
    users: 'users.profile is the person profile, not a device profile',
    backup_runs: 'what started a backup',
    mcp_requests: 'a request kind',
    reports: 'a report kind',
    credential_events: 'an event kind',
    record_events: 'an event kind',
    record_attachments: 'an attachment kind',
    record_documents: 'a pending document kind',
    record_editions: 'an edition kind',
    sync_updates: 'Git sync items: processes, monitors, dashboards',
    sync_items: 'Git sync items: processes, monitors, dashboards',
    ticket_ref_events: 'an event kind (affected items are item_links)',
    access_findings: 'a finding kind',
    control_tags: 'CONTROL_TAG_KINDS: processes, record types, records, monitors, report schedules, access checks',
    identity_aliases: 'users and teams',
    maintenance_windows: 'a window kind: maintenance or downtime',
    eol_notices: 'components',
    systems: 'the system kind',
    maintenance_targets: 'MAINTENANCE_TARGET_KINDS: platforms, systems, applications, services, monitors',
    maintenance_notices: 'a notice kind',
    stack_version_watch: 'applications and systems',
    service_duties: 'an interval',
    duty_periods: 'an interval',
    duty_notifications: 'a notice kind',
    db_schema_snapshots: 'platforms and systems',
    db_schema_settings: 'platforms and systems',
    db_schema_push_tokens: 'platforms and systems',
    data_contract_links: 'datasets, platforms and systems',
    approval_posts: 'runs and MCP requests',
    teams_conversations: 'a conversation kind',
    teams_cards: 'runs and MCP requests',
  };

  it('classifies every column of the plant tables and every polymorphic reference elsewhere', async () => {
    const { REFERENCES } = await import('../src/plant/rename.js');
    const d = await db();
    const columns: { table: string; column: string }[] =
      d.dialect === 'sqlite'
        ? d
            .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
            .flatMap((t) => d.all<{ name: string }>(`PRAGMA table_info(${t.name})`).map((c) => ({ table: t.name, column: c.name })))
        : d.all<{ table: string; column: string }>(
            'SELECT table_name AS "table", column_name AS "column" FROM information_schema.columns WHERE table_schema = current_schema()',
          );
    const registered = new Set(REFERENCES.map((r) => `${r.table}.${r.column.split('[')[0]}`));
    const problems: string[] = [];
    for (const c of columns) {
      const k = `${c.table}.${c.column}`;
      if (c.table.startsWith('plant_')) {
        if (registered.has(k) || SOURCE.includes(c.column) || PLAIN[c.table]?.includes(c.column)) continue;
        problems.push(`${k}: a plant id? add it to REFERENCES (plant/rename.ts) or to PLAIN here`);
      } else if (/(^|_)kind$/.test(c.column) || /^(site|asset|profile|kpi|vlan|zone|conduit|device|building|node)(_id|_ids)?$/.test(c.column)) {
        if ([...registered].some((r) => r.startsWith(`${c.table}.`)) || OTHER_KINDS[c.table] !== undefined) continue;
        problems.push(`${k}: may it name a plant entry? add it to REFERENCES (plant/rename.ts) or to OTHER_KINDS here`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('renaming one entry', () => {
  it('renames a site: everything in it, links, owning teams and the import follow; the old id still reads', async () => {
    const before = await s.api('GET', '/plant/sites/riverside');
    // a record links to the site, and to a conduit of it
    const rec = (await s.api('GET', '/records?limit=1'))[0] ?? null;
    const preview = await s.api('POST', '/plant/ids/rename/preview', { kind: 'site', id: 'riverside', newId: 'rvs' });
    expect(preview.problem).toBeNull();
    expect(count(preview.references, 'asset')).toBeGreaterThan(0);
    expect(count(preview.references, 'node')).toBeGreaterThan(0);
    expect(count(preview.references, 'vlan')).toBeGreaterThan(0);
    expect(preview.aliases).toEqual(['riverside']);
    // the preview changes nothing
    expect((await s.api('GET', '/plant/sites/riverside')).id).toBe('riverside');
    const r = await rename(s.api, 'site', 'riverside', 'rvs');
    expect(r).toMatchObject({ newId: 'rvs', path: '/plant/sites/rvs', aliases: ['riverside'] });
    const after = await s.api('GET', '/plant/sites/rvs');
    expect(after.areas.map((a: { id: string }) => a.id)).toEqual(before.areas.map((a: { id: string }) => a.id));
    expect((await s.api('GET', '/plant/assets/rvs-mill-01')).location.site.id).toBe('rvs');
    // the old id reads as the entry (internal and public API)
    expect((await s.api('GET', '/plant/sites/riverside')).id).toBe('rvs');
    expect((await s.api('GET', '/plant/sites/riverside/network')).vlans.length).toBeGreaterThan(0);
    expect((await v1('/plant/sites/riverside')).body.id).toBe('rvs');
    expect((await v1('/plant/assets?site=riverside')).body.items.length).toBeGreaterThan(0);
    // writes name the entry by its id
    expect(await status(s.api('PUT', '/plant/sites/riverside', { code: 'RVS', name: 'x' }))).toMatchObject({ status: 404 });
    // the import that wrote it knows the new id
    expect((await s.api('GET', '/plant/imports')).some((i: { sites: string[] }) => i.sites.includes('rvs'))).toBe(true);
    const log = await s.api('GET', '/audit?action=plant.id_changed&limit=1');
    expect(log[0]).toMatchObject({ entityType: 'site', entityId: 'rvs' });
    expect(log[0].details).toMatchObject({ kind: 'site', old: 'riverside', new: 'rvs' });
    void rec;
  });

  it('chains collapse and a rename back removes the alias', async () => {
    await rename(s.api, 'site', 'rvs', 'rvs-works');
    const aliases = await s.api('GET', '/plant/aliases');
    expect(aliases.filter((a: { kind: string }) => a.kind === 'site')).toEqual([
      expect.objectContaining({ oldId: 'riverside', newId: 'rvs-works' }),
      expect.objectContaining({ oldId: 'rvs', newId: 'rvs-works' }),
    ]);
    expect((await s.api('GET', '/plant/sites/riverside')).id).toBe('rvs-works');
    await rename(s.api, 'site', 'rvs-works', 'riverside');
    const back = (await s.api('GET', '/plant/aliases')).filter((a: { kind: string }) => a.kind === 'site');
    expect(back.map((a: { oldId: string; newId: string }) => `${a.oldId}→${a.newId}`)).toEqual(['rvs→riverside', 'rvs-works→riverside']);
  });

  it('renames an asset with its assignment, network, links and children', async () => {
    const r = await rename(s.api, 'asset', 'rvs-mill-01', 'rvs-mill-a');
    expect(count(r.references, 'assignment')).toBe(1);
    expect(count(r.references, 'device')).toBeGreaterThan(0);
    expect(count(r.references, 'asset')).toBe(1); // the meter is part of it
    expect((await s.api('GET', '/plant/assets/rvs-mill-01-meter')).parent.id).toBe('rvs-mill-a');
    expect((await s.api('GET', '/plant/assets/rvs-mill-01/assignment')).asset.id).toBe('rvs-mill-a');
    expect((await s.api('GET', '/plant/assets/rvs-mill-01/network')).devices.length).toBeGreaterThan(0);
    expect((await v1('/plant/assets/rvs-mill-01')).body.id).toBe('rvs-mill-a');
  });

  it('renames entries in a site, an asset and a profile; their references follow', async () => {
    // a building that nodes name, a node assets stand in
    const b = await rename(s.api, 'building', 'rvs-hall-1', 'rvs-h1', 'riverside');
    expect(count(b.references, 'node')).toBeGreaterThan(0);
    const site = await s.api('GET', '/plant/sites/riverside');
    expect(site.buildings.map((x: { id: string }) => x.id)).toContain('rvs-h1');
    const n = await rename(s.api, 'node', 'rvs-machining', 'rvs-mach', 'riverside');
    expect(count(n.references, 'node')).toBeGreaterThan(0);
    expect((await s.api('GET', '/plant/assets/rvs-mill-a')).location.area.id).toBe('rvs-mach');
    // VLAN → zones and devices; zone → conduits; device → data paths
    const vl = await rename(s.api, 'vlan', 'rvs-vlan-110', 'rvs-v110', 'riverside');
    expect(count(vl.references, 'zone')).toBe(1);
    expect(count(vl.references, 'device')).toBeGreaterThan(0);
    const z = await rename(s.api, 'zone', 'rvs-zone-cells', 'rvs-cells', 'riverside');
    expect(count(z.references, 'conduit')).toBe(1);
    await rename(s.api, 'conduit', 'rvs-cdt-cells-dmz', 'rvs-c1', 'riverside');
    const dv = await rename(s.api, 'device', 'rvs-mill-01-ipc', 'rvs-ipc', 'rvs-mill-a');
    expect(count(dv.references, 'data_path')).toBeGreaterThan(0);
    await rename(s.api, 'data_path', 'machine-state', 'state', 'rvs-mill-a');
    const net = await s.api('GET', '/plant/sites/riverside/network');
    expect(net.zones.find((x: { id: string }) => x.id === 'rvs-cells').vlans).toContain('rvs-v110');
    expect(net.conduits[0].zones).toContain('rvs-cells');
    const an = await s.api('GET', '/plant/assets/rvs-mill-a/network');
    expect(an.devices.find((d: { id: string }) => d.id === 'rvs-ipc').vlan).toBe('rvs-v110');
    expect(an.dataPaths.find((p: { id: string }) => p.id === 'state').devices).toContain('rvs-ipc');
    // a scoped old id reads in its scope, also under the scope's old id
    expect(
      (await s.api('GET', '/plant/aliases')).some(
        (a: { kind: string; scope: string; oldId: string }) => a.kind === 'vlan' && a.scope === 'riverside' && a.oldId === 'rvs-vlan-110',
      ),
    ).toBe(true);
  });

  it('renames a profile, an interface, a data point and a KPI definition', async () => {
    const p = await rename(s.api, 'profile', 'example-controls-c80', 'ctrl-c80');
    expect(count(p.references, 'assignment')).toBeGreaterThan(0);
    expect(count(p.references, 'kpi')).toBeGreaterThan(0);
    const i = await rename(s.api, 'interface', 'opc-ua', 'opcua', 'ctrl-c80');
    expect(count(i.references, 'assignment')).toBeGreaterThan(0);
    const d = await rename(s.api, 'data_point', 'spindle_speed', 'SpindleSpeed', 'ctrl-c80');
    expect(d.path).toBe('/plant/profiles/ctrl-c80/points/SpindleSpeed');
    const point = await s.api('GET', '/plant/profiles/example-controls-c80/points/spindle_speed');
    expect(point.point.id).toBe('SpindleSpeed');
    const k = await rename(s.api, 'kpi', 'machine-state-time', 'mst');
    expect(count(k.references, 'assignment')).toBeGreaterThan(0);
    const a = await s.api('GET', '/plant/assets/rvs-mill-a/assignment');
    expect(a.assignment.profileId).toBe('ctrl-c80');
    expect(a.assignment.interfaces.map((x: { interface: string }) => x.interface)).toContain('opcua');
    expect(a.assignment.kpis.map((x: { kpi: string }) => x.kpi)).toContain('mst');
    expect((await s.api('GET', '/plant/kpis/mst')).inputs[0]).toMatchObject({ profile: 'ctrl-c80' });
    expect((await s.api('GET', '/plant/kpis/mst')).inputs[0].dataPoints).not.toContain('spindle_speed');
    // the checks find nothing new to complain about
    expect((await s.api('GET', '/plant/checks')).filter((c: { code: string }) => c.code.includes('UNKNOWN'))).toEqual([]);
  });

  it('refuses a taken id, an old id of another entry, a wrong format, and asks for the right to change the entry', async () => {
    expect(await status(rename(s.api, 'site', 'riverside', 'hillcrest'))).toEqual({ status: 409, code: 'PLANT_ID_TAKEN' });
    expect(await status(rename(s.api, 'site', 'riverside', 'Bad Id'))).toEqual({ status: 400, code: 'PLANT_ID_FORMAT' });
    expect(await status(rename(s.api, 'site', 'hillcrest', 'rvs'))).toEqual({ status: 409, code: 'PLANT_ID_ALIAS' });
    expect(await status(rename(s.api, 'site', 'nowhere', 'x'))).toEqual({ status: 404, code: 'PLANT_ENTRY_NOT_FOUND' });
    expect(await status(rename(s.api, 'building', 'rvs-h1', 'x'))).toEqual({ status: 400, code: 'PLANT_ID_SCOPE' });
    expect(await status(rename(vera, 'site', 'hillcrest', 'hc'))).toEqual({ status: 403, code: 'FORBIDDEN' });
    expect(await status(vera('POST', '/plant/ids/rename/preview', { kind: 'site', id: 'hillcrest', newId: 'hc' }))).toMatchObject({ status: 403 });
    // a catalogue entry: whoever manages the catalogues (designers)
    expect((await rename(dana, 'kpi', 'energy-consumption', 'energy')).newId).toBe('energy');
    // a new entry cannot take an old id until an administrator removes the alias
    expect(await status(s.api('POST', '/plant/sites', { id: 'rvs', name: 'Another' }))).toEqual({ status: 409, code: 'PLANT_ID_ALIAS' });
    expect(await status(dana('DELETE', '/plant/aliases/site/rvs'))).toMatchObject({ status: 403 });
    await s.api('DELETE', '/plant/aliases/site/rvs');
    expect((await s.api('POST', '/plant/sites', { id: 'rvs', name: 'Another' })).id).toBe('rvs');
    expect((await s.api('GET', '/audit?action=plant.id_alias_removed&limit=1'))[0].details).toMatchObject({ oldId: 'rvs', newId: 'riverside' });
    await s.api('DELETE', '/plant/sites/rvs');
  });

  it('a single rename asks for a step-up only when the policy says so', async () => {
    const strict = await s.as('dana', PW, { autoStepUp: false });
    await strict('DELETE', '/auth/step-up');
    // off by default
    expect((await rename(strict, 'kpi', 'energy', 'energy-2')).newId).toBe('energy-2');
  });

  it('removing an entry removes the aliases that led to it: its old ids are free again', async () => {
    await s.api('POST', '/plant/sites', { id: 'tmp-a', name: 'Temporary' });
    await rename(s.api, 'site', 'tmp-a', 'tmp-b');
    await s.api('DELETE', '/plant/sites/tmp-b');
    expect((await s.api('GET', '/plant/aliases')).some((a: { oldId: string }) => a.oldId === 'tmp-a')).toBe(false);
    expect((await s.api('POST', '/plant/sites', { id: 'tmp-a', name: 'Again' })).id).toBe('tmp-a');
    await s.api('DELETE', '/plant/sites/tmp-a');
  });
});
