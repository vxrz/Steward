import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser } from '../auth/context.js';
import { requireCapability } from '../auth/permissions.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { backupContents, backupStatus, confirmBackupTarget, listStoredBackups, saveBackupSettings, setBackupPassphrase, startBackupRun } from './service.js';
import { ACCESS } from '../auth/access.js';

/**
 * Backups to S3 (#117): administrators only (manageSettings); changes need a fresh confirmation (step-up). A run whose
 * S3 target is not the one an administrator confirmed fails (BACKUP_TARGET_CHANGED) until it is confirmed again.
 */
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
  // the parts of a backup and their size now (walks the data folder: heavy)
  app.get('/backups/contents', { config: { access: ACCESS.admin, rateLimit: ROUTE_LIMITS.heavy } }, async () => {
    admin('see what the backups hold');
    return backupContents();
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
  // the platform of the backups changed (whoever manages it may change it without the step-up of the backup settings):
  // an administrator checks it and confirms the target again (0.17.1, BACKUP_TARGET_CHANGED)
  app.post('/backups/confirm-target', { config: { access: ACCESS.admin, stepUp: { action: 'changeBackups', who: 'manageSettings' } } }, async () => {
    admin('confirm the target of the backups');
    return confirmBackupTarget();
  });
  app.post('/backups/run', { config: { access: ACCESS.admin, rateLimit: ROUTE_LIMITS.heavy } }, async (_req, reply) => {
    admin('start a backup');
    return reply.code(202).send(startBackupRun('backup', 'manual'));
  });
  app.post('/backups/restore-test', { config: { access: ACCESS.admin, rateLimit: ROUTE_LIMITS.heavy } }, async (_req, reply) => {
    admin('test the backups');
    return reply.code(202).send(startBackupRun('restore_test', 'manual'));
  });
}
