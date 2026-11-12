import { describe, expect, it } from 'vitest';
import type { PlantDataPathView, PlantItemRef, PlantSiteNetwork } from '@sm/shared';
import { networkGraph, type NetworkWords } from '../../web/src/pages/plant/views/networkGraph.js';

/**
 * The OT network diagram's graph (web/src/pages/plant/views/networkGraph.ts, 0.20.0): where the data of a path comes
 * from – what the collector pulls from or receives from – and where it goes – what it pushes to and its destinations,
 * each a target of its own.
 */

const words: NetworkWords = {
  vid: (v) => `VID ${v}`,
  criticality: (c) => c,
  sl: (l) => (l ? `SL-T ${l}` : 'SL-T open'),
  direction: (d) => d,
  devices: (n) => `${n} devices`,
  paths: (n) => `${n} paths`,
  deviceLine: (d) => d.address,
  collectorKind: (k) => k,
  mode: (m) => m,
  on: (h) => `on ${h}`,
  level: () => 'level',
  label: {
    devices: 'Devices',
    subnets: 'Subnets',
    owner: 'Owner',
    vlans: 'VLANs',
    protocols: 'Protocols',
    controls: 'Controls',
    assessment: 'Assessment',
    managedBy: 'Managed by',
    segment: 'Segment',
    restricted: 'Restricted',
    level: 'Level',
  },
  yes: 'yes',
  hidden: 'Not visible',
  noVlan: 'No VLAN',
};

const ref = (id: string, label: string): PlantItemRef => ({ kind: 'system', id, label, path: `/systems/${id}`, visible: true });
const notWatched = { state: 'unknown' as const, watched: false, checks: [] };

function site(paths: Partial<PlantDataPathView>[]): PlantSiteNetwork {
  const dataPaths = paths.map(
    (p, i) =>
      ({
        id: `p${i}`,
        subject: `Path ${i}`,
        description: '',
        devices: [],
        collector: null,
        transfers: [],
        destinations: [],
        notes: '',
        assetId: `a${i}`,
        assetName: `Asset ${i}`,
        collectorRef: null,
        collectorHost: null,
        peers: [],
        targets: [],
        next: [],
        previous: [],
        nextMore: 0,
        previousMore: 0,
        importId: null,
        notInSource: false,
        revision: 1,
        ...p,
      }) as PlantDataPathView,
  );
  return {
    site: { id: 's', code: 'S', name: 'Site', names: {} },
    canManage: false,
    canPropose: false,
    vlans: [],
    zones: [],
    conduits: [],
    devices: [],
    dataPaths,
    assets: dataPaths.map((p) => ({ id: p.assetId, name: p.assetName, status: 'active', live: notWatched, devices: 0, paths: 1 })),
    statusCounts: { online: 0, offline: 0, unknown: dataPaths.length },
    hosts: [],
    dataQuality: { total: 0, hints: [] },
  } as unknown as PlantSiteNetwork;
}

const t = (mode: 'pull' | 'push' | 'receive', peerKind: 'system' | 'other', peer: string) => ({
  protocol: 'mqtt',
  mode,
  peerKind,
  peer,
  port: null,
  notes: '',
});

describe('the OT network diagram', () => {
  it('what sends to the collector is a source; what it pushes to and its destinations are targets side by side', () => {
    const g = networkGraph(
      site([
        {
          collector: { kind: 'job', ref: 'bfc', host: null },
          transfers: [t('receive', 'other', 'PLC'), t('push', 'system', 'iot'), t('push', 'system', 'influx')],
          peers: [null, ref('iot', 'IoT platform'), ref('influx', 'InfluxDB')],
          destinations: [{ kind: 'system', ref: 'historian', path: '', notes: '' }],
          targets: [ref('historian', 'Historian')],
        },
      ]),
      undefined,
      words,
    );
    const edges = g.edges.map((e) => `${e.from}>${e.to}`).sort();
    expect(edges).toEqual(['col:job:bfc>host:historian', 'col:job:bfc>host:influx', 'col:job:bfc>host:iot', 'peer:plc>col:job:bfc'].sort());
    // the PLC that publishes stands where the data comes from, not the asset (the path names no device)
    expect(edges.some((e) => e.startsWith('asset:'))).toBe(false);
  });

  it('a pull from a system is a source; without pull or receive the data comes from the asset', () => {
    const g = networkGraph(
      site([
        { collector: { kind: 'job', ref: 'archive', host: null }, transfers: [t('pull', 'system', 'share')], peers: [ref('share', 'Share')] },
        { collector: { kind: 'job', ref: 'push', host: null }, transfers: [t('push', 'system', 'share')], peers: [ref('share', 'Share')] },
      ]),
      undefined,
      words,
    );
    const edges = g.edges.map((e) => `${e.from}>${e.to}`).sort();
    expect(edges).toEqual(['asset:a1>col:job:push', 'col:job:push>host:share', 'host:share>col:job:archive'].sort());
  });
});
