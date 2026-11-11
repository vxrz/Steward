import { z, type ZodType } from 'zod';
import { CA_OPEN_STATUSES, CA_SEVERITIES, type CaSeverity } from '@sm/shared';
import { db } from '../db.js';
import { currentUser } from '../auth/context.js';
import { canViewCatalogue } from '../records/access.js';
import { moduleEnabled } from '../modules/registry.js';
import { collectDutyPeriods } from '../duties/report-section.js';
import { expiringItems, visibleSupplierRows } from '../suppliers/service.js';
import { supplierVisible } from '../suppliers/links.js';
import { parseJson } from '../util.js';
import { defineReportSection } from '../reports/sections.js';
import { findCatalogue } from './controls.js';
import { soaDecisions, soaStatusOf } from './soa.js';
import { matrixGaps } from './responsibilities.js';
import { CaContext, canReadFinding, listFindingSummaries, type FindingRow } from './corrective.js';
import { pendingSuggestionCount } from './corrective-sources.js';
import { reviewsApprovedIn } from './person-reviews.js';
import { livingDocumentsAt } from '../records/report-section.js';
import { reminderSettings } from '../credentials/service.js';
import { ismsSectionDraw, ISMS_MAX_ROWS, type IsmsSectionData } from './isms-report-section-draw.js';

/**
 * "ISMS summary" section of scheduled reports (ADR 0029 part 4, docs/REPORTS.md, docs/COMPLIANCE.md#isms-summary): the
 * figures of a management review (ISO/IEC 27001 clause 9.3) from what Steward already has – the statement of
 * applicability per catalogue, corrective actions, mandatory duty periods, reviews done, gaps of the responsibility
 * matrix and the certificates and notice dates of suppliers, and (0.18.0) the periodic reviews of living documents. No page and no state of its own: it reads the parts, with
 * the rights of the schedule's owner (runAs, like every section) – findings, services, suppliers and person reviews
 * the owner may not see are not counted. Compliance module: while it is off the section says so and holds nothing.
 */

const schema = z.object({
  /** One catalogue (key or id); null: every statement of applicability */
  catalogue: z.string().trim().min(1).max(100).nullable().default(null),
  /** Services to include (findings, duties, matrix gaps); null: all the owner may see */
  serviceIds: z.array(z.string().min(1).max(200)).max(200).nullable().default(null),
  /** Certificates and notice-by dates of suppliers this many days ahead (and passed this many days ago) */
  days: z.number().int().min(1).max(365).default(90),
});

type IsmsConfig = z.infer<typeof schema>;

const iso = (t: number) => new Date(t).toISOString();

export function emptyIsmsData(days: number, moduleOff: boolean): IsmsSectionData {
  return {
    moduleOff,
    days,
    soa: { items: [], decisions: [], missing: null },
    corrective: {
      open: { major: 0, minor: 0, observation: 0 },
      overdue: 0,
      overdueList: [],
      closed: 0,
      checks: { effective: 0, notEffective: 0 },
      suggestions: 0,
    },
    duties: { counts: { done: 0, late: 0, skipped: 0, failed: 0, missed: 0, ended: 0 }, notMet: [] },
    reviews: {
      personReviews: 0,
      removals: 0,
      gone: 0,
      supplierReviews: { done: 0, late: 0, notDone: 0 },
      documents: { withinInterval: 0, overdue: 0, reviewed: 0, overdueList: [] },
    },
    gaps: [],
    suppliers: { items: [], unconfirmed: 0 },
  };
}

