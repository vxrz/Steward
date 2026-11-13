import {
  DATABASE_KIND,
  DB_DIALECT_INFO,
  KAFKA_CONNECT_KIND,
  KAFKA_CONNECT_LIMITS,
  KAFKA_KIND,
  debeziumMatches,
  sameHost,
  type ConnectConnector,
  type ConnectConnectorView,
  type ConnectReadout,
  type ConnectView,
  type Platform,
  type TopicConnectorRef,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { HttpError, parseJson } from '../util.js';
import { getConnection, getPlatform, listPlatforms } from '../platforms/service.js';
import { requireVisiblePlatform } from '../monitors/platforms.js';
import { catalogueVisibleNow } from '../records/access.js';
import { ConnectError, assertConnectOutbound, connectGet, readConnect } from './client.js';

/**
 * Kafka Connect platforms (0.9.0, #223, docs/KAFKA.md): what Steward last read from the REST API – connectors, tasks,
 * plugins – kept per platform without any configuration (kafka_connect_readouts), and the links of each connector:
 * the Kafka topic components of its Kafka platform and, for Debezium source connectors, the database platform and the
 * system it reads. Links name only what the reader may see; a hidden platform or system reads like no match.
 */

interface ReadoutRow {
  platform_id: string;
  kafka_platform_id: string | null;
  readout: string;
  read_at: string;
  read_by: string;
}

/** The Kafka platform the variable kafkaPlatform names (its id, or its name), whoever may see it; null when none. */
export function kafkaPlatformOf(connect: Platform): { id: string; name: string } | null {
  const ref = String(connect.config.variables?.kafkaPlatform ?? '').trim();
  if (!ref) return null;
  const rows = db().all<{ id: string; name: string }>('SELECT id, name FROM platforms WHERE kind = ? ORDER BY name', KAFKA_KIND);
  const hit = rows.find((r) => r.id === ref) ?? rows.filter((r) => r.name.toLowerCase() === ref.toLowerCase())[0];
  return hit ? { id: hit.id, name: hit.name } : null;
}

const visible = (id: string): Platform | null => {
  try {
    const p = getPlatform(id);
    return p.permissions.length ? p : null;
  } catch {
    return null;
  }
};

function storedRow(platformId: string): ReadoutRow | undefined {
  return db().get<ReadoutRow>('SELECT * FROM kafka_connect_readouts WHERE platform_id = ?', platformId);
}

export function storedReadout(platformId: string): ConnectReadout | null {
  const r = storedRow(platformId);
  return r ? parseJson<ConnectReadout | null>(r.readout, null) : null;
}

/** Topic components of the Kafka platform per topic name, of applications the reader may see (archived ones left out). */
function topicComponents(kafkaPlatformId: string): Map<string, ConnectConnectorView['topicComponents']> {
  const rows = db().all<{ id: string; name: string; application_id: string; app_name: string; owners: string }>(
    `SELECT c.id, c.name, c.application_id, a.name AS app_name, a.owners FROM application_components c JOIN applications a ON a.id = c.application_id
     WHERE c.type = 'kafka-topic' AND c.platform_id = ? AND a.archived = 0 ORDER BY a.name, c.name`,
    kafkaPlatformId,
  );
  const out = new Map<string, ConnectConnectorView['topicComponents']>();
  for (const r of rows) {
    if (!catalogueVisibleNow('application', { id: r.application_id, owners: r.owners })) continue;
    out.set(r.name, [...(out.get(r.name) ?? []), { topic: r.name, applicationId: r.application_id, applicationName: r.app_name, componentId: r.id }]);
  }
  return out;
}

/**
 * The database platform and system a Debezium source connector reads – the rule of docs/KAFKA.md: a database platform
 * the reader may see whose dialect, host, port and (when the connector names databases) database match its
 * configuration, the first by name; the system that is this platform, else a system named like the host or its first
 * label (shop-db for shop-db.example.internal). Only systems the reader may see.
 */
function databaseLink(c: ConnectConnector, dbPlatforms: Platform[], systems: { id: string; name: string; platform_id: string | null; owners: string }[]) {
  const src = c.debezium;
  if (!src) return null;
  const platform =
    dbPlatforms.find((p) => {
      const d = p.config.database;
      return !!d && debeziumMatches(src, { dialect: d.dialect, host: d.host, port: d.port ?? DB_DIALECT_INFO[d.dialect].port, database: d.database ?? '' });
    }) ?? null;
  const label = src.host.split('.')[0] ?? src.host;
  const seen = systems.filter((s) => catalogueVisibleNow('system', s));
  const system =
    (platform && seen.find((s) => s.platform_id === platform.id)) ||
    seen.find((s) => sameHost(s.name, src.host)) ||
    seen.find((s) => s.name.toLowerCase() === label.toLowerCase()) ||
    null;
  return { platform: platform ? { id: platform.id, name: platform.name } : null, system: system ? { id: system.id, name: system.name } : null };
}

/** The platform page's view (GET /api/platforms/:id/kafka-connect): the last readout with the links the reader may see. */
export function getConnectView(platformId: string): ConnectView {
  const p = requireVisiblePlatform(platformId);
  if (p.kind !== KAFKA_CONNECT_KIND) throw new HttpError(400, 'Choose a Kafka Connect platform', 'KAFKA_CONNECT_PLATFORM');
  const readout = storedReadout(platformId);
  const linked = kafkaPlatformOf(p);
  const kafka = linked && visible(linked.id) ? linked : null;
  const topics = kafka ? topicComponents(kafka.id) : new Map<string, ConnectConnectorView['topicComponents']>();
  const needsDb = readout?.connectors.some((c) => c.debezium);
  const dbPlatforms = needsDb ? listPlatforms().filter((x) => x.kind === DATABASE_KIND && x.permissions.length > 0 && !!x.config.database) : [];
  const systems = needsDb
    ? db().all<{ id: string; name: string; platform_id: string | null; owners: string }>('SELECT id, name, platform_id, owners FROM systems ORDER BY name')
    : [];
  return {
    platformId,
    kafkaPlatform: kafka,
    kafkaPlatformMissing: !!String(p.config.variables?.kafkaPlatform ?? '').trim() && !kafka,
    readout,
    connectors: (readout?.connectors ?? []).map((c) => ({
      ...c,
      topicComponents: c.topics.flatMap((t) => topics.get(t) ?? []),
      database: databaseLink(c, dbPlatforms, systems),
    })),
    canRead: p.permissions.includes('use'),
  };
}

/** A short message for an error of a read (the REST API's answer, the outbound policy, a timeout). */
export function connectErrorMessage(e: unknown): string {
  const err = e as Error & { cause?: Error };
  return `${err.message}${err.cause?.message && !err.message.includes(err.cause.message) ? `: ${err.cause.message}` : ''}`.slice(0, 400);
}

/**
 * Reads the cluster now and keeps the readout (no configuration); a failed read keeps the last connectors and records
 * why. Connectors that appear or disappear are recorded in the platform's history (platform.connectors_changed).
 */
export async function refreshConnect(platformId: string, actor: string, now = Date.now()): Promise<ConnectReadout> {
  const { platform, secrets } = getConnection(platformId);
  if (platform.kind !== KAFKA_CONNECT_KIND) throw new HttpError(400, 'Choose a Kafka Connect platform', 'KAFKA_CONNECT_PLATFORM');
  const before = storedReadout(platformId);
  const at = new Date(now).toISOString();
  let readout: ConnectReadout;
  try {
    readout = { readAt: at, error: null, ...(await readConnect(platform, secrets, { before, now })) };
  } catch (e) {
    readout = { ...(before ?? { worker: null, connectors: [], plugins: [] }), readAt: at, error: connectErrorMessage(e) };
  }
  const kafka = kafkaPlatformOf(platform);
  db().run(
    `INSERT INTO kafka_connect_readouts (platform_id, kafka_platform_id, readout, read_at, read_by) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(platform_id) DO UPDATE SET kafka_platform_id = excluded.kafka_platform_id, readout = excluded.readout, read_at = excluded.read_at, read_by = excluded.read_by`,
    platformId,
    kafka?.id ?? null,
    JSON.stringify(readout),
    at,
    actor,
  );
  // a failed read keeps the connectors before it: they are what the new read is compared with (none read yet: nothing to compare)
  if (!readout.error && before && (before.connectors.length || !before.error)) {
    const was = new Set(before.connectors.map((c) => c.name));
    const is = new Set(readout.connectors.map((c) => c.name));
    const added = [...is].filter((n) => !was.has(n));
    const removed = [...was].filter((n) => !is.has(n));
    if (added.length || removed.length)
      audit({
        action: 'platform.connectors_changed',
        entityType: 'platform',
        entityId: platformId,
        actor,
        summary: `Connectors of "${platform.name}" changed: ${[...added.map((n) => `+${n}`), ...removed.map((n) => `-${n}`)].join(', ')}`.slice(0, 500),
        details: { added: added.slice(0, 50), removed: removed.slice(0, 50) },
      });
  }
  if (!readout.error) await proposeConnectorLineage(platformId);
  return readout;
}

/**
 * 0.25.0 (ADR 0037 part 1): the lineage of the connectors as proposals of the data products module (only while it is
 * on) – a failure there never fails the readout.
 */
export async function proposeConnectorLineage(platformId: string): Promise<void> {
  try {
    (await import('../dataproducts/connector-lineage.js')).proposeFromConnectors(platformId);
  } catch (err) {
    logger.warn({ err: (err as Error).message, platform: platformId }, 'connector lineage not proposed');
  }
}

/** The job: every Kafka Connect platform is read again after KAFKA_CONNECT_LIMITS.refreshMinutes; readouts of deleted platforms go with them. */
export async function runKafkaConnectJob(now = Date.now()): Promise<number> {
  if (!vault().unlocked) return 0;
  const ids = db()
    .all<{ id: string }>('SELECT id FROM platforms WHERE kind = ? ORDER BY name', KAFKA_CONNECT_KIND)
    .map((r) => r.id);
  let n = 0;
  for (const id of ids) {
    const last = storedRow(id);
    if (last && now - Date.parse(last.read_at) < KAFKA_CONNECT_LIMITS.refreshMinutes * 60_000) continue;
    try {
      await refreshConnect(id, 'system', now);
      n++;
    } catch (err) {
      logger.warn({ err: connectErrorMessage(err), platform: id }, 'reading a Kafka Connect platform failed');
    }
  }
  return n;
}

/**
 * The configuration of one connector, read now and never stored: secret-looking values are removed by the HTTP layer
 * already (redactConnectAnswer). Who may use the platform reads it; every read is recorded (kafka_connect.config_read).
 */
export async function connectorConfig(platformId: string, name: string, actor: string): Promise<{ name: string; config: Record<string, string> }> {
  const { platform, secrets } = getConnection(platformId);
  if (platform.kind !== KAFKA_CONNECT_KIND) throw new HttpError(400, 'Choose a Kafka Connect platform', 'KAFKA_CONNECT_PLATFORM');
  let body: unknown;
  try {
    await assertConnectOutbound(platform, secrets);
    body = await connectGet(platform, secrets, `/connectors/${encodeURIComponent(name)}/config`);
  } catch (e) {
    if (e instanceof ConnectError && e.status === 404)
      throw new HttpError(404, `Kafka Connect has no connector "${name.slice(0, 100)}"`, 'KAFKA_CONNECTOR_NOT_FOUND');
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, `Kafka Connect could not be read: ${connectErrorMessage(e)}`, 'KAFKA_CONNECT_READ');
  }
  const config = Object.fromEntries(
    Object.entries(body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {})
      .filter(([k]) => k !== '__proto__' && k !== 'constructor' && k !== 'prototype')
      .map(([k, v]): [string, string] => [k.slice(0, 300), typeof v === 'string' ? v.slice(0, 4000) : JSON.stringify(v ?? null).slice(0, 4000)])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  audit({
    action: 'kafka_connect.config_read',
    entityType: 'platform',
    entityId: platformId,
    actor,
    summary: `Configuration of the connector "${name.slice(0, 100)}" read on "${platform.name}" (secret-looking values removed)`,
    details: { connector: name.slice(0, 255), keys: Object.keys(config).length },
  });
  return { name, config };
}

/**
 * The connectors that use topics of a Kafka platform, per topic – for Kafka topic components on the application page.
 * Only Kafka Connect platforms the reader may see.
 */
export function topicConnectors(kafkaPlatformId: string): Map<string, TopicConnectorRef[]> {
  const out = new Map<string, TopicConnectorRef[]>();
  const rows = db().all<ReadoutRow>('SELECT * FROM kafka_connect_readouts WHERE kafka_platform_id = ?', kafkaPlatformId);
  for (const r of rows) {
    const p = visible(r.platform_id);
    if (!p) continue;
    for (const c of parseJson<ConnectReadout | null>(r.readout, null)?.connectors ?? [])
      for (const t of c.topics)
        out.set(t, [...(out.get(t) ?? []), { platformId: p.id, platformName: p.name, connector: c.name, type: c.type, state: c.state }]);
  }
  return out;
}
