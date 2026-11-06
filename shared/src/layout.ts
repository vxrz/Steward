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

/**
 * A layered layout with areas (dagre's compound graphs): leaves have a size and may name their area; areas may sit in
 * other areas and get the box around their members (with room for a label). Edges that name an area are laid out as
 * if they named its first member (dagre lays out edges between leaves only). Returns the top-left corner of every leaf
 * and the box of every area.
 */
export function compoundLayout(
  leaves: { id: string; width: number; height: number; parent?: string }[],
  areas: { id: string; parent?: string }[],
  edges: { from: string; to: string }[],
  opts: { direction?: 'LR' | 'TB'; rankSep?: number; nodeSep?: number } = {},
): { pos: Map<string, { x: number; y: number }>; boxes: Map<string, { x: number; y: number; width: number; height: number }> } {
  const g = new dagre.graphlib.Graph({ compound: true, multigraph: true });
  g.setGraph({ rankdir: opts.direction ?? 'LR', ranksep: opts.rankSep ?? 80, nodesep: opts.nodeSep ?? 24, marginx: 24, marginy: 36 });
  g.setDefaultEdgeLabel(() => ({}));
  const areaIds = new Set(areas.map((a) => a.id));
  // an area without members is laid out as a leaf of its own
  const hasMember = new Set([...leaves.map((l) => l.parent), ...areas.map((a) => a.parent)].filter((x): x is string => !!x));
  const empty = areas.filter((a) => !hasMember.has(a.id));
  for (const a of areas) if (hasMember.has(a.id)) g.setNode(a.id, {});
  for (const n of [...leaves, ...empty.map((a) => ({ ...a, width: 232, height: 72 }))]) g.setNode(n.id, { width: n.width, height: n.height });
  for (const n of [...leaves, ...areas]) if (n.parent && areaIds.has(n.parent) && hasMember.has(n.parent)) g.setParent(n.id, n.parent);
  // the first leaf inside an area stands for it in the edges
  const firstLeaf = new Map<string, string>();
  const leafOf = (id: string, depth = 0): string | undefined => {
    if (!areaIds.has(id) || !hasMember.has(id)) return id;
    if (firstLeaf.has(id)) return firstLeaf.get(id);
    if (depth > 8) return undefined;
    const child = leaves.find((l) => l.parent === id)?.id ?? areas.find((a) => a.parent === id)?.id;
    const leaf = child ? leafOf(child, depth + 1) : undefined;
    if (leaf) firstLeaf.set(id, leaf);
    return leaf;
  };
  edges.forEach((e, i) => {
    const a = leafOf(e.from);
    const b = leafOf(e.to);
    if (a && b && a !== b && g.hasNode(a) && g.hasNode(b)) g.setEdge(a, b, {}, `e${i}`);
  });
  dagre.layout(g);
  const pos = new Map<string, { x: number; y: number }>();
  const boxes = new Map<string, { x: number; y: number; width: number; height: number }>();
  for (const n of leaves) {
    const p = g.node(n.id) as { x: number; y: number } | undefined;
    pos.set(n.id, p ? { x: Math.round(p.x - n.width / 2), y: Math.round(p.y - n.height / 2) } : { x: 0, y: 0 });
  }
  for (const a of areas) {
    const p = g.node(a.id) as { x: number; y: number; width: number; height: number } | undefined;
    if (!p) continue;
    const width = p.width || 232;
    const height = p.height || 72;
    boxes.set(a.id, { x: Math.round(p.x - width / 2), y: Math.round(p.y - height / 2), width: Math.round(width), height: Math.round(height) });
  }
  return { pos, boxes };
}
