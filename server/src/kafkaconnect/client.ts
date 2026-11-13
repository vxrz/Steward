import {
  KAFKA_CONNECT_KIND,
  KAFKA_CONNECT_LIMITS,
  SCRUBBED,
  allowedConnectorConfig,
  debeziumSource,
  type ConnectConnector,
  type ConnectPlugin,
  type ConnectReadout,
  type ConnectTask,
  type Platform,
} from '@sm/shared';
import { buildUrl, platformRequest } from '../platforms/http.js';
import { assertOutboundAllowed } from '../platforms/outbound.js';
import { outboundContext } from '../platforms/policyContext.js';
import { HttpError } from '../util.js';

/**
 * The Kafka Connect REST API, read-only (0.9.0, #223): every request is a GET through platformRequest – the platform's
 * sign-in (basic, bearer or a client certificate), its TLS settings, no redirects followed – and every answer has its
 * secret-looking values removed there already (redactConnectAnswer, platforms/deniedPaths.ts). Changing requests are
 * refused for the kind whoever asks. The base URL goes through the outbound policy like every platform request.
 */

export class ConnectError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

/** The reason of an error answer (Kafka Connect: {error_code, message}), short. */
function reason(body: unknown): string {
  const m = isObj(body) ? str(body.message) : typeof body === 'string' ? body : '';
  return m.replace(/\s+/g, ' ').trim().slice(0, 200);
}

export async function assertConnectOutbound(platform: Platform, secrets: Record<string, string>): Promise<void> {
  if (platform.kind !== KAFKA_CONNECT_KIND) throw new HttpError(400, 'Choose a Kafka Connect platform', 'KAFKA_CONNECT_PLATFORM');
  if (!platform.baseUrl) throw new HttpError(400, 'The Kafka Connect platform has no base URL (its REST API)', 'KAFKA_CONNECT_BASE_URL');
  await assertOutboundAllowed(await buildUrl(platform, secrets, '/'), outboundContext());
}

/** GET on the REST API; an error answer throws ConnectError with the status and Kafka Connect's message. */
export async function connectGet(platform: Platform, secrets: Record<string, string>, path: string, query?: Record<string, unknown>): Promise<unknown> {
  const r = await platformRequest(
    platform,
    secrets,
    { method: 'GET', url: path, query, headers: { accept: 'application/json' }, maxResponseBytes: 16 * 1024 * 1024, noRedirects: true },
    AbortSignal.timeout(KAFKA_CONNECT_LIMITS.timeoutMs),
  );
  if (r.ok) return r.body;
  const why = reason(r.body);
  throw new ConnectError(
    `Kafka Connect answered HTTP ${r.status} for GET ${path.split('?')[0]}${why ? `: ${why}` : ''}${r.status === 401 || r.status === 403 ? ' – check the sign-in of the platform' : ''}`,
    r.status,
  );
}

/** Topics in a configuration value (comma-separated), without masked ones. */
const topicList = (v: unknown): string[] =>
  str(v)
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x && x !== SCRUBBED);

function task(t: unknown, before: ConnectTask | undefined, now: string): ConnectTask | null {
  if (!isObj(t)) return null;
  const state = str(t.state).toUpperCase() || 'UNASSIGNED';
  const failed = state === 'FAILED';
  return {
    id: Number(t.id) || 0,
    state,
    workerId: str(t.worker_id).slice(0, 200),
    trace: failed && t.trace ? str(t.trace).slice(0, KAFKA_CONNECT_LIMITS.traceChars + 2) : null,
    failedSince: failed ? (before?.state === 'FAILED' && before.failedSince ? before.failedSince : now) : null,
  };
}

/** One connector from its info (type, configuration – already redacted) and status. */
export function toConnector(
  name: string,
  info: unknown,
  status: unknown,
  plugins: ConnectPlugin[],
  before: ConnectConnector | undefined,
  now: string,
): ConnectConnector {
  const config = isObj(info) && isObj(info.config) ? info.config : {};
  const st = isObj(status) ? status : {};
  const c = isObj(st.connector) ? st.connector : {};
  const typeRaw = str((isObj(info) ? info.type : undefined) ?? st.type).toLowerCase();
  const type = typeRaw === 'source' || typeRaw === 'sink' ? typeRaw : 'unknown';
  const cls = str(config['connector.class']).slice(0, 300);
  const state = str(c.state).toUpperCase() || 'UNASSIGNED';
  const tasks = (Array.isArray(st.tasks) ? st.tasks : [])
    .map((t) =>
      task(
        t,
        before?.tasks.find((b) => isObj(t) && b.id === Number(t.id)),
        now,
      ),
    )
    .filter((t): t is ConnectTask => !!t)
    .sort((a, b) => a.id - b.id);
  const override = str(config['consumer.override.group.id']).trim();
  const plugin = plugins.find((p) => p.class === cls) ?? plugins.find((p) => cls && p.class.endsWith(`.${cls}`));
  return {
    name: name.slice(0, 255),
    type,
    class: cls,
    version: plugin?.version ?? null,
    state,
    workerId: str(c.worker_id).slice(0, 200),
    trace: state === 'FAILED' && c.trace ? str(c.trace).slice(0, KAFKA_CONNECT_LIMITS.traceChars + 2) : null,
    topics: type === 'sink' ? topicList(config.topics).slice(0, KAFKA_CONNECT_LIMITS.topics) : [],
    tasks,
    groupId: type === 'sink' ? (override && override !== SCRUBBED ? override : `connect-${name}`).slice(0, 255) : null,
    debezium: type === 'sink' ? null : debeziumSource(cls, config),
    // 0.25.0 (ADR 0037 part 1): the allow-listed keys only – the lineage proposals read them (connector-lineage.ts)
    config: allowedConnectorConfig(config),
  };
}

