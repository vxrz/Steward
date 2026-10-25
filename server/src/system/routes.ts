import os from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { AboutInfo, SystemStatus, UpdateNotice } from '@sm/shared';
import { config } from '../config.js';
import { db, databaseLabel } from '../db.js';
import { vault } from '../vault.js';
import { getSettings, passwordLoginFromEnv, readSetting } from '../settings.js';
import { currentUser, runAs } from '../auth/context.js';
import { isAdmin } from '../auth/permissions.js';
import * as scheduler from '../scheduler.js';
import { engineRunning } from '../monitors/engine.js';
import { getNotificationSettings } from '../notifications/settings.js';
import { errorReportingEnabled, errorReportingSettings } from '../errorReporting.js';
import { tracingEnabled } from '../telemetry.js';
import { publicApiStatus } from '../api/v1/config.js';
import { HttpError, nowIso } from '../util.js';
import { buildInfo, deploymentKind } from '../buildinfo.js';
import { readinessChecks } from './readiness.js';
import { dismissUpdateNotice, updateNoticeFor } from './update-notice.js';
import { z } from 'zod';

/**
 *   GET /api/about          signed-in users: version and build of the server
 *   GET /api/system/status  administrators (full) and auditors (limited: no paths, hosts or connection details)
 *   GET /api/system/update-notice, POST /api/system/update-notice/dismiss
 *                           administrators: the notice after an update (it names the backup copy's path)
 */

const SYSTEM = { id: 'system', username: 'system', displayName: 'System', roles: ['admin' as const], teams: [] };

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function systemStatus(full: boolean): SystemStatus {
  const { ready, checks } = readinessChecks();
  const settings = getSettings();
  const schedules = safe(() => runAs(SYSTEM, () => scheduler.listSchedules()), []);
  const enabled = schedules.filter((s) => s.enabled);
  const next = enabled
    .filter((s) => s.nextRunAt)
    .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))
    .slice(0, 5)
    .map((s) => ({ id: s.id, name: s.name, nextRunAt: s.nextRunAt! }));
  const monitors = safe(
    () =>
      db().get<{ total: number; enabled: number }>(
        'SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END), 0) AS enabled FROM monitors WHERE is_template = 0',
      )!,
    { total: 0, enabled: 0 },
  );
  const checkStats = safe(() => db().get<{ n: number; last: string | null }>('SELECT COUNT(*) AS n, MAX(last_checked_at) AS last FROM monitor_checks')!, {
    n: 0,
    last: null,
  });
  const down = safe(() => db().get<{ n: number }>("SELECT COUNT(*) AS n FROM monitor_state WHERE status = 'down'")!.n, 0);
  const notifications = safe(() => getNotificationSettings(), null);
  const er = errorReportingSettings();
  const api = publicApiStatus();
  const mem = process.memoryUsage();
  const extraHosts = (process.env.SM_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  const proxy = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some((k) => !!process.env[k]);
  return {
    generatedAt: nowIso(),
    view: full ? 'full' : 'limited',
    build: buildInfo(),
    deployment: deploymentKind(),
    ready,
    checks,
    vault: { initialized: vault().initialized, unlocked: vault().unlocked, unattendedUnlock: !!config.masterPassphrase },
    database: {
      kind: config.database.kind === 'sqlite' ? 'sqlite' : 'postgres',
      sizeBytes: safe(() => db().sizeBytes(), null),
      ...(full ? { location: databaseLabel() } : {}),
    },
    scheduler: { total: schedules.length, enabled: enabled.length, armed: enabled.filter((s) => s.nextRunAt).length, next },
    monitors: {
      engineRunning: engineRunning(),
      total: Number(monitors.total) || 0,
      enabled: Number(monitors.enabled) || 0,
      checks: Number(checkStats.n) || 0,
      down: Number(down) || 0,
      lastCheckAt: checkStats.last,
    },
    notifications: {
      email: !!notifications?.email.enabled && !!notifications.email.host,
      teams: !!notifications?.teams.enabled && notifications.teams.hasWebhookUrl,
      webhook: !!notifications?.webhook.enabled && notifications.webhook.hasUrl,
    },
    errorReporting: { server: errorReportingEnabled(), browser: !!er.webDsn, ...(full ? { environment: er.environment } : {}) },
    tracing: { enabled: tracingEnabled() },
    metrics: { access: process.env.SM_METRICS_PUBLIC === '1' ? 'public' : 'adminsAndAuditors' },
    publicApi: { enabled: api.enabled, basePath: api.basePath, docs: api.docs, rateLimitPerMinute: api.rateLimitPerMinute, apiVersion: api.apiVersion },
    retention: {
      runDays: settings.retentionRunDays ?? 0,
      notificationDays: settings.retentionNotificationDays ?? 30,
      monitorDays: settings.retentionMonitorDays ?? 30,
      lastCleanup: readSetting<SystemStatus['retention']['lastCleanup']>('maintenance.lastCleanup', null),
    },
    security: {
      tls: !!config.tls,
      passwordLogin: settings.passwordLogin,
      passwordLoginFromEnv: !!passwordLoginFromEnv(),
      ...(settings.passwordLoginPending ? { passwordLoginPending: settings.passwordLoginPending } : {}),
      ...(full
        ? {
            allowedHosts: extraHosts,
            proxyFromEnvironment: proxy,
            emergencyWindowsOpen: safe(
              () =>
                Number(
                  db().get<{ n: number }>(
                    'SELECT COUNT(*) AS n FROM emergency_access_grants WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > ?',
                    nowIso(),
                  )!.n,
                ),
              0,
            ),
          }
        : {}),
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpus: safe(() => os.availableParallelism(), 1),
      uptimeSeconds: Math.round(process.uptime()),
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      ...(full ? { dataDir: config.dataDir, hostname: os.hostname(), pid: process.pid } : {}),
    },
  };
}

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/about', async (): Promise<AboutInfo> => {
    if (!currentUser()) throw new HttpError(401, 'Please sign in', 'NOT_SIGNED_IN');
    return { build: buildInfo() };
  });

  app.get('/api/system/status', async (_req, reply) => {
    const u = currentUser();
    if (!u) throw new HttpError(401, 'Please sign in', 'NOT_SIGNED_IN');
    const full = isAdmin(u);
    if (!full && !u.roles.includes('auditor')) throw new HttpError(403, 'The system status is available to administrators and auditors', 'FORBIDDEN');
    reply.header('cache-control', 'no-store');
    return systemStatus(full);
  });

  const requireAdmin = () => {
    const u = currentUser();
    if (!u) throw new HttpError(401, 'Please sign in', 'NOT_SIGNED_IN');
    if (!isAdmin(u)) throw new HttpError(403, 'The update notice is available to administrators', 'FORBIDDEN');
    return u;
  };

  app.get('/api/system/update-notice', async (_req, reply): Promise<{ notice: UpdateNotice | null }> => {
    const u = requireAdmin();
    reply.header('cache-control', 'no-store');
    return { notice: updateNoticeFor(u.id) };
  });

  const dismissBody = z.object({ id: z.string().min(1).max(64) }).strict();
  app.post('/api/system/update-notice/dismiss', async (req) => {
    const u = requireAdmin();
    const { id } = dismissBody.parse(req.body);
    if (!dismissUpdateNotice(u, id)) throw new HttpError(404, 'This update notice no longer exists', 'UPDATE_NOTICE_NOT_FOUND');
    return { ok: true };
  });
}
