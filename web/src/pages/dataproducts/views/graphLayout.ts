import { compoundLayout, layeredLayout, type DataGraphColumn, type DataGraphEdge, type DataGraphNode } from '@sm/shared';

/**
 * Layouts of the data products pictures (ADR 0036 part 13), computed in the browser on the server-built graph and
 * cached (the same graph is laid out once): the pipeline in columns – upstream, inputs, the layers, outputs,
 * downstream – ordered within a column to cross few edges; the map and the lineage with the shared dagre layouts
 * (`layeredLayout`, `compoundLayout` with domains or products as areas), as the plant registry's pictures.
 */

export const NODE_W = 232;
export const NODE_H = 92;
export const STEP_W = 156;
export const STEP_H = 46;
/** Room above the pipeline's columns for their headers */
const HEAD = 44;

export const nodeSize = (n: Pick<DataGraphNode, 'kind'>): { width: number; height: number } =>
  n.kind === 'step' ? { width: STEP_W, height: STEP_H } : { width: NODE_W, height: NODE_H };

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GraphLayout {
  pos: Map<string, { x: number; y: number }>;
  /** Areas: domains, products (the pipeline's product boundary as `product`) */
  boxes: Map<string, Box>;
  /** Pipeline: where each column's header sits */
  headers: { column: DataGraphColumn; x: number; width: number }[];
  width: number;
  height: number;
}

type G = { nodes: DataGraphNode[]; edges: DataGraphEdge[] };

const cache = new Map<string, GraphLayout>();
const remember = (key: string, make: () => GraphLayout): GraphLayout => {
  const hit = cache.get(key);
  if (hit) return hit;
  const l = make();
  if (cache.size > 30) cache.delete(cache.keys().next().value!);
  cache.set(key, l);
  return l;
};
const keyOf = (kind: string, g: G) => `${kind}#${g.nodes.map((n) => `${n.id}@${n.column ?? ''}`).join('|')}#${g.edges.map((e) => e.id).join('|')}`;

/** The size of everything laid out. */
function extent(rects: Box[]): { width: number; height: number } {
  return {
    width: Math.max(NODE_W, ...rects.map((r) => r.x + r.width)) + 16,
    height: Math.max(NODE_H, ...rects.map((r) => r.y + r.height)) + 16,
  };
}

/**
 * The pipeline in columns (part 9: layers as columns). Within a column the nodes are ordered by the mean position of
 * their neighbours in the columns before and after (two sweeps each way), so few edges cross; the members sit in the
 * product's area, the neighbours outside it.
 */
