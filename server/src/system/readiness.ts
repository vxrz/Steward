import type { ReadinessChecks } from '@sm/shared';
import { db } from '../db.js';
import { vault } from '../vault.js';
import { nowIso } from '../util.js';
import { runAs } from '../auth/context.js';
import * as scheduler from '../scheduler.js';
import { logger } from '../log.js';
import { shuttingDown } from '../lifecycle.js';

/** A failure is logged once until the check passes again (probes ask every few seconds). */
const logged = new Map<string, string>();
function failed(check: string, e: unknown, publicMessage: string, detail: boolean): { ok: false; message: string } {
  const message = (e as Error)?.message ?? String(e);
  if (logged.get(check) !== message) {
    logged.set(check, message);
    logger.error({ err: e, check }, 'readiness check failed');
  }
  // GET /api/ready is public: the database error can name paths, hosts or SQL – administrators see it on the
  // System status page, everyone else the generic reason
  return { ok: false, message: detail ? `${publicMessage}: ${message}` : publicMessage };
}

/**
 * The checks behind GET /api/ready (also shown on the System status page). `detail`: the error messages of failed
 * checks (administrators only); otherwise a generic reason, and the detail goes to the log.
 */
export function readinessChecks(detail = false): { ready: boolean; checks: ReadinessChecks } {
  const checks: ReadinessChecks = {
    vault: { ok: false },
    database: { ok: false },
    scheduler: { ok: false },
  };
  const v = vault();
  checks.vault = v.unlocked ? { ok: true } : { ok: false, message: v.initialized ? 'Vault is locked' : 'Not set up yet' };
  try {
    db().get('SELECT 1');
    db().run('INSERT INTO engine_probe (id, ts) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET ts = excluded.ts', nowIso());
    checks.database = { ok: true };
    logged.delete('database');
  } catch (e) {
    checks.database = failed('database', e, 'Database not available', detail);
  }
  if (shuttingDown()) {
    // SIGTERM: draining (bootstrap.ts) – load balancers stop sending people here
    checks.scheduler = { ok: false, message: 'Shutting down' };
    return { ready: false, checks };
  }
  try {
    // schedules are armed once the vault is unlocked
    const all = runAs({ id: 'system', username: 'system', displayName: 'System', roles: ['admin'], teams: [] }, () => scheduler.listSchedules());
    const enabled = all.filter((s) => s.enabled);
    const armed = enabled.filter((s) => s.nextRunAt).length;
    checks.scheduler =
      enabled.length === 0 || armed > 0
        ? { ok: true, message: `${armed} of ${enabled.length} enabled schedule(s) armed` }
        : { ok: false, message: `None of ${enabled.length} enabled schedule(s) is armed` };
    logged.delete('scheduler');
  } catch (e) {
    checks.scheduler = failed('scheduler', e, 'Schedules could not be read', detail);
  }
  return { ready: Object.values(checks).every((c) => c.ok), checks };
}
