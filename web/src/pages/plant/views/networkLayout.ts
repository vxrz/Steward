import { ZONE_LEVELS, type PlantFlowGraph, type PlantFlowNode, type ZoneLevel } from '@sm/shared';

/**
 * The layout of the OT network diagram (#230): the zones in horizontal bands by their level in the Purdue model –
 * field and cells at the bottom, then supervisory, operations, the DMZ, the enterprise network and external parties at
 * the top – so data paths run upwards. A zone's VLANs are areas inside it, the parts on a VLAN small chips in a grid.
 * A system or platform a zone lists (0.20) is a chip in the zone itself, below its VLANs. A conduit is a gate on the
 * boundary between its two zones. What is outside every zone stands in a column on the
 * right, near what it is connected to. Edges get their geometry here too: the picture does not move its nodes.
 *
 * Deterministic and cheap (no graph layout library): the same graph gives the same picture.
 */

export const CHIP_W = 176;
export const CHIP_H = 52;
/** The widest a gate is (its name decides – room for the larger type of the overview; at least 110 px) */
export const GATE_W = 260;
export const GATE_H = 30;
const GX = 12;
const GY = 10;
const VPAD = 10;
const VHEAD = 28;
const ZPAD = 14;
const ZHEAD = 26;
const ZGAP = 56;
const ZGAP_GATE = GATE_W + 40;
const BAND_GAP = 80;
/** The column of the band labels on the left */
export const BAND_LABEL_W = 132;
const OUT_GAP = 110;
const OUT_PAD = 14;
const OUT_HEAD = 30;
/** Between the columns outside the zones: room for a way and its arrow */
const OUT_COL_GAP = 56;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EdgeGeom {
  /** SVG path */
  d: string;
  /** Where its label sits */
  mx: number;
  my: number;
}

export interface NetLayout {
  /** Every node drawn: zones and VLANs (areas), chips, gates */
  rects: Map<string, Rect>;
  /** The bands, top to bottom */
  bands: { level: ZoneLevel; y: number; h: number }[];
  /** The frame around the parts outside every zone (null: none) */
  outside: Rect | null;
  edges: Map<string, EdgeGeom>;
  width: number;
  height: number;
}

const KIND_ORDER: Record<string, number> = { asset: 0, host: 1, collector: 2, application: 3, platform: 4, dataset: 5, peer: 6 };
const byKindThenLabel = (a: PlantFlowNode, b: PlantFlowNode) =>
  (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id);

/** Columns of a grid of n chips: about twice as wide as high, at most 6. */
const colsFor = (n: number, wide = 2) => (n <= 3 ? Math.max(1, n) : Math.min(n, 10, Math.ceil(Math.sqrt(n * wide))));
/** About how wide a text of 12 px is */
const textW = (s: string) => s.length * 6.8;
/** A gate is as wide as its name */
export const gateWidth = (label: string) => Math.round(Math.min(GATE_W, Math.max(110, textW(label) * 1.45 + 44)));

const cx = (r: Rect) => r.x + r.w / 2;
const cy = (r: Rect) => r.y + r.h / 2;

/**
 * @param levels the level of every zone (by zone id, without the `zone:` prefix)
 */
/**
 * Lays the graph out for a frame of the given aspect (width / height): a few densities are tried – chips in wider or
 * narrower grids, zones with their VLANs in longer or shorter rows – and the one that shows the picture largest wins.
 */
export function networkLayout(g: Pick<PlantFlowGraph, 'nodes' | 'edges'>, levels: Map<string, ZoneLevel>, aspect = 1.8): NetLayout {
  let best: Placed | null = null;
  let bestFit = -1;
  for (const wide of [1.2, 2, 3.5, 6])
    for (const maxRow of [900, 1300, 2000]) {
      const p = place(g, levels, wide, maxRow);
      const fit = Math.min(aspect / p.width, 1 / p.height);
      if (fit > bestFit * 1.02) {
        best = p;
        bestFit = fit;
      }
    }
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  return { ...best!, edges: edgeGeometry(g, best!.rects, byId) };
}

type Placed = Omit<NetLayout, 'edges'>;

