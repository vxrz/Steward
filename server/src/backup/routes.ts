import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser } from '../auth/context.js';
import { requireCapability } from '../auth/permissions.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { backupStatus, listStoredBackups, saveBackupSettings, setBackupPassphrase, startBackupRun } from './service.js';
import { ACCESS } from '../auth/access.js';

/** Backups to S3 (#117): administrators only (manageSettings); changes need a fresh confirmation (step-up). */
export async function backupRoutes(app: FastifyInstance): Promise<void> {
  const admin = (what: string) => requireCapability(currentUser(), 'manageSettings', what);
  app.get('/backups', { config: { access: ACCESS.admin } }, async () => {
    admin('see the backups');
    return backupStatus();
  });
  app.get('/backups/stored', { config: { access: ACCESS.admin, rateLimit: ROUTE_LIMITS.heavy } }, async () => {
    admin('list the backups in the bucket');
    return listStoredBackups();
  });
  app.put('/backups/settings', { config: { access: ACCESS.admin, stepUp: { action: 'changeBackups', who: 'manageSettings' } } }, async (req) => {
    admin('change the backups');
    saveBackupSettings(req.body);
    return backupStatus();
  });
  app.put(
    '/backups/passphrase',
    { config: { access: ACCESS.admin, stepUp: { action: 'changeBackups', who: 'manageSettings' }, rateLimit: ROUTE_LIMITS.heavy } },
    async (req) => {
      admin('set the backup passphrase');
      const b = z.object({ passphrase: z.string().max(1024) }).parse(req.body);
      await setBackupPassphrase(b.passphrase);
      return backupStatus();
    },
  );
  app.post('/backups/run', { config: { access: ACCESS.admin, rateLimit: ROUTE_LIMITS.heavy } }, async (_req, reply) => {
    admin('start a backup');
    return reply.code(202).send(startBackupRun('backup', 'manual'));
  });
  app.post('/backups/restore-test', { config: { access: ACCESS.admin, rateLimit: ROUTE_LIMITS.heavy } }, async (_req, reply) => {
    admin('test the backups');
    return reply.code(202).send(startBackupRun('restore_test', 'manual'));
  });
}
