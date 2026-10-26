import { z, type ZodType } from 'zod';
import { OBJECTIVE_WINDOWS, SCORECARD_PARTS, type ObjectiveStatus, type ReportLang, type ScorecardPart, type ScorecardPartStatus } from '@sm/shared';
import { db } from '../db.js';
import { currentUser } from '../auth/context.js';
import { registerReportSection } from '../reports/sections.js';
import type { CellInput, Tone } from '../reports/pdf/engine.js';
import { computeScorecards, dayOf, scorecardTrend, snapshotsOf } from './scorecard.js';
import { listObjectiveViews, rowTargets } from './objectives.js';

/**
 * "Service scorecard" section of scheduled summary reports (#86): per service the four parts of the scorecard –
 * duties, availability, documentation, protection need – each with its own status and "attention needed"; the trend
 * of the stored daily snapshots over the report period; and the availability objectives with their status at the end
 * of the period and the breaches that started in it. Collected with the rights of the schedule's owner (documents
 * they may not read do not count).
 *
 * For a report period that has ended, the services come from the snapshot stored on its last day – a report generated
 * later for the same period shows the same results. Without a snapshot (or for a period that has not ended) the
 * scorecard is computed when the report is made.
 */

const MAX_ROWS = 400;

const en = {
  title: 'Service scorecard',
  intro:
    'Per service, each part with its own status – no weighting. Attention needed: a mandatory duty not met (last closed period or now), an availability objective below target, no released document, a review overdue or an expected document missing, or the protection need not rated.',
  asOfSnapshot: 'As stored on {day} (the last day of the report period).',
  asOfLive: 'As computed when the report was made.',
  services: 'Services',
  attention: 'Attention needed',
  service: 'Service',
  overall: 'Overall',
  trend: 'Trend over the report period',
  trendNone: 'No scorecard snapshots are stored for the report period.',
  day: 'Day',
  objectives: 'Availability objectives',
  objective: 'Objective',
  targets: 'Targets',
  statusEnd: 'At the end',
  breaches: 'Breaches',
  noObjectives: 'No availability objectives.',
  none: 'No services.',
  more: '{n} more not shown.',
  yes: 'Attention',
  no: 'OK',
  parts: { duties: 'Duties', availability: 'Availability', documentation: 'Documentation', protection: 'Protection need' } as Record<ScorecardPart, string>,
  statuses: { ok: 'OK', attention: 'Attention', pending: 'Open', none: '–', hidden: 'Hidden' } as Record<ScorecardPartStatus | 'hidden', string>,
  objectiveStatuses: { met: 'Met', below: 'Below target', noData: 'No data' } as Record<ObjectiveStatus, string>,
  windows: { h1: '1 h', h24: '24 h', d7: '7 d', d30: '30 d' } as Record<string, string>,
};
type Texts = typeof en;
const de: Texts = {
  title: 'Service-Scorecard',
  intro:
    'Je Service jeder Teil mit seinem eigenen Status – ohne Gewichtung. Handlungsbedarf: eine verpflichtende Pflicht nicht erfüllt (letzter abgeschlossener Zeitraum oder jetzt), ein Verfügbarkeitsziel unterschritten, kein freigegebenes Dokument, eine Überprüfung überfällig oder ein erwartetes Dokument fehlt, oder der Schutzbedarf ist nicht bewertet.',
  asOfSnapshot: 'Stand vom {day} (letzter Tag des Berichtszeitraums).',
  asOfLive: 'Stand bei der Erstellung des Berichts.',
  services: 'Services',
  attention: 'Handlungsbedarf',
  service: 'Service',
  overall: 'Gesamt',
  trend: 'Verlauf im Berichtszeitraum',
  trendNone: 'Für den Berichtszeitraum sind keine Scorecard-Stände gespeichert.',
  day: 'Tag',
  objectives: 'Verfügbarkeitsziele',
  objective: 'Ziel',
  targets: 'Zielwerte',
  statusEnd: 'Am Ende',
  breaches: 'Unterschreitungen',
  noObjectives: 'Keine Verfügbarkeitsziele.',
  none: 'Keine Services.',
  more: '{n} weitere nicht angezeigt.',
  yes: 'Handlungsbedarf',
  no: 'OK',
  parts: { duties: 'Pflichten', availability: 'Verfügbarkeit', documentation: 'Dokumentation', protection: 'Schutzbedarf' },
  statuses: { ok: 'OK', attention: 'Handlungsbedarf', pending: 'Offen', none: '–', hidden: 'Verborgen' },
  objectiveStatuses: { met: 'Erfüllt', below: 'Unterschritten', noData: 'Keine Daten' },
  windows: { h1: '1 Std.', h24: '24 Std.', d7: '7 T.', d30: '30 T.' },
};
const tx = (l: ReportLang): Texts => (l === 'de' ? de : en);
const fill = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));

