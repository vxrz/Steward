import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { vault, publicKeyPem } from '../vault.js';
import { audit, queryAudit, chainEntriesAscending, prunedBase } from '../audit.js';
import { anchoringStatus, createCheckpoint, parseAnchor, saveEmailSettings, verificationResult, verifyWithAnchors, anchorFile } from '../audit-anchor.js';
import { auditCsv, auditExportBundle } from '../audit-export.js';
import { archiveForDownload, archiveStatusAsync, runArchiving, saveArchiveSettings, startFullVerification } from '../audit-archive.js';
import { HttpError } from '../util.js';
import { requireCapability } from '../auth/permissions.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { ACCESS, me } from '../auth/access.js';
import { requireRun } from './helpers.js';

/** Query strings are validated like bodies: one value per parameter, bounded, numbers as numbers. */
const queryText = z.string().max(500).optional();
const auditQuery = z.object({
  runId: z.string().max(200).optional(),
  entityType: queryText,
  entityId: queryText,
  action: queryText,
  q: queryText,
  actor: queryText,
  from: z.string().max(64).optional(),
  to: z.string().max(64).optional(),
  beforeSeq: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
});

/** Audit log, verification, anchoring and export (mounted under /api). */
export async function auditRoutes(app: FastifyInstance): Promise<void> {
  // ---------- audit ----------
  app.get('/audit', async (req) => {
    const q = auditQuery.parse(req.query ?? {});
    if (q.runId) requireRun(q.runId, 'view', 'view this run');
    else requireCapability(me(), 'viewAudit', 'view the audit log');
    return queryAudit(q);
  });
  // Verification against all anchors (local anchor file, SM_AUDIT_ANCHOR[_FILE], and an anchor pasted by the user).
  // Incremental (from the newest signed checkpoint) unless `full`; a pasted checkpoint is always checked in full.
  const verifyRoute = async (anchorText: string | undefined, via: string, full: boolean) => {
    requireCapability(me(), 'viewAudit', 'verify the audit log');
    const extra = anchorText?.trim() ? [parseAnchor(anchorText, 'checkpoint you entered')] : [];
    const mode = full || extra.length ? 'full' : 'incremental';
    const r = await verifyWithAnchors(extra, { mode });
    const pub = verificationResult(r, null);
    audit({
      action: 'audit.verified',
      entityType: 'audit',
      summary: `Audit chain verified${via}${mode === 'full' ? ' in full' : ''}: ${r.message}`,
      details: pub,
    });
    const checkpoint = r.ok ? await createCheckpoint('verify') : null;
    return verificationResult(r, checkpoint);
  };
  const fullQuery = z.object({ full: z.enum(['true', 'false', '1', '0']).optional() });
  app.get('/audit/verify', { config: { rateLimit: ROUTE_LIMITS.heavy } }, async (req) => {
    const q = fullQuery.parse(req.query ?? {});
    return verifyRoute(undefined, '', q.full === 'true' || q.full === '1');
  });
  app.post('/audit/verify', { config: { rateLimit: ROUTE_LIMITS.heavy }, bodyLimit: 256 * 1024 }, async (req) =>
    verifyRoute(z.object({ anchor: z.string().max(200_000).optional() }).parse(req.body ?? {}).anchor, ' against an external checkpoint', true),
  );
  // a full verification in the background (progress: GET /audit/archive)
  app.post('/audit/verify/full', { config: { access: ACCESS.admin, rateLimit: ROUTE_LIMITS.heavy } }, async () => {
    requireCapability(me(), 'manageSettings', 'start a full verification of the audit log');
    const { started } = startFullVerification();
    if (started) audit({ action: 'audit.full_verification_started', entityType: 'audit', summary: 'Full verification of the audit chain started' });
    return archiveStatusAsync();
  });

  // ---------- epochs, archives, retention ----------
  app.get('/audit/archive', async () => {
    requireCapability(me(), 'viewAudit', 'view the audit archive');
    return archiveStatusAsync();
  });
  app.put('/audit/archive', { config: { access: ACCESS.admin, stepUp: { action: 'changeAuditAnchoring', who: 'manageSettings' } } }, async (req) => {
    requireCapability(me(), 'manageSettings', 'change the audit archive and retention');
    await saveArchiveSettings(req.body);
    return archiveStatusAsync();
  });
  app.post('/audit/archive/run', { config: { access: ACCESS.admin, rateLimit: ROUTE_LIMITS.heavy } }, async () => {
    requireCapability(me(), 'manageSettings', 'archive the audit log');
    const r = await runArchiving();
    return { ...(await archiveStatusAsync()), run: { archived: r.archived.length, uploaded: r.uploaded, deleted: r.deleted, problems: r.problems } };
  });
  app.get(
    '/audit/archives/:archiveId/file',
    { config: { rateLimit: ROUTE_LIMITS.heavy, stepUp: { action: 'exportAuditLog', who: 'viewAudit' } } },
    async (req, reply) => {
      requireCapability(me(), 'viewAudit', 'download an audit archive');
      const a = archiveForDownload((req.params as { archiveId: string }).archiveId);
      reply.header('content-disposition', `attachment; filename="${a.name.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
      return reply.type('application/zip').send(fs.createReadStream(a.file));
    },
  );

  app.get('/audit/anchoring', async () => {
    requireCapability(me(), 'viewAudit', 'view the audit anchoring');
    return anchoringStatus();
  });
  // where the signed checkpoints go (the evidence that the log was not changed)
  app.put('/audit/anchoring', { config: { access: ACCESS.admin, stepUp: { action: 'changeAuditAnchoring', who: 'manageSettings' } } }, async (req) => {
    requireCapability(me(), 'manageSettings', 'change the audit anchoring');
    const b = z
      .object({ emailRecipients: z.array(z.string().max(200)).max(20), emailIntervalHours: z.number().int().min(1).max(168).optional() })
      .parse(req.body);
    saveEmailSettings({ to: b.emailRecipients, intervalHours: b.emailIntervalHours });
    return anchoringStatus();
  });
  app.post('/audit/checkpoint', { config: { rateLimit: ROUTE_LIMITS.heavy } }, async () => {
    requireCapability(me(), 'viewAudit', 'create an audit checkpoint');
    const cp = await createCheckpoint('manual');
    if (!cp) throw new HttpError(409, 'No checkpoint written – the audit chain did not verify (see the server log) or the log is empty');
    return cp;
  });
  app.get('/audit/public-key.pem', async (_req, reply) => {
    requireCapability(me(), 'viewAudit', 'export the audit signing key');
    const pub = vault().signingPublicKey();
    if (!pub) throw new HttpError(404, 'No signing key yet – unlock the vault once');
    reply.header('content-disposition', 'attachment; filename="steward-audit-public-key.pem"');
    return reply.type('application/x-pem-file').send(publicKeyPem(pub));
  });
  app.get('/audit/anchor.json', async (_req, reply) => {
    requireCapability(me(), 'viewAudit', 'export the audit anchor');
    if (!fs.existsSync(anchorFile())) throw new HttpError(404, 'No checkpoint yet');
    reply.header('content-disposition', 'attachment; filename="steward-audit-checkpoint.json"');
    return reply.type('application/json').send(fs.readFileSync(anchorFile(), 'utf8'));
  });

  // the whole audit trail leaves Steward (like an evidence pack)
  app.get('/audit/export', { config: { rateLimit: ROUTE_LIMITS.heavy, stepUp: { action: 'exportAuditLog', who: 'viewAudit' } } }, async (req, reply) => {
    requireCapability(me(), 'viewAudit', 'export the audit log');
    const format = (req.query as { format?: string }).format ?? 'jsonl';
    if (!['jsonl', 'csv', 'json'].includes(format)) throw new HttpError(400, 'format: jsonl, csv or json');
    // a fresh signed checkpoint, so the file can be checked offline (npm run audit:verify-export)
    const checkpoint = await createCheckpoint('export');
    // the chain in the database: after archived entries were deleted, from the signed checkpoint it continues
    const base = prunedBase();
    const start = base && !('problem' in base) ? base : null;
    const all = chainEntriesAscending(start?.seq ?? 0);
    audit({
      action: 'audit.exported',
      entityType: 'audit',
      summary: `Audit log exported (${all.length} entries${start ? ` after #${start.seq}; the entries before are archived` : ''}, ${format})`,
    });
    if (format === 'csv') {
      reply.header('content-disposition', 'attachment; filename="audit-log.csv"');
      return reply.type('text/csv; charset=utf-8').send(auditCsv(all));
    }
    if (format === 'json') {
      reply.header('content-disposition', 'attachment; filename="audit-log.json"');
      return reply.type('application/json').send(JSON.stringify(auditExportBundle(all, checkpoint, start?.checkpoint ?? null), null, 1));
    }
    reply.header('content-disposition', 'attachment; filename="audit-log.jsonl"');
    return reply.type('application/x-ndjson').send(all.map((a) => JSON.stringify(a)).join('\n'));
  });
}
