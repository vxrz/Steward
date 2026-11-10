import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AUTH_TYPES, IDENTITY_MCP_MODES, boundedRecord } from '@sm/shared';
import { audit } from '../audit.js';
import { HttpError } from '../util.js';
import * as platforms from '../platforms/service.js';
import * as identities from '../platforms/identityService.js';
import { renewToken, usesCachedToken } from '../platforms/http.js';
import { redactSecrets, runConnectionTest } from '../platforms/testConnection.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { requirePlatform } from './helpers.js';
import { params } from './params.js';
import { ACCESS, me } from '../auth/access.js';
import { requireCapability } from '../auth/permissions.js';

/**
 * Platform identities (0.13.0, ADR 0009 step 2), mounted under /api with the platform routes:
 *
 *   GET    /platforms/:id/identities                              whoever sees the platform (names and flags)
 *   POST   /platforms/:id/identities                              manage
 *   GET    /platforms/:id/identities/:identityId/settings         manage (sign-in settings, variables – never credentials)
 *   PUT    /platforms/:id/identities/:identityId                  manage; loosening (read-only or privileged off, wider filter): step-up
 *   DELETE /platforms/:id/identities/:identityId                  manage; never the default, never one still in use
 *   PUT    /platforms/:id/identities/:identityId/secrets          manage; ?rotation=1 records it on the register entries (0.14.0)
 *   PUT    /platforms/:id/identities/:identityId/access           manage; adding someone: step-up (grantAccess)
 *   PUT    /platforms/:id/identities/:identityId/mcp              manage; approved writes on: step-up (allowMcpWrites)
 *   POST   /platforms/:id/identities/:identityId/default          manage; step-up (everyone with "use" gets it)
 *   POST   /platforms/:id/identities/:identityId/enable           administrators with manage; step-up (a disabled identity)
 *   POST   /platforms/:id/identities/:identityId/test             manage (audited platform.tested with the identity)
 *   POST   /platforms/:id/identities/:identityId/token/renew      manage
 *
 * Managing an identity does not make someone its user (ADR 0009, decided question 1).
 */
const operationRef = z.object({
  specId: z.string().max(64),
  method: z.string().max(10),
  specPath: z.string().max(2000),
  operationId: z.string().max(300).optional(),
});
const filterBody = z.object({ preset: z.enum(['read', 'chosen']), operations: z.array(operationRef).max(2000).default([]) }).nullable();
const identityBody = z
  .object({
    name: z.string().max(200),
    description: z.string().max(2000).optional(),
    auth: z
      .object({ type: z.enum(AUTH_TYPES) })
      .passthrough()
      .nullable()
      .optional(),
    variables: boundedRecord(z.string().max(2000), 100).optional(),
    readOnly: z.boolean().optional(),
    // 0.14.0 (ADR 0009 step 4): turning it off loosens the identity (step-up, like read-only off)
    privileged: z.boolean().optional(),
    operationFilter: filterBody.optional(),
  })
  .strict();
const mcpBody = z.object({ mode: z.enum(IDENTITY_MCP_MODES), writes: z.enum(['confirm', 'fourEyes']).optional() }).strict();

const ids = (req: FastifyRequest) => {
  const p = params(req);
  return { id: p.id!, identityId: p.identityId! };
};
const manages = (req: FastifyRequest) => {
  try {
    return platforms.getPlatform(ids(req).id).permissions.includes('manage');
  } catch {
    return false;
  }
};
const body = (req: FastifyRequest) => (req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {});

