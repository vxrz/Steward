import { scrubString, SCRUBBED } from './scrub.js';

/**
 * Kafka Connect (0.9.0, #223, docs/KAFKA.md#kafka-connect-and-debezium): Steward watches the connectors and tasks of a
 * Kafka Connect cluster through its REST API, read-only – it never creates, changes, restarts, pauses or resumes a
 * connector. A platform of kind kafka-connect names the REST API as its base URL and its Kafka platform (variable
 * `kafkaPlatform`, the name or id of a platform of kind kafka). Connector configurations hold credentials: every
 * answer of the kind has its secret-looking values removed before Steward uses it (redactConnectAnswer), and Steward
 * never stores a configuration.
 */

export const KAFKA_CONNECT_KIND = 'kafka-connect';

/** The states of a connector and of a task (Kafka Connect REST API, GET /connectors/{name}/status). */
export const CONNECT_STATES = ['RUNNING', 'PAUSED', 'STOPPED', 'FAILED', 'UNASSIGNED', 'RESTARTING'] as const;
export type ConnectState = (typeof CONNECT_STATES)[number];

export const KAFKA_CONNECT_LIMITS = {
  /** Connectors read per cluster */
  connectors: 500,
  /** Connectors whose active topics are read one by one (the others: the topics of their configuration) */
  topicReads: 200,
  /** Plugins listed */
  plugins: 500,
  /** Topics kept per connector */
  topics: 200,
  /** An error trace is cut to this many lines and characters */
  traceLines: 12,
  traceChars: 2000,
  /** Timeout of one request (ms) */
  timeoutMs: 20_000,
  /** The job reads each Kafka Connect platform again after this many minutes (or on "Read now") */
  refreshMinutes: 60,
} as const;

export interface ConnectTask {
  id: number;
  state: string;
  /** host:port of the worker the task runs on */
  workerId: string;
  /** The error of a failed task: trimmed, secret-looking values removed; null otherwise */
  trace: string | null;
  /** Since when Steward saw the task FAILED (null: not failed) */
  failedSince: string | null;
}

/** What a Debezium source connector reads (its configuration, by the rule in debeziumSource). */
export interface DebeziumSource {
  /** postgresql, mysql, sqlserver, oracle, db2, mongodb, mariadb … (from the connector class) */
  dbms: string;
  host: string;
  port: number | null;
  /** The database(s) named in the configuration; empty: none named (MySQL reads the whole server) */
  databases: string[];
}

export interface ConnectConnector {
  name: string;
  type: 'source' | 'sink' | 'unknown';
  /** connector.class */
  class: string;
  /** The version of its plugin (GET /connector-plugins), null when the plugin is not listed */
  version: string | null;
  state: string;
  workerId: string;
  /** The error of a failed connector, trimmed and redacted like a task's */
  trace: string | null;
  /** The topics it uses (the active topics Kafka Connect tracks, else the topics of its configuration) */
  topics: string[];
  tasks: ConnectTask[];
  /** Sink connectors: the consumer group whose lag is read on the Kafka platform (connect-<name> unless overridden) */
  groupId: string | null;
  /** Debezium source connectors: the database it reads */
  debezium: DebeziumSource | null;
}

export interface ConnectPlugin {
  class: string;
  type: string;
  version: string;
}

/** What Steward last read from a Kafka Connect cluster – no configuration, kept per platform. */
export interface ConnectReadout {
  readAt: string;
  /** null: read; else why not (the last connectors stay) */
  error: string | null;
  worker: { version: string; commit: string; kafkaClusterId: string } | null;
  connectors: ConnectConnector[];
  plugins: ConnectPlugin[];
}

/** A connector as the platform page shows it: the readout with its links, only those the reader may see. */
export interface ConnectConnectorView extends ConnectConnector {
  /** Kafka topic components (of applications the reader may see) of the linked Kafka platform, per topic */
  topicComponents: { topic: string; applicationId: string; applicationName: string; componentId: string }[];
  /** Debezium: the database platform and the system it reads (null: none matched, or one the reader may not see) */
  database: { platform: { id: string; name: string } | null; system: { id: string; name: string } | null } | null;
}

