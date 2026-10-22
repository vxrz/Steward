import fs from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ROLES,
  validateProcess,
  type AuthStatus,
  type DashboardData,
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
import { audit, queryAudit, verifyAudit, allAuditAscending, flushPendingAudit } from '../audit.js';
import { getSettings, updateSettings } from '../settings.js';
import { HttpError } from '../util.js';
import { db } from '../db.js';
import * as platforms from '../platforms/service.js';
import * as connectors from '../platforms/connectors.js';
import { platformRequest, secretValues } from '../platforms/http.js';
import * as processes from '../processes/service.js';
import * as store from '../engine/store.js';
import { startRun, cancelRun, resumeRun, completeTask, recoverRuns } from '../engine/runner.js';
import { browserAvailable } from '../engine/browser.js';
import * as scheduler from '../scheduler.js';
import { runReportHtml, runReportPdf } from '../reports.js';
import { setupDemo } from './demo.js';
import { dashboardRoutes } from './dashboards.js';
import { opsRoutes } from './ops.js';
import { engineExtrasRoutes } from './engine-extras.js';
import { currentUser, runAs, type AuthUser } from '../auth/context.js';
import * as users from '../auth/users.js';
import * as sso from '../auth/sso.js';
import { capabilities, decisionCheck, isAdmin, require, requireCapability } from '../auth/permissions.js';
import { readCookie, sessionCookie, SESSION_COOKIE } from '../auth/cookies.js';
import { BRAND } from '@sm/shared';

let started = false;
/** Things that need the decrypted vault: pending audit entries, scheduler, recovery of waiting runs. */
async function onUnlocked(): Promise<void> {
  flushPendingAudit();
  if (started) return;
  started = true;
  await recoverRuns();
  scheduler.startScheduler();
}

export async function unlockFromEnv(): Promise<void> {
  if (config.masterPassphrase && vault().initialized && !vault().unlocked) {
    vault().unlock(config.masterPassphrase);
    audit({ actor: 'system', action: 'vault.unlocked', entityType: 'vault', summary: 'Vault unlocked from SM_MASTER_PASSPHRASE at startup' });
    await onUnlocked();
  }
}

const platformBody = z.object({
  name: z.string().min(1),
  kind: z.string().optional(),
  description: z.string().optional(),
  baseUrl: z.string().optional(),
  environment: z.string().optional(),
  config: z.any().optional(),
  secrets: z.record(z.string()).optional(),
});

// ---------- helpers ----------

const me = (): AuthUser => {
  const u = currentUser();
  if (!u) throw new HttpError(401, 'Please sign in');
  return u;
};

