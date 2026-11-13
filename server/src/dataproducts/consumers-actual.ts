import {
  DATA_GOVERNANCE_LIMITS as G,
  dataConsumerIdentitiesInput,
  identityOf,
  matchConsumers,
  type AclEntry,
  type DataActualConsumer,
  type DataActualKind,
  type DataActualRead,
  type DataActualReadStatus,
  type DataActualView,
  type DataConsumerKind,
  type DataDeclaredConsumer,
  type Platform,
  type PlatformPermission,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { forbid, me } from '../auth/access.js';
import type { AuthUser } from '../auth/context.js';
import { platformAccess } from '../auth/policy.js';
import { findUserByName } from '../auth/users.js';
import { canViewCatalogue } from '../records/access.js';
import { logger } from '../log.js';
import { CheckSetupError, platformFor } from '../monitors/platforms.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import { productAccess } from './access.js';
import { bundleTopics, snowflakeParts } from './checks/freshness.js';
import { json, portNotFound } from './common.js';
import { bindingsOf, chunks, consumersOf, elementsByIds, marks, portRow, productRow, type ConsumerRow, type ElementRow, type PortRow } from './store.js';
import { editableProduct, visibleProduct } from './service.js';

/**
 * Declared against actual consumers (ADR 0036 part 17, decision 26): who really reads an output port, as the platforms
 * say – metadata only, read-only statements, never a query text:
 *
 *   Snowflake  SNOWFLAKE.ACCOUNT_USAGE.ACCESS_HISTORY (Enterprise edition; up to 3 hours behind): the users who read the
 *              port's objects in the last 30 days, with the role of each query (QUERY_HISTORY.ROLE_NAME), aggregated –
 *              reads and the last read per user and role. An edition or a role that cannot read the view is
 *              _not available_, never a failure of the port.
 *   Kafka      the consumer groups with committed offsets on the port's topics (a bundle's topics one by one) and their
 *              state – the metadata and offset requests of the kafka check, never a message.
 *
 * A read happens on _Read now_ (who may change the product, with their use right on the platform) and again daily by
 * the job as the person who read last (their use right checked again, platformFor). Results replace the previous ones
 * per port, environment and platform. Registrations are matched by the platform identities they name
 * (dp_consumer_identities: `user:`, `role:`, `group:`) and a registered user by their user name or e-mail address –
 * _seen_, _registered but silent_, and actual consumers _not registered_ (shared matchConsumers).
 *
 * Who sees what: who may see the product sees the comparison; the names of actual consumers only on platforms they may
 * see (else counted). Statements: names go in as bindings (JSON arrays), the view names are fixed.
 */

const SNOWFLAKE_KINDS = new Set(['snowflake.table', 'snowflake.view', 'snowflake.dynamicTable', 'snowflake.stream']);
const SNOWFLAKE_CONTAINERS = new Set(['snowflake.database', 'snowflake.schema']);

/** The statement (and the only one) Steward sends for actual consumers of Snowflake objects – the allow-list of the tests. */
export const ACCESS_HISTORY_STATEMENT = `/* steward:dp-access-history */ WITH reads AS (
  SELECT ah.QUERY_ID, ah.USER_NAME, ah.QUERY_START_TIME, f.value:"objectName"::STRING AS OBJECT_NAME
  FROM SNOWFLAKE.ACCOUNT_USAGE.ACCESS_HISTORY ah, LATERAL FLATTEN(input => ah.BASE_OBJECTS_ACCESSED) f
  WHERE ah.QUERY_START_TIME >= DATEADD('day', -?, CURRENT_TIMESTAMP())
)
SELECT r.OBJECT_NAME AS OBJECT_NAME, r.USER_NAME AS USER_NAME, COALESCE(q.ROLE_NAME, '') AS ROLE_NAME,
  COUNT(DISTINCT r.QUERY_ID) AS READS, TO_VARCHAR(MAX(r.QUERY_START_TIME), 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM') AS LAST_READ
FROM reads r LEFT JOIN SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY q ON q.QUERY_ID = r.QUERY_ID AND q.START_TIME >= DATEADD('day', -?, CURRENT_TIMESTAMP())
WHERE ARRAY_CONTAINS(r.OBJECT_NAME::VARIANT, PARSE_JSON(?))
   OR EXISTS (SELECT 1 FROM TABLE(FLATTEN(input => PARSE_JSON(?))) p WHERE STARTSWITH(r.OBJECT_NAME, p.value::STRING))
GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT ?`;

/** An answer that says the view is not there or not readable (Standard edition, or a role without the database role). */
const NOT_AVAILABLE = /does not exist or not authorized|insufficient privileges|not authorized|SQL access control error/i;

// ---------- identities of registrations ----------

/** The identities each registration names (bulk). */
export function identitiesOf(consumerIds: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of chunks([...new Set(consumerIds)]))
    for (const r of db().all<{ consumer_id: string; identity: string }>(
      `SELECT consumer_id, identity FROM dp_consumer_identities WHERE consumer_id IN (${marks(part.length)}) ORDER BY identity`,
      ...part,
    ))
      out.set(r.consumer_id, [...(out.get(r.consumer_id) ?? []), r.identity]);
  return out;
}

