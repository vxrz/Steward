import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { databaseSettingsSchema } from '@sm/shared';
import { requirePlatform } from '../routes/helpers.js';
import { setDatabaseSettings } from './service.js';

/**
 * Database platforms (0.7.0, docs/DATABASES.md): the connection (dialect, host, port, database, TLS, limits) is changed
 * with the platform's "manage" right and read with the platform. Statements run in processes, monitor checks and the
 * MCP gateway – there is no route that runs one. Not in the public API (/api/v1): it serves platforms without their
 * configuration.
 */
const idParam = (req: FastifyRequest) => z.object({ id: z.string().min(1).max(64) }).parse(req.params).id;

export async function databaseRoutes(app: FastifyInstance): Promise<void> {
  app.put('/platforms/:id/database', async (req) => {
    const id = idParam(req);
    requirePlatform(id, 'manage', 'change the database connection of this platform');
    return setDatabaseSettings(id, databaseSettingsSchema.parse(req.body));
  });
}
