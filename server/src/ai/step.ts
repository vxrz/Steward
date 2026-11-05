import { z } from 'zod';
import {
  AI_LIMITS,
  LLM_GATEWAY_KIND,
  datasetAllowed,
  fillPrompt,
  jsonSchemaProblem,
  modelInputCeiling,
  promptVariables,
  type AiContextSource,
  type AiGatewaySettings,
  type NodeOf,
  type Platform,
  type ProcessDefinition,
} from '@sm/shared';
import { db } from '../db.js';
import { platformRequest, type HttpResult } from '../platforms/http.js';
import { findRecording, missingRecording } from '../platforms/recordings.js';
import { ADAPTERS, gatewayErrorText, type AiAnswer } from './formats.js';
import { estimateTokens, fingerprint } from './estimate.js';
import { scrubForModel } from './scrub.js';
import { finishCall, refusalText, refuseCall, reserveCall, type CallFacts } from './usage.js';
import { gatewaySettings, modelCost } from './gateway.js';
import { DATASET, INPUT, resultVars } from './provenance.js';

/**
 * "Ask an AI model" (docs/AI.md): assemble the context the step names, check it against the gateway's allowed data,
 * fill in the prompt template, estimate the input and check the limits and budgets – all before anything is sent –,
 * then send one request in the model's format and read the answer (text, or JSON checked against the step's schema).
 * Dry runs use the step's sample answer; test runs a recorded response of the gateway (else the sample answer).
 */

/** What the runner gives the step (engine/runner.ts keeps its run context to itself). */
export interface AiStepIo {
  runId: string;
  processId: string;
  processName: string;
  processVersion: number | null;
  stepKey: string;
  actor: string;
  dryRun: boolean;
  /** Test run: recorded responses instead of the gateway */
  recorded: boolean;
  def: ProcessDefinition;
  gateway: { platform: Platform; secrets: Record<string, string> };
  vars: Record<string, unknown>;
  inputs: Record<string, unknown>;
  /** Where the values of these variables may come from (ai/provenance.ts): platform ids, "input", "dataset:<key>" */
  sourcesOf: (names: string[]) => Set<string>;
  /** What the run's inputs may carry: "input" – and for a sub-process run everything of its parent run */
  inputSources: () => Set<string>;
  /** Evaluates an expression on a value (the run's guard rails) */
  evalOn: (expr: string, value: unknown) => Promise<unknown>;
  /** The rows of a dataset the run's actor may read (throws otherwise) */
  datasetRows: (key: string) => Record<string, unknown>[];
  /** Every secret value of the run (platform credentials, secret inputs, tokens seen) */
  secrets: () => string[];
  log: (level: 'info' | 'warn', message: string) => void;
  setInput: (input: unknown) => void;
  /** The outbound policy and the secret-leak check of process requests */
  enforceOutbound: (url: string, headers: Record<string, string>, body: unknown) => Promise<void>;
  signal: AbortSignal;
}

export interface AiStepOutput {
  answer: unknown;
  text: string;
  format: 'text' | 'json';
  model: string;
  modelLabel: string;
  platform: string;
  aiGenerated: true;
  /** A line for messages that carry the answer */
  marking: string;
  usage: { inputTokens: number; outputTokens: number; estimatedInputTokens: number; cost: number | null };
  durationMs: number;
  finishReason: string;
  /** The answer ended at the output limit */
  truncated: boolean;
  promptFingerprint: string;
  inputFingerprint: string;
  removedSecrets: number;
  dryRun?: boolean;
  recorded?: boolean;
  sample?: boolean;
}

/** A refusal or failure with its reason code in the message, as the run shows it. */
export class AiStepError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
  /** Not retried by the platform client */
  readonly retryable = false;
}

interface Part {
  name: string;
  text: string;
  chars: number;
  cut: boolean;
  removed: number;
}

/**
 * Checks what a context source may carry against the allowed data: the platforms (but the gateway itself – its own
 * answers), the inputs and the datasets. The sources are those of the values actually read (ai/provenance.ts).
 */
