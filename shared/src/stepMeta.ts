import type { Step, StepType } from './process.js';

/** UI metadata used by the process editor to render step forms. */
export type FieldKind =
  | 'text'
  | 'template'
  | 'templateArea'
  | 'expr'
  | 'number'
  | 'boolean'
  | 'select'
  | 'connection'
  | 'method'
  | 'keyValue'
  | 'json'
  | 'columns'
  | 'actions'
  | 'paginate'
  | 'statusList'
  | 'identifier';

export interface FieldMeta {
  key: string;
  label: string;
  kind: FieldKind;
  options?: string[];
  help?: string;
  required?: boolean;
  placeholder?: string;
}

export interface StepMeta {
  type: StepType;
  label: string;
  category: 'API' | 'Data' | 'Control' | 'People' | 'Evidence' | 'Browser';
  description: string;
  fields: FieldMeta[];
  /** Nested step blocks */
  blocks?: { key: 'steps' | 'then' | 'else'; label: string }[];
  defaults: () => Partial<Step>;
}

export const STEP_META: Record<StepType, StepMeta> = {
  http: {
    type: 'http',
    label: 'API call',
    category: 'API',
    description: 'Call an endpoint of a connected platform. Writes (POST/PUT/PATCH/DELETE) are skipped in dry runs.',
    fields: [
      { key: 'connection', label: 'Connection', kind: 'connection', required: true },
      { key: 'method', label: 'Method', kind: 'method', required: true },
      {
        key: 'path',
        label: 'Path or URL',
        kind: 'template',
        required: true,
        placeholder: '/api/identitymanagement/v3/Users/{{ vars.user.id }}',
      },
      { key: 'query', label: 'Query parameters', kind: 'keyValue' },
      { key: 'headers', label: 'Headers', kind: 'keyValue' },
      { key: 'body', label: 'Body (JSON / YAML, templates allowed)', kind: 'json' },
      { key: 'bodyType', label: 'Body encoding', kind: 'select', options: ['json', 'form', 'text'] },
      { key: 'paginate', label: 'Pagination', kind: 'paginate' },
      {
        key: 'expectStatus',
        label: 'Accepted status codes',
        kind: 'statusList',
        help: 'Comma separated. Empty = any 2xx.',
      },
      { key: 'mutating', label: 'Treat as write (skip in dry run)', kind: 'boolean', help: 'Default: every method except GET/HEAD' },
    ],
    defaults: () => ({ method: 'GET', path: '/' }),
  },
  set: {
    type: 'set',
    label: 'Set variables',
    category: 'Data',
    description: 'Compute values with JSONata expressions and store them in vars.<name>.',
    fields: [{ key: 'values', label: 'Variables (name → template)', kind: 'keyValue', required: true }],
    defaults: () => ({ values: { result: '{{ 1 + 1 }}' } }),
  },
  forEach: {
    type: 'forEach',
    label: 'For each',
    category: 'Control',
    description: 'Repeat the nested steps for every item of a list. The item is available as vars.<as>.',
    fields: [
      { key: 'items', label: 'Items (expression)', kind: 'expr', required: true, placeholder: 'vars.users.body' },
      { key: 'as', label: 'Item variable name', kind: 'identifier', required: true },
      { key: 'delayMs', label: 'Delay between items (ms)', kind: 'number' },
      { key: 'maxItems', label: 'Max items (safety limit)', kind: 'number' },
    ],
    blocks: [{ key: 'steps', label: 'Do' }],
    defaults: () => ({ items: 'vars.items', as: 'item', steps: [] }),
  },
  if: {
    type: 'if',
    label: 'If / else',
    category: 'Control',
    description: 'Run one of two branches depending on a condition.',
    fields: [{ key: 'condition', label: 'Condition (expression)', kind: 'expr', required: true }],
    blocks: [
      { key: 'then', label: 'Then' },
      { key: 'else', label: 'Else' },
    ],
    defaults: () => ({ condition: 'true', then: [], else: [] }),
  },
  group: {
    type: 'group',
    label: 'Group',
    category: 'Control',
    description: 'Group steps into a named section (shared condition / error handling).',
    fields: [],
    blocks: [{ key: 'steps', label: 'Steps' }],
    defaults: () => ({ steps: [] }),
  },
  userTask: {
    type: 'userTask',
    label: 'User task / approval',
    category: 'People',
    description:
      'Pause the run and ask a person to pick items from a list (select) or approve/reject (approve). The decision is recorded in the protocol.',
    fields: [
      { key: 'mode', label: 'Mode', kind: 'select', options: ['select', 'approve'], required: true },
      { key: 'title', label: 'Title', kind: 'template', required: true },
      { key: 'instructions', label: 'Instructions (markdown, templates allowed)', kind: 'templateArea' },
      { key: 'items', label: 'Items (expression, select mode)', kind: 'expr' },
      { key: 'itemKey', label: 'Item key field', kind: 'text', placeholder: 'id' },
      { key: 'columns', label: 'Columns', kind: 'columns' },
      { key: 'preselect', label: 'Preselect (expression per item, $item)', kind: 'expr', placeholder: 'true' },
      { key: 'onReject', label: 'On reject (approve mode)', kind: 'select', options: ['fail', 'continue'] },
    ],
    defaults: () => ({ mode: 'approve', title: 'Please confirm' }),
  },
  check: {
    type: 'check',
    label: 'Check / assertion',
    category: 'Evidence',
    description: 'Record a pass/fail check result (status tests, health checks).',
    fields: [
      { key: 'condition', label: 'Passes when (expression)', kind: 'expr', required: true },
      { key: 'severity', label: 'Severity', kind: 'select', options: ['error', 'warning', 'info'] },
      { key: 'message', label: 'Message', kind: 'template' },
      { key: 'failRun', label: 'Fail the run when the check fails', kind: 'boolean' },
    ],
    defaults: () => ({ condition: 'true', severity: 'error' }),
  },
  log: {
    type: 'log',
    label: 'Log message',
    category: 'Evidence',
    description: 'Write a message (and optional data) to the run protocol.',
    fields: [
      { key: 'level', label: 'Level', kind: 'select', options: ['info', 'warn', 'error'] },
      { key: 'message', label: 'Message', kind: 'template', required: true },
      { key: 'data', label: 'Data (expression)', kind: 'expr' },
    ],
    defaults: () => ({ level: 'info', message: '' }),
  },
  report: {
    type: 'report',
    label: 'Report section',
    category: 'Evidence',
    description: 'Add a section with text and/or a table to the run protocol.',
    fields: [
      { key: 'title', label: 'Title', kind: 'template', required: true },
      { key: 'text', label: 'Text (markdown, templates allowed)', kind: 'templateArea' },
      { key: 'rows', label: 'Table rows (expression)', kind: 'expr' },
      { key: 'columns', label: 'Columns', kind: 'columns' },
    ],
    defaults: () => ({ title: 'Summary' }),
  },
  browser: {
    type: 'browser',
    label: 'Browser automation',
    category: 'Browser',
    description:
      'Drive a real browser (Playwright): open pages, fill forms, click, extract text and take screenshots as evidence. The browser session is shared by all browser steps of a run.',
    fields: [
      { key: 'connection', label: 'Connection (for base URL & secrets)', kind: 'connection' },
      { key: 'actions', label: 'Actions', kind: 'actions', required: true },
      { key: 'mutating', label: 'Changes data (skip in dry run)', kind: 'boolean' },
    ],
    defaults: () => ({ actions: [{ action: 'goto', value: '/' }, { action: 'screenshot', name: 'page' }] }),
  },
  wait: {
    type: 'wait',
    label: 'Wait',
    category: 'Control',
    description: 'Pause for a number of seconds.',
    fields: [{ key: 'seconds', label: 'Seconds', kind: 'number', required: true }],
    defaults: () => ({ seconds: 5 }),
  },
  fail: {
    type: 'fail',
    label: 'Fail run',
    category: 'Control',
    description: 'Stop the run with an error message.',
    fields: [{ key: 'message', label: 'Message', kind: 'template', required: true }],
    defaults: () => ({ message: 'Stopped' }),
  },
};