const schema = z.object({
  /** Services to include; null: all */
  serviceIds: z.array(z.string().min(1).max(200)).max(200).nullable().default(null),
});
type ScorecardConfig = z.infer<typeof schema>;

type PartCell = ScorecardPartStatus | 'hidden';
interface ServiceRow {
  service: string;
  attention: boolean;
  parts: Record<ScorecardPart, PartCell>;
}
interface ObjectiveRow {
  service: string;
  objective: string;
  targets: Partial<Record<string, number>>;
  status: ObjectiveStatus | null;
  breaches: number;
}

export interface ScorecardSectionData {
  /** The stored day the services come from; null: computed when the report was made */
  asOf: string | null;
  services: ServiceRow[];
  trend: { day: string; services: number; attention: number }[];
  objectives: ObjectiveRow[];
}

const DAY = 86400000;

function build(c: ScorecardConfig, ctx: { from: number; to: number; now: number }): ScorecardSectionData {
  const out: ScorecardSectionData = { asOf: null, services: [], trend: [], objectives: [] };
  if (!currentUser()) return out;
  const want = (id: string) => !c.serviceIds || c.serviceIds.includes(id);
  const today = dayOf(ctx.now);
  const lastDay = dayOf(ctx.to - 1);
  const stored = lastDay < today ? snapshotsOf(lastDay).filter((x) => want(x.serviceId)) : [];
  if (stored.length) {
    out.asOf = lastDay;
    out.services = stored.map((x) => ({ service: x.serviceName, attention: x.point.attention, parts: x.point.parts }));
  } else {
    out.services = computeScorecards(c.serviceIds ?? undefined, currentUser(), ctx.now).map(({ card }) => ({
      service: card.serviceName,
      attention: card.attention,
      parts: {
        duties: card.duties.status,
        availability: card.availability.status,
        documentation: card.documentation.status,
        protection: card.protection.status,
      },
    }));
  }
  out.services.sort((a, b) => a.service.localeCompare(b.service));
  // the trend of the stored days in the period (at most 14 points, evenly spread)
  const points = scorecardTrend({ from: dayOf(ctx.from), to: lastDay, serviceIds: c.serviceIds ?? undefined }, ctx.now);
  const step = Math.max(1, Math.ceil(points.length / 14));
  out.trend = points.filter((_, i) => i % step === 0 || i === points.length - 1).map((p) => ({ day: p.day, services: p.services, attention: p.attention }));
  const fromIso = new Date(ctx.from).toISOString();
  const toIso = new Date(Math.min(ctx.to, ctx.now + DAY)).toISOString();
  for (const v of listObjectiveViews({}, ctx.now)) {
    if (!want(v.row.service_id)) continue;
    const last = db().get<{ status: ObjectiveStatus }>(
      'SELECT status FROM objective_samples WHERE objective_id = ? AND bucket < ? ORDER BY bucket DESC LIMIT 1',
      v.row.id,
      toIso,
    );
    const breaches =
      db().get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM objective_breaches WHERE objective_id = ? AND started_at >= ? AND started_at < ?',
        v.row.id,
        fromIso,
        toIso,
      )?.n ?? 0;
    const t = rowTargets(v.row);
    out.objectives.push({
      service: v.summary.serviceName,
      objective: v.summary.name,
      targets: Object.fromEntries(OBJECTIVE_WINDOWS.filter((w) => t[w] !== null).map((w) => [w, t[w]!])),
      status: last?.status ?? null,
      breaches: Number(breaches),
    });
  }
  return out;
}

const tone = (s: PartCell): Tone => (s === 'ok' ? 'success' : s === 'attention' ? 'danger' : s === 'pending' ? 'warning' : 'muted');
const objTone = (s: ObjectiveStatus | null): Tone => (s === 'met' ? 'success' : s === 'below' ? 'danger' : 'muted');