function checkSources(c: AiContextSource, sources: Set<string>, io: AiStepIo, allowed: AiGatewaySettings['allowedData']): void {
  const name = io.gateway.platform.name;
  const where = `an administrator allows it under Platforms → ${name} → AI models → Allowed data`;
  const platforms = [...sources].filter((x) => x !== INPUT && !x.startsWith(DATASET) && x !== io.gateway.platform.id);
  const denied = allowed.platforms.includes('*') ? [] : platforms.filter((id) => !allowed.platforms.includes(id));
  if (denied.length)
    throw new AiStepError(
      'AI_DATA_NOT_ALLOWED',
      `context "${c.name}" comes from ${denied.length > 1 ? 'the platforms' : 'the platform'} ${denied.map((d) => `"${platformName(d)}"`).join(', ')}, which "${name}" may not be sent – ${where}`,
    );
  if (sources.has(INPUT) && !allowed.inputs)
    throw new AiStepError('AI_DATA_NOT_ALLOWED', `context "${c.name}" may carry inputs of the run, which may not be sent to "${name}" – ${where}`);
  const datasets = [...sources].filter((x) => x.startsWith(DATASET)).map((x) => x.slice(DATASET.length));
  const deniedSets = datasets.filter((k) => !datasetAllowed(k, allowed.datasets));
  if (deniedSets.length)
    throw new AiStepError(
      'AI_DATA_NOT_ALLOWED',
      `context "${c.name}" may carry data of ${deniedSets.map((k) => (k === '*' ? 'every dataset ($systems(), $trend() or $daysUntil() of an unnamed dataset)' : `the dataset "${k}"`)).join(', ')}, which may not be sent to "${name}" – ${where}`,
    );
}

const serialize = (v: unknown): string => (typeof v === 'string' ? v : v === undefined ? '' : (JSON.stringify(v) ?? ''));

async function contextPart(c: AiContextSource, io: AiStepIo, settings: AiGatewaySettings): Promise<Part> {
  const allowed = settings.allowedData;
  const name = io.gateway.platform.name;
  let value: unknown;
  if (c.from === 'step') {
    const node = io.def.nodes.find((n) => n.id === c.step);
    if (!node) throw new AiStepError('AI_DATA_NOT_ALLOWED', `context "${c.name}": there is no step "${c.step}"`);
    // the variables read are checked – any step may have written them, so their recorded sources count, not the step's
    const names = resultVars(node);
    value = node.type === 'set' ? Object.fromEntries(names.map((k) => [k, io.vars[k] ?? null])) : node.saveAs ? io.vars[node.saveAs] : undefined;
    if (value !== undefined) checkSources(c, io.sourcesOf(names), io, allowed);
    if (value === undefined)
      throw new AiStepError('AI_DATA_NOT_ALLOWED', `context "${c.name}": step "${c.step}" has no result yet (did it run before this step?)`);
  } else if (c.from === 'dataset') {
    const key = c.dataset ?? '';
    if (!datasetAllowed(key, allowed.datasets))
      throw new AiStepError(
        'AI_DATA_NOT_ALLOWED',
        `context "${c.name}": the dataset "${key}" may not be sent to "${name}" – an administrator allows it under Platforms → ${name} → AI models → Allowed data`,
      );
    const cols = c.columns?.length ? new Set(c.columns) : null;
    value = io.datasetRows(key).map((r) => {
      const { _source: _s, ...row } = r;
      return cols ? Object.fromEntries(Object.entries(row).filter(([k]) => cols.has(k) || k === '_status' || k === '_reason')) : row;
    });
  } else {
    if (!allowed.inputs)
      throw new AiStepError(
        'AI_DATA_NOT_ALLOWED',
        `context "${c.name}": inputs of a run may not be sent to "${name}" – an administrator allows it under Platforms → ${name} → AI models → Allowed data`,
      );
    // a sub-process run's inputs come from its parent run
    checkSources(c, io.inputSources(), io, allowed);
    value = io.inputs[c.input ?? ''];
  }
  if (c.path?.trim()) value = await io.evalOn(c.path, value);
  const scrubbed = scrubForModel(value, io.secrets());
  const full = serialize(scrubbed.value);
  const max = c.maxChars ?? AI_LIMITS.contextChars.default;
  const cut = full.length > max;
  const text = cut ? `${full.slice(0, max)}\n[… ${full.length - max} more characters left out]` : full;
  return { name: c.name, text, chars: full.length, cut, removed: scrubbed.removed };
}

