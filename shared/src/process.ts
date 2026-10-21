import { z } from 'zod';

/**
 * Process definition model.
 *
 * A process is a tree of steps. Fields marked "expression" take a JSONata
 * expression (optionally wrapped in {{ }}). Fields marked "template" are
 * strings/objects where {{ expression }} parts are replaced at run time.
 *
 * Expression scope: inputs, vars, const, run  (plus $item for per-item fields)
 */

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const STEP_TYPES = [
  'http',
  'set',
  'forEach',
  'if',
  'group',
  'userTask',
  'check',
  'log',
  'report',
  'browser',
  'wait',
  'fail',
] as const;
export type StepType = (typeof STEP_TYPES)[number];

const identifier = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Use letters, digits and _ only (must not start with a digit)');

const columnSchema = z.object({
  label: z.string(),
  value: z.string(), // expression evaluated against the item
});
export type Column = z.infer<typeof columnSchema>;

const baseStep = {
  id: identifier,
  name: z.string().optional(),
  description: z.string().optional(),
  /** Expression; step is skipped when it evaluates to false. */
  when: z.string().optional(),
  onError: z.enum(['fail', 'continue']).optional(),
  retry: z
    .object({ attempts: z.number().int().min(1).max(10), delayMs: z.number().int().min(0).optional() })
    .optional(),
  /** Store the step result in vars.<saveAs>. */
  saveAs: identifier.optional(),
};

export const paginateSchema = z.object({
  mode: z.enum(['none', 'scim', 'page', 'offset', 'nextLink']),
  /** Expression for the item array inside one page response body. */
  itemsPath: z.string().optional(),
  pageSize: z.number().int().min(1).max(10000).optional(),
  /** Query parameter names (defaults depend on mode). */
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
  action: z.enum([
    'goto',
    'click',
    'fill',
    'press',
    'select',
    'check',
    'waitFor',
    'expectText',
    'extract',
    'screenshot',
    'wait',
    'evaluate',
  ]),
  /** Playwright selector (css, text=..., role=..., etc.) */
  selector: z.string().optional(),
  /** Template: URL for goto, value for fill/select, key for press, text for expectText, JS for evaluate */
  value: z.string().optional(),
  /** Variable name to store extracted value / evaluate result. */
  as: identifier.optional(),
  attribute: z.string().optional(),
  all: z.boolean().optional(),
  name: z.string().optional(),
  fullPage: z.boolean().optional(),
  timeoutMs: z.number().int().min(0).optional(),
  state: z.enum(['attached', 'detached', 'visible', 'hidden']).optional(),
});
export type BrowserAction = z.infer<typeof browserActionSchema>;

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
  | WaitStep
  | FailStep;

interface Base {
  id: string;
  name?: string;
  description?: string;
  when?: string;
  onError?: 'fail' | 'continue';
  retry?: { attempts: number; delayMs?: number };
  saveAs?: string;
}
export interface HttpStep extends Base {
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
  operationId?: string;
  /** Override write detection (non-GET/HEAD = write) used for dry runs. */
  mutating?: boolean;
}
export interface SetStep extends Base {
  type: 'set';
  values: Record<string, unknown>;
}
export interface ForEachStep extends Base {
  type: 'forEach';
  items: string;
  as: string;
  steps: Step[];
  delayMs?: number;
  maxItems?: number;
}
export interface IfStep extends Base {
  type: 'if';
  condition: string;
  then: Step[];
  else?: Step[];
}
export interface GroupStep extends Base {
  type: 'group';
  steps: Step[];
}
export interface UserTaskStep extends Base {
  type: 'userTask';
  mode: 'select' | 'approve';
  title: string;
  instructions?: string;
  items?: string;
  itemKey?: string;
  columns?: Column[];
  /** Per-item expression: true = checkbox preselected. */
  preselect?: string;
  /** For approve mode: what happens on rejection. */
  onReject?: 'fail' | 'continue';
}
export interface CheckStep extends Base {
  type: 'check';
  condition: string;
  severity?: 'error' | 'warning' | 'info';
  message?: string;
  failRun?: boolean;
}
export interface LogStep extends Base {
  type: 'log';
  level?: 'info' | 'warn' | 'error';
  message: string;
  data?: string;
}
export interface ReportStep extends Base {
  type: 'report';
  title: string;
  text?: string;
  rows?: string;
  columns?: Column[];
}
export interface BrowserStep extends Base {
  type: 'browser';
  connection?: string;
  actions: BrowserAction[];
  mutating?: boolean;
}
export interface WaitStep extends Base {
  type: 'wait';
  seconds: number;
}
export interface FailStep extends Base {
  type: 'fail';
  message: string;
}