/** Replaces a registration's identities (inside the caller's transaction). */
export function writeIdentities(consumerId: string, identities: readonly string[]): void {
  db().run('DELETE FROM dp_consumer_identities WHERE consumer_id = ?', consumerId);
  for (const i of [...new Set(identities.map((x) => x.trim()))].slice(0, G.identitiesPerConsumer))
    db().run('INSERT INTO dp_consumer_identities (consumer_id, identity) VALUES (?, ?) ON CONFLICT DO NOTHING', consumerId, i);
}

/** PUT …/consumers/:consumerId/identities – who may change the product. */
export function setConsumerIdentities(productId: string, portId: string, consumerId: string, body: unknown): { identities: string[] } {
  const { row: p } = editableProduct(productId);
  const port = outputPort(p.id, portId);
  const c = db().get<ConsumerRow>('SELECT * FROM dp_consumers WHERE id = ? AND port_id = ?', consumerId, port.id);
  if (!c) throw new HttpError(404, `Consumer ${consumerId} not found`, 'DATA_CONSUMER_INVALID', { context: 'notFound' });
  const input = dataConsumerIdentitiesInput.parse(body);
  const before = identitiesOf([c.id]).get(c.id) ?? [];
  db().tx(() => {
    writeIdentities(c.id, input.identities);
    audit({
      action: 'dataproduct.consumer_changed',
      entityType: 'data_product',
      entityId: p.id,
      summary: `Data product "${p.name}": platform identities of a consumer of port "${port.name}" changed`,
      details: { portId: port.id, consumerId: c.id, before, after: input.identities },
    });
  });
  return { identities: identitiesOf([c.id]).get(c.id) ?? [] };
}

function outputPort(productId: string, portId: string): PortRow {
  const port = portRow(portId);
  if (!port || port.product_id !== productId) throw portNotFound(portId);
  if (port.direction !== 'output') throw new HttpError(400, 'Consumers register on output ports', 'DATA_CONSUMER_INVALID', { context: 'inputPort' });
  return port;
}

// ---------- reading the platforms ----------

interface Found {
  kind: DataActualKind;
  name: string;
  objects: Set<string>;
  reads: number | null;
  lastSeen: string | null;
  detail: string;
}

interface PlatformRead {
  platformId: string;
  status: DataActualReadStatus;
  message: string;
  objects: number;
  found: Found[];
}

/** The bound elements of a port in an environment, per platform. */
function boundByPlatform(port: PortRow, environment: string): Map<string, ElementRow[]> {
  const b = bindingsOf([port.id]).find((x) => x.environment === environment);
  const out = new Map<string, ElementRow[]>();
  if (!b) return out;
  for (const e of elementsByIds(b.elementIds).values()) {
    if (!e.platform_id) continue;
    out.set(e.platform_id, [...(out.get(e.platform_id) ?? []), e]);
  }
  return out;
}

const upper = (qn: string): string | null => snowflakeParts(qn)?.join('.') ?? null;

/** The Snowflake objects of the port: exact names (tables, views …) and prefixes (a schema or database: everything below). */
export function snowflakeObjects(elements: readonly ElementRow[]): { names: string[]; prefixes: string[] } {
  const names = new Set<string>();
  const prefixes = new Set<string>();
  for (const e of elements) {
    const n = upper(e.qualified_name);
    if (!n) continue;
    if (SNOWFLAKE_KINDS.has(e.kind) && n.split('.').length === 3) names.add(n);
    else if (SNOWFLAKE_CONTAINERS.has(e.kind)) prefixes.add(`${n}.`);
  }
  return { names: [...names].slice(0, G.objectsPerRead), prefixes: [...prefixes].slice(0, G.objectsPerRead) };
}

