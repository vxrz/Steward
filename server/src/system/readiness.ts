import type { ReadinessChecks } from '@sm/shared';
import { db } from '../db.js';
import { vault } from '../vault.js';
import { nowIso } from '../util.js';
import { runAs } from '../auth/context.js';
import * as scheduler from '../scheduler.js';

/** The checks behind GET /api/ready (also shown on the System status page). */
export function readinessChecks(): { ready: boolean; checks: ReadinessChecks } {
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
  } catch (e) {
    checks.database = { ok: false, message: (e as Error).message };
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
  } catch (e) {
    checks.scheduler = { ok: false, message: (e as Error).message };
  }
  return { ready: Object.values(checks).every((c) => c.ok), checks };
}
