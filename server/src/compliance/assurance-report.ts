import { CONTROL_POINTS, controlPoint, instanceRule, type PolicyChange, type ReportLang } from '@sm/shared';
import { authenticRows } from '../audit.js';
import { db } from '../db.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import { capabilities } from '../auth/permissions.js';
import type { AuthUser } from '../auth/context.js';
import { policyAsOf, policyHistory, type AssuranceProof } from '../auth/assurance.js';
import { stepUpWindowMs } from '../auth/step-up.js';
import { drawPdf } from '../reports/pdf/pool.js';
import { getBranding, logo } from '../reports/branding.js';
import { POINT_LABELS, type AssuranceReportModel } from './assurance-pdf.js';
import { moduleAccessEvidence } from '../modules/access-evidence.js';

/**
 * The assurance report of a period (#210, docs/ASSURANCE.md#the-assurance-report): read from the authentic entries of
 * the audit log – the policy versions (`assurance.policy_changed`), the requests to loosen it, every entry that carries
 * an assurance proof (details.assurance), emergency sign-ins and refusals for missing multi-factor authentication.
 * Auditors and administrators (it is an excerpt of the audit log); a PDF/A, and inside evidence packs as PDF + JSON.
 */

export const ASSURANCE_REPORT_LIMITS = { entries: 50_000, events: 5000, maxPeriodDays: 3 * 366 };

const FIELD: Record<ReportLang, Record<string, string>> = {
  en: { fourEyes: 'four-eyes', stepUp: 'step-up', maxAgeMinutes: 'age (min)', mfa: 'MFA', values: 'values', none: 'SM_STEP_UP_MINUTES' },
  de: { fourEyes: 'Vier Augen', stepUp: 'Bestätigung', maxAgeMinutes: 'Alter (Min.)', mfa: 'MFA', values: 'Werte', none: 'SM_STEP_UP_MINUTES' },
};

export function describeChange(c: PolicyChange, lang: ReportLang): string {
  const f = FIELD[lang] ?? FIELD.en;
  const label = POINT_LABELS[lang]?.[c.point] ?? c.point;
  const v = (x: unknown) => (x === null ? f.none : Array.isArray(x) ? x.join(' ') || '–' : String(x));
  return `${label} – ${f[c.field] ?? c.field}: ${v(c.from)} → ${v(c.to)}`;
}

/** One event of the period: an audit entry's proof (the JSON of the report lists them). */
export interface AssuranceEvent {
  seq: number;
  ts: string;
  action: string;
  proof: AssuranceProof;
}