const platformName = (id: string): string => db().get<{ name: string }>('SELECT name FROM platforms WHERE id = ?', id)?.name ?? id;

/** The answer's JSON (a code fence and text around it are tolerated), checked against the schema. */
export function parseJsonAnswer(text: string, schema: Record<string, unknown>): { ok: true; value: unknown } | { ok: false; problem: string } {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [text.trim(), fenced?.[1]?.trim() ?? ''];
  const first = text.search(/[[{]/);
  const last = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  let value: unknown;
  let parsed = false;
  for (const c of candidates) {
    if (!c) continue;
    try {
      value = JSON.parse(c);
      parsed = true;
      break;
    } catch {
      /* the next candidate */
    }
  }
  if (!parsed) return { ok: false, problem: 'the answer is not JSON' };
  // checked when the process is saved; again here, so no saved schema can run a regular expression on an answer
  const unusable = jsonSchemaProblem(schema);
  if (unusable) return { ok: false, problem: `the JSON Schema cannot be used: ${unusable}` };
  const check = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]).safeParse(value);
  if (check.success) return { ok: true, value: check.data };
  const issues = check.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  return { ok: false, problem: `the answer does not match the JSON Schema – ${issues.join('; ')}` };
}

const jsonInstruction = (schema: unknown) => `Answer with JSON only – no other text, no code fence – that matches this JSON Schema:\n${JSON.stringify(schema)}`;

