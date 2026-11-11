import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notificationPrefsSchema } from '@sm/shared';
import { currentUser } from '../auth/context.js';
import { getUser } from '../auth/users.js';
import { isAdmin } from '../auth/permissions.js';
import { HttpError } from '../util.js';
import { me } from '../auth/access.js';
import { prefsState, quietAdminView, resetNotificationPrefs, saveNotificationPrefs, setQuietHoursAllowed } from './prefs.js';
import { optInsOf, saveOptIns } from './opt-ins.js';

/**
 * Quiet hours and digests (mounted under /api, ADR 0012).
 *   GET /me/notification-prefs        the signed-in user's settings, where they come from, and the quiet hours now
 *   PUT /me/notification-prefs        save them (no step-up: they only delay one's own messages)
 *   DELETE /me/notification-prefs     back to the default (a team's or off)
 *   GET|PUT /me/notification-opt-ins  the notifications that are off by default and that the user turned on (ADR 0030)
 *   GET /settings/quiet-hours         administrators: the switch, who uses them and how many messages wait (no content)
 *   PUT /settings/quiet-hours         administrators: allow or switch off quiet hours and digests for everyone
 */
const meFull = () => getUser(me().id);

function requireAdmin(): void {
  if (!isAdmin(currentUser())) throw new HttpError(403, 'Only administrators see and change quiet hours for everyone', 'QUIET_HOURS_ADMIN_ONLY');
}

export async function notificationPrefsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/me/notification-prefs', async () => prefsState(meFull()));
  app.put('/me/notification-prefs', async (req) => saveNotificationPrefs(meFull(), notificationPrefsSchema.parse(req.body ?? {})));
  app.delete('/me/notification-prefs', async () => resetNotificationPrefs(meFull()));
  app.get('/me/notification-opt-ins', async () => optInsOf(me().id));
  app.put('/me/notification-opt-ins', async (req) => saveOptIns(meFull(), req.body));
  app.get('/settings/quiet-hours', async () => {
    requireAdmin();
    return quietAdminView();
  });
  app.put('/settings/quiet-hours', async (req) => {
    requireAdmin();
    const b = z
      .object({ allowed: z.boolean() })
      .strict()
      .parse(req.body ?? {});
    return setQuietHoursAllowed(b.allowed);
  });
}
