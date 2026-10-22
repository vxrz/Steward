import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { WEBHOOK_MAX_BODY_BYTES, type WebhookMappingPreview, type WebhookTestResult } from '@sm/shared';
import { HttpError } from '../util.js';
import { currentUser } from '../auth/context.js';
import { require } from '../auth/permissions.js';
import { permissionsFor } from '../processes/service.js';
import { getPlatform } from '../platforms/service.js';
import * as triggers from '../triggers/service.js';
import { handleHook, registerTestNonce } from '../triggers/hook.js';

const params = (req: FastifyRequest) => req.params as Record<string, string>;

function requireProcessRun(processId: string) {
  const perms = permissionsFor(processId);
  if (!perms.includes('view')) throw new HttpError(404, `Process ${processId} not found`);
  require(perms, 'run', 'start this process from a webhook trigger');
}

function requireBindingsUsable(bindings: Record<string, string>) {
  for (const pid of Object.values(bindings)) require(getPlatform(pid).permissions, 'use', `use platform ${pid}`);
}

const previewBody = z.object({
  inputMapping: z.record(z.string().max(2000)).default({}),
  allowedHeaders: z.array(z.string()).max(20).default([]),
  payload: z.unknown().optional(),
  headers: z.record(z.string()).default({}),
  query: z.record(z.string()).default({}),
});

const testBody = z.object({
  payload: z.unknown().optional(),
  headers: z.record(z.string()).default({}),
  query: z.record(z.string()).default({}),
  dryRun: z.boolean().default(true),
});

/**
 * Webhook triggers: management API (signed in, same rights as schedules) and
 * the inbound endpoint `POST /api/hooks/:id` (public, authenticated by the
 * trigger's secret, exempt from the CSRF header check in app.ts).
 */
export async function triggerRoutes(app: FastifyInstance): Promise<void> {
  // ---------- inbound endpoint ----------
  await app.register(async (hooks) => {
    // Keep the raw bytes: HMAC signatures are computed over the exact body.
    hooks.removeAllContentTypeParsers();
    hooks.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: WEBHOOK_MAX_BODY_BYTES }, (_req, body, done) => done(null, body));
    hooks.post('/hooks/:id', { bodyLimit: WEBHOOK_MAX_BODY_BYTES }, async (req, reply) => {
      const res = await handleHook({
        triggerId: params(req).id!,
        raw: Buffer.isBuffer(req.body) ? req.body : undefined,
        contentType: req.headers['content-type'],
        headers: req.headers,
        query: (req.query ?? {}) as Record<string, unknown>,
        ip: req.ip,
      });
      reply.header('cache-control', 'no-store');
      if (res.headers) reply.headers(res.headers);
      return reply.code(res.status).send(res.body);
    });
  });

  // ---------- management ----------
  app.get('/triggers', async () => triggers.listTriggers());
  app.get('/triggers/:id', async (req) => triggers.getTrigger(params(req).id!));
  app.get('/triggers/:id/fires', async (req) => triggers.listFires(params(req).id!, Number((req.query as { limit?: string }).limit ?? 50)));

  app.post('/triggers', async (req) => {
    const b = triggers.settingsSchema.parse(req.body);
    requireProcessRun(b.processId);
    requireBindingsUsable(b.bindings);
    return triggers.createTrigger(b);
  });
  app.put('/triggers/:id', async (req) => {
    triggers.requireTriggerEdit(params(req).id!);
    const b = triggers.settingsSchema.parse(req.body);
    requireProcessRun(b.processId);
    requireBindingsUsable(b.bindings);
    return triggers.updateTrigger(params(req).id!, b);
  });
  app.delete('/triggers/:id', async (req) => {
    triggers.deleteTrigger(params(req).id!);
    return { ok: true };
  });
  app.post('/triggers/:id/rotate', async (req) => {
    const r = triggers.requireTriggerEdit(params(req).id!);
    requireProcessRun(r.process_id);
    return triggers.rotateSecret(r.id);
  });

  /** Evaluate a mapping against a sample payload (editor preview; nothing is started). */
  app.post('/triggers/preview-mapping', async (req): Promise<WebhookMappingPreview> => {
    if (!currentUser()) throw new HttpError(401, 'Please sign in');
    const b = previewBody.parse(req.body);
    const allowed = b.allowedHeaders.map((h) => h.toLowerCase());
    const headers = Object.fromEntries(Object.entries(b.headers).map(([k, v]) => [k.toLowerCase(), v]));
    return triggers.evaluateMapping(b.inputMapping, { body: b.payload ?? {}, headers: triggers.pickHeaders(headers, allowed), query: b.query });
  });

  /**
   * Test call: sends a sample payload through the real endpoint (same checks,
   * secret added server-side) and marks the call and the run as a test.
   * Dry run by default.
   */
  app.post('/triggers/:id/test', async (req): Promise<WebhookTestResult> => {
    const r = triggers.requireTriggerEdit(params(req).id!);
    requireProcessRun(r.process_id);
    if (!r.enabled) throw new HttpError(409, 'The trigger is disabled – enable it to test');
    const b = testBody.parse(req.body);
    const raw = JSON.stringify(b.payload ?? {});
    const secret = triggers.revealSecretForTest(r);
    const auth: Record<string, string> =
      r.auth_mode === 'hmac'
        ? { 'x-steward-signature': 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex') }
        : { 'x-steward-token': secret };
    const extra = Object.fromEntries(
      Object.entries(b.headers)
        .map(([k, v]) => [k.toLowerCase(), v] as const)
        .filter(([k]) => !['authorization', 'x-steward-token', 'x-steward-signature', 'x-steward-test', 'host', 'content-length'].includes(k)),
    );
    const qs = new URLSearchParams(b.query).toString();
    const res = await app.inject({
      method: 'POST',
      url: triggers.hookPath(r.id) + (qs ? `?${qs}` : ''),
      headers: { ...extra, 'content-type': 'application/json', ...auth, 'x-steward-test': registerTestNonce(r.id, b.dryRun) },
      payload: raw,
    });
    let response: WebhookTestResult['response'] = {};
    try {
      response = JSON.parse(res.body);
    } catch {
      response = { error: res.body.slice(0, 200) };
    }
    const preview = await triggers.evaluateMapping(JSON.parse(r.input_mapping), {
      body: b.payload ?? {},
      headers: triggers.pickHeaders(extra, JSON.parse(r.allowed_headers)),
      query: b.query,
    });
    return { status: res.statusCode, response, inputs: preview.inputs };
  });
}
