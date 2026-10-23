import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { currentUser } from '../auth/context.js';
import { HttpError } from '../util.js';
import * as platforms from '../platforms/service.js';
import * as gatus from './metrics.js';

/**
 * Gatus metrics mode (mounted under /api):
 *   GET    /gatus/sources                         configured sources the user may see
 *   GET    /gatus/sources/:platformId             configuration and state (null when not configured)
 *   PUT    /gatus/sources/:platformId             configure (platform managers)
 *   DELETE /gatus/sources/:platformId             remove with all samples (platform managers)
 *   POST   /gatus/sources/:platformId/scrape      scrape now (platform users; at most every 15 s per source)
 *   GET    /gatus/sources/:platformId/endpoints   endpoint states with uptime
 */

const params = (req: FastifyRequest) => req.params as Record<string, string>;

const me = () => {
  const u = currentUser();
  if (!u) throw new HttpError(401, 'Please sign in', 'NOT_SIGNED_IN');
  return u;
};

/** The platform must be a Gatus platform the user has a right on (404 otherwise, so ids cannot be probed). */
function gatusPlatform(id: string, need?: 'use' | 'manage') {
  let p;
  try {
    p = platforms.getPlatform(id);
  } catch {
    throw new HttpError(404, `Platform ${id} not found`, 'PLATFORM_NOT_FOUND', { id });
  }
  if (!p.permissions.length) throw new HttpError(404, `Platform ${id} not found`, 'PLATFORM_NOT_FOUND', { id });
  if (p.kind !== 'gatus') throw new HttpError(400, 'Metrics mode is only available for Gatus platforms', 'GATUS_PLATFORM_REQUIRED', { context: 'metrics' });
  if (need && !p.permissions.includes(need))
    throw new HttpError(403, `You are not allowed to ${need === 'manage' ? 'configure' : 'use'} this platform`, 'FORBIDDEN', {
      context: need === 'manage' ? 'managePlatform' : 'usePlatform',
    });
  return p;
}

const sourceBody = z.object({
  enabled: z.boolean().default(true),
  intervalSeconds: z.number().int().min(15).max(3600).default(60),
  retentionDays: z.number().int().min(1).max(730).default(90),
  rawRetentionDays: z.number().int().min(1).max(90).default(14),
  metricsPath: z.string().max(200).default('/metrics'),
  fetchUptimes: z.boolean().default(false),
});

export async function gatusRoutes(app: FastifyInstance): Promise<void> {
  app.get('/gatus/sources', async () => {
    me();
    return gatus
      .listSources()
      .filter((s) => {
        try {
          return platforms.getPlatform(s.platform_id).permissions.length > 0;
        } catch {
          return false;
        }
      })
      .map(gatus.toSource);
  });

  app.get('/gatus/sources/:platformId', async (req) => {
    const p = gatusPlatform(params(req).platformId!);
    const r = gatus.sourceRow(p.id);
    return { source: r ? gatus.toSource(r) : null };
  });

  app.put('/gatus/sources/:platformId', async (req) => {
    const p = gatusPlatform(params(req).platformId!, 'manage');
    const b = sourceBody.parse(req.body ?? {});
    const before = gatus.sourceRow(p.id);
    if (b.rawRetentionDays > b.retentionDays) throw new HttpError(400, 'Raw samples cannot be kept longer than the hourly data', 'GATUS_RETENTION');
    const after = gatus.saveSource(p.id, b, me().username);
    audit({
      action: before ? 'gatus.metrics_updated' : 'gatus.metrics_enabled',
      entityType: 'platform',
      entityId: p.id,
      summary: `Gatus metrics mode ${before ? 'changed' : 'configured'} for "${p.name}" (${b.enabled ? `every ${b.intervalSeconds} s` : 'disabled'}, ${b.metricsPath}, kept ${b.retentionDays} days)`,
      details: { ...b, owner: after.owner },
    });
    return { source: gatus.toSource(after) };
  });

  app.delete('/gatus/sources/:platformId', async (req) => {
    const p = gatusPlatform(params(req).platformId!, 'manage');
    if (!gatus.sourceRow(p.id)) throw new HttpError(404, 'Metrics mode is not configured for this platform', 'GATUS_METRICS_OFF');
    gatus.deleteSource(p.id);
    audit({ action: 'gatus.metrics_removed', entityType: 'platform', entityId: p.id, summary: `Gatus metrics mode removed for "${p.name}" (samples deleted)` });
    return { ok: true };
  });

  app.post('/gatus/sources/:platformId/scrape', async (req) => {
    const p = gatusPlatform(params(req).platformId!, 'use');
    return gatus.manualScrape(p.id);
  });

  app.get('/gatus/sources/:platformId/endpoints', async (req) => {
    const p = gatusPlatform(params(req).platformId!);
    return gatus.endpointStates(p.id);
  });
}
