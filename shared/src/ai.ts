import { z } from 'zod';

/**
 * AI models through an LLM gateway (0.6.0, #216, docs/AI.md): a process step asks a model a predefined question with
 * explicitly chosen context and uses the answer in later steps. Every call is limited (input and output per call,
 * token budgets per day and month), logged without its content, and can be reported.
 *
 * One gateway can expose several request formats on one base URL, so the format belongs to the model, not to the
 * vendor. Steward speaks four formats and nothing else; it never streams.
 */

export const LLM_GATEWAY_KIND = 'llm-gateway';

/**
 * Request formats: OpenAI Chat Completions (also every OpenAI-compatible API), OpenAI Responses, Anthropic Messages
 * and the AWS Bedrock Converse format.
 */
export const AI_FORMATS = ['chat-completions', 'responses', 'anthropic-messages', 'bedrock-converse'] as const;
export type AiFormat = (typeof AI_FORMATS)[number];

/** The path of each format on the gateway (a model can override it); `{modelId}` is replaced, URL-encoded. */
export const AI_FORMAT_PATHS: Record<AiFormat, string> = {
  'chat-completions': '/v1/chat/completions',
  responses: '/v1/responses',
  'anthropic-messages': '/v1/messages',
  'bedrock-converse': '/v1/bedrock/model/{modelId}/invoke',
};

/** The model list of the gateway (OpenAI list format: `{ data: [{ id }] }`). */
export const AI_MODELS_PATH = '/v1/models';
/** The `anthropic-version` header the Messages format sends unless the gateway settings name another one. */
export const ANTHROPIC_VERSION = '2023-06-01';

/**
 * The token estimate made before a call (no tokenizer): characters divided by this, rounded up, plus a fixed
 * overhead per message and per call. 3.5 characters per token is conservative for English and German prose and for
 * JSON (real tokenizers average about 4); a model can set its own value.
 */
export const AI_ESTIMATE = { charsPerToken: 3.5, perMessage: 8, perCall: 16 } as const;

export const AI_LIMITS = {
  models: 50,
  modelIdChars: 200,
  /** The largest context window and output a model can be given (tokens) */
  contextTokens: 10_000_000,
  outputTokens: 1_000_000,
  /** Prompt template parts (characters) */
  promptChars: 50_000,
  /** Context sources of one step, and the characters one source may contribute */
  contextSources: 20,
  contextChars: { default: 20_000, max: 500_000 },
  /** The JSON Schema of a JSON answer (characters when serialized) */
  schemaChars: 20_000,
  /** A sample (recorded) answer for dry runs and test runs */
  sampleChars: 100_000,
  /** Allowed data entries of a gateway */
  allowedEntries: 200,
  /** Budgets (tokens) */
  budgetTokens: 1_000_000_000_000,
  /** One call waits at most this long for the answer (no streaming) */
  timeoutMs: 300_000,
} as const;

/** Share of a budget at which a notification goes out (once per period). */
export const AI_BUDGET_WARN_PCT = 80;

const modelId = z
  .string()
  .trim()
  .min(1)
  .max(AI_LIMITS.modelIdChars)
  .regex(/^[^\s{}]+$/, 'A model id without spaces or braces');

export const aiModelSchema = z
  .object({
    /** The model id as the gateway expects it (`model` field, or the path of the Bedrock format) */
    id: modelId,
    /** Shown instead of the id (optional) */
    label: z.string().trim().max(200).optional(),
    format: z.enum(AI_FORMATS),
    /** Another path than the format's default (relative to the base URL; `{modelId}` is replaced) */
    path: z
      .string()
      .trim()
      .max(500)
      .regex(/^\/[^\s?#]*$/, 'A path that starts with /, without query')
      .optional(),
    /** The context window: input and output together (tokens) */
    contextTokens: z.number().int().min(256).max(AI_LIMITS.contextTokens),
    /** Default and ceiling of the output of one call (tokens) */
    maxOutputTokens: z.number().int().min(1).max(AI_LIMITS.outputTokens),
    /** Ceiling of the input of one call (tokens); default: the context window minus the output */
    maxInputTokens: z.number().int().min(1).max(AI_LIMITS.contextTokens).optional(),
    /** Characters per token for the estimate before a call (default AI_ESTIMATE.charsPerToken) */
    charsPerToken: z.number().min(1).max(10).optional(),
    /** Price per 1,000 input and output tokens (in the installation's currency; optional, for reports) */
    priceInputPer1k: z.number().min(0).max(1_000_000).optional(),
    priceOutputPer1k: z.number().min(0).max(1_000_000).optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (m.maxOutputTokens >= m.contextTokens) ctx.addIssue({ code: 'custom', path: ['maxOutputTokens'], message: 'Must be smaller than the context window' });
  });
export type AiModel = z.infer<typeof aiModelSchema>;

/** A dataset key pattern: letters, digits, . _ - and * (any characters), e.g. checkmk.* */
const datasetPattern = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._*-]+$/, 'A dataset key or pattern such as checkmk.*');