async function readSnowflake(platform: Platform, secrets: Record<string, string>, elements: ElementRow[]): Promise<Omit<PlatformRead, 'platformId'>> {
  const { names, prefixes } = snowflakeObjects(elements);
  if (!names.length && !prefixes.length) return { status: 'noObjects', message: '', objects: 0, found: [] };
  const objects = names.length + prefixes.length;
  const { SnowflakeClient } = await import('../snowflake/client.js');
  const { buildUrl } = await import('../platforms/http.js');
  const { assertOutboundAllowed } = await import('../platforms/outbound.js');
  const { outboundContext } = await import('../platforms/policyContext.js');
  // the account's origin must be allowed by the outbound policy; every statement then goes through the platform's request path
  await assertOutboundAllowed(await buildUrl(platform, secrets, '/'), outboundContext());
  const c = new SnowflakeClient(platform, secrets);
  let rows: Record<string, string | null>[];
  try {
    rows = [];
    for await (const part of c.queryPartitions(
      ACCESS_HISTORY_STATEMENT,
      [G.actualWindowDays, G.actualWindowDays, JSON.stringify(names), JSON.stringify(prefixes), G.actualPerPlatform * 4],
      G.actualPerPlatform * 4,
      120,
    ))
      rows.push(...part);
  } catch (e) {
    const msg = (e as Error).message.slice(0, 500);
    if (NOT_AVAILABLE.test(msg)) return { status: 'notAvailable', message: msg, objects, found: [] };
    throw e;
  }
  // per user and per role: reads summed, the newest read, the objects
  const by = new Map<string, Found>();
  const add = (kind: DataActualKind, name: string, r: Record<string, string | null>) => {
    if (!name) return;
    const key = `${kind}:${name}`;
    const f = by.get(key) ?? { kind, name, objects: new Set<string>(), reads: 0, lastSeen: null, detail: '' };
    f.reads = (f.reads ?? 0) + (Number(r.READS) || 0);
    if (r.LAST_READ && (!f.lastSeen || r.LAST_READ > f.lastSeen)) f.lastSeen = r.LAST_READ;
    if (r.OBJECT_NAME && f.objects.size < G.actualObjects) f.objects.add(r.OBJECT_NAME);
    by.set(key, f);
  };
  for (const r of rows) {
    add('user', String(r.USER_NAME ?? ''), r);
    add('role', String(r.ROLE_NAME ?? ''), r);
  }
  const found = [...by.values()].sort((a, b) => (b.reads ?? 0) - (a.reads ?? 0) || a.name.localeCompare(b.name)).slice(0, G.actualPerPlatform);
  return { status: 'ok', message: '', objects, found };
}

async function readKafka(platform: Platform, secrets: Record<string, string>, elements: ElementRow[]): Promise<Omit<PlatformRead, 'platformId'>> {
  const topics = [
    ...new Set(elements.flatMap((e) => (e.kind === 'kafka.topic' ? [e.qualified_name] : e.kind === 'kafka.topicBundle' ? bundleTopics(e) : []))),
  ].slice(0, G.objectsPerRead);
  if (!topics.length) return { status: 'noObjects', message: '', objects: 0, found: [] };
  const { withKafka } = await import('../kafka/client.js');
  const now = nowIso();
  const by = new Map<string, Found>();
  await withKafka(platform, secrets, async (k) => {
    for (const topic of topics)
      for (const g of await k.groups(topic)) {
        // Steward's own short-lived groups (peeking a topic) are not consumers
        if (/^[a-z0-9-]+-peek-[0-9a-f]+$/.test(g.group) || !g.committed.size) continue;
        const f = by.get(g.group) ?? { kind: 'group' as const, name: g.group, objects: new Set<string>(), reads: null, lastSeen: now, detail: g.state };
        if (f.objects.size < G.actualObjects) f.objects.add(topic);
        by.set(g.group, f);
      }
  });
  return { status: 'ok', message: '', objects: topics.length, found: [...by.values()].slice(0, G.actualPerPlatform) };
}

