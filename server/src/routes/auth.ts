import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { STEP_UP_ACTIONS, type AuthStatus, type Me, BRAND } from '@sm/shared';
import { config } from '../config.js';
import { vault, publicKeyPem } from '../vault.js';
import { audit, flushPendingAudit } from '../audit.js';
import { changeMasterPassphrase } from '../vault-rotation.js';
import { unlockThrottle } from '../auth/unlock-throttle.js';
import { sealPlatformConfigs } from '../platforms/integrity.js';
import { getSettings, passwordLoginMode } from '../settings.js';
import { resolveLocale, t as serverT } from '../i18n/index.js';
import { HttpError } from '../util.js';
import { recoverRuns } from '../engine/runner.js';
import { browserAvailable } from '../engine/browser.js';
import * as scheduler from '../scheduler.js';
import { startAccessChecks } from '../compliance/reconciliation.js';
import { startMonitorEngine, stopMonitorEngine } from '../monitors/engine.js';
import { startGatusScraper } from '../gatus/metrics.js';
import { startReportSchedules } from '../reports/schedules.js';
import { startGitSync } from '../sync/engine.js';
import { seedExamplesSource } from '../sync/service.js';
import { currentUser, runAs } from '../auth/context.js';
import * as users from '../auth/users.js';
import * as sso from '../auth/sso.js';
import * as emergency from '../auth/emergency.js';
import * as stepUp from '../auth/step-up.js';
import { currentInstanceId } from '../instance.js';
import { capabilities, isAdmin, requireCapability } from '../auth/permissions.js';
import { LINK_KEY_STORAGE, readCookie, sessionCookie, sendSessionKeys, SESSION_COOKIE, SESSION_KEY_STORAGE } from '../auth/cookies.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { auditPendingUpgrades } from '../upgrades.js';
import { ACCESS, me } from '../auth/access.js';

let started = false;
/** Things that need the decrypted vault: pending audit entries, scheduler, recovery of waiting runs. */
async function onUnlocked(): Promise<void> {
  flushPendingAudit();
  auditPendingUpgrades();
  if (vault().migratedFromV1) {
    vault().migratedFromV1 = false;
    audit({
      actor: 'system',
      action: 'vault.upgraded',
      entityType: 'vault',
      summary: 'Vault converted to format 2 (wrapped keys, scrypt N=2^17); the audit key is unchanged',
    });
  }
  // configuration integrity: seal platforms that have no seal yet (installations from before it existed)
  sealPlatformConfigs();
  sso.sealProviderConfigs();
  // Steward's example library as a disabled Git sync source, once per installation
  seedExamplesSource();
  if (started) return;
  started = true;
  await recoverRuns();
  scheduler.startScheduler();
  startMonitorEngine();
  startGatusScraper();
  startReportSchedules();
  startGitSync();
  startAccessChecks();
}

export async function unlockFromEnv(): Promise<void> {
  if (config.masterPassphrase && vault().initialized && !vault().unlocked) {
    try {
      await vault().unlock(config.masterPassphrase);
    } catch (e) {
      if ((e as HttpError).code === 'WRONG_PASSPHRASE') {
        audit({
          actor: 'system',
          action: 'vault.unlock_failed',
          entityType: 'vault',
          summary: 'Automatic unlock at startup failed: wrong master passphrase (SM_MASTER_PASSPHRASE[_FILE])',
        });
      }
      throw e;
    }
    audit({ actor: 'system', action: 'vault.unlocked', entityType: 'vault', summary: 'Vault unlocked with the configured master passphrase at startup' });
    await onUnlocked();
  }
}

function meInfo(): Me | null {
  const u = currentUser();
  if (!u) return null;
  const user = users.getUser(u.id);
  if (u.emergency) user.mustChangePassword = false;
  return { user, capabilities: capabilities(u), ...(u.emergency ? { emergency: { expiresAt: u.emergency.expiresAt } } : {}) };
}

const params = (req: FastifyRequest) => req.params as Record<string, string>;

