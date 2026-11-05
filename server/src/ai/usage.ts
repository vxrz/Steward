import {
  AI_BUDGET_WARN_PCT,
  type AiBudgetInput,
  type AiBudgetScope,
  type AiBudgetUse,
  type AiCallResult,
  type AiFormat,
  type AiUsageEntry,
  type AiUsageOverview,
  type AiUsageTotals,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentActor, currentUser } from '../auth/context.js';
import { capabilities } from '../auth/permissions.js';
import { HttpError, newId, nowIso } from '../util.js';
import { permissionsFor } from '../processes/service.js';
import { emit } from '../events.js';

/**
 * The usage log and the token budgets of AI calls (docs/AI.md#limits, #reporting).
 *
 * Periods are calendar days and months in UTC. A budget counts input and output tokens of every call that was sent
 * (answered, failed or with an invalid answer) and of every call that is being sent: before it goes out, a call
 * reserves its worst case – the estimated input plus the most output it may get – in one transaction with the budget
 * check, so parallel steps cannot together go past a budget. When the answer comes the reservation becomes the counts
 * the gateway reported. A call is refused (AI_BUDGET_EXHAUSTED) when its worst case does not fit into what is left of
 * any budget that applies: the installation's, its gateway's and its process's, per day and per month.
 */

export const dayOf = (ts: string): string => ts.slice(0, 10);
export const monthOf = (ts: string): string => ts.slice(0, 7);

/** Results whose tokens count against budgets (refused calls were never sent). */
const COUNTED: AiCallResult[] = ['ok', 'failed', 'invalid', 'pending'];
const COUNTED_SQL = `result IN (${COUNTED.map((r) => `'${r}'`).join(', ')})`;

interface BudgetRow {
  scope: AiBudgetScope;
  scope_id: string;
  tokens_per_day: number | null;
  tokens_per_month: number | null;
  updated_at: string;
  updated_by: string;
}

interface UsageRow {
  id: string;
  ts: string;
  day: string;
  month: string;
  process_id: string | null;
  process_name: string | null;
  process_version: number | null;
  run_id: string | null;
  step_key: string | null;
  platform_id: string;
  platform_name: string;
  model: string;
  format: string;
  input_tokens: number;
  output_tokens: number;
  estimated_input_tokens: number;
  duration_ms: number;
  result: AiCallResult;
  reason: string;
  cost: number | null;
  prompt_fingerprint: string;
  input_fingerprint: string;
  actor: string;
}

const scopeColumn: Record<AiBudgetScope, string | null> = { installation: null, platform: 'platform_id', process: 'process_id' };

/** Tokens counted in a period for a scope. */
function used(scope: AiBudgetScope, scopeId: string, period: 'day' | 'month', key: string): number {
  const col = scopeColumn[scope];
  const r = db().get<{ n: number | null }>(
    `SELECT SUM(input_tokens + output_tokens) AS n FROM ai_usage WHERE ${period} = ? AND ${COUNTED_SQL}${col ? ` AND ${col} = ?` : ''}`,
    ...(col ? [key, scopeId] : [key]),
  );
  return Number(r?.n ?? 0);
}

function budgetRow(scope: AiBudgetScope, scopeId: string): BudgetRow | undefined {
  return db().get<BudgetRow>('SELECT * FROM ai_budgets WHERE scope = ? AND scope_id = ?', scope, scopeId);
}

function scopeName(scope: AiBudgetScope, id: string): string {
  if (scope === 'platform') return db().get<{ name: string }>('SELECT name FROM platforms WHERE id = ?', id)?.name ?? id;
  if (scope === 'process') return db().get<{ name: string }>('SELECT name FROM processes WHERE id = ?', id)?.name ?? id;
  return '';
}

