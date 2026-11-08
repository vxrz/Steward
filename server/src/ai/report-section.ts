import { z, type ZodType } from 'zod';
import { db } from '../db.js';
import { currentUser } from '../auth/context.js';
import { capabilities } from '../auth/permissions.js';
import { listBudgets } from './usage.js';
import type { ReportSectionDef } from '../reports/sections.js';
import { aiSectionDraw, type AiSectionData } from './report-section-draw.js';

/**
 * "AI usage" section of scheduled summary reports (0.6.0, docs/AI.md#reporting): calls and tokens of the report
 * period per gateway and model, the processes that used the most, refused and failed calls, and the budgets with
 * their use at the end of the period. A monthly schedule with this section is the monthly AI report. Collected with
 * the rights of the schedule's owner: administrators and auditors see the usage (like the usage log); for others
 * the section says so and shows nothing.
 */

const MAX_ROWS = 200;

const schema = z.object({
  /** Gateways to include; null: all */
  platformIds: z.array(z.string().min(1).max(64)).max(100).nullable().default(null),
});

type AiConfig = z.infer<typeof schema>;

const COUNTED = "result IN ('ok', 'failed', 'invalid', 'pending')";

const iso = (t: number) => new Date(t).toISOString();

function build(c: AiConfig, ctx: { from: number; to: number }): AiSectionData {
  const empty: AiSectionData = {
    allowed: false,
    totals: { calls: 0, refused: 0, failed: 0, tokens: 0, cost: null },
    byModel: [],
    byProcess: [],
    refused: [],
    budgets: [],
  };
  if (!capabilities(currentUser()).viewAudit) return empty;
  const where = ['ts >= ?', 'ts < ?'];
  const params: unknown[] = [iso(ctx.from), iso(ctx.to)];
  if (c.platformIds?.length) {
    where.push(`platform_id IN (${c.platformIds.map(() => '?').join(', ')})`);
    params.push(...c.platformIds);
  }
  const w = where.join(' AND ');
  const priced = (cost: number | null, n: number) => (Number(n) > 0 ? Math.round(Number(cost ?? 0) * 100) / 100 : null);
  const byModel = db()
    .all<{ gateway: string; model: string; calls: number; i: number; o: number; cost: number | null; n: number }>(
      `SELECT MAX(platform_name) AS gateway, model, COUNT(*) AS calls, SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(cost) AS cost,
              SUM(CASE WHEN cost IS NOT NULL THEN 1 ELSE 0 END) AS n
         FROM ai_usage WHERE ${w} AND ${COUNTED} GROUP BY platform_id, model ORDER BY gateway, model`,
      ...params,
    )
    .map((r) => ({ gateway: r.gateway, model: r.model, calls: Number(r.calls), input: Number(r.i ?? 0), output: Number(r.o ?? 0), cost: priced(r.cost, r.n) }));
  const byProcess = db()
    .all<{ process: string | null; calls: number; tokens: number; cost: number | null; n: number }>(
      `SELECT MAX(process_name) AS process, COUNT(*) AS calls, SUM(input_tokens + output_tokens) AS tokens, SUM(cost) AS cost,
              SUM(CASE WHEN cost IS NOT NULL THEN 1 ELSE 0 END) AS n
         FROM ai_usage WHERE ${w} AND ${COUNTED} GROUP BY process_id ORDER BY tokens DESC LIMIT 20`,
      ...params,
    )
    .map((r) => ({ process: r.process ?? '', calls: Number(r.calls), tokens: Number(r.tokens ?? 0), cost: priced(r.cost, r.n) }));
  const refused = db()
    .all<{ ts: string; platform_name: string; model: string; process_name: string | null; result: string; reason: string }>(
      `SELECT ts, platform_name, model, process_name, result, reason FROM ai_usage WHERE ${w} AND result IN ('refused', 'failed', 'invalid') ORDER BY ts DESC LIMIT ${MAX_ROWS}`,
      ...params,
    )
    .map((r) => ({ at: r.ts, gateway: r.platform_name, model: r.model, process: r.process_name ?? '', result: r.result, reason: r.reason }));
  const t = db().get<{ calls: number; refused: number; failed: number; tokens: number | null; cost: number | null; n: number }>(
    `SELECT SUM(CASE WHEN result <> 'refused' THEN 1 ELSE 0 END) AS calls, SUM(CASE WHEN result = 'refused' THEN 1 ELSE 0 END) AS refused,
            SUM(CASE WHEN result IN ('failed', 'invalid') THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN ${COUNTED} THEN input_tokens + output_tokens ELSE 0 END) AS tokens, SUM(cost) AS cost,
            SUM(CASE WHEN cost IS NOT NULL THEN 1 ELSE 0 END) AS n FROM ai_usage WHERE ${w}`,
    ...params,
  );
  const budgets = listBudgets()
    .filter((b) => !c.platformIds?.length || b.scope !== 'platform' || c.platformIds.includes(b.scopeId))
    .map((b) => ({
      scope: b.scope === 'installation' ? '' : `${b.scope}: ${b.name}`,
      perDay: b.tokensPerDay,
      perMonth: b.tokensPerMonth,
      usedMonth: b.usedThisMonth,
      state: b.state,
    }))
    .filter((b) => b.perDay !== null || b.perMonth !== null);
  return {
    allowed: true,
    totals: {
      calls: Number(t?.calls ?? 0),
      refused: Number(t?.refused ?? 0),
      failed: Number(t?.failed ?? 0),
      tokens: Number(t?.tokens ?? 0),
      cost: priced(t?.cost ?? null, t?.n ?? 0),
    },
    byModel,
    byProcess,
    refused,
    budgets,
  };
}

export const aiSection: ReportSectionDef<AiConfig, AiSectionData> = {
  ...aiSectionDraw,
  schema: schema as unknown as ZodType<AiConfig>,
  validate: (c) => {
    if (!c.platformIds) return;
    const known = new Set(
      db()
        .all<{ id: string }>("SELECT id FROM platforms WHERE kind = 'llm-gateway'")
        .map((p) => p.id),
    );
    const missing = c.platformIds.filter((x) => !known.has(x));
    if (missing.length) throw Object.assign(new Error(`LLM gateway(s) not found: ${missing.join(', ')}`), { statusCode: 400 });
  },
  build,
};