/** Health, sign-in, vault, single sign-on and step-up re-authentication (mounted under /api). */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  // ---------- health, auth & vault ----------
  app.get('/health', { config: { access: ACCESS.public } }, async () => ({ ok: true, version: config.version }));

  const status = async (): Promise<AuthStatus> => ({
    initialized: vault().initialized,
    setupRequired: users.countUsers() === 0,
    unlocked: vault().unlocked,
    me: meInfo(),
    ssoProviders: sso.publicProviders(),
    passwordLogin: passwordLoginMode(),
    demo: config.demo,
    version: config.version,
    browserAvailable: await browserAvailable(),
  });
  app.get('/auth/status', { config: { access: ACCESS.public } }, status);
  app.get('/vault/status', { config: { access: ACCESS.public } }, async () => {
    const s = await status();
    return { ...s, operator: s.me?.user.displayName };
  });

  app.post('/auth/setup', { config: { access: ACCESS.public, rateLimit: ROUTE_LIMITS.credential } }, async (req, reply) => {
    const b = z
      .object({
        passphrase: z.string().min(1).max(1024),
        username: z.string().min(2).max(64),
        displayName: z.string().max(100).optional(),
        password: z.string().max(1024),
      })
      .parse(req.body);
    if (users.countUsers() > 0) throw new HttpError(409, 'Setup has already been completed');
    if (vault().initialized) await vault().unlock(b.passphrase);
    else await vault().setup(b.passphrase);
    const { user } = users.createUser({ username: b.username, displayName: b.displayName, roles: ['admin'], password: b.password });
    runAs(users.toAuthUser(user), () =>
      audit({ action: 'vault.initialized', entityType: 'vault', summary: `${BRAND.name} set up by ${user.username} (first administrator)` }),
    );
    // the first administrator's session (SM_PASSWORD_LOGIN=none waits for an administrator's single sign-on, see ssoOnlyReady)
    const session = users.createSession(user.id, user.username, { ip: req.ip, userAgent: req.headers['user-agent'] }, 'password');
    reply.header('set-cookie', sessionCookie(session.token));
    sendSessionKeys(reply, session);
    await onUnlocked();
    return { ok: true };
  });

  // Small body limit: reachable without signing in (and every failure is audited, see login-audit.ts).
  app.post('/auth/login', { config: { access: ACCESS.public }, bodyLimit: 16 * 1024 }, async (req, reply) => {
    const b = z.object({ username: z.string().max(256), password: z.string().max(1024) }).parse(req.body);
    const { user, ...session } = await users.login(b.username.trim(), b.password, { ip: req.ip, userAgent: req.headers['user-agent'] });
    reply.header('set-cookie', sessionCookie(session.token));
    sendSessionKeys(reply, session);
    return { user, capabilities: capabilities(users.toAuthUser(user)) } satisfies Me;
  });

  // Emergency access (break-glass, see auth/emergency.ts): the one-time code from `steward admin emergency-access`.
  app.post('/auth/emergency', { bodyLimit: 4 * 1024, config: { access: ACCESS.public, rateLimit: ROUTE_LIMITS.credential } }, async (req, reply) => {
    const b = z.object({ code: z.string().max(200) }).parse(req.body);
    const { user, ...session } = emergency.signInWithCode(b.code.trim(), { ip: req.ip, userAgent: req.headers['user-agent'] });
    reply.header('set-cookie', sessionCookie(session.token));
    sendSessionKeys(reply, session);
    return { user: { ...user, mustChangePassword: false }, capabilities: capabilities(users.toAuthUser(user)) } satisfies Me;
  });
  // The same command while Steward runs: a grant signed with the vault's key, from this machine only.
  app.post('/auth/emergency/grant', { bodyLimit: 8 * 1024, config: { access: ACCESS.public, rateLimit: ROUTE_LIMITS.credential } }, async (req) => {
    const b = z
      .object({
        grant: z.object({
          v: z.literal(1),
          purpose: z.literal('steward-emergency-access-v1'),
          instanceId: z.string().max(100),
          username: z.string().max(256),
          minutes: z.number().int(),
          codeHash: z.string().max(64),
          actor: z.string().max(200),
          issuedAt: z.string().max(40),
          nonce: z.string().max(64),
        }),
        signature: z.string().max(200),
      })
      .parse(req.body);
    const forwarded = !!(req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers.forwarded || req.headers['x-real-ip']);
    const g = emergency.acceptSignedGrant(b, { remote: req.socket.remoteAddress, forwarded, instanceId: currentInstanceId() });
    return { ok: true, username: g.username, expiresAt: g.expiresAt, minutes: g.minutes };
  });

  app.post('/auth/logout', async (req, reply) => {
    const u = currentUser();
    users.logout(readCookie(req.headers.cookie, SESSION_COOKIE));
    if (u) audit({ action: 'auth.logout', entityType: 'user', entityId: u.id, summary: `${u.username} signed out` });
    reply.header('set-cookie', sessionCookie(null));
    return { ok: true };
  });

  app.get('/auth/me', async () => meInfo());

  // ---------- single sign-on (OpenID Connect) ----------
  const ssoFail = (reply: import('fastify').FastifyReply, message: string) => reply.redirect(`/?sso_error=${encodeURIComponent(message.slice(0, 300))}`);

  app.get('/auth/oidc/:id/start', async (req, reply) => {
    try {
      const url = await sso.startSignIn(params(req).id!, sso.redirectUriFor(req), (req.query as { returnTo?: string }).returnTo);
      return reply.redirect(url);
    } catch (e) {
      return ssoFail(reply, (e as Error).message);
    }
  });

  app.get('/auth/oidc/callback', async (req, reply) => {
    try {
      const current = new URL(req.url, `${req.protocol}://${req.headers.host}`);
      const result = await sso.finishSignIn(current, { ip: req.ip, userAgent: req.headers['user-agent'] });
      reply.header('cache-control', 'no-store');
      if (result.kind === 'test') {
        // a test sign-in: no cookie, no session – the administrator's editor shows the claims (it asks for them)
        const lang = resolveLocale(result.locale, getSettings().defaultLocale);
        const text = result.ok ? serverT(lang, 'ssoTest.done') : serverT(lang, 'ssoTest.failed');
        const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
        return reply.type('text/html').send(
          // nosemgrep: javascript.express.security.injection.raw-html-format.raw-html-format, javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag -- lang is one of the supported locales (resolveLocale), the texts are fixed catalog texts, HTML-escaped; no request data
          `<!doctype html><html lang="${esc(lang)}"><meta charset="utf-8"><title>${esc(serverT(lang, 'ssoTest.title'))}</title><p>${esc(text)}</p><script>setTimeout(function(){window.close()},1500)</script></html>`,
        );
      }
      if (result.kind === 'stepUp') return reply.type('text/html').send(stepUpPage(result));
      const { token, returnTo, sessionKey, linkKey } = result;
      reply.header('set-cookie', sessionCookie(token));
      // A same-site page hop (instead of a 302) so the SameSite=Strict session cookie is used right away.
      // It also hands the session key to the web app: localStorage of this origin (see auth/cookies.ts).
      const js = (v: string) => JSON.stringify(v).replace(/</g, '\\u003c');
      return reply.type('text/html').send(
        // nosemgrep: javascript.express.security.injection.raw-html-format.raw-html-format -- values are JSON string literals with "<" escaped (js()), safe inside <script>; returnTo is a validated same-origin path below the base path
        `<!doctype html><meta charset="utf-8"><title>Signing in…</title><p>Signing in…</p><script>try{localStorage.setItem(${js(SESSION_KEY_STORAGE)},${js(sessionKey)});localStorage.setItem(${js(LINK_KEY_STORAGE)},${js(linkKey)})}catch(e){}location.replace(${js(config.basePath + returnTo)})</script>`,
      );
    } catch (e) {
      return ssoFail(reply, (e as Error).message);
    }
  });

  /**
   * The callback of a step-up (auth/step-up.ts): no cookie, no session. On success the page – in the browser holding the
   * session – redeems the one-time ticket with the session key, then closes (popup) or returns to the page (redirect).
   */
  function stepUpPage(r: sso.StepUpCallback): string {
    const lang = resolveLocale(r.locale, getSettings().defaultLocale);
    const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
    const js = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
    const back = config.basePath + r.returnTo;
    // what was confirmed and when it started (the start time is written in the browser's time zone by the script)
    const what = r.actions.length
      ? r.actions.map((a) => serverT(lang, `stepUp.actions.${a}` as 'stepUp.actions.createToken')).join(', ')
      : serverT(lang, 'stepUp.actions.other');
    const started = new Date(r.startedAt).toISOString();
    const head =
      // nosemgrep: javascript.express.security.injection.raw-html-format.raw-html-format -- catalog texts and an ISO time, HTML-escaped; no request data
      `<!doctype html><html lang="${lang}"><meta charset="utf-8"><title>${esc(serverT(lang, 'stepUp.title'))}</title>` +
      `<p>${esc(serverT(lang, 'stepUp.what', { actions: what }))}</p><p>${esc(serverT(lang, 'stepUp.scope', { count: Math.round(config.session.stepUpMs / 60_000) }))}</p><p>${esc(serverT(lang, 'stepUp.started'))} <time datetime="${esc(started)}">${esc(started.slice(11, 16))} UTC</time></p>` +
      `<script>(function(){var t=document.querySelector('time');try{t.textContent=new Date(t.getAttribute('datetime')).toLocaleTimeString(document.documentElement.lang,{hour:'2-digit',minute:'2-digit'})}catch(e){}})()</script>`;
    if (!r.ok) {
      stepUp.recordStepUpFailure(r.sessionId, r.code, r.message);
      // nosemgrep: javascript.express.security.injection.raw-html-format.raw-html-format -- catalog texts and the provider's refusal, HTML-escaped; the link is a validated app path
      return `${head}<p>${esc(serverT(lang, 'stepUp.failed'))}</p><p>${esc(r.message)}</p>${r.popup ? '' : `<p><a href="${esc(back)}">${esc(serverT(lang, 'stepUp.back'))}</a></p>`}</html>`;
    }
    const ticket = stepUp.issueStepUpTicket({ sessionId: r.sessionId, userId: r.userId, method: r.method, at: r.at, provider: r.provider });
    const url = config.basePath + '/api/auth/step-up/sso/complete';
    return (
      // nosemgrep: javascript.express.security.injection.raw-html-format.raw-html-format -- catalog texts HTML-escaped; values are JSON string literals with "<" escaped (js()), safe inside <script>; the return path is validated (below the base path)
      `${head}<p id="m">${esc(serverT(lang, 'stepUp.confirming'))}</p><script>(function(){var k=null;try{k=localStorage.getItem(${js(SESSION_KEY_STORAGE)})}catch(e){}` +
      `var h={'x-sm-client':'1','content-type':'application/json'};if(k)h['x-sm-session']=k;` +
      `function done(ok){document.getElementById('m').textContent=ok?${js(serverT(lang, 'stepUp.done'))}:${js(serverT(lang, 'stepUp.notHere'))};` +
      `if(${js(r.popup)}){if(ok)setTimeout(function(){window.close()},800)}else if(ok){location.replace(${js(back)})}}` +
      `fetch(${js(url)},{method:'POST',credentials:'same-origin',headers:h,body:JSON.stringify({ticket:${js(ticket)}})}).then(function(x){done(x.ok)},function(){done(false)})})()</script></html>`
    );
  }

  // ---------- step-up re-authentication (auth/step-up.ts): sessions only (config.access) ----------
  app.get('/auth/step-up', { config: { access: ACCESS.session } }, async () => stepUp.stepUpStatus(stepUp.requireSession(me())));
  // the password again: limited and counted like a sign-in
  app.post('/auth/step-up', { bodyLimit: 16 * 1024, config: { access: ACCESS.session, rateLimit: ROUTE_LIMITS.credential } }, async (req) => {
    const b = z.object({ password: z.string().max(1024) }).parse(req.body);
    return stepUp.passwordStepUp(stepUp.requireSession(me()), b.password, req.ip);
  });
  app.delete('/auth/step-up', { config: { access: ACCESS.session } }, async () => {
    const u = stepUp.requireSession(me());
    stepUp.endStepUp(u);
    return stepUp.stepUpStatus({ ...u, session: { ...u.session, stepUpAt: null, stepUpMethod: null } });
  });
  // a fresh sign-in at the session's provider (prompt=login, max_age=0), in a popup or this window
  // (no secret is checked here: the provider checks the person; the ticket is 256 random bits)
  app.post('/auth/step-up/sso', { config: { access: ACCESS.session, rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    const u = stepUp.requireSession(me());
    if (u.session.method !== 'sso') throw new HttpError(400, 'This session was not opened with single sign-on', 'STEP_UP_METHOD', { method: u.session.method });
    const b = z
      .object({
        returnTo: z.string().max(1024).optional(),
        popup: z.boolean().default(true),
        // what is being confirmed (from the STEP_UP_REQUIRED answers): shown on the callback page
        actions: z.array(z.enum(STEP_UP_ACTIONS)).max(STEP_UP_ACTIONS.length).default([]),
      })
      .parse(req.body ?? {});
    return sso.startStepUp({ id: u.id, sessionId: u.session.id }, sso.redirectUriFor(req), b);
  });
  app.post('/auth/step-up/sso/complete', { bodyLimit: 4 * 1024, config: { access: ACCESS.session, rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    const b = z.object({ ticket: z.string().max(100) }).parse(req.body);
    return stepUp.redeemStepUpTicket(stepUp.requireSession(me()), b.ticket);
  });

  app.get('/sso/providers', { config: { access: ACCESS.admin } }, async () => {
    requireCapability(me(), 'manageUsers', 'manage single sign-on');
    return sso.listProviders();
  });
  app.post('/sso/providers', { config: { access: ACCESS.adminSession, stepUp: { action: 'addSsoProvider', who: 'manageUsers' } } }, async (req) => {
    requireCapability(me(), 'manageUsers', 'manage single sign-on');
    return sso.saveProvider(req.body as never);
  });
  app.put('/sso/providers/:id', { config: { access: ACCESS.adminSession, stepUp: { action: 'changeSsoProvider', who: 'manageUsers' } } }, async (req) => {
    requireCapability(me(), 'manageUsers', 'manage single sign-on');
    sso.getProvider(params(req).id!);
    return sso.saveProvider(req.body as never, params(req).id);
  });
  app.delete('/sso/providers/:id', { config: { access: ACCESS.adminSession, stepUp: { action: 'deleteSsoProvider', who: 'manageUsers' } } }, async (req) => {
    requireCapability(me(), 'manageUsers', 'manage single sign-on');
    sso.deleteProvider(params(req).id!);
    return { ok: true };
  });
  app.post('/sso/discover', { config: { access: ACCESS.admin, rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    requireCapability(me(), 'manageUsers', 'manage single sign-on');
    return sso.discover(z.object({ issuer: z.string().url() }).parse(req.body).issuer);
  });
  app.get('/sso/redirect-uri', async (req) => ({ redirectUri: sso.redirectUriFor(req) }));
  /** Test sign-in: the administrator signs in once through the provider and sees the claims – nothing signs in or changes. */
  app.post('/sso/providers/:id/test-sign-in', { config: { access: ACCESS.adminSession, rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    requireCapability(me(), 'manageUsers', 'test single sign-on');
    const u = me();
    return sso.startTestSignIn(params(req).id!, { id: u.id, username: u.username }, sso.redirectUriFor(req));
  });
  app.post('/sso/test-sign-ins/:id', { config: { access: ACCESS.adminSession } }, async (req) => {
    requireCapability(me(), 'manageUsers', 'test single sign-on');
    const b = z.object({ config: z.unknown().optional() }).parse(req.body ?? {});
    return sso.testResult(params(req).id!, me().id, b.config);
  });

  app.post('/auth/password', { config: { rateLimit: ROUTE_LIMITS.credential } }, async (req) => {
    const b = z.object({ current: z.string().max(1024), next: z.string().max(1024) }).parse(req.body);
    await users.changePassword(me().id, b.current, b.next, readCookie(req.headers.cookie, SESSION_COOKIE));
    return { ok: true };
  });

  app.post('/vault/unlock', { config: { rateLimit: ROUTE_LIMITS.credential } }, async (req, reply) => {
    if (!isAdmin(me())) throw new HttpError(403, 'Only administrators can unlock the vault');
    const b = z.object({ passphrase: z.string().max(1024) }).parse(req.body);
    // Failed attempts are audited (written once the vault is open) and slow down further attempts.
    const wait = unlockThrottle.waitSeconds();
    if (wait > 0) {
      reply.header('retry-after', String(wait));
      throw new HttpError(429, `Too many wrong passphrases – try again in ${wait} s`, 'TOO_MANY_ATTEMPTS');
    }
    try {
      await vault().unlock(b.passphrase);
    } catch (e) {
      if ((e as HttpError).code === 'WRONG_PASSPHRASE') {
        const n = unlockThrottle.failed();
        audit({
          action: 'vault.unlock_failed',
          entityType: 'vault',
          summary: `Wrong master passphrase entered by ${me().username} (attempt ${n})`,
          details: { ip: req.ip, attempt: n },
        });
      }
      throw e;
    }
    unlockThrottle.succeeded();
    audit({ action: 'vault.unlocked', entityType: 'vault', summary: `Vault unlocked by ${me().username}` });
    await onUnlocked();
    return { ok: true };
  });

  // Master passphrase change (administrators; needs the current passphrase). rotateDataKey re-encrypts every secret.
  app.post(
    '/vault/passphrase',
    { config: { access: ACCESS.session, rateLimit: ROUTE_LIMITS.credential, stepUp: { action: 'changeVaultPassphrase', who: 'manageSettings' } } },
    async (req) => {
      if (!isAdmin(me())) throw new HttpError(403, 'Only administrators can change the master passphrase');
      const b = z.object({ current: z.string().max(1024), next: z.string().max(1024), rotateDataKey: z.boolean().default(true) }).parse(req.body);
      const wait = unlockThrottle.waitSeconds();
      if (wait > 0) throw new HttpError(429, `Too many wrong passphrases – try again in ${wait} s`, 'TOO_MANY_ATTEMPTS');
      try {
        const r = await changeMasterPassphrase(b.current, b.next, b.rotateDataKey);
        unlockThrottle.succeeded();
        return { ok: true, ...r };
      } catch (e) {
        if ((e as HttpError).code === 'WRONG_PASSPHRASE') {
          const n = unlockThrottle.failed();
          audit({
            action: 'vault.passphrase_change_failed',
            entityType: 'vault',
            summary: `Master passphrase change by ${me().username} refused: wrong current passphrase (attempt ${n})`,
            details: { ip: req.ip },
          });
        }
        throw e;
      }
    },
  );

  // Public information about the vault (format, scrypt cost, checkpoint signing key) – administrators and auditors.
  app.get('/vault/info', async () => {
    requireCapability(me(), 'viewAudit', 'view vault information');
    const i = vault().info();
    return { ...i, passphraseMinLength: 12, signingPublicKeyPem: i.signingPublicKey ? publicKeyPem(i.signingPublicKey) : null };
  });

  app.post('/vault/lock', { config: { access: ACCESS.session } }, async () => {
    if (!isAdmin(me())) throw new HttpError(403, 'Only administrators can lock the vault');
    if (vault().unlocked) {
      audit({ action: 'vault.locked', entityType: 'vault', summary: `Vault locked by ${me().username}` });
      scheduler.stopScheduler();
      void stopMonitorEngine();
      started = false;
      vault().lock();
    }
    return { ok: true };
  });
}
