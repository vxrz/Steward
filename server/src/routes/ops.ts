import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  API_TOKEN_SCOPES,
  LOCALE_CODES,
  NOTIFICATION_CORNERS,
  NOTIFICATION_DRY_RUN_DELIVERY,
  NOTIFICATION_EVENTS,
  NOTIFICATION_FONTS,
  NOTIFICATION_HEADER_STYLES,
  NOTIFICATION_LOGO_ALIGNS,
  NOTIFICATION_LOGO_MAX_BYTES,
  NOTIFICATION_LOGO_SIZES,
  NOTIFICATION_LOGO_SOURCES,
  NOTIFICATION_LOOK_FOOTER_MAX,
  NOTIFICATION_LOOK_NAME_MAX,
  type NotificationSettingsInput,
} from '@sm/shared';
import { HttpError, sha256 } from '../util.js';
import { currentUser, type AuthUser } from '../auth/context.js';
import { requireCapability } from '../auth/permissions.js';
import { getUser, updateProfile } from '../auth/users.js';
import { createToken, listTokens, revokeToken } from '../auth/tokens.js';
import { changesNotificationDelivery } from '../auth/step-up-rules.js';
import { listInApp, markAllRead, markRead } from '../notifications/store.js';
import { getNotificationSettings, saveNotificationSettings } from '../notifications/settings.js';
import { initNotifications, previewLook, sendTest } from '../notifications/service.js';
import { customLogo, getLook, removeCustomLogo, setCustomLogo, updateLook } from '../notifications/look.js';
import { audit } from '../audit.js';
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

const lookBody = z
  .object({
    name: z
      .string()
      .max(NOTIFICATION_LOOK_NAME_MAX * 2)
      .optional(),
    color: z.string().max(16).optional(),
    logoSource: z.enum(NOTIFICATION_LOGO_SOURCES).optional(),
    footer: z
      .string()
      .max(NOTIFICATION_LOOK_FOOTER_MAX * 2)
      .optional(),
    logoSize: z.enum(NOTIFICATION_LOGO_SIZES).optional(),
    logoAlign: z.enum(NOTIFICATION_LOGO_ALIGNS).optional(),
    headerStyle: z.enum(NOTIFICATION_HEADER_STYLES).optional(),
    buttonColor: z.string().max(16).optional(),
    corners: z.enum(NOTIFICATION_CORNERS).optional(),
    font: z.enum(NOTIFICATION_FONTS).optional(),
    dryRunDelivery: z.enum(NOTIFICATION_DRY_RUN_DELIVERY).optional(),
  })
  .strict();
const previewBody = lookBody.extend({ sample: z.enum(['test', 'dryRun']).optional() }).strict();

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
  webhook: z.object({ enabled: z.boolean(), url: z.string().max(2000).optional(), format: z.enum(['json', 'teams']).optional() }),
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

  // look of e-mails and Teams messages (name, colour, logo, footer; empty = Settings → Appearance)
  app.get('/settings/notifications/look', async () => {
    admin('view the look of notifications');
    return getLook();
  });
  app.put('/settings/notifications/look', async (req) => {
    const u = admin('change the look of notifications');
    const { look, changed } = updateLook(lookBody.parse(req.body ?? {}), u.username);
    if (Object.keys(changed).length)
      audit({
        action: 'notifications.look_updated',
        entityType: 'settings',
        entityId: 'notifications.look',
        summary: `Look of e-mails and Teams messages changed (${Object.keys(changed).join(', ')})`,
        details: changed,
      });
    return look;
  });
  app.post('/settings/notifications/look/preview', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    admin('view the look of notifications');
    const { sample, ...draft } = previewBody.parse(req.body ?? {});
    return previewLook(draft, sample);
  });
  // an own logo for e-mails and Teams messages (logo source "custom"): PNG or JPEG, at most 512 KB
  app.get('/settings/notifications/look/logo', async (_req, reply) => {
    admin('view the look of notifications');
    const c = customLogo();
    if (!c) throw new HttpError(404, 'No notification logo is uploaded');
    reply.header('cache-control', 'no-store');
    return reply.type(c.mime).send(c.data);
  });
  app.post('/settings/notifications/look/logo', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    admin('change the look of notifications');
    const tooLarge = () =>
      new HttpError(400, `The logo is too large (max. ${NOTIFICATION_LOGO_MAX_BYTES / 1024} KB)`, 'NOTIFICATION_LOGO_TOO_LARGE', {
        maxKb: NOTIFICATION_LOGO_MAX_BYTES / 1024,
      });
    let data: Buffer;
    if (req.isMultipart()) {
      const file = await req.file({ limits: { fileSize: NOTIFICATION_LOGO_MAX_BYTES + 1, files: 1 } });
      if (!file) throw new HttpError(400, 'No file', 'NO_FILE');
      try {
        data = await file.toBuffer();
      } catch {
        throw tooLarge();
      }
    } else {
      const b = z
        .object({ contentBase64: z.string().max(Math.ceil((NOTIFICATION_LOGO_MAX_BYTES * 4) / 3) + 16) })
        .strict()
        .safeParse(req.body ?? {});
      if (!b.success) throw tooLarge();
      data = Buffer.from(b.data.contentBase64, 'base64');
    }
    const saved = setCustomLogo(data);
    audit({
      action: 'notifications.logo_uploaded',
      entityType: 'settings',
      entityId: 'notifications.look',
      summary: `Notification logo uploaded (${saved.mime}, ${saved.size} bytes)`,
      details: { sha256: sha256(data), size: saved.size, mime: saved.mime },
    });
    return getLook();
  });
  app.delete('/settings/notifications/look/logo', async () => {
    admin('change the look of notifications');
    if (removeCustomLogo())
      audit({ action: 'notifications.logo_removed', entityType: 'settings', entityId: 'notifications.look', summary: 'Notification logo removed' });
    return getLook();
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
