import { newStepId, type FlowNode, type ProcessDefinition, type Wire } from '@sm/shared';
import { allIds } from './graphOps';

type Def = ProcessDefinition;

const KEY = 'sm.flow.clipboard';

export interface FlowClipboard {
  kind: 'sm-flow-nodes';
  v: 1;
  nodes: FlowNode[];
  wires: Wire[];
}

/** In-memory fallback when localStorage is blocked. */
let memory: FlowClipboard | null = null;

/** Selected nodes (never the start node) and the wires between them. */
export function copyNodes(def: Def, ids: string[]): FlowClipboard | null {
  const set = new Set(ids);
  const nodes = def.nodes.filter((n) => set.has(n.id) && n.type !== 'start');
  if (!nodes.length) return null;
  const keep = new Set(nodes.map((n) => n.id));
  const wires = def.wires.filter((w) => keep.has(w.from) && keep.has(w.to));
  return { kind: 'sm-flow-nodes', v: 1, nodes: structuredClone(nodes), wires: structuredClone(wires) };
}

export function writeClipboard(clip: FlowClipboard): void {
  memory = clip;
  const text = JSON.stringify(clip);
  try {
    localStorage.setItem(KEY, text);
  } catch {
    /* storage blocked – memory copy still works in this tab */
  }
  try {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  } catch {
    /* clipboard API not available */
  }
}

export function readClipboard(): FlowClipboard | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const c = JSON.parse(raw) as FlowClipboard;
      if (c?.kind === 'sm-flow-nodes' && Array.isArray(c.nodes) && Array.isArray(c.wires)) return c;
    }
  } catch {
    /* fall back to memory */
  }
  return memory;
}

/** Insert copied nodes with new ids, keeping the wires between them; offset so they do not cover existing nodes. */
export function pasteNodes(def: Def, clip: FlowClipboard): [Def, string[]] {
  const nodes = clip.nodes.filter((n) => n.type !== 'start');
  if (!nodes.length) return [def, []];
  const existing = allIds(def);
  const map = new Map<string, string>();
  for (const n of nodes) {
    const id = newStepId(n.type, existing);
    existing.add(id);
    map.set(n.id, id);
  }
  const taken = (x: number, y: number) => def.nodes.some((m) => Math.abs(m.x - x) < 15 && Math.abs(m.y - y) < 15);
  let off = 40;
  while (off < 2000 && nodes.some((n) => taken(n.x + off, n.y + off))) off += 40;
  const pasted = nodes.map((n) => ({ ...structuredClone(n), id: map.get(n.id)!, x: Math.round(n.x + off), y: Math.round(n.y + off) }) as FlowNode);
  const wires = clip.wires.filter((w) => map.has(w.from) && map.has(w.to)).map((w) => ({ ...w, from: map.get(w.from)!, to: map.get(w.to)! }));
  return [{ ...def, nodes: [...def.nodes, ...pasted], wires: [...def.wires, ...wires] }, pasted.map((n) => n.id)];
}
