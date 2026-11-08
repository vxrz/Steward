import { z, type ZodType } from 'zod';
import { OBJECTIVE_WINDOWS, type ObjectiveStatus } from '@sm/shared';
import { db } from '../db.js';
import { currentUser } from '../auth/context.js';
import { computeScorecards, dayOf, scorecardTrend, snapshotsOf } from './scorecard.js';
import { listObjectiveViews, rowTargets } from './objectives.js';
import type { ReportSectionDef } from '../reports/sections.js';
import { scorecardSectionDraw, type ScorecardSectionData } from './report-section-draw.js';

/**
 * "Service scorecard" section of scheduled summary reports (#86): per service the parts of the scorecard –
 * duties, availability, documentation, protection need, tech stack (when counted), vulnerabilities (when linked), up to date (when counted) – each with its own status and "attention needed"; the trend
 * of the stored daily snapshots over the report period; and the availability objectives with their status at the end
 * of the period and the breaches that started in it. Collected with the rights of the schedule's owner (documents
 * they may not read do not count).
 *
 * For a report period that has ended, the services come from the snapshot stored on its last day – a report generated
 * later for the same period shows the same results. Without a snapshot (or for a period that has not ended) the
 * scorecard is computed when the report is made.
 */

const schema = z.object({
  /** Services to include; null: all */
  serviceIds: z.array(z.string().min(1).max(200)).max(200).nullable().default(null),
});

type ScorecardConfig = z.infer<typeof schema>;

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
        lifecycle: card.lifecycle.status,
        vulnerabilities: card.vulnerabilities.status,
        upToDate: card.upToDate.status,
        costs: card.costs.status,
        contracts: card.contracts.status,
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
  for (const v of listObjectiveViews({ archived: true }, ctx.now)) {
    // objectives archived before the report period are left out; those archived in it are reported
    if (!want(v.row.service_id) || (v.row.archived_at && v.row.archived_at < fromIso)) continue;
    const last = db().get<{ status: ObjectiveStatus }>(
      'SELECT status FROM objective_samples WHERE objective_id = ? AND bucket < ? ORDER BY bucket DESC LIMIT 1',
      v.row.id,
      toIso,
    );
    const b = db().get<{ n: number; archived: number | null }>(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN end_reason = 'archived' THEN 1 ELSE 0 END) AS archived
       FROM objective_breaches WHERE objective_id = ? AND started_at >= ? AND started_at < ?`,
      v.row.id,
      fromIso,
      toIso,
    );
    const t = rowTargets(v.row);
    out.objectives.push({
      service: v.summary.serviceName,
      objective: v.summary.name,
      targets: Object.fromEntries(OBJECTIVE_WINDOWS.filter((w) => t[w] !== null).map((w) => [w, t[w]!])),
      status: last?.status ?? null,
      breaches: Number(b?.n ?? 0),
      endedByArchiving: Number(b?.archived ?? 0),
      archived: !!v.row.archived_at,
    });
  }
  return out;
}

export const scorecardSection: ReportSectionDef<ScorecardConfig, ScorecardSectionData> = {
  ...scorecardSectionDraw,
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
  build,
};
