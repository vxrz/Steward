import type {
  LiveState,
  PlantDataPathView,
  PlantFlowEdge,
  PlantFlowGraph,
  PlantFlowNode,
  PlantFlowPath,
  PlantHostPlacement,
  PlantItemRef,
  PlantLive,
  PlantLiveStatus,
  PlantSiteNetwork,
  ZoneLevelOf,
} from '@sm/shared';
import { SOURCE_MODES } from '@sm/shared';

/**
 * The OT network of a site (#220) as a graph (#230, view 5): IEC 62443-3-2 zones as areas, the IEEE 802.1Q VLANs in
 * them as areas, the assets on their VLANs (their devices on hover), the conduits between the zones, and the data
 * paths – from where the data comes (what the collector pulls from or receives from), over the collector, to the parties
 * it pushes to and its destinations. A way from
 * one zone into another runs through the conduit between them; one without a documented conduit says so.
 *
 * Status only from what #220 links: an asset's live status comes from its checks and those of its devices – a part
 * nothing watches is drawn neutral (documentation only), unknown stays "no data". Hosts, collectors, datasets and other
 * parties have no live status here.
 */

export interface NetworkWords {
  vid: (vid: number) => string;
  criticality: (c: string) => string;
  sl: (level: number | null) => string;
  direction: (d: string, a: string, b: string) => string;
  devices: (n: number) => string;
  paths: (n: number) => string;
  deviceLine: (d: { address: string; vlan: string; state: string; live: string }) => string;
  collectorKind: (k: string) => string;
  mode: (m: string) => string;
  on: (host: string) => string;
  /** A zone's level: its own, or derived for the diagram */
  level: (l: ZoneLevelOf) => string;
  /** info labels */
  label: Record<'devices' | 'subnets' | 'owner' | 'vlans' | 'protocols' | 'controls' | 'assessment' | 'managedBy' | 'segment' | 'restricted' | 'level', string>;
  yes: string;
  hidden: string;
  noVlan: string;
}

const norm = (s: string) => s.trim().toLowerCase();

/** #220's live status as the views' live status (null: nothing watches it – documentation only). */
export function liveOf(l: PlantLiveStatus): PlantLive | null {
  if (!l.watched) return null;
  // the check that decides: the first offline one, else the first that does not say online, else the first
  const c = l.checks.find((x) => x.state === 'offline') ?? l.checks.find((x) => x.state !== 'online') ?? l.checks[0];
  return {
    source: c?.kind ?? 'monitor',
    // offline as planned (a monitor that is off, ADR 0021) is grey, not red
    state: l.state === 'online' ? 'ok' : l.state === 'offline' && c?.reason !== 'off' ? 'fail' : 'unknown',
    status: c?.reason ?? 'unknown',
    label: c?.visible ? c.label : '',
    path: c?.path ?? null,
    at: c?.at ?? null,
  };
}

