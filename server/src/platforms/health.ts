import { z } from 'zod';
import { PLATFORM_HEALTH_INTERVALS, type PlatformHealth } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { nowIso, parseJson } from '../util.js';
import { listUsers, toAuthUser } from '../auth/users.js';
import { platformPermissions } from '../auth/permissions.js';
import { me } from '../auth/access.js';
import { getConnection, getPlatform } from './service.js';
import { runConnectionTest } from './testConnection.js';

/**
 * Platform health (v0.4.0): the latest connection test of a platform, shown on its page, and an optional periodic
 * connection test (off by default; an interval per platform). The periodic test is the same as "Test connection" and
 * writes the same audit entry; when it starts failing, the platform's managers are notified once (event
 * platform.failing, routed like every other notification) – again only after it passed in between.
 */

interface HealthRow {
  platform_id: string;
  enabled: number;
  interval_minutes: number;
  last_run_at: string | null;
  failing_since: string | null;
  notified_at: string | null;
  updated_by: string | null;
  updated_at: string | null;
}

const row = (id: string) => db().get<HealthRow>('SELECT * FROM platform_health WHERE platform_id = ?', id);

/** The latest `platform.tested` entry of a platform: when, whether it passed, the message and who ran it. */
export function lastTestOf(platformId: string): PlatformHealth['lastTest'] {
  const r = db().get<{ ts: string; actor: string; summary: string; details: string | null }>(
    `SELECT ts, actor, summary, details FROM audit_log WHERE entity_type = 'platform' AND entity_id = ? AND action = 'platform.tested' ORDER BY seq DESC LIMIT 1`,
    platformId,
  );
  if (!r) return null;
  const d = parseJson<{ ok?: unknown; message?: unknown }>(r.details, {});
  const http = /→ HTTP (\d{3})/.exec(r.summary);
  const ok = typeof d.ok === 'boolean' ? d.ok : http ? Number(http[1]) < 400 : !r.summary.includes('" failed: ');
  // entries before 0.4.0 have no message: the summary after the platform's name
  const fromSummary = r.summary.includes('": ') ? r.summary.slice(r.summary.indexOf('": ') + 3) : r.summary;
  return { at: r.ts, ok, message: typeof d.message === 'string' ? d.message : fromSummary, by: r.actor };
}

export function getHealth(platformId: string): PlatformHealth {
  const h = row(platformId);
  const enabled = !!h?.enabled;
  const interval = h?.interval_minutes ?? 60;
  const next = enabled ? (h?.last_run_at ? new Date(Date.parse(h.last_run_at) + interval * 60000).toISOString() : nowIso()) : null;
  return {
    platformId,
    lastTest: lastTestOf(platformId),
    periodic: { enabled, intervalMinutes: interval, nextAt: next, updatedBy: h?.updated_by ?? null, updatedAt: h?.updated_at ?? null },
    failingSince: h?.failing_since ?? null,
  };
}

export const healthInput = z
  .object({
    enabled: z.boolean(),
    intervalMinutes: z
      .number()
      .int()
      .refine((n) => (PLATFORM_HEALTH_INTERVALS as readonly number[]).includes(n), `One of ${PLATFORM_HEALTH_INTERVALS.join(', ')} minutes`),
  })
  .strict();

/** Turns the periodic connection test on or off (platform managers; audited). */
export function setHealth(platformId: string, input: z.infer<typeof healthInput>): PlatformHealth {
  const u = me();
  const p = getPlatform(platformId);
  const before = row(platformId);
  const now = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO platform_health (platform_id, enabled, interval_minutes, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(platform_id) DO UPDATE SET enabled = excluded.enabled, interval_minutes = excluded.interval_minutes,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      platformId,
      input.enabled ? 1 : 0,
      input.intervalMinutes,
      u.username,
      now,
    );
    // switched off: a later start begins without the old failure
    if (!input.enabled) db().run('UPDATE platform_health SET failing_since = NULL, notified_at = NULL WHERE platform_id = ?', platformId);
    audit({
      action: 'platform.health_changed',
      entityType: 'platform',
      entityId: platformId,
      summary: `Periodic connection test of "${p.name}" ${input.enabled ? `on (every ${input.intervalMinutes} minutes)` : 'off'}`,
      details: {
        enabled: input.enabled,
        intervalMinutes: input.intervalMinutes,
        previous: before ? { enabled: !!before.enabled, intervalMinutes: before.interval_minutes } : null,
      },
    });
  });
  return getHealth(platformId);
}

