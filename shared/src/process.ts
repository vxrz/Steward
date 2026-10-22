import { z } from 'zod';
import { stepsToGraph } from './graph.js';

/**
 * Process definition model.
 *
 * A process is a graph of nodes connected by wires (like Node-RED). Every
 * node has named output ports (e.g. an "if" node has "true" and "false").
 * For hand-written YAML the compact sequential `steps` format (with nested
 * loops/branches) is accepted too and converted into a graph.
 *
 * Fields marked "expression" take a JSONata expression (optionally wrapped in
 * {{ }}). "Template" fields are strings/objects where {{ expression }} parts
 * are replaced at run time. Expression scope: inputs, vars, const, run, conn.
 */

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Node types available on the canvas. */
export const NODE_TYPES = [
  'start',
  'http',
  'set',
  'forEach',
  'if',
  'userTask',
  'check',
  'log',
  'report',
  'browser',
  'publish',
  'subprocess',
  'wait',
  'fail',
  'note',
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** Step types of the sequential (YAML) format. */
export const STEP_TYPES = ['http', 'set', 'forEach', 'if', 'group', 'userTask', 'check', 'log', 'report', 'browser', 'publish', 'subprocess', 'wait', 'fail'] as const;
export type StepType = (typeof STEP_TYPES)[number];

const identifier = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Use letters, digits and _ only (must not start with a digit)');

const columnSchema = z.object({
  label: z.string(),
  value: z.string(), // expression evaluated against the item
});
export type Column = z.infer<typeof columnSchema>;

export const paginateSchema = z.object({
  mode: z.enum(['none', 'scim', 'page', 'offset', 'nextLink']),
  /** Expression for the item array inside one page response body. */
  itemsPath: z.string().optional(),
  pageSize: z.number().int().min(1).max(10000).optional(),
  pageParam: z.string().optional(),
  sizeParam: z.string().optional(),
  /** 'page' mode: expression for total pages (default page.totalPages). */
  totalPagesPath: z.string().optional(),
  /** 'page' mode: first page number (default 0). */
  firstPage: z.number().int().optional(),
  /** 'nextLink' mode: expression for the next URL (absolute or relative). */
  nextPath: z.string().optional(),
  maxPages: z.number().int().min(1).optional(),
});
export type Paginate = z.infer<typeof paginateSchema>;

export const browserActionSchema = z.object({
  action: z.enum(['goto', 'click', 'fill', 'press', 'select', 'check', 'waitFor', 'expectText', 'extract', 'screenshot', 'wait', 'evaluate']),
  selector: z.string().optional(),
  value: z.string().optional(),
  as: identifier.optional(),
  attribute: z.string().optional(),
  all: z.boolean().optional(),
  name: z.string().optional(),
  fullPage: z.boolean().optional(),
  timeoutMs: z.number().int().min(0).optional(),
  state: z.enum(['attached', 'detached', 'visible', 'hidden']).optional(),
});
export type BrowserAction = z.infer<typeof browserActionSchema>;

// ---------------------------------------------------------------------------
// Shared configuration per type
// ---------------------------------------------------------------------------

interface Base {
  id: string;
  name?: string;
  description?: string;
  /** Expression; the node is skipped (and passes through) when false. */
  when?: string;
  onError?: 'fail' | 'continue';
  retry?: { attempts: number; delayMs?: number };
  /** Store the result in vars.<saveAs>. */
  saveAs?: string;
}

export interface HttpConfig {
  type: 'http';
  connection: string;
  method: HttpMethod;
  path: string;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
  bodyType?: 'json' | 'form' | 'text';
  expectStatus?: number[];
  paginate?: Paginate;
  /** OpenAPI operationId this call was created from (informational). */
  operationId?: string;
  /** Override write detection (non-GET/HEAD = write) used for dry runs. */
  mutating?: boolean;
}
export interface SetConfig {
  type: 'set';
  values: Record<string, unknown>;
}
export interface ForEachConfig {
  type: 'forEach';
  items: string;
  as: string;
  delayMs?: number;
  maxItems?: number;
  /**
   * Items processed in parallel (default 1 = one after another). With more
   * than 1, variables set inside the loop body are local to each item.
   */
  concurrency?: number;
}
export interface IfConfig {
  type: 'if';
  condition: string;
}
export interface UserTaskConfig {
  type: 'userTask';
  mode: 'select' | 'approve';
  title: string;
  instructions?: string;
  items?: string;
  itemKey?: string;
  columns?: Column[];
  /** Per-item expression: true = checkbox preselected. */
  preselect?: string;
  /** Who may decide: user:<name>, team:<name>, role:<role>. Empty = everyone allowed to run or approve the process. */
  assignees?: string[];
  /** Four-eyes principle: the person who started the run may not decide. */
  fourEyes?: boolean;
}
export interface CheckConfig {
  type: 'check';
  condition: string;
  severity?: 'error' | 'warning' | 'info';
  message?: string;
  failRun?: boolean;
}
export interface LogConfig {
  type: 'log';
  level?: 'info' | 'warn' | 'error';
  message: string;
  data?: string;
}
export interface ReportConfig {
  type: 'report';
  title: string;
  text?: string;
  rows?: string;
  columns?: Column[];
}
export interface BrowserConfig {
  type: 'browser';
  connection?: string;
  actions: BrowserAction[];
  mutating?: boolean;
}
/**
 * Publish a data snapshot (and metric values) for dashboards. Each run replaces
 * the dataset's rows; metrics are appended to a history for trends.
 */
export interface PublishConfig {
  type: 'publish';
  /** Dataset key, e.g. ih.users or iem.devices */
  dataset: string;
  title?: string;
  /** Expression → list of items (the rows) */
  rows?: string;
  /** Optional projection: label → expression per item (keeps snapshots small) */
  columns?: Column[];
  /** Expression per item → stable row key */
  key?: string;
  /** Expression per item → good | warning | serious | critical | unknown (ok/error/fail are accepted too) */
  status?: string;
  /** Expression per item → short reason shown next to the status */
  statusText?: string;
  /** Metric name → numeric expression; appended to the dataset's history */
  metrics?: Record<string, string>;
  /** Data counts as stale when older than this (dashboards show it) */
  staleAfterMinutes?: number;
  /** Safety limit (default 5000 rows) */
  maxRows?: number;
}
/**
 * Run another process as a step (sub-flow). The child run is a normal run
 * (own protocol, linked to the parent); its `outputs` become this node's result.
 */
export interface SubprocessConfig {
  type: 'subprocess';
  /** Id of the process to run */
  process: string;
  /** Pin a version (default: current version) */
  version?: number;
  /** Child input name → template evaluated in the parent */
  inputs?: Record<string, unknown>;
  /** Child connection slot → parent connection slot (default: same slot names) */
  connections?: Record<string, string>;
}
export interface WaitConfig {
  type: 'wait';
  seconds: number;
}
export interface FailConfig {
  type: 'fail';
  message: string;
}
export interface StartConfig {
  type: 'start';
}
export interface NoteConfig {
  type: 'note';
  text: string;
}

const baseFields = {
  id: identifier,
  name: z.string().optional(),
  description: z.string().optional(),
  when: z.string().optional(),
  onError: z.enum(['fail', 'continue']).optional(),
  retry: z.object({ attempts: z.number().int().min(1).max(10), delayMs: z.number().int().min(0).optional() }).optional(),
  saveAs: identifier.optional(),
};

const shapes = {
  http: {
    type: z.literal('http'),
    connection: z.string().min(1),
    method: z.enum(HTTP_METHODS),
    path: z.string().min(1),
    query: z.record(z.unknown()).optional(),
    headers: z.record(z.string()).optional(),
    body: z.unknown().optional(),
    bodyType: z.enum(['json', 'form', 'text']).optional(),
    expectStatus: z.array(z.number().int()).optional(),
    paginate: paginateSchema.optional(),
    operationId: z.string().optional(),
    mutating: z.boolean().optional(),
  },
  set: { type: z.literal('set'), values: z.record(z.unknown()) },
  forEach: {
    type: z.literal('forEach'),
    items: z.string().min(1),
    as: identifier,
    delayMs: z.number().int().min(0).optional(),
    maxItems: z.number().int().min(1).optional(),
    concurrency: z.number().int().min(1).max(20).optional(),
  },
  if: { type: z.literal('if'), condition: z.string().min(1) },
  userTask: {
    type: z.literal('userTask'),
    mode: z.enum(['select', 'approve']),
    title: z.string().min(1),
    instructions: z.string().optional(),
    items: z.string().optional(),
    itemKey: z.string().optional(),
    columns: z.array(columnSchema).optional(),
    preselect: z.string().optional(),
    assignees: z.array(z.string()).optional(),
    fourEyes: z.boolean().optional(),
  },
  check: {
    type: z.literal('check'),
    condition: z.string().min(1),
    severity: z.enum(['error', 'warning', 'info']).optional(),
    message: z.string().optional(),
    failRun: z.boolean().optional(),
  },
  log: { type: z.literal('log'), level: z.enum(['info', 'warn', 'error']).optional(), message: z.string(), data: z.string().optional() },
  report: {
    type: z.literal('report'),
    title: z.string().min(1),
    text: z.string().optional(),
    rows: z.string().optional(),
    columns: z.array(columnSchema).optional(),
  },
  browser: { type: z.literal('browser'), connection: z.string().optional(), actions: z.array(browserActionSchema), mutating: z.boolean().optional() },
  publish: {
    type: z.literal('publish'),
    dataset: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i, 'Dataset key: letters, digits, . _ - (e.g. ih.users)'),
    title: z.string().optional(),
    rows: z.string().optional(),
    columns: z.array(columnSchema).optional(),
    key: z.string().optional(),
    status: z.string().optional(),
    statusText: z.string().optional(),
    metrics: z.record(z.string()).optional(),
    staleAfterMinutes: z.number().int().min(1).optional(),
    maxRows: z.number().int().min(1).max(50000).optional(),
  },
  subprocess: {
    type: z.literal('subprocess'),
    process: z.string().min(1),
    version: z.number().int().min(1).optional(),
    inputs: z.record(z.unknown()).optional(),
    connections: z.record(z.string()).optional(),
  },
  wait: { type: z.literal('wait'), seconds: z.number().min(0).max(3600) },
  fail: { type: z.literal('fail'), message: z.string() },
  start: { type: z.literal('start') },
  note: { type: z.literal('note'), text: z.string() },
};

