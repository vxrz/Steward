import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * A benchmark of the plant registry's write paths on a large plant (0.13.0, ADR 0020 "Performance"): a full import, a
 * re-import that changes 5 %, a bulk change of 1,000 assets, single saves of the edit forms and an assistant's proposal
 * of 500 entries applied – with the times and what the history and baselines add to the database. Not part of the
 * suite: it runs only with SM_PLANT_PERF=1 (on PostgreSQL with SM_TEST_DATABASE_URL as well). The same file runs on
 * the code of 0.12.0 (it only uses routes and functions 0.12.0 has), which is how the numbers are compared:
 *
 *   SM_PLANT_PERF=1 server/node_modules/.bin/vitest run --root server --testTimeout=3600000 --hookTimeout=3600000 test/plant-perf.test.ts
 *
 * SM_PLANT_PERF_SCALE (default 1) scales the plant: 3 sites, 5,000 assets, 10,000 devices, 5,000 data paths,
 * 1,000 data collections, 40 device profiles with 10,000 data points, 4,000 assignments.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const ON = process.env.SM_PLANT_PERF === '1';
const SCALE = Number(process.env.SM_PLANT_PERF_SCALE ?? '1') || 1;
const SITES = 3;
const ASSETS = Math.round(5000 * SCALE);
const PROFILES = 40;
const POINTS = Math.round(250 * SCALE);
const KPIS = 10;
const ASSIGNED = Math.round(ASSETS * 0.8);
const COLLECTIONS = Math.round(ASSETS * 0.2);
const PW = 'Plant-password-1';

let s: TestServer;
let dana: Client;
let token = '';
const results: { op: string; ms: number; note?: string }[] = [];
const db = async () => (await import('../src/db.js')).db();

const pad = (n: number, w = 5) => String(n).padStart(w, '0');
const siteOf = (i: number) => `s${(i % SITES) + 1}`;
const assetId = (i: number) => `a-${pad(i)}`;
const profileId = (p: number) => `prof-${pad(p, 2)}`;

