import {
  CONFLUENT_KIND,
  DATABASE_KIND,
  DB_DIALECT_INFO,
  KAFKA_CONNECT_KIND,
  KAFKA_KIND,
  SCRUBBED,
  debeziumMatches,
  type ConfluentConnector,
  type ConfluentReadout,
  type ConnectConnector,
  type ConnectReadout,
  type DebeziumSource,
} from '@sm/shared';
import { db } from '../db.js';
import { GuardedRegExp } from '../engine/expr.js';
import { logger } from '../log.js';
import { moduleEnabled } from '../modules/registry.js';
import { nowIso, parseJson } from '../util.js';
import { chunks, marks } from './store.js';
import { writeProposal } from './lineage/store.js';

/**
 * Lineage from connectors (0.25.0, ADR 0037 part 1): what the allow-listed configuration keys of a Kafka Connect or
 * Confluent connector say it reads and writes, matched to elements of the catalogue –
 *
 * - **Debezium source** (class `io.debezium.connector.…`, Confluent's `…CdcSource…`): table → topic. The tables of
 *   `table.include.list` (`collection.include.list`) – plain names only, a pattern is not guessed –, the topic
 *   `<topic.prefix | database.server.name>.<table>` (SQL Server: with the database), then the topic routing transforms
 *   (RegexRouter's `regex`/`replacement`, ByLogicalTableRouter's `topic.regex`/`topic.replacement`, Java's whole-match
 *   rule) in their order. Without a table list, the connector's active topics under the prefix name the tables.
 * - **Snowflake sink** (`com.snowflake.kafka.connector.…`, Confluent's `SnowflakeSink`): topic → table
 *   `<snowflake.database.name>.<snowflake.schema.name>.<table>` – the table from `snowflake.topic2table.map`, else the
 *   connector's naming rule (snowflakeTableName).
 * - **S3 sink** (`…S3SinkConnector`, Confluent's `S3_SINK`): topic → `s3://<s3.bucket.name>/<topics.dir | topics>/<topic>/`,
 *   a `files.path` element (by that qualified name, with or without `s3://` and the slash, or by its OpenLineage dataset
 *   `s3://<bucket>` + `<dir>/<topic>`); the format from `format.class`.
 *
 * Tables are elements (`sql.table`, `sql.view`) of the database platforms the Debezium link rule finds (docs/KAFKA.md),
 * topics `kafka.topic` elements of the linked Kafka platform (Kafka Connect's variable `kafkaPlatform`; a Confluent
 * cluster's Kafka platform by `confluentClusterId`), tables `snowflake.table` elements by qualified name. What no
 * element matches is named on the proposal as the connector says it.
 *
 * The edges arrive as **proposals** in the lineage inbox of 0.24.0 (origin `connector`, the platform as the source, the
 * connector as the job) – a person accepts them; nothing changes a product on its own. _Create step from connector_
 * (connector-steps.ts) uses the same ends.
 */

/** One end as the connector names it: how to find its element, and its text when none matches. */
export type ConnectorEnd =
  | { kind: 'table'; databasePlatformIds: string[]; name: string; text: string }
  | { kind: 'topic'; kafkaPlatformId: string | null; name: string; text: string }
  | { kind: 'snowflake'; name: string; text: string }
  | { kind: 's3'; bucket: string; path: string; text: string };

export type ConnectorFamily = 'debezium' | 'snowflakeSink' | 's3Sink' | 'other';

/**
 * Why a draft names an end without an element, or leaves ends out – never guessed: a table pattern of an include list, a
 * routing pattern that failed or took too long, a CDC source whose configuration names no database host (Confluent's
 * managed connectors keep none of it).
 */
export type ConnectorSkipReason = 'tablePattern' | 'routePattern' | 'noDatabaseHost';
export interface ConnectorSkip {
  reason: ConnectorSkipReason;
  /** inputs: tables left unmatched (noDatabaseHost); skipped: ends left out */
  ends: 'unmatched' | 'skipped';
  count: number;
}

export interface ConnectorDraft {
  family: ConnectorFamily;
  type: 'source' | 'sink' | 'unknown';
  /** The technology of the bridge (a key of the technology list) and its name as the proposal's tool */
  technology: string;
  tool: string;
  inputs: ConnectorEnd[];
  outputs: ConnectorEnd[];
  /** What the draft could not read (a table pattern, a routing pattern that took too long, …) – counted */
  skipped: number;
  /** Why ends are skipped or left unmatched, per reason */
  reasons: ConnectorSkip[];
}