/**
 * What a gateway may be sent (default: nothing). The sources of the variables an AI step sends are checked
 * (server/src/ai/provenance.ts): a value an API call or a browser step wrote comes from its platform; a value any
 * other step wrote (set, for-each, sub-process …) counts as everything of the run – every platform bound to it, its
 * inputs and the datasets it may read.
 */
export const aiAllowedDataSchema = z
  .object({
    /** Platform ids whose data may be sent; "*": every platform */
    platforms: z.array(z.string().trim().min(1).max(64)).max(AI_LIMITS.allowedEntries).default([]),
    /** Dataset keys or patterns (checkmk.*); "*": every dataset the run may read */
    datasets: z.array(datasetPattern).max(AI_LIMITS.allowedEntries).default([]),
    /** Inputs of the run */
    inputs: z.boolean().default(false),
  })
  .strict();
export type AiAllowedData = z.infer<typeof aiAllowedDataSchema>;

/** `config.ai` of an LLM gateway platform (PUT /api/platforms/:id/ai). Sealed with the connection settings. */
export const aiGatewaySettingsSchema = z
  .object({
    models: z.array(aiModelSchema).max(AI_LIMITS.models).default([]),
    allowedData: aiAllowedDataSchema.default({ platforms: [], datasets: [], inputs: false }),
    /** The anthropic-version header of the Messages format (default ANTHROPIC_VERSION) */
    anthropicVersion: z
      .string()
      .trim()
      .max(40)
      .regex(/^[0-9A-Za-z.-]*$/)
      .optional(),
    /** Path of the model list (default AI_MODELS_PATH) */
    modelsPath: z
      .string()
      .trim()
      .max(500)
      .regex(/^\/[^\s?#]*$/)
      .optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    const seen = new Set<string>();
    s.models.forEach((m, i) => {
      if (seen.has(m.id)) ctx.addIssue({ code: 'custom', path: ['models', i, 'id'], message: `Model "${m.id}" is listed twice` });
      seen.add(m.id);
    });
  });
export type AiGatewaySettings = z.infer<typeof aiGatewaySettingsSchema>;
export type AiGatewaySettingsInput = z.input<typeof aiGatewaySettingsSchema>;

export const emptyAiSettings = (): AiGatewaySettings => ({ models: [], allowedData: { platforms: [], datasets: [], inputs: false } });

/** Whether a dataset key matches a pattern of the allowed data ("*" matches any characters, case does not matter). */
export function datasetAllowed(key: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => p === '*' || wildcardMatch(key.toLowerCase(), p.toLowerCase()));
}

/**
 * "*" matches any run of characters, everything else itself. No regular expression: the greedy two-pointer walk
 * backs up to the last "*" only, so it takes at most key × pattern steps, whatever the pattern.
 */
function wildcardMatch(key: string, pattern: string): boolean {
  let k = 0;
  let p = 0;
  let star = -1;
  let mark = 0;
  while (k < key.length) {
    if (p < pattern.length && pattern[p] !== '*' && pattern[p] === key[k]) {
      k++;
      p++;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      mark = k;
    } else if (star >= 0) {
      p = star + 1;
      k = ++mark;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

/** The input ceiling of one call to a model: its own, else the context window minus the output. */
export const modelInputCeiling = (m: Pick<AiModel, 'contextTokens' | 'maxOutputTokens' | 'maxInputTokens'>): number =>
  Math.min(m.maxInputTokens ?? m.contextTokens - m.maxOutputTokens, m.contextTokens - 1);

// ---------- budgets ----------

/** Budgets apply to the whole installation, to one gateway (platform) and to one process. */
export const AI_BUDGET_SCOPES = ['installation', 'platform', 'process'] as const;
export type AiBudgetScope = (typeof AI_BUDGET_SCOPES)[number];
export const AI_PERIODS = ['day', 'month'] as const;
export type AiPeriod = (typeof AI_PERIODS)[number];

const budgetTokens = z.number().int().min(0).max(AI_LIMITS.budgetTokens).nullable();

/** PUT /api/ai/budgets: one budget (null: no limit for that period). Raising a budget needs a step-up. */
export const aiBudgetInput = z
  .object({
    scope: z.enum(AI_BUDGET_SCOPES),
    /** Platform or process id; empty for the installation */
    scopeId: z.string().trim().max(64).default(''),
    tokensPerDay: budgetTokens,
    tokensPerMonth: budgetTokens,
    /** Why (kept in the audit entry) */
    comment: z.string().trim().max(1000).optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.scope === 'installation' ? b.scopeId !== '' : b.scopeId === '')
      ctx.addIssue({ code: 'custom', path: ['scopeId'], message: b.scope === 'installation' ? 'The installation has no id' : 'Name the platform or process' });
  });
export type AiBudgetInput = z.input<typeof aiBudgetInput>;

export interface AiBudgetUse {
  scope: AiBudgetScope;
  scopeId: string;
  /** Display name of the platform or process (empty for the installation) */
  name: string;
  tokensPerDay: number | null;
  tokensPerMonth: number | null;
  usedToday: number;
  usedThisMonth: number;
  /** ok · warning (≥ 80 % of a period) · exhausted (no call fits any more) */
  state: 'ok' | 'warning' | 'exhausted';
  updatedAt: string | null;
  updatedBy: string | null;
}

/** Results of a call in the usage log. */
export const AI_CALL_RESULTS = ['ok', 'failed', 'invalid', 'refused', 'pending'] as const;
export type AiCallResult = (typeof AI_CALL_RESULTS)[number];

/** Why a call was refused before it was sent, or failed. */
export const AI_REASON_CODES = [
  'AI_BUDGET_EXHAUSTED',
  'AI_INPUT_TOO_LARGE',
  'AI_OUTPUT_TOO_LARGE',
  'AI_DATA_NOT_ALLOWED',
  'AI_MODEL_UNKNOWN',
  'AI_ANSWER_INVALID',
  'AI_GATEWAY_ERROR',
  'AI_CALL_INTERRUPTED',
] as const;
export type AiReasonCode = (typeof AI_REASON_CODES)[number];

/** One call in the usage log: no prompt and no answer – those stay in the run. */
export interface AiUsageEntry {
  id: string;
  at: string;
  processId: string | null;
  processName: string | null;
  processVersion: number | null;
  runId: string | null;
  stepKey: string | null;
  platformId: string;
  platformName: string;
  model: string;
  format: AiFormat;
  inputTokens: number;
  outputTokens: number;
  estimatedInputTokens: number;
  durationMs: number;
  result: AiCallResult;
  reason: string;
  /** Price from the model's settings (null: no price set) */
  cost: number | null;
  /** SHA-256 of the prompt template (system, user, schema) and of the filled-in input */
  promptFingerprint: string;
  inputFingerprint: string;
  actor: string;
}

/** GET /api/platforms/:id/ai/usage: the gateway's budgets, its use this period and the top processes. */
export interface AiUsageOverview {
  platformId: string;
  day: string;
  month: string;
  budgets: AiBudgetUse[];
  today: AiUsageTotals;
  thisMonth: AiUsageTotals;
  /** By tokens this month; processes the reader may not view are summed up as one row with id null */
  topProcesses: { processId: string | null; name: string; calls: number; tokens: number; cost: number | null }[];
  byModel: { model: string; format: AiFormat; calls: number; inputTokens: number; outputTokens: number; cost: number | null }[];
  /** The latest calls (at most 50), the same rule for process names */
  recent: AiUsageEntry[];
  /** The reader may change budgets (administrators) */
  canEditBudgets: boolean;
}

export interface AiUsageTotals {
  calls: number;
  refused: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cost: number | null;
}

/** The built-in dataset of the usage (docs/AI.md); read by the "AI usage" dashboard template. */
export const AI_USAGE_DATASET = 'ai.usage';

/** POST /api/platforms/:id/ai/discover: the models the gateway lists, with a suggested format. */
export interface AiDiscoveredModel {
  id: string;
  ownedBy?: string;
  suggestedFormat: AiFormat;
  /** Already in the gateway's settings */
  configured: boolean;
}

/**
 * A suggested format for a model id the gateway lists: Bedrock model ids carry a provider prefix with a dot and a
 * version (vendor.model-v1:0); everything else is offered as Chat Completions, which every OpenAI-compatible gateway
 * speaks. Only a suggestion: the person setting up the gateway decides.
 */
export function suggestFormat(id: string): AiFormat {
  if (/^([a-z]{2}\.)?[a-z0-9-]+\.[a-z0-9.-]+-v\d+(:\d+)?$/i.test(id)) return 'bedrock-converse';
  return 'chat-completions';
}

// ---------- the step ----------

/** `{{ name }}` placeholders of a prompt template: only names of context sources, no expressions. */
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const NAME = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/;

/** The context names a prompt template uses, and the placeholders that are not a plain name. */
export function promptVariables(text: string | undefined): { names: string[]; invalid: string[] } {
  const names = new Set<string>();
  const invalid: string[] = [];
  for (const m of (text ?? '').matchAll(PLACEHOLDER)) {
    const n = NAME.exec(m[1]!);
    if (n) names.add(n[1]!);
    else invalid.push(m[0]);
  }
  return { names: [...names], invalid };
}

/** Fills the placeholders of a prompt template (every name must be in `values`; checked when the process is saved). */
export function fillPrompt(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (all, inner: string) => {
    const n = NAME.exec(inner);
    return n && Object.prototype.hasOwnProperty.call(values, n[1]!) ? values[n[1]!]! : all;
  });
}

export const AI_ANSWER_FORMATS = ['text', 'json'] as const;
export type AiAnswerFormat = (typeof AI_ANSWER_FORMATS)[number];
export const AI_CONTEXT_FROM = ['step', 'dataset', 'input'] as const;
export type AiContextFrom = (typeof AI_CONTEXT_FROM)[number];