function place(g: Pick<PlantFlowGraph, 'nodes' | 'edges'>, levels: Map<string, ZoneLevel>, wide: number, maxRowWidth: number): Placed {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const kids = new Map<string, PlantFlowNode[]>();
  for (const n of g.nodes) if (n.parent && byId.has(n.parent)) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n]);
  const rects = new Map<string, Rect>();
  // sizes first (positions relative to the box), then the boxes are placed and everything is moved with them
  const rel = new Map<string, { x: number; y: number }>();

  // ---------- VLANs: a grid of chips ----------
  const vlanSize = new Map<string, { w: number; h: number }>();
  for (const v of g.nodes.filter((n) => n.kind === 'vlan')) {
    const items = (kids.get(v.id) ?? []).filter((x) => !x.group).sort(byKindThenLabel);
    if (!items.length) {
      // an empty VLAN: as wide as its name
      vlanSize.set(v.id, { w: Math.round(Math.max(CHIP_W + 2 * VPAD, textW(`${v.label} ${v.tags?.join(' ') ?? ''}`) + 84)), h: VHEAD + 10 });
      continue;
    }
    const cols = colsFor(items.length, wide);
    items.forEach((x, i) => rel.set(x.id, { x: VPAD + (i % cols) * (CHIP_W + GX), y: VHEAD + Math.floor(i / cols) * (CHIP_H + GY) }));
    const rows = Math.ceil(items.length / cols);
    vlanSize.set(v.id, { w: 2 * VPAD + cols * CHIP_W + (cols - 1) * GX, h: VHEAD + rows * CHIP_H + (rows - 1) * GY + VPAD });
  }

  // ---------- units of a band: zones (with their VLANs), and VLANs outside every zone ----------
  interface Unit {
    id: string;
    level: number;
    w: number;
    h: number;
    x: number;
    y: number;
    /** members with their place in the unit */
    members: { id: string; x: number; y: number }[];
    /** parts placed in the zone itself, not on a VLAN of it (0.20: a system or platform the zone lists) */
    chips: { id: string; x: number; y: number }[];
    index: number;
  }
  const units: Unit[] = [];
  const zones = g.nodes.filter((n) => n.kind === 'zone');
  const rank = (l: ZoneLevel | undefined) => ZONE_LEVELS.indexOf(l ?? 'operations');
  for (const z of zones) {
    const vlans = (kids.get(z.id) ?? []).filter((x) => x.kind === 'vlan');
    // shelves of VLANs: a row as wide as about the widest VLAN or 1,100 px
    const maxRow = Math.max(maxRowWidth, ...vlans.map((v) => vlanSize.get(v.id)!.w));
    const members: Unit['members'] = [];
    let x = ZPAD;
    let y = ZHEAD;
    let rowH = 0;
    let w = 0;
    for (const v of vlans) {
      const s = vlanSize.get(v.id)!;
      if (x > ZPAD && x + s.w > maxRow) {
        x = ZPAD;
        y += rowH + GY + 4;
        rowH = 0;
      }
      members.push({ id: v.id, x, y });
      x += s.w + GX + 4;
      rowH = Math.max(rowH, s.h);
      w = Math.max(w, x - GX - 4 + ZPAD);
    }
    // parts in the zone itself: a grid below its VLANs
    const inZone = (kids.get(z.id) ?? []).filter((x) => !x.group && x.kind !== 'vlan').sort(byKindThenLabel);
    const chips: Unit['chips'] = [];
    let bottom = vlans.length ? y + rowH : 0;
    if (inZone.length) {
      const cols = colsFor(inZone.length, wide);
      const top = vlans.length ? bottom + GY + 4 : ZHEAD;
      inZone.forEach((c, i) => chips.push({ id: c.id, x: ZPAD + (i % cols) * (CHIP_W + GX), y: top + Math.floor(i / cols) * (CHIP_H + GY) }));
      const rows = Math.ceil(inZone.length / cols);
      bottom = top + rows * CHIP_H + (rows - 1) * GY;
      w = Math.max(w, 2 * ZPAD + cols * CHIP_W + (cols - 1) * GX);
    }
    units.push({
      id: z.id,
      level: rank(levels.get(z.id.slice(5))),
      w: Math.max(w, 240),
      h: bottom ? bottom + ZPAD : ZHEAD + 34,
      x: 0,
      y: 0,
      members,
      chips,
      index: units.length,
    });
  }
  for (const v of g.nodes.filter((n) => n.kind === 'vlan' && !(n.parent && byId.has(n.parent)))) {
    const s = vlanSize.get(v.id)!;
    units.push({ id: v.id, level: rank('control'), w: s.w, h: s.h, x: 0, y: 0, members: [], chips: [], index: units.length });
  }
  const unitOf = new Map(units.map((u) => [u.id, u]));

  // the zones a conduit connects (from its two pipes)
  const gates = g.nodes.filter((n) => n.kind === 'conduit');
  const gateZones = new Map<string, [string, string]>();
  for (const c of gates) {
    const a = g.edges.find((e) => e.to === c.id && e.conduit)?.from;
    const b = g.edges.find((e) => e.from === c.id && e.conduit)?.to;
    if (a && b && unitOf.has(a) && unitOf.has(b)) gateZones.set(c.id, [a, b]);
  }
  const partners = new Map<string, Set<string>>();
  for (const [a, b] of gateZones.values()) {
    partners.set(a, (partners.get(a) ?? new Set()).add(b));
    partners.set(b, (partners.get(b) ?? new Set()).add(a));
  }

  // ---------- bands: x bottom-up (a zone above the zones it connects to), y top-down ----------
  const levelsUsed = [...new Set(units.map((u) => u.level))].sort((a, b) => a - b);
  const bandUnits = new Map(levelsUsed.map((l) => [l, units.filter((u) => u.level === l)]));
  const placed = new Set<string>();
  for (const l of levelsUsed) {
    const list = bandUnits.get(l)!;
    const want = new Map<string, number>();
    for (const u of list) {
      const ps = [...(partners.get(u.id) ?? [])].filter((p) => placed.has(p)).map((p) => unitOf.get(p)!);
      if (ps.length) want.set(u.id, ps.reduce((s, p) => s + p.x + p.w / 2, 0) / ps.length);
    }
    list.sort((a, b) => (want.get(a.id) ?? Infinity) - (want.get(b.id) ?? Infinity) || a.index - b.index);
    let cursor = BAND_LABEL_W;
    list.forEach((u, i) => {
      const prev = list[i - 1];
      const gap = prev ? (partners.get(prev.id)?.has(u.id) ? ZGAP_GATE : ZGAP) : 0;
      const w = want.get(u.id);
      u.x = Math.max(cursor + gap, w !== undefined ? w - u.w / 2 : 0);
      cursor = u.x + u.w;
      placed.add(u.id);
    });
    bandUnits.set(l, list);
  }
  const bands: NetLayout['bands'] = [];
  let y = 36;
  for (const l of [...levelsUsed].reverse()) {
    const list = bandUnits.get(l)!;
    const h = Math.max(...list.map((u) => u.h));
    for (const u of list) u.y = y;
    bands.push({ level: ZONE_LEVELS[l]!, y, h });
    y += h + BAND_GAP;
  }
  const bandOf = (u: Unit) => bands.findIndex((b) => b.level === ZONE_LEVELS[u.level]);

  for (const u of units) {
    rects.set(u.id, { x: u.x, y: u.y, w: u.w, h: u.h });
    for (const m of u.members) {
      const s = vlanSize.get(m.id)!;
      rects.set(m.id, { x: u.x + m.x, y: u.y + m.y, w: s.w, h: s.h });
    }
    for (const c of u.chips) rects.set(c.id, { x: u.x + c.x, y: u.y + c.y, w: CHIP_W, h: CHIP_H });
  }
  for (const v of g.nodes.filter((n) => n.kind === 'vlan')) {
    const r = rects.get(v.id);
    if (!r) continue;
    for (const x of kids.get(v.id) ?? []) {
      const p = rel.get(x.id);
      if (p) rects.set(x.id, { x: r.x + p.x, y: r.y + p.y, w: CHIP_W, h: CHIP_H });
    }
  }

  // ---------- gates on the boundaries ----------
  const gateRects: { id: string; r: Rect }[] = [];
  for (const [id, [a, b]] of gateZones) {
    const ua = unitOf.get(a)!;
    const ub = unitOf.get(b)!;
    const ra = rects.get(a)!;
    const rb = rects.get(b)!;
    const gw = gateWidth(byId.get(id)?.label ?? '');
    let gx: number;
    let gy: number;
    if (ua.level !== ub.level) {
      const [lo, hi] = ua.level < ub.level ? [ra, rb] : [rb, ra];
      const above = bands[bandOf(ua.level < ub.level ? ua : ub) - 1];
      gy = above ? (above.y + above.h + lo.y) / 2 : lo.y - BAND_GAP / 2;
      const left = Math.max(lo.x, hi.x);
      const right = Math.min(lo.x + lo.w, hi.x + hi.w);
      gx = right - left > gw ? (left + right) / 2 : Math.min(Math.max(cx(hi), lo.x + gw / 2 + 8), lo.x + lo.w - gw / 2 - 8);
    } else {
      const list = bandUnits.get(ua.level)!;
      const [l, r] = ra.x < rb.x ? [ra, rb] : [rb, ra];
      if (Math.abs(list.indexOf(ua) - list.indexOf(ub)) === 1) {
        gx = (l.x + l.w + r.x) / 2;
        gy = l.y + Math.min(l.h, r.h) / 2;
      } else {
        gx = (cx(l) + cx(r)) / 2;
        gy = l.y - BAND_GAP / 2;
      }
    }
    gateRects.push({ id, r: { x: gx - gw / 2, y: gy - GATE_H / 2, w: gw, h: GATE_H } });
  }
  // gates on the same boundary must not overlap
  gateRects.sort((p, q) => p.r.y - q.r.y || p.r.x - q.r.x);
  for (let i = 1; i < gateRects.length; i++) {
    const p = gateRects[i - 1]!.r;
    const q = gateRects[i]!.r;
    if (Math.abs(p.y - q.y) < GATE_H && q.x < p.x + p.w + 10) q.x = p.x + p.w + 10;
  }
  for (const { id, r } of gateRects) rects.set(id, r);
  // a conduit whose zones are not drawn: beside them, in the outside column

  // ---------- outside every zone: a column on the right, near what it is connected to ----------
  const loose = g.nodes.filter((n) => !n.group && !rects.has(n.id) && n.kind !== 'vlan').sort(byKindThenLabel);
  let outside: Rect | null = null;
  if (loose.length) {
    const right = Math.max(BAND_LABEL_W, ...[...rects.values()].map((r) => r.x + r.w));
    const near = new Map<string, string[]>();
    for (const e of g.edges) {
      near.set(e.from, [...(near.get(e.from) ?? []), e.to]);
      near.set(e.to, [...(near.get(e.to) ?? []), e.from]);
    }
    if (!units.length) {
      // nothing in zones: a grid
      const cols = colsFor(loose.length, wide);
      loose.forEach((n, i) =>
        rects.set(n.id, {
          x: BAND_LABEL_W + OUT_PAD + (i % cols) * (CHIP_W + GX),
          y: 36 + OUT_HEAD + Math.floor(i / cols) * (CHIP_H + GY),
          w: CHIP_W,
          h: CHIP_H,
        }),
      );
    } else {
      const x = right + OUT_GAP;
      const want = new Map<string, number>();
      // twice: the second round places what is only connected to other loose parts
      for (let round = 0; round < 2; round++)
        for (const n of loose) {
          if (want.has(n.id)) continue;
          const ys = (near.get(n.id) ?? []).map((o) => (rects.get(o) ? cy(rects.get(o)!) : want.get(o))).filter((v): v is number => v !== undefined);
          if (ys.length || round === 1) want.set(n.id, ys.length ? ys.reduce((s, v) => s + v, 0) / ys.length : y);
        }
      const order = [...loose].sort((a, b) => want.get(a.id)! - want.get(b.id)!);
      // up to three columns: a part goes where it can stay near its height, else where it is pushed down least
      const cursors = [36 + OUT_HEAD, 36 + OUT_HEAD, 36 + OUT_HEAD];
      for (const n of order) {
        const top = (c: number) => Math.max(cursors[c]!, want.get(n.id)! - CHIP_H / 2);
        let c = cursors.findIndex((_, i) => top(i) - (want.get(n.id)! - CHIP_H / 2) < CHIP_H / 2);
        if (c < 0) c = [0, 1, 2].reduce((b, i) => (top(i) < top(b) ? i : b), 0);
        const y0 = top(c);
        rects.set(n.id, { x: x + OUT_PAD + c * (CHIP_W + OUT_COL_GAP), y: y0, w: CHIP_W, h: CHIP_H });
        cursors[c] = y0 + CHIP_H + GY;
      }
    }
    const rs = loose.map((n) => rects.get(n.id)!);
    const top = Math.min(...rs.map((r) => r.y)) - OUT_HEAD;
    const left = Math.min(...rs.map((r) => r.x)) - OUT_PAD;
    outside = { x: left, y: top, w: Math.max(...rs.map((r) => r.x + r.w)) + OUT_PAD - left, h: Math.max(...rs.map((r) => r.y + r.h)) + OUT_PAD - top };
  }

  const all = [...rects.values(), ...(outside ? [outside] : [])];
  const width = Math.max(BAND_LABEL_W + CHIP_W, ...all.map((r) => r.x + r.w)) + 24;
  const height = Math.max(CHIP_H, ...all.map((r) => r.y + r.h)) + 24;
  return { rects, bands, outside, width, height };
}

