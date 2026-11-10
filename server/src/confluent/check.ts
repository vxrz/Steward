import { CONFLUENT_KIND, type CheckOf, type ConfluentCluster, type ConfluentConnector, type MonitorStatus } from '@sm/shared';
import { platformFor } from '../monitors/platforms.js';
import { assertConfluentOutbound, readClusters, readConnectorsOf, readEnvironments } from './client.js';
import { confluentErrorMessage, storedConfluent } from './service.js';

/**
 * The monitor check "Confluent Cloud" (0.14.0, #123), read now with the rights of the monitor's owner:
 *   - target clusters: every Kafka cluster (or the one named, by id or name) is PROVISIONED – PROVISIONING is degraded,
 *     FAILED notRunningAs;
 *   - target connectors: every managed connector (or the one named, by name or id) and its tasks are RUNNING – FAILED is
 *     notRunningAs (a failed task degraded until it has failed failedMinutes), PAUSED pausedAs, PROVISIONING and
 *     DEGRADED degraded.
 * A platform of another kind reports unknown without a request (monitors/kinds.ts, and again here).
 */

const RANK: Record<string, number> = { up: 0, degraded: 1, down: 2 };
const worst = (a: MonitorStatus, b: MonitorStatus): MonitorStatus => ((RANK[b] ?? 0) > (RANK[a] ?? 0) ? b : a);

/** Since when a task was seen FAILED, per platform, connector and task. */
const failedSeen = new Map<string, number>();

interface Result {
  status: MonitorStatus;
  message: string;
  durationMs?: number;
  value?: unknown;
}

function clusterStatus(phase: string, c: CheckOf<'confluent'>): MonitorStatus {
  if (phase === 'PROVISIONED') return 'up';
  if (phase === 'FAILED') return c.notRunningAs;
  return 'degraded';
}

function connectorStatus(state: string, c: CheckOf<'confluent'>): MonitorStatus {
  if (state === 'RUNNING') return 'up';
  if (state === 'PAUSED') return c.pausedAs;
  if (state === 'FAILED') return c.notRunningAs;
  return 'degraded';
}

const matches = (name: string | undefined, ...ids: string[]) => !name || ids.some((x) => x.toLowerCase() === name.toLowerCase());

export async function checkConfluent(c: CheckOf<'confluent'>, ctx: { owner: string }): Promise<Result> {
  const t0 = Date.now();
  const { platform, secrets } = platformFor(ctx.owner, c.platform);
  if (platform.kind !== CONFLUENT_KIND) return { status: 'unknown', message: `Check could not run: "${platform.name}" is not a Confluent Cloud platform` };
  const only = c.resource?.trim() || undefined;
  const now = Date.now();
  let clusters: ConfluentCluster[];
  try {
    await assertConfluentOutbound(platform, secrets);
    clusters = await readClusters(platform, secrets, await readEnvironments(platform, secrets));
  } catch (e) {
    return { status: 'unknown', message: `Confluent Cloud could not be read: ${confluentErrorMessage(e)}`.slice(0, 500), durationMs: Date.now() - t0 };
  }

  if (c.target === 'clusters') {
    const list = clusters.filter((x) => matches(only, x.id, x.name));
    if (only && !list.length) return { status: 'unknown', message: `Confluent Cloud: no cluster "${only}"`, durationMs: Date.now() - t0 };
    let status: MonitorStatus = 'up';
    const problems: string[] = [];
    for (const x of list) {
      const s = clusterStatus(x.phase, c);
      status = worst(status, s);
      if (s !== 'up') problems.push(`${x.name} (${x.id}) ${x.phase}`);
    }
    const provisioned = list.filter((x) => x.phase === 'PROVISIONED').length;
    const head = only && list[0] ? `${list[0].name} ${list[0].phase}` : `${provisioned}/${list.length} clusters provisioned`;
    return {
      status,
      message: `Confluent Cloud: ${head}${problems.length && !only ? ` – ${problems.join(', ')}` : ''}`.slice(0, 500),
      durationMs: Date.now() - t0,
      value: { clusters: list.length, provisioned },
    };
  }

  const stored = storedConfluent(platform.id);
  const iso = new Date(now).toISOString();
  let connectors: ConfluentConnector[] = [];
  try {
    for (const cl of clusters.filter((x) => x.phase !== 'PROVISIONING'))
      connectors.push(...(await readConnectorsOf(platform, secrets, cl, stored?.connectors ?? [], iso)));
  } catch (e) {
    return {
      status: 'unknown',
      message: `Confluent Cloud connectors could not be read: ${confluentErrorMessage(e)}`.slice(0, 500),
      durationMs: Date.now() - t0,
    };
  }
  connectors = connectors.filter((x) => matches(only, x.name, x.id));
  if (only && !connectors.length) return { status: 'unknown', message: `Confluent Cloud: no connector "${only}"`, durationMs: Date.now() - t0 };
  let status: MonitorStatus = 'up';
  const problems: string[] = [];
  let running = 0;
  let failedTasks = 0;
  for (const x of connectors) {
    const s = connectorStatus(x.state, c);
    if (s !== 'up') {
      status = worst(status, s);
      problems.push(`${x.name} ${x.state}`);
    }
    if (x.state === 'RUNNING') running++;
    for (const t of x.tasks) {
      const key = `${platform.id}|${x.clusterId}|${x.name}|${t.id}`;
      if (t.state !== 'FAILED') {
        failedSeen.delete(key);
        const ts = connectorStatus(t.state, c);
        if (ts !== 'up') {
          status = worst(status, ts);
          problems.push(`${x.name} task ${t.id} ${t.state}`);
        }
        continue;
      }
      failedTasks++;
      if (!failedSeen.has(key)) failedSeen.set(key, now);
      // since when it failed: what this check saw, or the platform's last readout when that saw it earlier
      const earlier = t.failedSince ? Date.parse(t.failedSince) : NaN;
      const from = Math.min(failedSeen.get(key)!, Number.isFinite(earlier) ? earlier : now);
      const minutes = Math.round((now - from) / 60_000);
      if (c.failedMinutes !== undefined && minutes < c.failedMinutes) {
        status = worst(status, 'degraded');
        problems.push(`${x.name} task ${t.id} FAILED for ${minutes} minutes (alarm after ${c.failedMinutes})`);
      } else {
        status = worst(status, c.notRunningAs);
        problems.push(`${x.name} task ${t.id} FAILED${minutes ? ` for ${minutes} minutes` : ''}`);
      }
    }
  }
  const head =
    only && connectors[0]
      ? `${connectors[0].name} ${connectors[0].state} (${connectors[0].tasks.filter((t) => t.state === 'RUNNING').length}/${connectors[0].tasks.length} tasks)`
      : `${running}/${connectors.length} connectors running`;
  return {
    status,
    message: `Confluent Cloud: ${head}${problems.length ? ` – ${problems.join(', ')}` : ''}`.slice(0, 500),
    durationMs: Date.now() - t0,
    value: { connectors: connectors.length, running, failedTasks },
  };
}
