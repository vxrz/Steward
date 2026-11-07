import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { LIBRARY_ITEM_KINDS, LIBRARY_LIMITS } from '@sm/shared';
import { ACCESS } from '../auth/access.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { LARGE_BODIES } from '../bodyLimits.js';
import { HttpError } from '../util.js';
import * as trust from './trust.js';
import * as install from './install.js';
import { stageUpload } from './releases.js';

const params = (req: FastifyRequest) => req.params as Record<string, string>;

const uploadBody = z.object({
  fileName: z.string().max(300).default('library.zip'),
  /** The .zip as base64 */
  content: z
    .string()
    .min(4)
    .max(Math.ceil((LIBRARY_LIMITS.maxUploadBytes * 4) / 3) + 8),
});
const holdBody = z.object({ held: z.boolean(), reason: z.string().trim().max(500).optional() });
const safeBody = (req: FastifyRequest) => (req.body ?? {}) as Record<string, unknown>;

/**
 * Shared procedure libraries (ADR 0014, docs/LIBRARIES.md).
 *
 * - Releases and installs: designers and administrators (the createProcesses capability), each item with the rights
 *   of a change by hand; connector types and Hold: administrators.
 * - Trusted publishers: administrators in a signed-in session (API tokens cannot change trust). Adding a publisher or
 *   key, removing one, widening the library list and lifting an expiry need a step-up (control point
 *   library.publishers); retiring and revoking a key do not – stopping a stolen key must be quick.
 * - Origins (the "From library" badge): everyone, for the items they can see.
 */
export async function libraryRoutes(app: FastifyInstance): Promise<void> {
  // ---------- libraries and releases ----------
  app.get('/libraries', async () => install.listLibraries());
  app.get('/libraries/:library', async (req) => install.getLibrary(params(req).library!));
  app.post('/libraries/:library/rollback', { config: { access: ACCESS.session, rateLimit: ROUTE_LIMITS.action } }, async (req) =>
    install.rollbackLibrary(params(req).library!, install.installInput.parse(req.body ?? {})),
  );
  app.post('/libraries/:library/uninstall', { config: { access: ACCESS.session } }, async (req) => {
    install.uninstallLibrary(params(req).library!);
    return { ok: true };
  });
  app.post('/libraries/:library/hold', { config: { access: ACCESS.adminSession } }, async (req) => {
    const b = holdBody.parse(req.body ?? {});
    return install.setHold(params(req).library!, b.held, b.reason);
  });
  app.get('/library-releases/:id', async (req) => install.getRelease(params(req).id!));
  app.get('/library-releases/:id/review', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => install.reviewRelease(params(req).id!));
  app.post('/library-releases/:id/install', { config: { access: ACCESS.session, rateLimit: ROUTE_LIMITS.action } }, async (req) =>
    install.installRelease(params(req).id!, install.installInput.parse(req.body ?? {})),
  );
  app.post('/library-releases/:id/approve', { config: { access: ACCESS.session, rateLimit: ROUTE_LIMITS.action } }, async (req) =>
    install.approveInstall(params(req).id!, z.object({ hash: z.string().max(100).default('') }).parse(req.body ?? {}).hash),
  );
  app.post('/library-releases/:id/withdraw', { config: { access: ACCESS.session } }, async (req) => install.withdrawInstall(params(req).id!));
  app.delete('/library-releases/:id', { config: { access: ACCESS.session } }, async (req) => {
    install.discardRelease(params(req).id!);
    return { ok: true };
  });
  app.post(
    '/library-releases/upload',
    { config: { access: ACCESS.session, rateLimit: ROUTE_LIMITS.action }, bodyLimit: LARGE_BODIES.libraryUpload.bytes },
    async (req) => {
      install.requireReviewer();
      const b = uploadBody.parse(req.body ?? {});
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b.content)) throw new HttpError(400, 'The file is not valid base64', 'LIBRARY_UPLOAD_INVALID');
      return stageUpload(b.fileName, Buffer.from(b.content, 'base64'));
    },
  );
  app.get('/library-origins', async (req) => {
    const q = z.object({ kind: z.enum(LIBRARY_ITEM_KINDS).optional() }).parse(req.query ?? {});
    return install.listLibraryOrigins(q.kind);
  });

  // ---------- trusted publishers ----------
  const step = (when?: (req: FastifyRequest) => boolean) => ({
    access: ACCESS.adminSession,
    stepUp: { action: 'changeTrustedPublishers' as const, who: 'manageSettings' as const, ...(when ? { when } : {}) },
  });
  app.get('/library-publishers', { config: { access: ACCESS.admin } }, async () => trust.listPublishers());
  app.post('/library-publishers', { config: step() }, async (req) => trust.addPublisher(trust.publisherInput.parse(req.body ?? {})));
  app.put(
    '/library-publishers/:id',
    {
      config: step((req) => {
        const b = trust.publisherUpdate.safeParse(safeBody(req));
        return !b.success || trust.widensLibraries(params(req).id!, b.data.libraries);
      }),
    },
    async (req) => trust.updatePublisher(params(req).id!, trust.publisherUpdate.parse(req.body ?? {})),
  );
  app.delete('/library-publishers/:id', { config: step() }, async (req) => {
    trust.removePublisher(params(req).id!);
    return { ok: true };
  });
  app.post('/library-publishers/:id/keys', { config: step() }, async (req) => trust.addKey(params(req).id!, trust.keyInput.parse(req.body ?? {})));
  app.put(
    '/library-keys/:id',
    {
      config: step((req) => {
        const b = trust.keyExpiryInput.safeParse(safeBody(req));
        return !b.success || trust.liftsExpiry(params(req).id!, b.data.expiresAt);
      }),
    },
    async (req) => trust.setKeyExpiry(params(req).id!, trust.keyExpiryInput.parse(req.body ?? {})),
  );
  app.post('/library-keys/:id/retire', { config: { access: ACCESS.adminSession } }, async (req) => trust.retireKey(params(req).id!));
  app.post('/library-keys/:id/revoke', { config: { access: ACCESS.adminSession } }, async (req) =>
    trust.revokeKey(params(req).id!, trust.revokeInput.parse(req.body ?? {}).reason),
  );
  app.delete('/library-keys/:id', { config: step() }, async (req) => {
    trust.removeKey(params(req).id!);
    return { ok: true };
  });
}