export async function runAiStep(step: NodeOf<'ai'>, io: AiStepIo): Promise<{ output: AiStepOutput; summary: string }> {
  const { platform, secrets } = io.gateway;
  if (platform.kind !== LLM_GATEWAY_KIND)
    throw new AiStepError(
      'AI_MODEL_UNKNOWN',
      `"${platform.name}" is a platform of kind ${platform.kind}; "Ask an AI model" needs one of kind ${LLM_GATEWAY_KIND}`,
    );
  const settings = gatewaySettings(platform);
  const model = settings.models.find((m) => m.id === step.model);
  const answerFormat = step.answer ?? 'text';
  const facts: CallFacts = {
    processId: io.processId,
    processName: io.processName,
    processVersion: io.processVersion,
    runId: io.runId,
    stepKey: io.stepKey,
    platformId: platform.id,
    platformName: platform.name,
    model: step.model,
    format: model?.format ?? 'chat-completions',
    estimatedInputTokens: 0,
    maxOutputTokens: 0,
    promptFingerprint: fingerprint(step.system, step.prompt, answerFormat, step.schema ? JSON.stringify(step.schema) : ''),
    inputFingerprint: '',
    actor: io.actor,
  };
  const refuse = (code: string, message: string, details?: Record<string, unknown>): never => {
    // dry runs and test runs send nothing: their refusals are shown in the run, not logged as calls
    if (!io.dryRun) refuseCall(facts, code, message, details);
    throw new AiStepError(code, message);
  };
  if (!model) return refuse('AI_MODEL_UNKNOWN', `the model "${step.model}" is not set up on "${platform.name}" (Platforms → ${platform.name} → AI models)`);

  // ---- context and prompt: only the sources the template uses are read and sent ----
  const used = new Set([...promptVariables(step.system).names, ...promptVariables(step.prompt).names]);
  const parts: Part[] = [];
  for (const c of step.context ?? []) {
    if (!used.has(c.name)) continue;
    try {
      parts.push(await contextPart(c, io, settings));
    } catch (e) {
      if (e instanceof AiStepError && e.code === 'AI_DATA_NOT_ALLOWED') return refuse(e.code, e.message.slice(e.code.length + 2));
      throw e;
    }
  }
  const values = Object.fromEntries(parts.map((p) => [p.name, p.text]));
  const system = [fillPrompt(step.system ?? '', values), answerFormat === 'json' && step.schema ? jsonInstruction(step.schema) : '']
    .filter(Boolean)
    .join('\n\n');
  const user = fillPrompt(step.prompt, values);
  facts.inputFingerprint = fingerprint(system, user);

  // ---- limits, before anything is sent ----
  const maxOut = Math.min(step.maxOutputTokens ?? model.maxOutputTokens, model.maxOutputTokens);
  const ceiling = modelInputCeiling(model);
  const maxIn = Math.min(step.maxInputTokens ?? ceiling, ceiling);
  const estimate = estimateTokens([system, user], model.charsPerToken);
  facts.estimatedInputTokens = estimate;
  facts.maxOutputTokens = maxOut;
  const adapter = ADAPTERS[model.format];
  const req = adapter.request(model, { system, user, maxOutputTokens: maxOut, temperature: step.temperature }, { anthropicVersion: settings.anthropicVersion });
  const removed = parts.reduce((n, p) => n + p.removed, 0);
  io.setInput({
    platform: platform.name,
    model: model.id,
    format: model.format,
    path: req.path,
    system,
    user,
    context: parts.map((p) => ({ name: p.name, chars: p.chars, cut: p.cut, removedSecrets: p.removed })),
    estimatedInputTokens: estimate,
    maxInputTokens: maxIn,
    maxOutputTokens: maxOut,
    ...(step.temperature !== undefined ? { temperature: step.temperature } : {}),
  });
  if (removed) io.log('info', `${removed} secret-looking value(s) removed from the context before sending`);
  if (estimate > maxIn)
    return refuse(
      'AI_INPUT_TOO_LARGE',
      `the input is estimated at ${estimate.toLocaleString('en')} tokens, more than the ${maxIn.toLocaleString('en')} allowed for one call – send less context (a path or columns, a smaller "most characters") or raise the step's or the model's input limit`,
      { maxInputTokens: maxIn },
    );
  if (estimate + maxOut > model.contextTokens)
    return refuse(
      'AI_OUTPUT_TOO_LARGE',
      `the estimated input (${estimate.toLocaleString('en')} tokens) and the most output (${maxOut.toLocaleString('en')}) do not fit into the context window of ${model.id} (${model.contextTokens.toLocaleString('en')})`,
    );

  const label = model.label || model.id;
  const base = {
    format: answerFormat,
    model: model.id,
    modelLabel: label,
    platform: platform.name,
    aiGenerated: true as const,
    marking: `AI-generated with ${label} – check it before you rely on it`,
    promptFingerprint: facts.promptFingerprint,
    inputFingerprint: facts.inputFingerprint,
    removedSecrets: removed,
  };

  // ---- dry runs and test runs: no call ----
  if (io.dryRun) {
    let res: HttpResult | null = null;
    if (io.recorded) {
      const hit = findRecording(platform.id, { method: 'POST', url: req.path, body: req.body });
      if (hit) {
        res = hit.result;
        io.log('info', `TEST RUN – recorded response for POST ${req.path} → HTTP ${res.status}`);
      } else if (step.sampleAnswer === undefined) throw missingRecording(platform.name, 'POST', req.path);
    }
    if (res && !(res.status >= 200 && res.status < 300))
      throw new AiStepError('AI_GATEWAY_ERROR', `HTTP ${res.status} (recorded): ${gatewayErrorText(res.body)}`);
    const a: AiAnswer = res
      ? adapter.answer(res.body)
      : {
          text: step.sampleAnswer ?? (answerFormat === 'json' ? 'null' : `[Dry run: ${label} was not asked]`),
          inputTokens: null,
          outputTokens: null,
          finish: 'stop',
          finishRaw: 'sample',
        };
    if (!res)
      io.log(
        'info',
        `${io.recorded ? 'TEST RUN' : 'DRY RUN'} – ${step.sampleAnswer !== undefined ? 'the sample answer is used' : 'the model is not asked'} instead of ${label}`,
      );
    const answer =
      answerFormat === 'json' && step.schema && (res || step.sampleAnswer !== undefined)
        ? checked(a.text, step.schema)
        : answerFormat === 'json'
          ? parseLoose(a.text)
          : a.text;
    return {
      output: {
        ...base,
        answer,
        text: a.text,
        usage: { inputTokens: a.inputTokens ?? 0, outputTokens: a.outputTokens ?? 0, estimatedInputTokens: estimate, cost: null },
        durationMs: 0,
        finishReason: a.finishRaw,
        truncated: a.finish === 'length',
        dryRun: true,
        ...(io.recorded ? { recorded: !!res } : {}),
        ...(!res ? { sample: step.sampleAnswer !== undefined } : {}),
      },
      summary: `${io.recorded ? 'TEST RUN' : 'DRY RUN'} – ${label} not asked (estimated input ${estimate.toLocaleString('en')} tokens)`,
    };
  }

  // ---- the call: reserve the worst case, send, count ----
  const reservation = reserveCall(facts);
  if ('refused' in reservation) throw new AiStepError('AI_BUDGET_EXHAUSTED', refusalText(reservation.refused));
  const started = Date.now();
  let res: HttpResult;
  try {
    await io.enforceOutbound(req.path, req.headers, req.body);
    res = await platformRequest(
      platform,
      secrets,
      {
        method: 'POST',
        url: req.path,
        headers: { ...req.headers, accept: 'application/json' },
        body: req.body,
        bodyType: 'json',
        maxResponseBytes: 20 * 1024 * 1024,
      },
      io.signal,
    );
  } catch (e) {
    // nothing may have reached the model, or all of the input: the estimate is counted, no output
    finishCall(reservation.id, facts, {
      result: 'failed',
      inputTokens: estimate,
      outputTokens: 0,
      durationMs: Date.now() - started,
      reason: 'AI_GATEWAY_ERROR',
      cost: null,
    });
    throw e;
  }
  const durationMs = Date.now() - started;
  if (!res.ok) {
    finishCall(reservation.id, facts, { result: 'failed', inputTokens: estimate, outputTokens: 0, durationMs, reason: `HTTP ${res.status}`, cost: null });
    throw new AiStepError('AI_GATEWAY_ERROR', `HTTP ${res.status} from POST ${req.path}: ${gatewayErrorText(res.body)}`);
  }
  let a: AiAnswer;
  try {
    a = adapter.answer(res.body);
  } catch (e) {
    finishCall(reservation.id, facts, { result: 'failed', inputTokens: estimate, outputTokens: 0, durationMs, reason: 'AI_GATEWAY_ERROR', cost: null });
    throw new AiStepError('AI_GATEWAY_ERROR', (e as Error).message);
  }
  const inputTokens = a.inputTokens ?? estimate;
  const outputTokens = a.outputTokens ?? estimateTokens([a.text], model.charsPerToken);
  const cost = modelCost(model, inputTokens, outputTokens);
  let answer: unknown = a.text;
  if (answerFormat === 'json' && step.schema) {
    const parsed = parseJsonAnswer(a.text, step.schema);
    if (!parsed.ok) {
      finishCall(reservation.id, facts, { result: 'invalid', inputTokens, outputTokens, durationMs, reason: 'AI_ANSWER_INVALID', cost });
      throw new AiStepError('AI_ANSWER_INVALID', `${parsed.problem}${a.finish === 'length' ? ' (the answer ended at the output limit)' : ''}`);
    }
    answer = parsed.value;
  }
  finishCall(reservation.id, facts, { result: 'ok', inputTokens, outputTokens, durationMs, cost });
  if (a.finish === 'length') io.log('warn', `The answer of ${label} ended at the output limit (${maxOut} tokens)`);
  return {
    output: {
      ...base,
      answer,
      text: a.text,
      usage: { inputTokens, outputTokens, estimatedInputTokens: estimate, cost },
      durationMs,
      finishReason: a.finishRaw,
      truncated: a.finish === 'length',
    },
    summary: `${label}: ${inputTokens.toLocaleString('en')} input and ${outputTokens.toLocaleString('en')} output tokens (${durationMs} ms)`,
  };
}

function checked(text: string, schema: Record<string, unknown>): unknown {
  const r = parseJsonAnswer(text, schema);
  if (!r.ok) throw new AiStepError('AI_ANSWER_INVALID', `${r.problem} (sample answer or recorded response)`);
  return r.value;
}

function parseLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
