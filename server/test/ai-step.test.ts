import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LLM_GATEWAY_KIND, AI_USAGE_DATASET } from '@sm/shared';
import { ADMIN, setup, startTestServer, type TestServer } from './helpers.js';

/**
 * "Ask an AI model" end to end (#216, docs/AI.md) against the simulated multi-format gateway (mock/mockLlmGateway.ts):
 * the preset and the AI settings, discovering models, the connection test, a run in every format (the request each
 * format gets, the counts each reports), JSON answers checked against a schema, the refusals before anything is sent
 * (input too large, data not allowed, budgets) with their log and audit entries, the 80 % notice, budget periods,
 * secrets removed from the context, dry runs and test runs without a call, AI-generated marking, the usage on the
 * platform page, the built-in dataset and the report section, and who may do what.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
let gateway: string;
let source: string;
let mock: typeof import('../src/mock/mockLlmGateway.js');
const DONE = ['succeeded', 'failed', 'cancelled'];
const WINDOW = { contextTokens: 32_000, maxOutputTokens: 500 };
const MODELS = [
  { id: 'demo-chat-small', format: 'chat-completions', ...WINDOW, priceInputPer1k: 0.5, priceOutputPer1k: 1.5 },
  { id: 'demo-responses-small', format: 'responses', ...WINDOW },
  { id: 'demo-messages-small', format: 'anthropic-messages', ...WINDOW },
  { id: 'demo.converse-small-v1:0', format: 'bedrock-converse', ...WINDOW },
];

// the simulated gateway's test helpers need its API key, like every request to it
const mockKey = () => ({ 'x-api-key': mock.DEMO_LLM.apiKey });
const calls = async (): Promise<{ format: string; model: string; path: string; body: any; headers: Record<string, string> }[]> =>
  (await (await fetch(`${s.base}/mock/llm/_mock/calls`, { headers: mockKey() })).json()).calls;
const resetMock = () => fetch(`${s.base}/mock/llm/_mock/reset`, { method: 'POST', headers: mockKey() });
const n = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, ...extra });
const w = (from: string, to: string, port = 'out') => ({ from, to, port });
const db = async () => (await import('../src/db.js')).db();

async function setAllowed(allowedData: Record<string, unknown>, models: unknown[] = MODELS) {
  return s.api('PUT', `/platforms/${gateway}/ai`, { models, allowedData });
}

/** A process: read from the source platform, then ask the model; `ai` overrides the step. */
async function makeProcess(name: string, ai: Record<string, unknown>, more: { nodes?: unknown[]; wires?: unknown[]; inputs?: unknown[] } = {}) {
  return s.api('POST', '/processes', {
    definition: {
      name,
      connections: [
        { slot: 'llm', kind: LLM_GATEWAY_KIND },
        { slot: 'src', kind: 'generic' },
      ],
      inputs: more.inputs ?? [],
      nodes: [
        n('start', 'start'),
        n('read', 'http', { connection: 'src', method: 'GET', path: '/mock/test/delay?ms=1&value=disk-full-on-db01', saveAs: 'read' }),
        n('ask', 'ai', {
          connection: 'llm',
          model: 'demo-chat-small',
          system: 'You summarise monitoring data.',
          prompt: 'What stands out?\n\n{{ data }}',
          context: [{ name: 'data', from: 'step', step: 'read', path: 'body' }],
          saveAs: 'answer',
          ...ai,
        }),
        ...(more.nodes ?? []),
      ],
      wires: [w('start', 'read'), w('read', 'ask'), ...(more.wires ?? [])],
    },
  });
}

const run = async (processId: string, opts: Record<string, unknown> = {}) => {
  const { id } = await s.api('POST', '/runs', { processId, bindings: { llm: gateway, src: source }, ...opts });
  return s.waitRun(id, DONE);
};
const stepOf = async (runId: string, stepId: string) => {
  const d = await s.api('GET', `/runs/${runId}`);
  const st = d.steps.find((x: any) => x.stepId === stepId);
  const full = await s.api('GET', `/runs/${runId}/steps/${st.id}`);
  return { ...st, ...full };
};
// (calls in the same millisecond keep no order: the tests compare such rows as a set)
const usage = async (where = '1 = 1', ...p: unknown[]) => (await db()).all<any>(`SELECT * FROM ai_usage WHERE ${where} ORDER BY ts, id`, ...p);
const auditOf = async (action: string) => (await s.api('GET', `/audit?action=${action}&limit=50`)) as any[];

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  mock = await import('../src/mock/mockLlmGateway.js');
  const preset = (await s.api('GET', '/platform-presets')).find((p: any) => p.kind === LLM_GATEWAY_KIND);
  const p = await s.api('POST', '/platforms', {
    name: 'Gateway',
    kind: LLM_GATEWAY_KIND,
    baseUrl: `${s.base}/mock/llm`,
    config: { ...preset.config, http: { ...preset.config.http, proxy: 'none' } },
    secrets: { apiKey: mock.DEMO_LLM.apiKey },
  });
  gateway = p.id;
  const src = await s.api('POST', '/platforms', {
    name: 'Monitoring',
    kind: 'generic',
    baseUrl: s.base,
    config: { auth: { type: 'bearer' }, variables: {}, http: { proxy: 'none' } },
    secrets: { token: 'source-token-0123456789' },
  });
  source = src.id;
  await setAllowed({ platforms: [source], datasets: ['checkmk.*'], inputs: false });
});

afterAll(async () => {
  await s?.app.close();
});

beforeEach(async () => {
  await resetMock();
});