/** A budget with its use today and this month. */
export function budgetUse(scope: AiBudgetScope, scopeId: string, now = nowIso()): AiBudgetUse {
  const b = budgetRow(scope, scopeId);
  const today = used(scope, scopeId, 'day', dayOf(now));
  const month = used(scope, scopeId, 'month', monthOf(now));
  const day = b?.tokens_per_day ?? null;
  const mon = b?.tokens_per_month ?? null;
  const full = (u: number, l: number | null) => l !== null && u >= l;
  const warn = (u: number, l: number | null) => l !== null && u * 100 >= l * AI_BUDGET_WARN_PCT;
  return {
    scope,
    scopeId,
    name: scopeName(scope, scopeId),
    tokensPerDay: day,
    tokensPerMonth: mon,
    usedToday: today,
    usedThisMonth: month,
    state: full(today, day) || full(month, mon) ? 'exhausted' : warn(today, day) || warn(month, mon) ? 'warning' : 'ok',
    updatedAt: b?.updated_at ?? null,
    updatedBy: b?.updated_by ?? null,
  };
}

/** Every budget that is set (administrators and auditors). */
export function listBudgets(): AiBudgetUse[] {
  const rows = db().all<BudgetRow>('SELECT * FROM ai_budgets ORDER BY scope, scope_id');
  const out = rows.map((r) => budgetUse(r.scope, r.scope_id));
  if (!rows.some((r) => r.scope === 'installation')) out.unshift(budgetUse('installation', ''));
  return out;
}

const raises = (from: number | null, to: number | null): boolean => (from === null ? false : to === null || to > from);

/** Whether this change raises a budget (more tokens, or no limit any more): it then needs a step-up (control point ai.budget). */
export function raisesBudget(input: Pick<AiBudgetInput, 'scope' | 'scopeId' | 'tokensPerDay' | 'tokensPerMonth'>): boolean {
  const b = budgetRow(input.scope, input.scopeId ?? '');
  return raises(b?.tokens_per_day ?? null, input.tokensPerDay) || raises(b?.tokens_per_month ?? null, input.tokensPerMonth);
}

