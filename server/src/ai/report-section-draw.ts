import type { ReportLang } from '@sm/shared';
import type { CellInput, Tone } from '../reports/pdf/engine.js';
import type { ReportSectionDraw } from '../reports/section-draw.js';

/**
 * The draw half of the section of scheduled summary reports in report-section.ts (which collects its data): data
 * in, PDF out – it runs in the PDF worker (reports/section-draw.ts).
 */

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

const n = (lang: ReportLang, v: number) => v.toLocaleString(lang);

export const aiSectionDraw: ReportSectionDraw<AiSectionData> = {
  id: 'ai',
  title: (l) => tx(l).title,
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
};
