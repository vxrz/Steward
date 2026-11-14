import { CONFLUENT_KIND, KAFKA_CONNECT_KIND, worstHealth, type DataHealthStatus, type DataStep, type MonitorDefinition, type MonitorStatus } from '@sm/shared';
import { db } from '../db.js';
import type { AuthUser } from '../auth/context.js';
import { permissionsOfRow } from '../monitors/model.js';
import { parseJson } from '../util.js';
import { checkRuns, checkStates } from './health.js';
import { chunks, marks } from './store.js';

/**
 * The health of a step whose runner is a connector (0.25.0, ADR 0037 part 1): the existing checks watch it – a
 * `kafka-connect` check on its platform (the connector named, or every connector of the cluster) and a `confluent`
 * check of the managed connectors (the connector named by name or id, or every one). The worst status of the checks
 * that run counts (maintenance as up, blocked as unknown, as for elements); checks of monitors the reader may not see are
 * counted by status only. No such check: no health (null) – never OK without one.
 *
 * A fixed number of statements however many steps: the platforms, the monitors whose definition names one of the two
 * check types (a text filter before parsing) and their checks' states – and none when no step has a connector runner.
 */

const asHealth = (s: MonitorStatus): MonitorStatus => (s === 'maintenance' ? 'up' : s === 'blocked' ? 'unknown' : s);

interface MonitorRowLite {
  id: string;
  key: string;
  name: string;
  owner: string;
  acl: string;
  enabled: number;
  is_template: number;
  definition: string;
  status: MonitorStatus | null;
  since: string | null;
}

export function connectorStepHealth(
  u: AuthUser | null,
  steps: readonly { id: string; runner: DataStep['runner'] }[],
): Map<string, NonNullable<DataStep['health']>> {
  const out = new Map<string, NonNullable<DataStep['health']>>();
  const runners = steps.flatMap((s) => (s.runner?.kind === 'connector' ? [{ step: s.id, platformId: s.runner.platformId, name: s.runner.name }] : []));
  if (!runners.length) return out;
  const platformIds = [...new Set(runners.map((r) => r.platformId))];
  const platforms = new Map(
    chunks(platformIds).flatMap((part) =>
      db()
        .all<{ id: string; name: string; kind: string }>(`SELECT id, name, kind FROM platforms WHERE id IN (${marks(part.length)})`, ...part)
        .map((p) => [p.id, p] as const),
    ),
  );
  const monitors = db().all<MonitorRowLite>(
    `SELECT m.id, m.key, m.name, m.owner, m.acl, m.enabled, m.is_template, m.definition, s.status, s.since FROM monitors m LEFT JOIN monitor_state s ON s.monitor_id = m.id
     WHERE m.is_template = 0 AND m.enabled = 1 AND (lower(m.definition) LIKE '%"kafka-connect"%' OR lower(m.definition) LIKE '%"confluent"%')`,
  );
  if (!monitors.length) return out;
  const states = checkStates(monitors.map((m) => m.id));
  const views = new Map<string, boolean>();
  const sees = (m: MonitorRowLite) => {
    let v = views.get(m.id);
    if (v === undefined) views.set(m.id, (v = permissionsOfRow(m, u).includes('view')));
    return v;
  };
  // the checks of each platform: (monitor, check, connector named or '' for all)
  const checks: { platformRef: string; type: 'kafka-connect' | 'confluent'; connector: string; m: MonitorRowLite; checkId: string }[] = [];
  for (const m of monitors)
    for (const c of parseJson<Partial<MonitorDefinition>>(m.definition, {}).checks ?? []) {
      if (c.type === 'kafka-connect') checks.push({ platformRef: c.platform, type: c.type, connector: c.connector?.trim() ?? '', m, checkId: c.id });
      else if (c.type === 'confluent' && c.target === 'connectors')
        checks.push({ platformRef: c.platform, type: c.type, connector: c.resource?.trim() ?? '', m, checkId: c.id });
    }
  for (const r of runners) {
    const p = platforms.get(r.platformId);
    if (!p) continue;
    const type = p.kind === KAFKA_CONNECT_KIND ? 'kafka-connect' : p.kind === CONFLUENT_KIND ? 'confluent' : null;
    if (!type) continue;
    const mine = checks.filter(
      (c) =>
        c.type === type &&
        (c.platformRef === p.id || c.platformRef.toLowerCase() === p.name.toLowerCase()) &&
        (!c.connector || c.connector.toLowerCase() === r.name.toLowerCase()) &&
        checkRuns(c.m, c.checkId, states),
    );
    if (!mine.length) continue;
    const statuses: DataHealthStatus[] = mine.map((c) => asHealth(states.get(`${c.m.id}|${c.checkId}`)?.status ?? 'unknown'));
    const visible = mine.filter((c) => sees(c.m)).length;
    out.set(r.step, { status: worstHealth(statuses) ?? 'noData', checks: { visible, hidden: mine.length - visible } });
  }
  return out;
}
