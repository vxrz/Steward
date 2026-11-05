import { z, type ZodType } from 'zod';
import type { ReportLang } from '@sm/shared';
import { db } from '../db.js';
import { currentUser } from '../auth/context.js';
import { capabilities } from '../auth/permissions.js';
import { registerReportSection } from '../reports/sections.js';
import type { CellInput, Tone } from '../reports/pdf/engine.js';
import { listBudgets } from './usage.js';

/**
 * "AI usage" section of scheduled summary reports (0.6.0, docs/AI.md#reporting): calls and tokens of the report
 * period per gateway and model, the processes that used the most, refused and failed calls, and the budgets with
 * their use at the end of the period. A monthly schedule with this section is the monthly AI report. Collected with
 * the rights of the schedule's owner: administrators and auditors see the usage (like the usage log); for others
 * the section says so and shows nothing.
 */

const MAX_ROWS = 200;

const en = {
  title: 'AI usage',
  intro:
    'Calls of AI models through LLM gateways in the report period: tokens as the gateways reported them, costs from the prices set on the models. Refused calls were never sent (a budget, the input limit or the allowed data). The usage log holds no prompts and no answers – they are in the runs.',
  notAllowed: 'Only administrators and auditors see the AI usage.',
  byModel: 'By gateway and model',
  byProcess: 'Processes with the most tokens',
  refusedTitle: 'Refused and failed calls',
  budgets: 'Budgets',
  gateway: 'Gateway',
  model: 'Model',
  process: 'Process',
  calls: 'Calls',
  input: 'Input tokens',
  output: 'Output tokens',
  tokens: 'Tokens',
  cost: 'Cost',
  refused: 'Refused',
  failed: 'Failed',
  when: 'When',
  reason: 'Reason',
  scope: 'Budget',
  perDay: 'Per day',
  perMonth: 'Per month',
  usedMonth: 'Used this month',
  none: 'No AI model was called in the report period.',
  noRefusals: 'No call was refused or failed.',
  noBudgets: 'No budget is set.',
  connectionTests: 'Connection tests',
  installation: 'Installation',
  noLimit: 'no limit',
  totalTokens: 'Tokens',
  totalCalls: 'Calls',
};
type Texts = typeof en;
const de: Texts = {
  title: 'Nutzung von KI-Modellen',
  intro:
    'Aufrufe von KI-Modellen über LLM-Gateways im Berichtszeitraum: Tokens, wie die Gateways sie gemeldet haben, Kosten aus den an den Modellen hinterlegten Preisen. Abgelehnte Aufrufe wurden nie gesendet (ein Budget, die Eingabegrenze oder die erlaubten Daten). Das Nutzungsprotokoll enthält weder Prompts noch Antworten – sie stehen in den Ausführungen.',
  notAllowed: 'Nur Administratoren und Prüfer sehen die Nutzung von KI-Modellen.',
  byModel: 'Nach Gateway und Modell',
  byProcess: 'Prozesse mit den meisten Tokens',
  refusedTitle: 'Abgelehnte und fehlgeschlagene Aufrufe',
  budgets: 'Budgets',
  gateway: 'Gateway',
  model: 'Modell',
  process: 'Prozess',
  calls: 'Aufrufe',
  input: 'Eingabe-Tokens',
  output: 'Ausgabe-Tokens',
  tokens: 'Tokens',
  cost: 'Kosten',
  refused: 'Abgelehnt',
  failed: 'Fehlgeschlagen',
  when: 'Wann',
  reason: 'Grund',
  scope: 'Budget',
  perDay: 'Pro Tag',
  perMonth: 'Pro Monat',
  usedMonth: 'Diesen Monat verbraucht',
  none: 'Im Berichtszeitraum wurde kein KI-Modell aufgerufen.',
  noRefusals: 'Kein Aufruf wurde abgelehnt oder ist fehlgeschlagen.',
  noBudgets: 'Es ist kein Budget festgelegt.',
  connectionTests: 'Verbindungstests',
  installation: 'Installation',
  noLimit: 'keine Grenze',
  totalTokens: 'Tokens',
  totalCalls: 'Aufrufe',
};
const tx = (l: ReportLang): Texts => (l === 'de' ? de : en);

const schema = z.object({
  /** Gateways to include; null: all */
  platformIds: z.array(z.string().min(1).max(64)).max(100).nullable().default(null),
});
type AiConfig = z.infer<typeof schema>;

