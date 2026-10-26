import { z, type ZodType } from 'zod';
import { DUTY_LEVELS, type DutyLevel, type DutyPeriodStatus, type ReportLang } from '@sm/shared';
import { db } from '../db.js';
import { currentUser } from '../auth/context.js';
import { registerReportSection } from '../reports/sections.js';
import type { CellInput, Tone } from '../reports/pdf/engine.js';
import { listDutyViews } from './service.js';
import { addLocalDays } from './periods.js';

/**
 * "Service duties" section of scheduled summary reports: the periods of service duties that ended in the report
 * period with their status (done, late, skipped, failed, missed), and the duties not done yet at the end of the
 * report period. Collected with the rights of the schedule's owner (duties are readable by everyone who can sign in,
 * like services). Closed periods are stored and never change, so a report generated later for the same period shows
 * the same results; a period whose grace period is still running shows the status it has when the report is made.
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
  levels: { mandatory: 'Mandatory', recommended: 'Recommended', optional: 'Optional' } as Record<DutyLevel, string>,
  statuses: { due: 'Due', done: 'Done', late: 'Late', skipped: 'Skipped', failed: 'Failed', missed: 'Missed' } as Record<DutyPeriodStatus, string>,
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
  levels: { mandatory: 'Verpflichtend', recommended: 'Empfohlen', optional: 'Optional' },
  statuses: { due: 'Fällig', done: 'Erledigt', late: 'Verspätet', skipped: 'Ausgesetzt', failed: 'Fehlgeschlagen', missed: 'Versäumt' },
};
const tx = (l: ReportLang): Texts => (l === 'de' ? de : en);
const fill = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));

const schema = z.object({
  /** Levels to include; null: all */
  levels: z.array(z.enum(DUTY_LEVELS)).max(3).nullable().default(null),
  /** Services to include; null: all */
  serviceIds: z.array(z.string().min(1).max(200)).max(200).nullable().default(null),
});
type DutiesConfig = z.infer<typeof schema>;

interface Row {
  service: string;
  duty: string;
  level: DutyLevel;
  period: string;
  status: DutyPeriodStatus;
  completedAt: string | null;
  dueBy: string;
  timeZone: string;
}

export interface DutiesSectionData {
  counts: Record<DutyPeriodStatus, number>;
  ended: Row[];
  open: Row[];
}

const STATUSES: DutyPeriodStatus[] = ['done', 'late', 'skipped', 'failed', 'missed', 'due'];
const iso = (t: number) => new Date(t).toISOString();

function build(c: DutiesConfig, ctx: { from: number; to: number; now: number }): DutiesSectionData {
  const out: DutiesSectionData = { counts: { due: 0, done: 0, late: 0, skipped: 0, failed: 0, missed: 0 }, ended: [], open: [] };
  if (!currentUser()) return out;
  const at = Math.min(ctx.to, ctx.now);
  for (const b of listDutyViews({ archived: true }, ctx.now)) {
    if (c.serviceIds && !c.serviceIds.includes(b.service.id)) continue;
    for (const e of b.periods) {
      const level = e.row?.closed_at ? e.row.level : b.row.level;
      if (c.levels && !c.levels.includes(level)) continue;
      const tz = e.row?.closed_at ? e.row.time_zone : b.summary.timeZone;
      const row: Row = {
        service: b.service.name,
        duty: e.row?.closed_at ? e.row.duty_name : b.row.name,
        level,
        period: e.period.key,
        status: e.status,
        completedAt: e.status === 'done' || e.status === 'late' ? (e.run?.finishedAt ?? null) : null,
        dueBy: iso(addLocalDays(e.period.end, -1, tz) + 12 * 3600000),
        timeZone: tz,
      };
      if (e.period.end > ctx.from && e.period.end <= ctx.to) {
        out.ended.push(row);
        out.counts[e.status]++;
      } else if (e.period.start <= at && at < e.graceEnd && e.status === 'due' && !b.row.archived) out.open.push(row);
    }
  }
  const order = (a: Row, b: Row) => a.service.localeCompare(b.service) || a.duty.localeCompare(b.duty) || a.period.localeCompare(b.period);
  out.ended.sort(order);
  out.open.sort(order);
  return out;
}

const tone = (s: DutyPeriodStatus): Tone => (s === 'done' ? 'success' : s === 'late' || s === 'skipped' ? 'warning' : s === 'due' ? 'info' : 'danger');

registerReportSection<DutiesConfig, DutiesSectionData>({
  id: 'duties',
  schema: schema as unknown as ZodType<DutiesConfig>,
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
    const bad = d.counts.missed + d.counts.failed;
    return [
      { label: tx(l).statuses.done, value: String(d.counts.done + d.counts.late), tone: 'success' as Tone },
      { label: `${tx(l).statuses.missed} / ${tx(l).statuses.failed}`, value: String(bad), tone: (bad ? 'danger' : 'default') as Tone },
    ];
  },
  render: (d, { w, lang, section }) => {
    const x = tx(lang);
    const date = (s: string | null, tz: string) =>
      s ? new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz }).format(new Date(s)) : '–';
    section(x.title);
    w.paragraph(x.intro, { tone: 'muted', size: 8 });
    w.stats(
      STATUSES.filter((s) => s !== 'due').map((s) => ({
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
          date(r.completedAt, r.timeZone),
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
});
