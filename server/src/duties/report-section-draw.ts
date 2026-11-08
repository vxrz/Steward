import type { DutyLevel, DutyPeriodStatus, ReportLang } from '@sm/shared';
import type { CellInput, Tone } from '../reports/pdf/engine.js';
import type { ReportSectionDraw } from '../reports/section-draw.js';

/**
 * The draw half of the section of scheduled summary reports in report-section.ts (which collects its data): data
 * in, PDF out – it runs in the PDF worker (reports/section-draw.ts).
 */

const MAX_ROWS = 400;

const en = {
  title: 'Service duties',
  intro:
    'Periods of service duties that ended in the report period, with their status, and the duties that were not done yet at its end. Done: a successful real run of the process (dry runs never count); late: done in the grace period; skipped: an exception approved by a second person.',
  ended: 'Periods ended in the report period',
  open: 'Not done yet at the end of the report period',
  service: 'Service',
  duty: 'Duty',
  level: 'Level',
  period: 'Period',
  status: 'Status',
  completed: 'Done at',
  dueBy: 'Due by',
  none: 'No period of a duty ended in the report period.',
  noneOpen: 'Every duty is done for its current period.',
  more: '{n} more not shown.',
  notMet: 'Not met (missed, failed, ended)',
  version: 'version {n}',
  levels: { mandatory: 'Mandatory', recommended: 'Recommended', optional: 'Optional' } as Record<DutyLevel, string>,
  statuses: {
    due: 'Due',
    done: 'Done',
    late: 'Late',
    skipped: 'Skipped',
    failed: 'Failed',
    missed: 'Missed',
    inactive: 'Inactive (archived)',
    ended: 'Ended without a run',
  } as Record<DutyPeriodStatus, string>,
};

type Texts = typeof en;

const de: Texts = {
  title: 'Service-Pflichten',
  intro:
    'Zeiträume von Service-Pflichten, die im Berichtszeitraum endeten, mit ihrem Status, und die Pflichten, die an seinem Ende noch nicht erledigt waren. Erledigt: eine erfolgreiche echte Ausführung des Prozesses (Probeläufe zählen nie); verspätet: in der Nachfrist erledigt; ausgesetzt: eine von einer zweiten Person genehmigte Ausnahme.',
  ended: 'Im Berichtszeitraum beendete Zeiträume',
  open: 'Am Ende des Berichtszeitraums noch nicht erledigt',
  service: 'Service',
  duty: 'Pflicht',
  level: 'Stufe',
  period: 'Zeitraum',
  status: 'Status',
  completed: 'Erledigt am',
  dueBy: 'Fällig bis',
  none: 'Im Berichtszeitraum endete kein Zeitraum einer Pflicht.',
  noneOpen: 'Jede Pflicht ist für ihren aktuellen Zeitraum erledigt.',
  more: '{n} weitere nicht angezeigt.',
  notMet: 'Nicht erfüllt (versäumt, fehlgeschlagen, beendet)',
  version: 'Version {n}',
  levels: { mandatory: 'Verpflichtend', recommended: 'Empfohlen', optional: 'Freiwillig' },
  statuses: {
    due: 'Fällig',
    done: 'Erledigt',
    late: 'Verspätet',
    skipped: 'Ausgesetzt',
    failed: 'Fehlgeschlagen',
    missed: 'Versäumt',
    inactive: 'Inaktiv (archiviert)',
    ended: 'Ohne Ausführung beendet',
  },
};

const tx = (l: ReportLang): Texts => (l === 'de' ? de : en);

const fill = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));

export interface Row {
  service: string;
  duty: string;
  level: DutyLevel;
  period: string;
  status: DutyPeriodStatus;
  completedAt: string | null;
  /** Process version of the run that counted */
  version: number | null;
  dueBy: string;
  timeZone: string;
}

export interface DutiesSectionData {
  counts: Record<DutyPeriodStatus, number>;
  ended: Row[];
  open: Row[];
}

const STATUSES: DutyPeriodStatus[] = ['done', 'late', 'skipped', 'failed', 'missed', 'ended', 'due', 'inactive'];

const tone = (s: DutyPeriodStatus): Tone =>
  s === 'done' ? 'success' : s === 'late' || s === 'skipped' ? 'warning' : s === 'due' ? 'info' : s === 'inactive' ? 'muted' : 'danger';

export const dutiesSectionDraw: ReportSectionDraw<DutiesSectionData> = {
  id: 'duties',
  title: (l) => tx(l).title,
  glance: (d, l) => {
    const bad = d.counts.missed + d.counts.failed + d.counts.ended;
    return [
      { label: tx(l).statuses.done, value: String(d.counts.done + d.counts.late), tone: 'success' as Tone },
      { label: tx(l).notMet, value: String(bad), tone: (bad ? 'danger' : 'default') as Tone },
    ];
  },
  render: (d, { w, lang, section }) => {
    const x = tx(lang);
    const date = (s: string | null, tz: string) =>
      s ? new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz }).format(new Date(s)) : '–';
    section(x.title);
    w.paragraph(x.intro, { tone: 'muted', size: 8 });
    w.stats(
      STATUSES.filter((s) => s !== 'due' && s !== 'inactive').map((s) => ({
        label: x.statuses[s],
        value: String(d.counts[s]),
        tone: d.counts[s] ? tone(s) : ('default' as Tone),
      })),
    );
    const columns = [
      { header: x.service, width: 2 },
      { header: x.duty, width: 2.6 },
      { header: x.level, width: 1.3 },
      { header: x.period, width: 1.1, mono: true },
      { header: x.status, width: 1.2 },
    ];
    w.subheading(x.ended);
    w.table(
      [...columns, { header: x.completed, width: 1.4 }],
      d.ended
        .slice(0, MAX_ROWS)
        .map((r): CellInput[] => [
          r.service,
          { text: r.duty, bold: true },
          x.levels[r.level],
          r.period,
          { text: x.statuses[r.status], tone: tone(r.status) },
          r.version === null ? date(r.completedAt, r.timeZone) : `${date(r.completedAt, r.timeZone)} · ${fill(x.version, { n: r.version })}`,
        ]),
      { empty: x.none, size: 7.4 },
    );
    if (d.ended.length > MAX_ROWS) w.paragraph(fill(x.more, { n: d.ended.length - MAX_ROWS }), { tone: 'muted', size: 7.4 });
    w.subheading(x.open);
    w.table(
      [...columns, { header: x.dueBy, width: 1.4 }],
      d.open
        .slice(0, MAX_ROWS)
        .map((r): CellInput[] => [
          r.service,
          { text: r.duty, bold: true },
          x.levels[r.level],
          r.period,
          { text: x.statuses[r.status], tone: tone(r.status) },
          date(r.dueBy, r.timeZone),
        ]),
      { empty: x.noneOpen, size: 7.4 },
    );
    if (d.open.length > MAX_ROWS) w.paragraph(fill(x.more, { n: d.open.length - MAX_ROWS }), { tone: 'muted', size: 7.4 });
  },
};