describe('the platform', () => {
  it('has a preset: an API key in x-api-key, the model list as its test path, a long timeout', async () => {
    const preset = (await s.api('GET', '/platform-presets')).find((p: any) => p.kind === LLM_GATEWAY_KIND);
    expect(preset).toMatchObject({
      label: 'LLM gateway (AI models)',
      config: { auth: { type: 'apiKey', apiKeyIn: 'header', apiKeyName: 'x-api-key' }, testPath: '/v1/models', http: { timeoutMs: 300000 } },
    });
    expect(preset.secretFields.map((f: any) => [f.key, f.auth])).toEqual([
      ['apiKey', 'apiKey'],
      ['token', 'bearer'],
    ]);
  });

  it('keeps its AI settings sealed with the connection settings; the general form cannot change them', async () => {
    const p = await s.api('GET', `/platforms/${gateway}`);
    expect(p.config.ai.models.map((m: any) => m.id)).toEqual(MODELS.map((m) => m.id));
    expect(p.integrity).toBe('ok');
    // a PUT of the whole platform without (or with other) AI settings keeps them
    const { ai: _ai, ...rest } = p.config;
    await s.api('PUT', `/platforms/${gateway}`, { config: { ...rest, ai: { models: [] } } });
    expect((await s.api('GET', `/platforms/${gateway}`)).config.ai.models).toHaveLength(4);
    const changed = await auditOf('platform.ai_changed');
    expect(changed[0].summary).toMatch(/AI settings of "Gateway" changed: 4 model\(s\), added demo-chat-small/);
  });

  it('a connector type made from the gateway keeps its models, not what this installation allows it', async () => {
    const type = await s.api('POST', '/platform-types', { fromPlatformId: gateway, kind: 'my-llm-gateway', label: 'My gateway' });
    expect(type.config.ai.models.map((m: any) => m.id)).toEqual(MODELS.map((m) => m.id));
    expect(type.config.ai.allowedData).toEqual({ platforms: [], datasets: [], inputs: false });
    await s.api('DELETE', '/platform-types/my-llm-gateway');
  });

  it('refuses invalid AI settings and settings on a platform that is no gateway', async () => {
    await expect(s.api('PUT', `/platforms/${gateway}/ai`, { models: [{ ...MODELS[0], format: 'other' }] })).rejects.toMatchObject({ status: 400 });
    await expect(s.api('PUT', `/platforms/${gateway}/ai`, { models: [MODELS[0], MODELS[0]] })).rejects.toMatchObject({ status: 400 });
    await expect(s.api('PUT', `/platforms/${source}/ai`, { models: [] })).rejects.toMatchObject({ status: 400, body: { code: 'AI_NOT_A_GATEWAY' } });
  });

  it('discovers the models the gateway lists, with a suggested format', async () => {
    const r = await s.api('POST', `/platforms/${gateway}/ai/discover`);
    expect(r.models).toEqual(
      expect.arrayContaining([
        { id: 'demo-chat-small', ownedBy: 'demo', suggestedFormat: 'chat-completions', configured: true },
        { id: 'demo.converse-small-v1:0', ownedBy: 'demo', suggestedFormat: 'bedrock-converse', configured: true },
      ]),
    );
  });

  it('the connection test lists the models and asks each one once – logged as usage, not as a process', async () => {
    const before = (await usage()).length;
    const t = await s.api('POST', `/platforms/${gateway}/test`);
    expect(t.ok).toBe(true);
    expect(t.message).toBe('Every model set up answers (4)');
    expect(t.checks[0]).toMatchObject({ name: 'Model list (GET /v1/models)', ok: true, message: '4 model(s) listed; every model set up is listed' });
    expect(t.checks.slice(1).map((c: any) => [c.name, c.ok])).toEqual(MODELS.map((m) => [`${m.id} (${m.format})`, true]));
    expect((await calls()).map((c) => c.format)).toEqual(MODELS.map((m) => m.format));
    const rows = (await usage()).slice(before);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.process_id === null && r.step_key === 'connection-test' && r.result === 'ok' && r.output_tokens > 0)).toBe(true);
  });

  it('a wrong API key fails the test with the gateway’s reason', async () => {
    await s.api('PUT', `/platforms/${gateway}/secrets`, { apiKey: 'wrong' });
    try {
      const t = await s.api('POST', `/platforms/${gateway}/test`);
      expect(t.ok).toBe(false);
      expect(t.checks[0].message).toContain('HTTP 401: Missing or invalid API key');
    } finally {
      await s.api('PUT', `/platforms/${gateway}/secrets`, { apiKey: mock.DEMO_LLM.apiKey });
    }
  });
});

describe('the simulated gateway', () => {
  it('keeps only the latest 100 requests and shows them only with its API key', async () => {
    expect((await fetch(`${s.base}/mock/llm/_mock/calls`)).status).toBe(401);
    expect((await fetch(`${s.base}/mock/llm/_mock/reset`, { method: 'POST' })).status).toBe(401);
    for (let i = 0; i < 105; i++) {
      const res = await fetch(`${s.base}/mock/llm/v1/chat/completions`, {
        method: 'POST',
        headers: { ...mockKey(), 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'demo-chat-small', messages: [{ role: 'user', content: `question ${i}` }] }),
      });
      expect(res.status).toBe(200);
    }
    const kept = await calls();
    expect(kept).toHaveLength(100);
    expect(kept[99]!.body.messages[0].content).toBe('question 104');
  });
});

