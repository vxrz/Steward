import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { databaseSettingsSchema } from '@sm/shared';
import { requirePlatform } from '../routes/helpers.js';
import { platformAccess } from '../auth/step-up-rules.js';
import { db } from '../db.js';
import { afterDatabaseUpdate, credentialChoice, destinationRules, planDestinationChange, recordDestinationChange } from '../platforms/destinationChange.js';
import { setDatabaseSettings } from './service.js';
import { getPlatform } from '../platforms/service.js';

/**
 * Database platforms (0.7.0, docs/DATABASES.md): the connection (dialect, host, port, database, TLS, limits) is changed
 * with the platform's "manage" right and read with the platform. Statements run in processes, monitor checks and the
 * MCP gateway – there is no route that runs one. Not in the public API (/api/v1): it serves platforms without their
 * configuration.
 */
const idParam = (req: FastifyRequest) => z.object({ id: z.string().min(1).max(64) }).parse(req.params).id;

export async function databaseRoutes(app: FastifyInstance): Promise<void> {
  // a new host or port receives the stored credentials (security review 0.19.0 H1): as a new address of any platform
  app.put(
    '/platforms/:id/database',
    { config: { stepUp: { action: 'changePlatformDestination', who: platformAccess.who, when: (req) => destinationRules.database(idParam(req), req.body) } } },
    async (req) => {
      const id = idParam(req);
      requirePlatform(id, 'manage', 'change the database connection of this platform');
      const raw = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
      const credentials = credentialChoice.parse(raw.credentials);
      const settings = databaseSettingsSchema.parse(Object.fromEntries(Object.entries(raw).filter(([k]) => k !== 'credentials')));
      const change = planDestinationChange(id, afterDatabaseUpdate(id, settings), credentials);
      return db().tx(() => {
        setDatabaseSettings(id, settings);
        recordDestinationChange(id, change);
        return getPlatform(id);
      });
    },
  );
}