/** Sets a budget (administrators; the route asks for the step-up when it raises one). Audited with the before and after. */
export function setBudget(input: {
  scope: AiBudgetScope;
  scopeId: string;
  tokensPerDay: number | null;
  tokensPerMonth: number | null;
  comment?: string;
}): AiBudgetUse {
  if (!capabilities(currentUser()).manageSettings) throw new HttpError(403, 'Only administrators change AI budgets', 'FORBIDDEN', { context: 'aiBudget' });
  if (input.scope !== 'installation') {
    const table = input.scope === 'platform' ? 'platforms' : 'processes';
    if (!db().get(`SELECT id FROM ${table} WHERE id = ?`, input.scopeId))
      throw new HttpError(
        404,
        `${input.scope === 'platform' ? 'Platform' : 'Process'} ${input.scopeId} not found`,
        input.scope === 'platform' ? 'PLATFORM_NOT_FOUND' : 'PROCESS_NOT_FOUND',
        {
          id: input.scopeId,
        },
      );
  }
  const before = budgetRow(input.scope, input.scopeId);
  const raised = raises(before?.tokens_per_day ?? null, input.tokensPerDay) || raises(before?.tokens_per_month ?? null, input.tokensPerMonth);
  const name = scopeName(input.scope, input.scopeId);
  const what = input.scope === 'installation' ? 'the installation' : `${input.scope} "${name}"`;
  const fmt = (n: number | null | undefined) => (n === null || n === undefined ? 'no limit' : n.toLocaleString('en'));
  const ts = nowIso();
  db().tx(() => {
    if (input.tokensPerDay === null && input.tokensPerMonth === null)
      db().run('DELETE FROM ai_budgets WHERE scope = ? AND scope_id = ?', input.scope, input.scopeId);
    else
      db().run(
        `INSERT INTO ai_budgets (scope, scope_id, tokens_per_day, tokens_per_month, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, scope_id) DO UPDATE SET tokens_per_day = excluded.tokens_per_day, tokens_per_month = excluded.tokens_per_month,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        input.scope,
        input.scopeId,
        input.tokensPerDay,
        input.tokensPerMonth,
        ts,
        currentActor(),
      );
    // a raised budget may warn again in this period
    if (raised) db().run('DELETE FROM ai_budget_notices WHERE scope = ? AND scope_id = ?', input.scope, input.scopeId);
    audit({
      action: 'ai.budget_changed',
      entityType: input.scope === 'installation' ? 'settings' : input.scope,
      entityId: input.scope === 'installation' ? 'ai.budget' : input.scopeId,
      summary: `AI budget of ${what} ${raised ? 'raised' : 'changed'}: ${fmt(input.tokensPerDay)} tokens a day, ${fmt(input.tokensPerMonth)} a month (was ${fmt(before?.tokens_per_day ?? null)} / ${fmt(before?.tokens_per_month ?? null)})`,
      details: {
        scope: input.scope,
        scopeId: input.scopeId,
        before: { tokensPerDay: before?.tokens_per_day ?? null, tokensPerMonth: before?.tokens_per_month ?? null },
        after: { tokensPerDay: input.tokensPerDay, tokensPerMonth: input.tokensPerMonth },
        raised,
        ...(input.comment ? { comment: input.comment } : {}),
      },
    });
  });
  emit('ai.usage', { platformId: input.scope === 'platform' ? input.scopeId : null });
  return budgetUse(input.scope, input.scopeId);
}

// ---------- calls ----------

export interface CallFacts {
  processId: string | null;
  processName: string | null;
  processVersion: number | null;
  runId: string | null;
  stepKey: string | null;
  platformId: string;
  platformName: string;
  model: string;
  format: AiFormat;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  promptFingerprint: string;
  inputFingerprint: string;
  actor: string;
}

export interface Refusal {
  scope: AiBudgetScope;
  scopeId: string;
  name: string;
  period: 'day' | 'month';
  limit: number;
  used: number;
  /** The worst case of the call */
  needed: number;
}

const refusalText = (r: Refusal): string =>
  `the ${r.period === 'day' ? 'daily' : 'monthly'} AI budget of ${r.scope === 'installation' ? 'the installation' : `${r.scope} "${r.name}"`} ` +
  `(${r.limit.toLocaleString('en')} tokens) has ${Math.max(0, r.limit - r.used).toLocaleString('en')} left; this call may need ${r.needed.toLocaleString('en')} ` +
  `(estimated input plus the most output) – it is refused until the ${r.period === 'day' ? 'day' : 'month'} ends (UTC) or an administrator raises the budget`;
export { refusalText };

/** The scopes a call is counted in. */
const scopesOf = (f: Pick<CallFacts, 'platformId' | 'processId'>): [AiBudgetScope, string][] => [
  ['installation', ''],
  ['platform', f.platformId],
  ...(f.processId ? ([['process', f.processId]] as [AiBudgetScope, string][]) : []),
];

/** The budget a call of this worst case would go past, if any (without reserving). */
export function budgetRefusal(f: Pick<CallFacts, 'platformId' | 'processId'>, needed: number, now = nowIso()): Refusal | null {
  for (const [scope, id] of scopesOf(f)) {
    const b = budgetRow(scope, id);
    if (!b) continue;
    for (const period of ['day', 'month'] as const) {
      const limit = period === 'day' ? b.tokens_per_day : b.tokens_per_month;
      if (limit === null) continue;
      const u = used(scope, id, period, period === 'day' ? dayOf(now) : monthOf(now));
      if (u + needed > limit) return { scope, scopeId: id, name: scopeName(scope, id), period, limit, used: u, needed };
    }
  }
  return null;
}

function insertRow(f: CallFacts, result: AiCallResult, input: number, output: number, reason: string, ts: string): string {
  const id = newId('aiu_');
  db().run(
    `INSERT INTO ai_usage (id, ts, day, month, process_id, process_name, process_version, run_id, step_key, platform_id, platform_name, model, format,
       input_tokens, output_tokens, estimated_input_tokens, duration_ms, result, reason, cost, prompt_fingerprint, input_fingerprint, actor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?, ?)`,
    id,
    ts,
    dayOf(ts),
    monthOf(ts),
    f.processId,
    f.processName,
    f.processVersion,
    f.runId,
    f.stepKey,
    f.platformId,
    f.platformName,
    f.model,
    f.format,
    input,
    output,
    f.estimatedInputTokens,
    result,
    reason,
    f.promptFingerprint,
    f.inputFingerprint,
    f.actor,
  );
  return id;
}

/**
 * Checks every budget and reserves the call's worst case in one transaction. Returns the reservation, or the refusal –
 * which is logged (result "refused") and audited.
 */
export function reserveCall(f: CallFacts): { id: string } | { refused: Refusal; id: string } {
  const needed = f.estimatedInputTokens + f.maxOutputTokens;
  const out = db().tx((): { id: string } | { refused: Refusal; id: string } => {
    const ts = nowIso();
    const refused = budgetRefusal(f, needed, ts);
    if (refused) return { refused, id: insertRow(f, 'refused', 0, 0, 'AI_BUDGET_EXHAUSTED', ts) };
    return { id: insertRow(f, 'pending', f.estimatedInputTokens, f.maxOutputTokens, '', ts) };
  });
  if ('refused' in out) {
    // a refusal of a budget is a refused call like any other: audited, and it can be the 100 % notice
    refusedCall(f, 'AI_BUDGET_EXHAUSTED', refusalText(out.refused), { budget: out.refused });
    checkNotices(f);
  }
  return out;
}

/** Logs and audits a call refused before it was sent for another reason (too large, data not allowed). */
export function refuseCall(f: CallFacts, reason: string, message: string, details: Record<string, unknown> = {}): void {
  insertRow(f, 'refused', 0, 0, reason, nowIso());
  refusedCall(f, reason, message, details);
}

function refusedCall(f: CallFacts, reason: string, message: string, details: Record<string, unknown>): void {
  audit({
    actor: f.actor || undefined,
    action: 'ai.call_refused',
    entityType: f.runId ? 'run' : 'platform',
    entityId: f.runId ?? f.platformId,
    ...(f.runId ? { runId: f.runId } : {}),
    summary: `AI call to ${f.model} on "${f.platformName}" refused (${reason}): ${message.slice(0, 400)}`,
    details: {
      reason,
      platformId: f.platformId,
      model: f.model,
      processId: f.processId,
      stepKey: f.stepKey,
      estimatedInputTokens: f.estimatedInputTokens,
      maxOutputTokens: f.maxOutputTokens,
      ...details,
    },
  });
  emit('ai.usage', { platformId: f.platformId });
}

/** The answer of a reserved call: the counts the gateway reported (else the estimate), its duration and result. */
export function finishCall(
  id: string,
  f: CallFacts,
  r: {
    result: Exclude<AiCallResult, 'pending' | 'refused'>;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    reason?: string;
    cost: number | null;
  },
): void {
  db().run(
    'UPDATE ai_usage SET input_tokens = ?, output_tokens = ?, duration_ms = ?, result = ?, reason = ?, cost = ? WHERE id = ?',
    r.inputTokens,
    r.outputTokens,
    r.durationMs,
    r.result,
    r.reason ?? '',
    r.cost,
    id,
  );
  emit('ai.usage', { platformId: f.platformId });
  checkNotices(f);
}

/**
 * Reservations of calls that never got an answer (the server stopped while waiting): after an hour they become
 * failed calls that keep their worst case – what they may have used. Returns how many.
 */
export function expireReservations(now = Date.now()): number {
  const before = new Date(now - 3600_000).toISOString();
  return db().run("UPDATE ai_usage SET result = 'failed', reason = 'AI_CALL_INTERRUPTED' WHERE result = 'pending' AND ts < ?", before).changes;
}

// ---------- notices ----------

type NoticeHook = (n: { use: AiBudgetUse; level: 80 | 100; period: 'day' | 'month' }) => void;
let noticeHook: NoticeHook | null = null;
/** The notification module sends the 80 % and 100 % notices (set at start-up, no import cycle). */
export function onBudgetNotice(fn: NoticeHook): void {
  noticeHook = fn;
}

/** Sends the 80 % and the 100 % notice of each budget of a call once per period. */
export function checkNotices(f: Pick<CallFacts, 'platformId' | 'processId'>, now = nowIso()): void {
  for (const [scope, id] of scopesOf(f)) {
    const u = budgetUse(scope, id, now);
    for (const period of ['day', 'month'] as const) {
      const limit = period === 'day' ? u.tokensPerDay : u.tokensPerMonth;
      if (!limit) continue;
      const spent = period === 'day' ? u.usedToday : u.usedThisMonth;
      const level: 80 | 100 | null = spent >= limit ? 100 : spent * 100 >= limit * AI_BUDGET_WARN_PCT ? 80 : null;
      if (!level) continue;
      const key = period === 'day' ? `day:${dayOf(now)}` : `month:${monthOf(now)}`;
      const fresh = db().run(
        'INSERT INTO ai_budget_notices (scope, scope_id, period, level, sent_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
        scope,
        id,
        key,
        level,
        now,
      ).changes;
      if (fresh) noticeHook?.({ use: u, level, period });
    }
  }
}

// ---------- reading ----------

const toEntry = (r: UsageRow, showProcess: (id: string) => boolean): AiUsageEntry => {
  const shown = !r.process_id || showProcess(r.process_id);
  return {
    id: r.id,
    at: r.ts,
    processId: shown ? r.process_id : null,
    processName: shown ? r.process_name : null,
    processVersion: shown ? r.process_version : null,
    runId: shown ? r.run_id : null,
    stepKey: shown ? r.step_key : null,
    platformId: r.platform_id,
    platformName: r.platform_name,
    model: r.model,
    format: r.format as AiFormat,
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    estimatedInputTokens: Number(r.estimated_input_tokens),
    durationMs: Number(r.duration_ms),
    result: r.result,
    reason: r.reason,
    cost: r.cost === null ? null : Number(r.cost),
    promptFingerprint: r.prompt_fingerprint,
    inputFingerprint: r.input_fingerprint,
    actor: shown ? r.actor : '',
  };
};

/** Whether the reader may see a process's name in the usage (internal readers and auditors: always). */
function processVisibility(): (id: string) => boolean {
  const u = currentUser();
  if (!u || capabilities(u).viewAudit) return () => true;
  const cache = new Map<string, boolean>();
  return (id) => {
    let v = cache.get(id);
    if (v === undefined) cache.set(id, (v = permissionsFor(id).includes('view')));
    return v;
  };
}

const roundCost = (n: number | null): number | null => (n === null ? null : Math.round(n * 10000) / 10000);

function totals(where: string, params: unknown[]): AiUsageTotals {
  const r = db().get<{ calls: number; refused: number; failed: number; i: number | null; o: number | null; cost: number | null; priced: number }>(
    `SELECT SUM(CASE WHEN result <> 'refused' THEN 1 ELSE 0 END) AS calls, SUM(CASE WHEN result = 'refused' THEN 1 ELSE 0 END) AS refused,
            SUM(CASE WHEN result IN ('failed', 'invalid') THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN ${COUNTED_SQL} THEN input_tokens ELSE 0 END) AS i, SUM(CASE WHEN ${COUNTED_SQL} THEN output_tokens ELSE 0 END) AS o,
            SUM(cost) AS cost, SUM(CASE WHEN cost IS NOT NULL THEN 1 ELSE 0 END) AS priced
       FROM ai_usage WHERE ${where}`,
    ...params,
  );
  return {
    calls: Number(r?.calls ?? 0),
    refused: Number(r?.refused ?? 0),
    failed: Number(r?.failed ?? 0),
    inputTokens: Number(r?.i ?? 0),
    outputTokens: Number(r?.o ?? 0),
    cost: Number(r?.priced ?? 0) > 0 ? roundCost(Number(r?.cost ?? 0)) : null,
  };
}

/** The platform page's usage: budgets, totals, top processes, models and the latest calls (readers of the platform). */
export function usageOverview(platformId: string, now = nowIso()): AiUsageOverview {
  const show = processVisibility();
  const day = dayOf(now);
  const month = monthOf(now);
  const top = db().all<{ process_id: string | null; process_name: string | null; calls: number; tokens: number; cost: number | null; priced: number }>(
    `SELECT process_id, MAX(process_name) AS process_name, COUNT(*) AS calls, SUM(input_tokens + output_tokens) AS tokens, SUM(cost) AS cost,
            SUM(CASE WHEN cost IS NOT NULL THEN 1 ELSE 0 END) AS priced
       FROM ai_usage WHERE platform_id = ? AND month = ? AND ${COUNTED_SQL} GROUP BY process_id ORDER BY tokens DESC`,
    platformId,
    month,
  );
  const topProcesses: AiUsageOverview['topProcesses'] = [];
  let hidden: AiUsageOverview['topProcesses'][number] | null = null;
  for (const r of top) {
    const row = { calls: Number(r.calls), tokens: Number(r.tokens ?? 0), cost: Number(r.priced) > 0 ? roundCost(Number(r.cost ?? 0)) : null };
    if (!r.process_id) topProcesses.push({ processId: null, name: 'Connection tests', ...row });
    else if (show(r.process_id)) topProcesses.push({ processId: r.process_id, name: r.process_name ?? r.process_id, ...row });
    else {
      hidden ??= { processId: null, name: 'Other processes', calls: 0, tokens: 0, cost: null };
      hidden.calls += row.calls;
      hidden.tokens += row.tokens;
      if (row.cost !== null) hidden.cost = roundCost((hidden.cost ?? 0) + row.cost);
    }
  }
  if (hidden) topProcesses.push(hidden);
  topProcesses.sort((a, b) => b.tokens - a.tokens);
  const byModel = db()
    .all<{ model: string; format: string; calls: number; i: number; o: number; cost: number | null; priced: number }>(
      `SELECT model, MAX(format) AS format, COUNT(*) AS calls, SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(cost) AS cost,
              SUM(CASE WHEN cost IS NOT NULL THEN 1 ELSE 0 END) AS priced
         FROM ai_usage WHERE platform_id = ? AND month = ? AND ${COUNTED_SQL} GROUP BY model ORDER BY model`,
      platformId,
      month,
    )
    .map((r) => ({
      model: r.model,
      format: r.format as AiFormat,
      calls: Number(r.calls),
      inputTokens: Number(r.i ?? 0),
      outputTokens: Number(r.o ?? 0),
      cost: Number(r.priced) > 0 ? roundCost(Number(r.cost ?? 0)) : null,
    }));
  const recent = db()
    .all<UsageRow>('SELECT * FROM ai_usage WHERE platform_id = ? ORDER BY ts DESC, id DESC LIMIT 50', platformId)
    .map((r) => toEntry(r, show));
  return {
    platformId,
    day,
    month,
    budgets: [budgetUse('installation', '', now), budgetUse('platform', platformId, now)],
    today: totals('platform_id = ? AND day = ?', [platformId, day]),
    thisMonth: totals('platform_id = ? AND month = ?', [platformId, month]),
    topProcesses: topProcesses.slice(0, 10),
    byModel,
    recent,
    canEditBudgets: capabilities(currentUser()).manageSettings,
  };
}

/** The usage log in a time range (administrators and auditors; report sections, the dataset). */
export function usageEntries(f: { from?: string; to?: string; platformId?: string; processId?: string; limit?: number } = {}): AiUsageEntry[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.from) where.push('ts >= ?') && params.push(f.from);
  if (f.to) where.push('ts < ?') && params.push(f.to);
  if (f.platformId) where.push('platform_id = ?') && params.push(f.platformId);
  if (f.processId) where.push('process_id = ?') && params.push(f.processId);
  const show = processVisibility();
  return db()
    .all<UsageRow>(
      `SELECT * FROM ai_usage${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ts DESC, id DESC LIMIT ?`,
      ...params,
      Math.min(f.limit ?? 1000, 10_000),
    )
    .map((r) => toEntry(r, show));
}

/** Retention of the usage log (SM_AI_USAGE_RETENTION_DAYS). */
export function pruneUsage(days: number, now = Date.now()): number {
  return db().run('DELETE FROM ai_usage WHERE ts < ?', new Date(now - days * 86400_000).toISOString()).changes;
}