export interface ConnectView {
  platformId: string;
  /** The linked Kafka platform (null: none set, not found, or one the reader may not see) */
  kafkaPlatform: { id: string; name: string } | null;
  /** The variable kafkaPlatform is set but names no platform of kind kafka the reader may see */
  kafkaPlatformMissing: boolean;
  readout: ConnectReadout | null;
  connectors: ConnectConnectorView[];
  canRead: boolean;
}

/** A Kafka topic component's connectors (#223), on the application page: Kafka Connect platforms the reader may see. */
export interface TopicConnectorRef {
  platformId: string;
  platformName: string;
  connector: string;
  type: 'source' | 'sink' | 'unknown';
  state: string;
}

// ---------- removing secrets from answers ----------

/** Parts of a configuration key that mark a secret (compared with the key's words, lower case). */
const SECRET_WORDS = ['password', 'passwd', 'pwd', 'secret', 'token', 'credential', 'credentials', 'passphrase', 'apikey', 'jaas', 'privatekey', 'userinfo'];
/** Substrings that mark a secret anywhere in a key. */
const SECRET_PARTS = [
  'password',
  'passwd',
  'secret',
  'token',
  'credential',
  'passphrase',
  'api.key',
  'api_key',
  'api-key',
  'apikey',
  'private.key',
  'private_key',
  'privatekey',
  'user.info',
  'userinfo',
  'jaas',
];
/** Keys whose value is never a secret – structure that Steward reads (and shows) as it is. */
const STRUCTURAL_KEYS = new Set([
  'name',
  'type',
  'state',
  'worker_id',
  'class',
  'version',
  'connector.class',
  'topics',
  'topics.regex',
  'topic.prefix',
  'tasks.max',
  'database.hostname',
  'database.port',
  'database.dbname',
  'database.names',
  'database.include.list',
  'database.server.name',
  'kafka_cluster_id',
  'commit',
]);

/**
 * A configuration key whose value is a secret: a fixed list (password, secret, token, key, credentials,
 * sasl.jaas.config, user info, API and private keys …) compared by words – "ssl.key.password", "aws.secret.access.key",
 * "basic.auth.user.info", "api.key" are; "key.converter" and "primary.key.mode" are not.
 */
export function isConnectSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  if (k === 'sasl.jaas.config') return true;
  if (SECRET_PARTS.some((p) => k.includes(p))) return true;
  const words = k.split(/[._-]/).filter(Boolean);
  if (words.some((w) => SECRET_WORDS.includes(w))) return true;
  const last = words[words.length - 1];
  // proxy.auth (user:password), the request headers of an HTTP sink (Authorization: …) – 0.9.0
  return last === 'key' || last === 'pass' || last === 'auth' || last === 'headers';
}

const SECRET_PAIR_WORDS = ['password', 'passwd', 'pwd', 'secret', 'token', 'apikey', 'api_key', 'accesskey', 'access_key', 'authorization'];
const PAIR_END = new Set([';', '&', ',', ' ', '\t', '\n', '\r', '"', "'", '}', ')']);

/** key=value or key:value pairs with a secret word as key: the value becomes *** (a scan, no regular expression). */
function maskPairs(s: string): string {
  const lower = s.toLowerCase();
  let out = '';
  let i = 0;
  while (i < s.length) {
    let hit = -1;
    let len = 0;
    for (const w of SECRET_PAIR_WORDS) {
      const at = lower.indexOf(w, i);
      if (at >= 0 && (hit < 0 || at < hit)) {
        hit = at;
        len = w.length;
      }
    }
    if (hit < 0) break;
    let j = hit + len;
    while (j < s.length && (s[j] === ' ' || s[j] === '"' || s[j] === "'")) j++;
    if (s[j] !== '=' && s[j] !== ':') {
      out += s.slice(i, hit + len);
      i = hit + len;
      continue;
    }
    j++;
    while (j < s.length && (s[j] === ' ' || s[j] === '"' || s[j] === "'")) j++;
    let end = j;
    while (end < s.length && !PAIR_END.has(s[end]!)) end++;
    out += s.slice(i, j) + (end > j ? SCRUBBED : '');
    i = end;
  }
  return out + s.slice(i);
}