export async function platformIdentityRoutes(app: FastifyInstance): Promise<void> {
  app.get('/platforms/:id/identities', async (req) => {
    const p = platforms.getPlatform(params(req).id!);
    if (!p.permissions.length) throw new HttpError(404, `Platform ${params(req).id} not found`, 'PLATFORM_NOT_FOUND', { id: params(req).id! });
    return p.identities ?? [];
  });
  app.post('/platforms/:id/identities', async (req) => {
    const id = params(req).id!;
    requirePlatform(id, 'manage', 'add identities to this platform');
    return identities.createIdentity(id, identityBody.parse(req.body));
  });
  app.get('/platforms/:id/identities/:identityId/settings', async (req) => {
    const { id, identityId } = ids(req);
    requirePlatform(id, 'manage', 'see the settings of this identity');
    return identities.identitySettings(id, identityId);
  });
  app.put(
    '/platforms/:id/identities/:identityId',
    {
      config: {
        // loosening an identity (read-only off, a wider or removed operation filter) is confirmed like a grant
        stepUp: { action: 'grantAccess', who: manages, when: (req) => identities.identityChangeLoosens(ids(req).id, ids(req).identityId, body(req)) },
      },
    },
    async (req) => {
      const { id, identityId } = ids(req);
      requirePlatform(id, 'manage', 'change this identity');
      return identities.updateIdentity(id, identityId, identityBody.partial().parse(req.body));
    },
  );
  app.delete('/platforms/:id/identities/:identityId', async (req) => {
    const { id, identityId } = ids(req);
    requirePlatform(id, 'manage', 'delete this identity');
    identities.deleteIdentity(id, identityId);
    return { ok: true };
  });
  app.put('/platforms/:id/identities/:identityId/secrets', async (req) => {
    const { id, identityId } = ids(req);
    requirePlatform(id, 'manage', 'change the credentials of this identity');
    // "This is a rotation" (0.14.0, ADR 0009 step 4): ?rotation=1 records it on the register entries that document the identity
    const { rotation } = z.object({ rotation: z.enum(['0', '1']).optional() }).parse(req.query ?? {});
    const patch = boundedRecord(z.string().max(20000).nullable(), 100).parse(req.body);
    const out = identities.setIdentitySecrets(id, identityId, patch);
    // a new value, not only removed ones
    if (rotation === '1' && Object.values(patch).some((v) => !!v)) {
      const { recordIdentityRotation } = await import('../credentials/service.js');
      recordIdentityRotation(id, identityId, me().username);
    }
    return out;
  });
  app.put(
    '/platforms/:id/identities/:identityId/access',
    {
      config: {
        stepUp: { action: 'grantAccess', who: manages, when: (req) => identities.accessAddsSubjects(ids(req).id, ids(req).identityId, body(req).acl) },
      },
    },
    async (req) => {
      const { id, identityId } = ids(req);
      requirePlatform(id, 'manage', 'change who may use this identity');
      return identities.setIdentityAccess(id, identityId, z.object({ acl: z.array(z.any()).max(500) }).parse(req.body).acl);
    },
  );
  app.put(
    '/platforms/:id/identities/:identityId/mcp',
    { config: { stepUp: { action: 'allowMcpWrites', who: manages, when: (req) => identities.mcpTurnsWritesOn(ids(req).id, ids(req).identityId, body(req)) } } },
    async (req) => {
      const { id, identityId } = ids(req);
      requirePlatform(id, 'manage', 'change the MCP mode of this identity');
      return identities.setIdentityMcp(id, identityId, mcpBody.parse(req.body));
    },
  );
  app.post(
    '/platforms/:id/identities/:identityId/default',
    // everyone with "use" on the platform gets the new default identity: confirmed like a grant
    { config: { stepUp: { action: 'grantAccess', who: manages } } },
    async (req) => {
      const { id, identityId } = ids(req);
      requirePlatform(id, 'manage', 'change the default identity of this platform');
      return identities.makeDefaultIdentity(id, identityId);
    },
  );
  // an identity kept disabled at the confirmation of settings changed outside Steward (0.13.0): administrators enable it
  // one by one, after reading its access list, with a step-up – like the confirmation itself
  app.post(
    '/platforms/:id/identities/:identityId/enable',
    { config: { access: ACCESS.admin, stepUp: { action: 'grantAccess', who: manages } } },
    async (req) => {
      const { id, identityId } = ids(req);
      requireCapability(me(), 'createPlatforms', 'enable identities');
      requirePlatform(id, 'manage', 'enable identities of this platform');
      return identities.enableIdentity(id, identityId);
    },
  );
  app.post('/platforms/:id/identities/:identityId/test', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    const { id, identityId } = ids(req);
    requirePlatform(id, 'manage', 'test this identity');
    identities.requireIdentity(id, identityId);
    const c = platforms.getConnection(id, identityId);
    return runConnectionTest(c.platform, c.secrets);
  });
  app.post('/platforms/:id/identities/:identityId/token/renew', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    const { id, identityId } = ids(req);
    requirePlatform(id, 'manage', 'get a new token for this identity');
    identities.requireIdentity(id, identityId);
    const { platform: p, secrets } = platforms.getConnection(id, identityId);
    if (!usesCachedToken(p)) throw new HttpError(400, 'This platform does not log in for a token', 'PLATFORM_NO_TOKEN');
    const label = identities.identityLabel(p.name, p.identityName);
    try {
      const token = await renewToken(p, secrets);
      audit({
        action: 'platform.token_renewed',
        entityType: 'platform',
        entityId: id,
        summary: `New access token for "${label}" (expires ${token.expiresAt})`,
        details: { identityId },
      });
      return { ok: true, token };
    } catch (e) {
      const message = redactSecrets((e as Error).message, secrets) as string;
      audit({
        action: 'platform.token_renewed',
        entityType: 'platform',
        entityId: id,
        summary: `New access token for "${label}" failed: ${message.slice(0, 200)}`,
        details: { identityId },
      });
      return { ok: false, message, token: null };
    }
  });
}
