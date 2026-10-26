import fs from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  LOCALE_CODES,
  API_DOCS_MODES,
  PASSWORD_LOGIN_MODES,
  STEP_UP_ACTIONS,
  OUTBOUND_POLICIES,
  ROLES,
  validateProcess,
  type AuthStatus,
  type DashboardAttention,
  type DashboardData,
  type DashboardSetup,
  type Me,
  type RunSummary,
  type StartRunRequest,
  type Subject,
  type TaskDecision,
  type TaskRecord,
  type UserInfo,
} from '@sm/shared';
import { config } from '../config.js';
import { vault } from '../vault.js';
import { audit, queryAudit, allAuditAscending, flushPendingAudit } from '../audit.js';
import { anchoringStatus, createCheckpoint, parseAnchor, saveEmailSettings, verificationResult, verifyWithAnchors, anchorFile } from '../audit-anchor.js';
import { auditCsv, auditExportBundle } from '../audit-export.js';
import { changeMasterPassphrase } from '../vault-rotation.js';
import { publicKeyPem } from '../vault.js';
import { unlockThrottle } from '../auth/unlock-throttle.js';
import { confirmPlatformConfig, sealPlatformConfigs } from '../platforms/integrity.js';
import { getSettings, passwordLoginFromEnv, passwordLoginMode, updateSettings } from '../settings.js';
import { resolveLocale, t as serverT } from '../i18n/index.js';
import { HttpError, parseJson, MAX_DEFINITION_TEXT, rasterImageType } from '../util.js';
import { db } from '../db.js';
import * as platforms from '../platforms/service.js';
import * as connectors from '../platforms/connectors.js';
import { platformRequest, secretValues } from '../platforms/http.js';
import * as processes from '../processes/service.js';
import * as store from '../engine/store.js';
import { startRun, cancelRun, resumeRun, completeTask, completeManualTask, recoverRuns, verifyManualTask } from '../engine/runner.js';
import { addEvidence, evidenceForDownload, manualCompletionSchema, manualForReader, removeEvidence, verificationSchema } from '../engine/manual.js';
import { browserAvailable } from '../engine/browser.js';
import * as scheduler from '../scheduler.js';
import { runReportHtml } from '../reports.js';
import { setupDemo } from './demo.js';
import { dashboardRoutes } from './dashboards.js';
import { opsRoutes } from './ops.js';
import { engineExtrasRoutes } from './engine-extras.js';
import { reportRoutes } from './reports.js';
import { triggerRoutes } from './triggers.js';
import { monitorRoutes } from '../monitors/routes.js';
import { recordRoutes, uploadedFile } from '../records/routes.js';
import { contentDisposition, downloadType } from '../records/attachments.js';
import { catalogueRoutes } from '../catalogue/routes.js';
import { ticketRoutes } from '../tickets/routes.js';
import { dailySummaryRoutes } from '../notifications/summary-routes.js';
import { complianceRoutes } from '../compliance/routes.js';
import { migrationRoutes } from '../migration/routes.js';
import { findingAttention, startAccessChecks } from '../compliance/reconciliation.js';
import { monitorAttention } from '../monitors/service.js';
import { dueAttention } from '../credentials/service.js';
import { vendorAttention } from '../tickets/service.js';
import { reviewAttention } from '../records/documents.js';
import { startMonitorEngine, stopMonitorEngine } from '../monitors/engine.js';
import { gatusRoutes } from '../gatus/routes.js';
import { startGatusScraper } from '../gatus/metrics.js';
import { credentialRoutes } from '../credentials/routes.js';
import { reportScheduleRoutes } from './report-schedules.js';
import { startReportSchedules } from '../reports/schedules.js';
import { syncRoutes } from '../sync/routes.js';
import { startGitSync } from '../sync/engine.js';
import { currentActor, currentUser, runAs, type AuthUser } from '../auth/context.js';
import * as users from '../auth/users.js';
import * as sso from '../auth/sso.js';
import * as emergency from '../auth/emergency.js';
import * as stepUp from '../auth/step-up.js';
import { changesAccess, changesSignInOrOutbound, changesTeamMembers, grantsRoles, platformAccess, processAccess } from '../auth/step-up-rules.js';
import { currentInstanceId } from '../instance.js';
import { capabilities, decisionCheck, isAdmin, processPermissions, require, requireCapability } from '../auth/permissions.js';
import { LINK_KEY_STORAGE, readCookie, sessionCookie, sendSessionKeys, SESSION_COOKIE, SESSION_KEY_STORAGE } from '../auth/cookies.js';
import { BRAND, MANUAL_LIMITS, boundedRecord } from '@sm/shared';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { IMPORT_BODY_SHAPE } from '../bodyShape.js';
import { LARGE_BODIES } from '../bodyLimits.js';
import { auditPendingUpgrades } from '../upgrades.js';

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

const platformBody = z.object({
  name: z.string().min(1).max(200),
  kind: z.string().max(64).optional(),
  description: z.string().max(10000).optional(),
  baseUrl: z.string().max(2000).optional(),
  environment: z.string().max(100).optional(),
  config: z.any().optional(),
  secrets: boundedRecord(z.string().max(20000), 100).optional(),
});

/** Query strings are validated like bodies: one value per parameter, bounded, numbers as numbers. */
const queryText = z.string().max(500).optional();
const versionQuery = z.object({ version: z.coerce.number().int().min(1).optional() });
const runsQuery = z.object({
  processId: z.string().max(200).optional(),
  status: z.string().max(200).optional(),
  scheduleId: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  before: z.string().max(64).optional(),
  /** Runs started after this time (ISO), e.g. the start page's "Failed runs (24 h)" */
  since: z
    .string()
    .max(64)
    .refine((x) => !Number.isNaN(Date.parse(x)), 'an ISO timestamp')
    .transform((x) => new Date(x).toISOString())
    .optional(),
});
const auditQuery = z.object({
  runId: z.string().max(200).optional(),
  entityType: queryText,
  entityId: queryText,
  action: queryText,
  q: queryText,
  actor: queryText,
  from: z.string().max(64).optional(),
  to: z.string().max(64).optional(),
  beforeSeq: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
});

// ---------- helpers ----------

const me = (): AuthUser => {
  const u = currentUser();
  if (!u) throw new HttpError(401, 'Please sign in', 'NOT_SIGNED_IN');
  return u;
};

/** Instance-wide counts for the getting-started checklist (administrators only). */
function setupProgress(): DashboardSetup {
  const count = (sql: string) => db().get<{ n: number }>(sql)?.n ?? 0;
  return {
    platforms: count('SELECT COUNT(*) AS n FROM platforms'),
    processes: count('SELECT COUNT(*) AS n FROM processes'),
    runs: count('SELECT COUNT(*) AS n FROM runs'),
    schedules: count('SELECT COUNT(*) AS n FROM schedules'),
    monitors: count('SELECT COUNT(*) AS n FROM monitors WHERE is_template = 0'),
    credentials: count('SELECT COUNT(*) AS n FROM credentials WHERE archived = 0'),
    users: users.countUsers(),
    reportSchedules: count('SELECT COUNT(*) AS n FROM report_schedules'),
  };
}

