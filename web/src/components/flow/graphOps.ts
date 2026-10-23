import { STEP_META, autoLayout, hasInput, newStepId, type FlowNode, type NodeType, type ProcessDefinition, type Wire } from '@sm/shared';
import i18n from '../../i18n';

type Def = ProcessDefinition;

export const allIds = (def: Def): Set<string> => new Set(def.nodes.map((n) => n.id));

export const wireId = (w: Wire): string => `${w.from}|${w.port}|${w.to}`;

export function createNode(def: Def, type: NodeType, x: number, y: number): FlowNode {
  const id = newStepId(type, allIds(def));
  const base: Record<string, unknown> = { id, type, ...STEP_META[type].defaults(), x: Math.round(x), y: Math.round(y) };
  // Default texts of new nodes in the UI language (they become part of the process, like anything the user types).
  for (const key of ['text', 'title', 'message'] as const) {
    if (typeof base[key] === 'string' && base[key])
      base[key] = i18n.t(`editor:defaults.${type}.${key}` as 'editor:defaults.note.text', { defaultValue: base[key] as string });
  }
  if ((type === 'http' || type === 'browser') && def.connections[0] && !base.connection) base.connection = def.connections[0].slot;
  return base as unknown as FlowNode;
}

export function addNode(def: Def, node: FlowNode): Def {
  return { ...def, nodes: [...def.nodes, node] };
}

export function updateNode(def: Def, id: string, node: FlowNode): Def {
  return { ...def, nodes: def.nodes.map((n) => (n.id === id ? node : n)) };
}

/** Rename a node and keep its wires. */
export function renameNode(def: Def, oldId: string, newId: string): Def {
  return {
    ...def,
    nodes: def.nodes.map((n) => (n.id === oldId ? { ...n, id: newId } : n)),
    wires: def.wires.map((w) => ({ ...w, from: w.from === oldId ? newId : w.from, to: w.to === oldId ? newId : w.to })),
  };
}

export function moveNodes(def: Def, positions: Map<string, { x: number; y: number }>): Def {
  return {
    ...def,
    nodes: def.nodes.map((n) => {
      const p = positions.get(n.id);
      return p ? { ...n, x: Math.round(p.x), y: Math.round(p.y) } : n;
    }),
  };
}

/** Remove nodes (never the last start node) and their wires. */
export function removeNodes(def: Def, ids: string[]): Def {
  const startCount = def.nodes.filter((n) => n.type === 'start').length;
  const drop = new Set(ids.filter((id) => !(def.nodes.find((n) => n.id === id)?.type === 'start' && startCount <= 1)));
  return {
    ...def,
    nodes: def.nodes.filter((n) => !drop.has(n.id)),
    wires: def.wires.filter((w) => !drop.has(w.from) && !drop.has(w.to)),
  };
}

export function removeWires(def: Def, ids: string[]): Def {
  const drop = new Set(ids);
  return { ...def, wires: def.wires.filter((w) => !drop.has(wireId(w))) };
}

/** Returns an error message if the wire is not allowed. */
export function wireError(def: Def, w: Wire): string | null {
  if (w.from === w.to) return 'A node cannot be connected to itself';
  const target = def.nodes.find((n) => n.id === w.to);
  if (!target || !hasInput(target.type)) return 'This node has no input';
  if (def.wires.some((x) => wireId(x) === wireId(w))) return 'Already connected';
  return null;
}

export function addWire(def: Def, w: Wire): Def {
  return wireError(def, w) ? def : { ...def, wires: [...def.wires, w] };
}

export function duplicateNode(def: Def, id: string): [Def, string | null] {
  const n = def.nodes.find((x) => x.id === id);
  if (!n || n.type === 'start') return [def, null];
  const copy = { ...structuredClone(n), id: newStepId(n.type, allIds(def)), x: n.x + 40, y: n.y + 40 } as FlowNode;
  if (copy.name) copy.name = `${copy.name} (copy)`;
  return [{ ...def, nodes: [...def.nodes, copy] }, copy.id];
}

export function tidy(def: Def): Def {
  return { ...def, nodes: autoLayout(def.nodes, def.wires) };
}
