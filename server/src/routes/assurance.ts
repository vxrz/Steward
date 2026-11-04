import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { REPORT_LANGS, assurancePolicyInput } from '@sm/shared';
import { ACCESS, me } from '../auth/access.js';
import { requireCapability } from '../auth/permissions.js';
import { approveChange, policyAt, policyHistory, policyView, rejectChange, savePolicy } from '../auth/assurance.js';
import { assuranceReportJson, collectAssuranceReport, renderAssurancePdf } from '../compliance/assurance-report.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { audit } from '../audit.js';
import { ensureDefaultTypes } from '../records/types.js';

/**
 * The assurance policy (#210, auth/assurance.ts): Settings → Assurance policy. Administrators and auditors read it, its
 * history and the report; administrators change it in a signed-in session with a step-up (the baseline of the
 * control point assurance.policy) – loosening waits for a second administrator.
 *
 * Not in the public API (/api/v1): the policy is an administrator's setting of this instance, and auditors take it
 * from the report and the evidence packs, which carry the policy, its changes and the proofs.
 */
const READERS = { roles: ['admin', 'auditor'] } as const;
const STEP_UP = { action: 'changeAssurancePolicy' as const, who: 'manageSettings' as const };
const iso = z.string().datetime({ offset: true });
const changeParams = z.object({ changeId: z.string().min(1).max(64) });

export async function assuranceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/assurance/policy', { config: { access: READERS } }, async () => {
    requireCapability(me(), 'viewAudit', 'read the assurance policy');
    // the built-in record types exist before their overrides are listed
    ensureDefaultTypes();
    return policyView(me());
  });
  app.put('/assurance/policy', { config: { access: ACCESS.adminSession, stepUp: STEP_UP } }, async (req) => {
    const input = assurancePolicyInput.parse(req.body);
    return savePolicy({ ...input, points: input.points }, me());
  });
  app.post('/assurance/policy/changes/:changeId/approve', { config: { access: ACCESS.adminSession, stepUp: STEP_UP } }, async (req) =>
    approveChange(changeParams.parse(req.params).changeId, me()),
  );
  // rejecting (or withdrawing one's own request) keeps the stricter rules: no confirmation needed
  app.post('/assurance/policy/changes/:changeId/reject', { config: { access: ACCESS.adminSession } }, async (req) => {
    const b = z
      .object({ comment: z.string().max(1000).default('') })
      .strict()
      .parse(req.body ?? {});
    return rejectChange(changeParams.parse(req.params).changeId, me(), b.comment);
  });
  app.get('/assurance/policy/history', { config: { access: READERS } }, async (req) => {
    requireCapability(me(), 'viewAudit', 'read the assurance policy');
    const q = z.object({ from: iso.optional(), to: iso.optional() }).parse(req.query ?? {});
    return policyHistory(q);
  });
  app.get('/assurance/policy/as-of', { config: { access: READERS } }, async (req) => {
    requireCapability(me(), 'viewAudit', 'read the assurance policy');
    return policyAt(z.object({ at: iso }).parse(req.query ?? {}).at);
  });
  // the report is an excerpt of the audit log: confirmed like an export of it
  app.get(
    '/assurance/report',
    { config: { access: READERS, rateLimit: ROUTE_LIMITS.heavy, stepUp: { action: 'exportAuditLog', who: 'viewAudit' } } },
    async (req, reply) => {
      const q = z
        .object({
          from: iso,
          to: iso,
          lang: z.enum(REPORT_LANGS).default('en'),
          format: z.enum(['pdf', 'json']).default('pdf'),
          tz: z.string().max(64).optional(),
        })
        .parse(req.query ?? {});
      const r = collectAssuranceReport({ from: q.from, to: q.to, lang: q.lang, timeZone: q.tz }, me());
      const name = `steward-assurance-${r.model.from.slice(0, 10)}-${r.model.to.slice(0, 10)}`;
      audit({
        action: 'assurance.report_exported',
        entityType: 'assurance_policy',
        entityId: String(r.model.endVersion),
        summary: `Assurance report ${r.model.from} – ${r.model.to} exported (${q.format})`,
        details: { from: r.model.from, to: r.model.to, format: q.format, events: r.events.length },
      });
      if (q.format === 'json') {
        reply.header('content-disposition', `attachment; filename="${name}.json"`);
        return reply.type('application/json').send(JSON.stringify(assuranceReportJson(r), null, 2));
      }
      const pdf = await renderAssurancePdf(r.model);
      reply.header('content-disposition', `attachment; filename="${name}.pdf"`);
      return reply.type('application/pdf').send(pdf);
    },
  );
}
