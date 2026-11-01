import type { FastifyInstance } from 'fastify';
import type { DashboardAttention, DashboardData, DashboardSetup } from '@sm/shared';
import { db } from '../db.js';
import * as platforms from '../platforms/service.js';
import * as processes from '../processes/service.js';
import * as store from '../engine/store.js';
import * as scheduler from '../scheduler.js';
import { findingAttention } from '../compliance/reconciliation.js';
import { monitorAttention } from '../monitors/service.js';
import { dueAttention } from '../credentials/service.js';
import { vendorAttention } from '../tickets/service.js';
import { reviewAttention } from '../records/documents.js';
import { dutyAttention } from '../duties/service.js';
import { scorecardAttention } from '../scorecard/scorecard.js';
import * as users from '../auth/users.js';
import { isAdmin } from '../auth/permissions.js';
import { me } from '../auth/access.js';
import { visibleProcessIds, visibleTasks, visibleRuns } from './helpers.js';

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

/** The start page dashboard (mounted under /api). */
export async function dashboardHomeRoutes(app: FastifyInstance): Promise<void> {
  // ---------- dashboard ----------
  app.get('/dashboard', async (): Promise<DashboardData> => {
    const since = new Date(Date.now() - 86400000).toISOString();
    const visible = visibleProcessIds();
    const failedChecks = store.failedCheckGroups((id) => visible.has(id));
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
    const duties = dutyAttention();
    const scorecard = scorecardAttention();
    const attention: DashboardAttention = {
      tasks: openTasks.length,
      runs: { failed: failed24h, total: last24.length },
      ...(monitors ? { monitors } : {}),
      ...(credentials ? { credentials } : {}),
      ...(findings ? { findings } : {}),
      ...(reviews ? { reviews } : {}),
      ...(duties ? { duties } : {}),
      ...(scorecard ? { scorecard } : {}),
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
}