/** The active topics of a connector (GET /connectors/{name}/topics, Kafka 2.5+); null when Kafka Connect does not track them. */
export async function activeTopics(platform: Platform, secrets: Record<string, string>, name: string): Promise<string[] | null> {
  try {
    const body = await connectGet(platform, secrets, `/connectors/${encodeURIComponent(name)}/topics`);
    const entry = isObj(body) ? body[name] : undefined;
    const topics = isObj(entry) && Array.isArray(entry.topics) ? entry.topics.map(str).filter(Boolean) : null;
    return topics ? [...new Set(topics)].sort().slice(0, KAFKA_CONNECT_LIMITS.topics) : null;
  } catch (e) {
    // topic tracking off (topic.tracking.enable=false) or an older Kafka Connect: the topics of the configuration count
    if (e instanceof ConnectError) return null;
    throw e;
  }
}

/**
 * The connectors with their status and info: GET /connectors?expand=status&expand=info (Kafka 2.3+), else one request
 * per connector.
 */
async function connectorsWithStatus(platform: Platform, secrets: Record<string, string>): Promise<[string, { info: unknown; status: unknown }][]> {
  const body = await connectGet(platform, secrets, '/connectors', { expand: ['status', 'info'] });
  if (isObj(body))
    return Object.entries(body)
      .filter(([k]) => k !== '__proto__' && k !== 'constructor' && k !== 'prototype')
      .slice(0, KAFKA_CONNECT_LIMITS.connectors)
      .map(([name, v]) => [name, { info: isObj(v) ? v.info : undefined, status: isObj(v) ? v.status : undefined }]);
  // an older Kafka Connect answers the names only
  const names = (Array.isArray(body) ? body.map(str).filter(Boolean) : []).slice(0, KAFKA_CONNECT_LIMITS.connectors);
  const out: [string, { info: unknown; status: unknown }][] = [];
  for (const name of names) {
    const path = `/connectors/${encodeURIComponent(name)}`;
    out.push([name, { info: await connectGet(platform, secrets, path), status: await connectGet(platform, secrets, `${path}/status`) }]);
  }
  return out;
}

export async function plugins(platform: Platform, secrets: Record<string, string>): Promise<ConnectPlugin[]> {
  const body = await connectGet(platform, secrets, '/connector-plugins');
  return (Array.isArray(body) ? body : [])
    .filter(isObj)
    .map((p) => ({ class: str(p.class).slice(0, 300), type: str(p.type).toLowerCase().slice(0, 40), version: str(p.version).slice(0, 100) }))
    .filter((p) => p.class)
    .sort((a, b) => a.class.localeCompare(b.class))
    .slice(0, KAFKA_CONNECT_LIMITS.plugins);
}

/**
 * Everything Steward reads from a Kafka Connect cluster: the worker, the connectors with state, tasks, topics and
 * versions, the plugins. `before`: the last readout (a task that stays FAILED keeps the time it failed). `topicsFor`:
 * the connectors whose active topics are read (default: all, up to KAFKA_CONNECT_LIMITS.topicReads). `full: false`
 * leaves out the worker and the plugins (monitor checks).
 */
export async function readConnect(
  platform: Platform,
  secrets: Record<string, string>,
  opts: { before?: ConnectReadout | null; now?: number; only?: string; topicsFor?: (c: ConnectConnector) => boolean; full?: boolean } = {},
): Promise<Omit<ConnectReadout, 'readAt' | 'error'>> {
  await assertConnectOutbound(platform, secrets);
  const now = new Date(opts.now ?? Date.now()).toISOString();
  const full = opts.full !== false;
  const w = full ? await connectGet(platform, secrets, '/') : null;
  const worker = isObj(w)
    ? { version: str(w.version).slice(0, 100), commit: str(w.commit).slice(0, 100), kafkaClusterId: str(w.kafka_cluster_id).slice(0, 100) }
    : null;
  const plug = full ? await plugins(platform, secrets) : [];
  let list = await connectorsWithStatus(platform, secrets);
  if (opts.only !== undefined) list = list.filter(([name]) => name === opts.only);
  const connectors = list
    .map(([name, x]) =>
      toConnector(
        name,
        x.info,
        x.status,
        plug,
        opts.before?.connectors.find((b) => b.name === name),
        now,
      ),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  let reads = 0;
  for (const c of connectors) {
    if (opts.topicsFor && !opts.topicsFor(c)) continue;
    if (reads++ >= KAFKA_CONNECT_LIMITS.topicReads) break;
    const active = await activeTopics(platform, secrets, c.name);
    if (active) c.topics = [...new Set([...active, ...c.topics])].sort().slice(0, KAFKA_CONNECT_LIMITS.topics);
  }
  return { worker, connectors, plugins: plug };
}
