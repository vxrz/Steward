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

type StatusPoint = { t: number; status: MonitorStatus };

/**
 * A monitor's status changes from `from` on (the status in effect at `from` first, dated `from`), up to `to`. The one
 * read behind every uptime figure of a monitor: its own, availability objectives with the monitor as source, and the
 * availability section of scheduled reports – so they show the same number for the same window (ADR 0018).
 */
export function statusPoints(monitorId: string, from: number, to: number): StatusPoint[] {
  const before = db().get<{ ts: string; status: MonitorStatus }>(
    "SELECT ts, status FROM monitor_history WHERE monitor_id = ? AND check_id = '' AND ts < ? ORDER BY ts DESC, id DESC LIMIT 1",
    monitorId,
    new Date(from).toISOString(),
  );
  const changes = db().all<{ ts: string; status: MonitorStatus }>(
    "SELECT ts, status FROM monitor_history WHERE monitor_id = ? AND check_id = '' AND ts >= ? AND ts < ? ORDER BY ts, id",
    monitorId,
    new Date(from).toISOString(),
    new Date(to).toISOString(),
  );
  return [...(before ? [{ t: from, status: before.status }] : []), ...changes.map((c) => ({ t: Date.parse(c.ts), status: c.status }))];
}

/**
 * Up (up or degraded) and down time in [start, end) from status points; unknown, blocked and maintenance do not
 * count, so a maintenance window neither lowers nor raises the figure.
 */
export function upAndDown(points: StatusPoint[], start: number, end: number): { ok: number; down: number } {
  let ok = 0;
  let down = 0;
  points.forEach((p, i) => {
    const a = Math.max(p.t, start);
    const b = Math.min(points[i + 1]?.t ?? end, end);
    if (b <= a) return;
    if (p.status === 'up' || p.status === 'degraded') ok += b - a;
    else if (p.status === 'down') down += b - a;
  });
  return { ok, down };
}

/** Uptime in hundredths of a percent (9995 = 99.95 %), null without up or down time. */
export const uptimeHundredths = ({ ok, down }: { ok: number; down: number }): number | null => (ok + down > 0 ? Math.round((ok / (ok + down)) * 10000) : null);

/** Time-weighted uptime of one monitor in the windows ending now, in hundredths of a percent. */
export function monitorUptimeHundredths<K extends string>(monitorId: string, windowsMs: Record<K, number>, now = Date.now()): Record<K, number | null> {
  const keys = Object.keys(windowsMs) as K[];
  const longest = Math.max(0, ...keys.map((k) => windowsMs[k]));
  const points = statusPoints(monitorId, now - longest, now + 1);
  return Object.fromEntries(keys.map((k) => [k, uptimeHundredths(upAndDown(points, now - windowsMs[k], now))])) as Record<K, number | null>;
}

/** Time-weighted uptime of one monitor from its status changes. */
export function monitorUptime(monitorId: string, now = Date.now()): UptimeSet {
  const h = monitorUptimeHundredths(
    monitorId,
    Object.fromEntries(WINDOWS.map(([name, hours]) => [name, hours * 3600000])) as Record<keyof UptimeSet, number>,
    now,
  );
  return { h24: h.h24 === null ? null : h.h24 / 100, d7: h.d7 === null ? null : h.d7 / 100, d30: h.d30 === null ? null : h.d30 / 100 };
}
