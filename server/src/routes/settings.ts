import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { LOCALE_CODES, API_DOCS_MODES, PASSWORD_LOGIN_MODES, OUTBOUND_POLICIES, allowListEntryProblem } from '@sm/shared';
import { config } from '../config.js';
import { audit } from '../audit.js';
import { getSettings, passwordLoginFromEnv, passwordLoginMode, updateSettings } from '../settings.js';
import { HttpError } from '../util.js';
import * as users from '../auth/users.js';
import * as sso from '../auth/sso.js';
import { changesSignInOrOutbound } from '../auth/step-up-rules.js';
import { requireCapability } from '../auth/permissions.js';
import { readCookie, SESSION_COOKIE } from '../auth/cookies.js';
import { ACCESS, me } from '../auth/access.js';

/** Instance settings (mounted under /api). */
export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // ---------- settings ----------
  // Instance settings (#136): /settings/instance; /settings is the old name, kept for one minor version (Deprecation
  // header). Team settings live under /teams/:id/settings, personal ones under /me.
  const deprecated = (reply: FastifyReply) =>
    reply.header('Deprecation', 'true').header('Link', `<${config.basePath}/api/settings/instance>; rel="successor-version"`);
  const getInstanceSettings = async () => {
    requireCapability(me(), 'manageSettings', 'view settings');
    return getSettings();
  };
  app.get('/settings/instance', { config: { access: ACCESS.admin } }, getInstanceSettings);
  app.get('/settings', { config: { access: ACCESS.admin } }, async (_req, reply) => {
    deprecated(reply);
    return getInstanceSettings();
  });
  const putInstanceSettings = async (req: FastifyRequest) => {
    requireCapability(me(), 'manageSettings', 'change settings');
    const b = z
      .object({
        passwordLogin: z.enum(PASSWORD_LOGIN_MODES).optional(),
        browserHeadless: z.boolean().optional(),
        browserTimeoutMs: z.number().int().min(1000).optional(),
        retentionRunDays: z.number().int().min(0).max(3650).optional(),
        retentionNotificationDays: z.number().int().min(1).max(3650).optional(),
        defaultLocale: z.enum(LOCALE_CODES).optional(),
        retentionMonitorDays: z.number().int().min(1).max(3650).optional(),
        apiDocs: z.enum(API_DOCS_MODES).optional(),
        outboundPolicy: z.enum(OUTBOUND_POLICIES).optional(),
        outboundAllowList: z
          .array(
            z
              .string()
              .trim()
              .min(1)
              .max(255)
              .refine((e) => !allowListEntryProblem(e), {
                message: 'Use an origin (https://host[:port]), a host or *.host (optional :port), or an IPv4 CIDR',
              }),
          )
          .max(200)
          .optional(),
        findingDismissFourEyes: z.boolean().optional(),
      })
      .parse(req.body);
    const before = passwordLoginMode();
    const envLogin = passwordLoginFromEnv();
    if (b.passwordLogin !== undefined && envLogin) {
      // SM_PASSWORD_LOGIN decides; the stored value is not touched (the UI shows the field read-only)
      if (b.passwordLogin !== envLogin && b.passwordLogin !== before)
        throw new HttpError(409, `Password sign-in is set by SM_PASSWORD_LOGIN=${envLogin} on the server`, 'PASSWORD_LOGIN_FROM_ENV', { value: envLogin });
      delete b.passwordLogin;
    }
    if (b.passwordLogin === 'adminsOnly' && !sso.publicProviders().length)
      throw new HttpError(400, 'Enable a single sign-on provider before turning off password sign-in', 'SSO_PROVIDER_REQUIRED');
    if (b.passwordLogin === 'none' && before !== 'none') requireSsoOnlyPossible();
    const s = updateSettings(b);
    const ended =
      b.passwordLogin && b.passwordLogin !== before ? users.endPasswordSessions(b.passwordLogin, readCookie(req.headers.cookie, SESSION_COOKIE)) : 0;
    audit({
      action: 'settings.updated',
      entityType: 'settings',
      summary:
        b.passwordLogin && b.passwordLogin !== before
          ? `Settings updated: password sign-in ${before} → ${b.passwordLogin}${ended ? ` (${ended} password session(s) signed out)` : ''}`
          : 'Settings updated',
      details: { scope: 'instance', ...b, ...(ended ? { sessionsEnded: ended } : {}) },
    });
    return s;
  };
  const putSettingsConfig = {
    config: { access: ACCESS.adminSession, stepUp: { action: 'changeSignInSettings' as const, who: 'manageSettings' as const, when: changesSignInOrOutbound } },
  };
  app.put('/settings/instance', putSettingsConfig, putInstanceSettings);
  app.put('/settings', putSettingsConfig, async (req, reply) => {
    deprecated(reply);
    return putInstanceSettings(req);
  });

  /**
   * Single sign-on only is allowed once it cannot lock everyone out: an enabled provider exists and the administrator
   * turning it on signed in through it (so at least one administrator demonstrably gets in that way).
   */
  function requireSsoOnlyPossible(): void {
    const providers = sso.publicProviders();
    if (!providers.length) throw new HttpError(400, 'Enable a single sign-on provider before turning off password sign-in', 'SSO_PROVIDER_REQUIRED');
    const u = me();
    const account = users.getUser(u.id);
    if (u.emergency || !providers.some((p) => p.id === account.authSource))
      throw new HttpError(
        409,
        'Sign in with single sign-on as an administrator first – then you know that at least one administrator can still get in',
        'SSO_ADMIN_REQUIRED',
      );
  }
}