/** scheme://user:password@host → scheme://user:***@host (string functions only). */
function maskUrlPasswords(s: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const at = s.indexOf('://', i);
    if (at < 0) break;
    const start = at + 3;
    let end = start;
    while (end < s.length && !'/?#\\ \t\n"\''.includes(s[end]!)) end++;
    const authority = s.slice(start, end);
    const atSign = authority.lastIndexOf('@');
    const colon = atSign > 0 ? authority.indexOf(':') : -1;
    out += s.slice(i, start);
    out += colon >= 0 && colon < atSign ? `${authority.slice(0, colon + 1)}${SCRUBBED}${authority.slice(atSign)}` : authority;
    i = end;
  }
  return out + s.slice(i);
}

/** Characters that end a credential in running text (a header list "a:b|c:d", JSON, a properties line). */
const CREDENTIAL_END = new Set([' ', '\t', '\n', '\r', '|', ',', ';', '"', "'", '}', ')', ']', '&', '<', '>']);
const AUTH_SCHEMES = ['bearer', 'basic', 'digest', 'negotiate'];

/** "Bearer <token>", "Basic <base64>" (after a space, a colon or an equals sign): the credential becomes *** (a scan). */
function maskAuthSchemes(s: string): string {
  const lower = s.toLowerCase();
  let out = '';
  let i = 0;
  while (i < s.length) {
    let hit = -1;
    let len = 0;
    for (const w of AUTH_SCHEMES) {
      const at = lower.indexOf(w, i);
      if (at >= 0 && (hit < 0 || at < hit)) {
        hit = at;
        len = w.length;
      }
    }
    if (hit < 0) break;
    const before = hit === 0 ? ' ' : s[hit - 1]!;
    let j = hit + len;
    const sep = s[j];
    // a word of its own, followed by a space, ":" or "="
    if (/[A-Za-z0-9_]/.test(before) || (sep !== ' ' && sep !== ':' && sep !== '=')) {
      out += s.slice(i, j);
      i = j;
      continue;
    }
    while (j < s.length && (s[j] === ' ' || s[j] === ':' || s[j] === '=')) j++;
    let end = j;
    while (end < s.length && !CREDENTIAL_END.has(s[end]!)) end++;
    const cred = s.slice(j, end);
    // a credential, not a word of a sentence ("basic tier"): 6+ characters with a digit, a capital or + / = . _ -
    if (cred.length < 6 || !/[0-9A-Z+/=._-]/.test(cred)) {
      out += s.slice(i, j);
      i = j;
      continue;
    }
    out += s.slice(i, j) + SCRUBBED;
    i = end;
  }
  return out + s.slice(i);
}

/**
 * Credentials before an "@" without "://": JDBC URLs such as jdbc:oracle:thin:scott/tiger@//db:1521/ORCL (user/password
 * or user:password after the last ":" of the jdbc: prefix) and a bare user:password@host. The password becomes ***.
 */
function maskAtCredentials(s: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const at = s.indexOf('@', i);
    if (at < 0) break;
    // the run before the "@" (back to a space, quote, ";", "," or "=")
    let start = at;
    while (start > i && !' \t\n\r"\';,=('.includes(s[start - 1]!)) start--;
    const run = s.slice(start, at);
    let masked = run;
    if (!run.includes('://')) {
      const jdbc = run.toLowerCase().startsWith('jdbc:');
      const colon = run.lastIndexOf(':');
      const cred = jdbc ? run.slice(colon + 1) : run;
      const slash = cred.indexOf('/');
      const credStart = run.length - cred.length;
      if (jdbc && slash > 0 && slash < cred.length - 1) masked = run.slice(0, credStart + slash + 1) + SCRUBBED;
      else if (jdbc && slash < 0 && cred && run.slice(0, colon).split(':').length > 3) masked = run.slice(0, colon + 1) + SCRUBBED;
      else if (!jdbc) {
        const c = run.indexOf(':');
        if (c > 0 && c < run.length - 1 && run.indexOf(':', c + 1) < 0 && !run.includes('/')) masked = run.slice(0, c + 1) + SCRUBBED;
      }
    }
    out += s.slice(i, start) + masked + '@';
    i = at + 1;
  }
  return out + s.slice(i);
}

