import { AI_USAGE_DATASET, type DatasetRow, type DatasetStatus, type MetricLimit } from '@sm/shared';
import { db } from '../db.js';
import { on } from '../events.js';
import { publishDataset } from '../dashboards/datasets.js';
import { dayOf, monthOf } from './usage.js';

/**
 * The built-in dataset "AI usage" (`ai.usage`, docs/AI.md#reporting): one row per gateway, model and process with
 * this month's calls and tokens, and the metrics tokensToday, tokensThisMonth, callsToday, refusedToday and
 * costThisMonth – with the installation's budgets as their limits, so dashboards forecast when a budget runs out.
 * Published by the job "ai-usage" (at most every few minutes after calls, and at least hourly for the new day).
 * Visible to administrators and auditors (dashboards/builtin.ts), like the usage log.
 */

const COLUMNS = ['Gateway', 'Model', 'Process', 'Calls', 'Refused', 'Failed', 'Input tokens', 'Output tokens', 'Tokens', 'Cost'];
let dirty = true;
let lastPublished = 0;

export function initAiUsageDataset(): void {
  on('ai.usage', () => {
    dirty = true;
  });
}

/** Publishes the dataset when calls changed it, or once an hour (a new day or month). Returns whether it did. */
export function publishUsageDataset(force = false, now = Date.now()): boolean {
  if (!force && !dirty && now - lastPublished < 3600_000) return false;
  // nothing to show yet: no dataset (the dashboard says "no data yet")
  if (!db().get('SELECT id FROM ai_usage LIMIT 1') && !db().get('SELECT key FROM datasets WHERE key = ?', AI_USAGE_DATASET)) return false;
  dirty = false;
  lastPublished = now;
  const ts = new Date(now).toISOString();
  const day = dayOf(ts);
  const month = monthOf(ts);
  const rows = db().all<{
    platform_name: string;
    model: string;
    process_name: string | null;
    calls: number;
    refused: number;
    failed: number;
    i: number | null;
    o: number | null;
    cost: number | null;
    priced: number;
  }>(
    `SELECT MAX(platform_name) AS platform_name, model, MAX(process_name) AS process_name,
            SUM(CASE WHEN result <> 'refused' THEN 1 ELSE 0 END) AS calls, SUM(CASE WHEN result = 'refused' THEN 1 ELSE 0 END) AS refused,
            SUM(CASE WHEN result IN ('failed', 'invalid') THEN 1 ELSE 0 END) AS failed,
            SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(cost) AS cost, SUM(CASE WHEN cost IS NOT NULL THEN 1 ELSE 0 END) AS priced
       FROM ai_usage WHERE month = ? GROUP BY platform_id, model, process_id ORDER BY platform_id, model, process_id`,
    month,
  );
  const out: DatasetRow[] = rows.map((r) => {
    const refused = Number(r.refused);
    const failed = Number(r.failed);
    const status: DatasetStatus = refused ? 'serious' : failed ? 'warning' : 'good';
    const input = Number(r.i ?? 0);
    const output = Number(r.o ?? 0);
    return {
      Gateway: r.platform_name,
      Model: r.model,
      Process: r.process_name ?? 'Connection tests',
      Calls: Number(r.calls),
      Refused: refused,
      Failed: failed,
      'Input tokens': input,
      'Output tokens': output,
      Tokens: input + output,
      Cost: Number(r.priced) > 0 ? Math.round(Number(r.cost ?? 0) * 1_000_000) / 1_000_000 : null,
      _key: `${r.platform_name}/${r.model}/${r.process_name ?? ''}`,
      _status: status,
      _reason: refused ? `${refused} call(s) refused this month` : failed ? `${failed} call(s) failed this month` : '',
    };
  });
  const counted = "result IN ('ok', 'failed', 'invalid', 'pending')";
  const sum = (where: string, ...p: unknown[]) =>
    Number(db().get<{ n: number | null }>(`SELECT SUM(input_tokens + output_tokens) AS n FROM ai_usage WHERE ${where} AND ${counted}`, ...p)?.n ?? 0);
  const count = (where: string, ...p: unknown[]) => Number(db().get<{ n: number }>(`SELECT COUNT(*) AS n FROM ai_usage WHERE ${where}`, ...p)?.n ?? 0);
  const cost = db().get<{ c: number | null }>('SELECT SUM(cost) AS c FROM ai_usage WHERE month = ?', month)?.c;
  const metrics: Record<string, number> = {
    tokensToday: sum('day = ?', day),
    tokensThisMonth: sum('month = ?', month),
    callsToday: count("day = ? AND result <> 'refused'", day),
    refusedToday: count("day = ? AND result = 'refused'", day),
    ...(cost !== null && cost !== undefined ? { costThisMonth: Math.round(Number(cost) * 100) / 100 } : {}),
  };
  const budget = db().get<{ tokens_per_day: number | null; tokens_per_month: number | null }>(
    "SELECT tokens_per_day, tokens_per_month FROM ai_budgets WHERE scope = 'installation' AND scope_id = ''",
  );
  const limits: Record<string, MetricLimit> = {};
  if (budget?.tokens_per_day) limits.tokensToday = { value: Number(budget.tokens_per_day), lower: false };
  if (budget?.tokens_per_month) limits.tokensThisMonth = { value: Number(budget.tokens_per_month), lower: false };
  publishDataset({
    key: AI_USAGE_DATASET,
    title: 'AI usage',
    processId: 'ai:usage',
    processName: 'AI usage (built in)',
    runId: '',
    dryRun: false,
    columns: COLUMNS,
    rows: out,
    metrics,
    limits,
    // published at least hourly
    staleAfterMinutes: 180,
    staleAfterFixed: true,
  });
  return true;
}

/** The job "ai-usage": reservations without an answer, retention, the dataset. */
export async function runAiUsageJob(retentionDays: number): Promise<{ expired: number; pruned: number; published: boolean }> {
  const { expireReservations, pruneUsage } = await import('./usage.js');
  const expired = expireReservations();
  const pruned = pruneUsage(retentionDays);
  if (expired) dirty = true;
  return { expired, pruned, published: publishUsageDataset() };
}
