import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { boundedRecord, HEARTBEAT_MAX_BODY_BYTES, MONITOR_PERMISSIONS } from '@sm/shared';
import { HttpError } from '../util.js';
import { vault } from '../vault.js';
import { currentUser } from '../auth/context.js';
import * as svc from './service.js';
import * as gateways from './gateways.js';
import * as engine from './engine.js';
import { handleGatewayBatch, handleHeartbeat } from './hooks.js';
import { canCreateMonitors, MONITOR_IMPORT_LIMITS, type CheckRow } from './model.js';
import { parseCsv } from './templates.js';
import { validateMonitorFile } from './validation.js';
import { db } from '../db.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { IMPORT_BODY_SHAPE } from '../bodyShape.js';
import { LARGE_BODIES } from '../bodyLimits.js';
import { monitorAccess } from '../auth/step-up-rules.js';

const params = (req: FastifyRequest) => req.params as Record<string, string>;

const saveBody = z.object({
  key: z.string().max(64).optional(),
  enabled: z.boolean().optional(),
  isTemplate: z.boolean().optional(),
  version: z.number().int().optional(),
  definition: z.unknown(),
});

/**
 * Monitors: management API for the web UI (signed in) and the heartbeat
 * endpoints under /api/hooks/ (machine-to-machine, authenticated by secret,
 * exempt from the session and CSRF checks in app.ts).
 */
