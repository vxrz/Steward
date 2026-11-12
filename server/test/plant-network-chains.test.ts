import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { dataPathEnds, type PlantDataPathValues } from '@sm/shared';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Chains of data paths (0.20.0, docs/PLANT.md#chains-of-data-paths). A transfer is seen from the collector: pull – it
 * fetches from the peer (a source), push – it sends to the peer (a target), receive – the peer sends to it (a source).
 * A path reads from its pull and receive peers (else from the system its collector runs on) and writes to its push
 * peers and destinations; it continues in the paths that read from what it writes to. Paths that only write into the
 * same system are never linked.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const sys: Record<string, string> = {};
const assetNet = (asset: string) => s.api('GET', `/plant/assets/${asset}/network`);
const pathOf = async (asset: string, id: string) => (await assetNet(asset)).dataPaths.find((p: { id: string }) => p.id === id);
const links = (list: { assetId: string; pathId: string }[]) => list.map((x) => `${x.assetId}/${x.pathId}`).sort();

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
  const files = ['brightwater.plant.yaml', 'brightwater-ot-network.plant.yaml'].map((name) => ({
    name,
    content: fs.readFileSync(path.resolve(__dirname, '../../examples/plant', name), 'utf8'),
  }));
  await s.api('POST', '/plant/import', { files, mode: 'add' });
  for (const name of ['gateway', 'iot', 'influx', 'share', 'archive', 'historian'])
    sys[name] = (await s.api('POST', '/systems', { name: `Invented ${name}`, kind: 'server' })).id;
});

describe('what a data path reads from and writes to', () => {
  const p = (x: Partial<PlantDataPathValues>): PlantDataPathValues => ({
    id: 'p',
    subject: 'S',
    description: '',
    devices: [],
    collector: null,
    transfers: [],
    destinations: [],
    notes: '',
    ...x,
  });
  const t = (mode: 'pull' | 'push' | 'receive', peer: string, peerKind: 'system' | 'device' | 'other' = 'system') => ({
    protocol: 'mqtt',
    mode,
    peerKind,
    peer,
    port: null,
    notes: '',
  });

  it('pull and receive peers are sources, push peers and destinations targets', () => {
    expect(
      dataPathEnds(
        p({
          transfers: [t('pull', 'a'), t('receive', 'b'), t('push', 'c'), t('push', 'plc', 'device')],
          destinations: [{ kind: 'system', ref: 'd', path: '', notes: '' }],
        }),
      ),
    ).toEqual({ from: ['system:a', 'system:b'], to: ['system:c', 'system:d'] });
  });

  it('the collector’s host is a source only without a pull or receive transfer', () => {
    expect(dataPathEnds(p({ collector: { kind: 'job', ref: 'archive', host: 'share' } })).from).toEqual(['system:share']);
    expect(dataPathEnds(p({ collector: { kind: 'job', ref: 'archive', host: 'share' }, transfers: [t('push', 'x')] })).from).toEqual(['system:share']);
    expect(dataPathEnds(p({ collector: { kind: 'job', ref: 'gw', host: 'gw' }, transfers: [t('receive', 'plc', 'device')] })).from).toEqual([]);
    expect(dataPathEnds(p({ collector: { kind: 'job', ref: 'gw', host: 'gw' }, transfers: [t('pull', 'plc', 'other')] })).from).toEqual([]);
  });
});

