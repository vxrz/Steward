import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { API_TOKEN_SCOPES, LOCALE_CODES, NOTIFICATION_EVENTS, type NotificationSettingsInput } from '@sm/shared';
import { HttpError } from '../util.js';
import { currentUser, type AuthUser } from '../auth/context.js';
import { requireCapability } from '../auth/permissions.js';
import { getUser, updateProfile } from '../auth/users.js';
import { createToken, listTokens, revokeToken } from '../auth/tokens.js';
import { changesNotificationDelivery } from '../auth/step-up-rules.js';
import { listInApp, markAllRead, markRead } from '../notifications/store.js';
import { getNotificationSettings, saveNotificationSettings } from '../notifications/settings.js';
import { initNotifications, sendTest } from '../notifications/service.js';
import { maintenanceStatus, runCleanup } from '../maintenance.js';
import { publicApiStatus } from '../api/v1/config.js';
import { ROUTE_LIMITS } from '../rateLimits.js';

const me = (): AuthUser => {
  const u = currentUser();
  if (!u) throw new HttpError(401, 'Please sign in', 'NOT_SIGNED_IN');
  return u;
};
const admin = (what: string): AuthUser => {
  const u = me();
  requireCapability(u, 'manageSettings', what);
  return u;
};
const params = (req: FastifyRequest) => req.params as Record<string, string>;
const viaToken = (req: FastifyRequest) => !!(req as unknown as { smToken?: string }).smToken;

const channelList = z.array(z.enum(['inApp', 'email', 'teams', 'webhook'])).max(4);
const notificationSettingsBody = z.object({
  email: z.object({
    enabled: z.boolean(),
    host: z.string().max(255).default(''),
    port: z.number().int().min(1).max(65535).default(587),
    secure: z.boolean().default(false),
    user: z.string().max(255).optional(),
    from: z.string().max(255).default(''),
    password: z.string().max(1000).optional(),
  }),
  teams: z.object({ enabled: z.boolean(), webhookUrl: z.string().max(2000).optional() }),
  webhook: z.object({ enabled: z.boolean(), url: z.string().max(2000).optional() }),
  routes: z
    .object(Object.fromEntries(NOTIFICATION_EVENTS.map((e) => [e, channelList.optional()])))
    .partial()
    .default({}),
  baseUrl: z.string().max(500).optional(),
  /** Omitted: keep the stored list */
  allowedEmailDomains: z.array(z.string().max(255)).max(100).optional(),
});

/** Notifications, API tokens, maintenance (mounted under /api). */
export async function opsRoutes(app: FastifyInstance): Promise<void> {
  initNotifications();

  // ---------- in-app notifications ----------
  app.get('/notifications', async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) }).parse(req.query ?? {});
    return listInApp(me().id, limit);
  });
  app.post('/notifications/read-all', async () => {
    markAllRead(me().id);
    return { ok: true };
  });
  app.post('/notifications/:id/read', async (req) => {
    markRead(me().id, params(req).id!);
    return { ok: true };
  });

  // ---------- own profile ----------
  app.patch('/me', async (req) => {
    const b = z
      .object({
        displayName: z.string().max(100).optional(),
        firstName: z.string().max(100).optional(),
        lastName: z.string().max(100).optional(),
        email: z.string().max(254).optional(),
        emailNotifications: z.boolean().optional(),
        /** null = back to the default (browser language / Settings.defaultLocale) */
        locale: z.enum(LOCALE_CODES).nullable().optional(),
      })
      .parse(req.body ?? {});
    return updateProfile(me().id, b);
  });

  // ---------- API tokens ----------
  app.get('/me/tokens', async () => listTokens(me().id));
  // a token outlives the session: creating one needs a recent confirmation (auth/step-up.ts)
  app.post('/me/tokens', { config: { stepUp: { action: 'createToken' } } }, async (req) => {
    if (viaToken(req)) throw new HttpError(403, 'API tokens cannot create other tokens – sign in to the web UI');
    // emergency access is for repairing sign-in, not for lasting access that outlives its session
    if (me().emergency) throw new HttpError(403, 'API tokens cannot be created in an emergency access session', 'EMERGENCY_NO_TOKENS');
    const b = z
      .object({ name: z.string().min(1).max(100), scope: z.enum(API_TOKEN_SCOPES), expiresInDays: z.number().int().min(1).max(3650).optional() })
      .parse(req.body);
    const u = getUser(me().id);
    return createToken(u.id, b);
  });
  app.delete('/me/tokens/:id', async (req) => {
    revokeToken(params(req).id!, me().id);
    return { ok: true };
  });
  app.get('/tokens', async () => {
    requireCapability(me(), 'manageUsers', 'manage API tokens of other users');
    return listTokens();
  });
  app.delete('/tokens/:id', async (req) => {
    requireCapability(me(), 'manageUsers', 'manage API tokens of other users');
    revokeToken(params(req).id!);
    return { ok: true };
  });

  // ---------- public REST API (/api/v1): effective configuration for the web UI ----------
  app.get('/public-api', async () => {
    me();
    return publicApiStatus();
  });

  // ---------- notification settings ----------
  app.get('/settings/notifications', async () => {
    admin('change notification settings');
    return getNotificationSettings();
  });
  app.put(
    '/settings/notifications',
    { config: { stepUp: { action: 'changeNotificationDelivery', who: 'manageSettings', when: changesNotificationDelivery } } },
    async (req) => {
      admin('change notification settings');
      return saveNotificationSettings(notificationSettingsBody.parse(req.body) as NotificationSettingsInput);
    },
  );
  app.post('/settings/notifications/test', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    const u = admin('test notification channels');
    const b = z.object({ channel: z.enum(['email', 'teams', 'webhook']), to: z.string().max(254).optional() }).parse(req.body);
    return sendTest(b.channel, b.to?.trim() || getUser(u.id).email);
  });

  // ---------- maintenance ----------
  app.get('/maintenance', async () => {
    admin('view maintenance information');
    return maintenanceStatus();
  });
  app.post('/maintenance/cleanup', { config: { rateLimit: ROUTE_LIMITS.heavy } }, async () => {
    admin('run the cleanup');
    try {
      runCleanup({ manual: true });
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
    return maintenanceStatus();
  });
}