/** The generated plant as import files (JSON is YAML); `version` changes 5 % of the entries. */
export function plantFiles(version = 0): { name: string; content: string }[] {
  const changed = (i: number) => version > 0 && i % 20 === 0;
  const files: { name: string; content: string }[] = [];
  // the catalogue: device profiles with their data points, KPI definitions
  files.push({
    name: 'catalogue.plant.json',
    content: JSON.stringify({
      version: 1,
      device_profiles: Array.from({ length: PROFILES }, (_, p) => ({
        id: profileId(p),
        name: `Example controller ${p}`,
        manufacturer: 'Example Controls',
        model: `EC-${p}`,
        category: 'Controller',
        description: changed(p) ? `Revision ${version}` : '',
        interfaces: [
          {
            id: 'opc',
            name: 'OPC UA server',
            protocol: 'opc_ua',
            groups: [
              {
                name: 'Values',
                data_points: Array.from({ length: POINTS }, (_, d) => ({
                  id: `dp_${pad(d, 4)}`,
                  name: `Value ${d}`,
                  data_type: d % 3 ? 'Float' : 'Int32',
                  unit: d % 2 ? 'kW' : '°C',
                  address: `ns=2;s=/Values/V${d}${changed(d) ? `-${version}` : ''}`,
                })),
              },
            ],
          },
        ],
      })),
      kpi_definitions: Array.from({ length: KPIS }, (_, k) => ({
        id: `kpi-${k}`,
        name: `Example KPI ${k}`,
        category: 'Energy',
        unit: 'kW.h',
        inputs: [{ profile: profileId(k), data_points: ['dp_0001'] }],
      })),
    }),
  });
  for (let si = 1; si <= SITES; si++) {
    const site = `s${si}`;
    const assets = Array.from({ length: ASSETS }, (_, i) => i).filter((i) => siteOf(i) === site);
    files.push({
      name: `${site}.plant.json`,
      content: JSON.stringify({
        version: 1,
        site: {
          id: site,
          code: `S${si}`,
          name: `Example works ${si}`,
          buildings: Array.from({ length: 4 }, (_, b) => ({ id: `${site}-hall-${b}`, name: `Hall ${b}`, kind: 'hall' })),
          areas: Array.from({ length: 4 }, (_, a) => ({
            id: `${site}-area-${a}`,
            name: `Area ${a}`,
            domain: 'machining',
            work_centers: Array.from({ length: 5 }, (_, w) => ({
              id: `${site}-wc-${a}-${w}`,
              name: `Line ${a}.${w}`,
              type: 'production_line',
              building: `${site}-hall-${a}`,
              work_units: [0, 1].map((u) => ({ id: `${site}-wu-${a}-${w}-${u}`, name: `Cell ${a}.${w}.${u}`, type: 'work_cell' })),
            })),
          })),
          assets: assets.map((i) => ({
            id: assetId(i),
            name: `Machine ${i}`,
            manufacturer: 'Example Machine Tools',
            model: changed(i) ? `M-${version}` : 'M-1',
            status: 'operational',
            location: { work_unit: `${site}-wu-${i % 4}-${i % 5}-${i % 2}` },
            taxonomy: { domain: 'machining', process_area: 'milling', role: 'machine' },
            tags: ['cnc', `line-${i % 5}`],
          })),
        },
        ot_network: {
          site,
          vlans: Array.from({ length: 10 }, (_, v) => ({
            id: `${site}-vlan-${v}`,
            name: `Cells ${v}`,
            vid: 100 + v,
            type: 'production',
            subnets: [{ cidr: `10.${si}.${v}.0/24`, gateway: `10.${si}.${v}.1` }],
          })),
          zones: Array.from({ length: 5 }, (_, z) => ({
            id: `${site}-zone-${z}`,
            name: `Zone ${z}`,
            level: 'control',
            vlans: [`${site}-vlan-${z * 2}`, `${site}-vlan-${z * 2 + 1}`],
          })),
          conduits: Array.from({ length: 4 }, (_, c) => ({
            id: `${site}-cdt-${c}`,
            name: `Conduit ${c}`,
            zones: [`${site}-zone-${c}`, `${site}-zone-${c + 1}`],
            direction: 'a_to_b',
            protocols: ['opc-ua tcp/4840'],
          })),
        },
        asset_networks: assets.map((i) => ({
          asset: assetId(i),
          devices: [0, 1].map((d) => ({
            id: `dev-${d}`,
            hostname: `${assetId(i)}-${d}`,
            domain: 'ot.example.com',
            vlan: `${site}-vlan-${i % 10}`,
            address_type: 'static',
            address: `10.${si}.${i % 10}.${(Math.floor(i / 30) % 200) + 10 + d}`,
            notes: changed(i) && d === 0 ? `Checked ${version}` : '',
          })),
          data_paths: [
            {
              id: 'state',
              subject: 'Machine state',
              devices: ['dev-0'],
              collector: { kind: 'job', ref: 'edge-gateway' },
              transfers: [{ protocol: 'opc-ua', mode: 'pull', peer_kind: 'device', peer: 'dev-0', port: 4840 }],
              destinations: [{ ref: 'IoT platform', path: `${assetId(i)}/state` }],
            },
          ],
          ...(i < COLLECTIONS
            ? {
                collections: [
                  {
                    id: 'values',
                    name: 'Edge gateway – values',
                    collector: { kind: 'job', ref: 'edge-gateway' },
                    interface: 'opc',
                    mode: 'interval',
                    interval_ms: changed(i) ? 2000 : 1000,
                    items: Array.from({ length: 10 }, (_, k) => ({ address: `/Values/V${k}`, output_name: `V${k}` })),
                  },
                ],
              }
            : {}),
        })),
        assignments: assets
          .filter((i) => i < ASSIGNED)
          .map((i) => ({
            asset: assetId(i),
            profile: profileId(i % PROFILES),
            firmware: changed(i) ? `2.${version}` : '2.0',
            interfaces: [{ interface: 'opc', active: true, endpoint: `opc.tcp://${assetId(i)}-0.ot.example.com:4840` }],
          })),
      }),
    });
  }
  return files;
}