// ---------------------------------------------------------------------------
// Sequential format (YAML authoring, templates)
// ---------------------------------------------------------------------------

export type HttpStep = Base & HttpConfig;
export type SetStep = Base & SetConfig;
export type ForEachStep = Base & ForEachConfig & { steps: Step[] };
export type IfStep = Base & IfConfig & { then: Step[]; else?: Step[] };
export type GroupStep = Base & { type: 'group'; steps: Step[] };
export type UserTaskStep = Base & UserTaskConfig & { onReject?: 'fail' | 'continue' };
export type CheckStep = Base & CheckConfig;
export type LogStep = Base & LogConfig;
export type ReportStep = Base & ReportConfig;
export type BrowserStep = Base & BrowserConfig;
export type PublishStep = Base & PublishConfig;
export type SubprocessStep = Base & SubprocessConfig;
export type WaitStep = Base & WaitConfig;
export type FailStep = Base & FailConfig;
export type Step =
  | HttpStep
  | SetStep
  | ForEachStep
  | IfStep
  | GroupStep
  | UserTaskStep
  | CheckStep
  | LogStep
  | ReportStep
  | BrowserStep
  | PublishStep
  | SubprocessStep
  | WaitStep
  | FailStep;

export const stepSchema: z.ZodType<Step> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ ...baseFields, ...shapes.http }),
    z.object({ ...baseFields, ...shapes.set }),
    z.object({ ...baseFields, ...shapes.forEach, steps: z.array(stepSchema) }),
    z.object({ ...baseFields, ...shapes.if, then: z.array(stepSchema), else: z.array(stepSchema).optional() }),
    z.object({ ...baseFields, type: z.literal('group'), steps: z.array(stepSchema) }),
    z.object({ ...baseFields, ...shapes.userTask, onReject: z.enum(['fail', 'continue']).optional() }),
    z.object({ ...baseFields, ...shapes.check }),
    z.object({ ...baseFields, ...shapes.log }),
    z.object({ ...baseFields, ...shapes.report }),
    z.object({ ...baseFields, ...shapes.browser }),
    z.object({ ...baseFields, ...shapes.publish }),
    z.object({ ...baseFields, ...shapes.subprocess }),
    z.object({ ...baseFields, ...shapes.wait }),
    z.object({ ...baseFields, ...shapes.fail }),
  ]),
) as z.ZodType<Step>;