registerReportSection<ScorecardConfig, ScorecardSectionData>({
  id: 'scorecard',
  schema: schema as unknown as ZodType<ScorecardConfig>,
  validate: (c) => {
    if (!c.serviceIds) return;
    const known = new Set(
      db()
        .all<{ id: string }>('SELECT id FROM services')
        .map((s) => s.id),
    );
    const missing = c.serviceIds.filter((x) => !known.has(x));
    if (missing.length) throw Object.assign(new Error(`Service(s) not found: ${missing.join(', ')}`), { statusCode: 400 });
  },
  title: (l) => tx(l).title,
  build,
  glance: (d, l) => {
    const n = d.services.filter((s) => s.attention).length;
    return [{ label: tx(l).attention, value: `${n} / ${d.services.length}`, tone: (n ? 'danger' : 'success') as Tone }];
  },
  render: (d, { w, lang, section }) => {
    const x = tx(lang);
    const pct = (v: number) => `${new Intl.NumberFormat(lang, { maximumFractionDigits: 2 }).format(v)} %`;
    section(x.title);
    w.paragraph(x.intro, { tone: 'muted', size: 8 });
    w.paragraph(d.asOf ? fill(x.asOfSnapshot, { day: d.asOf }) : x.asOfLive, { tone: 'muted', size: 7.4 });
    const attention = d.services.filter((s) => s.attention).length;
    w.stats([
      { label: x.services, value: String(d.services.length), tone: 'default' as Tone },
      { label: x.attention, value: String(attention), tone: (attention ? 'danger' : 'success') as Tone },
      ...SCORECARD_PARTS.map((p) => {
        const n = d.services.filter((s) => s.parts[p] === 'attention').length;
        return { label: x.parts[p], value: String(n), tone: (n ? 'danger' : 'default') as Tone };
      }),
    ]);
    w.table(
      [{ header: x.service, width: 2.6 }, { header: x.overall, width: 1.5 }, ...SCORECARD_PARTS.map((p) => ({ header: x.parts[p], width: 1.4 }))],
      d.services
        .slice(0, MAX_ROWS)
        .map((s): CellInput[] => [
          { text: s.service, bold: true },
          { text: s.attention ? x.yes : x.no, tone: s.attention ? 'danger' : 'success', bold: s.attention },
          ...SCORECARD_PARTS.map((p): CellInput => ({ text: x.statuses[s.parts[p]], tone: tone(s.parts[p]) })),
        ]),
      { empty: x.none, size: 7.4 },
    );
    if (d.services.length > MAX_ROWS) w.paragraph(fill(x.more, { n: d.services.length - MAX_ROWS }), { tone: 'muted', size: 7.4 });
    w.subheading(x.trend);
    w.table(
      [
        { header: x.day, width: 1.4, mono: true },
        { header: x.services, width: 1 },
        { header: x.attention, width: 1.4 },
      ],
      d.trend.map((p): CellInput[] => [p.day, String(p.services), { text: String(p.attention), tone: p.attention ? 'danger' : 'success' }]),
      { empty: x.trendNone, size: 7.4 },
    );
    w.subheading(x.objectives);
    w.table(
      [
        { header: x.service, width: 2 },
        { header: x.objective, width: 2.4 },
        { header: x.targets, width: 2.4 },
        { header: x.statusEnd, width: 1.4 },
        { header: x.breaches, width: 1 },
      ],
      d.objectives.slice(0, MAX_ROWS).map((o): CellInput[] => [
        o.service,
        { text: o.objective, bold: true },
        Object.entries(o.targets)
          .map(([k, v]) => `${x.windows[k]} ≥ ${pct(v!)}`)
          .join(', '),
        { text: o.status ? x.objectiveStatuses[o.status] : x.objectiveStatuses.noData, tone: objTone(o.status) },
        { text: String(o.breaches), tone: o.breaches ? 'danger' : 'default' },
      ]),
      { empty: x.noObjectives, size: 7.4 },
    );
    if (d.objectives.length > MAX_ROWS) w.paragraph(fill(x.more, { n: d.objectives.length - MAX_ROWS }), { tone: 'muted', size: 7.4 });
  },
});
