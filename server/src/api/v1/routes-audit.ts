/** /api/v1 routes for the audit log and its verification. */
import { audit, queryAudit } from '../../audit.js';
import { createCheckpoint, verificationResult, verifyWithAnchors } from '../../audit-anchor.js';
import { currentUser } from '../../auth/context.js';
import { capabilities, requireCapability } from '../../auth/permissions.js';
import { decodeCursor, pageRows } from './pagination.js';
import * as S from './schemas.js';
import { iso, paged, query, viewableRun, type Get } from './helpers.js';

const mapAudit = (a: ReturnType<typeof queryAudit>[number]) => ({
  seq: a.seq,
  ts: a.ts,
  actor: a.actor,
  action: a.action,
  entityType: a.entityType,
  entityId: a.entityId ?? null,
  runId: a.runId ?? null,
  summary: a.summary,
  details: a.details ?? null,
  hash: a.hash,
});

export function auditRoutes(get: Get): void {
  get(
    '/audit',
    {
      operationId: 'listAuditEntries',
      tag: 'Audit',
      summary: 'List audit log entries',
      description: 'Auditors and administrators; others only with `runId` of a run they may view. Newest first.',
      query: S.AuditListQuery,
      paginated: true,
      response: S.pageOf('AuditEntry', 'A page of audit entries'),
    },
    async (req, reply) => {
      const q = query<{
        action?: string;
        actor?: string;
        entityType?: string;
        entityId?: string;
        runId?: string;
        q?: string;
        from?: string;
        to?: string;
        cursor?: string;
        limit: number;
      }>(req);
      if (q.runId && !capabilities(currentUser()).viewAudit) viewableRun(q.runId);
      else requireCapability(currentUser(), 'viewAudit', 'view the audit log');
      const after = decodeCursor(q.cursor, q);
      const rows = queryAudit({
        action: q.action,
        actor: q.actor,
        entityType: q.entityType,
        entityId: q.entityId,
        runId: q.runId,
        q: q.q,
        from: iso(q.from),
        to: iso(q.to),
        beforeSeq: after ? Number(after[0]) : undefined,
        limit: q.limit + 1,
      });
      return paged(
        req,
        reply,
        pageRows(rows.map(mapAudit), q.limit, (a) => [a.seq], q),
      );
    },
  );

  get(
    '/audit/verify',
    {
      operationId: 'verifyAuditLog',
      tag: 'Audit',
      summary: 'Verify the hash chain of the audit log',
      description: 'Auditors and administrators. The verification itself is recorded in the audit log.',
      response: S.ref('AuditVerifyResult'),
    },
    async () => {
      requireCapability(currentUser(), 'viewAudit', 'verify the audit log');
      // compared with the configured anchors (local anchor file, SM_AUDIT_ANCHOR[_FILE]); a success is checkpointed
      const r = await verifyWithAnchors();
      audit({ action: 'audit.verified', entityType: 'audit', summary: `Audit chain verified via the API: ${r.message}`, details: verificationResult(r, null) });
      if (r.ok) await createCheckpoint('verify');
      return { ok: r.ok, checked: r.checked, firstBadSeq: r.firstBadSeq ?? null, message: r.message };
    },
  );
}