async function timed<T>(op: string, fn: () => Promise<T>, note?: (r: T) => string): Promise<T> {
  const t = performance.now();
  const r = await fn();
  const ms = performance.now() - t;
  results.push({ op, ms, ...(note ? { note: note(r) } : {}) });
  return r;
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/** Rows and bytes of the tables 0.13 adds (0 where they do not exist), and the database. */
async function growth(): Promise<Record<string, number>> {
  const d = await db();
  const out: Record<string, number> = { databaseBytes: d.sizeBytes() };
  // SQLite: the database file without its write-ahead log (which a large transaction grows until a checkpoint)
  if (d.dialect === 'sqlite')
    out.sqliteFileBytes =
      Number(d.get<{ page_count: number }>('PRAGMA page_count')?.page_count ?? 0) * Number(d.get<{ page_size: number }>('PRAGMA page_size')?.page_size ?? 0);
  for (const t of ['plant_entry_history', 'plant_import_baselines', 'plant_change_sets', 'plant_change_ops', 'plant_change_sources']) {
    try {
      out[`${t}.rows`] = Number(d.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)?.n ?? 0);
    } catch {
      out[`${t}.rows`] = 0;
      continue;
    }
    try {
      out[`${t}.bytes`] =
        d.dialect === 'postgres'
          ? Number(d.get<{ n: number }>(`SELECT pg_total_relation_size(to_regclass(?)) AS n`, t)?.n ?? 0)
          : Number(d.get<{ n: number }>(`SELECT SUM(pgsize) AS n FROM dbstat WHERE name = ? OR name LIKE ?`, t, `sqlite_autoindex_${t}%`)?.n ?? 0) +
            Number(
              d.get<{ n: number }>(
                `SELECT SUM(s.pgsize) AS n FROM dbstat s JOIN sqlite_master m ON m.name = s.name WHERE m.type = 'index' AND m.tbl_name = ? AND m.name NOT LIKE 'sqlite_autoindex%'`,
                t,
              )?.n ?? 0,
            );
    } catch {
      out[`${t}.bytes`] = -1;
    }
  }
  // what the values take (the JSON text, without row and index overhead): history per operation, baselines
  try {
    for (const r of d.all<{ op: string; n: number; bytes: number }>(
      'SELECT op, COUNT(*) AS n, SUM(LENGTH(before_values) + LENGTH(after_values)) AS bytes FROM plant_entry_history GROUP BY op',
    ))
      out[`history.${r.op}.valueBytes`] = Number(r.bytes ?? 0);
    out['baselines.valueBytes'] = Number(d.get<{ n: number }>('SELECT SUM(LENGTH(field_values)) AS n FROM plant_import_baselines')?.n ?? 0);
  } catch {
    // 0.12.0: no such tables
  }
  return out;
}

/** A body of an entry's PUT route from its stored row: its values, only the keys the route takes. */
async function putBody(kind: 'asset' | 'device' | 'profile', row: Record<string, unknown>): Promise<Record<string, unknown>> {
  const model = await import('../src/plant/model.js');
  const data = await import('../src/plant/data-model.js');
  const net = await import('../src/plant/network-model.js');
  const [schema, values] =
    kind === 'asset'
      ? [model.assetUpdate, model.assetValuesOf(row as never, [])]
      : kind === 'device'
        ? [net.deviceUpdate, net.deviceValuesOf(row as never)]
        : [data.profileUpdate, data.profileValuesOf(row as never)];
  const shape = (schema as unknown as { shape: Record<string, unknown> }).shape;
  return Object.fromEntries(
    Object.keys(shape)
      .map((k) => [k, (values as unknown as Record<string, unknown>)[k] ?? null])
      .filter(([, v]) => v !== null),
  );
}