// ---------------------------------------------------------------------------
// Graph format (canonical)
// ---------------------------------------------------------------------------

type Pos = { x: number; y: number };
export type NodeConfig =
  | HttpConfig
  | SetConfig
  | ForEachConfig
  | IfConfig
  | UserTaskConfig
  | CheckConfig
  | LogConfig
  | ReportConfig
  | BrowserConfig
  | PublishConfig
  | SubprocessConfig
  | WaitConfig
  | FailConfig
  | StartConfig
  | NoteConfig;
export type FlowNode = Base & Pos & NodeConfig;
export type NodeOf<T extends NodeType> = Extract<FlowNode, { type: T }>;

const pos = { x: z.number(), y: z.number() };
export const nodeSchema = z.discriminatedUnion('type', [
  z.object({ ...baseFields, ...pos, ...shapes.start }),
  z.object({ ...baseFields, ...pos, ...shapes.http }),
  z.object({ ...baseFields, ...pos, ...shapes.set }),
  z.object({ ...baseFields, ...pos, ...shapes.forEach }),
  z.object({ ...baseFields, ...pos, ...shapes.if }),
  z.object({ ...baseFields, ...pos, ...shapes.userTask }),
  z.object({ ...baseFields, ...pos, ...shapes.check }),
  z.object({ ...baseFields, ...pos, ...shapes.log }),
  z.object({ ...baseFields, ...pos, ...shapes.report }),
  z.object({ ...baseFields, ...pos, ...shapes.browser }),
  z.object({ ...baseFields, ...pos, ...shapes.publish }),
  z.object({ ...baseFields, ...pos, ...shapes.subprocess }),
  z.object({ ...baseFields, ...pos, ...shapes.wait }),
  z.object({ ...baseFields, ...pos, ...shapes.fail }),
  z.object({ ...baseFields, ...pos, ...shapes.note }),
]) as unknown as z.ZodType<FlowNode>;

