import { KAFKA_CONNECT_KIND, type CheckOf, type ConnectConnector, type MonitorStatus } from '@sm/shared';
import { platformFor, CheckSetupError } from '../monitors/platforms.js';
import { getPlatform } from '../platforms/service.js';
import { readConnect } from './client.js';
import { connectErrorMessage, kafkaPlatformOf, storedReadout } from './service.js';

/**
 * The monitor check "Kafka Connect connectors" (0.9.0, #223), with the rights of the monitor's owner:
 *   - a connector or task that is FAILED: notRunningAs (default down) – with failedMinutes, a failed task is degraded
 *     until it has failed that long; UNASSIGNED or RESTARTING (a rebalance): degraded; PAUSED or STOPPED: pausedAs;
 *   - maxLag: the consumer lag of a sink connector's group on its topics, read on the linked Kafka platform (when the
 *     owner may use it) – degraded above;
 *   - quietMinutes: a Debezium source connector none of whose topics got a message for that long: quietAs.
 */

const RANK: Record<string, number> = { up: 0, degraded: 1, down: 2 };
const worst = (a: MonitorStatus, b: MonitorStatus): MonitorStatus => ((RANK[b] ?? 0) > (RANK[a] ?? 0) ? b : a);

/** Since when a task was seen FAILED, and topic end offsets (brokers without the newest message's time): per key. */
const seen = new Map<string, { value: number; since: number }>();
const since = (key: string, value: number, now: number) => {
  const prev = seen.get(key);
  if (!prev || prev.value !== value) seen.set(key, { value, since: now });
  return seen.get(key)!;
};

interface Result {
  status: MonitorStatus;
  message: string;
  durationMs?: number;
  value?: unknown;
}

function stateStatus(state: string, c: CheckOf<'kafka-connect'>): MonitorStatus {
  if (state === 'RUNNING') return 'up';
  if (state === 'PAUSED' || state === 'STOPPED') return c.pausedAs;
  if (state === 'FAILED') return c.notRunningAs;
  return 'degraded';
}

export async function checkKafkaConnect(c: CheckOf<'kafka-connect'>, ctx: { owner: string }): Promise<Result> {
  const t0 = Date.now();
  const { platform, secrets } = platformFor(ctx.owner, c.platform);
  if (platform.kind !== KAFKA_CONNECT_KIND) return { status: 'unknown', message: `Check could not run: "${platform.name}" is not a Kafka Connect platform` };
  const only = c.connector?.trim() || undefined;
  let connectors: ConnectConnector[];
  try {
    ({ connectors } = await readConnect(platform, secrets, {
      full: false,
      only,
      // the active topics only where the check needs them
      topicsFor: (x) => (c.quietMinutes !== undefined && !!x.debezium) || (c.maxLag !== undefined && x.type === 'sink'),
    }));
  } catch (e) {
    return { status: 'unknown', message: `Kafka Connect could not be read: ${connectErrorMessage(e)}`.slice(0, 500), durationMs: Date.now() - t0 };
  }
  if (only && !connectors.length) return { status: 'unknown', message: `Kafka Connect: no connector "${only}"`, durationMs: Date.now() - t0 };
  const now = Date.now();
  const stored = storedReadout(platform.id);
  let status: MonitorStatus = 'up';
  const problems: string[] = [];
  const notes: string[] = [];
  let failedTasks = 0;
  let running = 0;
  for (const x of connectors) {
    const s = stateStatus(x.state, c);
    if (s !== 'up') {
      status = worst(status, s);
      problems.push(`${x.name} ${x.state}`);
    } else running++;
    for (const t of x.tasks) {
      const key = `${platform.id}|${x.name}|${t.id}`;
      if (t.state !== 'FAILED') {
        seen.delete(key);
        const ts = stateStatus(t.state, c);
        if (ts !== 'up') {
          status = worst(status, ts);
          problems.push(`${x.name} task ${t.id} ${t.state}`);
        }
        continue;
      }
      failedTasks++;
      // since when it failed: what this check saw, or the platform's last readout when that saw it earlier
      const earlier = stored?.connectors.find((s2) => s2.name === x.name)?.tasks.find((s2) => s2.id === t.id)?.failedSince;
      const from = Math.min(since(key, 1, now).since, earlier ? Date.parse(earlier) || now : now);
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
  const value: Record<string, unknown> = { connectors: connectors.length, running, failedTasks };

  // lag and quiet topics: on the linked Kafka platform, with the owner's rights
  const sinks = c.maxLag !== undefined ? connectors.filter((x) => x.type === 'sink' && x.groupId && x.topics.length) : [];
  const sources = c.quietMinutes !== undefined ? connectors.filter((x) => x.debezium && x.topics.length) : [];
  if (sinks.length || sources.length) {
    const linked = kafkaPlatformOf(getPlatform(platform.id));
    let kafka: ReturnType<typeof platformFor> | null = null;
    try {
      if (!linked) throw new CheckSetupError('the platform names no Kafka platform (variable kafkaPlatform)');
      kafka = platformFor(ctx.owner, linked.id);
    } catch (e) {
      notes.push(`lag and messages not readable: ${(e as Error).message}`);
    }
    if (kafka) {
      const { withKafka, kafkaError } = await import('../kafka/client.js');
      const { lagOf } = await import('../kafka/service.js');
      try {
        await withKafka(kafka.platform, kafka.secrets, async (k) => {
          for (const x of sinks) {
            let lag = 0;
            for (const topic of x.topics) {
              const ends = await k.ends(topic);
              const g = (await k.groups(topic, [x.groupId!]))[0];
              lag += g ? lagOf(ends, g).lag : ends.reduce((n, e) => n + e.end, 0);
            }
            value[`lag:${x.name}`] = lag;
            if (lag > c.maxLag!) {
              status = worst(status, 'degraded');
              problems.push(`${x.name} lag ${lag} (at most ${c.maxLag})`);
            } else notes.push(`${x.name} lag ${lag}`);
          }
          for (const x of sources) {
            let newest: number | null = null;
            let offsets = 0;
            for (const topic of x.topics) {
              const t = await k.newest(topic);
              if (t !== null) newest = Math.max(newest ?? 0, t);
              offsets += (await k.ends(topic)).reduce((n, e) => n + e.end, 0);
            }
            // brokers before Kafka 3.0: when the end offsets last moved (known after the first window)
            const moved = since(`${platform.id}|${x.name}|offsets`, offsets, now);
            const last = newest ?? (now - moved.since >= c.quietMinutes! * 60_000 ? moved.since : null);
            const age = last === null ? null : Math.round((now - last) / 60_000);
            value[`minutesSinceMessage:${x.name}`] = age;
            if (age !== null && age > c.quietMinutes!) {
              status = worst(status, c.quietAs);
              problems.push(`${x.name}: no message on its ${x.topics.length} topics for ${age} minutes (expected within ${c.quietMinutes})`);
            } else notes.push(age === null ? `${x.name}: watching its topics` : `${x.name}: newest message ${age} minutes ago`);
          }
        });
      } catch (e) {
        notes.push(`Kafka not readable: ${kafkaError(e)}`);
      }
    }
  }
  const head = only
    ? `${only} ${connectors[0]!.state} (${connectors[0]!.tasks.filter((t) => t.state === 'RUNNING').length}/${connectors[0]!.tasks.length} tasks)`
    : `${running}/${connectors.length} connectors running`;
  const parts = [...problems, ...notes];
  return { status, message: `Kafka Connect: ${head}${parts.length ? ` – ${parts.join(', ')}` : ''}`.slice(0, 500), durationMs: Date.now() - t0, value };
}