/** Reads one platform of a port as `owner` (their use right checked again); failures become the read's status. */
async function readPlatform(owner: string, platformId: string, elements: ElementRow[]): Promise<PlatformRead> {
  try {
    const { platform, secrets } = platformFor(owner, platformId);
    if (platform.kind === 'snowflake') return { platformId, ...(await readSnowflake(platform, secrets, elements)) };
    if (platform.kind === 'kafka') return { platformId, ...(await readKafka(platform, secrets, elements)) };
    return { platformId, status: 'noObjects', message: `${platform.kind} platforms do not say who reads`, objects: 0, found: [] };
  } catch (e) {
    const msg = e instanceof CheckSetupError ? e.message : (e as Error).message;
    return { platformId, status: 'failed', message: msg.slice(0, 500), objects: 0, found: [] };
  }
}

/** Stores what a read found (replaces the previous read of the port, environment and platform). */
function store(portId: string, environment: string, owner: string, reads: PlatformRead[]): void {
  const at = nowIso();
  db().tx(() => {
    // platforms no longer bound: their old answers go
    const keep = reads.map((r) => r.platformId);
    const stale = db()
      .all<{ platform_id: string }>('SELECT platform_id FROM dp_actual_reads WHERE port_id = ? AND environment = ?', portId, environment)
      .map((r) => r.platform_id)
      .filter((p) => !keep.includes(p));
    for (const p of stale) {
      db().run('DELETE FROM dp_actual_reads WHERE port_id = ? AND environment = ? AND platform_id = ?', portId, environment, p);
      db().run('DELETE FROM dp_actual_consumers WHERE port_id = ? AND environment = ? AND platform_id = ?', portId, environment, p);
    }
    for (const r of reads) {
      db().run(
        `INSERT INTO dp_actual_reads (port_id, environment, platform_id, status, message, window_days, objects, read_at, read_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (port_id, environment, platform_id) DO UPDATE SET status = excluded.status, message = excluded.message, window_days = excluded.window_days,
           objects = excluded.objects, read_at = excluded.read_at, read_by = excluded.read_by`,
        portId,
        environment,
        r.platformId,
        r.status,
        r.message,
        G.actualWindowDays,
        r.objects,
        at,
        owner,
      );
      // a failed read keeps what the last good one found (a hiccup does not make every consumer silent)
      if (r.status === 'failed') continue;
      db().run('DELETE FROM dp_actual_consumers WHERE port_id = ? AND environment = ? AND platform_id = ?', portId, environment, r.platformId);
      for (const f of r.found)
        db().run(
          'INSERT INTO dp_actual_consumers (port_id, environment, platform_id, kind, name, objects, reads, last_seen, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          portId,
          environment,
          r.platformId,
          f.kind,
          f.name.slice(0, 255),
          json([...f.objects].sort()),
          f.reads,
          f.lastSeen,
          f.detail.slice(0, 100),
        );
    }
  });
}

/** Reads a port's actual consumers in an environment as `owner` and stores them. */
export async function readPort(port: PortRow, environment: string, owner: string): Promise<PlatformRead[]> {
  const bound = boundByPlatform(port, environment);
  const reads: PlatformRead[] = [];
  for (const [platformId, elements] of bound) reads.push(await readPlatform(owner, platformId, elements));
  store(port.id, environment, owner, reads);
  return reads;
}

/** POST …/ports/:portId/actual/read – who may change the product and use one of the bound platforms (session only). */
export async function readNow(productId: string, portId: string, environment: string): Promise<DataActualView> {
  const u = me();
  const { row: p } = editableProduct(productId);
  const port = outputPort(p.id, portId);
  const bound = boundByPlatform(port, environment);
  if (!bound.size)
    throw new HttpError(409, `The port has no elements on a platform in ${environment}`, 'DATA_PORT_BINDING', { context: 'noPlatform', environment });
  const usable = usablePlatforms(u, [...bound.keys()]);
  if (!usable.size) forbid('use the platforms of this port', 'dataProducts');
  const reads = await readPort(port, environment, u.username);
  audit({
    action: 'dataproduct.consumers_read',
    entityType: 'data_product',
    entityId: p.id,
    summary: `Data product "${p.name}": actual consumers of port "${port.name}" read in ${environment}`,
    details: { portId: port.id, environment, reads: reads.map((r) => ({ platformId: r.platformId, status: r.status, found: r.found.length })) },
  });
  return actualView(p.id, port.id, environment);
}

