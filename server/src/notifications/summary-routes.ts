import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser } from '../auth/context.js';
import { getUser } from '../auth/users.js';
import { isAdmin } from '../auth/permissions.js';
import { HttpError } from '../util.js';
import * as summary from './summary.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { me } from '../auth/access.js';

/**
 * Daily summary (mounted under /api).
 *   GET /me/daily-summary          the signed-in user's settings, whether summaries are allowed and e-mail can reach them
 *   PUT /me/daily-summary          save them
 *   GET /me/daily-summary/preview  what the summary would contain now (nothing is sent)
 *   GET /settings/daily-summary    administrators: the switch and who subscribed (no content)
 *   PUT /settings/daily-summary    administrators: allow or stop daily summaries for everyone
 */
/** The signed-in user's full record (with their daily summary settings). */
const meFull = () => getUser(me().id);

export async function dailySummaryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/me/daily-summary', async () => summary.summaryState(meFull()));
  app.put('/me/daily-summary', async (req) => summary.savePrefs(meFull(), summary.prefsSchema.parse(req.body ?? {})));
  app.get('/me/daily-summary/preview', { config: { rateLimit: ROUTE_LIMITS.heavy } }, async () => summary.previewSummary(meFull()));

  app.get('/settings/daily-summary', async () => {
    if (!isAdmin(currentUser())) throw new HttpError(403, 'Only administrators can see the daily summary subscriptions', 'DAILY_SUMMARY_ADMIN_ONLY');
    return summary.adminView();
  });
  app.put('/settings/daily-summary', async (req) => {
    if (!isAdmin(currentUser())) throw new HttpError(403, 'Only administrators can change the daily summary setting', 'DAILY_SUMMARY_ADMIN_ONLY');
    const b = z
      .object({ allowed: z.boolean() })
      .strict()
      .parse(req.body ?? {});
    return summary.setSummariesAllowed(b.allowed);
  });
}
