import type { DatasetRow, DatasetStatus, MonitorStatus } from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { parseJson } from '../util.js';
import { currentUser } from '../auth/context.js';
import { publishDataset } from '../dashboards/datasets.js';
import { monitorPermissions, parseCauses, type CheckRow, type MonitorRow, type StateRow } from './model.js';
import { checkUptimes, monitorUptime } from './stats.js';
import { subMonitorMessage } from './redact.js';

/**
 * Dashboard datasets fed by the monitor engine (at most once a minute):
 * - `monitor.<key>`: one row per check of a monitor, visible to whoever may view the monitor – so it
 *   names no other monitor (its viewers may not be allowed to view a sub-monitor): causes in other
 *   monitors are "another monitor", sub-monitor checks get a message without names;
 * - `monitors.status`: one row per monitor, visible to users who may view every monitor.
 * Their "process id" is `monitor:<id>` / `monitor:*`, which the dataset visibility checks understand.
 */
export const OVERVIEW_DATASET = 'monitors.status';
const dirty = new Set<string>();

export function markDatasetsDirty(mid: string): void {
  dirty.add(mid);
}

const TO_DATASET: Record<MonitorStatus, DatasetStatus> = {
  up: 'good',
  degraded: 'warning',
  down: 'critical',
  blocked: 'serious',
  unknown: 'unknown',
  maintenance: 'unknown',
};

export function publishDirtyDatasets(): number {
  if (!dirty.size) return 0;
  const ids = [...dirty];
  dirty.clear();
  let n = 0;
  for (const id of ids) {
    const m = db().get<MonitorRow>('SELECT * FROM monitors WHERE id = ?', id);
    if (!m || m.is_template) continue;
    const def = parseJson<{ checks?: { id: string; name: string; type: string }[] }>(m.definition, {});
    const causeName = (c: { monitorId: string; checkName: string }) => (c.monitorId === id ? c.checkName : 'another monitor');
    const rows = new Map(
      db()
        .all<CheckRow>('SELECT * FROM monitor_checks WHERE monitor_id = ?', id)
        .map((r) => [r.check_id, r]),
    );
    const uptimes = checkUptimes([id]);
    const out: DatasetRow[] = (def.checks ?? []).map((c) => {
      const r = rows.get(c.id);
      const last = parseJson<{ message?: string } | null>(r?.last_result, null);
      const causes = parseCauses(r?.caused_by);
      const status = (r?.status ?? 'unknown') as MonitorStatus;
      // messages stored before they became generic may name the sub-monitor
      const message = c.type === 'monitor' && last ? subMonitorMessage(status) : (last?.message ?? '');
      const causedBy = [...new Set(causes.map(causeName))].join(', ');
      return {
        Check: c.name,
        Type: c.type,
        Status: status,
        'Uptime 24 h (%)': uptimes.get(`${id}/${c.id}`)?.h24 ?? null,
        'Last check (UTC)': r?.last_checked_at ?? null,
        Message: message,
        'Likely caused by': causedBy,
        _status: TO_DATASET[status],
        _reason: causes.length ? `Likely caused by ${causedBy}` : message,
      };
    });
    const count = (s: MonitorStatus) => out.filter((r) => r.Status === s).length;
    try {
      publishDataset({
        key: `monitor.${m.key}`,
        title: `Monitor: ${m.name}`,
        processId: `monitor:${m.id}`,
        processName: `Monitor "${m.name}"`,
        runId: '',
        dryRun: false,
        columns: ['Check', 'Type', 'Status', 'Uptime 24 h (%)', 'Last check (UTC)', 'Message', 'Likely caused by'],
        rows: out,
        metrics: { checks: out.length, up: count('up'), degraded: count('degraded'), down: count('down'), uptime24h: monitorUptime(id).h24 ?? 0 },
      });
      n++;
    } catch (err) {
      logger.warn({ err, monitor: m.key }, 'monitor dataset not published');
    }
  }
  publishOverview();
  return n + 1;
}

function publishOverview(): void {
  const list = db().all<MonitorRow & Partial<StateRow>>(
    'SELECT m.*, s.status, s.since, s.root_causes FROM monitors m LEFT JOIN monitor_state s ON s.monitor_id = m.id WHERE m.is_template = 0 ORDER BY m.name',
  );
  const rows: DatasetRow[] = list.map((m) => {
    const status = (m.enabled ? (m.status ?? 'unknown') : 'unknown') as MonitorStatus;
    const roots = parseCauses(m.root_causes);
    return {
      Monitor: m.name,
      Key: m.key,
      Status: m.enabled ? status : 'disabled',
      'Since (UTC)': m.since ?? null,
      'Uptime 24 h (%)': monitorUptime(m.id).h24,
      'Root cause': roots.map((r) => `${r.monitorName} › ${r.checkName}`).join(', '),
      _status: TO_DATASET[status],
      _reason: roots.length ? `Root cause: ${roots.map((r) => r.checkName).join(', ')}` : '',
    };
  });
  const count = (s: string) => rows.filter((r) => r.Status === s).length;
  publishDataset({
    key: OVERVIEW_DATASET,
    title: 'Monitors – status overview',
    processId: 'monitor:*',
    processName: 'Monitors',
    runId: '',
    dryRun: false,
    columns: ['Monitor', 'Key', 'Status', 'Since (UTC)', 'Uptime 24 h (%)', 'Root cause'],
    rows,
    metrics: { monitors: rows.length, up: count('up'), degraded: count('degraded'), down: count('down'), unknown: count('unknown') },
  });
}

/**
 * Visibility of monitor datasets for the dataset/dashboard APIs:
 * undefined when the process id is not a monitor's (normal process rules apply).
 */
export function monitorDatasetVisible(processId: string): boolean | undefined {
  if (!processId.startsWith('monitor:')) return undefined;
  const u = currentUser();
  const id = processId.slice('monitor:'.length);
  if (id === '*') {
    return (
      db()
        .all<{ id: string; owner: string; acl: string }>('SELECT id, owner, acl FROM monitors WHERE is_template = 0')
        .every((r) => monitorPermissions(u, { id: r.id, owner: r.owner, acl: parseJson(r.acl, []) }).includes('view')) && !!u
    );
  }
  const r = db().get<{ id: string; owner: string; acl: string }>('SELECT id, owner, acl FROM monitors WHERE id = ?', id);
  return !!r && monitorPermissions(u, { id: r.id, owner: r.owner, acl: parseJson(r.acl, []) }).includes('view');
}