/** The platforms `u` may use, of these. */
function usablePlatforms(u: AuthUser, ids: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const part of chunks([...new Set(ids)]))
    for (const p of db().all<{ id: string; acl: string }>(`SELECT id, acl FROM platforms WHERE id IN (${marks(part.length)})`, ...part))
      if (platformAccess(u, { id: p.id, acl: parseJson<AclEntry<PlatformPermission>[]>(p.acl, []) }).permissions.includes('use')) out.add(p.id);
  return out;
}

// ---------- the comparison ----------

interface ReadRow {
  platform_id: string;
  status: DataActualReadStatus;
  message: string;
  window_days: number;
  objects: number;
  read_at: string;
  read_by: string;
}
interface ActualRow {
  platform_id: string;
  kind: DataActualKind;
  name: string;
  objects: string;
  reads: number | null;
  last_seen: string | null;
  detail: string;
}

/** Steward users named by registrations of kind user, with their e-mail address (they match a Snowflake user). */
function userNames(subjects: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const s of subjects) {
    const m = /^user:(.+)$/i.exec(s);
    if (!m) continue;
    const info = findUserByName(m[1]!);
    out.set(s, [m[1]!, ...(info?.email ? [info.email] : [])]);
  }
  return out;
}

const labelOf = (c: ConsumerRow): { label: string | null; subject: string | null } => {
  const subjects = parseJson<string[]>(c.consumer_subjects, []);
  if (c.consumer_kind === 'team' || c.consumer_kind === 'user') return { label: subjects[0] ?? null, subject: subjects[0] ?? null };
  if (c.consumer_kind === 'text') return { label: c.consumer_text, subject: null };
  return { label: null, subject: null };
};

/** GET …/ports/:portId/actual?environment= – who may see the product (names of hidden platforms counted). */
export function actualView(productId: string, portId: string, environment: string): DataActualView {
  const u = me();
  const { row: p, perms } = visibleProduct(productId, u);
  const port = outputPort(p.id, portId);
  const reads = db().all<ReadRow>('SELECT * FROM dp_actual_reads WHERE port_id = ? AND environment = ? ORDER BY platform_id', port.id, environment);
  const rows = db().all<ActualRow>(
    'SELECT platform_id, kind, name, objects, reads, last_seen, detail FROM dp_actual_consumers WHERE port_id = ? AND environment = ? ORDER BY platform_id, kind, name',
    port.id,
    environment,
  );
  const platformIds = [...new Set([...reads.map((r) => r.platform_id), ...rows.map((r) => r.platform_id), ...boundByPlatform(port, environment).keys()])];
  const platforms = new Map<string, { name: string; kind: string; visible: boolean }>();
  for (const part of chunks(platformIds))
    for (const x of db().all<{ id: string; name: string; kind: string; acl: string }>(
      `SELECT id, name, kind, acl FROM platforms WHERE id IN (${marks(part.length)})`,
      ...part,
    ))
      platforms.set(x.id, {
        name: x.name,
        kind: x.kind,
        visible: platformAccess(u, { id: x.id, acl: parseJson<AclEntry<PlatformPermission>[]>(x.acl, []) }).permissions.length > 0,
      });
  const consumers = consumersOf([port.id]);
  const ids = identitiesOf(consumers.map((c) => c.id));
  const users = userNames(consumers.filter((c) => c.consumer_kind === 'user').flatMap((c) => parseJson<string[]>(c.consumer_subjects, [])));
  const readOk = reads.some((r) => r.status === 'ok');
  const matched = matchConsumers(
    consumers.map((c) => ({
      consumerId: c.id,
      identities: ids.get(c.id) ?? [],
      userNames: c.consumer_kind === 'user' ? (users.get(parseJson<string[]>(c.consumer_subjects, [])[0] ?? '') ?? []).filter(Boolean) : [],
    })),
    rows.map((r) => ({ kind: r.kind, name: r.name })),
    readOk,
  );
  const names = consumerNames(u, consumers);
  const declared: DataDeclaredConsumer[] = consumers.map((c) => {
    const l = labelOf(c);
    const m = matched.declared.get(c.id)!;
    const label = c.consumer_kind === 'application' || c.consumer_kind === 'service' || c.consumer_kind === 'product' ? (names.get(c.id) ?? null) : l.label;
    return {
      consumerId: c.id,
      kind: c.consumer_kind as DataConsumerKind,
      label,
      subject: l.subject,
      purpose: c.purpose,
      endDate: c.end_date,
      identities: ids.get(c.id) ?? [],
      state: m.state,
      seenAs: m.seenAs,
    };
  });
  let hiddenActual = 0;
  const actual: DataActualConsumer[] = [];
  for (const r of rows) {
    const pl = platforms.get(r.platform_id);
    if (!pl?.visible) {
      hiddenActual++;
      continue;
    }
    actual.push({
      platformId: r.platform_id,
      platformName: pl.name,
      kind: r.kind,
      name: r.name,
      objects: parseJson<string[]>(r.objects, []),
      reads: r.reads === null ? null : Number(r.reads),
      lastSeen: r.last_seen,
      detail: r.detail,
      registeredAs: matched.actual.get(identityOf(r.kind, r.name)) ?? [],
    });
  }
  const readsOut: DataActualRead[] = reads.map((r) => {
    const pl = platforms.get(r.platform_id);
    return {
      platformId: pl?.visible ? r.platform_id : null,
      platformName: pl?.visible ? pl.name : null,
      platformKind: pl?.visible ? pl.kind : null,
      status: r.status,
      message: pl?.visible ? r.message : '',
      windowDays: Number(r.window_days),
      objects: Number(r.objects),
      readAt: r.read_at,
      readBy: r.read_by,
    };
  });
  const usable = perms.includes('edit') ? usablePlatforms(u, [...boundByPlatform(port, environment).keys()]) : new Set<string>();
  return {
    portId: port.id,
    environment,
    windowDays: G.actualWindowDays,
    reads: readsOut,
    actual,
    hiddenActual,
    declared,
    counts: {
      seen: declared.filter((d) => d.state === 'seen').length,
      silent: declared.filter((d) => d.state === 'silent').length,
      unknown: declared.filter((d) => d.state === 'unknown').length,
      // counted on every platform (hidden ones too: a count names nobody)
      notRegistered: rows.filter((r) => !(matched.actual.get(identityOf(r.kind, r.name)) ?? []).length).length,
    },
    canRead: usable.size > 0,
  };
}