export function pipelineLayout(g: G, columns: DataGraphColumn[], productId: string): GraphLayout {
  return remember(keyOf('pipeline', g), () => {
    const drawn = g.nodes.filter((n) => !n.group);
    const cols = [...new Set(drawn.map((n) => n.column ?? 0))].sort((a, b) => a - b);
    const inCol = new Map<number, DataGraphNode[]>(cols.map((c) => [c, []]));
    const rank = (n: DataGraphNode) => (n.outside ? 1 : 0) * 10 + (n.hidden ? 1 : 0);
    for (const n of drawn) inCol.get(n.column ?? 0)!.push(n);
    for (const list of inCol.values()) list.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    const preds = new Map<string, string[]>();
    const succs = new Map<string, string[]>();
    for (const e of g.edges) {
      preds.set(e.to, [...(preds.get(e.to) ?? []), e.from]);
      succs.set(e.from, [...(succs.get(e.from) ?? []), e.to]);
    }
    const index = new Map<string, number>();
    const reindex = () => {
      for (const list of inCol.values()) list.forEach((n, i) => index.set(n.id, i / Math.max(1, list.length - 1)));
    };
    reindex();
    const sweep = (order: number[], by: Map<string, string[]>) => {
      for (const c of order) {
        const list = inCol.get(c)!;
        const bary = new Map(
          list.map((n, i) => {
            const xs = (by.get(n.id) ?? []).map((id) => index.get(id)).filter((x): x is number => x !== undefined);
            return [n.id, xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : i / Math.max(1, list.length - 1)];
          }),
        );
        list.sort((a, b) => rank(a) - rank(b) || bary.get(a.id)! - bary.get(b.id)!);
        list.forEach((n, i) => index.set(n.id, i / Math.max(1, list.length - 1)));
      }
    };
    for (let i = 0; i < 2; i++) {
      sweep(cols, preds);
      sweep([...cols].reverse(), succs);
    }
    // x by column (step columns are narrower), y stacked and centred
    const gapX = 72;
    const gapY = 18;
    const colX = new Map<number, { x: number; width: number }>();
    let x = 24;
    for (const c of cols) {
      const width = Math.max(...inCol.get(c)!.map((n) => nodeSize(n).width));
      colX.set(c, { x, width });
      x += width + gapX;
    }
    const heightOf = (list: DataGraphNode[]) => list.reduce((a, n) => a + nodeSize(n).height, 0) + gapY * Math.max(0, list.length - 1);
    const tallest = Math.max(0, ...[...inCol.values()].map(heightOf));
    const pos = new Map<string, { x: number; y: number }>();
    for (const c of cols) {
      const list = inCol.get(c)!;
      const { x: cx, width } = colX.get(c)!;
      let y = HEAD + 24 + (tallest - heightOf(list)) / 2;
      for (const n of list) {
        const s = nodeSize(n);
        pos.set(n.id, { x: Math.round(cx + (width - s.width) / 2), y: Math.round(y) });
        y += s.height + gapY;
      }
    }
    // the product's area: around its members (and the steps between them)
    const boxes = new Map<string, Box>();
    const members = drawn.filter((n) => !n.outside && n.kind !== 'step');
    const first = Math.min(...members.map((n) => n.column ?? 0));
    const last = Math.max(...members.map((n) => n.column ?? 0));
    const inside = [...members, ...drawn.filter((n) => n.kind === 'step' && (n.column ?? 0) > first && (n.column ?? 0) < last)];
    if (inside.length) {
      const rs = inside.map((n) => ({ ...pos.get(n.id)!, ...nodeSize(n) }));
      const x0 = Math.min(...rs.map((r) => r.x)) - 14;
      const y0 = Math.min(...rs.map((r) => r.y)) - 30;
      boxes.set(`product:${productId}`, {
        x: x0,
        y: y0,
        width: Math.max(...rs.map((r) => r.x + r.width)) + 14 - x0,
        height: Math.max(...rs.map((r) => r.y + r.height)) + 14 - y0,
      });
    }
    const headers = columns.filter((c) => colX.has(c.index)).map((c) => ({ column: c, ...colX.get(c.index)! }));
    const rects = [...drawn.map((n) => ({ ...pos.get(n.id)!, ...nodeSize(n) })), ...boxes.values()];
    return { pos, boxes, headers, ...extent(rects) };
  });
}

/**
 * The map and the lineage: dagre left to right (the flow of data), with areas (domains and sub-domains, or products)
 * around their nodes where the graph has them.
 */
export function flowLayout(g: G): GraphLayout {
  return remember(keyOf('flow', g), () => {
    const leaves = g.nodes.filter((n) => !n.group);
    const areas = g.nodes.filter((n) => n.group);
    const opts = { direction: 'LR' as const, rankSep: 96, nodeSep: 26 };
    let pos: Map<string, { x: number; y: number }>;
    let boxes = new Map<string, Box>();
    if (!areas.length)
      pos = layeredLayout(
        leaves.map((n) => ({ id: n.id, ...nodeSize(n) })),
        g.edges,
        opts,
      );
    else
      ({ pos, boxes } = compoundLayout(
        leaves.map((n) => ({ id: n.id, ...nodeSize(n), parent: n.parent })),
        areas.map((a) => ({ id: a.id, parent: a.parent })),
        g.edges,
        { ...opts, rankSep: opts.rankSep + 24 },
      ));
    const rects = [...leaves.map((n) => ({ ...(pos.get(n.id) ?? { x: 0, y: 0 }), ...nodeSize(n) })), ...boxes.values()];
    return { pos, boxes, headers: [], ...extent(rects) };
  });
}