function meInfo(): Me | null {
  const u = currentUser();
  if (!u) return null;
  const user = users.getUser(u.id);
  if (u.emergency) user.mustChangePassword = false;
  return { user, capabilities: capabilities(u), ...(u.emergency ? { emergency: { expiresAt: u.emergency.expiresAt } } : {}) };
}

function requireProcess(processId: string, perm: 'view' | 'run' | 'edit' | 'approve' | 'manage', what: string) {
  const perms = processes.permissionsFor(processId);
  if (!perms.includes('view')) throw new HttpError(404, `Process ${processId} not found`);
  require(perms, perm, what);
  return perms;
}

function requireRun(runId: string, perm: 'view' | 'run', what: string) {
  const r = store.runRow(runId);
  const perms = processes.permissionsFor(r.process_id);
  if (!perms.includes('view')) throw new HttpError(404, `Run ${runId} not found`);
  require(perms, perm, what);
  return r;
}

/** A platform the current user has some permission on (404 otherwise, so ids can't be probed). */
function visiblePlatform(id: string) {
  const p = platforms.getPlatform(id);
  if (!p.permissions.length) throw new HttpError(404, `Platform ${id} not found`);
  return p;
}

/** Content type for showing an uploaded document inline, or null to force a download. */
function inlineDocType(data: Buffer, declared: string | undefined): string | null {
  const head = data.subarray(0, 12);
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.subarray(0, 6).toString('latin1').startsWith('GIF8')) return 'image/gif';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (/^text\/(plain|markdown|csv)$/.test(declared ?? '') && !data.includes(0)) return 'text/plain; charset=utf-8';
  return null;
}

function requirePlatform(id: string, perm: 'use' | 'manage', what: string) {
  const p = platforms.getPlatform(id);
  require(p.permissions, perm, what);
  return p;
}

function requireBindingsUsable(bindings: Record<string, string> | undefined) {
  for (const pid of Object.values(bindings ?? {})) requirePlatform(pid, 'use', `use platform ${pid}`);
}

/** Processes the current user may view (one query, permissions evaluated in memory). */
const visibleProcessIds = (): Set<string> => {
  const user = currentUser();
  return new Set(
    db()
      .all<{ id: string; owner: string | null; acl: string }>('SELECT id, owner, acl FROM processes')
      .filter((r) => processPermissions(user, { owner: r.owner, acl: parseJson(r.acl, []) }).includes('view'))
      .map((r) => r.id),
  );
};

function withDecisionRights(tasks: TaskRecord[]): TaskRecord[] {
  const permCache = new Map<string, ReturnType<typeof processes.permissionsFor>>();
  return tasks.map((t) => {
    const pid = t.processId ?? store.taskProcessId(t.id);
    if (!permCache.has(pid)) permCache.set(pid, processes.permissionsFor(pid));
    const check = decisionCheck(currentUser(), t, { actor: t.startedBy ?? '' }, permCache.get(pid)!);
    return {
      ...t,
      ...(t.manual ? { manual: manualForReader(t.manual, currentUser()) } : {}),
      canDecide: check.ok,
      cannotDecideReason: check.reason,
      cannotDecideCode: check.code,
      cannotDecideParams: check.params,
    };
  });
}

function visibleTasks(status?: string): TaskRecord[] {
  const visible = visibleProcessIds();
  return withDecisionRights(store.listTasks({ status }).filter((t) => visible.has(t.processId ?? store.taskProcessId(t.id))));
}

/**
 * Runs the user may see, newest first. Runs of hidden processes are left out before the limit applies:
 * further batches are read (older than the last one) until the page is full, so a short page means
 * "no more runs" and `before` = the oldest run's start continues the list.
 */
function visibleRuns(f: Parameters<typeof store.listRuns>[0]): RunSummary[] {
  const visible = visibleProcessIds();
  const limit = Math.min(f.limit ?? 100, 1000);
  const batch = Math.min(limit * 3, 1000);
  const out: RunSummary[] = [];
  let before = f.before;
  for (let i = 0; i < 20 && out.length < limit; i++) {
    const rows = store.listRuns({ ...f, before, limit: batch });
    out.push(...rows.filter((r) => visible.has(r.processId)));
    if (rows.length < batch) break;
    before = rows[rows.length - 1]!.startedAt;
  }
  return out.slice(0, limit);
}

function redact<T>(v: T, secrets: Record<string, string>): T {
  const vals = secretValues(secrets);
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') return vals.reduce((s, sec) => (sec && s.includes(sec) ? s.split(sec).join('***') : s), x);
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, val]) => [k, walk(val)]));
    return x;
  };
  return walk(v) as T;
}

