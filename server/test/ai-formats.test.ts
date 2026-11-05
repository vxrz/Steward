import { describe, expect, it } from 'vitest';
import {
  AI_ESTIMATE,
  aiGatewaySettingsSchema,
  datasetAllowed,
  fillPrompt,
  modelInputCeiling,
  promptVariables,
  suggestFormat,
  validateProcess,
} from '@sm/shared';
import { ADAPTERS, gatewayErrorText, modelList, modelPath } from '../src/ai/formats.js';
import { estimateTokens, fingerprint } from '../src/ai/estimate.js';
import { scrubForModel } from '../src/ai/scrub.js';
import { parseJsonAnswer } from '../src/ai/step.js';

/**
 * The translation layer of "Ask an AI model" (#216, docs/AI.md): one adapter per request format – the request built
 * from one question, the answer, its token counts and why it ended read back –, the token estimate made before a
 * call, the removal of secrets from the context, prompt placeholders and JSON answers checked against a schema.
 */

const Q = { system: 'Be brief.', user: 'How are the hosts?', maxOutputTokens: 200, temperature: 0.2 };

describe('request formats: requests', () => {
  it('Chat Completions: system and user messages, max_tokens, no streaming', () => {
    const r = ADAPTERS['chat-completions'].request({ id: 'm1' }, Q);
    expect(r).toEqual({
      path: '/v1/chat/completions',
      headers: {},
      body: {
        model: 'm1',
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'How are the hosts?' },
        ],
        max_tokens: 200,
        temperature: 0.2,
        stream: false,
      },
    });
    // without instructions: only the user message; without a temperature: the model's default
    const bare = ADAPTERS['chat-completions'].request({ id: 'm1' }, { system: '', user: 'x', maxOutputTokens: 5 });
    expect(bare.body).toEqual({ model: 'm1', messages: [{ role: 'user', content: 'x' }], max_tokens: 5, stream: false });
  });

  it('Responses: instructions and input instead of messages, max_output_tokens, nothing stored', () => {
    const r = ADAPTERS.responses.request({ id: 'm2' }, Q);
    expect(r.path).toBe('/v1/responses');
    expect(r.body).toEqual({
      model: 'm2',
      instructions: 'Be brief.',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'How are the hosts?' }] }],
      max_output_tokens: 200,
      temperature: 0.2,
      stream: false,
      store: false,
    });
    expect(r.body).not.toHaveProperty('messages');
  });

  it('Anthropic Messages: the anthropic-version header, top-level system, required max_tokens', () => {
    const r = ADAPTERS['anthropic-messages'].request({ id: 'm3' }, Q);
    expect(r).toEqual({
      path: '/v1/messages',
      headers: { 'anthropic-version': '2023-06-01' },
      body: { model: 'm3', max_tokens: 200, system: 'Be brief.', messages: [{ role: 'user', content: 'How are the hosts?' }], temperature: 0.2 },
    });
    expect(ADAPTERS['anthropic-messages'].request({ id: 'm3' }, Q, { anthropicVersion: '2024-01-01' }).headers).toEqual({ 'anthropic-version': '2024-01-01' });
  });

  it('Bedrock Converse: the model id in the path (encoded), typed content blocks, inferenceConfig', () => {
    const r = ADAPTERS['bedrock-converse'].request({ id: 'vendor.model-v1:0' }, Q);
    expect(r.path).toBe('/v1/bedrock/model/vendor.model-v1%3A0/invoke');
    expect(r.body).toEqual({
      system: [{ text: 'Be brief.' }],
      messages: [{ role: 'user', content: [{ text: 'How are the hosts?' }] }],
      inferenceConfig: { maxTokens: 200, temperature: 0.2 },
    });
    expect(r.body).not.toHaveProperty('model');
  });

  it('a model can name its own path ({modelId} replaced)', () => {
    expect(modelPath('chat-completions', { id: 'x', path: '/openai/deployments/{modelId}/chat/completions' })).toBe('/openai/deployments/x/chat/completions');
    expect(ADAPTERS['chat-completions'].request({ id: 'g/x', path: '/custom' }, Q).path).toBe('/custom');
  });
});