interface ModelRow {
  gateway: string;
  model: string;
  calls: number;
  input: number;
  output: number;
  cost: number | null;
}
interface ProcessRow {
  process: string;
  calls: number;
  tokens: number;
  cost: number | null;
}
interface RefusedRow {
  at: string;
  gateway: string;
  model: string;
  process: string;
  result: string;
  reason: string;
}
interface BudgetRow {
  scope: string;
  perDay: number | null;
  perMonth: number | null;
  usedMonth: number;
  state: string;
}

export interface AiSectionData {
  allowed: boolean;
  totals: { calls: number; refused: number; failed: number; tokens: number; cost: number | null };
  byModel: ModelRow[];
  byProcess: ProcessRow[];
  refused: RefusedRow[];
  budgets: BudgetRow[];
}

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

const n = (lang: ReportLang, v: number) => v.toLocaleString(lang);

registerReportSection<AiConfig, AiSectionData>({
  id: 'ai',
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
  title: (l) => tx(l).title,
  build,
  glance: (d, l) =>
    d.allowed
      ? [
          { label: tx(l).totalTokens, value: n(l, d.totals.tokens) },
          { label: tx(l).refused, value: String(d.totals.refused), tone: (d.totals.refused ? 'warning' : 'default') as Tone },
        ]
      : [],
  render: (d, { w, lang, section }) => {
    const x = tx(lang);
    section(x.title);
    if (!d.allowed) {
      w.paragraph(x.notAllowed, { tone: 'muted', size: 8 });
      return;
    }
    w.paragraph(x.intro, { tone: 'muted', size: 8 });
    w.stats([
      { label: x.totalCalls, value: n(lang, d.totals.calls) },
      { label: x.totalTokens, value: n(lang, d.totals.tokens) },
      { label: x.refused, value: n(lang, d.totals.refused), tone: d.totals.refused ? 'warning' : 'default' },
      { label: x.failed, value: n(lang, d.totals.failed), tone: d.totals.failed ? 'danger' : 'default' },
      ...(d.totals.cost !== null ? [{ label: x.cost, value: d.totals.cost.toLocaleString(lang, { minimumFractionDigits: 2 }) }] : []),
    ]);
    const cost = (v: number | null): CellInput => (v === null ? '–' : v.toLocaleString(lang, { minimumFractionDigits: 2 }));
    w.subheading(x.byModel);
    w.table(
      [
        { header: x.gateway, width: 2 },
        { header: x.model, width: 2.2, mono: true },
        { header: x.calls, width: 0.8 },
        { header: x.input, width: 1.2 },
        { header: x.output, width: 1.2 },
        { header: x.cost, width: 0.9 },
      ],
      d.byModel.map((r): CellInput[] => [r.gateway, r.model, n(lang, r.calls), n(lang, r.input), n(lang, r.output), cost(r.cost)]),
      { empty: x.none, size: 7.4 },
    );
    w.subheading(x.byProcess);
    w.table(
      [
        { header: x.process, width: 3.4 },
        { header: x.calls, width: 0.8 },
        { header: x.tokens, width: 1.2 },
        { header: x.cost, width: 0.9 },
      ],
      d.byProcess.map((r): CellInput[] => [{ text: r.process || x.connectionTests, bold: !!r.process }, n(lang, r.calls), n(lang, r.tokens), cost(r.cost)]),
      { empty: x.none, size: 7.4 },
    );
    w.subheading(x.refusedTitle, d.refused.length ? 'warning' : 'default');
    const date = (s: string) =>
      new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(new Date(s));
    w.table(
      [
        { header: x.when, width: 1.3 },
        { header: x.process, width: 2.4 },
        { header: x.model, width: 1.8, mono: true },
        { header: x.reason, width: 2 },
      ],
      d.refused.map((r): CellInput[] => [
        date(r.at),
        r.process || x.connectionTests,
        r.model,
        { text: `${r.result === 'refused' ? x.refused : x.failed}: ${r.reason}`, tone: r.result === 'refused' ? 'warning' : 'danger' },
      ]),
      { empty: x.noRefusals, size: 7.4 },
    );
    w.subheading(x.budgets);
    const limit = (v: number | null) => (v === null ? x.noLimit : n(lang, v));
    w.table(
      [
        { header: x.scope, width: 3 },
        { header: x.perDay, width: 1.2 },
        { header: x.perMonth, width: 1.2 },
        { header: x.usedMonth, width: 1.4 },
      ],
      d.budgets.map((b): CellInput[] => [
        b.scope || x.installation,
        limit(b.perDay),
        limit(b.perMonth),
        { text: n(lang, b.usedMonth), tone: b.state === 'exhausted' ? 'danger' : b.state === 'warning' ? 'warning' : 'default' },
      ]),
      { empty: x.noBudgets, size: 7.4 },
    );
  },
});