function meInfo(): Me | null {
  const u = currentUser();
  if (!u) return null;
  return { user: users.getUser(u.id), capabilities: capabilities(u) };
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

function requirePlatform(id: string, perm: 'use' | 'manage', what: string) {
  const p = platforms.getPlatform(id);
  require(p.permissions, perm, what);
  return p;
}

function requireBindingsUsable(bindings: Record<string, string> | undefined) {
  for (const pid of Object.values(bindings ?? {})) requirePlatform(pid, 'use', `use platform ${pid}`);
}

const visibleProcessIds = (): Set<string> =>
  new Set(db().all<{ id: string }>('SELECT id FROM processes').map((r) => r.id).filter((id) => processes.permissionsFor(id).includes('view')));

function withDecisionRights(tasks: TaskRecord[]): TaskRecord[] {
  const permCache = new Map<string, ReturnType<typeof processes.permissionsFor>>();
  return tasks.map((t) => {
    const pid = store.taskProcessId(t.id);
    if (!permCache.has(pid)) permCache.set(pid, processes.permissionsFor(pid));
    const check = decisionCheck(currentUser(), t, { actor: t.startedBy ?? '' }, permCache.get(pid)!);
    return { ...t, canDecide: check.ok, cannotDecideReason: check.reason };
  });
}

function visibleTasks(status?: string): TaskRecord[] {
  const visible = visibleProcessIds();
  return withDecisionRights(store.listTasks({ status }).filter((t) => visible.has(store.taskProcessId(t.id))));
}

function visibleRuns(f: Parameters<typeof store.listRuns>[0]): RunSummary[] {
  const visible = visibleProcessIds();
  const limit = f.limit ?? 100;
  return store.listRuns({ ...f, limit: limit * 3 }).filter((r) => visible.has(r.processId)).slice(0, limit);
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
    passwordLogin: getSettings().passwordLogin,
    demo: config.demo,
    version: config.version,
    browserAvailable: await browserAvailable(),
  });
  app.get('/auth/status', status);
  app.get('/vault/status', async () => {
    const s = await status();
    return { ...s, operator: s.me?.user.displayName };
  });

  app.post('/auth/setup', async (req, reply) => {
    const b = z
      .object({ passphrase: z.string().min(8), username: z.string().min(2), displayName: z.string().optional(), password: z.string() })
      .parse(req.body);
    if (users.countUsers() > 0) throw new HttpError(409, 'Setup has already been completed');
    if (vault().initialized) vault().unlock(b.passphrase);
    else vault().setup(b.passphrase);
    const { user } = users.createUser({ username: b.username, displayName: b.displayName, roles: ['admin'], password: b.password });
    runAs(users.toAuthUser(user), () =>
      audit({ action: 'vault.initialized', entityType: 'vault', summary: `${BRAND.name} set up by ${user.username} (first administrator)` }),
    );
    const { token } = users.login(b.username, b.password, { ip: req.ip, userAgent: req.headers['user-agent'] });
    reply.header('set-cookie', sessionCookie(token));
    await onUnlocked();
    return { ok: true };
  });

  app.post('/auth/login', async (req, reply) => {
    const b = z.object({ username: z.string(), password: z.string() }).parse(req.body);
    const { token, user } = users.login(b.username.trim(), b.password, { ip: req.ip, userAgent: req.headers['user-agent'] });
    reply.header('set-cookie', sessionCookie(token));
    return { user, capabilities: capabilities(users.toAuthUser(user)) } satisfies Me;
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
  const ssoFail = (reply: import('fastify').FastifyReply, message: string) =>
    reply.redirect(`/?sso_error=${encodeURIComponent(message.slice(0, 300))}`);

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
      const { token, returnTo } = await sso.finishSignIn(current, { ip: req.ip, userAgent: req.headers['user-agent'] });
      reply.header('set-cookie', sessionCookie(token));
      // A same-site page hop (instead of a 302) so the SameSite=Strict session cookie is used right away.
      const target = JSON.stringify(returnTo).replace(/</g, '\\u003c');
      return reply
        .type('text/html')
        .send(`<!doctype html><meta charset="utf-8"><title>Signing in…</title><p>Signing in…</p><script>location.replace(${target})</script>`);
    } catch (e) {
      return ssoFail(reply, (e as Error).message);
    }
  });

  app.get('/sso/providers', async () => {
    requireCapability(me(), 'manageUsers', 'manage single sign-on');
    return sso.listProviders();
  });
  app.post('/sso/providers', async (req) => {
    requireCapability(me(), 'manageUsers', 'manage single sign-on');
    return sso.saveProvider(req.body as never);
  });
  app.put('/sso/providers/:id', async (req) => {
    requireCapability(me(), 'manageUsers', 'manage single sign-on');
    sso.getProvider(params(req).id!);
    return sso.saveProvider(req.body as never, params(req).id);
  });
  app.delete('/sso/providers/:id', async (req) => {
    requireCapability(me(), 'manageUsers', 'manage single sign-on');
    sso.deleteProvider(params(req).id!);
    return { ok: true };
  });
  app.post('/sso/discover', async (req) => {
    requireCapability(me(), 'manageUsers', 'manage single sign-on');
    return sso.discover(z.object({ issuer: z.string().url() }).parse(req.body).issuer);
  });
  app.get('/sso/redirect-uri', async (req) => ({ redirectUri: sso.redirectUriFor(req) }));

  app.post('/auth/password', async (req) => {
    const b = z.object({ current: z.string(), next: z.string() }).parse(req.body);
    users.changePassword(me().id, b.current, b.next);
    return { ok: true };
  });

  app.post('/vault/unlock', async (req) => {
    if (!isAdmin(me())) throw new HttpError(403, 'Only administrators can unlock the vault');
    const b = z.object({ passphrase: z.string() }).parse(req.body);
    vault().unlock(b.passphrase);
    audit({ action: 'vault.unlocked', entityType: 'vault', summary: `Vault unlocked by ${me().username}` });
    await onUnlocked();
    return { ok: true };
  });

  app.post('/vault/lock', async () => {
    if (!isAdmin(me())) throw new HttpError(403, 'Only administrators can lock the vault');
    if (vault().unlocked) {
      audit({ action: 'vault.locked', entityType: 'vault', summary: `Vault locked by ${me().username}` });
      scheduler.stopScheduler();
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
  app.post('/users', async (req) => {
    requireCapability(me(), 'manageUsers', 'manage users');
    const b = z
      .object({
        username: z.string(),
        displayName: z.string().optional(),
        email: z.string().optional(),
        roles: z.array(z.enum(ROLES)).default([]),
        password: z.string().optional(),
      })
      .parse(req.body);
    return users.createUser({ ...b, mustChangePassword: true });
  });
  app.put('/users/:id', async (req) => {
    requireCapability(me(), 'manageUsers', 'manage users');
    const b = z
      .object({ displayName: z.string().optional(), email: z.string().optional(), roles: z.array(z.enum(ROLES)).optional(), active: z.boolean().optional() })
      .parse(req.body);
    return users.updateUser(params(req).id!, b);
  });
  app.post('/users/:id/reset-password', async (req) => {
    requireCapability(me(), 'manageUsers', 'manage users');
    return { temporaryPassword: users.resetPassword(params(req).id!) };
  });
  app.get('/teams', async () => users.listTeams());
  const teamBody = z.object({ name: z.string(), description: z.string().optional(), members: z.array(z.string()).optional() });
  app.post('/teams', async (req) => {
    requireCapability(me(), 'manageUsers', 'manage teams');
    return users.saveTeam(teamBody.parse(req.body));
  });
  app.put('/teams/:id', async (req) => {
    requireCapability(me(), 'manageUsers', 'manage teams');
    return users.saveTeam(teamBody.parse(req.body), params(req).id);
  });
  app.delete('/teams/:id', async (req) => {
    requireCapability(me(), 'manageUsers', 'manage teams');
    users.deleteTeam(params(req).id!);
    return { ok: true };
  });
  app.get('/subjects', async (): Promise<Subject[]> => [
    ...users
      .listUsers()
      .filter((u: UserInfo) => u.active)
      .map((u) => ({ value: `user:${u.username.toLowerCase()}`, label: `${u.displayName} (${u.username})`, kind: 'user' as const })),
    ...users.listTeams().map((t) => ({ value: `team:${t.name.toLowerCase()}`, label: `Team ${t.name}`, kind: 'team' as const })),
    ...ROLES.map((r) => ({ value: `role:${r}`, label: `Everyone with role ${r}`, kind: 'role' as const })),
  ]);

  // ---------- settings ----------
  app.get('/settings', async () => getSettings());
  app.put('/settings', async (req) => {
    requireCapability(me(), 'manageSettings', 'change settings');
    const b = z
      .object({
        passwordLogin: z.enum(['all', 'adminsOnly']).optional(),
        browserHeadless: z.boolean().optional(),
        browserTimeoutMs: z.number().int().min(1000).optional(),
        retentionRunDays: z.number().int().min(0).max(3650).optional(),
        retentionNotificationDays: z.number().int().min(1).max(3650).optional(),
      })
      .parse(req.body);
    if (b.passwordLogin === 'adminsOnly' && !sso.publicProviders().length) throw new HttpError(400, 'Enable a single sign-on provider before turning off password sign-in');
    const s = updateSettings(b);
    audit({ action: 'settings.updated', entityType: 'settings', summary: 'Settings updated', details: b });
    return s;
  });

  // ---------- platforms ----------
  app.get('/platform-presets', async () => connectors.listPresets());
  app.post('/platform-types', async (req) => {
    requireCapability(me(), 'createPlatforms', 'create connector types');
    const b = z.object({ fromPlatformId: z.string(), kind: z.string().optional(), label: z.string().optional(), description: z.string().optional() }).parse(req.body);
    requirePlatform(b.fromPlatformId, 'manage', 'use this platform as a template');
    return connectors.createTypeFromPlatform(b.fromPlatformId, b);
  });
  app.post('/platform-types/import', async (req) => {
    requireCapability(me(), 'createPlatforms', 'import connector types');
    return connectors.importType(z.object({ package: z.any() }).parse(req.body).package);
  });
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
  app.get('/platforms', async () => platforms.listPlatforms());
  app.post('/platforms', async (req) => {
    requireCapability(me(), 'createPlatforms', 'add platforms');
    return connectors.createPlatformFromType(platformBody.extend({ typeKind: z.string().optional() }).parse(req.body));
  });
  app.get('/platforms/:id', async (req) => platforms.getPlatform(params(req).id!));
  app.put('/platforms/:id', async (req) => {
    requirePlatform(params(req).id!, 'manage', 'change this platform');
    return platforms.updatePlatform(params(req).id!, platformBody.partial().parse(req.body));
  });
  app.put('/platforms/:id/access', async (req) => {
    requirePlatform(params(req).id!, 'manage', 'change access to this platform');
    return platforms.setPlatformAccess(params(req).id!, z.object({ acl: z.array(z.any()) }).parse(req.body).acl);
  });
  app.delete('/platforms/:id', async (req) => {
    requirePlatform(params(req).id!, 'manage', 'delete this platform');
    platforms.deletePlatform(params(req).id!);
    return { ok: true };
  });
  app.put('/platforms/:id/secrets', async (req) => {
    requirePlatform(params(req).id!, 'manage', 'change credentials of this platform');
    return platforms.setSecrets(params(req).id!, z.record(z.string().nullable()).parse(req.body));
  });

  app.post('/platforms/:id/test', async (req) => {
    const id = params(req).id!;
    const p = requirePlatform(id, 'use', 'use this platform');
    const secrets = platforms.getSecrets(id);
    const testPath = p.config.testPath || '/';
    try {
      const res = await platformRequest(p, secrets, { method: 'GET', url: testPath });
      const ok = res.status >= 200 && res.status < 400;
      audit({ action: 'platform.tested', entityType: 'platform', entityId: id, summary: `Connection test "${p.name}": GET ${testPath} → HTTP ${res.status} (${res.durationMs} ms)` });
      return { ok, status: res.status, durationMs: res.durationMs, message: ok ? 'Connection works' : `HTTP ${res.status}`, body: redact(res.body, secrets) };
    } catch (e) {
      const message = redact((e as Error).message, secrets) as string;
      audit({ action: 'platform.tested', entityType: 'platform', entityId: id, summary: `Connection test "${p.name}" failed: ${message.slice(0, 200)}` });
      return { ok: false, status: 0, durationMs: 0, message };
    }
  });

  app.post('/platforms/:id/request', async (req) => {
    const id = params(req).id!;
    const b = z
      .object({
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']),
        path: z.string().min(1),
        query: z.record(z.string()).optional(),
        headers: z.record(z.string()).optional(),
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

  app.get('/platforms/:id/specs', async (req) => platforms.listSpecs(params(req).id!));
  app.post('/platforms/:id/specs', async (req) => {
    requirePlatform(params(req).id!, 'manage', 'add API specifications');
    const b = z
      .object({ name: z.string().optional(), content: z.string().min(2).optional(), url: z.string().min(1).optional() })
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
    const c = platforms.getSpecContent(params(req).specId!);
    return reply.type(c.trim().startsWith('{') ? 'application/json' : 'text/yaml').send(c);
  });
  app.get('/platforms/:id/operations', async (req) => platforms.listOperations(params(req).id!));

  app.get('/platforms/:id/docs', async (req) => platforms.listDocs(params(req).id!));
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
    const b = z.object({ title: z.string(), kind: z.enum(['note', 'link']), content: z.string().optional(), url: z.string().url().optional() }).parse(req.body);
    return platforms.addDoc(id, b);
  });
  app.delete('/platforms/:id/docs/:docId', async (req) => {
    requirePlatform(params(req).id!, 'manage', 'remove documentation');
    platforms.deleteDoc(params(req).id!, params(req).docId!);
    return { ok: true };
  });
  app.get('/docs/:docId/file', async (req, reply) => {
    const d = platforms.getDoc(params(req).docId!);
    if (d.kind !== 'file' || !d.filename) throw new HttpError(404, 'No file');
    reply.header('content-disposition', `inline; filename="${d.filename.replace(/"/g, '')}"`);
    return reply.type(d.mime || 'application/octet-stream').send(fs.readFileSync(platforms.docPath(d.id, d.filename)));
  });

  // ---------- processes ----------
  app.get('/templates', async () => processes.listTemplates());
  app.get('/processes', async () => processes.listProcesses());
  app.post('/processes', async (req) => {
    requireCapability(me(), 'createProcesses', 'create processes');
    const b = z.object({ definition: z.any().optional(), templateId: z.string().optional(), text: z.string().optional(), comment: z.string().optional() }).parse(req.body);
    if (b.templateId) return processes.createFromTemplate(b.templateId);
    const def = b.text ? processes.parseDefinitionText(b.text) : b.definition;
    return processes.createProcess(def, { comment: b.comment ?? (b.text ? 'Imported' : 'Created') });
  });
  app.post('/processes/validate', async (req) => {
    const b = z.object({ definition: z.any().optional(), text: z.string().optional() }).parse(req.body);
    try {
      const def = b.text !== undefined ? processes.parseDefinitionText(b.text) : b.definition;
      const r = validateProcess(def);
      return { ok: r.ok, issues: r.issues, warnings: r.warnings, definition: r.definition };
    } catch (e) {
      return { ok: false, issues: [{ path: '', message: (e as Error).message }], warnings: [] };
    }
  });
  app.post('/processes/to-yaml', async (req) => {
    const b = z.object({ definition: z.any() }).parse(req.body);
    return { text: processes.toYaml(b.definition) };
  });
  app.get('/processes/:id', async (req) => {
    requireProcess(params(req).id!, 'view', 'view this process');
    const q = req.query as { version?: string };
    return processes.getProcess(params(req).id!, q.version ? Number(q.version) : undefined);
  });
  app.put('/processes/:id', async (req) => {
    requireProcess(params(req).id!, 'edit', 'edit this process');
    const b = z.object({ definition: z.any(), comment: z.string().optional() }).parse(req.body);
    return processes.saveProcess(params(req).id!, b.definition, b.comment ?? '');
  });
  app.put('/processes/:id/access', async (req) => {
    requireProcess(params(req).id!, 'manage', 'change access to this process');
    const b = z.object({ acl: z.array(z.any()), owner: z.string().nullable().optional() }).parse(req.body);
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
    const q = req.query as { version?: string };
    const p = processes.getProcess(params(req).id!, q.version ? Number(q.version) : undefined);
    reply.header('content-disposition', `attachment; filename="${p.id}.yaml"`);
    return reply.type('text/yaml').send(processes.toYaml(p.definition));
  });

  // ---------- runs ----------
  app.post('/runs', async (req) => {
    const b = z
      .object({
        processId: z.string(),
        version: z.number().int().optional(),
        inputs: z.record(z.unknown()).optional(),
        bindings: z.record(z.string()).optional(),
        dryRun: z.boolean().optional(),
      })
      .parse(req.body) as StartRunRequest;
    requireProcess(b.processId, 'run', 'run this process');
    requireBindingsUsable(b.bindings);
    return { id: await startRun(b) };
  });
  app.get('/runs', async (req) => {
    const q = req.query as { processId?: string; status?: string; scheduleId?: string; limit?: string; before?: string };
    return visibleRuns({ ...q, limit: q.limit ? Number(q.limit) : undefined });
  });
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
  app.get('/runs/:id/report.pdf', async (req, reply) => {
    const id = params(req).id!;
    requireRun(id, 'view', 'view this run');
    const pdf = await runReportPdf(id);
    audit({ action: 'run.report_exported', entityType: 'run', entityId: id, runId: id, summary: 'Run protocol exported as PDF' });
    reply.header('content-disposition', `attachment; filename="protocol-${id}.pdf"`);
    return reply.type('application/pdf').send(pdf);
  });
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
    return reply.type(a.mime).send(fs.readFileSync(a.path));
  });

  // ---------- tasks ----------
  app.get('/tasks', async (req) => {
    const q = req.query as { status?: string; mine?: string };
    const list = visibleTasks(q.status);
    return q.mine ? list.filter((t) => t.canDecide) : list;
  });
  app.get('/tasks/:id', async (req) => {
    const t = visibleTasks().find((x) => x.id === params(req).id);
    if (!t) throw new HttpError(404, 'Task not found');
    return t;
  });
  app.post('/tasks/:id/complete', async (req) => {
    const id = params(req).id!;
    const t = visibleTasks().find((x) => x.id === id);
    if (!t) throw new HttpError(404, 'Task not found');
    if (!t.canDecide) throw new HttpError(403, t.cannotDecideReason ?? 'You may not decide this task');
    const b = z.object({ approved: z.boolean(), selectedKeys: z.array(z.string()).default([]), comment: z.string().optional() }).parse(req.body) as TaskDecision;
    await completeTask(id, b);
    return { ok: true };
  });

  // ---------- schedules ----------
  const scheduleBody = z.object({
    name: z.string().min(1),
    processId: z.string(),
    cron: z.string().min(1),
    timezone: z.string().optional(),
    inputs: z.record(z.unknown()).default({}),
    bindings: z.record(z.string()).default({}),
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
  app.post('/schedules/:id/run', async (req) => {
    const s = scheduler.getSchedule(params(req).id!);
    requireProcess(s.processId, 'run', 'run this process');
    requireBindingsUsable(s.bindings);
    const id = await scheduler.fire(s.id, true);
    if (!id) throw new HttpError(409, 'Run was not started – see audit log');
    return { id };
  });
  app.post('/cron/preview', async (req) => {
    const b = z.object({ cron: z.string(), timezone: z.string().optional() }).parse(req.body);
    return { next: scheduler.validateCron(b.cron, b.timezone) };
  });

  // ---------- audit ----------
  app.get('/audit', async (req) => {
    const q = req.query as Record<string, string>;
    if (q.runId) requireRun(q.runId, 'view', 'view this run');
    else requireCapability(me(), 'viewAudit', 'view the audit log');
    return queryAudit({ ...q, beforeSeq: q.beforeSeq ? Number(q.beforeSeq) : undefined, limit: q.limit ? Number(q.limit) : undefined });
  });
  app.get('/audit/verify', async () => {
    requireCapability(me(), 'viewAudit', 'verify the audit log');
    const r = verifyAudit();
    audit({ action: 'audit.verified', entityType: 'audit', summary: `Audit chain verified: ${r.message}`, details: r });
    return r;
  });
  app.get('/audit/export', async (req, reply) => {
    requireCapability(me(), 'viewAudit', 'export the audit log');
    const format = (req.query as { format?: string }).format ?? 'jsonl';
    const all = allAuditAscending();
    audit({ action: 'audit.exported', entityType: 'audit', summary: `Audit log exported (${all.length} entries, ${format})` });
    if (format === 'csv') {
      const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const lines = ['seq,ts,actor,action,entityType,entityId,runId,summary,hash'].concat(
        all.map((a) => [a.seq, a.ts, a.actor, a.action, a.entityType, a.entityId, a.runId, a.summary, a.hash].map(cell).join(',')),
      );
      reply.header('content-disposition', 'attachment; filename="audit-log.csv"');
      return reply.type('text/csv').send(lines.join('\n'));
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
    const recent = visibleRuns({ limit: 200 });
    return {
      openTasks: visibleTasks('open').filter((t) => t.canDecide),
      activeRuns: visibleRuns({ status: 'running,waiting,interrupted', limit: 20 }),
      recentRuns: recent.slice(0, 12),
      failedChecks,
      upcoming: scheduler.upcoming().filter((s) => visible.has(s.processId)),
      counts: {
        platforms: platforms.listPlatforms().length,
        processes: processes.listProcesses().length,
        schedules: scheduler.listSchedules().filter((s) => s.enabled).length,
        runs24h: recent.filter((r) => r.startedAt > since).length,
        failed24h: recent.filter((r) => r.startedAt > since && r.status === 'failed').length,
      },
    };
  });

  await dashboardRoutes(app);
  await opsRoutes(app);
  await engineExtrasRoutes(app);

  // ---------- demo ----------
  app.post('/demo/setup', async () => {
    if (!config.demo) throw new HttpError(404, 'Demo mode is not enabled (start with npm run demo)');
    if (!isAdmin(me())) throw new HttpError(403, 'Only administrators can load demo data');
    return setupDemo();
  });
}