export function networkGraph(
  n: PlantSiteNetwork,
  placement: PlantHostPlacement | undefined,
  w: NetworkWords,
  levels?: Map<string, ZoneLevelOf>,
): PlantFlowGraph {
  const nodes = new Map<string, PlantFlowNode>();
  const edges = new Map<string, PlantFlowEdge & { via: Set<string>; labels?: string[] }>();
  const paths: PlantFlowPath[] = [];
  const site = encodeURIComponent(n.site.id);
  const node = (x: Omit<PlantFlowNode, 'checks' | 'live' | 'inactive'> & Partial<Pick<PlantFlowNode, 'checks' | 'live' | 'inactive'>>) => {
    if (!nodes.has(x.id)) nodes.set(x.id, { checks: [], live: null, inactive: false, ...x });
    return x.id;
  };

  // ---------- zones, VLANs, conduits ----------
  const vlanById = new Map(n.vlans.map((v) => [v.id, v]));
  const zoneOfVlan = new Map<string, string>();
  for (const z of n.zones) for (const v of z.vlans) if (!zoneOfVlan.has(v) && vlanById.has(v)) zoneOfVlan.set(v, z.id);
  const hostVlan = new Map((placement?.hosts ?? []).map((h) => [h.id, h.vlans[0]]));
  // an asset is drawn on the VLAN of its first device that has one
  const assetVlan = new Map<string, string>();
  for (const d of n.devices) if (d.vlan && vlanById.has(d.vlan) && !assetVlan.has(d.assetId)) assetVlan.set(d.assetId, d.vlan);
  const used = new Set<string>([...assetVlan.values(), ...[...hostVlan.values()].filter((x): x is string => !!x)]);

  for (const z of n.zones)
    node({
      id: `zone:${z.id}`,
      kind: 'zone',
      label: z.name,
      detail: z.description,
      path: `/plant/sites/${site}/network/zones`,
      group: true,
      tags: [z.criticality ? w.criticality(z.criticality) : '', w.sl(z.slTarget)].filter(Boolean),
      info: [
        ...(levels?.has(z.id) ? [{ label: w.label.level, value: w.level(levels.get(z.id)!) }] : []),
        { label: w.label.vlans, value: z.vlans.map((v) => vlanById.get(v)?.name ?? v).join(', ') || '–' },
        ...(z.owner ? [{ label: w.label.owner, value: z.owner }] : []),
        ...(z.riskAssessment ? [{ label: w.label.assessment, value: [z.riskAssessment, z.assessedAt].filter(Boolean).join(' · ') }] : []),
        { label: w.label.devices, value: String(z.deviceCount) },
      ],
    });
  for (const v of n.vlans) {
    const zone = zoneOfVlan.get(v.id);
    // a VLAN outside every zone is drawn only when something is on it
    if (!zone && !used.has(v.id)) continue;
    const subnets = v.subnets.map((s) => s.cidr);
    node({
      id: `vlan:${v.id}`,
      kind: 'vlan',
      label: v.name,
      detail: subnets.join(', '),
      path: `/plant/sites/${site}/network/vlans`,
      group: used.has(v.id),
      small: !used.has(v.id),
      parent: zone ? `zone:${zone}` : undefined,
      tags: v.vid !== null ? [w.vid(v.vid)] : [],
      info: [
        { label: w.label.subnets, value: subnets.join(', ') || '–' },
        ...(v.restricted ? [{ label: w.label.restricted, value: w.yes }] : []),
        ...(v.managedBy ? [{ label: w.label.managedBy, value: v.managedBy }] : []),
        ...(v.segment ? [{ label: w.label.segment, value: v.segment.visible ? v.segment.label : w.hidden }] : []),
        { label: w.label.devices, value: String(v.deviceCount) },
      ],
    });
  }
  const zoneName = (id: string) => n.zones.find((z) => z.id === id)?.name ?? id;
  const conduitBetween = new Map<string, string>();
  for (const c of n.conduits) {
    const [a, b] = c.zones;
    if (!nodes.has(`zone:${a}`) || !nodes.has(`zone:${b}`)) continue;
    const id = node({
      id: `cdt:${c.id}`,
      kind: 'conduit',
      label: c.name,
      detail: c.protocols.join(', '),
      path: `/plant/sites/${site}/network/zones`,
      tags: [w.direction(c.direction, zoneName(a), zoneName(b))],
      info: [
        { label: w.label.protocols, value: c.protocols.join(', ') || '–' },
        { label: w.label.controls, value: c.controls.join(', ') || '–' },
      ],
    });
    const [from, to] = c.direction === 'b_to_a' ? [b, a] : [a, b];
    for (const [x, y] of [
      [`zone:${from}`, id],
      [id, `zone:${to}`],
    ] as const)
      edges.set(`${x}>${y}`, {
        id: `${x}>${y}`,
        from: x,
        to: y,
        points: 0,
        assets: 0,
        files: 0,
        inactive: false,
        problem: false,
        result: false,
        conduit: true,
        both: c.direction === 'both',
        via: new Set(),
      });
    conduitBetween.set(`${a}|${b}`, id);
    conduitBetween.set(`${b}|${a}`, id);
  }

  // ---------- assets and their devices ----------
  const live = new Map(n.assets.map((a) => [a.id, a.live]));
  const drawn = new Set([...n.devices.map((d) => d.assetId), ...n.dataPaths.map((p) => p.assetId)]);
  for (const a of n.assets) {
    if (!drawn.has(a.id)) continue;
    const vlan = assetVlan.get(a.id);
    const mine = n.devices.filter((d) => d.assetId === a.id);
    node({
      id: `asset:${a.id}`,
      kind: 'asset',
      label: a.name,
      detail: [w.devices(a.devices), w.paths(a.paths)].join(' · '),
      path: `/plant/assets/${encodeURIComponent(a.id)}`,
      parent: vlan && nodes.has(`vlan:${vlan}`) ? `vlan:${vlan}` : undefined,
      live: liveOf(a.live),
      info: mine.map((d) => ({
        label: d.hostname || d.id,
        value: w.deviceLine({
          address: d.address,
          vlan: d.vlan ? (vlanById.get(d.vlan)?.vid !== null && vlanById.get(d.vlan) ? w.vid(vlanById.get(d.vlan)!.vid!) : d.vlan) : w.noVlan,
          state: d.state,
          live: d.live.watched ? d.live.state : 'notWatched',
        }),
      })),
    });
  }

  // ---------- data paths ----------
  const zoneOf = (id: string): string | undefined => {
    let p = nodes.get(id)?.parent;
    for (let i = 0; p && i < 4; i++) {
      if (p.startsWith('zone:')) return p.slice(5);
      p = nodes.get(p)?.parent;
    }
    return undefined;
  };
  const vlanParent = (vlan: string | undefined) => (vlan && nodes.has(`vlan:${vlan}`) && nodes.get(`vlan:${vlan}`)!.group ? `vlan:${vlan}` : undefined);
  const host = (ref: PlantItemRef | null, id: string) =>
    node({
      id: `host:${id}`,
      kind: 'host',
      label: ref?.visible ? ref.label || id : '',
      hidden: !ref?.visible,
      detail: '',
      path: ref?.path ?? null,
      parent: vlanParent(hostVlan.get(id)),
    });
  const peer = (text: string) => node({ id: `peer:${norm(text)}`, kind: 'peer', label: text || '–', detail: '', path: null, small: true });
  const worst = (a: LiveState | null | undefined, b: LiveState | null | undefined): LiveState | null => {
    if (a === 'offline' || b === 'offline') return 'offline';
    if (a === 'unknown' || b === 'unknown') return 'unknown';
    return a ?? b ?? null;
  };
  const addEdge = (from: string, to: string, via: string, label: string, state: LiveState | null) => {
    const id = `${from}>${to}`;
    let e = edges.get(id);
    if (!e) {
      e = { id, from, to, points: 0, assets: 0, files: 0, inactive: false, problem: false, result: false, via: new Set(), live: state };
      edges.set(id, e);
    } else e.live = worst(e.live, state);
    e.via.add(via);
    // the first two different transfers name the way ("opc-ua:4840 · pull, mqtt:8883 · push"), however many paths take it
    const labels = (e.labels ??= []);
    if (label && !labels.includes(label) && labels.length < 2) {
      labels.push(label);
      e.label = labels.join(', ');
    }
    return id;
  };
  /** The collector of a data path as a part (one per collector, whichever data paths name it) */
  const collectorNode = (dp: PlantDataPathView): string | null => {
    const c = dp.collector;
    if (!c) return null;
    const hostRef = dp.collectorHost;
    return node({
      id: `col:${c.kind}:${norm(c.ref)}`,
      kind: 'collector',
      label: dp.collectorRef?.visible === false ? '' : dp.collectorRef?.label || c.ref,
      hidden: dp.collectorRef?.visible === false,
      detail: [w.collectorKind(c.kind), hostRef ? w.on(hostRef.visible ? hostRef.label : w.hidden) : ''].filter(Boolean).join(' · '),
      path: dp.collectorRef?.path ?? null,
      parent: c.host ? vlanParent(hostVlan.get(c.host)) : undefined,
    });
  };
  /**
   * A Steward application or platform a data path pushes to, reads from or delivers to (0.20): one part with the
   * collector of the same item, so a chain through it stays one picture
   */
  const stewardItem = (kind: 'application' | 'platform', item: PlantItemRef | null, id: string) =>
    node({
      id: `col:${kind}:${norm(id)}`,
      kind,
      label: item?.visible ? item.label || id : '',
      hidden: !item?.visible,
      detail: '',
      path: item?.path ?? null,
    });
  // collectors first: an application that collects for one path and receives from another is drawn as its collector
  for (const dp of n.dataPaths as PlantDataPathView[]) if (nodes.has(`asset:${dp.assetId}`)) collectorNode(dp);
  for (const dp of n.dataPaths as PlantDataPathView[]) {
    const pid = `${dp.assetId}/${dp.id}`;
    const asset = `asset:${dp.assetId}`;
    if (!nodes.has(asset)) continue;
    const l = live.get(dp.assetId);
    const state: LiveState | null = l?.watched ? l.state : null;
    // offline as planned (monitors that are off, ADR 0021): the path says so in grey, its edges are not drawn as failing
    const offPlanned = state === 'offline' && !!l && l.checks.filter((c) => c.state === 'offline').every((c) => c.reason === 'off');
    const edgeState: LiveState | null = offPlanned ? 'unknown' : state;
    const p: PlantFlowPath = {
      id: pid,
      kind: 'path',
      label: dp.subject,
      detail: dp.assetName,
      delivers: true,
      reason: null,
      live: state,
      ...(offPlanned ? { offPlanned: true } : {}),
      nodes: [asset],
      edges: [],
    };
    paths.push(p);
    const touch = (id: string) => {
      if (!p.nodes.includes(id)) p.nodes.push(id);
    };
    // a way between two zones runs through their conduit (or says that none is documented)
    const link = (from: string, to: string, label: string) => {
      if (from === to) return;
      touch(from);
      const za = zoneOf(from);
      const zb = zoneOf(to);
      const cdt = za && zb && za !== zb ? conduitBetween.get(`${za}|${zb}`) : undefined;
      if (cdt) {
        p.edges.push(addEdge(from, cdt, pid, label, edgeState), addEdge(cdt, to, pid, '', edgeState));
        touch(cdt);
      } else {
        const id = addEdge(from, to, pid, label, edgeState);
        if (za && zb && za !== zb) edges.get(id)!.noConduit = true;
        p.edges.push(id);
      }
      touch(to);
    };
    const party = (kind: PlantDataPathView['transfers'][number]['peerKind'], ref: string, item: PlantItemRef | null) =>
      kind === 'device'
        ? asset
        : kind === 'system'
          ? host(item, ref)
          : kind === 'application' || kind === 'platform'
            ? stewardItem(kind, item, ref)
            : peer(ref);
    // where the data comes from (seen from the collector): what it pulls from and what sends to it – a device is its
    // asset –, else the asset itself
    const ends = dp.transfers.map((t, i) => ({ t, id: party(t.peerKind, t.peer, dp.peers[i] ?? null), label: transferLabel(t, w) }));
    const fetched = ends.filter((x) => SOURCE_MODES.includes(x.t.mode));
    const sources = fetched.map(({ id, label }) => ({ id, label }));
    if (!sources.some((s) => s.id === asset) && (!fetched.length || dp.devices.length)) sources.unshift({ id: asset, label: '' });
    let stage = sources;
    if (dp.collector) {
      const id = collectorNode(dp)!;
      for (const s of sources) link(s.id, id, s.label);
      stage = [{ id, label: '' }];
    }
    // the parties the collector pushes to are targets like the destinations: each is reached from the collector (two
    // targets are never drawn one after the other)
    const pushes = ends.filter((x) => x.t.mode === 'push');
    for (const s of stage) for (const x of pushes) link(s.id, x.id, x.label);
    const dests = dp.destinations.map((d, i) => {
      const item = dp.targets[i] ?? null;
      if (d.kind === 'system') return host(item, d.ref);
      if (d.kind === 'application' || d.kind === 'platform') return stewardItem(d.kind, item, d.ref);
      if (d.kind === 'dataset') return node({ id: `ds:${d.ref}`, kind: 'dataset', label: d.ref, detail: '', path: item?.path ?? null });
      return peer(d.ref);
    });
    for (const s of stage) for (const d of dests) link(s.id, d, '');
    if (!dp.collector && !pushes.length && !dests.length) touch(asset);
  }
  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()].map(({ via, labels: _labels, ...e }) => ({ ...e, paths: via.size })),
    paths,
    grouped: false,
    empty: nodes.size ? null : 'no_assets',
  };
}

function transferLabel(t: PlantDataPathView['transfers'][number], w: NetworkWords): string {
  return [t.protocol, t.port ? `:${t.port}` : ''].join('') + (t.mode ? ` · ${w.mode(t.mode)}` : '');
}