type Side = 'top' | 'bottom' | 'left' | 'right';

/** The ways: from the side of a part that faces the other end, spread over the side, as gentle curves. */
function edgeGeometry(g: Pick<PlantFlowGraph, 'edges'>, rects: Map<string, Rect>, byId: Map<string, PlantFlowNode>): Map<string, EdgeGeom> {
  const out = new Map<string, EdgeGeom>();
  const ends: { id: string; s: Side; t: Side; a: Rect; b: Rect }[] = [];
  const slots = new Map<string, { edge: string; end: 's' | 't'; other: number }[]>();
  const slot = (node: string, side: Side, edge: string, end: 's' | 't', other: number) => {
    const k = `${node}|${side}`;
    slots.set(k, [...(slots.get(k) ?? []), { edge, end, other }]);
  };
  for (const e of g.edges) {
    const a = rects.get(e.from);
    const b = rects.get(e.to);
    if (!a || !b) continue;
    if (e.conduit) {
      // a pipe: from the gate straight to the border of its zone
      const gateIsFrom = byId.get(e.from)?.kind === 'conduit';
      const gate = gateIsFrom ? a : b;
      const zone = gateIsFrom ? b : a;
      const p = pipe(gate, zone);
      const [x1, y1, x2, y2] = gateIsFrom ? p : [p[2], p[3], p[0], p[1]];
      out.set(e.id, { d: `M${x1} ${y1} L${x2} ${y2}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 });
      continue;
    }
    const dy = cy(b) - cy(a);
    const dx = cx(b) - cx(a);
    const vertical = Math.abs(dy) >= (a.h + b.h) / 2 + 16;
    const s: Side = vertical ? (dy < 0 ? 'top' : 'bottom') : dx < 0 ? 'left' : 'right';
    const t: Side = vertical ? (dy < 0 ? 'bottom' : 'top') : dx < 0 ? 'right' : 'left';
    ends.push({ id: e.id, s, t, a, b });
    slot(e.from, s, e.id, 's', vertical ? cx(b) : cy(b));
    slot(e.to, t, e.id, 't', vertical ? cx(a) : cy(a));
  }
  // spread the ends on a side in the order of where they go, so they do not cross right at the part
  const at = new Map<string, number>();
  for (const [k, list] of slots) {
    const [node, side] = k.split('|') as [string, Side];
    const r = rects.get(node)!;
    const len = side === 'top' || side === 'bottom' ? r.w : r.h;
    const start = side === 'top' || side === 'bottom' ? r.x : r.y;
    list.sort((p, q) => p.other - q.other);
    list.forEach((x, i) => at.set(`${x.edge}|${x.end}`, start + len * 0.1 + (len * 0.8 * (i + 1)) / (list.length + 1)));
  }
  const point = (r: Rect, side: Side, pos: number): [number, number] =>
    side === 'top' ? [pos, r.y] : side === 'bottom' ? [pos, r.y + r.h] : side === 'left' ? [r.x, pos] : [r.x + r.w, pos];
  const normal: Record<Side, [number, number]> = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] };
  for (const x of ends) {
    const [x0, y0] = point(x.a, x.s, at.get(`${x.id}|s`)!);
    const [x3, y3] = point(x.b, x.t, at.get(`${x.id}|t`)!);
    const span = x.s === 'top' || x.s === 'bottom' ? Math.abs(y3 - y0) : Math.abs(x3 - x0);
    const c = Math.min(160, Math.max(24, span * 0.5));
    const [n1x, n1y] = normal[x.s];
    const [n2x, n2y] = normal[x.t];
    const x1 = x0 + n1x * c;
    const y1 = y0 + n1y * c;
    const x2 = x3 + n2x * c;
    const y2 = y3 + n2y * c;
    const r = (v: number) => Math.round(v * 10) / 10;
    out.set(x.id, {
      d: `M${r(x0)} ${r(y0)} C${r(x1)} ${r(y1)} ${r(x2)} ${r(y2)} ${r(x3)} ${r(y3)}`,
      // the curve's middle (t = 0.5)
      mx: r((x0 + 3 * x1 + 3 * x2 + x3) / 8),
      my: r((y0 + 3 * y1 + 3 * y2 + y3) / 8),
    });
  }
  return out;
}

/** A pipe from a gate to the border of a zone: [gate x, gate y, zone x, zone y]. */
function pipe(gate: Rect, zone: Rect): [number, number, number, number] {
  const gx = cx(gate);
  const gy = cy(gate);
  if (gate.y + gate.h <= zone.y) return [gx, gate.y + gate.h, clamp(gx, zone.x + 12, zone.x + zone.w - 12), zone.y];
  if (gate.y >= zone.y + zone.h) return [gx, gate.y, clamp(gx, zone.x + 12, zone.x + zone.w - 12), zone.y + zone.h];
  if (gate.x >= zone.x + zone.w) return [gate.x, gy, zone.x + zone.w, clamp(gy, zone.y + 12, zone.y + zone.h - 12)];
  return [gate.x + gate.w, gy, zone.x, clamp(gy, zone.y + 12, zone.y + zone.h - 12)];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
