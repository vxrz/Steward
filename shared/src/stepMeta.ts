import type { FlowNode, NodeType } from './process.js';

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
  | 'identifier'
  | 'subjects'
  | 'process'
  | 'aiModel'
  | 'prompt'
  | 'aiContext';

export interface FieldMeta {
  key: string;
  label: string;
  kind: FieldKind;
  options?: string[];
  help?: string;
  required?: boolean;
  placeholder?: string;
}

export type NodeCategory = 'Flow' | 'API' | 'Data' | 'Control' | 'People' | 'Evidence' | 'Browser';

export interface StepMeta {
  type: NodeType;
  label: string;
  category: NodeCategory;
  description: string;
  fields: FieldMeta[];
  /** Color used on the canvas */
  color: string;
  defaults: () => Partial<FlowNode>;
}

export const CATEGORY_ORDER: NodeCategory[] = ['Flow', 'API', 'Data', 'Control', 'People', 'Evidence', 'Browser'];

export const STEP_META: Record<NodeType, StepMeta> = {
  start: {
    type: 'start',
    label: 'Start',
    category: 'Flow',
    description: 'Entry point of the process. Inputs and connections are defined in the process settings.',
    fields: [],
    color: 'gray',
    defaults: () => ({ name: 'Start' }),
  },
  note: {
    type: 'note',
    label: 'Comment',
    category: 'Flow',
    description: 'A comment on the canvas. Not executed.',
    fields: [{ key: 'text', label: 'Text (markdown)', kind: 'templateArea', required: true }],
    color: 'yellow',
    defaults: () => ({ text: 'Comment' }),
  },
  http: {
    type: 'http',
    label: 'API call',
    category: 'API',
    color: 'blue',
    description:
      'Call an endpoint of a connected platform. Writes (POST/PUT/PATCH/DELETE) are skipped in dry runs. Connect the "error" output to handle failures instead of stopping the run.',
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
      { key: 'maxResponseMb', label: 'Largest answer (MB)', kind: 'number', help: 'Default 20, at most 200 (per page); a larger answer fails the step' },
      {
        key: 'aws',
        label: 'AWS service (AWS platforms only)',
        kind: 'json',
        help: 'service and region, e.g. { service: ec2, region: eu-central-1 }: the path is relative to that endpoint, signed with the platform',
      },
    ],
    defaults: () => ({ method: 'GET', path: '/' }),
  },
  set: {
    type: 'set',
    label: 'Set variables',
    category: 'Data',
    color: 'teal',
    description: 'Compute values with JSONata expressions and store them in vars.<name>.',
    fields: [{ key: 'values', label: 'Variables (name → template)', kind: 'keyValue', required: true }],
    defaults: () => ({ values: { result: '{{ 1 + 1 }}' } }),
  },
  forEach: {
    type: 'forEach',
    label: 'For each',
    category: 'Control',
    color: 'indigo',
    description:
      'Runs the nodes connected to "each item" once per item (the item is vars.<as>), then continues with "done". Leave the last node of the loop body unconnected.',
    fields: [
      { key: 'items', label: 'Items (expression)', kind: 'expr', required: true, placeholder: 'vars.users.body' },
      { key: 'as', label: 'Item variable name', kind: 'identifier', required: true },
      { key: 'delayMs', label: 'Delay between items (ms)', kind: 'number' },
      { key: 'maxItems', label: 'Max items (safety limit)', kind: 'number' },
      {
        key: 'concurrency',
        label: 'Parallel items (1 = one after another)',
        kind: 'number',
        help: 'Up to 20. In parallel mode variables set inside the loop are local to each item; the loop result (Save result as) holds them per item in results[].',
      },
    ],
    defaults: () => ({ items: 'vars.items', as: 'item' }),
  },
  if: {
    type: 'if',
    label: 'If / else',
    category: 'Control',
    color: 'indigo',
    description: 'Continues with "true" or "false" depending on a condition.',
    fields: [{ key: 'condition', label: 'Condition (expression)', kind: 'expr', required: true }],
    defaults: () => ({ condition: 'true' }),
  },
  userTask: {
    type: 'userTask',
    label: 'User task / approval',
    category: 'People',
    color: 'grape',
    description:
      'Pause the run and ask a person to pick items from a list (select), approve/reject (approve, with "approved" and "rejected" outputs – an unconnected "rejected" output fails the run) or carry out a documented manual step (manual: checklist, fields, evidence, optional second-person verification). Everything is recorded in the protocol.',
    fields: [
      { key: 'mode', label: 'Mode', kind: 'select', options: ['select', 'approve', 'manual'], required: true },
      { key: 'title', label: 'Title', kind: 'template', required: true },
      { key: 'instructions', label: 'Instructions (markdown, templates allowed)', kind: 'templateArea' },
      { key: 'items', label: 'Items (expression, select mode)', kind: 'expr' },
      { key: 'itemKey', label: 'Item key field', kind: 'text', placeholder: 'id' },
      { key: 'columns', label: 'Columns', kind: 'columns' },
      { key: 'preselect', label: 'Preselect (expression per item, $item)', kind: 'expr', placeholder: 'true' },
      {
        key: 'assignees',
        label: 'Who may decide',
        kind: 'subjects',
        help: 'Users, teams or roles. Empty = everyone allowed to run or approve this process.',
      },
      { key: 'fourEyes', label: 'Four-eyes: the person who started the run may not decide', kind: 'boolean' },
    ],
    defaults: () => ({ mode: 'approve', title: 'Please confirm' }),
  },
  check: {
    type: 'check',
    label: 'Check / assertion',
    category: 'Evidence',
    color: 'green',
    description: 'Record a pass/fail check result (status tests, health checks).',
    fields: [
      { key: 'condition', label: 'Passes when (expression)', kind: 'expr', required: true },
      { key: 'severity', label: 'Severity', kind: 'select', options: ['error', 'warning', 'info'] },
      { key: 'message', label: 'Message', kind: 'template' },
      { key: 'failRun', label: 'Fail the run when the check fails', kind: 'boolean' },
      {
        key: 'notify',
        label: 'Notify when the check fails',
        kind: 'boolean',
        help: 'Default: yes. No: an informational check – shown in the run, never notified',
      },
      {
        key: 'headline',
        label: 'Headline of the message (optional)',
        kind: 'template',
        help: 'A short sentence for the failure, used as subject, e.g. {{ $count(vars.down) }} of {{ vars.total }} endpoints down',
      },
      { key: 'value', label: 'Value (optional)', kind: 'expr', help: 'The number that matters, e.g. the endpoints down; messages say whether it got better' },
      { key: 'betterWhen', label: 'Better when the value is', kind: 'select', options: ['lower', 'higher'] },
      { key: 'items', label: 'Items (optional)', kind: 'expr', help: 'A list shown as bullets in the message, e.g. the names of the endpoints down' },
      { key: 'runbook', label: 'Runbook (optional)', kind: 'text', help: 'A living document id (rec_…) or an http(s) URL; default: the process runbook' },
    ],
    defaults: () => ({ condition: 'true', severity: 'error' }),
  },
  log: {
    type: 'log',
    label: 'Log message',
    category: 'Evidence',
    color: 'green',
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
    color: 'green',
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
    color: 'orange',
    description:
      'Drive a real browser (Playwright): open pages, fill forms, click, extract text and take screenshots as evidence. The browser session is shared by all browser steps of a run. Dry runs skip only steps marked "changes data"; otherwise interactions (click, fill, …) still run and can change data in the portal – use "Read-only in dry runs" for a step that must stay safe to preview.',
    fields: [
      { key: 'connection', label: 'Connection (for base URL & secrets)', kind: 'connection' },
      { key: 'actions', label: 'Actions', kind: 'actions', required: true },
      { key: 'mutating', label: 'Changes data (skip in dry run)', kind: 'boolean' },
      { key: 'dryRunReadOnly', label: 'Read-only in dry runs (skip click/fill/… during a dry run)', kind: 'boolean' },
    ],
    defaults: () => ({
      actions: [
        { action: 'goto', value: '/' },
        { action: 'screenshot', name: 'page' },
      ],
    }),
  },
  publish: {
    type: 'publish',
    label: 'Publish to dashboard',
    category: 'Evidence',
    color: 'cyan',
    description:
      'Store a snapshot of rows (with a status per row) and metric values in a dataset for dashboards. Each run replaces the rows; metrics are kept as history for trends. Dashboards read the stored data – they never call the platforms themselves.',
    fields: [
      { key: 'dataset', label: 'Dataset key', kind: 'text', required: true, placeholder: 'ih.users', help: 'Dashboards refer to this key' },
      { key: 'title', label: 'Title', kind: 'text' },
      { key: 'rows', label: 'Rows (expression → list)', kind: 'expr', placeholder: 'vars.users.body' },
      { key: 'columns', label: 'Columns (keep only what the dashboard needs)', kind: 'columns' },
      { key: 'key', label: 'Row key (expression per item)', kind: 'expr', placeholder: 'id' },
      {
        key: 'status',
        label: 'Status (expression per item)',
        kind: 'expr',
        placeholder: "connectionState = 'ONLINE' ? 'good' : 'critical'",
        help: 'good | warning | serious | critical | unknown',
      },
      { key: 'statusText', label: 'Status reason (expression per item)', kind: 'expr' },
      { key: 'metrics', label: 'Metrics (name → number expression)', kind: 'keyValue', help: 'Appended to the history for trend charts' },
      {
        key: 'limits',
        label: 'Upper limits (metric → number expression)',
        kind: 'keyValue',
        help: 'A quota or contract limit per metric: dashboards and checks forecast when the trend reaches it',
      },
      {
        key: 'floors',
        label: 'Lower limits (metric → number expression)',
        kind: 'keyValue',
        help: 'A floor per metric, e.g. free storage: forecast when the trend falls to it',
      },
      {
        key: 'staleAfterMinutes',
        label: 'Stale after (minutes)',
        kind: 'number',
        help: 'For runs without a schedule (default 24 hours). Scheduled runs follow their schedule: 2.5 × its interval, at least 15 minutes',
      },
      {
        key: 'staleAfterFixed',
        label: 'Use “Stale after” for scheduled runs too',
        kind: 'boolean',
        help: 'Instead of 2.5 × the schedule interval, e.g. for a tighter or a more tolerant limit than the schedule gives',
      },
      { key: 'maxRows', label: 'Max rows (safety limit, default 5000)', kind: 'number' },
      {
        key: 'source',
        label: 'Source connection (optional)',
        kind: 'connection',
        help: 'Its platform is where the rows come from: every source keeps its own rows. Default: the only connection, else all bound platforms',
      },
    ],
    defaults: () => ({ dataset: 'my.dataset', rows: 'vars.items', metrics: { total: '$count(vars.items)' } }),
  },
  accessChange: {
    type: 'accessChange',
    label: 'Document access change',
    category: 'Evidence',
    color: 'grape',
    description:
      'Records which access rights this run changed (one entry per user or technical user). When the run ends, Steward creates a documented access change entry per subject, linked to the run and its PDF protocol – no manual documentation needed. Place it after the steps that change access. Nothing is recorded in dry runs.',
    fields: [
      { key: 'connection', label: 'Platform connection', kind: 'connection', required: true },
      { key: 'kind', label: 'Change', kind: 'select', options: ['grant', 'revoke', 'modify', 'onboarding', 'offboarding'], required: true },
      {
        key: 'items',
        label: 'Subjects (expression → list, optional)',
        kind: 'expr',
        placeholder: 'vars.attestation.unselected',
        help: 'With a list, the expressions below are evaluated per item; without, once in the run scope (e.g. inside a loop)',
      },
      { key: 'subjectId', label: 'Subject id (expression)', kind: 'expr', required: true, placeholder: 'userName' },
      { key: 'subjectName', label: 'Subject name (expression)', kind: 'expr' },
      {
        key: 'rights',
        label: 'Changed rights (expression → list)',
        kind: 'expr',
        placeholder: '[role]',
        help: 'Granted for grant/onboarding, removed for revoke/offboarding',
      },
      { key: 'rightsBefore', label: 'All rights before (expression → list)', kind: 'expr' },
      { key: 'rightsAfter', label: 'All rights after (expression → list)', kind: 'expr' },
      { key: 'reason', label: 'Reason', kind: 'template' },
      { key: 'requestRef', label: 'Request reference (ticket)', kind: 'template' },
      { key: 'approvedBy', label: 'Approved by', kind: 'template', placeholder: '{{ vars.approval.decidedBy }}' },
    ],
    defaults: () => ({ connection: '', kind: 'grant', subjectId: 'vars.user.userName', rights: '[vars.groupName]', reason: 'Access granted by this process' }),
  },
  ai: {
    type: 'ai',
    label: 'Ask an AI model',
    category: 'API',
    color: 'pink',
    description:
      'Sends a predefined question to a model of an LLM gateway, with the context you choose (results of earlier steps, datasets), and uses the answer in later steps. Limits and budgets are checked before anything is sent, secret-looking values are removed. Dry runs and test runs never call the model. Connect "error" to handle a refused or failed call.',
    fields: [
      { key: 'connection', label: 'LLM gateway connection', kind: 'connection', required: true },
      { key: 'model', label: 'Model', kind: 'aiModel', required: true, help: 'A model configured on the gateway (platform → AI models)' },
      {
        key: 'system',
        label: 'Instructions (system part)',
        kind: 'prompt',
        placeholder: 'You summarise monitoring data for the service team. Answer in short sentences.',
      },
      {
        key: 'prompt',
        label: 'Question (user part)',
        kind: 'prompt',
        required: true,
        placeholder: 'Which of these series need attention this week?\n\n{{ trends }}',
        help: 'The name of a context source in double braces inserts it; nothing else is filled in at run time',
      },
      { key: 'context', label: 'Context', kind: 'aiContext', required: true },
      { key: 'answer', label: 'Answer', kind: 'select', options: ['text', 'json'], help: 'json: the answer must match the JSON Schema below' },
      { key: 'schema', label: 'JSON Schema of the answer', kind: 'json', help: 'For a JSON answer: later steps and checks can rely on its shape' },
      { key: 'temperature', label: 'Temperature', kind: 'number', help: '0 (default of the model if empty) to 2; lower is more predictable' },
      { key: 'maxOutputTokens', label: 'Most output tokens', kind: 'number', help: "Default and ceiling: the model's maximum output" },
      {
        key: 'maxInputTokens',
        label: 'Most input tokens',
        kind: 'number',
        help: "Estimated before sending: a larger input fails the step without a call. Default and ceiling: the model's",
      },
      {
        key: 'sampleAnswer',
        label: 'Sample answer (dry runs and test runs)',
        kind: 'prompt',
        help: 'Used instead of the model in dry runs, and in test runs without a recorded response',
      },
    ],
    defaults: () => ({ connection: '', model: '', prompt: 'Summarise the following in three sentences:\n\n{{ data }}', context: [], answer: 'text' }),
  },
  subprocess: {
    type: 'subprocess',
    label: 'Run sub-process',
    category: 'Control',
    color: 'violet',
    description:
      'Runs another process as one step (reusable building blocks). The child run gets its own protocol, linked to this run; its outputs (process setting "Outputs") become this node\'s result. Connect "error" to handle a failed child run.',
    fields: [
      { key: 'process', label: 'Process', kind: 'process', required: true },
      { key: 'version', label: 'Version (empty = current)', kind: 'number' },
      { key: 'inputs', label: 'Inputs (child input → template)', kind: 'keyValue' },
      { key: 'connections', label: "Connections (child slot → this process' slot)", kind: 'keyValue', help: 'Empty = same slot names' },
    ],
    defaults: () => ({ process: '', inputs: {} }),
  },
  wait: {
    type: 'wait',
    label: 'Wait',
    category: 'Control',
    color: 'indigo',
    description: 'Pause for a number of seconds.',
    fields: [{ key: 'seconds', label: 'Seconds', kind: 'number', required: true }],
    defaults: () => ({ seconds: 5 }),
  },
  fail: {
    type: 'fail',
    label: 'Fail run',
    category: 'Control',
    color: 'indigo',
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

export function newStepId(type: NodeType, existing: Set<string>): string {
  let i = 1;
  while (existing.has(`${type}${i}`)) i++;
  return `${type}${i}`;
}