describe('asking a model in each format', () => {
  it('sends one question per format and reads the answer and the token counts each reports', async () => {
    for (const m of MODELS) {
      const proc = await makeProcess(`Ask ${m.id}`, { model: m.id, temperature: 0.1, maxOutputTokens: 200 });
      const r = await run(proc.id);
      expect([r.status, r.error], m.id).toEqual(['succeeded', null]);
      const step = await stepOf(r.id, 'ask');
      expect(step.output).toMatchObject({
        model: m.id,
        format: 'text',
        aiGenerated: true,
        marking: `AI-generated with ${m.id} – check it before you rely on it`,
        finishReason: expect.any(String),
        truncated: false,
      });
      expect(step.output.text).toContain(`Answer of ${m.id} (simulated gateway)`);
      expect(step.output.usage.inputTokens).toBeGreaterThan(0);
      expect(step.output.usage.outputTokens).toBeGreaterThan(0);
      // the estimate before the call is above what the gateway counted
      expect(step.output.usage.estimatedInputTokens).toBeGreaterThan(step.output.usage.inputTokens - 10);
      expect(step.input).toMatchObject({ model: m.id, format: m.format, system: 'You summarise monitoring data.', maxOutputTokens: 200 });
      expect(step.input.user).toContain('disk-full-on-db01');
      expect(step.summary).toMatch(new RegExp(`^${m.id.replace(/\./g, '\\.')}: \\d+ input and \\d+ output tokens`));
    }
    const sent = await calls();
    expect(sent.map((c) => c.format)).toEqual(MODELS.map((m) => m.format));
    const [chat, responses, messages, converse] = sent;
    expect(chat!.body).toMatchObject({
      model: 'demo-chat-small',
      max_tokens: 200,
      temperature: 0.1,
      stream: false,
      messages: [{ role: 'system' }, { role: 'user' }],
    });
    expect(responses!.body).toMatchObject({
      model: 'demo-responses-small',
      instructions: 'You summarise monitoring data.',
      max_output_tokens: 200,
      store: false,
    });
    expect(responses!.body.input[0].content[0].type).toBe('input_text');
    expect(messages!.headers['anthropic-version']).toBe('2023-06-01');
    expect(messages!.body).toMatchObject({ model: 'demo-messages-small', max_tokens: 200, system: 'You summarise monitoring data.' });
    expect(converse!.path).toBe('/llm/v1/bedrock/model/demo.converse-small-v1%3A0/invoke');
    expect(converse!.body).toMatchObject({
      inferenceConfig: { maxTokens: 200, temperature: 0.1 },
      messages: [{ role: 'user', content: [{ text: expect.any(String) }] }],
    });

    // one usage entry per call, without the content; the price of the model makes a cost
    const rows = await usage("process_name LIKE 'Ask %'");
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r).toMatchObject({ platform_id: gateway, result: 'ok', reason: '' });
      expect(r.prompt_fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(r.input_fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(r)).not.toContain('disk-full-on-db01');
    }
    expect(rows[0].cost).toBeCloseTo((rows[0].input_tokens * 0.5 + rows[0].output_tokens * 1.5) / 1000, 6);
    expect(rows[1].cost).toBeNull();
  });

  it('a JSON answer is checked against the schema; an answer that is not JSON fails the step with AI_ANSWER_INVALID (error output)', async () => {
    const schema = {
      type: 'object',
      properties: {
        summary: { type: 'string', maxLength: 200 },
        risk: { enum: ['low', 'medium', 'high'] },
        hosts: { type: 'array', items: { type: 'string' } },
      },
      required: ['summary', 'risk', 'hosts'],
      additionalProperties: false,
    };
    const proc = await makeProcess(
      'JSON answer',
      { answer: 'json', schema, model: 'demo-messages-small' },
      {
        nodes: [n('show', 'log', { message: 'risk={{ vars.answer.answer.risk }}' })],
        wires: [w('ask', 'show')],
      },
    );
    const r = await run(proc.id);
    expect([r.status, r.error]).toEqual(['succeeded', null]);
    const step = await stepOf(r.id, 'ask');
    expect(step.output.answer).toEqual({ summary: expect.any(String), risk: 'low', hosts: [expect.any(String)] });
    expect(step.input.system).toContain('Answer with JSON only');
    expect(step.input.system).toContain('"additionalProperties":false');
    expect(JSON.stringify(r.logs)).toContain('risk=low');

    const bad = await makeProcess(
      'Bad JSON answer',
      { answer: 'json', schema, prompt: '[mock:bad-json] {{ data }}' },
      { nodes: [n('fallback', 'log', { message: 'handled: {{ vars.answer.error }}' })], wires: [w('ask', 'fallback', 'error')] },
    );
    const b = await run(bad.id);
    expect(b.status).toBe('succeeded');
    expect(JSON.stringify(b.logs)).toContain('handled: AI_ANSWER_INVALID: the answer is not JSON');
    const row = (await usage('process_id = ?', bad.id))[0];
    // the call was made: its tokens count
    expect(row).toMatchObject({ result: 'invalid', reason: 'AI_ANSWER_INVALID' });
    expect(row.output_tokens).toBeGreaterThan(0);
  });

  it('the gateway failing fails the step with its reason; the estimate is counted', async () => {
    const proc = await makeProcess('Gateway fails', { prompt: '[mock:error] {{ data }}' });
    const r = await run(proc.id);
    expect(r.status).toBe('failed');
    expect(r.error).toContain('AI_GATEWAY_ERROR: HTTP 500 from POST /v1/chat/completions: The simulated gateway failed on purpose');
    const row = (await usage('process_id = ?', proc.id))[0];
    expect(row).toMatchObject({ result: 'failed', reason: 'HTTP 500', output_tokens: 0 });
    expect(row.input_tokens).toBe(row.estimated_input_tokens);
  });

  it('without token counts in the answer, the estimate counts; an answer at the output limit is marked', async () => {
    const proc = await makeProcess('No usage', { prompt: '[mock:no-usage] [mock:length] {{ data }}' });
    const r = await run(proc.id);
    expect(r.status).toBe('succeeded');
    const step = await stepOf(r.id, 'ask');
    expect(step.output.truncated).toBe(true);
    expect(step.output.usage.inputTokens).toBe(step.output.usage.estimatedInputTokens);
    expect(JSON.stringify(r.logs)).toContain('ended at the output limit');
  });
});

describe('refused before anything is sent', () => {
  it('an input estimated above the limit fails the step with AI_INPUT_TOO_LARGE – no call, logged and audited', async () => {
    const proc = await makeProcess('Too large', { maxInputTokens: 20 });
    const r = await run(proc.id);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/AI_INPUT_TOO_LARGE: the input is estimated at \d+ tokens, more than the 20 allowed for one call/);
    expect(await calls()).toEqual([]);
    expect((await usage('process_id = ?', proc.id))[0]).toMatchObject({ result: 'refused', reason: 'AI_INPUT_TOO_LARGE', input_tokens: 0 });
    const a = (await auditOf('ai.call_refused')).find((e) => e.runId === r.id);
    expect(a.summary).toMatch(/AI call to demo-chat-small on "Gateway" refused \(AI_INPUT_TOO_LARGE\)/);
  });

  it('data of a platform, a dataset or the inputs the gateway may not be sent: AI_DATA_NOT_ALLOWED', async () => {
    await setAllowed({ platforms: [], datasets: [], inputs: false });
    try {
      const proc = await makeProcess('Not allowed', {});
      const r = await run(proc.id);
      expect(r.status).toBe('failed');
      expect(r.error).toContain('AI_DATA_NOT_ALLOWED: context "data" comes from the platform "Monitoring", which "Gateway" may not be sent');
      const viaSet = await makeProcess(
        'Not allowed via set',
        { context: [{ name: 'data', from: 'step', step: 'shape' }] },
        { nodes: [n('shape', 'set', { values: { rows: '{{ vars.read.body }}' } })], wires: [] },
      );
      // a set step's result counts as coming from every platform of the run
      const def = (await s.api('GET', `/processes/${viaSet.id}`)).definition;
      def.wires = [w('start', 'read'), w('read', 'shape'), w('shape', 'ask')];
      await s.api('PUT', `/processes/${viaSet.id}`, { definition: def });
      expect((await run(viaSet.id)).error).toContain('AI_DATA_NOT_ALLOWED');
      const ds = await makeProcess('Dataset not allowed', { prompt: '{{ d }}', context: [{ name: 'd', from: 'dataset', dataset: 'entra.guests' }] });
      expect((await run(ds.id)).error).toContain('AI_DATA_NOT_ALLOWED: context "d": the dataset "entra.guests" may not be sent');
      const inp = await makeProcess(
        'Input not allowed',
        { prompt: '{{ i }}', context: [{ name: 'i', from: 'input', input: 'hosts' }] },
        { inputs: [{ name: 'hosts', type: 'list' }] },
      );
      expect((await run(inp.id, { inputs: { hosts: ['db01'] } })).error).toContain('AI_DATA_NOT_ALLOWED: context "i": inputs of a run may not be sent');
      expect(await calls()).toEqual([]);
      // a context source the prompt does not use is neither read nor sent
      const unused = await makeProcess('Unused context', { prompt: 'Say hello', context: [{ name: 'data', from: 'step', step: 'read' }] });
      expect((await run(unused.id)).status).toBe('succeeded');
    } finally {
      await setAllowed({ platforms: [source], datasets: ['checkmk.*'], inputs: false });
    }
  });

  it('a model that is not set up on the gateway: AI_MODEL_UNKNOWN', async () => {
    const proc = await makeProcess('Unknown model', { model: 'other-model' });
    const r = await run(proc.id);
    expect(r.error).toContain('AI_MODEL_UNKNOWN: the model "other-model" is not set up on "Gateway"');
  });
});