/** A connector of either readout, as the lineage reads it. */
export interface ConnectorOf {
  platformId: string;
  platformKind: string;
  /** The job key of a proposal: the connector's name (Confluent: its id lcc-… where there is one) */
  key: string;
  name: string;
  type: 'source' | 'sink' | 'unknown';
  class: string;
  state: string;
  topics: string[];
  config: Record<string, string>;
  debezium: DebeziumSource | null;
  /** The Kafka platform its topics live on (null: none linked) */
  kafkaPlatformId: string | null;
}

// ---------- reading the configuration ----------

const list = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x && x !== SCRUBBED);

/** A plain name of an include list (`public.orders`, `public\.orders`); a pattern (`public.order_.*`) is not guessed. */
export function plainTableName(entry: string): string | null {
  const s = entry.trim().replace(/\\\./g, '.');
  return /^[A-Za-z0-9_$][A-Za-z0-9_$.-]*$/.test(s) && !s.endsWith('.') ? s : null;
}

/** Java's String.hashCode (the Snowflake connector's suffix for names that are no identifier). */
function javaHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

/**
 * The table the Snowflake Kafka connector writes a topic to without a topic-to-table map: the topic itself when it is
 * a valid unquoted identifier, else its characters outside `[_$A-Za-z0-9]` replaced by `_` (an underscore first when it
 * starts with neither a letter nor `_`) and `_<|hashCode|>` appended – the rule of the connector's Utils.generateValidName.
 */
export function snowflakeTableName(topic: string): string {
  if (/^[_A-Za-z][_$A-Za-z0-9]*$/.test(topic)) return topic;
  let out = /^[_A-Za-z]/.test(topic) ? topic[0]! : '_';
  for (let i = /^[_A-Za-z]/.test(topic) ? 1 : 0; i < topic.length; i++) out += /[_$A-Za-z0-9]/.test(topic[i]!) ? topic[i]! : '_';
  return `${out}_${Math.abs(javaHash(topic))}`;
}

/** `topic:table,topic2:table2` → a map (topic → table). */
export function topicTableMap(v: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of list(v)) {
    const i = pair.indexOf(':');
    if (i > 0 && i < pair.length - 1) out.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return out;
}

/** The routing transforms of a configuration in their order: pattern and replacement. */
function routes(config: Record<string, string>): { regex: string; replacement: string }[] {
  const out: { regex: string; replacement: string }[] = [];
  for (const n of list(config.transforms)) {
    const regex = config[`transforms.${n}.topic.regex`] ?? config[`transforms.${n}.regex`];
    const replacement = config[`transforms.${n}.topic.replacement`] ?? config[`transforms.${n}.replacement`];
    if (regex && replacement !== undefined) out.push({ regex, replacement });
  }
  return out;
}

/** Longest routing pattern read (a router's pattern is short; anything longer is not guessed). */
const ROUTE_PATTERN_MAX = 300;

/**
 * A topic after the routing transforms: a pattern that matches the whole topic (Java's Matcher.matches) replaces it
 * with the replacement, `$1` … `$9` its groups. Patterns run through the expression engine's ReDoS guard (a worker with
 * a time limit); one that fails or takes too long leaves the topic unrouted and counts as skipped.
 */
export function routeTopic(topic: string, rs: readonly { regex: string; replacement: string }[], skipped: { n: number }): string {
  let t = topic;
  for (const r of rs) {
    if (r.regex.length > ROUTE_PATTERN_MAX) {
      skipped.n++;
      continue;
    }
    let m: RegExpExecArray | null;
    try {
      m = new GuardedRegExp(`^(?:${r.regex})$`, '').exec(t);
    } catch (e) {
      skipped.n++;
      logger.debug({ err: (e as Error).message }, 'a connector routing pattern was not applied');
      continue;
    }
    if (!m) continue;
    const groups = m;
    t = r.replacement.replace(/\$(\d)/g, (_x, d: string) => groups[Number(d)] ?? '');
  }
  return t;
}

const CDC_CLASS = /cdcsource/i;
const SNOWFLAKE_CLASS = /snowflake/i;
const S3_CLASS = /(^|\.)s3(_|sink|\.)|S3Sink/i;