/** Every pattern of a value: passwords in URLs, JDBC URLs, user:password@, authorization schemes and secret pairs. */
function maskCredentials(s: string): string {
  return maskPairs(maskAuthSchemes(maskAtCredentials(maskUrlPasswords(s))));
}

/** A private key (PEM) or a JSON Web Token. */
function isKeyOrJwt(v: string): boolean {
  return v.includes('-----BEGIN') || (v.startsWith('eyJ') && v.split('.').length === 3 && v.length > 20);
}

const TOKEN_CHARS = /^[A-Za-z0-9+/=_-]+$/;

/** A long random-looking string (key, token, hash) or a JSON Web Token. */
function looksLikeToken(v: string): boolean {
  if (v.startsWith('eyJ') && v.split('.').length === 3 && v.length > 20) return true;
  if (v.length < 32 || !TOKEN_CHARS.test(v) || !/\d/.test(v)) return false;
  // mixed case (Base64, Base64url) or hexadecimal; lower-case names with digits ("orders-sink-2024-v2-…") are not
  return (/[a-z]/.test(v) && /[A-Z]/.test(v)) || /^[0-9a-fA-F]+$/.test(v);
}

/** A configuration provider reference such as ${file:/opt/connect/secrets.properties:db.password}: no secret itself. */
export function isConfigReference(v: string): boolean {
  if (!v.startsWith('${') || !v.endsWith('}') || v.length > 500) return false;
  const inner = v.slice(2, -1);
  return inner.includes(':') && !inner.includes('{') && !inner.includes('}') && !/\s/.test(inner);
}

/**
 * One configuration value as Steward shows it: *** when the key looks secret (configuration provider references stay),
 * else with the value heuristics applied – private keys (PEM), JSON Web Tokens and long random strings become ***,
 * passwords in URLs (scheme://user:***@host) and in key=value pairs (password=***) are masked.
 */
export function redactConnectValue(key: string, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (isConfigReference(value.trim())) return value;
  if (isConnectSecretKey(key)) return value === '' ? value : SCRUBBED;
  if (STRUCTURAL_KEYS.has(key.toLowerCase())) return value;
  const t = value.trim();
  if (t.includes('-----BEGIN') || looksLikeToken(t)) return SCRUBBED;
  return maskCredentials(value);
}

/** The values under secret keys of an answer (at least 4 characters): removed from error traces too. */
function secretValuesOf(v: unknown, out: Set<string>, depth = 0): void {
  if (depth > 32 || !v || typeof v !== 'object') return;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (typeof x === 'string') {
      if (x.length >= 4 && !isConfigReference(x.trim()) && (isConnectSecretKey(k) || looksLikeToken(x.trim()))) out.add(x);
    } else secretValuesOf(x, out, depth + 1);
  }
}

/**
 * An error trace as Steward shows it: the first KAFKA_CONNECT_LIMITS.traceLines lines, at most traceChars characters,
 * the given secret values and everything that looks like a credential (passwords in URLs and pairs, tokens, keys,
 * e-mail and IP addresses) masked.
 */
export function trimTrace(trace: string, secrets: Iterable<string> = []): string {
  const lines = trace.replace(/\r\n?/g, '\n').split('\n');
  let cut = lines.slice(0, KAFKA_CONNECT_LIMITS.traceLines).join('\n');
  const more = lines.length > KAFKA_CONNECT_LIMITS.traceLines;
  if (cut.length > KAFKA_CONNECT_LIMITS.traceChars) cut = cut.slice(0, KAFKA_CONNECT_LIMITS.traceChars);
  // known values first (on the whole text), then the patterns
  let out = cut;
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) if (s.length >= 4 && out.includes(s)) out = out.split(s).join(SCRUBBED);
  out = scrubString(maskCredentials(out));
  return more || trace.length > cut.length ? `${out}\n…` : out;
}