/** Names of the applications, services and products registrations name, as `u` may see them (by consumer id). */
function consumerNames(u: AuthUser, consumers: ConsumerRow[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const kind of ['application', 'service'] as const) {
    const of = consumers.filter((c) => c.consumer_kind === kind && c.ref_id);
    if (!of.length) continue;
    const ids = [...new Set(of.map((c) => c.ref_id!))];
    const rows = new Map(
      db()
        .all<{ id: string; name: string; owners: string }>(
          `SELECT id, name, owners FROM ${kind === 'application' ? 'applications' : 'services'} WHERE id IN (${marks(ids.length)})`,
          ...ids,
        )
        .map((r) => [r.id, r]),
    );
    for (const c of of) {
      const r = rows.get(c.ref_id!);
      out.set(c.id, r && canViewCatalogue(u, { kind, id: r.id, owners: parseJson<string[]>(r.owners, []) }) ? r.name : null);
    }
  }
  for (const c of consumers.filter((x) => x.consumer_kind === 'product' && x.ref_id)) {
    const pr = productRow(c.ref_id!);
    out.set(c.id, pr && productAccess(u, pr).permissions.length ? pr.name : null);
  }
  return out;
}

// ---------- the job ----------

/** Ports read before whose last read is older than a day: read again as the person who read them (daily). */
export async function refreshActualConsumers(now = Date.now(), max = 50): Promise<number> {
  const before = new Date(now - G.actualRefreshHours * 3_600_000).toISOString();
  const due = db().all<{ port_id: string; environment: string; read_by: string }>(
    `SELECT port_id, environment, MIN(read_by) AS read_by FROM dp_actual_reads GROUP BY port_id, environment HAVING MAX(read_at) < ? ORDER BY MAX(read_at) LIMIT ?`,
    before,
    max,
  );
  let n = 0;
  for (const d of due) {
    const port = portRow(d.port_id);
    if (!port || port.direction !== 'output' || !productRow(port.product_id)) {
      db().run('DELETE FROM dp_actual_reads WHERE port_id = ?', d.port_id);
      db().run('DELETE FROM dp_actual_consumers WHERE port_id = ?', d.port_id);
      continue;
    }
    try {
      await readPort(port, d.environment, d.read_by);
      n++;
    } catch (err) {
      logger.warn({ err, portId: d.port_id }, 'actual consumers could not be read');
    }
  }
  return n;
}