/** What a connector is, by its class and type. */
export function familyOf(c: Pick<ConnectorOf, 'class' | 'type' | 'debezium'>): ConnectorFamily {
  if (c.type !== 'sink' && (c.class.startsWith('io.debezium.connector.') || CDC_CLASS.test(c.class))) return 'debezium';
  if (c.type === 'sink' && SNOWFLAKE_CLASS.test(c.class)) return 'snowflakeSink';
  if (c.type === 'sink' && S3_CLASS.test(c.class)) return 's3Sink';
  return 'other';
}

const FORMATS: [RegExp, string][] = [
  [/parquet/i, 'parquet'],
  [/avro/i, 'avro'],
  [/json/i, 'json'],
  [/csv/i, 'csv'],
  [/bytearray/i, 'bytes'],
];
const formatOf = (cls: string | undefined): string | null => (cls ? (FORMATS.find(([re]) => re.test(cls))?.[1] ?? null) : null);

/**
 * The ends of a connector by its family (see the module's comment). `databasePlatformIds`: the database platforms the
 * Debezium link rule finds for it (read by the caller).
 */
export function connectorDraft(c: ConnectorOf, databasePlatformIds: readonly string[] = []): ConnectorDraft {
  const family = familyOf(c);
  const confluent = c.platformKind === CONFLUENT_KIND;
  const skipped = { n: 0 };
  const topicEnd = (name: string): ConnectorEnd => ({ kind: 'topic', kafkaPlatformId: c.kafkaPlatformId, name, text: name });
  const configTopics = list(c.config.topics);
  const topics = [...new Set([...c.topics, ...configTopics])];
  const technology = family === 'debezium' ? 'debezium' : confluent ? 'confluent' : 'kafka-connect';
  const tool = family === 'debezium' ? 'Debezium' : confluent ? 'Confluent' : 'Kafka Connect';
  const base = { family, type: c.type, technology, tool };
  const reasons: ConnectorSkip[] = [];
  const because = (reason: ConnectorSkipReason, ends: ConnectorSkip['ends'], count: number) => count > 0 && reasons.push({ reason, ends, count });
  if (family === 'debezium') {
    const prefix = c.config['topic.prefix'] ?? c.config['database.server.name'] ?? null;
    const rs = routes(c.config);
    const listed = [...list(c.config['table.include.list']), ...list(c.config['collection.include.list'])];
    const tables = listed.map(plainTableName);
    because('tablePattern', 'skipped', tables.filter((t) => t === null).length);
    skipped.n += tables.filter((t) => t === null).length;
    // SQL Server names the database in its topics: <prefix>.<database>.<schema>.<table>
    const db = c.debezium?.dbms === 'sqlserver' && c.debezium.databases.length === 1 ? c.debezium.databases[0]! : null;
    // no database host in the configuration (Confluent's managed CDC sources): the tables are named, never matched
    const noHost = !c.debezium;
    const pairs: { table: string; topic: string }[] = [];
    const before = skipped.n;
    if (prefix)
      for (const t of tables.filter((x): x is string => !!x)) pairs.push({ table: t, topic: routeTopic(`${prefix}.${db ? `${db}.` : ''}${t}`, rs, skipped) });
    because('routePattern', 'skipped', skipped.n - before);
    // no table list (or only patterns): the active topics under the prefix name the tables – not with routing, which
    // cannot be read backwards
    if (!pairs.length && prefix && !rs.length)
      for (const topic of topics) {
        const rest = topic.startsWith(`${prefix}.`) ? topic.slice(prefix.length + 1) : null;
        const table = rest && db && rest.toLowerCase().startsWith(`${db.toLowerCase()}.`) ? rest.slice(db.length + 1) : rest;
        if (table && table.includes('.')) pairs.push({ table, topic });
      }
    const tableNames = [...new Set(pairs.map((p) => p.table))];
    if (noHost) because('noDatabaseHost', 'unmatched', tableNames.length);
    return {
      ...base,
      inputs: tableNames.map((t) => ({
        kind: 'table',
        databasePlatformIds: noHost ? [] : [...databasePlatformIds],
        name: t,
        text: noHost ? `${t} (no database host in the connector's configuration)` : t,
      })),
      outputs: [...new Set(pairs.map((p) => p.topic))].map(topicEnd),
      skipped: skipped.n,
      reasons,
    };
  }
  if (family === 'snowflakeSink') {
    const map = topicTableMap(c.config['snowflake.topic2table.map']);
    const database = c.config['snowflake.database.name'];
    const schema = c.config['snowflake.schema.name'];
    return {
      ...base,
      inputs: topics.map(topicEnd),
      outputs: topics.map((t) => {
        const table = map.get(t) ?? snowflakeTableName(t);
        const name = database && schema ? `${database}.${schema}.${table}` : table;
        return { kind: 'snowflake', name, text: name };
      }),
      skipped: 0,
      reasons,
    };
  }
  if (family === 's3Sink') {
    const bucket = c.config['s3.bucket.name'];
    const dir = (c.config['topics.dir'] ?? 'topics').replace(/^\/+|\/+$/g, '');
    // Kafka Connect's format class, or the output format of Confluent's managed sink
    const format = formatOf(c.config['format.class'] ?? c.config['output.data.format']);
    return {
      ...base,
      inputs: topics.map(topicEnd),
      outputs: bucket
        ? topics.map((t) => {
            const path = `${dir ? `${dir}/` : ''}${t}`;
            return { kind: 's3', bucket, path, text: `s3://${bucket}/${path}/${format ? ` (${format})` : ''}` };
          })
        : [],
      skipped: 0,
      reasons,
    };
  }
  // another connector: a source writes its topics, a sink reads them (what it writes is not known)
  return { ...base, inputs: c.type === 'sink' ? topics.map(topicEnd) : [], outputs: c.type === 'source' ? topics.map(topicEnd) : [], skipped: 0, reasons };
}