export const wireSchema = z.object({
  from: z.string(),
  port: z.string().default('out'),
  to: z.string(),
});
export type Wire = z.infer<typeof wireSchema>;

export interface PortDef {
  id: string;
  label: string;
}

/** Output ports of a node. A port without wires ends that path. */
export function nodePorts(n: Pick<FlowNode, 'type'> & { mode?: string }): PortDef[] {
  switch (n.type) {
    case 'if':
      return [
        { id: 'true', label: 'true' },
        { id: 'false', label: 'false' },
      ];
    case 'forEach':
      return [
        { id: 'each', label: 'each item' },
        { id: 'done', label: 'done' },
      ];
    case 'userTask':
      return n.mode === 'approve'
        ? [
            { id: 'approved', label: 'approved' },
            { id: 'rejected', label: 'rejected' },
          ]
        : [{ id: 'out', label: '' }];
    case 'http':
    case 'browser':
    case 'subprocess':
      return [
        { id: 'out', label: '' },
        { id: 'error', label: 'error' },
      ];
    case 'fail':
    case 'note':
      return [];
    default:
      return [{ id: 'out', label: '' }];
  }
}

export function hasInput(type: NodeType): boolean {
  return type !== 'start' && type !== 'note';
}

export const INPUT_TYPES = ['string', 'number', 'boolean', 'select', 'list', 'table', 'json'] as const;
export type InputType = (typeof INPUT_TYPES)[number];

