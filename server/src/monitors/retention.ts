import { db } from '../db.js';

/**
 * Retention of monitor data (Settings → retentionMonitorDays, default 30; run by
 * the daily maintenance job): status changes, hourly samples, raw results and
 * past maintenance windows. The newest status change of every check is kept, so
 * uptime can still be computed after a long quiet period.
 */
export function deleteMonitorDataBefore(cutoff: string): { history: number; samples: number; results: number; maintenance: number } {
  return db().tx(() => ({
    history: db().run(
      'DELETE FROM monitor_history WHERE ts < ? AND id NOT IN (SELECT keep FROM (SELECT MAX(id) AS keep FROM monitor_history GROUP BY monitor_id, check_id) newest)',
      cutoff,
    ).changes,
    samples: db().run('DELETE FROM monitor_samples WHERE bucket < ?', cutoff).changes,
    results: db().run('DELETE FROM monitor_results WHERE ts < ?', cutoff).changes,
    maintenance: db().run('DELETE FROM monitor_maintenance WHERE ends_at < ?', cutoff).changes,
  }));
}