/** The people who manage the platform (its access list or their role), else the administrators. */
export function platformManagers(platformId: string) {
  const r = db().get<{ acl: string }>('SELECT acl FROM platforms WHERE id = ?', platformId);
  const acl = parseJson(r?.acl, []);
  const all = listUsers().filter((u) => u.active);
  const managers = all.filter((u) => platformPermissions(toAuthUser(u), { id: platformId, acl }).includes('manage'));
  return managers.length ? managers : all.filter((u) => u.roles.includes('admin'));
}

const running = new Set<string>();

/**
 * One pass of the periodic connection tests (every few minutes from the notification jobs): every platform whose test
 * is on and due. Returns how many were tested.
 */
export async function runPlatformHealthJob(now = Date.now()): Promise<number> {
  if (!vault().unlocked) return 0;
  const due = db()
    .all<HealthRow>('SELECT * FROM platform_health WHERE enabled = 1')
    .filter((h) => !h.last_run_at || now - Date.parse(h.last_run_at) >= h.interval_minutes * 60000 - 30_000);
  let n = 0;
  for (const h of due) {
    if (running.has(h.platform_id)) continue;
    running.add(h.platform_id);
    try {
      await testOne(h, now);
      n++;
    } catch (err) {
      logger.warn({ err, platform: h.platform_id }, 'periodic connection test failed to run');
    } finally {
      running.delete(h.platform_id);
    }
  }
  return n;
}

async function testOne(h: HealthRow, now: number): Promise<void> {
  const at = new Date(now).toISOString();
  db().run('UPDATE platform_health SET last_run_at = ? WHERE platform_id = ?', at, h.platform_id);
  let p;
  try {
    p = getPlatform(h.platform_id);
  } catch {
    return; // deleted in between (the row goes with it)
  }
  let ok: boolean;
  let message: string;
  try {
    // the periodic test tests the default identity (ADR 0009)
    const c = getConnection(p.id);
    const r = await runConnectionTest(c.platform, c.secrets, { periodic: true });
    ok = r.ok;
    message = r.message;
  } catch (e) {
    // the credentials cannot be read (settings changed outside Steward, vault): that is a failing connection too
    ok = false;
    message = (e as Error).message.slice(0, 300);
    audit({
      actor: 'system',
      action: 'platform.tested',
      entityType: 'platform',
      entityId: p.id,
      summary: `Connection test "${p.name}" failed: ${message.slice(0, 200)}`,
      details: { ok: false, message, periodic: true },
    });
  }
  if (ok) {
    if (h.failing_since) db().run('UPDATE platform_health SET failing_since = NULL, notified_at = NULL WHERE platform_id = ?', p.id);
    return;
  }
  if (h.failing_since && h.notified_at) return; // reported once per failing period
  db().run('UPDATE platform_health SET failing_since = COALESCE(failing_since, ?), notified_at = ? WHERE platform_id = ?', at, at, p.id);
  const { notifyPlatformFailing } = await import('../notifications/service.js');
  notifyPlatformFailing({ platformId: p.id, name: p.name, message, since: h.failing_since ?? at, recipients: platformManagers(p.id) });
}

/** For tests: the next pass tests every enabled platform. */
export function resetHealthClock(): void {
  db().run('UPDATE platform_health SET last_run_at = NULL');
}
