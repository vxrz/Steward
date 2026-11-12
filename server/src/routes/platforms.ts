import fs from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { confirmPlatformConfig, confirmReview } from '../platforms/integrity.js';
import { HttpError } from '../util.js';
import * as platforms from '../platforms/service.js';
import * as connectors from '../platforms/connectors.js';
import * as recordings from '../platforms/recordings.js';
import { PATH_PREFIX_MAX } from '../platforms/pathPrefix.js';
import { platformRequest, renewToken, usesCachedToken } from '../platforms/http.js';
import { runConnectionTest, redactSecrets } from '../platforms/testConnection.js';
import { platformAccess } from '../auth/step-up-rules.js';
import { requireCapability } from '../auth/permissions.js';
import { boundedRecord } from '@sm/shared';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { IMPORT_BODY_SHAPE } from '../bodyShape.js';
import { LARGE_BODIES } from '../bodyLimits.js';
import { ACCESS, me } from '../auth/access.js';
import { requirePlatform } from './helpers.js';
import { PRESET_SPECS } from '../platforms/presets.js';
import { moduleOfPlatformKind } from '@sm/shared';
import { moduleEnabled } from '../modules/registry.js';
import { params } from './params.js';
import { platformIdentityRoutes } from './platform-identities.js';
import { isPrivileged, privilegedRefusal } from '../platforms/privileged.js';
import {
  afterPlatformUpdate,
  credentialChoice,
  destinationRules,
  guardDestinationSecrets,
  planDestinationChange,
  recordDestinationChange,
} from '../platforms/destinationChange.js';
import { db } from '../db.js';
import { contentDisposition } from '../records/attachments.js';

const platformBody = z.object({
  name: z.string().min(1).max(200),
  kind: z.string().max(64).optional(),
  description: z.string().max(10000).optional(),
  baseUrl: z.string().max(2000).optional(),
  environment: z.string().max(100).optional(),
  config: z.any().optional(),
  secrets: boundedRecord(z.string().max(20000), 100).optional(),
});

/** A platform the current user has some permission on (404 otherwise, so ids can't be probed). */
function visiblePlatform(id: string) {
  const p = platforms.getPlatform(id);
  if (!p.permissions.length) throw new HttpError(404, `Platform ${id} not found`);
  return p;
}

/** Content type for showing an uploaded document inline, or null to force a download. */
function inlineDocType(data: Buffer, declared: string | undefined): string | null {
  const head = data.subarray(0, 12);
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.subarray(0, 6).toString('latin1').startsWith('GIF8')) return 'image/gif';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (/^text\/(plain|markdown|csv)$/.test(declared ?? '') && !data.includes(0)) return 'text/plain; charset=utf-8';
  return null;
}

const redact = redactSecrets;