// ---------- matching ends to elements ----------

export interface MatchedEnds {
  inputs: string[];
  outputs: string[];
  unmatchedInputs: string[];
  unmatchedOutputs: string[];
}

/**
 * The elements of these ends (one statement per kind of end and chunk): tables of the database platforms, topics of
 * the Kafka platform, Snowflake tables by qualified name, `files.path` by name or OpenLineage dataset. At most five
 * elements per end (as the OpenLineage matching).
 */
export function matchEnds(draft: Pick<ConnectorDraft, 'inputs' | 'outputs'>): MatchedEnds {
  const ends = [...draft.inputs, ...draft.outputs];
  const found = new Map<ConnectorEnd, string[]>();
  const add = (e: ConnectorEnd, id: string) => {
    const l = found.get(e) ?? [];
    if (l.length < 5 && !l.includes(id)) l.push(id);
    found.set(e, l);
  };
  // tables of database platforms
  const tables = ends.filter((e): e is Extract<ConnectorEnd, { kind: 'table' }> => e.kind === 'table' && e.databasePlatformIds.length > 0);
  const tablePlatforms = [...new Set(tables.flatMap((e) => e.databasePlatformIds))];
  if (tables.length)
    for (const part of chunks([...new Set(tables.map((e) => e.name.toLowerCase()))], 400))
      for (const r of db().all<{ id: string; platform_id: string; name_norm: string }>(
        `SELECT id, platform_id, name_norm FROM dp_elements WHERE kind IN ('sql.table', 'sql.view') AND platform_id IN (${marks(tablePlatforms.length)})
           AND name_norm IN (${marks(part.length)}) ORDER BY id`,
        ...tablePlatforms,
        ...part,
      ))
        for (const e of tables) if (e.name.toLowerCase() === r.name_norm && e.databasePlatformIds.includes(r.platform_id)) add(e, r.id);
  // topics of the Kafka platform
  const topics = ends.filter((e): e is Extract<ConnectorEnd, { kind: 'topic' }> => e.kind === 'topic' && !!e.kafkaPlatformId);
  const kafkaIds = [...new Set(topics.map((e) => e.kafkaPlatformId!))];
  if (topics.length)
    for (const part of chunks([...new Set(topics.map((e) => e.name.toLowerCase()))], 400))
      for (const r of db().all<{ id: string; platform_id: string; name_norm: string }>(
        `SELECT id, platform_id, name_norm FROM dp_elements WHERE kind = 'kafka.topic' AND platform_id IN (${marks(kafkaIds.length)}) AND name_norm IN (${marks(part.length)}) ORDER BY id`,
        ...kafkaIds,
        ...part,
      ))
        for (const e of topics) if (e.name.toLowerCase() === r.name_norm && e.kafkaPlatformId === r.platform_id) add(e, r.id);
  // Snowflake tables by qualified name (any Snowflake platform)
  const sf = ends.filter((e): e is Extract<ConnectorEnd, { kind: 'snowflake' }> => e.kind === 'snowflake');
  if (sf.length)
    for (const part of chunks([...new Set(sf.map((e) => e.name.toLowerCase()))], 400))
      for (const r of db().all<{ id: string; name_norm: string }>(
        `SELECT id, name_norm FROM dp_elements WHERE kind = 'snowflake.table' AND name_norm IN (${marks(part.length)}) ORDER BY id`,
        ...part,
      ))
        for (const e of sf) if (e.name.toLowerCase() === r.name_norm) add(e, r.id);
  // files.path by qualified name or OpenLineage dataset
  const s3 = ends.filter((e): e is Extract<ConnectorEnd, { kind: 's3' }> => e.kind === 's3');
  if (s3.length) {
    const names = (e: Extract<ConnectorEnd, { kind: 's3' }>) => {
      const p = `${e.bucket}/${e.path}`.toLowerCase();
      return [`s3://${p}`, `s3://${p}/`, p, `${p}/`];
    };
    const all = [...new Set(s3.flatMap(names))];
    for (const part of chunks(all, 400))
      for (const r of db().all<{ id: string; name_norm: string }>(
        `SELECT id, name_norm FROM dp_elements WHERE kind = 'files.path' AND name_norm IN (${marks(part.length)}) ORDER BY id`,
        ...part,
      ))
        for (const e of s3) if (names(e).includes(r.name_norm)) add(e, r.id);
    const namespaces = [...new Set(s3.map((e) => `s3://${e.bucket.toLowerCase()}`))];
    for (const part of chunks([...new Set(s3.flatMap((e) => [e.path, `${e.path}/`]))], 400))
      for (const r of db().all<{ id: string; ol_namespace: string; ol_name: string }>(
        `SELECT id, ol_namespace, ol_name FROM dp_elements WHERE kind = 'files.path' AND lower(ol_namespace) IN (${marks(namespaces.length)}) AND ol_name IN (${marks(part.length)}) ORDER BY id`,
        ...namespaces,
        ...part,
      ))
        for (const e of s3)
          if (`s3://${e.bucket.toLowerCase()}` === r.ol_namespace.toLowerCase().replace(/\/+$/, '') && [e.path, `${e.path}/`].includes(r.ol_name)) add(e, r.id);
  }
  const side = (xs: ConnectorEnd[]) => ({
    ids: [...new Set(xs.flatMap((e) => found.get(e) ?? []))],
    unmatched: [...new Set(xs.filter((e) => !found.get(e)?.length).map((e) => e.text))],
  });
  const i = side(draft.inputs);
  const o = side(draft.outputs);
  return { inputs: i.ids, outputs: o.ids.filter((x) => !i.ids.includes(x)), unmatchedInputs: i.unmatched, unmatchedOutputs: o.unmatched };
}