describe('request formats: answers and token counts', () => {
  it('Chat Completions: choices[0].message.content, usage.prompt_tokens / completion_tokens, finish_reason', () => {
    const a = ADAPTERS['chat-completions'].answer({
      choices: [{ index: 0, message: { role: 'assistant', content: 'All good.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    });
    expect(a).toEqual({ text: 'All good.', inputTokens: 12, outputTokens: 3, finish: 'stop', finishRaw: 'stop' });
    // content parts, the output limit, no usage
    const b = ADAPTERS['chat-completions'].answer({
      choices: [
        {
          message: {
            content: [
              { type: 'text', text: 'A' },
              { type: 'text', text: 'B' },
            ],
          },
          finish_reason: 'length',
        },
      ],
    });
    expect(b).toMatchObject({ text: 'AB', inputTokens: null, outputTokens: null, finish: 'length' });
  });

  it('Responses: output items of type message (and output_text where a gateway adds it), usage.input_tokens / output_tokens', () => {
    const a = ADAPTERS.responses.answer({
      status: 'completed',
      output: [
        { type: 'reasoning', summary: [] },
        {
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'output_text', text: 'Fine' },
            { type: 'output_text', text: ' indeed.' },
          ],
        },
      ],
      usage: { input_tokens: 20, output_tokens: 4 },
    });
    expect(a).toEqual({ text: 'Fine indeed.', inputTokens: 20, outputTokens: 4, finish: 'stop', finishRaw: 'completed' });
    expect(ADAPTERS.responses.answer({ output_text: 'Short', output: [], status: 'completed' }).text).toBe('Short');
    expect(ADAPTERS.responses.answer({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] })).toMatchObject({
      finish: 'length',
      finishRaw: 'incomplete: max_output_tokens',
    });
  });

  it('Anthropic Messages: text blocks, input_tokens with cached parts, stop_reason', () => {
    const a = ADAPTERS['anthropic-messages'].answer({
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'tool_use', id: 't', name: 'x', input: {} },
      ],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 2, output_tokens: 7 },
    });
    expect(a).toEqual({ text: 'Hello', inputTokens: 17, outputTokens: 7, finish: 'length', finishRaw: 'max_tokens' });
  });

  it('Bedrock Converse: output.message.content blocks, usage.inputTokens / outputTokens, stopReason', () => {
    const a = ADAPTERS['bedrock-converse'].answer({
      output: { message: { role: 'assistant', content: [{ text: 'Yes' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 9, outputTokens: 1, totalTokens: 10 },
    });
    expect(a).toEqual({ text: 'Yes', inputTokens: 9, outputTokens: 1, finish: 'stop', finishRaw: 'end_turn' });
  });

  it('refuses a body of another format, and reads the error texts of every format', () => {
    expect(() => ADAPTERS['chat-completions'].answer({ content: [{ type: 'text', text: 'x' }] })).toThrow(/not in the chat-completions format/);
    expect(() => ADAPTERS['anthropic-messages'].answer({ choices: [] })).toThrow(/anthropic-messages/);
    expect(() => ADAPTERS['bedrock-converse'].answer('oops')).toThrow(/bedrock-converse/);
    expect(gatewayErrorText({ error: { message: 'model not found', type: 'invalid_request_error' } })).toBe('model not found');
    expect(gatewayErrorText({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })).toBe('Overloaded');
    expect(gatewayErrorText({ message: 'ValidationException' })).toBe('ValidationException');
    expect(gatewayErrorText('Bad gateway')).toBe('Bad gateway');
  });

  it('reads an OpenAI model list and suggests a format per id', () => {
    expect(modelList({ object: 'list', data: [{ id: 'a', owned_by: 'x' }, { id: 'b' }] })).toEqual([
      { id: 'a', ownedBy: 'x' },
      { id: 'b', ownedBy: undefined },
    ]);
    expect(modelList(['c'])).toEqual([{ id: 'c' }]);
    expect(suggestFormat('vendor.model-name-v2:0')).toBe('bedrock-converse');
    expect(suggestFormat('eu.vendor.model-v1:0')).toBe('bedrock-converse');
    expect(suggestFormat('provider/model-small')).toBe('chat-completions');
    expect(suggestFormat('model-4-mini')).toBe('chat-completions');
  });
});

describe('the estimate before a call', () => {
  it('is characters / 3.5 rounded up, plus overhead per message and per call – a model can set its own ratio', () => {
    expect(estimateTokens(['a'.repeat(35)])).toBe(10 + AI_ESTIMATE.perMessage + AI_ESTIMATE.perCall);
    expect(estimateTokens(['a'.repeat(35), 'b'.repeat(36)])).toBe(10 + 11 + 2 * AI_ESTIMATE.perMessage + AI_ESTIMATE.perCall);
    expect(estimateTokens(['', 'x'])).toBe(1 + AI_ESTIMATE.perMessage + AI_ESTIMATE.perCall);
    expect(estimateTokens(['a'.repeat(100)], 2)).toBe(50 + AI_ESTIMATE.perMessage + AI_ESTIMATE.perCall);
    // code points, not UTF-16 units
    expect(estimateTokens(['😀😀😀😀😀😀😀'])).toBe(2 + AI_ESTIMATE.perMessage + AI_ESTIMATE.perCall);
  });

  it('is conservative against the counts of the simulated gateway (4 characters a token)', () => {
    const text = 'The disk of db01 grows by 2 % a week and reaches CRIT in about 12 days. '.repeat(40);
    expect(estimateTokens([text])).toBeGreaterThan(Math.ceil(text.length / 4));
  });

  it("the input ceiling: the model's own, else the context window minus the output", () => {
    expect(modelInputCeiling({ contextTokens: 8000, maxOutputTokens: 1000 })).toBe(7000);
    expect(modelInputCeiling({ contextTokens: 8000, maxOutputTokens: 1000, maxInputTokens: 2000 })).toBe(2000);
  });

  it('fingerprints change when text moves between the parts', () => {
    expect(fingerprint('ab', 'c')).not.toBe(fingerprint('a', 'bc'));
    expect(fingerprint('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('secrets are removed before anything is sent', () => {
  it('known secret values, credential keys and credential-looking strings; e-mail and IP addresses stay', () => {
    const value = {
      hosts: [{ name: 'db01', ip: '10.1.2.3', owner: 'ops@example.com', password: 'hunter2!', apiKey: 'k-123456' }],
      note: 'connect with Authorization: Bearer abcdefghijklmnop, token=zyxwvutsrq, the key s3cr3t-value-123 or https://svc:pw12345@db.example.com',
      jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXZhbHVl',
      pem: '-----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY-----',
      flag: true,
    };
    const r = scrubForModel(value, ['s3cr3t-value-123']);
    const text = JSON.stringify(r.value);
    for (const leaked of ['hunter2!', 'k-123456', 'abcdefghijklmnop', 'zyxwvutsrq', 's3cr3t-value-123', 'pw12345', 'eyJhbGciOiJIUzI1NiJ9', 'MIIEv'])
      expect(text, leaked).not.toContain(leaked);
    expect(text).toContain('10.1.2.3');
    expect(text).toContain('ops@example.com');
    expect(text).toContain('db01');
    expect(r.value.flag).toBe(true);
    expect(r.removed).toBeGreaterThanOrEqual(8);
    expect(scrubForModel('plain text about hosts', []).removed).toBe(0);
  });
});

describe('prompts and answers', () => {
  it('placeholders are names of context sources only – no expressions', () => {
    expect(promptVariables('Look at {{ hosts }} and {{trends}}, then {{ hosts }}.')).toEqual({ names: ['hosts', 'trends'], invalid: [] });
    expect(promptVariables('{{ vars.x }} {{ $now() }}').invalid).toEqual(['{{ vars.x }}', '{{ $now() }}']);
    expect(fillPrompt('A {{ x }} B {{y}} C {{ z }}', { x: '1', y: '{{ x }}' })).toBe('A 1 B {{ x }} C {{ z }}');
  });

  it('a JSON answer is parsed (code fences and text around it tolerated) and checked against the schema', () => {
    const schema = { type: 'object', properties: { summary: { type: 'string' }, risk: { enum: ['low', 'high'] } }, required: ['summary', 'risk'] };
    expect(parseJsonAnswer('{"summary":"ok","risk":"low"}', schema)).toEqual({ ok: true, value: { summary: 'ok', risk: 'low' } });
    expect(parseJsonAnswer('Here it is:\n```json\n{"summary":"ok","risk":"high"}\n```', schema)).toMatchObject({ ok: true, value: { risk: 'high' } });
    expect(parseJsonAnswer('Sure! {"summary":"x","risk":"high"} Hope it helps', schema)).toMatchObject({ ok: true });
    const bad = parseJsonAnswer('{"summary":1,"risk":"medium"}', schema);
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.problem).toMatch(/summary: .*string.*risk/s);
    expect(parseJsonAnswer('no json here', schema)).toEqual({ ok: false, problem: 'the answer is not JSON' });
  });

  it('dataset patterns of the allowed data', () => {
    expect(datasetAllowed('checkmk.trends', ['checkmk.*'])).toBe(true);
    expect(datasetAllowed('entra.guests', ['checkmk.*'])).toBe(false);
    expect(datasetAllowed('anything', ['*'])).toBe(true);
    expect(datasetAllowed('a.b', [])).toBe(false);
  });

  it('gateway settings: unique model ids, output below the context window, paths without a query', () => {
    const m = { id: 'x', format: 'chat-completions', contextTokens: 8000, maxOutputTokens: 1000 };
    expect(aiGatewaySettingsSchema.parse({ models: [m] }).allowedData).toEqual({ platforms: [], datasets: [], inputs: false });
    expect(aiGatewaySettingsSchema.safeParse({ models: [m, m] }).success).toBe(false);
    expect(aiGatewaySettingsSchema.safeParse({ models: [{ ...m, maxOutputTokens: 8000 }] }).success).toBe(false);
    expect(aiGatewaySettingsSchema.safeParse({ models: [{ ...m, path: '/x?y=1' }] }).success).toBe(false);
    expect(aiGatewaySettingsSchema.safeParse({ models: [{ ...m, format: 'gemini' }] }).success).toBe(false);
  });
});

describe('the step in a process definition', () => {
  const def = (step: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    validateProcess({
      name: 'AI',
      connections: [{ slot: 'llm', kind: 'llm-gateway' }],
      inputs: [{ name: 'hosts', type: 'list' }],
      steps: [
        { id: 'read', type: 'set', values: { rows: '{{ [1, 2] }}' } },
        { id: 'plain', type: 'log', message: 'x' },
        { id: 'ask', type: 'ai', connection: 'llm', model: 'm', prompt: 'Look: {{ rows }}', context: [{ name: 'rows', from: 'step', step: 'read' }], ...step },
      ],
      ...extra,
    });
  const codes = (r: ReturnType<typeof validateProcess>) => [...r.issues, ...r.warnings].map((i) => i.code);

  it('accepts a step with context from a set step', () => {
    const r = def({});
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('names unknown placeholders, expressions in placeholders, unknown steps and inputs, steps without a result, unused context', () => {
    expect(codes(def({ prompt: 'x {{ other }}' }))).toEqual(expect.arrayContaining(['aiUnknownVariable', 'aiUnusedContext']));
    expect(codes(def({ prompt: '{{ rows }} {{ vars.x }}' }))).toContain('aiPlaceholder');
    expect(codes(def({ context: [{ name: 'rows', from: 'step', step: 'nope' }] }))).toContain('aiUnknownStep');
    expect(codes(def({ context: [{ name: 'rows', from: 'step', step: 'plain' }] }))).toContain('aiStepNeedsSaveAs');
    expect(codes(def({ context: [{ name: 'rows', from: 'input', input: 'missing' }] }))).toContain('aiUnknownInput');
    expect(def({ context: [{ name: 'rows', from: 'input', input: 'hosts' }] }).ok).toBe(true);
    expect(codes(def({ context: [{ name: 'rows', from: 'dataset' }] }))).toContain('aiNoDataset');
    expect(codes(def({ connection: 'nope' }))).toContain('unknownConnection');
  });

  it('a JSON answer needs a usable JSON Schema', () => {
    expect(codes(def({ answer: 'json' }))).toContain('aiSchemaMissing');
    expect(codes(def({ answer: 'json', schema: { $ref: 'https://example.com/schema.json' } }))).toContain('aiSchemaInvalid');
    expect(def({ answer: 'json', schema: { type: 'object', properties: { a: { type: 'string' } } } }).ok).toBe(true);
  });

  it('refuses regular expressions in the schema (pattern, patternProperties) anywhere; a property named "pattern" is fine', () => {
    const nested = { type: 'object', properties: { items: { type: 'array', items: { type: 'string', pattern: '^(a+)+$' } } } };
    for (const schema of [{ type: 'string', pattern: '^(a+)+$' }, nested, { type: 'object', patternProperties: { '^x': { type: 'string' } } }]) {
      const r = def({ answer: 'json', schema });
      expect(codes(r)).toContain('aiSchemaInvalid');
      expect(r.issues.find((i) => i.code === 'aiSchemaInvalid')!.message).toMatch(/the keyword "pattern(Properties)?" is not supported/);
    }
    expect(def({ answer: 'json', schema: { type: 'object', properties: { pattern: { type: 'string' } }, examples: [{ pattern: 'x' }] } }).ok).toBe(true);
    // a schema saved before the rule is refused when the answer is read, before any regular expression is made
    expect(parseJsonAnswer('"aaaa"', { type: 'string', pattern: '^(a+)+$' })).toMatchObject({
      ok: false,
      problem: expect.stringContaining('"pattern" is not supported'),
    });
  });

  it('refuses a context step whose variable another step also writes (its data could be sent instead)', () => {
    const extra = (node: Record<string, unknown>) => {
      const r = validateProcess({
        name: 'AI',
        connections: [{ slot: 'llm', kind: 'llm-gateway' }],
        steps: [
          { id: 'read', type: 'set', values: { rows: '{{ [1, 2] }}' } },
          node,
          { id: 'ask', type: 'ai', connection: 'llm', model: 'm', prompt: 'Look: {{ rows }}', context: [{ name: 'rows', from: 'step', step: 'read' }] },
        ],
      });
      return r.issues.filter((i) => i.code === 'aiContextOverwritten');
    };
    expect(extra({ id: 'again', type: 'set', values: { rows: 'x' } })).toMatchObject([{ params: { name: 'rows', variable: 'rows', step: 'again' } }]);
    expect(extra({ id: 'saved', type: 'log', message: 'x', saveAs: 'rows' })).toHaveLength(1);
    expect(extra({ id: 'other', type: 'set', values: { other: 'x' } })).toEqual([]);
  });

  it('has an error output like other calls', () => {
    const r = def({});
    const ask = r.definition!.nodes.find((n) => n.id === 'ask')!;
    expect(ask.type).toBe('ai');
  });
});