describe('chains', () => {
  it('two assets whose gateways push into the same platform are not chained; a job reading from it continues both', async () => {
    // the PLC publishes to the gateway (receive), which pushes to the IoT platform and to InfluxDB
    for (const asset of ['rvs-mill-01', 'rvs-mill-02'])
      await s.api('POST', `/plant/assets/${asset}/paths`, {
        id: 'bfc',
        subject: 'Machine data over the gateway',
        collector: { kind: 'job', ref: `bfc-${asset}`, host: sys.gateway },
        transfers: [
          { protocol: 'mqtt', mode: 'receive', peerKind: 'other', peer: 'PLC', port: 1883 },
          { protocol: 'https', mode: 'push', peerKind: 'system', peer: sys.iot, port: 443 },
          { protocol: 'http', mode: 'push', peerKind: 'system', peer: sys.influx, port: 8086 },
        ],
      });
    const one = await pathOf('rvs-mill-01', 'bfc');
    expect(one.next).toEqual([]);
    expect(one.previous).toEqual([]);
    expect((await pathOf('rvs-mill-02', 'bfc')).next).toEqual([]);

    // a job that pulls from InfluxDB continues both; they come before it
    await s.api('POST', '/plant/assets/rvs-press-01/paths', {
      id: 'report',
      subject: 'Shift report',
      collector: { kind: 'job', ref: 'report-job', host: sys.historian },
      transfers: [{ protocol: 'http', mode: 'pull', peerKind: 'system', peer: sys.influx }],
      destinations: [{ kind: 'system', ref: sys.historian }],
    });
    const report = await pathOf('rvs-press-01', 'report');
    expect(links(report.previous)).toEqual(['rvs-mill-01/bfc', 'rvs-mill-02/bfc']);
    expect(report.previous.every((x: { via: string }) => x.via === sys.influx)).toBe(true);
    expect(links((await pathOf('rvs-mill-01', 'bfc')).next)).toEqual(['rvs-press-01/report']);
    // a path whose collector runs on the gateway but receives from the PLC does not read from the gateway
    await s.api('POST', '/plant/assets/rvs-mill-03/paths', {
      id: 'to-gateway',
      subject: 'Into the gateway',
      collector: { kind: 'job', ref: 'copy' },
      transfers: [{ protocol: 'sftp', mode: 'push', peerKind: 'system', peer: sys.gateway }],
    });
    expect((await pathOf('rvs-mill-03', 'to-gateway')).next).toEqual([]);
    expect((await pathOf('rvs-mill-01', 'bfc')).previous).toEqual([]);
  });

  it('pull job → file share → archive job on the share: the collector’s host is where the archive job reads', async () => {
    await s.api('POST', '/plant/assets/rvs-mill-02/paths', {
      id: 'programs-out',
      subject: 'NC programs back',
      devices: ['rvs-mill-02-ipc'],
      collector: { kind: 'job', ref: 'pull-job' },
      transfers: [{ protocol: 'smb', mode: 'pull', peerKind: 'device', peer: 'rvs-mill-02-ipc', port: 445 }],
      destinations: [{ kind: 'system', ref: sys.share, path: '\\\\share\\nc' }],
    });
    await s.api('POST', '/plant/assets/rvs-press-01/paths', {
      id: 'archive',
      subject: 'Archive of NC programs',
      collector: { kind: 'job', ref: 'archive-job', host: sys.share },
      transfers: [{ protocol: 'sftp', mode: 'push', peerKind: 'system', peer: sys.archive }],
    });
    const archive = await pathOf('rvs-press-01', 'archive');
    expect(archive.previous).toEqual([expect.objectContaining({ assetId: 'rvs-mill-02', pathId: 'programs-out', via: sys.share })]);
    expect((await pathOf('rvs-mill-02', 'programs-out')).next).toEqual([expect.objectContaining({ assetId: 'rvs-press-01', pathId: 'archive' })]);
  });

  it('a push peer is a target: what pushes into a system is not read from it', async () => {
    // before 0.20, pushing to the share counted as reading from it, and the two paths that write there were chained
    await s.api('POST', '/plant/assets/rvs-mill-01/paths', {
      id: 'push-share',
      subject: 'Programs pushed to the share',
      collector: { kind: 'job', ref: 'push-job' },
      transfers: [{ protocol: 'smb', mode: 'push', peerKind: 'system', peer: sys.share }],
    });
    const pushed = await pathOf('rvs-mill-01', 'push-share');
    expect(pushed.previous).toEqual([]);
    expect(links(pushed.next)).toEqual(['rvs-press-01/archive']);
    expect(links((await pathOf('rvs-mill-02', 'programs-out')).next)).toEqual(['rvs-press-01/archive']);
  });

  it('the file format and the API take the mode receive', async () => {
    const yaml = await s.api('GET', '/plant/export?site=riverside');
    expect(yaml).toContain('mode: receive');
    expect(JSON.stringify(await s.api('GET', '/plant/schema'))).toContain('"receive"');
    // read back in, it is the same data path
    const r = await s.api('POST', '/plant/import/preview', { files: [{ name: 'riverside.plant.yaml', content: yaml }], mode: 'update' });
    expect(r.problems).toEqual([]);
    expect(r.counts).toMatchObject({ add: 0, change: 0 });
  });
});
