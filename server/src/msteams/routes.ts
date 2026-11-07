import type { FastifyInstance } from 'fastify';
import type { TeamsBotConversation } from '@sm/shared';
import { db } from '../db.js';
import { ACCESS } from '../auth/access.js';
import { HttpError } from '../util.js';
import { listUsers } from '../auth/users.js';
import { botConfig, botSettingsView, saveBotSettings, teamsBotInput } from './settings.js';
import { appPackage } from './package.js';
import { wireBotDelivery } from './delivery.js';

/**
 * Settings → Notifications → Teams bot (preview, administrators; mounted under /api).
 *   GET  /settings/teams-bot                 the settings (never the credential)
 *   PUT  /settings/teams-bot                 save them (step-up changeNotificationDelivery, audited)
 *   GET  /settings/teams-bot/conversations   where the bot is installed
 *   GET  /settings/teams-bot/package         the Teams app package (zip) to upload to the tenant
 */
export async function teamsBotRoutes(app: FastifyInstance): Promise<void> {
  wireBotDelivery();
  app.get('/settings/teams-bot', { config: { access: ACCESS.admin } }, async () => botSettingsView());
  app.put('/settings/teams-bot', { config: { access: ACCESS.admin, stepUp: { action: 'changeNotificationDelivery', who: 'manageSettings' } } }, async (req) =>
    saveBotSettings(teamsBotInput.parse(req.body ?? {})),
  );
  app.get('/settings/teams-bot/conversations', { config: { access: ACCESS.admin } }, async (): Promise<TeamsBotConversation[]> => {
    const users = new Map(listUsers().map((u) => [u.id, u.username]));
    return db()
      .all<{ id: string; kind: string; name: string; tenant_id: string; user_id: string | null; installed_at: string; removed_at: string | null }>(
        'SELECT id, kind, name, tenant_id, user_id, installed_at, removed_at FROM teams_conversations ORDER BY kind, name, installed_at',
      )
      .map((r) => ({
        id: r.id,
        kind: r.kind === 'personal' ? 'personal' : 'channel',
        name: r.name,
        tenantId: r.tenant_id,
        user: r.user_id ? (users.get(r.user_id) ?? null) : null,
        installedAt: r.installed_at,
        removedAt: r.removed_at,
      }));
  });
  app.get('/settings/teams-bot/package', { config: { access: ACCESS.admin } }, async (_req, reply) => {
    if (!botConfig().appId) throw new HttpError(409, 'Enter the app id of the bot first', 'TEAMS_BOT_APP_ID');
    const zip = await appPackage();
    reply.header('content-disposition', 'attachment; filename="steward-teams-app.zip"');
    return reply.type('application/zip').send(zip);
  });
}