/**
 * Every answer of a Kafka Connect platform before Steward uses, shows, stores or logs it (platforms/deniedPaths.ts):
 * values of secret-looking keys become *** at any depth, the value heuristics apply to every other string, and error
 * traces (keys "trace") are trimmed and have the configuration's secret values of the same answer removed.
 */
export function redactConnectAnswer<T>(body: T): T {
  const secrets = new Set<string>();
  secretValuesOf(body, secrets);
  const walk = (x: unknown, depth: number): unknown => {
    if (depth > 64) return null;
    // list entries (connector names, topics) lose private keys and JSON Web Tokens and the credentials in URLs and pairs
    if (Array.isArray(x)) return x.map((v) => (typeof v === 'string' ? (isKeyOrJwt(v.trim()) ? SCRUBBED : maskCredentials(v)) : walk(v, depth + 1)));
    if (x && typeof x === 'object') {
      const out: [string, unknown][] = [];
      for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        if (k === 'trace' && typeof v === 'string') out.push([k, trimTrace(v, secrets)]);
        else if (typeof v === 'string') out.push([k, redactConnectValue(k, v)]);
        else out.push([k, walk(v, depth + 1)]);
      }
      return Object.fromEntries(out);
    }
    if (typeof x === 'string') return redactConnectValue('', x);
    return x;
  };
  return walk(body, 0) as T;
}

// ---------- Debezium ----------

const DEBEZIUM_PREFIX = 'io.debezium.connector.';
const DEFAULT_PORTS: Record<string, number> = { postgresql: 5432, mysql: 3306, mariadb: 3306, sqlserver: 1433, oracle: 1521, db2: 50000, informix: 9088 };

/** The Steward database dialect a Debezium DBMS matches (null: none of Steward's database platforms). */
export function debeziumDialect(dbms: string): string | null {
  return dbms === 'postgresql' ? 'postgresql' : dbms === 'mysql' || dbms === 'mariadb' ? 'mysql' : dbms === 'sqlserver' ? 'sqlserver' : null;
}

const list = (v: unknown): string[] =>
  typeof v === 'string'
    ? v
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x && x !== SCRUBBED)
    : [];

/**
 * What a Debezium source connector reads, from its class and configuration: the DBMS is the part after
 * io.debezium.connector. (postgresql, mysql, sqlserver, …), the host database.hostname, the port database.port (else
 * the DBMS's default), the databases database.dbname (PostgreSQL, Oracle, Db2), database.names (SQL Server) or
 * database.include.list (MySQL, MariaDB). Null for other connectors and without a host.
 */
export function debeziumSource(cls: string, config: Record<string, unknown>): DebeziumSource | null {
  if (!cls.startsWith(DEBEZIUM_PREFIX)) return null;
  const dbms = cls.slice(DEBEZIUM_PREFIX.length).split('.')[0]!.toLowerCase();
  const host = typeof config['database.hostname'] === 'string' ? config['database.hostname'].trim() : '';
  if (!dbms || !host || host === SCRUBBED) return null;
  const port = Number(config['database.port']);
  const databases = [...list(config['database.dbname']), ...list(config['database.names']), ...list(config['database.include.list'])];
  return { dbms, host, port: Number.isInteger(port) && port > 0 && port < 65536 ? port : (DEFAULT_PORTS[dbms] ?? null), databases: [...new Set(databases)] };
}

/** Host names compared: lower case, without a trailing dot. */
export const sameHost = (a: string, b: string): boolean => a.trim().toLowerCase().replace(/\.$/, '') === b.trim().toLowerCase().replace(/\.$/, '');

/**
 * Whether a database platform's connection is the database a Debezium connector reads: the dialect fits, host and port
 * are the same, and – when the connector names databases – the platform's database is one of them.
 */
export function debeziumMatches(src: DebeziumSource, db: { dialect: string; host: string; port: number; database: string }): boolean {
  if (debeziumDialect(src.dbms) !== db.dialect || !sameHost(src.host, db.host)) return false;
  if (src.port !== null && src.port !== db.port) return false;
  return !src.databases.length || src.databases.some((d) => d.toLowerCase() === db.database.toLowerCase());
}