describe.skipIf(!ON)('plant registry write paths on a large plant (benchmark)', () => {
  beforeAll(async () => {
    s = await startTestServer();
    await setup(s);
    const { createUser } = await import('../src/auth/users.js');
    createUser({ username: 'dana', roles: ['designer'], password: PW });
    dana = await s.as('dana', PW);
    await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Example Components', labels: {}, fields: {} });
    await s.api('PUT', '/mcp-server', { enabled: true });
    token = (await dana('POST', '/me/tokens', { name: 'mcp dana', scope: 'mcp' })).token;
  });

  it('runs', async () => {
    const files = plantFiles();
    const bytes = files.reduce((n, f) => n + f.content.length, 0);
    console.log(
      `plant: ${SITES} sites, ${ASSETS} assets, ${ASSETS * 2} devices, ${ASSETS} data paths, ${COLLECTIONS} collections, ${PROFILES} profiles × ${POINTS} data points, ${ASSIGNED} assignments – ${(bytes / 1048576).toFixed(1)} MB of files`,
    );
    const before = await growth();

    // 1. the full import: preview, then apply (what Plant → Import does)
    const pre = await timed('import (full): preview', () => s.api('POST', '/plant/import/preview', { files, mode: 'update' }));
    expect(pre.ok, JSON.stringify(pre.problems?.slice(0, 3))).toBe(true);
    await timed('import (full): apply', () =>
      s.api('POST', '/plant/import', { files, mode: 'update', ...(pre.fingerprint ? { fingerprint: pre.fingerprint } : {}) }),
    );
    const afterImport = await growth();

    // 2. the same files with 5 % changed
    const again = plantFiles(2);
    const pre2 = await timed(
      're-import (5 % changed): preview',
      () => s.api('POST', '/plant/import/preview', { files: again, mode: 'update' }),
      (r) => JSON.stringify(r.counts),
    );
    expect(pre2.ok).toBe(true);
    await timed('re-import (5 % changed): apply', () =>
      s.api('POST', '/plant/import', { files: again, mode: 'update', ...(pre2.fingerprint ? { fingerprint: pre2.fingerprint } : {}) }),
    );
    const afterReimport = await growth();

    // 3. a bulk change of 1,000 assets (two requests of 500, the limit of one)
    for (const part of [0, 1]) {
      const items = Array.from({ length: 500 }, (_, i) => ({ scope: '', id: assetId((part * 500 + i) % ASSETS) }));
      const body = { kind: 'asset', action: 'edit', items, set: { model: `B-${part}`, addTags: ['bulk'] } };
      const p = await timed(`bulk change of 500 assets (${part + 1}/2): preview`, () => s.api('POST', '/plant/bulk/preview', body));
      await timed(`bulk change of 500 assets (${part + 1}/2): apply`, () =>
        s.api('POST', '/plant/bulk', { ...body, ...(p.fingerprint ? { fingerprint: p.fingerprint } : {}) }),
      );
    }
    const afterBulk = await growth();

    // 4. single saves of the edit forms: an asset, a device, a device profile (median of 10, after one to warm up)
    const d = await db();
    for (const [kind, label] of [
      ['asset', 'edit form: asset'],
      ['device', 'edit form: device'],
      ['profile', 'edit form: device profile'],
    ] as const) {
      const times: number[] = [];
      for (let n = 0; n <= 10; n++) {
        const i = (1000 + n * 7) % ASSETS;
        let url: string;
        let row: Record<string, unknown>;
        if (kind === 'asset') {
          row = d.get<Record<string, unknown>>('SELECT * FROM plant_assets WHERE id = ?', assetId(i))!;
          url = `/plant/assets/${assetId(i)}`;
        } else if (kind === 'device') {
          row = d.get<Record<string, unknown>>('SELECT * FROM plant_devices WHERE asset_id = ? AND id = ?', assetId(i), 'dev-1')!;
          url = `/plant/assets/${assetId(i)}/devices/dev-1`;
        } else {
          row = d.get<Record<string, unknown>>('SELECT * FROM plant_profiles WHERE id = ?', profileId(n % PROFILES))!;
          url = `/plant/profiles/${profileId(n % PROFILES)}`;
        }
        const body = await putBody(kind, row);
        const revision = typeof row.revision === 'number' || typeof row.revision === 'string' ? { revision: Number(row.revision) } : {};
        const t = performance.now();
        await s.api('PUT', url, { ...body, ...(kind === 'device' ? { notes: `Saved ${n}` } : { description: `Saved ${n}` }), ...revision });
        if (n > 0) times.push(performance.now() - t);
      }
      results.push({ op: `${label} (median of 10)`, ms: median(times), note: `min ${Math.min(...times).toFixed(0)}, max ${Math.max(...times).toFixed(0)}` });
    }

    // 5. an assistant's proposal of 500 assets (the document at its size limit), applied by a person
    const doc = {
      version: 1,
      assets: Array.from({ length: 500 }, (_, i) => (2000 + i) % ASSETS).map((i) => ({
        id: assetId(i),
        name: `Machine ${i}`,
        model: 'P-2',
        location: { site: siteOf(i) },
      })),
    };
    const res = await fetch(`${s.base}/api/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'propose_plant_changes',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'propose_plant_changes',
          arguments: { title: 'New models', rationale: 'From the example inventory', document: doc },
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: 'perf', version: '1' },
          },
        },
      }),
    });
    const proposal = JSON.parse(await res.text());
    const requestId = proposal.result?.structuredContent?.requestId;
    expect(requestId, JSON.stringify(proposal).slice(0, 500)).toBeTruthy();
    await timed('proposal of 500 assets: review page', () => s.api('GET', `/mcp-requests/${requestId}`));
    const done = await timed('proposal of 500 assets: apply', () =>
      s.api('POST', `/mcp-requests/${requestId}/decision`, { approve: true, comment: 'Checked' }),
    );
    expect(done.status).toBe('done');
    const end = await growth();

    const out = process.env.SM_PLANT_PERF_OUT;
    if (out)
      (await import('node:fs')).writeFileSync(
        out,
        JSON.stringify({ dialect: (await db()).dialect, scale: SCALE, results, growth: { before, afterImport, afterReimport, afterBulk, end } }, null, 1),
      );
    const table = results.map((r) => `| ${r.op} | ${r.ms.toFixed(0)} ms |${r.note ? ` ${r.note}` : ''}`).join('\n');
    const g = (o: Record<string, number>) => JSON.stringify(o);
    console.log(
      `\nPLANT-PERF ${(await db()).dialect}\n${table}\ngrowth before: ${g(before)}\nafter import: ${g(afterImport)}\nafter re-import: ${g(afterReimport)}\nafter bulk: ${g(afterBulk)}\nend: ${g(end)}\n`,
    );
  });
});
