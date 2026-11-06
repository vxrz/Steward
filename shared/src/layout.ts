import dagre from '@dagrejs/dagre';

/**
 * A layered (Sugiyama) layout of a directed graph with nodes of given sizes – dagre, as for the process canvas. Used by
 * the plant registry's graph views (#230); the caller caches the result (the layout of the same graph is the same).
 * Returns the top-left corner of every node.
 */
export function layeredLayout(
  nodes: { id: string; width: number; height: number }[],
  edges: { from: string; to: string }[],
  opts: { direction?: 'LR' | 'TB'; rankSep?: number; nodeSep?: number } = {},
): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: opts.direction ?? 'LR', ranksep: opts.rankSep ?? 80, nodesep: opts.nodeSep ?? 24, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: n.width, height: n.height });
  edges.forEach((e, i) => {
    if (g.hasNode(e.from) && g.hasNode(e.to)) g.setEdge(e.from, e.to, {}, `e${i}`);
  });
  dagre.layout(g);
  const out = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    const p = g.node(n.id) as { x: number; y: number } | undefined;
    out.set(n.id, p ? { x: Math.round(p.x - n.width / 2), y: Math.round(p.y - n.height / 2) } : { x: 0, y: 0 });
  }
  return out;
}