export const inputDefSchema = z.object({
  name: identifier,
  label: z.string().optional(),
  type: z.enum(INPUT_TYPES),
  description: z.string().optional(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  options: z.array(z.string()).optional(),
  columns: z.array(z.string()).optional(),
});
export type InputDef = z.infer<typeof inputDefSchema>;

export const connectionSlotSchema = z.object({
  slot: identifier,
  /** Platform kind this slot expects (e.g. insights-hub). Empty = any. */
  kind: z.string().optional(),
  description: z.string().optional(),
});
export type ConnectionSlot = z.infer<typeof connectionSlotSchema>;

const definitionBase = {
  name: z.string().min(1),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  connections: z.array(connectionSlotSchema).default([]),
  inputs: z.array(inputDefSchema).default([]),
  constants: z.record(z.unknown()).optional(),
  /** Values returned to a parent process (name → expression evaluated when the run ends) */
  outputs: z.record(z.string()).optional(),
};

export const processDefinitionSchema = z.object({
  ...definitionBase,
  nodes: z.array(nodeSchema),
  wires: z.array(wireSchema).default([]),
});
export type ProcessDefinition = z.infer<typeof processDefinitionSchema>;

/** Accepted input: graph (nodes + wires) or sequential steps. */
const processInputSchema = z.object({
  ...definitionBase,
  nodes: z.array(z.unknown()).optional(),
  wires: z.array(z.unknown()).optional(),
  steps: z.array(stepSchema).optional(),
});

export interface ValidationIssue {
  path: string;
  /** English text (API responses, CLI) */
  message: string;
  /** Stable id of the rule (e.g. "duplicateNodeId"); the web UI translates code + params */
  code?: string;
  params?: Record<string, string | number>;
  /** Node the issue belongs to (graph format). */
  nodeId?: string;
  severity?: 'error' | 'warning';
}

/** Walk sequential steps (depth first) with their nesting path. */
export function walkSteps(steps: Step[], fn: (step: Step, path: string) => void, prefix = 'steps'): void {
  steps.forEach((s, i) => {
    const p = `${prefix}[${i}]`;
    fn(s, p);
    for (const [key, children] of childBlocks(s)) walkSteps(children, fn, `${p}.${key}`);
  });
}

export function childBlocks(step: Step): [string, Step[]][] {
  switch (step.type) {
    case 'forEach':
    case 'group':
      return [['steps', step.steps ?? []]];
    case 'if':
      return [
        ['then', step.then ?? []],
        ['else', step.else ?? []],
      ];
    default:
      return [];
  }
}

/**
 * Parse, convert (steps → graph) and validate a definition.
 * Errors make `ok` false; warnings are informational.
 */
export function validateProcess(raw: unknown): {
  ok: boolean;
  issues: ValidationIssue[];
  warnings: ValidationIssue[];
  definition?: ProcessDefinition;
} {
  const input = processInputSchema.safeParse(raw);
  if (!input.success) {
    return { ok: false, warnings: [], issues: input.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
  }
  let candidate: unknown = input.data;
  if (!input.data.nodes && input.data.steps) {
    const { steps, ...rest } = input.data;
    candidate = { ...rest, ...stepsToGraph(steps) };
  } else if (!input.data.nodes) {
    const { steps: _s, ...rest } = input.data;
    candidate = { ...rest, ...stepsToGraph([]) };
  } else {
    const { steps: _s, ...rest } = input.data;
    candidate = rest;
  }
  const parsed = processDefinitionSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      warnings: [],
      issues: parsed.error.issues.map((i) => {
        const idx = i.path[0] === 'nodes' ? Number(i.path[1]) : NaN;
        const node = Number.isFinite(idx) ? (candidate as { nodes: { id?: string }[] }).nodes?.[idx] : undefined;
        return { path: i.path.join('.'), message: i.message, nodeId: node?.id };
      }),
    };
  }
  const d = parsed.data;
  const { issues, warnings } = checkGraph(d);
  return { ok: issues.length === 0, issues, warnings, definition: d };
}

