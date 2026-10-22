import type { MonitorStatus, UptimeSet } from '@sm/shared';
import { db } from '../db.js';

/**
 * Uptime:
 * - checks: hourly samples (evaluations that were ok = up/degraded vs. down; unknown,
 *   blocked and maintenance do not count) – robust against gaps while Steward was stopped;
 * - monitors: time-weighted from the status changes (down vs. up/degraded; other time does not count).
 * Values are percentages with two decimals, null when there is no data for the window.
 */
const WINDOWS: [keyof UptimeSet, number][] = [
  ['h24', 24],
  ['d7', 24 * 7],
  ['d30', 24 * 30],
];

const round = (x: number) => Math.round(x * 10000) / 100;

/** Uptime of all checks of the given monitors, one query per window. */
export function checkUptimes(monitorIds: string[], now = Date.now()): Map<string, UptimeSet> {
  const out = new Map<string, UptimeSet>();
  if (!monitorIds.length) return out;
  const marks = monitorIds.map(() => '?').join(',');
  for (const [name, hours] of WINDOWS) {
    const since = new Date(Math.floor((now - hours * 3600000) / 3600000) * 3600000).toISOString();
    const rows = db().all<{ monitor_id: string; check_id: string; ok: number; down: number }>(
      `SELECT monitor_id, check_id, SUM(ok) AS ok, SUM(down) AS down FROM monitor_samples
       WHERE monitor_id IN (${marks}) AND bucket >= ? AND check_id <> '' GROUP BY monitor_id, check_id`,
      ...monitorIds,
      since,
    );
    for (const r of rows) {
      const k = `${r.monitor_id}/${r.check_id}`;
      const set = out.get(k) ?? { h24: null, d7: null, d30: null };
      const total = Number(r.ok) + Number(r.down);
      set[name] = total ? round(Number(r.ok) / total) : null;
      out.set(k, set);
    }
  }
  return out;
}

/** Time-weighted uptime of one monitor from its status changes. */
export function monitorUptime(monitorId: string, now = Date.now()): UptimeSet {
  const from30 = now - 30 * 86400000;
  const before = db().get<{ ts: string; status: MonitorStatus }>(
    "SELECT ts, status FROM monitor_history WHERE monitor_id = ? AND check_id = '' AND ts < ? ORDER BY id DESC LIMIT 1",
    monitorId,
    new Date(from30).toISOString(),
  );
  const changes = db().all<{ ts: string; status: MonitorStatus }>(
    "SELECT ts, status FROM monitor_history WHERE monitor_id = ? AND check_id = '' AND ts >= ? ORDER BY id",
    monitorId,
    new Date(from30).toISOString(),
  );
  const points = [...(before ? [{ t: from30, status: before.status }] : []), ...changes.map((c) => ({ t: Date.parse(c.ts), status: c.status }))];
  const out: UptimeSet = { h24: null, d7: null, d30: null };
  for (const [name, hours] of WINDOWS) {
    const start = now - hours * 3600000;
    let ok = 0;
    let down = 0;
    points.forEach((p, i) => {
      const a = Math.max(p.t, start);
      const b = Math.min(points[i + 1]?.t ?? now, now);
      if (b <= a) return;
      if (p.status === 'up' || p.status === 'degraded') ok += b - a;
      else if (p.status === 'down') down += b - a;
    });
    out[name] = ok + down > 0 ? round(ok / (ok + down)) : null;
  }
  return out;
}
