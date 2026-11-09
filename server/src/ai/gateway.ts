import {
  AI_MODELS_PATH,
  LLM_GATEWAY_KIND,
  aiGatewaySettingsSchema,
  emptyAiSettings,
  suggestFormat,
  type AiDiscoveredModel,
  type AiGatewaySettings,
  type AiGatewaySettingsInput,
  type AiModel,
  type Platform,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentActor } from '../auth/context.js';
import { HttpError, nowIso } from '../util.js';
import { getPlatform, storedConfig } from '../platforms/service.js';
import { requirePlatformIntact, sealPlatform } from '../platforms/integrity.js';
import { invalidatePlatformCaches, platformRequest } from '../platforms/http.js';
import { ADAPTERS, gatewayErrorText, modelList } from './formats.js';
import { estimateTokens } from './estimate.js';
import { finishCall, refusalText, reserveCall, type CallFacts } from './usage.js';

/**
 * The AI settings of an LLM gateway platform (`config.ai`, docs/AI.md#set-up): its models with their format and
 * limits, and the data it may be sent. They are part of the platform's sealed connection settings and change only here
 * (PUT /api/platforms/:id/ai, the platform's "manage" right, audited) – the general settings form keeps them.
 */

/** The settings of a platform (empty when none or unreadable – a sealed platform cannot hold invalid ones). */
export function gatewaySettings(p: Pick<Platform, 'config'>): AiGatewaySettings {
  const raw = (p.config as { ai?: unknown }).ai;
  if (!raw) return emptyAiSettings();
  const r = aiGatewaySettingsSchema.safeParse(raw);
  return r.success ? r.data : emptyAiSettings();
}

/** The price of a call from the model's prices (null without any). */
export function modelCost(m: Pick<AiModel, 'priceInputPer1k' | 'priceOutputPer1k'>, input: number, output: number): number | null {
  if (m.priceInputPer1k === undefined && m.priceOutputPer1k === undefined) return null;
  return Math.round((((m.priceInputPer1k ?? 0) * input) / 1000 + ((m.priceOutputPer1k ?? 0) * output) / 1000) * 1_000_000) / 1_000_000;
}

const requireGateway = (p: Platform) => {
  if (p.kind !== LLM_GATEWAY_KIND) throw new HttpError(400, `"${p.name}" is not an LLM gateway (kind ${p.kind})`, 'AI_NOT_A_GATEWAY', { name: p.name });
};

/** Saves the models and the allowed data (the route checked "manage"). */
export function setGatewaySettings(id: string, input: AiGatewaySettingsInput): Platform {
  const before = getPlatform(id);
  requireGateway(before);
  requirePlatformIntact(id);
  const next = aiGatewaySettingsSchema.parse(input);
  const prev = gatewaySettings(before);
  const ids = (s: AiGatewaySettings) => s.models.map((m) => m.id);
  const added = ids(next).filter((m) => !ids(prev).includes(m));
  const removed = ids(prev).filter((m) => !ids(next).includes(m));
  const dataChanged = JSON.stringify(prev.allowedData) !== JSON.stringify(next.allowedData);
  db().tx(() => {
    db().run('UPDATE platforms SET config = ?, updated_at = ? WHERE id = ?', JSON.stringify({ ...storedConfig(id), ai: next }), nowIso(), id);
    audit({
      action: 'platform.ai_changed',
      entityType: 'platform',
      entityId: id,
      summary:
        `AI settings of "${before.name}" changed: ${next.models.length} model(s)` +
        (added.length ? `, added ${added.join(', ')}` : '') +
        (removed.length ? `, removed ${removed.join(', ')}` : '') +
        (dataChanged ? ' – allowed data changed' : ''),
      details: { models: next.models, allowedData: next.allowedData, previousAllowedData: prev.allowedData, added, removed },
    });
    sealPlatform(id);
  });
  invalidatePlatformCaches(id);
  return getPlatform(id);
}