function build(c: IsmsConfig, ctx: { from: number; to: number; now: number }): IsmsSectionData {
  const u = currentUser();
  if (!moduleEnabled('compliance')) return emptyIsmsData(c.days, true);
  const out = emptyIsmsData(c.days, false);
  if (!u) return out;
  const from = iso(ctx.from);
  const to = iso(ctx.to);
  const inServices = (id: string | null) => !c.serviceIds || (!!id && c.serviceIds.includes(id));

  // 1. statement of applicability: the state now, the decisions of the period
  const cat = c.catalogue ? findCatalogue(c.catalogue) : null;
  const keys = c.catalogue
    ? cat
      ? [cat.key]
      : []
    : db()
        .all<{ key: string }>('SELECT k.key FROM soas s JOIN control_catalogues k ON k.id = s.catalogue_id ORDER BY k.key')
        .map((r) => r.key);
  for (const key of keys) {
    const st = soaStatusOf(key, ctx.now);
    if (!st) continue;
    out.soa.items.push({
      catalogueKey: st.catalogueKey,
      catalogueName: st.catalogueName,
      scopeName: st.scopeName,
      counts: st.counts,
      latestApproved: st.latestApproved,
      waiting: st.waiting,
      changedSinceApproved: st.changedSinceApproved,
    });
  }
  if (c.catalogue && !out.soa.items.length) out.soa.missing = cat?.key ?? c.catalogue;
  out.soa.decisions = soaDecisions(from, to)
    .filter((d) => keys.includes(d.catalogueKey))
    .map((d) => ({ catalogueKey: d.catalogueKey, number: d.number, status: d.status, decidedAt: d.decidedAt, decidedBy: d.decidedBy }));

  // 2. corrective actions the owner may read: open now by severity, overdue, closed and checked in the period
  const cactx = new CaContext();
  const findings = listFindingSummaries({}, cactx, u).filter((f) => inServices(f.serviceId));
  for (const f of findings) {
    if (!CA_OPEN_STATUSES.includes(f.status)) continue;
    out.corrective.open[f.severity]++;
    if (f.overdue) {
      out.corrective.overdue++;
      out.corrective.overdueList.push({ number: f.number, title: f.title, severity: f.severity, owner: f.owner, dueDate: f.dueDate });
    }
  }
  const rank = (s: CaSeverity) => CA_SEVERITIES.indexOf(s);
  out.corrective.overdueList.sort(
    (a, b) => rank(a.severity) - rank(b.severity) || (a.dueDate ?? '').localeCompare(b.dueDate ?? '') || a.number.localeCompare(b.number),
  );
  out.corrective.overdueList = out.corrective.overdueList.slice(0, ISMS_MAX_ROWS);
  for (const f of db().all<FindingRow>(
    `SELECT * FROM ca_findings WHERE (closed_at >= ? AND closed_at <= ? AND status = 'closed') OR (eff_checked_at >= ? AND eff_checked_at <= ?)`,
    from,
    to,
    from,
    to,
  )) {
    if (!inServices(f.service_id) || !canReadFinding(u, f, cactx)) continue;
    if (f.status === 'closed' && f.closed_at && f.closed_at >= from && f.closed_at <= to) out.corrective.closed++;
    // the latest check of a finding is stored: an earlier "not effective" of a finding checked again later is not counted
    if (f.eff_checked_at && f.eff_checked_at >= from && f.eff_checked_at <= to) {
      if (f.eff_result === 'effective') out.corrective.checks.effective++;
      else out.corrective.checks.notEffective++;
    }
  }
  out.corrective.suggestions = pendingSuggestionCount(u);

  // 3. mandatory duty periods that ended in the period (the stored statuses, as in the duties section)
  const duties = collectDutyPeriods({ levels: ['mandatory'], serviceIds: c.serviceIds }, ctx);
  out.duties.counts = {
    done: duties.counts.done,
    late: duties.counts.late,
    skipped: duties.counts.skipped,
    failed: duties.counts.failed,
    missed: duties.counts.missed,
    ended: duties.counts.ended,
  };
  out.duties.notMet = duties.ended
    .filter((r) => r.status === 'missed' || r.status === 'failed' || r.status === 'ended')
    .slice(0, ISMS_MAX_ROWS)
    .map((r) => ({ service: r.service, duty: r.duty, period: r.period, status: r.status as 'missed' | 'failed' | 'ended' }));

  // 4. reviews done: person access reviews approved in the period, supplier reviews (duties that name a supplier)
  const pr = reviewsApprovedIn(from, to, u);
  out.reviews.personReviews = pr.approved;
  out.reviews.removals = pr.removals;
  out.reviews.gone = pr.gone;
  const suppliers = new Map(
    db()
      .all<{ id: string; owners: string }>('SELECT id, owners FROM suppliers')
      .map((s) => [s.id, s]),
  );
  for (const p of db().all<{ status: string; service_id: string; supplier_id: string }>(
    `SELECT p.status, p.service_id, d.supplier_id FROM duty_periods p JOIN service_duties d ON d.id = p.duty_id
     WHERE d.supplier_id IS NOT NULL AND p.period_end > ? AND p.period_end <= ? AND p.status NOT IN ('due', 'inactive')`,
    from,
    to,
  )) {
    const s = suppliers.get(p.supplier_id);
    if (!s || !supplierVisible(s) || !inServices(p.service_id)) continue;
    if (p.status === 'done') out.reviews.supplierReviews.done++;
    else if (p.status === 'late') out.reviews.supplierReviews.late++;
    else if (p.status !== 'skipped') out.reviews.supplierReviews.notDone++;
  }

  // 4b. periodic reviews of living documents (0.18.0, docs/RECORDS.md#periodic-reviews): of the documents with a review
  // cycle the owner may read, those not overdue at the end of the period (reviewed or approved within their interval)
  // and those overdue then – replayed like the records section – and the reviews recorded in the period
  const docs = livingDocumentsAt(u, { from: ctx.from, to: ctx.to, now: ctx.now, dueSoonDays: reminderSettings().dueSoonDays }).filter(
    (x) => x.nextReviewAt !== null,
  );
  const dr = out.reviews.documents!;
  for (const x of docs) {
    if (x.reviewStatus === 'overdue') dr.overdue++;
    else dr.withinInterval++;
    dr.reviewed += x.reviewsInPeriod;
  }
  dr.overdueList = docs
    .filter((x) => x.reviewStatus === 'overdue')
    .sort((a, b) => a.nextReviewAt!.localeCompare(b.nextReviewAt!) || a.number.localeCompare(b.number))
    .slice(0, ISMS_MAX_ROWS)
    .map((x) => ({ number: x.number, title: x.title, owner: x.reviewOwner, nextReviewAt: x.nextReviewAt! }));

  // 5. services with gaps in their responsibility matrix (services the owner may see)
  const visible = new Set(
    db()
      .all<{ id: string; owners: string }>('SELECT id, owners FROM services WHERE archived = 0')
      .filter((s) => inServices(s.id) && canViewCatalogue(u, { kind: 'service', id: s.id, owners: parseJson<string[]>(s.owners, []) }))
      .map((s) => s.id),
  );
  const gaps = matrixGaps([...visible]);
  out.gaps = gaps.slice(0, ISMS_MAX_ROWS).map((g) => ({ service: g.serviceName, undecided: g.undecided, noRecoveryTest: g.noRecoveryTest }));
  out.gapCount = gaps.length;

  // 6. suppliers: certificates and notice-by dates ahead and passed (confirmed suppliers), and those still to confirm
  const dates = expiringItems({ days: c.days, pastDays: c.days, includeUnconfirmed: false }, ctx.now);
  out.suppliers.items = dates
    .slice(0, ISMS_MAX_ROWS)
    .map((x) => ({ supplier: x.supplierName, kind: x.kind, title: x.title, date: x.date, days: x.days, state: x.state }));
  out.suppliers.itemCount = dates.length;
  out.suppliers.unconfirmed = visibleSupplierRows({ status: 'unconfirmed' }).length;
  return out;
}

export const ismsSection = defineReportSection<IsmsConfig, IsmsSectionData>({
  ...ismsSectionDraw,
  schema: schema as unknown as ZodType<IsmsConfig>,
  validate: (c) => {
    if (c.catalogue && !findCatalogue(c.catalogue)) throw Object.assign(new Error(`Control catalogue not found: ${c.catalogue}`), { statusCode: 400 });
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
});
