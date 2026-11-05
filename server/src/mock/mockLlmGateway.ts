import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AiFormat } from '@sm/shared';

/**
 * A simulated multi-format LLM gateway for the demo and the tests (0.6.0, #216, docs/AI.md): one base URL
 * (/mock/llm) that speaks the four request formats Steward uses, signed in with an API key in `x-api-key` (also
 * `api-key` or `Authorization: Bearer`). No streaming: a request that asks for it is refused.
 *
 *   GET  /v1/models                              OpenAI list format
 *   POST /v1/chat/completions                    OpenAI Chat Completions
 *   POST /v1/responses                           OpenAI Responses (input instead of messages, output items)
 *   POST /v1/messages                            Anthropic Messages (needs anthropic-version, model, max_tokens, messages)
 *   POST /v1/bedrock/model/{modelId}/invoke      Bedrock Converse (model id in the path, typed content blocks)
 *
 * Each model speaks one format (DEMO_LLM.models); a request in another format is refused with HTTP 400, as a real
 * gateway would. The answer is made up from the question: for a system part that asks for JSON matching a JSON Schema,
 * an object that matches it; otherwise a short text that names the model and what it was asked. Token counts: four
 * characters a token. Markers in the question steer the tests: [mock:error] (HTTP 500), [mock:bad-json] (not JSON),
 * [mock:no-usage] (no token counts), [mock:length] (stopped at the output limit).
 *
 * Test helpers (no sign-in): GET /llm/_mock/calls (every request: format, model, path, body), POST /llm/_mock/reset.
 */

export const DEMO_LLM = {
  apiKey: 'demo-llm-key',
  models: [
    { id: 'demo-chat-small', format: 'chat-completions' as AiFormat },
    { id: 'demo-responses-small', format: 'responses' as AiFormat },
    { id: 'demo-messages-small', format: 'anthropic-messages' as AiFormat },
    { id: 'demo.converse-small-v1:0', format: 'bedrock-converse' as AiFormat },
  ],
};

const R = '/llm';

interface Call {
  format: AiFormat;
  model: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

const calls: Call[] = [];

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const tokens = (s: string) => Math.ceil(s.length / 4);

function authorized(req: FastifyRequest): boolean {
  const h = req.headers;
  const bearer = /^Bearer\s+(.+)$/i.exec(String(h.authorization ?? ''))?.[1];
  return [h['x-api-key'], h['api-key'], bearer].includes(DEMO_LLM.apiKey);
}

/** A value that matches a JSON Schema (the subset answers use): every property, the first enum value. */
function sample(schema: unknown, hint: string, depth = 0): unknown {
  const s = obj(schema);
  if (depth > 8) return null;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  if (s.const !== undefined) return s.const;
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
  const alt = (Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : null) as unknown[] | null;
  if (alt?.length) return sample(alt.find((x) => obj(x).type !== 'null') ?? alt[0], hint, depth + 1);
  if (type === 'object' || s.properties) {
    const out: Obj = {};
    for (const [k, v] of Object.entries(obj(s.properties))) out[k] = sample(v, k, depth + 1);
    return out;
  }
  if (type === 'array') return [sample(s.items, hint, depth + 1)];
  if (type === 'number' || type === 'integer') return typeof s.minimum === 'number' ? s.minimum : 1;
  if (type === 'boolean') return true;
  const text = `Demo ${hint || 'text'} from the simulated gateway`;
  return typeof s.maxLength === 'number' ? text.slice(0, s.maxLength) : text;
}

/** The answer to one question, and how it ended. */
function answer(model: string, system: string, user: string): { text: string; finish: 'stop' | 'length'; usage: boolean; status: number } {
  const usage = !user.includes('[mock:no-usage]');
  if (user.includes('[mock:error]')) return { text: 'The simulated gateway failed on purpose', finish: 'stop', usage, status: 500 };
  if (user.includes('[mock:bad-json]')) return { text: 'Sorry, here is no JSON.', finish: 'stop', usage, status: 200 };
  const finish = user.includes('[mock:length]') ? 'length' : 'stop';
  const schemaAt = system.indexOf('JSON Schema:');
  if (schemaAt >= 0) {
    try {
      return { text: JSON.stringify(sample(JSON.parse(system.slice(schemaAt + 'JSON Schema:'.length).trim()), 'summary')), finish, usage, status: 200 };
    } catch {
      return { text: '{}', finish, usage, status: 200 };
    }
  }
  if (user.trim() === 'Reply with OK.') return { text: 'OK', finish, usage, status: 200 };
  const first = user.replace(/\s+/g, ' ').trim().slice(0, 80);
  const lines = user.split('\n').filter((l) => l.trim()).length;
  return {
    text: `Answer of ${model} (simulated gateway): the question has ${user.length} characters in ${lines} line(s) and begins with "${first}". Nothing here was written by a real model.`,
    finish,
    usage,
    status: 200,
  };
}

function refuse(reply: FastifyReply, format: AiFormat, status: number, message: string) {
  const body =
    format === 'anthropic-messages'
      ? { type: 'error', error: { type: status === 401 ? 'authentication_error' : 'invalid_request_error', message } }
      : format === 'bedrock-converse'
        ? { message }
        : { error: { message, type: status === 401 ? 'authentication_error' : 'invalid_request_error', code: null } };
  return reply.code(status).send(body);
}

function modelFor(reply: FastifyReply, format: AiFormat, id: unknown): string | null {
  const m = DEMO_LLM.models.find((x) => x.id === id);
  if (!m) {
    refuse(reply, format, 404, `The model "${String(id ?? '')}" does not exist on this gateway`);
    return null;
  }
  if (m.format !== format) {
    refuse(reply, format, 400, `The model "${m.id}" speaks the ${m.format} format, not ${format}`);
    return null;
  }
  return m.id;
}

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => (typeof c === 'string' ? c : String(obj(c).text ?? ''))).join('') : '';