function checkGraph(d: ProcessDefinition): { issues: ValidationIssue[]; warnings: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const byId = new Map<string, FlowNode>();
  const slots = new Set(d.connections.map((c) => c.slot));
  d.nodes.forEach((n, i) => {
    if (byId.has(n.id)) issues.push({ path: `nodes[${i}]`, nodeId: n.id, code: 'duplicateNodeId', params: { id: n.id }, message: `Duplicate node id "${n.id}"` });
    byId.set(n.id, n);
    if ((n.type === 'http' || (n.type === 'browser' && n.connection)) && !slots.has(n.connection!)) {
      issues.push({ path: `nodes[${i}]`, nodeId: n.id, code: 'unknownConnection', params: { slot: n.connection ?? '' }, message: `Unknown connection "${n.connection}". Declare it under Connections.` });
    }
    if (n.type === 'userTask' && n.mode === 'select' && !n.items) {
      issues.push({ path: `nodes[${i}]`, nodeId: n.id, code: 'selectNeedsItems', message: 'Select tasks need an "items" expression' });
    }
    if (n.type === 'subprocess') {
      for (const [childSlot, parentSlot] of Object.entries(n.connections ?? {})) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(childSlot)) issues.push({ path: `nodes[${i}].connections`, nodeId: n.id, code: 'invalidSlotName', params: { slot: childSlot }, message: `Invalid connection slot name "${childSlot}"` });
        if (!slots.has(parentSlot)) {
          issues.push({
            path: `nodes[${i}].connections.${childSlot}`,
            nodeId: n.id,
            code: 'unknownSubprocessConnection',
            params: { slot: parentSlot, childSlot },
            message: `Unknown connection "${parentSlot}" for sub-process slot "${childSlot}". Declare it under Connections.`,
          });
        }
      }
      for (const k of Object.keys(n.inputs ?? {})) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) issues.push({ path: `nodes[${i}].inputs`, nodeId: n.id, code: 'invalidInputName', params: { name: k }, message: `Invalid input name "${k}"` });
      }
    }
    if (n.type === 'if' && n.when) {
      issues.push({ path: `nodes[${i}]`, nodeId: n.id, code: 'whenOnIf', message: '"Only run when" is not supported on if nodes – put it into the condition' });
    }
  });
  for (const k of Object.keys(d.outputs ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) issues.push({ path: `outputs.${k}`, code: 'invalidOutputName', params: { name: k }, message: `Invalid output name "${k}" (letters, digits and _ only)` });
  }
  const starts = d.nodes.filter((n) => n.type === 'start');
  if (starts.length !== 1) issues.push({ path: 'nodes', code: 'startCount', params: { count: starts.length }, message: `A process needs exactly one start node (found ${starts.length})` });

  const out = new Map<string, Wire[]>();
  const seen = new Set<string>();
  d.wires.forEach((w, i) => {
    const from = byId.get(w.from);
    const to = byId.get(w.to);
    if (!from || !to) {
      issues.push({ path: `wires[${i}]`, code: 'wireUnknownNode', params: { from: w.from, to: w.to }, message: `Wire references unknown node (${w.from} → ${w.to})` });
      return;
    }
    if (!nodePorts(from as never).some((p) => p.id === w.port)) {
      issues.push({ path: `wires[${i}]`, nodeId: from.id, code: 'unknownPort', params: { id: from.id, port: w.port }, message: `Node "${from.id}" has no output "${w.port}"` });
    }
    if (!hasInput(to.type)) issues.push({ path: `wires[${i}]`, nodeId: to.id, code: 'noInput', params: { id: to.id }, message: `Node "${to.id}" cannot receive wires` });
    const k = `${w.from}|${w.port}|${w.to}`;
    if (seen.has(k)) warnings.push({ path: `wires[${i}]`, nodeId: from.id, code: 'duplicateWire', message: 'Duplicate wire' });
    seen.add(k);
    out.set(w.from, [...(out.get(w.from) ?? []), w]);
  });

  // cycles (loops must use a for-each node instead of wiring back)
  const state = new Map<string, 1 | 2>();
  const visit = (id: string, trail: string[]): void => {
    state.set(id, 1);
    for (const w of out.get(id) ?? []) {
      const s = state.get(w.to);
      if (s === 1) {
        const cycle = [...trail, id, w.to].join(' → ');
        issues.push({ path: 'wires', nodeId: w.to, code: 'cycle', params: { cycle }, message: `Wires form a cycle (${cycle}). Use a "For each" node for loops.` });
      }
      else if (!s) visit(w.to, [...trail, id]);
    }
    state.set(id, 2);
  };
  for (const n of d.nodes) if (!state.has(n.id)) visit(n.id, []);

  // reachability
  if (starts.length === 1 && issues.length === 0) {
    const reach = new Set<string>();
    const stack = [starts[0]!.id];
    while (stack.length) {
      const id = stack.pop()!;
      if (reach.has(id)) continue;
      reach.add(id);
      for (const w of out.get(id) ?? []) stack.push(w.to);
    }
    for (const n of d.nodes) {
      if (n.type !== 'note' && !reach.has(n.id)) {
        warnings.push({ path: 'nodes', nodeId: n.id, code: 'unreachable', params: { name: n.name || n.id }, message: `"${n.name || n.id}" is not connected to the start node and will never run` });
      }
    }
  }
  return { issues, warnings };
}

/** Methods treated as write operations (skipped in dry runs). */
export function isMutating(step: Pick<HttpConfig, 'method' | 'mutating'>): boolean {
  if (typeof step.mutating === 'boolean') return step.mutating;
  return !['GET', 'HEAD'].includes(step.method);
}
