import { AI_FORMAT_PATHS, ANTHROPIC_VERSION, type AiFormat, type AiModel } from '@sm/shared';

/**
 * The four request formats of an LLM gateway (docs/AI.md#formats), one adapter each behind one interface: build the
 * request of one question (instructions and the user part, no conversation, no tools, no streaming) and read the
 * answer, its token counts and why it ended. Nothing else of the formats is used.
 */

export interface AiRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
  temperature?: number;
}

export interface AiHttpRequest {
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Why the model stopped: the answer is complete, it hit the output limit, or something else (filtered, unknown). */
export type AiFinish = 'stop' | 'length' | 'other';

export interface AiAnswer {
  text: string;
  /** Token counts as the gateway reported them (null: not reported) */
  inputTokens: number | null;
  outputTokens: number | null;
  finish: AiFinish;
  /** The gateway's own word for it (finish_reason, stop_reason, stopReason, status) */
  finishRaw: string;
}

export interface FormatAdapter {
  format: AiFormat;
  request(model: Pick<AiModel, 'id' | 'path'>, q: AiRequest, opts?: { anthropicVersion?: string }): AiHttpRequest;
  /** Throws when the body is not an answer of the format */
  answer(body: unknown): AiAnswer;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
const sum = (...v: (number | null)[]): number | null => (v.every((x) => x === null) ? null : v.reduce<number>((a, b) => a + (b ?? 0), 0));
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The path of a model: its own, else the format's; `{modelId}` URL-encoded (Bedrock ids contain ':' and '.'). */
export function modelPath(format: AiFormat, model: Pick<AiModel, 'id' | 'path'>): string {
  return (model.path || AI_FORMAT_PATHS[format]).replace(/\{modelId\}/g, encodeURIComponent(model.id));
}

function notAnAnswer(format: AiFormat, body: unknown): Error {
  const s = typeof body === 'string' ? body : JSON.stringify(body ?? null);
  return new Error(`The gateway's answer is not in the ${format} format: ${(s ?? '').slice(0, 200)}`);
}

/** Text of content parts: strings, or parts with a `text` (output_text, text, …) – other parts (images, tool use) are left out. */
function partsText(content: unknown): string {
  if (typeof content === 'string') return content;
  return arr(content)
    .map((p) => (typeof p === 'string' ? p : str(obj(p).text)))
    .filter(Boolean)
    .join('');
}

const finishOf = (raw: string, stop: string[], length: string[]): AiFinish => (stop.includes(raw) ? 'stop' : length.includes(raw) ? 'length' : 'other');

// ---------- OpenAI Chat Completions (and every OpenAI-compatible API) ----------

const chatCompletions: FormatAdapter = {
  format: 'chat-completions',
  request: (m, q) => ({
    path: modelPath('chat-completions', m),
    headers: {},
    body: {
      model: m.id,
      messages: [...(q.system ? [{ role: 'system', content: q.system }] : []), { role: 'user', content: q.user }],
      max_tokens: q.maxOutputTokens,
      ...(q.temperature !== undefined ? { temperature: q.temperature } : {}),
      stream: false,
    },
  }),
  answer: (body) => {
    const b = obj(body);
    const choice = obj(arr(b.choices)[0]);
    if (!Array.isArray(b.choices) || !choice.message) throw notAnAnswer('chat-completions', body);
    const u = obj(b.usage);
    const raw = str(choice.finish_reason);
    return {
      text: partsText(obj(choice.message).content),
      inputTokens: num(u.prompt_tokens),
      outputTokens: num(u.completion_tokens),
      finish: finishOf(raw, ['stop'], ['length']),
      finishRaw: raw,
    };
  },
};

// ---------- OpenAI Responses ----------

const responses: FormatAdapter = {
  format: 'responses',
  request: (m, q) => ({
    path: modelPath('responses', m),
    headers: {},
    body: {
      model: m.id,
      ...(q.system ? { instructions: q.system } : {}),
      input: [{ role: 'user', content: [{ type: 'input_text', text: q.user }] }],
      max_output_tokens: q.maxOutputTokens,
      ...(q.temperature !== undefined ? { temperature: q.temperature } : {}),
      stream: false,
      // nothing is kept on the provider's side for a later turn
      store: false,
    },
  }),
  answer: (body) => {
    const b = obj(body);
    if (!Array.isArray(b.output) && typeof b.output_text !== 'string') throw notAnAnswer('responses', body);
    // output_text is a convenience some gateways add; the API itself returns output items of type "message"
    const text =
      typeof b.output_text === 'string'
        ? b.output_text
        : arr(b.output)
            .filter((i) => obj(i).type === 'message')
            .map((i) => partsText(arr(obj(i).content).filter((c) => obj(c).type === 'output_text' || obj(c).type === 'text')))
            .join('');
    const u = obj(b.usage);
    const status = str(b.status);
    const reason = str(obj(b.incomplete_details).reason);
    return {
      text,
      inputTokens: num(u.input_tokens),
      outputTokens: num(u.output_tokens),
      finish: status === 'incomplete' ? (reason === 'max_output_tokens' ? 'length' : 'other') : status === 'completed' || !status ? 'stop' : 'other',
      finishRaw: reason ? `${status}: ${reason}` : status,
    };
  },
};

// ---------- Anthropic Messages ----------

const anthropicMessages: FormatAdapter = {
  format: 'anthropic-messages',
  request: (m, q, opts) => ({
    path: modelPath('anthropic-messages', m),
    headers: { 'anthropic-version': opts?.anthropicVersion || ANTHROPIC_VERSION },
    body: {
      model: m.id,
      max_tokens: q.maxOutputTokens,
      ...(q.system ? { system: q.system } : {}),
      messages: [{ role: 'user', content: q.user }],
      ...(q.temperature !== undefined ? { temperature: q.temperature } : {}),
    },
  }),
  answer: (body) => {
    const b = obj(body);
    if (!Array.isArray(b.content)) throw notAnAnswer('anthropic-messages', body);
    const u = obj(b.usage);
    const raw = str(b.stop_reason);
    return {
      text: partsText(arr(b.content).filter((c) => obj(c).type === 'text')),
      // cached prompt parts are reported separately: they are input all the same
      inputTokens: sum(num(u.input_tokens), num(u.cache_creation_input_tokens), num(u.cache_read_input_tokens)),
      outputTokens: num(u.output_tokens),
      finish: finishOf(raw, ['end_turn', 'stop_sequence'], ['max_tokens']),
      finishRaw: raw,
    };
  },
};

// ---------- AWS Bedrock Converse ----------

const bedrockConverse: FormatAdapter = {
  format: 'bedrock-converse',
  request: (m, q) => ({
    path: modelPath('bedrock-converse', m),
    headers: {},
    body: {
      ...(q.system ? { system: [{ text: q.system }] } : {}),
      messages: [{ role: 'user', content: [{ text: q.user }] }],
      inferenceConfig: { maxTokens: q.maxOutputTokens, ...(q.temperature !== undefined ? { temperature: q.temperature } : {}) },
    },
  }),
  answer: (body) => {
    const b = obj(body);
    const message = obj(obj(b.output).message);
    if (!Array.isArray(message.content)) throw notAnAnswer('bedrock-converse', body);
    const u = obj(b.usage);
    const raw = str(b.stopReason);
    return {
      text: partsText(message.content),
      inputTokens: sum(num(u.inputTokens), num(u.cacheReadInputTokens), num(u.cacheWriteInputTokens)),
      outputTokens: num(u.outputTokens),
      finish: finishOf(raw, ['end_turn', 'stop_sequence'], ['max_tokens']),
      finishRaw: raw,
    };
  },
};

export const ADAPTERS: Record<AiFormat, FormatAdapter> = {
  'chat-completions': chatCompletions,
  responses,
  'anthropic-messages': anthropicMessages,
  'bedrock-converse': bedrockConverse,
};

/**
 * The gateway's own error text from an error answer: OpenAI `{ error: { message } }`, Anthropic `{ type: "error",
 * error: { message } }`, Bedrock `{ message }` / `{ Message }`, or a plain text.
 */
export function gatewayErrorText(body: unknown): string {
  if (typeof body === 'string') return body.slice(0, 300);
  const b = obj(body);
  const e = obj(b.error);
  const text = str(e.message) || str(b.error) || str(b.message) || str(b.Message) || str(b.detail);
  return (text || JSON.stringify(body ?? null)).slice(0, 300);
}

/** Ids of an OpenAI list of models (`{ data: [{ id, owned_by }] }`; also a bare list). */
export function modelList(body: unknown): { id: string; ownedBy?: string }[] {
  const items = Array.isArray(body) ? body : arr(obj(body).data ?? obj(body).models);
  return items
    .map((x) => (typeof x === 'string' ? { id: x } : { id: str(obj(x).id) || str(obj(x).name), ownedBy: str(obj(x).owned_by) || undefined }))
    .filter((x) => x.id);
}