export const COMMON_FIELDS: FieldMeta[] = [
  { key: 'when', label: 'Only run when (expression)', kind: 'expr', help: 'Skipped if false' },
  { key: 'saveAs', label: 'Save result as vars.', kind: 'identifier' },
  { key: 'onError', label: 'On error', kind: 'select', options: ['fail', 'continue'] },
];

export const BROWSER_ACTIONS: { action: string; label: string; fields: ('selector' | 'value' | 'as' | 'attribute' | 'name')[] }[] = [
  { action: 'goto', label: 'Open URL', fields: ['value'] },
  { action: 'click', label: 'Click', fields: ['selector'] },
  { action: 'fill', label: 'Fill field', fields: ['selector', 'value'] },
  { action: 'press', label: 'Press key', fields: ['selector', 'value'] },
  { action: 'select', label: 'Select option', fields: ['selector', 'value'] },
  { action: 'check', label: 'Tick checkbox', fields: ['selector'] },
  { action: 'waitFor', label: 'Wait for element', fields: ['selector'] },
  { action: 'expectText', label: 'Expect text', fields: ['selector', 'value'] },
  { action: 'extract', label: 'Extract text/attribute', fields: ['selector', 'attribute', 'as'] },
  { action: 'screenshot', label: 'Screenshot (evidence)', fields: ['name'] },
  { action: 'wait', label: 'Wait (ms)', fields: ['value'] },
  { action: 'evaluate', label: 'Run JavaScript in page', fields: ['value', 'as'] },
];

export function newStepId(type: StepType, existing: Set<string>): string {
  let i = 1;
  while (existing.has(`${type}${i}`)) i++;
  return `${type}${i}`;
}