const stepSchema: z.ZodType<Step> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({
      ...baseStep,
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
    }),
    z.object({ ...baseStep, type: z.literal('set'), values: z.record(z.unknown()) }),
    z.object({
      ...baseStep,
      type: z.literal('forEach'),
      items: z.string().min(1),
      as: identifier,
      steps: z.array(stepSchema),
      delayMs: z.number().int().min(0).optional(),
      maxItems: z.number().int().min(1).optional(),
    }),
    z.object({
      ...baseStep,
      type: z.literal('if'),
      condition: z.string().min(1),
      then: z.array(stepSchema),
      else: z.array(stepSchema).optional(),
    }),
    z.object({ ...baseStep, type: z.literal('group'), steps: z.array(stepSchema) }),
    z.object({
      ...baseStep,
      type: z.literal('userTask'),
      mode: z.enum(['select', 'approve']),
      title: z.string().min(1),
      instructions: z.string().optional(),
      items: z.string().optional(),
      itemKey: z.string().optional(),
      columns: z.array(columnSchema).optional(),
      preselect: z.string().optional(),
      onReject: z.enum(['fail', 'continue']).optional(),
    }),
    z.object({
      ...baseStep,
      type: z.literal('check'),
      condition: z.string().min(1),
      severity: z.enum(['error', 'warning', 'info']).optional(),
      message: z.string().optional(),
      failRun: z.boolean().optional(),
    }),
    z.object({
      ...baseStep,
      type: z.literal('log'),
      level: z.enum(['info', 'warn', 'error']).optional(),
      message: z.string(),
      data: z.string().optional(),
    }),
    z.object({
      ...baseStep,
      type: z.literal('report'),
      title: z.string().min(1),
      text: z.string().optional(),
      rows: z.string().optional(),
      columns: z.array(columnSchema).optional(),
    }),
    z.object({
      ...baseStep,
      type: z.literal('browser'),
      connection: z.string().optional(),
      actions: z.array(browserActionSchema),
      mutating: z.boolean().optional(),
    }),
    z.object({ ...baseStep, type: z.literal('wait'), seconds: z.number().min(0).max(3600) }),
    z.object({ ...baseStep, type: z.literal('fail'), message: z.string() }),
  ]),
) as z.ZodType<Step>;

export const INPUT_TYPES = ['string', 'number', 'boolean', 'select', 'list', 'table', 'json'] as const;
export type InputType = (typeof INPUT_TYPES)[number];

export const inputDefSchema = z.object({
  name: identifier,
  label: z.string().optional(),
  type: z.enum(INPUT_TYPES),
  description: z.string().optional(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  /** select: allowed values */
  options: z.array(z.string()).optional(),
  /** table: expected CSV columns */
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

export const processDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  connections: z.array(connectionSlotSchema).default([]),
  inputs: z.array(inputDefSchema).default([]),
  constants: z.record(z.unknown()).optional(),
  steps: z.array(stepSchema),
});
export type ProcessDefinition = z.infer<typeof processDefinitionSchema>;

export interface ValidationIssue {
  path: string;
  message: string;
}

/** Walk all steps (depth first) with their nesting path. */
export function walkSteps(
  steps: Step[],
  fn: (step: Step, path: string) => void,
  prefix = 'steps',
): void {
  steps.forEach((s, i) => {
    const p = `${prefix}[${i}]`;
    fn(s, p);
    for (const [key, children] of childBlocks(s)) walkSteps(children, fn, `${p}.${key}`);
  });
}

/** Nested step lists of a control step. */
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

export function validateProcess(def: unknown): {
  ok: boolean;
  issues: ValidationIssue[];
  definition?: ProcessDefinition;
} {
  const parsed = processDefinitionSchema.safeParse(def);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  }
  const d = parsed.data;
  const issues: ValidationIssue[] = [];
  const ids = new Map<string, string>();
  const slots = new Set(d.connections.map((c) => c.slot));
  walkSteps(d.steps, (s, path) => {
    const prev = ids.get(s.id);
    if (prev) issues.push({ path, message: `Duplicate step id "${s.id}" (also used at ${prev})` });
    ids.set(s.id, path);
    if ((s.type === 'http' || (s.type === 'browser' && s.connection)) && !slots.has(s.connection!)) {
      issues.push({ path, message: `Unknown connection slot "${s.connection}". Declare it under connections.` });
    }
    if (s.type === 'userTask' && s.mode === 'select' && !s.items) {
      issues.push({ path, message: 'Select tasks need an "items" expression' });
    }
  });
  const inputNames = new Set<string>();
  for (const inp of d.inputs) {
    if (inputNames.has(inp.name)) issues.push({ path: `inputs.${inp.name}`, message: 'Duplicate input name' });
    inputNames.add(inp.name);
  }
  return { ok: issues.length === 0, issues, definition: d };
}

/** Methods treated as write operations (skipped in dry runs). */
export function isMutating(step: HttpStep): boolean {
  if (typeof step.mutating === 'boolean') return step.mutating;
  return !['GET', 'HEAD'].includes(step.method);
}
