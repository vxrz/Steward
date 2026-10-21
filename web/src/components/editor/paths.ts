import { STEP_META, newStepId, walkSteps, type Step, type StepType } from '@sm/shared';

/** Location of a step inside the tree: one segment per nesting level. */
export type BlockKey = 'steps' | 'then' | 'else';
export interface Seg {
  block: BlockKey;
  index: number;
}
export type Loc = Seg[];
/** A step list: parent step location (empty = root) + block name. */
export interface BlockRef {
  parent: Loc;
  block: BlockKey;
}

export const ROOT: BlockRef = { parent: [], block: 'steps' };
export const locKey = (l: Loc | null | undefined) => (l ? l.map((s) => `${s.block}.${s.index}`).join('/') : '');

type AnyStep = Step & Record<string, unknown>;

export function getStep(root: Step[], loc: Loc): Step | undefined {
  let list: Step[] | undefined = root;
  let step: Step | undefined;
  for (let i = 0; i < loc.length; i++) {
    const s = loc[i]!;
    if (i > 0) list = step ? ((step as AnyStep)[s.block] as Step[] | undefined) : undefined;
    step = list?.[s.index];
  }
  return step;
}

function listFor(root: Step[], ref: BlockRef): Step[] {
  if (ref.parent.length === 0) return root;
  const parent = getStep(root, ref.parent) as AnyStep | undefined;
  if (!parent) throw new Error('Invalid location');
  if (!Array.isArray(parent[ref.block])) parent[ref.block] = [];
  return parent[ref.block] as Step[];
}

const refOf = (loc: Loc): BlockRef => ({ parent: loc.slice(0, -1), block: loc[loc.length - 1]!.block });

function edit(root: Step[], fn: (r: Step[]) => void): Step[] {
  const copy = structuredClone(root);
  fn(copy);
  return copy;
}

export function allIds(root: Step[]): Set<string> {
  const ids = new Set<string>();
  walkSteps(root, (s) => ids.add(s.id));
  return ids;
}

export function replaceStep(root: Step[], loc: Loc, step: Step): Step[] {
  return edit(root, (r) => {
    listFor(r, refOf(loc))[loc[loc.length - 1]!.index] = structuredClone(step);
  });
}

export function removeStep(root: Step[], loc: Loc): Step[] {
  return edit(root, (r) => {
    listFor(r, refOf(loc)).splice(loc[loc.length - 1]!.index, 1);
  });
}

/** Move within the same block; returns new tree and new location. */
export function moveStep(root: Step[], loc: Loc, delta: number): [Step[], Loc] {
  const idx = loc[loc.length - 1]!.index;
  let target = idx;
  const steps = edit(root, (r) => {
    const list = listFor(r, refOf(loc));
    target = Math.max(0, Math.min(list.length - 1, idx + delta));
    const [s] = list.splice(idx, 1);
    list.splice(target, 0, s!);
  });
  return [steps, [...loc.slice(0, -1), { block: loc[loc.length - 1]!.block, index: target }]];
}

export function insertStep(root: Step[], ref: BlockRef, index: number, step: Step): [Step[], Loc] {
  let at = index;
  const steps = edit(root, (r) => {
    const list = listFor(r, ref);
    at = Math.max(0, Math.min(list.length, index));
    list.splice(at, 0, step);
  });
  return [steps, [...ref.parent, { block: ref.block, index: at }]];
}

export function createStep(type: StepType, ids: Set<string>): Step {
  const id = newStepId(type, ids);
  return { id, type, ...STEP_META[type].defaults() } as Step;
}

/** Deep copy with fresh ids for the step and all nested steps. */
export function duplicateStep(root: Step[], loc: Loc): [Step[], Loc] {
  const src = getStep(root, loc);
  if (!src) return [root, loc];
  const ids = allIds(root);
  const copy = structuredClone(src);
  const renew = (s: Step) => {
    s.id = newStepId(s.type, ids);
    ids.add(s.id);
  };
  renew(copy);
  walkSteps(
    ([] as Step[]).concat(
      ...(['steps', 'then', 'else'] as const).map((k) => ((copy as AnyStep)[k] as Step[] | undefined) ?? []),
    ),
    renew,
  );
  return insertStep(root, refOf(loc), loc[loc.length - 1]!.index + 1, copy);
}
