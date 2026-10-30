import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CERTIFICATE_MAX_BYTES, CREDENTIAL_STATUSES, type CredentialList } from '@sm/shared';
import { audit } from '../audit.js';
import { currentUser } from '../auth/context.js';
import { requireCapability } from '../auth/permissions.js';
import { HttpError } from '../util.js';
import * as svc from './service.js';
import { belongsTargets } from './belongs.js';
import { parseCertificate, certificateBytes } from './certificates.js';
import { ROUTE_LIMITS } from '../rateLimits.js';

/**
 * Credentials register (mounted under /api). Documentation only: no route
 * accepts or returns a secret value.
 *   GET    /credentials                   list (filters: q, type, platform, status, owner, tag, dueWithinDays, archived)
 *   GET    /credentials/export.csv        the same list as CSV
 *   GET    /credentials/summary           due soon / overdue / expired (home page)
 *   GET    /credentials/settings          reminder defaults; PUT: administrators
 *   POST   /credentials/certificate/parse parse a public certificate (preview, nothing stored)
 *   POST   /credentials                   create
 *   GET    /credentials/:id               entry
 *   PUT    /credentials/:id               update
 *   GET    /credentials/:id/history       events
 *   POST   /credentials/:id/rotated       mark rotated {rotatedAt?, comment, expiresAt?, certificate?}
 *   POST   /credentials/:id/reviewed      mark reviewed {reviewedAt?, comment}
 *   POST   /credentials/:id/archive|restore  administrators
 *   DELETE /credentials/:id               administrators
 */

const params = (req: FastifyRequest) => req.params as Record<string, string>;
const me = () => {
  const u = currentUser();
  if (!u) throw new HttpError(401, 'Please sign in', 'NOT_SIGNED_IN');
  return u;
};

const list = (v: unknown): string[] | undefined => {
  if (v === undefined || v === '') return undefined;
  return (Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim()).filter(Boolean);
};

export const listQuery = z.object({
  q: z.string().max(200).optional(),
  type: z.preprocess(list, z.array(z.string().max(40)).max(20).optional()),
  platform: z.string().max(200).optional(),
  status: z.preprocess(list, z.array(z.enum(CREDENTIAL_STATUSES)).max(4).optional()),
  owner: z.string().max(254).optional(),
  tag: z.string().max(161).optional(),
  role: z.string().max(200).optional(),
  belongs: z
    .string()
    .max(120)
    .regex(/^(application|component|system):\S+$/)
    .optional(),
  dueWithinDays: z.coerce.number().int().min(0).max(3650).optional(),
  archived: z.enum(['exclude', 'include', 'only']).optional(),
});

const certBody = z.object({
  contentBase64: z
    .string()
    .max(Math.ceil((CERTIFICATE_MAX_BYTES * 4) / 3) + 16)
    .optional(),
  pem: z.string().max(CERTIFICATE_MAX_BYTES).optional(),
});

export async function credentialRoutes(app: FastifyInstance): Promise<void> {
  app.get('/credentials', async (req): Promise<CredentialList> => {
    me();
    const q = listQuery.parse(req.query ?? {});
    return { items: svc.listCredentials(q), canCreate: svc.canCreateCredentials() };
  });

  // the whole register (owners, locations, due dates) in one file: a recent confirmation first (auth/step-up.ts)
  app.get('/credentials/export.csv', { config: { rateLimit: ROUTE_LIMITS.heavy, stepUp: { action: 'exportCredentials' } } }, async (req, reply) => {
    me();
    const q = listQuery.parse(req.query ?? {});
    const items = svc.listCredentials({ ...q, archived: q.archived ?? 'include' });
    audit({
      action: 'credential.exported',
      entityType: 'credential',
      summary: `Credential register exported as CSV (${items.length} entries)`,
      details: { filters: q, count: items.length },
    });
    reply.header('content-disposition', `attachment; filename="credentials-${new Date().toISOString().slice(0, 10)}.csv"`);
    reply.header('cache-control', 'no-store');
    return reply.type('text/csv; charset=utf-8').send(svc.credentialsCsv(items));
  });

  // what an entry can belong to (#143): applications, their components, systems
  app.get('/credentials/belongs-targets', async () => {
    me();
    return belongsTargets();
  });

  app.get('/credentials/summary', async () => {
    me();
    return svc.dueSummary();
  });

  app.get('/credentials/settings', async () => {
    me();
    return svc.reminderSettings();
  });

  app.put('/credentials/settings', async (req) => {
    requireCapability(me(), 'manageSettings', 'change the credential reminder settings');
    return svc.saveReminderSettings(svc.reminderSettingsSchema.parse(req.body ?? {}));
  });

  app.post('/credentials/certificate/parse', async (req) => {
    me();
    let data: Buffer;
    if (req.isMultipart()) {
      const file = await req.file({ limits: { fileSize: CERTIFICATE_MAX_BYTES + 1, files: 1 } });
      if (!file) throw new HttpError(400, 'No file', 'NO_FILE');
      try {
        data = await file.toBuffer();
      } catch {
        throw new HttpError(400, `The file is too large (max. ${CERTIFICATE_MAX_BYTES / 1024} KB)`, 'FILE_TOO_LARGE_KIB', {
          maxKib: CERTIFICATE_MAX_BYTES / 1024,
        });
      }
    } else data = certificateBytes(certBody.parse(req.body ?? {}));
    return parseCertificate(data);
  });

  app.post('/credentials', async (req) => svc.createCredential(svc.credentialInputSchema.parse(req.body ?? {})));

  app.get('/credentials/:id', async (req) => svc.getCredential(params(req).id!));

  app.put('/credentials/:id', async (req) => svc.updateCredential(params(req).id!, svc.credentialInputSchema.parse(req.body ?? {})));

  app.get('/credentials/:id/history', async (req) => svc.credentialHistory(params(req).id!));

  app.post('/credentials/:id/rotated', async (req) => svc.markRotated(params(req).id!, svc.rotatedSchema.parse(req.body ?? {})));

  app.post('/credentials/:id/reviewed', async (req) => svc.markReviewed(params(req).id!, svc.reviewedSchema.parse(req.body ?? {})));

  app.post('/credentials/:id/archive', async (req) => svc.setArchived(params(req).id!, true));
  app.post('/credentials/:id/restore', async (req) => svc.setArchived(params(req).id!, false));

  app.delete('/credentials/:id', async (req) => {
    svc.deleteCredential(params(req).id!);
    return { ok: true };
  });
}