// ---------- the connectors of a platform ----------

interface PlatformRow {
  id: string;
  name: string;
  kind: string;
  config: string;
}

type PlatformConfig = { variables?: Record<string, unknown>; database?: { dialect: string; host: string; port?: number | null; database?: string | null } };

/** The Kafka platform a Kafka Connect platform names (variable kafkaPlatform: an id or a name). */
function kafkaOfConnect(p: PlatformRow, kafka: readonly PlatformRow[]): string | null {
  const ref = String(parseJson<PlatformConfig>(p.config, {}).variables?.kafkaPlatform ?? '').trim();
  if (!ref) return null;
  return (kafka.find((k) => k.id === ref) ?? kafka.find((k) => k.name.toLowerCase() === ref.toLowerCase()))?.id ?? null;
}

/** The Kafka platforms by the Confluent cluster their variable confluentClusterId names (the first by name). */
function kafkaByCluster(kafka: readonly PlatformRow[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const k of kafka) {
    const cluster = String(parseJson<PlatformConfig>(k.config, {}).variables?.confluentClusterId ?? '').trim();
    if (cluster && !out.has(cluster)) out.set(cluster, k.id);
  }
  return out;
}

/**
 * The connectors of a Kafka Connect or Confluent platform from its stored readout (no request to the platform), each
 * with the Kafka platform of its topics. Whoever may see what is decided by the caller.
 */