const params = (req: FastifyRequest) => req.params as Record<string, string>;

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // ---------- health, auth & vault ----------
  app.get('/health', async () => ({ ok: true, version: config.version }));

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
  app.get('/auth/status', status);
  app.get('/vault/status', async () => {
    const s = await status();
    return { ...s, operator: s.me?.user.displayName };
  });

  app.post('/auth/setup', { config: { rateLimit: ROUTE_LIMITS.credential } }, async (req, reply) => {
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
  app.post('/auth/login', { bodyLimit: 16 * 1024 }, async (req, reply) => {
    const b = z.object({ username: z.string().max(256), password: z.string().max(1024) }).parse(req.body);
    const { user, ...session } = await users.login(b.username.trim(), b.password, { ip: req.ip, userAgent: req.headers['user-agent'] });
    reply.header('set-cookie', sessionCookie(session.token));
    sendSessionKeys(reply, session);
    return { user, capabilities: capabilities(users.toAuthUser(user)) } satisfies Me;
  });

  // Emergency access (break-glass, see auth/emergency.ts): the one-time code from `steward admin emergency-access`.
  app.post('/auth/emergency', { bodyLimit: 4 * 1024, config: { rateLimit: ROUTE_LIMITS.credential } }, async (req, reply) => {
    const b = z.object({ code: z.string().max(200) }).parse(req.body);
    const { user, ...session } = emergency.signInWithCode(b.code.trim(), { ip: req.ip, userAgent: req.headers['user-agent'] });
    reply.header('set-cookie', sessionCookie(session.token));
    sendSessionKeys(reply, session);
    return { user: { ...user, mustChangePassword: false }, capabilities: capabilities(users.toAuthUser(user)) } satisfies Me;
  });
  // The same command while Steward runs: a grant signed with the vault's key, from this machine only.
  app.post('/auth/emergency/grant', { bodyLimit: 8 * 1024, config: { rateLimit: ROUTE_LIMITS.credential } }, async (req) => {
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

  // ---------- step-up re-authentication (auth/step-up.ts): sessions only, see SESSION_ONLY_ROUTES ----------
  app.get('/auth/step-up', async () => stepUp.stepUpStatus(stepUp.requireSession(me())));
  // the password again: limited and counted like a sign-in
  app.post('/auth/step-up', { bodyLimit: 16 * 1024, config: { rateLimit: ROUTE_LIMITS.credential } }, async (req) => {
    const b = z.object({ password: z.string().max(1024) }).parse(req.body);
    return stepUp.passwordStepUp(stepUp.requireSession(me()), b.password, req.ip);
  });
  app.delete('/auth/step-up', async () => {
    const u = stepUp.requireSession(me());
    stepUp.endStepUp(u);
    return stepUp.stepUpStatus({ ...u, session: { ...u.session, stepUpAt: null, stepUpMethod: null } });
  });
  // a fresh sign-in at the session's provider (prompt=login, max_age=0), in a popup or this window
  // (no secret is checked here: the provider checks the person; the ticket is 256 random bits)
  app.post('/auth/step-up/sso', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
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
  app.post('/auth/step-up/sso/complete', { bodyLimit: 4 * 1024, config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    const b = z.object({ ticket: z.string().max(100) }).parse(req.body);
    return stepUp.redeemStepUpTicket(stepUp.requireSession(me()), b.ticket);
  });

  app.get('/sso/providers', async () => {
    requireCapability(me(), 'manageUsers', 'manage single sign-on');
    return sso.listProviders();
  });
  app.post('/sso/providers', { config: { stepUp: { action: 'addSsoProvider', who: 'manageUsers' } } }, async (req) => {
    requireCapability(me(), 'manageUsers', 'manage single sign-on');
    return sso.saveProvider(req.body as never);
  });
  app.put('/sso/providers/:id', { config: { stepUp: { action: 'changeSsoProvider', who: 'manageUsers' } } }, async (req) => {
    requireCapability(me(), 'manageUsers', 'manage single sign-on');
    sso.getProvider(params(req).id!);
    return sso.saveProvider(req.body as never, params(req).id);
  });
  app.delete('/sso/providers/:id', { config: { stepUp: { action: 'deleteSsoProvider', who: 'manageUsers' } } }, async (req) => {
    requireCapability(me(), 'manageUsers', 'manage single sign-on');
    sso.deleteProvider(params(req).id!);
    return { ok: true };
  });
  app.post('/sso/discover', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    requireCapability(me(), 'manageUsers', 'manage single sign-on');
    return sso.discover(z.object({ issuer: z.string().url() }).parse(req.body).issuer);
  });
  app.get('/sso/redirect-uri', async (req) => ({ redirectUri: sso.redirectUriFor(req) }));
  /** Test sign-in: the administrator signs in once through the provider and sees the claims – nothing signs in or changes. */
  app.post('/sso/providers/:id/test-sign-in', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    requireCapability(me(), 'manageUsers', 'test single sign-on');
    const u = me();
    return sso.startTestSignIn(params(req).id!, { id: u.id, username: u.username }, sso.redirectUriFor(req));
  });
  app.post('/sso/test-sign-ins/:id', async (req) => {
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
    { config: { rateLimit: ROUTE_LIMITS.credential, stepUp: { action: 'changeVaultPassphrase', who: 'manageSettings' } } },
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

  app.post('/vault/lock', async () => {
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

  // ---------- users & teams ----------
  app.get('/users', async () => {
    requireCapability(me(), 'manageUsers', 'manage users');
    return users.listUsers();
  });
  app.post('/users', { config: { stepUp: { action: 'createUser', who: 'manageUsers', when: grantsRoles } } }, async (req) => {
    requireCapability(me(), 'manageUsers', 'manage users');
    const b = z
      .object({
        username: z.string().max(64),
        displayName: z.string().max(100).optional(),
        firstName: z.string().max(100).optional(),
        lastName: z.string().max(100).optional(),
        email: z.string().max(254).optional(),
        roles: z.array(z.enum(ROLES)).max(ROLES.length).default([]),
        password: z.string().max(1024).optional(),
        /** A single sign-on account: no password, claimed at the first sign-in through this provider only */
        provider: z.string().max(100).optional(),
      })
      .parse(req.body);
    const { provider, ...input } = b;
    // single sign-on only: new accounts get no password and are linked by their user name at the first sign-in
    if (provider || passwordLoginMode() === 'none') {
      if (b.password) users.requirePasswordLogin('setting a password');
      return users.createUser({ ...input, password: undefined, noPassword: true, provider: claimingProvider(provider).id });
    }
    return users.createUser({ ...input, mustChangePassword: true });
  });
  /**
   * The provider that may claim a new account without a password: the one chosen, or the only enabled one. With several
   * enabled providers the choice is required – otherwise any of them could hand the account (and its roles) to whoever
   * has that user name there.
   */
  function claimingProvider(id: string | undefined): { id: string; displayName: string } {
    const enabled = sso.publicProviders();
    if (id) {
      const p = enabled.find((x) => x.id === id);
      if (!p) throw new HttpError(400, 'Choose an enabled single sign-on provider', 'SSO_PROVIDER_UNKNOWN');
      return p;
    }
    if (enabled.length === 1) return enabled[0]!;
    if (!enabled.length) throw new HttpError(400, 'Enable a single sign-on provider first', 'SSO_PROVIDER_REQUIRED');
    throw new HttpError(400, 'Choose the single sign-on provider the account signs in with', 'SSO_PROVIDER_CHOICE_REQUIRED');
  }
  app.put('/users/:id', { config: { stepUp: { action: 'changeAccount', who: 'manageUsers', when: changesAccess } } }, async (req) => {
    requireCapability(me(), 'manageUsers', 'manage users');
    const b = z
      .object({
        displayName: z.string().max(100).optional(),
        firstName: z.string().max(100).optional(),
        lastName: z.string().max(100).optional(),
        email: z.string().max(254).optional(),
        roles: z.array(z.enum(ROLES)).max(ROLES.length).optional(),
        active: z.boolean().optional(),
        /** Bind a local account to a single sign-on provider (removes its password) */
        provider: z.string().max(100).optional(),
      })
      .parse(req.body);
    const { provider, ...patch } = b;
    const id = params(req).id!;
    // one transaction: a binding is not kept when the rest of the change is refused
    return db().tx(() => {
      if (provider) {
        const p = claimingProvider(provider);
        users.bindToProvider(id, p.id, p.displayName);
      }
      return Object.keys(patch).length || !provider ? users.updateUser(id, patch) : users.getUser(id);
    });
  });
  // a temporary password lets the administrator sign in as that person
  app.post(
    '/users/:id/reset-password',
    { config: { rateLimit: ROUTE_LIMITS.credential, stepUp: { action: 'resetPassword', who: 'manageUsers' } } },
    async (req) => {
      requireCapability(me(), 'manageUsers', 'manage users');
      return { temporaryPassword: users.resetPassword(params(req).id!) };
    },
  );
  app.get('/teams', async () => {
    requireCapability(me(), 'manageUsers', 'view teams');
    return users.listTeams();
  });
  const teamBody = z.object({
    name: z.string().max(64),
    description: z.string().max(2000).optional(),
    members: z.array(z.string().max(64)).max(5000).optional(),
  });
  // teams are subjects of access lists: a new member gets the team's rights (auth/step-up-rules.ts)
  const teamStepUp = { stepUp: { action: 'changeTeamMembers' as const, who: 'manageUsers' as const, when: changesTeamMembers } };
  app.post('/teams', { config: teamStepUp }, async (req) => {
    requireCapability(me(), 'manageUsers', 'manage teams');
    return users.saveTeam(teamBody.parse(req.body));
  });
  app.put('/teams/:id', { config: teamStepUp }, async (req) => {
    requireCapability(me(), 'manageUsers', 'manage teams');
    return users.saveTeam(teamBody.parse(req.body), params(req).id);
  });
  app.delete('/teams/:id', async (req) => {
    requireCapability(me(), 'manageUsers', 'manage teams');
    users.deleteTeam(params(req).id!);
    return { ok: true };
  });
  app.get('/subjects', async (): Promise<Subject[]> => {
    // Used by access editors and assignee pickers – not needed by read-only accounts.
    if (!me().roles.some((r) => r !== 'viewer' && r !== 'auditor')) throw new HttpError(403, 'You are not allowed to list users and teams');
    return subjectList();
  });
  const subjectList = (): Subject[] => [
    ...users
      .listUsers()
      .filter((u: UserInfo) => u.active)
      .map((u) => ({ value: `user:${u.username.toLowerCase()}`, label: `${u.displayName} (${u.username})`, kind: 'user' as const })),
    ...users.listTeams().map((t) => ({ value: `team:${t.name.toLowerCase()}`, label: `Team ${t.name}`, kind: 'team' as const, name: t.name })),
    ...ROLES.map((r) => ({ value: `role:${r}`, label: `Everyone with role ${r}`, kind: 'role' as const, name: r })),
  ];

  // ---------- settings ----------
  app.get('/settings', async () => {
    requireCapability(me(), 'manageSettings', 'view settings');
    return getSettings();
  });
  app.put('/settings', { config: { stepUp: { action: 'changeSignInSettings', who: 'manageSettings', when: changesSignInOrOutbound } } }, async (req) => {
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
        outboundAllowList: z.array(z.string().trim().min(1).max(255)).max(200).optional(),
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
      details: { ...b, ...(ended ? { sessionsEnded: ended } : {}) },
    });
    return s;
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

  // ---------- platforms ----------
  app.get('/platform-presets', async () => connectors.listPresets());
  app.post('/platform-types', async (req) => {
    requireCapability(me(), 'createPlatforms', 'create connector types');
    const b = z
      .object({
        fromPlatformId: z.string().max(200),
        kind: z.string().max(64).optional(),
        label: z.string().max(200).optional(),
        description: z.string().max(10000).optional(),
      })
      .parse(req.body);
    requirePlatform(b.fromPlatformId, 'manage', 'use this platform as a template');
    return connectors.createTypeFromPlatform(b.fromPlatformId, b);
  });
  app.post(
    '/platform-types/import',
    { config: { rateLimit: ROUTE_LIMITS.heavy, smBodyShape: IMPORT_BODY_SHAPE }, bodyLimit: LARGE_BODIES.exports.bytes },
    async (req) => {
      requireCapability(me(), 'createPlatforms', 'import connector types');
      return connectors.importType(z.object({ package: z.any() }).parse(req.body).package);
    },
  );
  app.get('/platform-types/:kind/export', async (req, reply) => {
    const pkg = connectors.getPackage(params(req).kind!);
    reply.header('content-disposition', `attachment; filename="connector-${pkg.kind}.json"`);
    return pkg;
  });
  app.delete('/platform-types/:kind', async (req) => {
    requireCapability(me(), 'createPlatforms', 'delete connector types');
    connectors.deleteType(params(req).kind!);
    return { ok: true };
  });
  // Platforms (names, base URLs, docs) are only visible to users with some permission on them.
  app.get('/platforms', async () => platforms.listPlatforms().filter((p) => p.permissions.length > 0));
  app.post('/platforms', async (req) => {
    requireCapability(me(), 'createPlatforms', 'add platforms');
    return connectors.createPlatformFromType(platformBody.extend({ typeKind: z.string().optional() }).parse(req.body));
  });
  app.get('/platforms/:id', async (req) => visiblePlatform(params(req).id!));
  app.put('/platforms/:id', async (req) => {
    requirePlatform(params(req).id!, 'manage', 'change this platform');
    return platforms.updatePlatform(params(req).id!, platformBody.partial().parse(req.body));
  });
  app.put('/platforms/:id/access', { config: { stepUp: { action: 'grantAccess', ...platformAccess } } }, async (req) => {
    requirePlatform(params(req).id!, 'manage', 'change access to this platform');
    return platforms.setPlatformAccess(params(req).id!, z.object({ acl: z.array(z.any()).max(500) }).parse(req.body).acl);
  });
  app.delete('/platforms/:id', async (req) => {
    requirePlatform(params(req).id!, 'manage', 'delete this platform');
    platforms.deletePlatform(params(req).id!);
    return { ok: true };
  });
  // Connection settings changed outside the application (configuration integrity): an administrator reviews and confirms them.
  app.post('/platforms/:id/confirm-config', async (req) => {
    requireCapability(me(), 'createPlatforms', 'confirm platform settings');
    requirePlatform(params(req).id!, 'manage', 'confirm the settings of this platform');
    confirmPlatformConfig(params(req).id!);
    return platforms.getPlatform(params(req).id!);
  });
  app.put('/platforms/:id/secrets', async (req) => {
    requirePlatform(params(req).id!, 'manage', 'change credentials of this platform');
    return platforms.setSecrets(params(req).id!, boundedRecord(z.string().nullable(), 100).parse(req.body));
  });

  app.post('/platforms/:id/test', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    const id = params(req).id!;
    const p = requirePlatform(id, 'use', 'use this platform');
    const secrets = platforms.getSecrets(id);
    const testPath = p.config.testPath || '/';
    try {
      const res = await platformRequest(p, secrets, { method: 'GET', url: testPath });
      const ok = res.status >= 200 && res.status < 400;
      audit({
        action: 'platform.tested',
        entityType: 'platform',
        entityId: id,
        summary: `Connection test "${p.name}": GET ${testPath} → HTTP ${res.status} (${res.durationMs} ms)`,
      });
      return { ok, status: res.status, durationMs: res.durationMs, message: ok ? 'Connection works' : `HTTP ${res.status}`, body: redact(res.body, secrets) };
    } catch (e) {
      const message = redact((e as Error).message, secrets) as string;
      audit({ action: 'platform.tested', entityType: 'platform', entityId: id, summary: `Connection test "${p.name}" failed: ${message.slice(0, 200)}` });
      return { ok: false, status: 0, durationMs: 0, message };
    }
  });

  app.post('/platforms/:id/request', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    const id = params(req).id!;
    const b = z
      .object({
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']),
        path: z.string().min(1).max(8000),
        query: boundedRecord(z.string().max(8000), 200).optional(),
        headers: boundedRecord(z.string().max(8000), 100).optional(),
        body: z.any().optional(),
      })
      .parse(req.body);
    const write = !(b.method === 'GET' || b.method === 'HEAD');
    const p = requirePlatform(id, write ? 'manage' : 'use', write ? 'send changing requests to this platform' : 'use this platform');
    const secrets = platforms.getSecrets(id);
    const res = await platformRequest(p, secrets, { method: b.method, url: b.path, query: b.query, headers: b.headers, body: b.body });
    audit({
      action: write ? 'api.adhoc_write' : 'api.adhoc_read',
      entityType: 'platform',
      entityId: id,
      summary: `Ad-hoc ${b.method} ${b.path} on "${p.name}" → HTTP ${res.status}`,
      details: { query: b.query, body: write ? redact(b.body, secrets) : undefined },
    });
    return redact(res, secrets);
  });

  // API specifications and operations reveal a platform's endpoints: only for users with some permission on it.
  app.get('/platforms/:id/specs', async (req) => (visiblePlatform(params(req).id!), platforms.listSpecs(params(req).id!)));
  app.post('/platforms/:id/specs', { bodyLimit: LARGE_BODIES.apiSpec.bytes }, async (req) => {
    requirePlatform(params(req).id!, 'manage', 'add API specifications');
    const b = z
      .object({
        name: z.string().max(200).optional(),
        content: z.string().min(2).max(connectors.MAX_SPEC_BYTES).optional(),
        url: z.string().min(1).max(2000).optional(),
      })
      .refine((x) => x.content || x.url, 'Provide content or url')
      .parse(req.body);
    const content = b.content ?? (await connectors.fetchSpec(params(req).id!, b.url!));
    return platforms.addSpec(params(req).id!, b.name ?? '', content);
  });
  app.delete('/platforms/:id/specs/:specId', async (req) => {
    requirePlatform(params(req).id!, 'manage', 'remove API specifications');
    platforms.deleteSpec(params(req).id!, params(req).specId!);
    return { ok: true };
  });
  app.get('/specs/:specId/content', async (req, reply) => {
    const pid = platforms.specPlatformId(params(req).specId!);
    if (!pid || !platforms.getPlatform(pid).permissions.length) throw new HttpError(404, 'Spec not found');
    const c = platforms.getSpecContent(params(req).specId!);
    return reply.type(c.trim().startsWith('{') ? 'application/json' : 'text/yaml').send(c);
  });
  app.get('/platforms/:id/operations', async (req) => (visiblePlatform(params(req).id!), platforms.listOperations(params(req).id!)));

  app.get('/platforms/:id/docs', async (req) => (visiblePlatform(params(req).id!), platforms.listDocs(params(req).id!)));
  app.post('/platforms/:id/docs', async (req) => {
    const id = params(req).id!;
    requirePlatform(id, 'manage', 'add documentation');
    if (req.isMultipart()) {
      const file = await req.file();
      if (!file) throw new HttpError(400, 'No file');
      const data = await file.toBuffer();
      const title = (file.fields.title as { value?: string } | undefined)?.value ?? file.filename;
      return platforms.addDoc(id, { title, kind: 'file', filename: file.filename, mime: file.mimetype, data });
    }
    const httpUrl = z
      .string()
      .max(2000)
      .url()
      // URL.parse: an invalid URL is reported by .url(), it must not throw here
      .refine((u) => /^https?:$/.test(URL.parse(u)?.protocol ?? 'https:'), 'Only http and https links are allowed');
    const b = z
      .object({ title: z.string().max(200), kind: z.enum(['note', 'link']), content: z.string().max(200_000).optional(), url: httpUrl.optional() })
      .parse(req.body);
    return platforms.addDoc(id, b);
  });
  app.delete('/platforms/:id/docs/:docId', async (req) => {
    requirePlatform(params(req).id!, 'manage', 'remove documentation');
    platforms.deleteDoc(params(req).id!, params(req).docId!);
    return { ok: true };
  });
  app.get('/docs/:docId/file', async (req, reply) => {
    const d = platforms.getDoc(params(req).docId!);
    visiblePlatform(d.platformId);
    if (d.kind !== 'file' || !d.filename) throw new HttpError(404, 'No file');
    const data = fs.readFileSync(platforms.docPath(d.id, d.filename));
    // Uploaded files are untrusted: only PDFs, raster images and plain text open in the browser (type taken
    // from the content, not from the upload); everything else is a download that cannot run as page or script.
    const inline = inlineDocType(data, d.mime);
    const name = d.filename.replace(/["\\\r\n]/g, '');
    reply.header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${name}"`);
    reply.header('content-security-policy', "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; plugin-types application/pdf");
    return reply.type(inline ?? 'application/octet-stream').send(data);
  });

  // ---------- processes ----------
  app.get('/templates', async () => processes.listTemplates());
  app.get('/processes', async () => processes.listProcesses());
  app.post('/processes', { bodyLimit: LARGE_BODIES.definitions.bytes }, async (req) => {
    requireCapability(me(), 'createProcesses', 'create processes');
    const b = z
      .object({
        definition: z.any().optional(),
        templateId: z.string().max(200).optional(),
        text: z.string().max(MAX_DEFINITION_TEXT).optional(),
        comment: z.string().max(2000).optional(),
      })
      .parse(req.body);
    if (b.templateId) return processes.createFromTemplate(b.templateId);
    const def = b.text ? processes.parseDefinitionText(b.text) : b.definition;
    return processes.createProcess(def, { comment: b.comment ?? (b.text ? 'Imported' : 'Created') });
  });
  app.post('/processes/validate', { bodyLimit: LARGE_BODIES.definitions.bytes }, async (req) => {
    const b = z.object({ definition: z.any().optional(), text: z.string().max(MAX_DEFINITION_TEXT).optional() }).parse(req.body);
    try {
      const def = b.text !== undefined ? processes.parseDefinitionText(b.text) : b.definition;
      const r = validateProcess(def);
      return { ok: r.ok, issues: r.issues, warnings: r.warnings, definition: r.definition };
    } catch (e) {
      return { ok: false, issues: [{ path: '', message: (e as Error).message }], warnings: [] };
    }
  });
  app.post('/processes/to-yaml', { bodyLimit: LARGE_BODIES.definitions.bytes }, async (req) => {
    const b = z.object({ definition: z.any() }).parse(req.body);
    return { text: processes.toYaml(b.definition) };
  });
  app.get('/processes/:id', async (req) => {
    requireProcess(params(req).id!, 'view', 'view this process');
    const q = versionQuery.parse(req.query ?? {});
    return processes.getProcess(params(req).id!, q.version);
  });
  app.put('/processes/:id', { bodyLimit: LARGE_BODIES.definitions.bytes }, async (req) => {
    requireProcess(params(req).id!, 'edit', 'edit this process');
    const b = z.object({ definition: z.any(), comment: z.string().max(2000).optional() }).parse(req.body);
    return processes.saveProcess(params(req).id!, b.definition, b.comment ?? '');
  });
  app.put('/processes/:id/access', { config: { stepUp: { action: 'grantAccess', ...processAccess } } }, async (req) => {
    requireProcess(params(req).id!, 'manage', 'change access to this process');
    const b = z.object({ acl: z.array(z.any()).max(500), owner: z.string().max(64).nullable().optional() }).parse(req.body);
    if (b.owner && !users.findUserByName(b.owner)) throw new HttpError(400, `Unknown user "${b.owner}"`);
    return processes.setProcessAccess(params(req).id!, b);
  });
  app.delete('/processes/:id', async (req) => {
    requireProcess(params(req).id!, 'manage', 'archive this process');
    processes.archiveProcess(params(req).id!);
    return { ok: true };
  });
  app.get('/processes/:id/versions', async (req) => {
    requireProcess(params(req).id!, 'view', 'view this process');
    return processes.listVersions(params(req).id!);
  });
  app.get('/processes/:id/export', async (req, reply) => {
    requireProcess(params(req).id!, 'view', 'view this process');
    const q = versionQuery.parse(req.query ?? {});
    const p = processes.getProcess(params(req).id!, q.version);
    reply.header('content-disposition', `attachment; filename="${p.id}.yaml"`);
    return reply.type('text/yaml').send(processes.toYaml(p.definition));
  });

  // ---------- runs ----------
  app.post('/runs', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    const b = z
      .object({
        processId: z.string().max(200),
        version: z.number().int().optional(),
        inputs: boundedRecord(z.unknown(), 200).optional(),
        bindings: boundedRecord(z.string(), 100).optional(),
        dryRun: z.boolean().optional(),
      })
      .parse(req.body) as StartRunRequest;
    requireProcess(b.processId, 'run', 'run this process');
    requireBindingsUsable(b.bindings);
    return { id: await startRun(b) };
  });
  app.get('/runs', async (req) => visibleRuns(runsQuery.parse(req.query ?? {})));
  app.get('/runs/:id', async (req) => {
    requireRun(params(req).id!, 'view', 'view this run');
    const d = store.getRunDetail(params(req).id!);
    return { ...d, tasks: withDecisionRights(d.tasks) };
  });
  app.get('/runs/:id/steps/:stepId', async (req) => {
    requireRun(params(req).id!, 'view', 'view this run');
    return store.getStepFull(params(req).id!, Number(params(req).stepId));
  });
  app.post('/runs/:id/cancel', async (req) => {
    requireRun(params(req).id!, 'run', 'cancel this run');
    await cancelRun(params(req).id!);
    return { ok: true };
  });
  app.post('/runs/:id/resume', async (req) => {
    requireRun(params(req).id!, 'run', 'resume this run');
    await resumeRun(params(req).id!);
    return { ok: true };
  });
  app.get('/runs/:id/report.html', async (req, reply) => {
    const id = params(req).id!;
    requireRun(id, 'view', 'view this run');
    if ((req.query as { download?: string }).download) reply.header('content-disposition', `attachment; filename="protocol-${id}.html"`);
    return reply.type('text/html').send(runReportHtml(id));
  });
  // PDF reports (GET /runs/:id/report.pdf, POST /runs/:id/reports, …): routes/reports.ts
  app.get('/runs/:id/report.json', async (req, reply) => {
    const id = params(req).id!;
    requireRun(id, 'view', 'view this run');
    const detail = store.getRunDetail(id);
    const steps = detail.steps.map((s) => store.getStepFull(id, s.id));
    reply.header('content-disposition', `attachment; filename="protocol-${id}.json"`);
    return { ...detail, steps, audit: allAuditAscending(id), protocolHash: store.protocolHash(id) };
  });
  app.get('/artifacts/:id', async (req, reply) => {
    const a = store.artifactFile(params(req).id!);
    requireRun(a.runId, 'view', 'view this run');
    const data = fs.readFileSync(a.path);
    // the type comes from the content (screenshots are images): anything else is a download that cannot run as page or script
    const image = rasterImageType(data);
    reply.header('content-disposition', `${image ? 'inline' : 'attachment'}; filename="${a.name.replace(/[^\w.-]/g, '_')}"`);
    reply.header('content-security-policy', "sandbox; default-src 'none'");
    reply.header('x-content-type-options', 'nosniff');
    return reply.type(image ?? 'application/octet-stream').send(data);
  });

  // ---------- tasks ----------
  app.get('/tasks', async (req) => {
    const q = z.object({ status: z.string().max(100).optional(), mine: z.string().max(10).optional() }).parse(req.query ?? {});
    const list = visibleTasks(q.status);
    return q.mine ? list.filter((t) => t.canDecide) : list;
  });
  app.get('/tasks/:id', async (req) => {
    const t = visibleTasks().find((x) => x.id === params(req).id);
    if (!t) throw new HttpError(404, 'Task not found', 'TASK_NOT_FOUND');
    return t;
  });
  app.post('/tasks/:id/complete', async (req) => {
    const id = params(req).id!;
    const t = visibleTasks().find((x) => x.id === id);
    if (!t) throw new HttpError(404, 'Task not found', 'TASK_NOT_FOUND');
    if (t.manual?.stage === 'verify') throw new HttpError(409, 'This step was completed and waits for its verification', 'TASK_WAITS_FOR_VERIFICATION');
    if (!t.canDecide) throw new HttpError(403, t.cannotDecideReason ?? 'You may not decide this task', t.cannotDecideCode ?? 'FORBIDDEN', t.cannotDecideParams);
    if (t.mode === 'manual') return { ok: true, ...(await completeManualTask(id, manualCompletionSchema.parse(req.body ?? {}))) };
    const b = z
      .object({ approved: z.boolean(), selectedKeys: z.array(z.string().max(500)).max(10000).default([]), comment: z.string().max(5000).optional() })
      .parse(req.body) as TaskDecision;
    await completeTask(id, b);
    return { ok: true };
  });
  // manual steps: the second person verifies (or sends back / rejects) what the first one entered
  app.post('/tasks/:id/verify', async (req) => {
    const id = params(req).id!;
    const t = visibleTasks().find((x) => x.id === id);
    if (!t) throw new HttpError(404, 'Task not found', 'TASK_NOT_FOUND');
    if (t.mode !== 'manual' || t.manual?.stage !== 'verify') throw new HttpError(409, 'This step does not wait for a verification', 'TASK_NOT_IN_VERIFICATION');
    if (!t.canDecide) throw new HttpError(403, t.cannotDecideReason ?? 'You may not verify this step', t.cannotDecideCode ?? 'FORBIDDEN', t.cannotDecideParams);
    return { ok: true, ...(await verifyManualTask(id, verificationSchema.parse(req.body))) };
  });
  /** A manual step the current user may work on now (only they add or remove its evidence). */
  const workableStep = (id: string) => {
    const t = visibleTasks().find((x) => x.id === id);
    if (!t) throw new HttpError(404, 'Task not found', 'TASK_NOT_FOUND');
    if (t.mode !== 'manual' || t.manual?.stage !== 'work')
      throw new HttpError(409, 'Evidence can only be added while the step is being worked on', 'TASK_WAITS_FOR_VERIFICATION');
    if (!t.canDecide)
      throw new HttpError(403, t.cannotDecideReason ?? 'You may not work on this step', t.cannotDecideCode ?? 'FORBIDDEN', t.cannotDecideParams);
    return t;
  };
  app.post('/tasks/:id/evidence', async (req) => {
    const t = workableStep(params(req).id!);
    const f = await uploadedFile(req, MANUAL_LIMITS.evidenceBytes);
    return addEvidence(t, f.filename, f.data, currentActor());
  });
  app.delete('/tasks/:id/evidence/:evidenceId', async (req) => {
    const t = workableStep(params(req).id!);
    removeEvidence(t, params(req).evidenceId!, currentActor());
    return { ok: true };
  });
  app.get('/tasks/:id/evidence/:evidenceId/download', async (req, reply) => {
    // whoever may see the run may read its evidence
    const pid = store.taskProcessId(params(req).id!);
    if (!processes.permissionsFor(pid).includes('view')) throw new HttpError(404, 'Task not found', 'TASK_NOT_FOUND');
    const { e, data } = evidenceForDownload(params(req).id!, params(req).evidenceId!);
    // untrusted files: always a download, never rendered by the browser
    reply.header('content-disposition', contentDisposition(e.filename));
    reply.header('content-security-policy', "sandbox; default-src 'none'");
    reply.header('x-content-type-options', 'nosniff');
    return reply.type(downloadType(e.mime)).send(data);
  });

  // ---------- schedules ----------
  const scheduleBody = z.object({
    name: z.string().min(1).max(200),
    processId: z.string().max(200),
    cron: z.string().min(1).max(100),
    timezone: z.string().max(64).optional(),
    inputs: boundedRecord(z.unknown(), 200).default({}),
    bindings: boundedRecord(z.string(), 100).default({}),
    dryRun: z.boolean().default(false),
    enabled: z.boolean().default(true),
    allowOverlap: z.boolean().default(false),
  });
  app.get('/schedules', async () => scheduler.listSchedules());
  app.post('/schedules', async (req) => {
    const b = scheduleBody.parse(req.body);
    requireProcess(b.processId, 'run', 'schedule this process');
    requireBindingsUsable(b.bindings);
    return scheduler.saveSchedule(b);
  });
  app.put('/schedules/:id', async (req) => {
    scheduler.requireScheduleEdit(params(req).id!);
    const b = scheduleBody.parse(req.body);
    requireProcess(b.processId, 'run', 'schedule this process');
    requireBindingsUsable(b.bindings);
    return scheduler.saveSchedule(b, params(req).id);
  });
  app.delete('/schedules/:id', async (req) => {
    scheduler.requireScheduleEdit(params(req).id!);
    scheduler.deleteSchedule(params(req).id!);
    return { ok: true };
  });
  app.post('/schedules/:id/run', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    const s = scheduler.getSchedule(params(req).id!);
    requireProcess(s.processId, 'run', 'run this process');
    requireBindingsUsable(s.bindings);
    const id = await scheduler.fire(s.id, true);
    if (!id) throw new HttpError(409, 'Run was not started – see audit log');
    return { id };
  });
  app.post('/cron/preview', async (req) => {
    const b = z.object({ cron: z.string().max(100), timezone: z.string().max(64).optional() }).parse(req.body);
    return { next: scheduler.validateCron(b.cron, b.timezone) };
  });

  // ---------- audit ----------
  app.get('/audit', async (req) => {
    const q = auditQuery.parse(req.query ?? {});
    if (q.runId) requireRun(q.runId, 'view', 'view this run');
    else requireCapability(me(), 'viewAudit', 'view the audit log');
    return queryAudit(q);
  });
  // Verification against all anchors (local anchor file, SM_AUDIT_ANCHOR[_FILE], and an anchor pasted by the user).
  const verifyRoute = async (anchorText: string | undefined, via: string) => {
    requireCapability(me(), 'viewAudit', 'verify the audit log');
    const extra = anchorText?.trim() ? [parseAnchor(anchorText, 'checkpoint you entered')] : [];
    const r = await verifyWithAnchors(extra);
    const pub = verificationResult(r, null);
    audit({ action: 'audit.verified', entityType: 'audit', summary: `Audit chain verified${via}: ${r.message}`, details: pub });
    const checkpoint = r.ok ? await createCheckpoint('verify') : null;
    return verificationResult(r, checkpoint);
  };
  app.get('/audit/verify', { config: { rateLimit: ROUTE_LIMITS.heavy } }, async () => verifyRoute(undefined, ''));
  app.post('/audit/verify', { config: { rateLimit: ROUTE_LIMITS.heavy }, bodyLimit: 256 * 1024 }, async (req) =>
    verifyRoute(z.object({ anchor: z.string().max(200_000).optional() }).parse(req.body ?? {}).anchor, ' against an external checkpoint'),
  );

  app.get('/audit/anchoring', async () => {
    requireCapability(me(), 'viewAudit', 'view the audit anchoring');
    return anchoringStatus();
  });
  // where the signed checkpoints go (the evidence that the log was not changed)
  app.put('/audit/anchoring', { config: { stepUp: { action: 'changeAuditAnchoring', who: 'manageSettings' } } }, async (req) => {
    requireCapability(me(), 'manageSettings', 'change the audit anchoring');
    const b = z
      .object({ emailRecipients: z.array(z.string().max(200)).max(20), emailIntervalHours: z.number().int().min(1).max(168).optional() })
      .parse(req.body);
    saveEmailSettings({ to: b.emailRecipients, intervalHours: b.emailIntervalHours });
    return anchoringStatus();
  });
  app.post('/audit/checkpoint', { config: { rateLimit: ROUTE_LIMITS.heavy } }, async () => {
    requireCapability(me(), 'viewAudit', 'create an audit checkpoint');
    const cp = await createCheckpoint('manual');
    if (!cp) throw new HttpError(409, 'No checkpoint written – the audit chain did not verify (see the server log) or the log is empty');
    return cp;
  });
  app.get('/audit/public-key.pem', async (_req, reply) => {
    requireCapability(me(), 'viewAudit', 'export the audit signing key');
    const pub = vault().signingPublicKey();
    if (!pub) throw new HttpError(404, 'No signing key yet – unlock the vault once');
    reply.header('content-disposition', 'attachment; filename="steward-audit-public-key.pem"');
    return reply.type('application/x-pem-file').send(publicKeyPem(pub));
  });
  app.get('/audit/anchor.json', async (_req, reply) => {
    requireCapability(me(), 'viewAudit', 'export the audit anchor');
    if (!fs.existsSync(anchorFile())) throw new HttpError(404, 'No checkpoint yet');
    reply.header('content-disposition', 'attachment; filename="steward-audit-checkpoint.json"');
    return reply.type('application/json').send(fs.readFileSync(anchorFile(), 'utf8'));
  });

  // the whole audit trail leaves Steward (like an evidence pack)
  app.get('/audit/export', { config: { rateLimit: ROUTE_LIMITS.heavy, stepUp: { action: 'exportAuditLog', who: 'viewAudit' } } }, async (req, reply) => {
    requireCapability(me(), 'viewAudit', 'export the audit log');
    const format = (req.query as { format?: string }).format ?? 'jsonl';
    if (!['jsonl', 'csv', 'json'].includes(format)) throw new HttpError(400, 'format: jsonl, csv or json');
    // a fresh signed checkpoint, so the file can be checked offline (npm run audit:verify-export)
    const checkpoint = await createCheckpoint('export');
    const all = allAuditAscending();
    audit({ action: 'audit.exported', entityType: 'audit', summary: `Audit log exported (${all.length} entries, ${format})` });
    if (format === 'csv') {
      reply.header('content-disposition', 'attachment; filename="audit-log.csv"');
      return reply.type('text/csv; charset=utf-8').send(auditCsv(all));
    }
    if (format === 'json') {
      reply.header('content-disposition', 'attachment; filename="audit-log.json"');
      return reply.type('application/json').send(JSON.stringify(auditExportBundle(all, checkpoint), null, 1));
    }
    reply.header('content-disposition', 'attachment; filename="audit-log.jsonl"');
    return reply.type('application/x-ndjson').send(all.map((a) => JSON.stringify(a)).join('\n'));
  });

  // ---------- dashboard ----------
  app.get('/dashboard', async (): Promise<DashboardData> => {
    const since = new Date(Date.now() - 86400000).toISOString();
    const visible = visibleProcessIds();
    const failedChecks = db()
      .all<{ run_id: string; process_id: string; process_name: string; name: string; output: string; finished_at: string }>(
        `SELECT s.run_id, r.process_id, r.process_name, s.name, s.output, s.finished_at FROM run_steps s JOIN runs r ON r.id = s.run_id
         WHERE s.type = 'check' AND s.status = 'failed' AND s.finished_at > ? ORDER BY s.finished_at DESC LIMIT 50`,
        new Date(Date.now() - 7 * 86400000).toISOString(),
      )
      .filter((r) => visible.has(r.process_id))
      .slice(0, 20)
      .map((r) => {
        const o = JSON.parse(r.output ?? '{}') as { message?: string; severity?: string };
        return { runId: r.run_id, processName: r.process_name, name: r.name, message: o.message ?? '', severity: o.severity ?? 'error', ts: r.finished_at };
      });
    // 24 h counters from a range query (not capped by the recent-runs list)
    const last24 = db()
      .all<{ process_id: string; status: string }>('SELECT process_id, status FROM runs WHERE started_at > ?', since)
      .filter((r) => visible.has(r.process_id));
    const failed24h = last24.filter((r) => r.status === 'failed').length;
    const openTasks = visibleTasks('open').filter((t) => t.canDecide);
    // the tiles: each counted by the feature's own permission-filtered service; left out without the right
    const monitors = monitorAttention();
    const credentials = dueAttention();
    const findings = findingAttention();
    const reviews = reviewAttention();
    const attention: DashboardAttention = {
      tasks: openTasks.length,
      runs: { failed: failed24h, total: last24.length },
      ...(monitors ? { monitors } : {}),
      ...(credentials ? { credentials } : {}),
      ...(findings ? { findings } : {}),
      ...(reviews ? { reviews } : {}),
      vendorTickets: vendorAttention(),
    };
    return {
      openTasks,
      activeRuns: visibleRuns({ status: 'running,waiting,interrupted', limit: 20 }),
      recentRuns: visibleRuns({ limit: 12 }),
      failedChecks,
      upcoming: scheduler.upcoming().filter((s) => visible.has(s.processId)),
      counts: {
        platforms: platforms.listPlatforms().length,
        processes: processes.listProcesses().length,
        schedules: scheduler.listSchedules().filter((s) => s.enabled).length,
        runs24h: last24.length,
        failed24h,
      },
      attention,
      ...(isAdmin(me()) ? { setup: setupProgress() } : {}),
    };
  });

  await dashboardRoutes(app);
  await opsRoutes(app);
  await engineExtrasRoutes(app);
  await reportRoutes(app);
  await triggerRoutes(app);
  await monitorRoutes(app);
  await gatusRoutes(app);
  await credentialRoutes(app);
  await reportScheduleRoutes(app);
  await recordRoutes(app);
  await catalogueRoutes(app);
  await syncRoutes(app);
  await ticketRoutes(app);
  await dailySummaryRoutes(app);
  await complianceRoutes(app);
  await migrationRoutes(app);

  // ---------- demo ----------
  app.post('/demo/setup', { config: { rateLimit: ROUTE_LIMITS.heavy } }, async () => {
    if (!config.demo) throw new HttpError(404, 'Demo mode is not enabled (start with npm run demo)');
    if (!isAdmin(me())) throw new HttpError(403, 'Only administrators can load demo data');
    return setupDemo();
  });
}