export async function mockLlmGateway(app: FastifyInstance): Promise<void> {
  const guard = (format: AiFormat) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!authorized(req)) return refuse(reply, format, 401, 'Missing or invalid API key');
    if (obj(req.body).stream === true) return refuse(reply, format, 400, 'Streaming is not supported by this endpoint');
    return undefined;
  };
  const record = (req: FastifyRequest, format: AiFormat, model: string) =>
    calls.push({
      format,
      model,
      path: req.url.split('?')[0]!.slice('/mock'.length),
      body: req.body,
      headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k === 'anthropic-version' || k === 'content-type')) as Record<string, string>,
    });

  app.get(`${R}/v1/models`, async (req, reply) => {
    if (!authorized(req)) return refuse(reply, 'chat-completions', 401, 'Missing or invalid API key');
    return { object: 'list', data: DEMO_LLM.models.map((m) => ({ id: m.id, object: 'model', created: 1767225600, owned_by: 'demo' })) };
  });

  app.post(`${R}/v1/chat/completions`, { preHandler: guard('chat-completions') }, async (req, reply) => {
    const b = obj(req.body);
    const model = modelFor(reply, 'chat-completions', b.model);
    if (!model) return reply;
    const messages = Array.isArray(b.messages) ? b.messages.map(obj) : [];
    if (!messages.length) return refuse(reply, 'chat-completions', 400, 'messages is required');
    record(req, 'chat-completions', model);
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => textOf(m.content))
      .join('\n');
    const user = messages
      .filter((m) => m.role === 'user')
      .map((m) => textOf(m.content))
      .join('\n');
    const a = answer(model, system, user);
    if (a.status !== 200) return refuse(reply, 'chat-completions', a.status, a.text);
    return {
      id: `chatcmpl-${calls.length}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: a.text }, finish_reason: a.finish === 'length' ? 'length' : 'stop' }],
      ...(a.usage
        ? { usage: { prompt_tokens: tokens(system + user) + 7, completion_tokens: tokens(a.text), total_tokens: tokens(system + user) + 7 + tokens(a.text) } }
        : {}),
    };
  });

  app.post(`${R}/v1/responses`, { preHandler: guard('responses') }, async (req, reply) => {
    const b = obj(req.body);
    const model = modelFor(reply, 'responses', b.model);
    if (!model) return reply;
    if (b.messages !== undefined) return refuse(reply, 'responses', 400, 'Unknown parameter: messages (use input)');
    if (b.input === undefined) return refuse(reply, 'responses', 400, 'input is required');
    record(req, 'responses', model);
    const user = typeof b.input === 'string' ? b.input : (b.input as unknown[]).map((i) => textOf(obj(i).content)).join('\n');
    const system = typeof b.instructions === 'string' ? b.instructions : '';
    const a = answer(model, system, user);
    if (a.status !== 200) return refuse(reply, 'responses', a.status, a.text);
    return {
      id: `resp_${calls.length}`,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: a.finish === 'length' ? 'incomplete' : 'completed',
      ...(a.finish === 'length' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
      model,
      output: [
        {
          type: 'message',
          id: `msg_${calls.length}`,
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: a.text, annotations: [] }],
        },
      ],
      ...(a.usage
        ? { usage: { input_tokens: tokens(system + user) + 5, output_tokens: tokens(a.text), total_tokens: tokens(system + user) + 5 + tokens(a.text) } }
        : {}),
    };
  });

  app.post(`${R}/v1/messages`, { preHandler: guard('anthropic-messages') }, async (req, reply) => {
    const b = obj(req.body);
    if (!req.headers['anthropic-version']) return refuse(reply, 'anthropic-messages', 400, 'anthropic-version: header is required');
    const model = modelFor(reply, 'anthropic-messages', b.model);
    if (!model) return reply;
    if (typeof b.max_tokens !== 'number') return refuse(reply, 'anthropic-messages', 400, 'max_tokens: Field required');
    const messages = Array.isArray(b.messages) ? b.messages.map(obj) : [];
    if (!messages.length) return refuse(reply, 'anthropic-messages', 400, 'messages: Field required');
    if (messages.some((m) => m.role === 'system'))
      return refuse(reply, 'anthropic-messages', 400, 'messages: Unexpected role "system" (use the top-level system parameter)');
    record(req, 'anthropic-messages', model);
    const system = textOf(b.system);
    const user = messages.map((m) => textOf(m.content)).join('\n');
    const a = answer(model, system, user);
    if (a.status !== 200) return refuse(reply, 'anthropic-messages', a.status, a.text);
    return {
      id: `msg_${calls.length}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text: a.text }],
      stop_reason: a.finish === 'length' ? 'max_tokens' : 'end_turn',
      stop_sequence: null,
      ...(a.usage ? { usage: { input_tokens: tokens(system + user) + 4, output_tokens: tokens(a.text), cache_read_input_tokens: 0 } } : {}),
    };
  });

  app.post(`${R}/v1/bedrock/model/:modelId/invoke`, { preHandler: guard('bedrock-converse') }, async (req, reply) => {
    const id = (req.params as { modelId: string }).modelId;
    const model = modelFor(reply, 'bedrock-converse', id);
    if (!model) return reply;
    const b = obj(req.body);
    const messages = Array.isArray(b.messages) ? b.messages.map(obj) : [];
    if (!messages.length || messages.some((m) => !Array.isArray(m.content)))
      return refuse(reply, 'bedrock-converse', 400, 'messages: content must be a list of content blocks, e.g. [{"text": "…"}]');
    record(req, 'bedrock-converse', model);
    const system = textOf(b.system);
    const user = messages.map((m) => textOf(m.content)).join('\n');
    const a = answer(model, system, user);
    if (a.status !== 200) return refuse(reply, 'bedrock-converse', a.status, a.text);
    const input = tokens(system + user) + 3;
    return {
      output: { message: { role: 'assistant', content: [{ text: a.text }] } },
      stopReason: a.finish === 'length' ? 'max_tokens' : 'end_turn',
      ...(a.usage ? { usage: { inputTokens: input, outputTokens: tokens(a.text), totalTokens: input + tokens(a.text) } } : {}),
      metrics: { latencyMs: 12 },
    };
  });

  app.get(`${R}/_mock/calls`, async () => ({ calls }));
  app.post(`${R}/_mock/reset`, async () => {
    calls.length = 0;
    return { ok: true };
  });
}