export function connectorsOf(platformId: string): ConnectorOf[] {
  const p = db().get<PlatformRow>('SELECT id, name, kind, config FROM platforms WHERE id = ?', platformId);
  if (!p || (p.kind !== KAFKA_CONNECT_KIND && p.kind !== CONFLUENT_KIND)) return [];
  const kafka = db().all<PlatformRow>('SELECT id, name, kind, config FROM platforms WHERE kind = ? ORDER BY name', KAFKA_KIND);
  if (p.kind === KAFKA_CONNECT_KIND) {
    const r = db().get<{ readout: string }>('SELECT readout FROM kafka_connect_readouts WHERE platform_id = ?', platformId);
    const readout = parseJson<ConnectReadout | null>(r?.readout, null);
    const kafkaId = kafkaOfConnect(p, kafka);
    return (readout?.connectors ?? []).map((c: ConnectConnector) => ({
      platformId,
      platformKind: p.kind,
      key: c.name,
      name: c.name,
      type: c.type,
      class: c.class,
      state: c.state,
      topics: c.topics,
      config: c.config ?? {},
      debezium: c.debezium,
      kafkaPlatformId: kafkaId,
    }));
  }
  const r = db().get<{ readout: string }>('SELECT readout FROM confluent_readouts WHERE platform_id = ?', platformId);
  const readout = parseJson<ConfluentReadout | null>(r?.readout, null);
  const byCluster = kafkaByCluster(kafka);
  return (readout?.connectors ?? []).map((c: ConfluentConnector) => ({
    platformId,
    platformKind: p.kind,
    key: c.id || c.name,
    name: c.name,
    type: c.type,
    class: c.class,
    state: c.state,
    topics: c.topics,
    config: c.config ?? {},
    debezium: null,
    kafkaPlatformId: byCluster.get(c.clusterId) ?? null,
  }));
}

/** The database platforms the Debezium link rule finds for a source (docs/KAFKA.md#links-topics-databases-systems). */
export function databasePlatformsOf(src: DebeziumSource | null, rows?: PlatformRow[]): string[] {
  if (!src) return [];
  const platforms = rows ?? db().all<PlatformRow>('SELECT id, name, kind, config FROM platforms WHERE kind = ? ORDER BY name', DATABASE_KIND);
  return platforms
    .filter((p) => {
      const d = parseJson<PlatformConfig>(p.config, {}).database;
      if (!d) return false;
      const port = d.port ?? DB_DIALECT_INFO[d.dialect as keyof typeof DB_DIALECT_INFO]?.port ?? 0;
      return debeziumMatches(src, { dialect: d.dialect, host: d.host, port, database: d.database ?? '' });
    })
    .map((p) => p.id);
}

/** The draft of one connector with its database platforms looked up. */
export function draftOf(c: ConnectorOf, dbRows?: PlatformRow[]): ConnectorDraft {
  return connectorDraft(c, familyOf(c) === 'debezium' ? databasePlatformsOf(c.debezium, dbRows) : []);
}

// ---------- proposals ----------

/**
 * Proposes the lineage of the connectors of a platform after a readout (the hourly job, _Read now_): one proposal per
 * Debezium source, Snowflake sink and S3 sink (job: the connector; the platform is the source) in the inbox of lineage
 * from tools. While the data products module is off nothing is proposed (`force`: the demo, whose module may be off
 * yet). Returns how many proposals were added or changed.
 */
export function proposeFromConnectors(platformId: string, opts: { now?: string; force?: boolean } = {}): number {
  if (!opts.force && !moduleEnabled('dataProducts')) return 0;
  const now = opts.now ?? nowIso();
  const connectors = connectorsOf(platformId).filter((c) => familyOf(c) !== 'other');
  if (!connectors.length) return 0;
  const dbRows = db().all<PlatformRow>('SELECT id, name, kind, config FROM platforms WHERE kind = ? ORDER BY name', DATABASE_KIND);
  let n = 0;
  db().tx(() => {
    for (const c of connectors) {
      const d = draftOf(c, dbRows);
      if (!d.outputs.length) continue;
      const m = matchEnds(d);
      const w = writeProposal(
        {
          origin: 'connector',
          sourceId: platformId,
          key: c.key,
          name: c.name,
          kind: 'bridge',
          tool: d.tool,
          inputs: m.inputs,
          outputs: m.outputs,
          unmatchedInputs: m.unmatchedInputs,
          unmatchedOutputs: m.unmatchedOutputs,
          run: null,
        },
        now,
      );
      if (w?.changed) n++;
    }
  });
  return n;
}
