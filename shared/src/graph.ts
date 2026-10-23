import dagre from '@dagrejs/dagre';
import type { FlowNode, Step, Wire } from './process.js';

export const NODE_WIDTH = 210;
export const NODE_HEIGHT = 64;

interface PortRef {
  from: string;
  port: string;
}

/**
 * Convert the sequential `steps` format into nodes + wires.
 *  - for-each: body hangs off the "each" output, the flow continues from "done"
 *  - if: both branches continue into the next node
 *  - approve tasks: continue on "approved" (and on "rejected" when onReject: continue)
 *  - group: flattened (a group condition becomes an if node)
 */
export function stepsToGraph(steps: Step[]): { nodes: FlowNode[]; wires: Wire[] } {
  const nodes: FlowNode[] = [];
  const wires: Wire[] = [];
  const used = new Set<string>();
  const uniq = (id: string) => {
    let n = id;
    let i = 2;
    while (used.has(n)) n = `${id}_${i++}`;
    used.add(n);
    return n;
  };
  // reserve step ids first so they stay unchanged
  const reserve = (list: Step[]) =>
    list.forEach((s) => {
      used.add(s.id);
      if (s.type === 'forEach' || s.type === 'group') reserve(s.steps ?? []);
      if (s.type === 'if') {
        reserve(s.then ?? []);
        reserve(s.else ?? []);
      }
    });
  reserve(steps);
  const startId = uniq('start');
  nodes.push({ id: startId, type: 'start', name: 'Start', x: 0, y: 0 });

  const connect = (prev: PortRef[], to: string) => prev.forEach((p) => wires.push({ from: p.from, port: p.port, to }));

  const guard = (id: string, when: string, prev: PortRef[], inner: (p: PortRef[]) => PortRef[]): PortRef[] => {
    const gid = uniq(`${id}_when`);
    nodes.push({ id: gid, type: 'if', name: `Only if: ${when.slice(0, 40)}`, condition: when, x: 0, y: 0 });
    connect(prev, gid);
    return [...inner([{ from: gid, port: 'true' }]), { from: gid, port: 'false' }];
  };

  const seq = (list: Step[], prev: PortRef[]): PortRef[] => {
    for (const step of list) prev = one(step, prev);
    return prev;
  };

  const one = (step: Step, prev: PortRef[]): PortRef[] => {
    switch (step.type) {
      case 'group': {
        if (step.when) return guard(step.id, step.when, prev, (p) => seq(step.steps ?? [], p));
        return seq(step.steps ?? [], prev);
      }
      case 'if': {
        const { then, else: els, when, ...cfg } = step;
        const build = (p: PortRef[]): PortRef[] => {
          nodes.push({ ...cfg, x: 0, y: 0 } as FlowNode);
          connect(p, step.id);
          const t = seq(then ?? [], [{ from: step.id, port: 'true' }]);
          const e = seq(els ?? [], [{ from: step.id, port: 'false' }]);
          return [...t, ...e];
        };
        return when ? guard(step.id, when, prev, build) : build(prev);
      }
      case 'forEach': {
        const { steps: body, ...cfg } = step;
        nodes.push({ ...cfg, x: 0, y: 0 } as FlowNode);
        connect(prev, step.id);
        seq(body ?? [], [{ from: step.id, port: 'each' }]);
        return [{ from: step.id, port: 'done' }];
      }
      case 'userTask': {
        const { onReject, ...cfg } = step;
        nodes.push({ ...cfg, x: 0, y: 0 } as FlowNode);
        connect(prev, step.id);
        if (step.mode !== 'approve') return [{ from: step.id, port: 'out' }];
        return onReject === 'continue'
          ? [
              { from: step.id, port: 'approved' },
              { from: step.id, port: 'rejected' },
            ]
          : [{ from: step.id, port: 'approved' }];
      }
      case 'fail': {
        const { when, ...cfg } = step;
        const build = (p: PortRef[]): PortRef[] => {
          nodes.push({ ...cfg, x: 0, y: 0 } as FlowNode);
          connect(p, step.id);
          return [];
        };
        return when ? guard(step.id, when, prev, build) : build(prev);
      }
      default:
        nodes.push({ ...step, x: 0, y: 0 } as FlowNode);
        connect(prev, step.id);
        return [{ from: step.id, port: 'out' }];
    }
  };

  seq(steps, [{ from: startId, port: 'out' }]);
  return { nodes: autoLayout(nodes, wires), wires };
}

/** Left-to-right layered layout (used for converted flows and "Tidy up"). */
export function autoLayout(nodes: FlowNode[], wires: Wire[]): FlowNode[] {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: 'LR', ranksep: 70, nodesep: 28, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  const laid = nodes.filter((n) => n.type !== 'note');
  for (const n of laid) g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  wires.forEach((w, i) => {
    if (g.hasNode(w.from) && g.hasNode(w.to)) g.setEdge(w.from, w.to, {}, `${w.port}-${i}`);
  });
  dagre.layout(g);
  const pos = new Map<string, { x: number; y: number }>();
  for (const n of laid) {
    const p = g.node(n.id) as { x: number; y: number } | undefined;
    if (p) pos.set(n.id, { x: Math.round(p.x - NODE_WIDTH / 2), y: Math.round(p.y - NODE_HEIGHT / 2) });
  }
  wrapRows(pos);
  return nodes.map((n) => {
    const p = n.type === 'note' ? undefined : pos.get(n.id);
    return p ? { ...n, x: p.x, y: p.y } : n;
  });
}

/** Long left-to-right chains are wrapped into rows (like a hand-drawn flow) so they stay readable. */
const RANKS_PER_ROW = 5;
function wrapRows(pos: Map<string, { x: number; y: number }>): void {
  const xs = [...new Set([...pos.values()].map((p) => p.x))].sort((a, b) => a - b);
  if (xs.length <= RANKS_PER_ROW + 1) return;
  const rankOf = new Map(xs.map((x, i) => [x, i]));
  const rows = new Map<number, { x: number; y: number }[]>();
  for (const p of pos.values()) {
    const row = Math.floor(rankOf.get(p.x)! / RANKS_PER_ROW);
    rows.set(row, [...(rows.get(row) ?? []), p]);
  }
  let offset = 0;
  for (const row of [...rows.keys()].sort((a, b) => a - b)) {
    const list = rows.get(row)!;
    const minY = Math.min(...list.map((p) => p.y));
    const maxY = Math.max(...list.map((p) => p.y));
    for (const p of list) {
      const col = rankOf.get(p.x)! % RANKS_PER_ROW;
      p.x = 20 + col * (NODE_WIDTH + 70);
      p.y = offset + (p.y - minY);
    }
    offset += maxY - minY + NODE_HEIGHT + 90;
  }
}

/** Outgoing wires of a node port, ordered top-to-bottom (then left-to-right) by target position. */
export function outgoing(nodes: Map<string, FlowNode>, wires: Wire[], from: string, port: string): FlowNode[] {
  return wires
    .filter((w) => w.from === from && w.port === port)
    .map((w) => nodes.get(w.to))
    .filter((n): n is FlowNode => !!n)
    .sort((a, b) => a.y - b.y || a.x - b.x);
}
