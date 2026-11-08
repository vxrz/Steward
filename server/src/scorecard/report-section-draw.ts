import { SCORECARD_PARTS, type ObjectiveStatus, type ReportLang, type ScorecardPart, type ScorecardPartStatus } from '@sm/shared';
import type { CellInput, Tone } from '../reports/pdf/engine.js';
import type { ReportSectionDraw } from '../reports/section-draw.js';

/**
 * The draw half of the section of scheduled summary reports in report-section.ts (which collects its data): data
 * in, PDF out – it runs in the PDF worker (reports/section-draw.ts).
 */

const MAX_ROWS = 400;

const en = {
  title: 'Service scorecard',
  intro:
    'Per service, each part with its own status – no weighting. Attention needed: a mandatory duty not met (last closed period or now), an availability objective below target, no released document, a review overdue or an expected document missing, the protection need not rated, a component past its end of life or a major release behind (when counted), or open critical findings or failing policy violations in Dependency-Track.',
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
  endedByArchiving: '{n} ended by archiving',
  archivedObjective: 'archived',
  noObjectives: 'No availability objectives.',
  none: 'No services.',
  more: '{n} more not shown.',
  yes: 'Attention',
  no: 'OK',
  parts: {
    duties: 'Duties',
    availability: 'Availability',
    documentation: 'Documentation',
    protection: 'Protection need',
    lifecycle: 'Tech stack',
    vulnerabilities: 'Vulnerabilities',
    upToDate: 'Up to date',
    costs: 'Costs',
    contracts: 'Data contracts',
  } as Record<ScorecardPart, string>,
  statuses: { ok: 'OK', attention: 'Attention', pending: 'Open', none: '–', hidden: 'Hidden' } as Record<ScorecardPartStatus | 'hidden', string>,
  objectiveStatuses: { met: 'Met', below: 'Below target', noData: 'No data' } as Record<ObjectiveStatus, string>,
  windows: { h1: '1 h', h24: '24 h', d7: '7 d', d30: '30 d' } as Record<string, string>,
};

type Texts = typeof en;

const de: Texts = {
  title: 'Service-Scorecard',
  intro:
    'Je Service jeder Teil mit seinem eigenen Status – ohne Gewichtung. Handlungsbedarf: eine verpflichtende Pflicht nicht erfüllt (letzter abgeschlossener Zeitraum oder jetzt), ein Verfügbarkeitsziel unterschritten, kein freigegebenes Dokument, eine Überprüfung überfällig oder ein erwartetes Dokument fehlt, der Schutzbedarf ist nicht bewertet, eine Komponente hat ihr Lebensende überschritten oder liegt eine Hauptversion zurück (wenn gezählt) oder Dependency-Track meldet offene kritische Schwachstellen oder fehlgeschlagene Richtlinienverstöße.',
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
  endedByArchiving: '{n} durch Archivieren beendet',
  archivedObjective: 'archiviert',
  noObjectives: 'Keine Verfügbarkeitsziele.',
  none: 'Keine Services.',
  more: '{n} weitere nicht angezeigt.',
  yes: 'Handlungsbedarf',
  no: 'OK',
  parts: {
    duties: 'Pflichten',
    availability: 'Verfügbarkeit',
    documentation: 'Dokumentation',
    protection: 'Schutzbedarf',
    lifecycle: 'Tech-Stack',
    vulnerabilities: 'Schwachstellen',
    upToDate: 'Aktualität',
    costs: 'Kosten',
    contracts: 'Datenverträge',
  },
  statuses: { ok: 'OK', attention: 'Handlungsbedarf', pending: 'Offen', none: '–', hidden: 'Verborgen' },
  objectiveStatuses: { met: 'Erfüllt', below: 'Unterschritten', noData: 'Keine Daten' },
  windows: { h1: '1 Std.', h24: '24 Std.', d7: '7 T.', d30: '30 T.' },
};

const tx = (l: ReportLang): Texts => (l === 'de' ? de : en);

const fill = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));

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
  /** Breaches that ended because the objective was archived */
  endedByArchiving: number;
  archived: boolean;
}

export interface ScorecardSectionData {
  /** The stored day the services come from; null: computed when the report was made */
  asOf: string | null;
  services: ServiceRow[];
  trend: { day: string; services: number; attention: number }[];
  objectives: ObjectiveRow[];
}

const tone = (s: PartCell): Tone => (s === 'ok' ? 'success' : s === 'attention' ? 'danger' : s === 'pending' ? 'warning' : 'muted');

const objTone = (s: ObjectiveStatus | null): Tone => (s === 'met' ? 'success' : s === 'below' ? 'danger' : 'muted');

export const scorecardSectionDraw: ReportSectionDraw<ScorecardSectionData> = {
  id: 'scorecard',
  title: (l) => tx(l).title,
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
    // the tech stack part only when it is counted (it is off by default; reports made before 0.2.3 have no value), the
    // vulnerabilities only when a service's components link Dependency-Track (older reports have no value)
    // and the costs only when a service has a cost budget (#226), data contracts only when one is linked to a service's
    // applications or systems (#221)
    const optional: ScorecardPart[] = ['lifecycle', 'vulnerabilities', 'upToDate', 'costs', 'contracts'];
    const parts = SCORECARD_PARTS.filter((p) => !optional.includes(p) || d.services.some((s) => (s.parts[p] ?? 'none') !== 'none'));
    w.stats([
      { label: x.services, value: String(d.services.length), tone: 'default' as Tone },
      { label: x.attention, value: String(attention), tone: (attention ? 'danger' : 'success') as Tone },
      ...parts.map((p) => {
        const n = d.services.filter((s) => s.parts[p] === 'attention').length;
        return { label: x.parts[p], value: String(n), tone: (n ? 'danger' : 'default') as Tone };
      }),
    ]);
    w.table(
      [{ header: x.service, width: 2.6 }, { header: x.overall, width: 1.5 }, ...parts.map((p) => ({ header: x.parts[p], width: 1.4 }))],
      d.services
        .slice(0, MAX_ROWS)
        .map((s): CellInput[] => [
          { text: s.service, bold: true },
          { text: s.attention ? x.yes : x.no, tone: s.attention ? 'danger' : 'success', bold: s.attention },
          ...parts.map((p): CellInput => ({ text: x.statuses[s.parts[p] ?? 'none'], tone: tone(s.parts[p] ?? 'none') })),
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
        { text: o.archived ? `${o.objective} (${x.archivedObjective})` : o.objective, bold: true },
        Object.entries(o.targets)
          .map(([k, v]) => `${x.windows[k]} ≥ ${pct(v!)}`)
          .join(', '),
        { text: o.status ? x.objectiveStatuses[o.status] : x.objectiveStatuses.noData, tone: objTone(o.status) },
        {
          text: o.endedByArchiving ? `${o.breaches} (${fill(x.endedByArchiving, { n: o.endedByArchiving })})` : String(o.breaches),
          tone: o.breaches ? 'danger' : 'default',
        },
      ]),
      { empty: x.noObjectives, size: 7.4 },
    );
    if (d.objectives.length > MAX_ROWS) w.paragraph(fill(x.more, { n: d.objectives.length - MAX_ROWS }), { tone: 'muted', size: 7.4 });
  },
};