describe('allowed data follows the values sent, not the step named', () => {
  let other: string;
  const read = (id: string, slot: string, saveAs: string) =>
    n(id, 'http', { connection: slot, method: 'GET', path: `/mock/test/delay?ms=1&value=from-${slot}`, saveAs });
  const ask = (context: unknown[], extra: Record<string, unknown> = {}) =>
    n('ask', 'ai', { connection: 'llm', model: 'demo-chat-small', prompt: 'Look: {{ data }}', context, saveAs: 'answer', ...extra });
  /** A process with the slots llm, src and other (or only llm) */
  const makeDef = (name: string, nodes: unknown[], wires: unknown[], extra: Record<string, unknown> = {}) =>
    s.api('POST', '/processes', {
      definition: {
        name,
        connections: [
          { slot: 'llm', kind: LLM_GATEWAY_KIND },
          { slot: 'src', kind: 'generic' },
          { slot: 'other', kind: 'generic' },
        ],
        inputs: [],
        nodes: [n('start', 'start'), ...nodes],
        wires,
        ...extra,
      },
    });
  const runAll = async (processId: string, opts: Record<string, unknown> = {}) => {
    const { id } = await s.api('POST', '/runs', { processId, bindings: { llm: gateway, src: source, other }, ...opts });
    return s.waitRun(id, DONE);
  };

  beforeAll(async () => {
    const p = await s.api('POST', '/platforms', {
      name: 'Archive',
      kind: 'generic',
      baseUrl: s.base,
      config: { auth: { type: 'bearer' }, variables: {}, http: { proxy: 'none' } },
      secrets: { token: 'archive-token-0123456789' },
    });
    other = p.id;
  });
  afterAll(async () => {
    await setAllowed({ platforms: [source], datasets: ['checkmk.*'], inputs: false });
  });

  it('a variable another step also writes: refused when saved; at run time the data of every writer counts', async () => {
    const nodes = (second: string) => [
      read('read', 'src', 'data'),
      read('read2', 'other', second),
      ask([{ name: 'data', from: 'step', step: 'read', path: 'body' }]),
    ];
    const wires = [w('start', 'read'), w('read', 'read2'), w('read2', 'ask')];
    await expect(makeDef('Overwritten', nodes('data'), wires)).rejects.toMatchObject({
      status: 400,
      body: {
        issues: [
          { code: 'aiContextOverwritten', message: 'Context "data": the variable "data" is also written by step "read2" – give the result its own name' },
        ],
      },
    });
    // saved with its own name, then changed behind the validation (a definition saved before the rule)
    const proc = await makeDef('Overwritten later', nodes('data2'), wires);
    const d = await db();
    const row = d.get<{ definition: string }>('SELECT definition FROM process_versions WHERE process_id = ?', proc.id)!;
    const def = JSON.parse(row.definition);
    def.nodes.find((x: any) => x.id === 'read2').saveAs = 'data';
    d.run('UPDATE process_versions SET definition = ? WHERE process_id = ?', JSON.stringify(def), proc.id);
    const r = await runAll(proc.id);
    expect(r.error).toContain('AI_DATA_NOT_ALLOWED: context "data" comes from the platform "Archive", which "Gateway" may not be sent');
    expect(await calls()).toEqual([]);
    await setAllowed({ platforms: [source, other], datasets: [], inputs: false });
    const ok = await runAll(proc.id);
    expect(ok.status).toBe('succeeded');
    expect((await stepOf(ok.id, 'ask')).input.user).toContain('from-other');
    await setAllowed({ platforms: [source], datasets: ['checkmk.*'], inputs: false });
  });

  it('a set step computed from the inputs or from datasets carries them: inputs and dataset rules apply', async () => {
    const viaSet = (name: string, value: string) =>
      s.api('POST', '/processes', {
        definition: {
          name,
          connections: [{ slot: 'llm', kind: LLM_GATEWAY_KIND }],
          inputs: [{ name: 'customerList', type: 'list' }],
          nodes: [n('start', 'start'), n('shape', 'set', { values: { x: value } }), ask([{ name: 'data', from: 'step', step: 'shape' }])],
          wires: [w('start', 'shape'), w('shape', 'ask')],
        },
      });
    const go = async (id: string) => {
      const { id: runId } = await s.api('POST', '/runs', { processId: id, bindings: { llm: gateway }, inputs: { customerList: ['ACME Corp'] } });
      return s.waitRun(runId, DONE);
    };
    const proc = await viaSet('Inputs via set', '{{ inputs.customerList }}');
    expect((await go(proc.id)).error).toContain('AI_DATA_NOT_ALLOWED: context "data" may carry inputs of the run, which may not be sent to "Gateway"');
    const trend = await viaSet('Dataset via set', "{{ $trend('entra.guests/count', '7d') }}");
    await setAllowed({ platforms: [], datasets: ['checkmk.*'], inputs: true });
    expect((await go(trend.id)).error).toContain('AI_DATA_NOT_ALLOWED: context "data" may carry data of the dataset "entra.guests"');
    const systems = await viaSet('Systems via set', '{{ $count($systems()) }}');
    expect((await go(systems.id)).error).toContain('AI_DATA_NOT_ALLOWED: context "data" may carry data of every dataset');
    expect(await calls()).toEqual([]);
    // allowed: the inputs, and the datasets
    const ok = await go(proc.id);
    expect(ok.status).toBe('succeeded');
    expect((await stepOf(ok.id, 'ask')).input.user).toContain('ACME Corp');
    await setAllowed({ platforms: [], datasets: ['entra.*'], inputs: true });
    expect((await go(trend.id)).status).toBe('succeeded');
    await setAllowed({ platforms: [source], datasets: ['checkmk.*'], inputs: false });
  });

  it('the inputs of a sub-process run carry the data of its parent run', async () => {
    const child = await s.api('POST', '/processes', {
      definition: {
        name: 'AI child',
        connections: [{ slot: 'llm', kind: LLM_GATEWAY_KIND }],
        inputs: [{ name: 'rows', type: 'json' }],
        nodes: [n('start', 'start'), ask([{ name: 'data', from: 'input', input: 'rows' }])],
        wires: [w('start', 'ask')],
      },
    });
    const parent = await makeDef(
      'AI parent',
      [read('read2', 'other', 'archived'), n('sub', 'subprocess', { process: child.id, inputs: { rows: '{{ vars.archived.body }}' } })],
      [w('start', 'read2'), w('read2', 'sub')],
    );
    await setAllowed({ platforms: [source], datasets: [], inputs: true });
    const r = await runAll(parent.id);
    expect(r.status).toBe('failed');
    expect(r.error).toContain('AI_DATA_NOT_ALLOWED: context "data" comes from the platform "Archive"');
    await setAllowed({ platforms: [source, other], datasets: [], inputs: true });
    expect((await runAll(parent.id)).status).toBe('succeeded');
    await setAllowed({ platforms: [source], datasets: ['checkmk.*'], inputs: false });
  });

  it('a resumed run replays its finished steps and knows again where their values come from', async () => {
    // "other" is bound but not read: the value of "data" comes from "Monitoring" alone
    const proc = await makeDef(
      'Resumed',
      [read('read', 'src', 'data'), ask([{ name: 'data', from: 'step', step: 'read', path: 'body' }])],
      [w('start', 'read'), w('read', 'ask')],
    );
    await setAllowed({ platforms: [], datasets: [], inputs: false });
    const first = await runAll(proc.id);
    expect(first.error).toContain('comes from the platform "Monitoring"');
    const readBefore = await stepOf(first.id, 'read');
    // as after a restart: the run resumes from its journal, the read is not repeated
    await setAllowed({ platforms: [source], datasets: [], inputs: false });
    (await db()).run("UPDATE runs SET status = 'interrupted', finished_at = NULL, error = NULL WHERE id = ?", first.id);
    await s.api('POST', `/runs/${first.id}/resume`);
    const resumed = await s.waitRun(first.id, DONE);
    expect([resumed.status, resumed.error]).toEqual(['succeeded', null]);
    expect((await stepOf(first.id, 'read')).startedAt).toBe(readBefore.startedAt);
    await setAllowed({ platforms: [source], datasets: ['checkmk.*'], inputs: false });
  });
});