/** Platforms, connector types, API specifications and documentation (mounted under /api). */
export async function platformRoutes(app: FastifyInstance): Promise<void> {
  // identities of a platform (0.13.0, ADR 0009 step 2)
  await platformIdentityRoutes(app);
  // ---------- platforms ----------
  // connectors of a switched-off module are not offered (ADR 0016); platforms of that kind stay as they are
  app.get('/platform-presets', async () =>
    connectors.listPresets().filter((p) => {
      const m = moduleOfPlatformKind(p.kind);
      return !m || moduleEnabled(m);
    }),
  );
  app.post('/platform-types', { config: { access: ACCESS.admin } }, async (req) => {
    requireCapability(me(), 'createPlatforms', 'create connector types');
    const b = z
      .object({
        fromPlatformId: z.string().max(200),
        kind: z.string().max(64).optional(),
        label: z.string().max(200).optional(),
        description: z.string().max(10000).optional(),
      })
      .parse(req.body);
    requirePlatform(b.fromPlatformId, 'manage', 'use this platform as a template');
    return connectors.createTypeFromPlatform(b.fromPlatformId, b);
  });
  app.post(
    '/platform-types/import',
    { config: { access: ACCESS.admin, rateLimit: ROUTE_LIMITS.heavy, smBodyShape: IMPORT_BODY_SHAPE }, bodyLimit: LARGE_BODIES.exports.bytes },
    async (req) => {
      requireCapability(me(), 'createPlatforms', 'import connector types');
      return connectors.importType(z.object({ package: z.any() }).parse(req.body).package);
    },
  );
  app.get('/platform-types/:kind/export', async (req, reply) => {
    const pkg = connectors.getPackage(params(req).kind!);
    reply.header('content-disposition', `attachment; filename="connector-${pkg.kind}.json"`);
    return pkg;
  });
  app.delete('/platform-types/:kind', { config: { access: ACCESS.admin } }, async (req) => {
    requireCapability(me(), 'createPlatforms', 'delete connector types');
    connectors.deleteType(params(req).kind!);
    return { ok: true };
  });
  // Platforms (names, base URLs, docs) are only visible to users with some permission on them.
  app.get('/platforms', async () => {
    const tests = platforms.lastConnectionTests();
    return platforms
      .listPlatforms()
      .filter((p) => p.permissions.length > 0)
      .map((p) => ({ ...p, lastTest: tests.get(p.id) ?? null }));
  });
  app.post('/platforms', { config: { access: ACCESS.admin } }, async (req) => {
    requireCapability(me(), 'createPlatforms', 'add platforms');
    return connectors.createPlatformFromType(platformBody.extend({ typeKind: z.string().optional() }).parse(req.body));
  });
  app.get('/platforms/:id', async (req) => visiblePlatform(params(req).id!));
  // a new address of the platform's stored credentials (security review 0.19.0 H1): a signed-in session with a step-up,
  // and the credentials are removed unless an administrator keeps them (platforms/destinationChange.ts)
  app.put(
    '/platforms/:id',
    {
      config: { stepUp: { action: 'changePlatformDestination', who: platformAccess.who, when: (req) => destinationRules.platform(params(req).id!, req.body) } },
    },
    async (req) => {
      const id = params(req).id!;
      requirePlatform(id, 'manage', 'change this platform');
      const { credentials, ...patch } = platformBody.partial().extend({ credentials: credentialChoice }).parse(req.body);
      const change = planDestinationChange(id, afterPlatformUpdate(id, patch), credentials);
      db().tx(() => {
        platforms.updatePlatform(id, patch);
        recordDestinationChange(id, change);
      });
      return platforms.getPlatform(id);
    },
  );
  app.put('/platforms/:id/access', { config: { stepUp: { action: 'grantAccess', ...platformAccess } } }, async (req) => {
    requirePlatform(params(req).id!, 'manage', 'change access to this platform');
    return platforms.setPlatformAccess(params(req).id!, z.object({ acl: z.array(z.any()).max(500) }).parse(req.body).acl);
  });
  app.delete('/platforms/:id', async (req) => {
    requirePlatform(params(req).id!, 'manage', 'delete this platform');
    platforms.deletePlatform(params(req).id!);
    return { ok: true };
  });
  // Connection settings changed outside the application (configuration integrity): an administrator reviews and confirms them.
  // what the confirmation seals and what it resets or removes (0.9.0): the identities' settings the platform page does not show
  app.get('/platforms/:id/confirm-config', { config: { access: ACCESS.admin } }, async (req) => {
    requireCapability(me(), 'createPlatforms', 'confirm platform settings');
    requirePlatform(params(req).id!, 'manage', 'confirm the settings of this platform');
    return confirmReview(params(req).id!);
  });
  app.post('/platforms/:id/confirm-config', { config: { access: ACCESS.admin } }, async (req) => {
    requireCapability(me(), 'createPlatforms', 'confirm platform settings');
    requirePlatform(params(req).id!, 'manage', 'confirm the settings of this platform');
    confirmPlatformConfig(params(req).id!);
    return platforms.getPlatform(params(req).id!);
  });
  app.put('/platforms/:id/secrets', async (req) => {
    requirePlatform(params(req).id!, 'manage', 'change credentials of this platform');
    const patch = boundedRecord(z.string().nullable(), 100).parse(req.body);
    // a secret a destination template names decides where the credentials go (security review 0.19.0 L3)
    guardDestinationSecrets(params(req).id!, undefined, patch);
    return platforms.setSecrets(params(req).id!, patch);
  });

  app.post('/platforms/:id/test', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    const id = params(req).id!;
    requirePlatform(id, 'use', 'use this platform');
    // the test itself (and its audit entry) is shared with the periodic connection test (v0.4.0, platforms/health.ts);
    // the old route tests the default identity (ADR 0009)
    const c = platforms.getConnection(id);
    return runConnectionTest(c.platform, c.secrets);
  });

  // Kafka (#112): the newest messages of a topic, for troubleshooting – off unless the platform allows it, platform managers only, audited
  app.post('/platforms/:id/kafka/peek', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    const id = params(req).id!;
    const p = platforms.getPlatform(id);
    const body = z
      .object({ topic: z.string().min(1).max(249), count: z.number().int().min(1).max(5).default(5) })
      .strict()
      .parse(req.body);
    const { peekTopic } = await import('../kafka/service.js');
    return { messages: await peekTopic(id, body.topic, body.count, me().username, p.permissions.includes('manage')) };
  });

  // Roles or permissions granted to the platform's technical user only appear in a new token: drop the cached one and log in again.
  app.post('/platforms/:id/token/renew', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    const id = params(req).id!;
    requirePlatform(id, 'manage', 'get a new token for this platform');
    // the default identity's token (ADR 0009)
    const { platform: p, secrets } = platforms.getConnection(id);
    if (!usesCachedToken(p)) throw new HttpError(400, 'This platform does not log in for a token', 'PLATFORM_NO_TOKEN');
    try {
      const token = await renewToken(p, secrets);
      audit({
        action: 'platform.token_renewed',
        entityType: 'platform',
        entityId: id,
        summary: `New access token for "${p.name}" (expires ${token.expiresAt})`,
      });
      return { ok: true, token };
    } catch (e) {
      const message = redact((e as Error).message, secrets) as string;
      audit({
        action: 'platform.token_renewed',
        entityType: 'platform',
        entityId: id,
        summary: `New access token for "${p.name}" failed: ${message.slice(0, 200)}`,
      });
      return { ok: false, message, token: null };
    }
  });

  // recorded responses for test runs (#105): read with "use", changed with "manage" (checked in recordings.ts)
  app.get('/platforms/:id/recordings', async (req) => recordings.listRecordings(params(req).id!));
  app.post('/platforms/:id/recordings', { bodyLimit: LARGE_BODIES.recordings.bytes }, async (req) =>
    recordings.createRecording(params(req).id!, recordings.recordingInput.parse(req.body)),
  );
  app.put('/platforms/:id/recordings/:recId', { bodyLimit: LARGE_BODIES.recordings.bytes }, async (req) =>
    recordings.updateRecording(params(req).id!, params(req).recId!, recordings.recordingInput.parse(req.body)),
  );
  app.delete('/platforms/:id/recordings/:recId', async (req) => {
    recordings.deleteRecording(params(req).id!, params(req).recId!);
    return { ok: true };
  });

  // a request with a privileged identity (0.14.0, ADR 0009 step 4): a step-up (platform.privilegedIdentity)
  const privilegedRequest = (req: FastifyRequest) => {
    const b = req.body && typeof req.body === 'object' ? (req.body as { identityId?: unknown }) : {};
    return isPrivileged(params(req).id!, typeof b.identityId === 'string' ? b.identityId : undefined);
  };
  app.post(
    '/platforms/:id/request',
    {
      config: {
        rateLimit: ROUTE_LIMITS.action,
        // only for someone who may use the platform (anyone else gets the route's own refusal)
        stepUp: { action: 'usePrivilegedIdentity', who: (req) => platforms.getPlatform(params(req).id!).permissions.includes('use'), when: privilegedRequest },
      },
    },
    async (req, reply) => {
      const id = params(req).id!;
      const b = z
        .object({
          method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']),
          path: z.string().min(1).max(8000),
          query: boundedRecord(z.string().max(8000), 200).optional(),
          headers: boundedRecord(z.string().max(8000), 100).optional(),
          body: z.any().optional(),
          // one of the platform's identities (0.13.0, ADR 0009): the caller must be allowed to use it; missing: the default
          identityId: z.string().max(100).optional(),
        })
        .parse(req.body);
      const write = !(b.method === 'GET' || b.method === 'HEAD');
      requirePlatform(id, write ? 'manage' : 'use', write ? 'send changing requests to this platform' : 'use this platform');
      if (b.identityId) {
        const { mayUseIdentity, requireIdentity } = await import('../platforms/identityService.js');
        const row = requireIdentity(id, b.identityId);
        if (!mayUseIdentity(me(), platforms.getPlatform(id), row))
          throw new HttpError(403, `You are not allowed to use the identity "${row.name}"`, 'IDENTITY_NOT_ALLOWED', { identity: row.name });
      }
      const { platform: p, secrets, identity } = platforms.getConnection(id, b.identityId);
      if (identity.privileged) {
        const refused = privilegedRefusal([{ platformId: id, platformName: p.name, identityId: identity.id, identityName: identity.name }]);
        if (refused) return reply.code(refused.status).send(refused.body);
      }
      const res = await platformRequest(p, secrets, { method: b.method, url: b.path, query: b.query, headers: b.headers, body: b.body });
      audit({
        action: write ? 'api.adhoc_write' : 'api.adhoc_read',
        entityType: 'platform',
        entityId: id,
        summary: `Ad-hoc ${b.method} ${b.path} on "${p.name}${(p.identities?.length ?? 0) > 1 ? ` · ${p.identityName}` : ''}" → HTTP ${res.status}`,
        details: {
          query: b.query,
          body: write ? redact(b.body, secrets) : undefined,
          identityId: p.identityId,
          identityName: p.identityName,
          ...(identity.privileged ? { privileged: true } : {}),
        },
      });
      return redact(res, secrets);
    },
  );

  // API specifications and operations reveal a platform's endpoints: only for users with some permission on it.
  app.get('/platforms/:id/specs', async (req) => (visiblePlatform(params(req).id!), platforms.listSpecs(params(req).id!)));
  app.post('/platforms/:id/specs', { bodyLimit: LARGE_BODIES.apiSpec.bytes }, async (req) => {
    requirePlatform(params(req).id!, 'manage', 'add API specifications');
    const b = z
      .object({
        name: z.string().max(200).optional(),
        content: z.string().min(2).max(connectors.MAX_SPEC_BYTES).optional(),
        url: z.string().min(1).max(2000).optional(),
      })
      .refine((x) => x.content || x.url, 'Provide content or url')
      .parse(req.body);
    const content = b.content ?? (await connectors.fetchSpec(params(req).id!, b.url!));
    return platforms.addSpec(params(req).id!, b.name ?? '', content, { basePath: await platforms.platformBasePath(params(req).id!) });
  });
  app.patch('/platforms/:id/specs/:specId', async (req) => {
    requirePlatform(params(req).id!, 'manage', 'change API specifications');
    // validated in setSpecPathPrefix (same rules as the default taken from the server URL)
    const b = z
      .object({ pathPrefix: z.string().max(PATH_PREFIX_MAX) })
      .strict()
      .parse(req.body);
    return platforms.setSpecPathPrefix(params(req).id!, params(req).specId!, b.pathPrefix);
  });
  // The specifications a built-in preset brings (e.g. Prometheus since 0.3.1) for platforms made before it had them;
  // names the platform already has are skipped, so this can be clicked again.
  app.post('/platforms/:id/specs/built-in', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    const id = params(req).id!;
    const p = requirePlatform(id, 'manage', 'add API specifications');
    const have = new Set(platforms.listSpecs(id).map((s) => s.name));
    const added: string[] = [];
    for (const s of PRESET_SPECS[p.kind]?.() ?? []) {
      if (have.has(s.name)) continue;
      platforms.addSpec(id, s.name, s.content);
      added.push(s.name);
    }
    return { added };
  });
  // Copies, not links: platforms of one kind can run different API versions, so each target gets its own spec.
  app.post('/platforms/:id/specs/:specId/copy', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    const id = params(req).id!;
    requirePlatform(id, 'manage', 'copy API specifications');
    const b = z
      .object({
        targets: z.array(z.string().min(1).max(100)).min(1).max(platforms.SPEC_COPY_MAX_TARGETS),
        replace: z.boolean().optional(),
        // "Also copy the operation filters" (0.13.0, ADR 0009): identities of the same name get the filter, or are created closed
        copyFilters: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    for (const t of new Set(b.targets)) if (t !== id) requirePlatform(t, 'manage', 'add API specifications to this platform');
    const result = platforms.copySpec(id, params(req).specId!, b.targets, { replace: b.replace });
    if (!b.copyFilters) return result;
    const { copyIdentityFilters } = await import('../platforms/identityService.js');
    const filters: Record<string, { created: string[]; updated: string[]; skipped: string[] }> = {};
    for (const c of result.copied) filters[c.platformId] = copyIdentityFilters(id, c.platformId, new Map([[params(req).specId!, c.specId]]));
    return { ...result, filters };
  });
  app.delete('/platforms/:id/specs/:specId', async (req) => {
    requirePlatform(params(req).id!, 'manage', 'remove API specifications');
    platforms.deleteSpec(params(req).id!, params(req).specId!);
    return { ok: true };
  });
  app.get('/specs/:specId/content', async (req, reply) => {
    const pid = platforms.specPlatformId(params(req).specId!);
    if (!pid || !platforms.getPlatform(pid).permissions.length) throw new HttpError(404, 'Spec not found');
    const c = platforms.getSpecContent(params(req).specId!);
    return reply.type(c.trim().startsWith('{') ? 'application/json' : 'text/yaml').send(c);
  });
  app.get('/platforms/:id/operations', async (req) => (visiblePlatform(params(req).id!), platforms.listOperations(params(req).id!)));

  app.get('/platforms/:id/docs', async (req) => (visiblePlatform(params(req).id!), platforms.listDocs(params(req).id!)));
  app.post('/platforms/:id/docs', async (req) => {
    const id = params(req).id!;
    requirePlatform(id, 'manage', 'add documentation');
    if (req.isMultipart()) {
      const file = await req.file();
      if (!file) throw new HttpError(400, 'No file');
      const data = await file.toBuffer();
      const title = (file.fields.title as { value?: string } | undefined)?.value ?? file.filename;
      return platforms.addDoc(id, { title, kind: 'file', filename: file.filename, mime: file.mimetype, data });
    }
    const httpUrl = z
      .string()
      .max(2000)
      .url()
      // URL.parse: an invalid URL is reported by .url(), it must not throw here
      .refine((u) => /^https?:$/.test(URL.parse(u)?.protocol ?? 'https:'), 'Only http and https links are allowed');
    const b = z
      .object({ title: z.string().max(200), kind: z.enum(['note', 'link']), content: z.string().max(200_000).optional(), url: httpUrl.optional() })
      .parse(req.body);
    return platforms.addDoc(id, b);
  });
  app.delete('/platforms/:id/docs/:docId', async (req) => {
    requirePlatform(params(req).id!, 'manage', 'remove documentation');
    platforms.deleteDoc(params(req).id!, params(req).docId!);
    return { ok: true };
  });
  app.get('/docs/:docId/file', async (req, reply) => {
    const d = platforms.getDoc(params(req).docId!);
    visiblePlatform(d.platformId);
    if (d.kind !== 'file' || !d.filename) throw new HttpError(404, 'No file');
    const data = fs.readFileSync(platforms.docPath(d.id, d.filename));
    // Uploaded files are untrusted: only PDFs, raster images and plain text open in the browser (type taken
    // from the content, not from the upload); everything else is a download that cannot run as page or script.
    const inline = inlineDocType(data, d.mime);
    // any characters of the uploaded name (review 0.20.0: one outside Latin-1 made the download fail with 500)
    reply.header('content-disposition', contentDisposition(d.filename, inline ? 'inline' : 'attachment'));
    reply.header('content-security-policy', "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; plugin-types application/pdf");
    return reply.type(inline ?? 'application/octet-stream').send(data);
  });
}