export async function monitorRoutes(app: FastifyInstance): Promise<void> {
  // ---------- heartbeat endpoints ----------
  await app.register(async (hooks) => {
    // raw bytes: HMAC signatures are computed over the exact body
    hooks.removeAllContentTypeParsers();
    hooks.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: HEARTBEAT_MAX_BODY_BYTES }, (_req, body, done) => done(null, body));
    const call = (req: FastifyRequest) => ({
      raw: Buffer.isBuffer(req.body) ? req.body : undefined,
      contentType: req.headers['content-type'],
      headers: req.headers,
      ip: req.ip,
    });
    hooks.post('/hooks/monitor/:id', { config: { rateLimit: ROUTE_LIMITS.webhook }, bodyLimit: HEARTBEAT_MAX_BODY_BYTES }, async (req, reply) => {
      const res = await handleHeartbeat(params(req).id!, call(req));
      reply.header('cache-control', 'no-store');
      if (res.headers) reply.headers(res.headers);
      return reply.code(res.status).send(res.body);
    });
    hooks.post('/hooks/monitors', { config: { rateLimit: ROUTE_LIMITS.webhook }, bodyLimit: HEARTBEAT_MAX_BODY_BYTES }, async (req, reply) => {
      const res = await handleGatewayBatch(call(req));
      reply.header('cache-control', 'no-store');
      if (res.headers) reply.headers(res.headers);
      return reply.code(res.status).send(res.body);
    });
  });

  // ---------- monitors ----------
  app.get('/monitors', async (req) => {
    const q = req.query as { templates?: string };
    return svc.listMonitors({ templates: q.templates === undefined ? false : q.templates === '1' || q.templates === 'true' });
  });
  app.get('/monitors/meta', async () => ({
    // Same as capabilities.createMonitors in /auth/status (kept for API clients)
    canCreate: canCreateMonitors(currentUser()),
    permissions: MONITOR_PERMISSIONS,
    engineRunning: engine.engineRunning(),
    heartbeatPathPrefix: '/api/hooks/monitor/',
    gatewayPath: '/api/hooks/monitors',
  }));
  app.get('/monitors/examples', async () => svc.listExamples());
  // the platform chosen for each platform reference in the file (reference → platform id); without it names are resolved as before
  const platformChoices = z.record(z.string().min(1).max(200), z.string().min(1).max(64)).refine((m) => Object.keys(m).length <= 100, 'Too many platforms');
  app.post('/monitors/examples/:file', async (req) =>
    svc.importExample(params(req).file!, z.object({ platforms: platformChoices.optional() }).parse(req.body ?? {})),
  );
  app.post('/monitors/examples/:file/preview', async (req) => {
    svc.requireCreate();
    return { platforms: svc.exampleReferences(params(req).file!) };
  });
  const monitorImport = { config: { rateLimit: ROUTE_LIMITS.heavy, smBodyShape: IMPORT_BODY_SHAPE }, bodyLimit: LARGE_BODIES.monitorImport.bytes };
  app.post('/monitors/import', monitorImport, async (req) => {
    const b = z
      .object({
        yaml: z.string().min(1).max(MONITOR_IMPORT_LIMITS.yamlChars),
        key: z.string().max(64).optional(),
        platforms: platformChoices.optional(),
      })
      .parse(req.body);
    return svc.importMonitor(b.yaml, { key: b.key, platforms: b.platforms });
  });
  app.post('/monitors/import/preview', monitorImport, async (req) => {
    svc.requireCreate();
    const b = z.object({ yaml: z.string().min(1).max(MONITOR_IMPORT_LIMITS.yamlChars) }).parse(req.body);
    return { platforms: svc.importReferences(b.yaml) };
  });
  app.post('/monitors/validate', async (req) => {
    const b = z.object({ definition: z.unknown(), isTemplate: z.boolean().default(false) }).parse(req.body);
    return validateMonitorFile({ ...(b.definition as object), kind: b.isTemplate ? 'monitorTemplate' : 'monitor' });
  });
  app.post('/monitors', async (req) => {
    const b = saveBody.parse(req.body);
    return svc.createMonitor({ key: b.key, enabled: b.enabled, isTemplate: b.isTemplate, definition: b.definition });
  });
  app.get('/monitors/:id', async (req) => svc.getMonitor(params(req).id!));
  app.put('/monitors/:id', async (req) => {
    const b = saveBody.parse(req.body);
    return svc.updateMonitor(params(req).id!, { key: b.key, enabled: b.enabled, isTemplate: b.isTemplate, version: b.version, definition: b.definition });
  });
  app.post('/monitors/:id/enabled', async (req) => svc.setEnabled(params(req).id!, z.object({ enabled: z.boolean() }).parse(req.body).enabled));
  app.delete('/monitors/:id', async (req) => {
    svc.deleteMonitor(params(req).id!);
    return { ok: true };
  });
  app.put('/monitors/:id/access', { config: { stepUp: { action: 'grantAccess', ...monitorAccess } } }, async (req) => {
    const b = z
      .object({ acl: z.array(z.object({ subject: z.string(), permissions: z.array(z.string()).max(50) })).max(500), owner: z.string().optional() })
      .parse(req.body);
    return svc.setAccess(params(req).id!, b);
  });
  app.get('/monitors/:id/export', async (req, reply) => {
    const r = svc.requireMonitor(params(req).id!);
    reply.header('content-disposition', `attachment; filename="${r.key}.yaml"`);
    return reply.type('application/yaml; charset=utf-8').send(svc.exportMonitor(r.id));
  });
  app.get('/monitors/:id/history', async (req) => {
    const q = z
      .object({
        check: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(1000).optional(),
        before: z.coerce.number().int().min(1).optional(),
      })
      .parse(req.query ?? {});
    return svc.listHistory(params(req).id!, { checkId: q.check, limit: q.limit, beforeId: q.before });
  });
  app.get('/monitors/:id/checks/:checkId/results', async (req) =>
    svc.listResults(
      params(req).id!,
      params(req).checkId!,
      z.object({ limit: z.coerce.number().int().min(1).max(1000).default(50) }).parse(req.query ?? {}).limit,
    ),
  );
  app.post('/monitors/:id/run', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    const r = svc.requireMonitor(params(req).id!, 'acknowledge', 'run the checks of this monitor');
    if (!vault().unlocked) throw new HttpError(423, 'The vault is locked', 'VAULT_LOCKED');
    if (!engine.loadedMonitor(r.id))
      throw new HttpError(409, r.is_template ? 'Templates are not evaluated' : 'The monitor is not loaded', 'MONITOR_NOT_LOADED', {
        context: r.is_template ? 'template' : '',
      });
    await engine.evaluateMonitorNow(r.id);
    return svc.getMonitor(r.id);
  });
  app.post('/monitors/:id/checks/:checkId/rotate', async (req) => svc.rotateHeartbeatSecret(params(req).id!, params(req).checkId!));

  /** Sends a sample report through the real heartbeat endpoint (secret added server-side). */
  app.post('/monitors/:id/checks/:checkId/test-report', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    const r = svc.requireMonitor(params(req).id!, 'edit');
    const row = db().get<CheckRow>('SELECT * FROM monitor_checks WHERE monitor_id = ? AND check_id = ?', r.id, params(req).checkId);
    if (!row?.hook_id || !row.secret_enc) throw new HttpError(404, 'This check has no heartbeat endpoint', 'NO_HEARTBEAT');
    const report = z
      .object({ status: z.union([z.string(), z.boolean()]).optional(), value: z.unknown().optional(), data: z.unknown().optional() })
      .parse(req.body ?? {});
    const raw = JSON.stringify({ ...report, ts: new Date().toISOString() });
    const secret = vault().decrypt<string>(row.secret_enc);
    const res = await app.inject({
      method: 'POST',
      url: svc.heartbeatPath(row.hook_id),
      headers: {
        'content-type': 'application/json',
        'x-steward-signature': 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex'),
        'x-steward-token': secret,
      },
      payload: raw,
      remoteAddress: req.ip,
    });
    return { status: res.statusCode, response: JSON.parse(res.body || '{}') };
  });

  app.get('/monitors/:id/maintenance', async (req) => svc.listMaintenance(params(req).id!));
  app.post('/monitors/:id/maintenance', async (req) => {
    const b = z.object({ startsAt: z.string().optional(), endsAt: z.string(), reason: z.string().max(500).default('') }).parse(req.body);
    return svc.addMaintenance(params(req).id!, b);
  });
  app.delete('/monitors/:id/maintenance/:wid', async (req) => {
    svc.endMaintenance(params(req).id!, params(req).wid!);
    return { ok: true };
  });
  app.post('/monitors/:id/acknowledge', async (req) =>
    svc.acknowledge(params(req).id!, z.object({ comment: z.string().max(1000).default('') }).parse(req.body ?? {}).comment),
  );
  app.delete('/monitors/:id/acknowledge', async (req) => svc.unacknowledge(params(req).id!));

  // ---------- templates ----------
  app.post('/monitors/:id/instances', { bodyLimit: LARGE_BODIES.monitorInstances.bytes }, async (req) => {
    const b = z
      .object({
        rows: z
          .array(
            z.object({
              params: boundedRecord(z.unknown(), 100).default({}),
              name: z.string().max(160).optional(),
              key: z.string().max(64).optional(),
              enabled: z.boolean().optional(),
            }),
          )
          // the service refuses more than 500 with its own error (TOO_MANY_INSTANCES)
          .max(1000)
          .optional(),
        csv: z.string().max(MONITOR_IMPORT_LIMITS.csvChars).optional(),
      })
      .parse(req.body);
    let rows = b.rows ?? [];
    if (b.csv) {
      rows = parseCsv(b.csv).map((r) => {
        const { name, key, ...p } = r;
        return { params: p, name: name || undefined, key: key || undefined };
      });
    }
    return svc.instantiateTemplate(params(req).id!, rows);
  });
  app.post('/monitors/:id/resync', async (req) => svc.resyncInstance(params(req).id!));

  // ---------- gateways ----------
  app.get('/monitor-gateways', async () => gateways.listGateways());
  app.post('/monitor-gateways', async (req) => gateways.createGateway(gateways.gatewaySchema.parse(req.body)));
  app.put('/monitor-gateways/:id', async (req) => gateways.updateGateway(params(req).id!, gateways.gatewaySchema.parse(req.body)));
  app.post('/monitor-gateways/:id/rotate', async (req) => gateways.rotateGatewaySecret(params(req).id!));
  app.delete('/monitor-gateways/:id', async (req) => {
    gateways.deleteGateway(params(req).id!);
    return { ok: true };
  });
}