/** The models the gateway lists (GET /v1/models), with a suggested format and whether they are set up already. */
export async function discoverModels(p: Platform, secrets: Record<string, string>): Promise<AiDiscoveredModel[]> {
  requireGateway(p);
  const s = gatewaySettings(p);
  const path = s.modelsPath || AI_MODELS_PATH;
  const res = await platformRequest(p, secrets, { method: 'GET', url: path, truncateResponseBytes: 5 * 1024 * 1024 });
  if (!res.ok)
    throw new HttpError(502, `GET ${path} answered HTTP ${res.status}: ${gatewayErrorText(res.body)}`, 'AI_MODEL_LIST_FAILED', { status: res.status, path });
  const configured = new Set(s.models.map((m) => m.id));
  return modelList(res.body)
    .slice(0, 500)
    .map((m) => ({ ...m, suggestedFormat: suggestFormat(m.id), configured: configured.has(m.id) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export interface GatewayTestResult {
  ok: boolean;
  message: string;
  checks: { name: string; ok: boolean; message: string }[];
}

/**
 * The connection test of a gateway: the model list, then one minimal request per model that is set up ("Reply with
 * OK", at most 16 output tokens). The requests are real calls: logged in the usage and counted against the budgets –
 * a model whose budget is used up is not asked.
 */
export async function testGateway(p: Platform, secrets: Record<string, string>): Promise<GatewayTestResult> {
  const s = gatewaySettings(p);
  const checks: GatewayTestResult['checks'] = [];
  const path = s.modelsPath || AI_MODELS_PATH;
  let listed: string[] | null = null;
  try {
    const res = await platformRequest(p, secrets, { method: 'GET', url: path, truncateResponseBytes: 5 * 1024 * 1024 });
    if (res.ok) {
      listed = modelList(res.body).map((m) => m.id);
      const missing = s.models.filter((m) => !listed!.includes(m.id)).map((m) => m.id);
      checks.push({
        name: `Model list (GET ${path})`,
        ok: true,
        message:
          `${listed.length} model(s) listed` +
          (s.models.length
            ? missing.length
              ? `; not listed: ${missing.join(', ')} (a gateway may not list every model)`
              : '; every model set up is listed'
            : ''),
      });
    } else
      checks.push({
        name: `Model list (GET ${path})`,
        // a gateway without a model list still works with models entered by hand
        ok: res.status === 404 && s.models.length > 0,
        message: `HTTP ${res.status}: ${gatewayErrorText(res.body)}`,
      });
  } catch (e) {
    checks.push({ name: `Model list (GET ${path})`, ok: false, message: (e as Error).message });
  }
  for (const m of s.models) {
    const adapter = ADAPTERS[m.format];
    const maxOut = Math.min(16, m.maxOutputTokens);
    const req = adapter.request(m, { system: '', user: 'Reply with OK.', maxOutputTokens: maxOut }, { anthropicVersion: s.anthropicVersion });
    const estimate = estimateTokens(['Reply with OK.'], m.charsPerToken);
    const facts: CallFacts = {
      processId: null,
      processName: null,
      processVersion: null,
      runId: null,
      stepKey: 'connection-test',
      platformId: p.id,
      platformName: p.name,
      model: m.id,
      format: m.format,
      estimatedInputTokens: estimate,
      maxOutputTokens: maxOut,
      promptFingerprint: '',
      inputFingerprint: '',
      actor: currentActor(),
    };
    const name = `${m.label || m.id} (${m.format})`;
    const reservation = reserveCall(facts);
    if ('refused' in reservation) {
      checks.push({ name, ok: false, message: `not asked: ${refusalText(reservation.refused)}` });
      continue;
    }
    const t0 = Date.now();
    try {
      const res = await platformRequest(p, secrets, {
        method: 'POST',
        url: req.path,
        headers: req.headers,
        body: req.body,
        bodyType: 'json',
        maxResponseBytes: 1024 * 1024,
        // an LLM call reads (ADR 0009: a read-only identity lets it through)
        intent: 'read',
      });
      const durationMs = Date.now() - t0;
      if (!res.ok) {
        finishCall(reservation.id, facts, { result: 'failed', inputTokens: estimate, outputTokens: 0, durationMs, reason: `HTTP ${res.status}`, cost: null });
        checks.push({ name, ok: false, message: `POST ${req.path} → HTTP ${res.status}: ${gatewayErrorText(res.body)}` });
        continue;
      }
      const a = adapter.answer(res.body);
      const input = a.inputTokens ?? estimate;
      const output = a.outputTokens ?? estimateTokens([a.text], m.charsPerToken);
      finishCall(reservation.id, facts, { result: 'ok', inputTokens: input, outputTokens: output, durationMs, cost: modelCost(m, input, output) });
      const reported = a.inputTokens !== null && a.outputTokens !== null;
      checks.push({
        name,
        ok: true,
        message: `answered in ${durationMs} ms – ${input} input and ${output} output tokens${reported ? '' : ' (estimated: the gateway reported no usage)'}`,
      });
    } catch (e) {
      finishCall(reservation.id, facts, {
        result: 'failed',
        inputTokens: estimate,
        outputTokens: 0,
        durationMs: Date.now() - t0,
        reason: 'AI_GATEWAY_ERROR',
        cost: null,
      });
      checks.push({ name, ok: false, message: (e as Error).message });
    }
  }
  const failed = checks.filter((c) => !c.ok);
  const ok = failed.length === 0 && (s.models.length > 0 || listed !== null);
  const message = !s.models.length
    ? listed !== null
      ? `The gateway answers and lists ${listed.length} model(s) – add the models processes may use under AI models`
      : 'The gateway does not answer with a model list – check the base URL and the API key, or add models by hand under AI models'
    : ok
      ? `Every model set up answers (${s.models.length})`
      : `${failed.length} of ${checks.length} checks failed`;
  return { ok, message, checks };
}
