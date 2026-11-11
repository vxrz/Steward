import { z, type ZodType } from 'zod';
import { DUTY_LEVELS } from '@sm/shared';
import { db } from '../db.js';
import { currentUser } from '../auth/context.js';
import { listDutyViews } from './service.js';
import { addLocalDays } from './periods.js';
import { defineReportSection } from '../reports/sections.js';
import { dutiesSectionDraw, type Row, type DutiesSectionData } from './report-section-draw.js';

/**
 * "Service duties" section of scheduled summary reports: the periods of service duties that ended in the report
 * period with their status (done, late, skipped, failed, missed), and the duties not done yet at the end of the
 * report period. Collected with the rights of the schedule's owner (duties are readable by everyone who can sign in,
 * like services). Closed periods are stored and never change, so a report generated later for the same period shows
 * the same results; a period whose grace period is still running shows the status it has when the report is made.
 */

const schema = z.object({
  /** Levels to include; null: all */
  levels: z.array(z.enum(DUTY_LEVELS)).max(3).nullable().default(null),
  /** Services to include; null: all */
  serviceIds: z.array(z.string().min(1).max(200)).max(200).nullable().default(null),
});

export type DutiesConfig = z.infer<typeof schema>;

const iso = (t: number) => new Date(t).toISOString();

/** The periods of the report period and the duties not done yet at its end (also the ISMS summary's duty figures). */
export function collectDutyPeriods(c: DutiesConfig, ctx: { from: number; to: number; now: number }): DutiesSectionData {
  const out: DutiesSectionData = { counts: { due: 0, done: 0, late: 0, skipped: 0, failed: 0, missed: 0, inactive: 0, ended: 0 }, ended: [], open: [] };
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
        version: e.status === 'done' || e.status === 'late' ? (e.run?.processVersion ?? null) : null,
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

export const dutiesSection = defineReportSection<DutiesConfig, DutiesSectionData>({
  ...dutiesSectionDraw,
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
  build: collectDutyPeriods,
});