describe('secrets never leave', () => {
  it('platform credentials and secret-looking values are removed from the context before sending', async () => {
    const proc = await makeProcess(
      'Secrets',
      { context: [{ name: 'data', from: 'step', step: 'read' }] },
      {
        nodes: [],
        wires: [],
      },
    );
    // the source answers with its own credential and a password in the data
    const def = (await s.api('GET', `/processes/${proc.id}`)).definition;
    def.nodes.find((x: any) => x.id === 'read').path = '/mock/test/delay?ms=1&value=token%20source-token-0123456789%20password%3Dhunter2hunter2';
    await s.api('PUT', `/processes/${proc.id}`, { definition: def });
    const r = await run(proc.id);
    expect(r.status).toBe('succeeded');
    const body = JSON.stringify((await calls())[0]!.body);
    expect(body).not.toContain('source-token-0123456789');
    expect(body).not.toContain('hunter2hunter2');
    expect(body).toContain('[removed]');
    expect(JSON.stringify(r.logs)).toMatch(/\d+ secret-looking value\(s\) removed from the context before sending/);
    expect((await stepOf(r.id, 'ask')).output.removedSecrets).toBeGreaterThanOrEqual(1);
  });
});

describe('dry runs and test runs never call the model', () => {
  it('a dry run uses the sample answer (or says the model was not asked); a test run a recorded response', async () => {
    const proc = await makeProcess('Dry', { sampleAnswer: 'Sample: disk of db01 grows.' });
    const dry = await run(proc.id, { dryRun: true });
    expect(dry.status).toBe('succeeded');
    const step = await stepOf(dry.id, 'ask');
    expect(step.status).toBe('dryrun');
    expect(step.output).toMatchObject({ text: 'Sample: disk of db01 grows.', dryRun: true, sample: true });
    const plain = await makeProcess('Dry without sample', {});
    expect((await stepOf((await run(plain.id, { dryRun: true })).id, 'ask')).output.text).toBe('[Dry run: demo-chat-small was not asked]');
    expect(await calls()).toEqual([]);
    expect(await usage('process_id IN (?, ?)', proc.id, plain.id)).toEqual([]);

    // a test run: the recorded answer of the gateway, parsed in the model's format; the source too
    await s.api('POST', `/platforms/${source}/recordings`, { method: 'GET', path: '/mock/test/delay', status: 200, body: { value: 'recorded' } });
    const recorded = {
      choices: [{ message: { role: 'assistant', content: 'Recorded answer' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    };
    await s.api('POST', `/platforms/${gateway}/recordings`, { method: 'POST', path: '/v1/chat/completions', status: 200, body: recorded });
    const test = await run(plain.id, { recorded: true });
    expect([test.status, test.error]).toEqual(['succeeded', null]);
    expect((await stepOf(test.id, 'ask')).output).toMatchObject({ text: 'Recorded answer', recorded: true, usage: { inputTokens: 5, outputTokens: 2 } });
    expect(await calls()).toEqual([]);
  });

  it('dry runs still refuse what a real run would refuse (input size, allowed data)', async () => {
    const proc = await makeProcess('Dry too large', { maxInputTokens: 10 });
    const r = await run(proc.id, { dryRun: true });
    expect(r.error).toContain('AI_INPUT_TOO_LARGE');
    // nothing was sent, so nothing is logged
    expect(await usage('process_id = ?', proc.id)).toEqual([]);
  });
});

describe('AI-generated text is marked', () => {
  it('a report that carries the answer says so and names the model', async () => {
    const proc = await makeProcess(
      'Marked report',
      {},
      {
        nodes: [n('report', 'report', { title: 'Morning summary', text: '{{ vars.answer.text }}' })],
        wires: [w('ask', 'report')],
      },
    );
    const r = await run(proc.id);
    expect(r.status).toBe('succeeded');
    const rep = await stepOf(r.id, 'report');
    expect(rep.output.aiGenerated).toEqual({ models: ['demo-chat-small'] });
    expect(rep.summary).toContain('AI-generated (demo-chat-small)');
  });
});

describe('budgets', () => {
  const budget = (body: Record<string, unknown>) => s.api('PUT', '/ai/budgets', body);
  afterAll(async () => {
    for (const [scope, scopeId] of [
      ['installation', ''],
      ['platform', gateway],
    ])
      await budget({ scope, scopeId, tokensPerDay: null, tokensPerMonth: null });
  });

  it('a call whose worst case does not fit is refused with AI_BUDGET_EXHAUSTED; the 80 % notice goes out once', async () => {
    const proc = await makeProcess('Budgeted', { maxOutputTokens: 30 });
    const first = await run(proc.id);
    expect(first.status).toBe('succeeded');
    const spent = (await usage('process_id = ?', proc.id)).reduce((t, r) => t + r.input_tokens + r.output_tokens, 0);
    // what is left fits one more call (80 % reached), not two
    const per = spent;
    const est = (await stepOf(first.id, 'ask')).output.usage.estimatedInputTokens;
    const limit = per + est + 30 + 5;
    // (the numbers of the simulated gateway: two calls reach 80 %, a third does not fit)
    expect(2 * per * 100).toBeGreaterThanOrEqual(80 * limit);
    await budget({ scope: 'process', scopeId: proc.id, tokensPerDay: null, tokensPerMonth: limit });
    const second = await run(proc.id);
    expect(second.status).toBe('succeeded');
    const third = await run(proc.id);
    expect(third.status).toBe('failed');
    expect(third.error).toMatch(
      /^Step "ask" failed: AI_BUDGET_EXHAUSTED: the monthly AI budget of process "Budgeted" \(.+ tokens\) has .+ left; this call may need/,
    );
    const rows = await usage('process_id = ?', proc.id);
    expect(rows.map((r) => r.result)).toEqual(['ok', 'ok', 'refused']);
    expect(rows[2]).toMatchObject({ reason: 'AI_BUDGET_EXHAUSTED', input_tokens: 0, output_tokens: 0 });
    // the refusal is audited, and the notices went out once each
    expect((await auditOf('ai.call_refused')).some((e) => e.runId === third.id && /AI_BUDGET_EXHAUSTED/.test(e.summary))).toBe(true);
    const notes = await (await db()).all<any>("SELECT * FROM ai_budget_notices WHERE scope = 'process' AND scope_id = ?", proc.id);
    expect(notes.map((x) => x.level).sort()).toEqual([80]);
    const inApp = await s.api('GET', '/notifications');
    expect(inApp.items.some((x: any) => x.event === 'ai.budget' && x.title === 'AI budget at 80 %: Process “Budgeted”')).toBe(true);
    await budget({ scope: 'process', scopeId: proc.id, tokensPerDay: null, tokensPerMonth: null });
  });

  it("a process's budget covers its sub-processes: a child run's calls count against the parent too", async () => {
    const child = await s.api('POST', '/processes', {
      definition: {
        name: 'Budget child',
        connections: [{ slot: 'llm', kind: LLM_GATEWAY_KIND }],
        nodes: [
          n('start', 'start'),
          n('ask', 'ai', { connection: 'llm', model: 'demo-chat-small', prompt: 'Say hello', maxOutputTokens: 30, saveAs: 'answer' }),
        ],
        wires: [w('start', 'ask')],
      },
    });
    const parent = await s.api('POST', '/processes', {
      definition: {
        name: 'Budget parent',
        connections: [{ slot: 'llm', kind: LLM_GATEWAY_KIND }],
        nodes: [n('start', 'start'), n('sub', 'subprocess', { process: child.id })],
        wires: [w('start', 'sub')],
      },
    });
    const go = async () => {
      const { id } = await s.api('POST', '/runs', { processId: parent.id, bindings: { llm: gateway } });
      return s.waitRun(id, DONE);
    };
    expect((await go()).status).toBe('succeeded');
    const rows = await usage('process_id = ?', child.id);
    expect(rows[0].parent_process_ids).toBe(`,${parent.id},`);
    const spent = rows[0].input_tokens + rows[0].output_tokens;
    // what the child used is used up of the parent's budget
    await budget({ scope: 'process', scopeId: parent.id, tokensPerDay: spent + 10, tokensPerMonth: null });
    const refused = await go();
    expect(refused.status).toBe('failed');
    expect(refused.error).toMatch(/AI_BUDGET_EXHAUSTED: the daily AI budget of process "Budget parent" \(.+ tokens\) has .+ left/);
    // the budget page counts the child's calls for the parent
    expect((await s.api('GET', '/ai/budgets')).budgets.find((b: any) => b.scope === 'process' && b.scopeId === parent.id)).toMatchObject({ usedToday: spent });
    await budget({ scope: 'process', scopeId: parent.id, tokensPerDay: null, tokensPerMonth: null });
  });

  it('the installation and the gateway have budgets too; a used-up one is shown as exhausted', async () => {
    const used = (await s.api('GET', `/platforms/${gateway}/ai/usage`)).budgets[1].usedToday;
    await budget({ scope: 'platform', scopeId: gateway, tokensPerDay: used, tokensPerMonth: null });
    const proc = await makeProcess('Gateway budget', {});
    const r = await run(proc.id);
    expect(r.error).toContain('AI_BUDGET_EXHAUSTED: the daily AI budget of platform "Gateway"');
    const o = await s.api('GET', `/platforms/${gateway}/ai/usage`);
    expect(o.budgets[1]).toMatchObject({ scope: 'platform', name: 'Gateway', tokensPerDay: used, state: 'exhausted' });
    // the 100 % notice of the gateway's day
    const notes = await (await db()).all<any>("SELECT level FROM ai_budget_notices WHERE scope = 'platform' AND scope_id = ?", gateway);
    expect(notes.map((x) => x.level)).toContain(100);
    const inApp = await s.api('GET', '/notifications');
    expect(inApp.items.some((x: any) => x.event === 'ai.budget' && x.title === 'AI budget used up: Gateway “Gateway”')).toBe(true);
    // the connection test does not ask a model that has no budget left
    const t = await s.api('POST', `/platforms/${gateway}/test`);
    expect(t.checks[1].message).toMatch(/^not asked: the daily AI budget/);
    await budget({ scope: 'platform', scopeId: gateway, tokensPerDay: null, tokensPerMonth: null });
    await budget({ scope: 'installation', scopeId: '', tokensPerDay: 1, tokensPerMonth: null });
    expect((await run(proc.id)).error).toContain('AI_BUDGET_EXHAUSTED: the daily AI budget of the installation');
    await budget({ scope: 'installation', scopeId: '', tokensPerDay: null, tokensPerMonth: null });
    expect((await run(proc.id)).status).toBe('succeeded');
  });

  it('a new day or month starts from nothing', async () => {
    const { budgetUse, budgetRefusal } = await import('../src/ai/usage.js');
    const now = new Date().toISOString();
    const d = await db();
    d.run(
      `INSERT INTO ai_usage (id, ts, day, month, platform_id, platform_name, model, format, input_tokens, output_tokens, result)
       VALUES ('aiu_old', '2020-01-31T23:59:00.000Z', '2020-01-31', '2020-01', ?, 'Gateway', 'demo-chat-small', 'chat-completions', 900, 100, 'ok')`,
      gateway,
    );
    const { setBudget } = await import('../src/ai/usage.js');
    const { runAs } = await import('../src/auth/context.js');
    const { findUserByName, toAuthUser } = await import('../src/auth/users.js');
    runAs(toAuthUser(findUserByName('admin')!), () => setBudget({ scope: 'platform', scopeId: gateway, tokensPerDay: 1000, tokensPerMonth: 1000 }));
    try {
      // on that day the budget was full; the next day and the next month it is not
      expect(budgetUse('platform', gateway, '2020-01-31T23:59:30.000Z')).toMatchObject({ usedToday: 1000, usedThisMonth: 1000, state: 'exhausted' });
      expect(budgetRefusal({ platformId: gateway, processId: null }, 1, '2020-01-31T23:59:30.000Z')).toMatchObject({ period: 'day', limit: 1000, used: 1000 });
      expect(budgetUse('platform', gateway, '2020-02-01T00:00:01.000Z')).toMatchObject({ usedToday: 0, usedThisMonth: 0, state: 'ok' });
      expect(budgetRefusal({ platformId: gateway, processId: null }, 999, '2020-02-01T00:00:01.000Z')).toBeNull();
      expect(budgetUse('platform', gateway, now).usedToday).toBeGreaterThan(0);
    } finally {
      d.run("DELETE FROM ai_usage WHERE id = 'aiu_old'");
      await budget({ scope: 'platform', scopeId: gateway, tokensPerDay: null, tokensPerMonth: null });
    }
  });

  it('raising a budget needs a step-up and is audited; lowering one does not need it', async () => {
    const c = await s.as(ADMIN.username, ADMIN.password, { autoStepUp: false });
    await c('DELETE', '/auth/step-up').catch(() => undefined);
    // a new limit lowers "no limit": no confirmation
    expect(await c('PUT', '/ai/budgets', { scope: 'installation', scopeId: '', tokensPerDay: 1000, tokensPerMonth: null })).toMatchObject({
      tokensPerDay: 1000,
    });
    expect(await c('PUT', '/ai/budgets', { scope: 'installation', scopeId: '', tokensPerDay: 500, tokensPerMonth: null })).toMatchObject({ tokensPerDay: 500 });
    await expect(c('PUT', '/ai/budgets', { scope: 'installation', scopeId: '', tokensPerDay: 5000, tokensPerMonth: null })).rejects.toMatchObject({
      status: 403,
      body: { code: 'STEP_UP_REQUIRED', stepUp: { action: 'changeAiBudget' } },
    });
    // removing a limit is a raise too
    await expect(c('PUT', '/ai/budgets', { scope: 'installation', scopeId: '', tokensPerDay: null, tokensPerMonth: null })).rejects.toMatchObject({
      status: 403,
    });
    // the admin client of the suite confirms with its password
    await budget({ scope: 'installation', scopeId: '', tokensPerDay: 5000, tokensPerMonth: null, comment: 'quarter end' });
    const a = (await auditOf('ai.budget_changed'))[0];
    expect(a.summary).toBe('AI budget of the installation raised: 5,000 tokens a day, no limit a month (was 500 / no limit)');
    expect(a.details).toMatchObject({ raised: true, comment: 'quarter end', before: { tokensPerDay: 500 }, after: { tokensPerDay: 5000 } });
    expect(a.details.assurance?.[0]).toMatchObject({ point: 'ai.budget', stepUp: { method: 'password' } });
    await budget({ scope: 'installation', scopeId: '', tokensPerDay: null, tokensPerMonth: null });
    // the control point is in the assurance policy, on by default
    const policy = await s.api('GET', '/assurance/policy');
    expect(JSON.stringify(policy)).toContain('ai.budget');
  });

  it('only administrators set budgets; a budget names an existing platform or process', async () => {
    await expect(budget({ scope: 'process', scopeId: 'prc_nope', tokensPerDay: 1, tokensPerMonth: null })).rejects.toMatchObject({ status: 404 });
    await expect(budget({ scope: 'installation', scopeId: 'x', tokensPerDay: 1, tokensPerMonth: null })).rejects.toMatchObject({ status: 400 });
    const { temporaryPassword } = await s.api('POST', '/users', { username: 'dana-ai', roles: ['designer'] });
    await (
      await s.as('dana-ai', temporaryPassword)
    )('POST', '/auth/password', { current: temporaryPassword, next: 'Dana-password-123' });
    const dana = await s.as('dana-ai', 'Dana-password-123');
    await expect(dana('PUT', '/ai/budgets', { scope: 'installation', scopeId: '', tokensPerDay: 1, tokensPerMonth: null })).rejects.toMatchObject({
      status: 403,
    });
    await expect(dana('GET', '/ai/budgets')).rejects.toMatchObject({ status: 403 });
    await expect(dana('PUT', `/platforms/${gateway}/ai`, { models: [] })).rejects.toMatchObject({ status: 403 });
    // designers use platforms: they see the usage of the gateway, without the names of processes they may not view
    const hidden = (await db()).get<{ process_id: string }>("SELECT process_id FROM ai_usage WHERE process_name = 'Budgeted' LIMIT 1")!.process_id;
    await s.api('PUT', `/processes/${hidden}/access`, { acl: [{ subject: 'user:admin', permissions: ['view', 'run', 'edit', 'manage'] }] });
    const o = await dana('GET', `/platforms/${gateway}/ai/usage`);
    expect(o.canEditBudgets).toBe(false);
    expect(o.topProcesses.map((p: any) => p.name)).not.toContain('Budgeted');
    expect(o.topProcesses.map((p: any) => p.name)).toContain('Other processes');
    expect(o.topProcesses.map((p: any) => p.name)).toContain('JSON answer');
    expect(o.recent.some((e: any) => e.processName === 'Budgeted' || e.processId === hidden)).toBe(false);
    await s.api('PUT', `/processes/${hidden}/access`, { acl: [] });
  });
});

describe('reporting', () => {
  it('the platform page: budgets, totals of today and this month, top processes, models, the latest calls', async () => {
    const o = await s.api('GET', `/platforms/${gateway}/ai/usage`);
    expect(o.budgets.map((b: any) => b.scope)).toEqual(['installation', 'platform']);
    expect(o.today.calls).toBeGreaterThan(5);
    expect(o.today.refused).toBeGreaterThan(0);
    expect(o.thisMonth.inputTokens).toBeGreaterThan(0);
    expect(o.topProcesses.length).toBeGreaterThan(1);
    expect(o.topProcesses.some((p: any) => p.name === 'Connection tests')).toBe(true);
    expect(o.byModel.map((m: any) => m.model)).toEqual(expect.arrayContaining(MODELS.map((m) => m.id)));
    expect(o.byModel.find((m: any) => m.model === 'demo-chat-small').cost).toBeGreaterThan(0);
    expect(o.recent[0]).toMatchObject({ platformId: gateway, platformName: 'Gateway' });
    expect(o.canEditBudgets).toBe(true);
    // every platform has a (possibly empty) overview
    expect((await s.api('GET', `/platforms/${source}/ai/usage`)).today.calls).toBe(0);
  });

  it('the usage log for administrators and auditors, filtered', async () => {
    const r = await s.api('GET', `/ai/usage?platformId=${gateway}&limit=5`);
    expect(r.entries).toHaveLength(5);
    expect(Object.keys(r.entries[0])).toEqual(
      expect.arrayContaining(['model', 'format', 'inputTokens', 'outputTokens', 'durationMs', 'result', 'promptFingerprint', 'inputFingerprint']),
    );
    expect(JSON.stringify(r.entries)).not.toContain('disk-full-on-db01');
  });

  it('the built-in dataset "AI usage": rows per gateway, model and process, metrics with the budgets as limits – for administrators and auditors', async () => {
    const { runAs } = await import('../src/auth/context.js');
    const { findUserByName, toAuthUser } = await import('../src/auth/users.js');
    const admin = toAuthUser(findUserByName('admin')!);
    runAs(admin, () =>
      import('../src/ai/usage.js').then((m) => m.setBudget({ scope: 'installation', scopeId: '', tokensPerDay: null, tokensPerMonth: 10_000_000 })),
    );
    await new Promise((r) => setTimeout(r, 20));
    const { publishUsageDataset } = await import('../src/ai/dataset.js');
    expect(publishUsageDataset(true)).toBe(true);
    const d = await s.api('GET', `/datasets/${AI_USAGE_DATASET}`);
    expect(d).toMatchObject({ title: 'AI usage', processId: 'ai:usage' });
    expect(d.columns).toEqual(['Gateway', 'Model', 'Process', 'Calls', 'Refused', 'Failed', 'Input tokens', 'Output tokens', 'Tokens', 'Cost']);
    expect(d.rows.some((r: any) => r.Gateway === 'Gateway' && r.Model === 'demo-chat-small' && r.Process === 'Budgeted' && r._status === 'serious')).toBe(true);
    expect(d.metrics.tokensThisMonth).toBeGreaterThan(0);
    expect(d.limits.tokensThisMonth).toEqual({ value: 10_000_000, lower: false });
    const dana = await s.as('dana-ai', 'Dana-password-123');
    await expect(dana('GET', `/datasets/${AI_USAGE_DATASET}`)).rejects.toMatchObject({ status: 404 });
    runAs(admin, () => import('../src/ai/usage.js').then((m) => m.setBudget({ scope: 'installation', scopeId: '', tokensPerDay: null, tokensPerMonth: null })));
  });

  it('the report section "AI usage" for report schedules', async () => {
    const { reportSection } = await import('../src/reports/sections.js');
    await import('../src/ai/report-section.js');
    const def = reportSection('ai')!;
    const { runAs } = await import('../src/auth/context.js');
    const { findUserByName, toAuthUser } = await import('../src/auth/users.js');
    const now = Date.now();
    const data = runAs(toAuthUser(findUserByName('admin')!), () =>
      def.build(def.schema.parse({}), { from: now - 86400_000, to: now + 60_000, now, lang: 'en' }),
    ) as any;
    expect(data.allowed).toBe(true);
    expect(data.totals.calls).toBeGreaterThan(5);
    expect(data.byModel.map((m: any) => m.model)).toEqual(expect.arrayContaining(MODELS.map((m) => m.id)));
    expect(data.refused.some((r: any) => r.reason === 'AI_BUDGET_EXHAUSTED')).toBe(true);
    const viewer = runAs(toAuthUser(findUserByName('dana-ai')!), () => def.build(def.schema.parse({}), { from: 0, to: now, now, lang: 'en' })) as any;
    expect(viewer.allowed).toBe(false);
    // a monthly schedule with the section is accepted
    const sched = await s.api('POST', '/report-schedules', {
      name: 'Monthly AI usage',
      preset: 'monthly',
      sections: { ai: { platformIds: [gateway] } },
      recipients: { users: [], teams: [], emails: [] },
    });
    expect(sched.sections.ai).toEqual({ platformIds: [gateway] });
    await expect(
      s.api('POST', '/report-schedules', {
        name: 'x',
        preset: 'monthly',
        sections: { ai: { platformIds: [source] } },
        recipients: { users: [], teams: [], emails: [] },
      }),
    ).rejects.toMatchObject({
      status: 400,
    });
  });
});