export function collectAssuranceReport(
  input: { from: string; to: string; lang: ReportLang; timeZone?: string | null },
  u: AuthUser,
): { model: AssuranceReportModel; events: AssuranceEvent[] } {
  if (!capabilities(u).viewAudit) throw new HttpError(403, 'Only auditors and administrators read the assurance report', 'FORBIDDEN', { context: 'viewAudit' });
  const from = new Date(input.from).toISOString();
  const to = new Date(input.to).toISOString();
  if (!(Date.parse(from) < Date.parse(to))) throw new HttpError(400, 'from must be before to', 'PERIOD_INVALID');
  if (Date.parse(to) - Date.parse(from) > ASSURANCE_REPORT_LIMITS.maxPeriodDays * 86_400_000)
    throw new HttpError(400, `The period may be at most ${ASSURANCE_REPORT_LIMITS.maxPeriodDays} days`, 'PERIOD_TOO_LONG', {
      max: ASSURANCE_REPORT_LIMITS.maxPeriodDays,
    });
  const lang = input.lang;
  const start = policyAsOf(from);
  const end = policyAsOf(to);

  const { rows, rejected } = authenticRows(
    `ts >= ? AND ts <= ? AND (lower(details) LIKE ? OR action IN ('auth.emergency_sign_in', 'assurance.mfa_refused', 'auth.step_up_failed', 'assurance.policy_change_requested'))`,
    [from, to, '%"assurance":[%'],
    { ascending: true, limit: ASSURANCE_REPORT_LIMITS.entries, ownOnly: true },
  );
  const points = new Map<string, { events: Set<string>; methods: Record<string, number>; fourEyes: Set<string> }>();
  const seen = new Set<string>();
  const events: AssuranceEvent[] = [];
  const exceptions: AssuranceReportModel['exceptions'] = [];
  const requests: AssuranceReportModel['requests'] = [];
  for (const r of rows) {
    const d = parseJson<Record<string, unknown>>(r.details, {});
    if (r.action === 'auth.emergency_sign_in') exceptions.push({ kind: 'emergencySignIn', at: r.ts, actor: r.actor, text: r.summary.slice(0, 300) });
    if (r.action === 'assurance.mfa_refused' || (r.action === 'auth.step_up_failed' && d.reason === 'STEP_UP_MFA_REQUIRED'))
      exceptions.push({ kind: 'mfaRefused', at: r.ts, actor: r.actor, text: r.summary.slice(0, 300) });
    if (r.action === 'assurance.policy_change_requested') {
      const row = db().get<{ status: string; decided_by: string | null }>(
        'SELECT status, decided_by FROM assurance_policy_changes WHERE id = ?',
        String(d.changeId ?? ''),
      );
      requests.push({
        at: r.ts,
        by: r.actor,
        outcome: row?.status ?? 'pending',
        decidedBy: row?.decided_by ?? null,
        changes: ((d.changes as PolicyChange[] | undefined) ?? []).map((c) => describeChange(c, lang)),
      });
    }
    for (const p of (Array.isArray(d.assurance) ? d.assurance : []) as AssuranceProof[]) {
      if (!p || typeof p.point !== 'string' || typeof p.ref !== 'string') continue;
      if (events.length < ASSURANCE_REPORT_LIMITS.events && !seen.has(`${p.ref}:${p.point}`))
        events.push({ seq: Number(r.seq), ts: r.ts, action: r.action, proof: p });
      const key = `${p.ref}:${p.point}`;
      const x = points.get(p.point) ?? { events: new Set<string>(), methods: {}, fourEyes: new Set<string>() };
      points.set(p.point, x);
      if (seen.has(key)) continue;
      seen.add(key);
      x.events.add(p.ref);
      const method = p.stepUp?.method ?? 'notRequired';
      x.methods[method] = (x.methods[method] ?? 0) + 1;
      if (p.fourEyes?.required) x.fourEyes.add(p.ref);
      if (method === 'emergency')
        exceptions.push({
          kind: 'emergencyConfirmation',
          at: r.ts,
          actor: p.actor,
          text: `${POINT_LABELS[lang]?.[p.point] ?? p.point}${p.rule?.mfa ? ' (MFA)' : ''} – ${r.summary.slice(0, 200)}`,
        });
      else if (p.rule?.mfa && p.stepUp && method !== 'notRequired' && !p.stepUp.mfa)
        exceptions.push({ kind: 'mfaMissing', at: r.ts, actor: p.actor, text: `${POINT_LABELS[lang]?.[p.point] ?? p.point} – ${method}` });
    }
  }
  const versions = policyHistory({ from, to }).map((v) => ({
    version: v.version,
    at: v.at,
    by: v.by,
    approvedBy: v.approvedBy,
    changes: v.changes.map((c) => describeChange(c, lang)),
  }));
  for (const v of versions)
    if (v.approvedBy) exceptions.push({ kind: 'loosening', at: v.at, actor: v.by, text: `${v.changes.join('; ')} – ${v.approvedBy}`.slice(0, 600) });
  exceptions.sort((a, b) => a.at.localeCompare(b.at));
  // the module layer (ADR 0034): who uses each restricted module now, and how module access changed in the period
  const moduleAccess = moduleAccessEvidence(from, to);

  const model: AssuranceReportModel = {
    from,
    to,
    generatedAt: nowIso(),
    generatedBy: u.username,
    lang,
    timeZone: input.timeZone ?? null,
    startVersion: start.policy.version,
    endVersion: end.policy.version,
    rules: CONTROL_POINTS.map((p) => {
      const r = instanceRule(p, end.policy);
      return {
        point: p.key,
        fourEyes: r.fourEyes,
        stepUp: r.stepUp,
        maxAgeMinutes: r.maxAgeMinutes,
        mfa: r.mfa,
        baseline: !!(p.baseline.stepUp || p.baseline.fourEyes),
      };
    }),
    windowMinutes: Math.round(stepUpWindowMs() / 60_000),
    versions,
    requests,
    points: [...points.entries()]
      .filter(([k]) => !!controlPoint(k))
      .map(([point, x]) => ({ point, events: x.events.size, methods: x.methods, fourEyes: x.fourEyes.size })),
    exceptions,
    audit: { entries: rows.length, rejected },
    truncated: rows.length >= ASSURANCE_REPORT_LIMITS.entries || moduleAccess.truncated,
    moduleAccess: { current: moduleAccess.current, changes: moduleAccess.changes },
  };
  return { model, events };
}

/** The PDF/A of the report, drawn in the PDF worker with the instance branding. */
export async function renderAssurancePdf(m: AssuranceReportModel, o: { compress?: boolean } = {}): Promise<Buffer> {
  return drawPdf('assurance', m, { branding: getBranding(), logo: logo().data }, o);
}

/** The JSON of the report (evidence packs): the model and every event with its audit sequence number. */
export const assuranceReportJson = (r: ReturnType<typeof collectAssuranceReport>) => ({
  format: 'steward-assurance-report',
  version: 1,
  ...r.model,
  events: r.events,
});
