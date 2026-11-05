import crypto from 'node:crypto';
import net from 'node:net';
import {
  DATABASE_KIND,
  DB_DIALECT_INFO,
  DB_LIMITS,
  databaseSettingsSchema,
  dbPort,
  effectiveDbLimits,
  readOnlyStatementProblem,
  type CheckOf,
  type DatabaseSettings,
  type DatabaseSettingsInput,
  type DbCatalog,
  type DbDialect,
  type DbLimits,
  type DbQueryResult,
  type MonitorStatus,
  type Platform,
} from '@sm/shared';
import { config } from '../config.js';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { getSettings } from '../settings.js';
import { nowIso } from '../util.js';
import { getPlatform } from '../platforms/service.js';
import { requireIntact, sealPlatform } from '../platforms/integrity.js';
import { invalidatePlatformCaches, onPlatformInvalidated } from '../platforms/http.js';
import { assertAddressSafe, assertNetAllowed, guardedLookup } from '../platforms/outbound.js';
import { outboundContext } from '../platforms/policyContext.js';
import { DbError, type ConnectTarget, type DbDriver, type DriverConnection, type RunLimits, type ServerInfo } from './types.js';
import { catalogColumns, catalogSql, mapCatalogRows } from './catalog.js';
import { closePool, poolFor } from './pool.js';
import { DEMO_DB_HOST, demoDriver } from './demo.js';

/**
 * Database platforms (0.7.0, #203, ADR 0008, docs/DATABASES.md): the connection settings, the outbound policy for
 * host:port, the pool, and running one read-only statement (the query step, monitor checks, the MCP gateway, the
 * connection test).
 */

onPlatformInvalidated(closePool);

// ---------- settings ----------

export function requireDatabasePlatform(p: Platform): void {
  if (p.kind !== DATABASE_KIND)
    throw new DbError('DB_NOT_A_DATABASE', `"${p.name}" is not a database platform (kind ${p.kind})`, { name: p.name, kind: p.kind }, 400);
}

/** The connection settings of a database platform; refused when there are none (or they do not parse). */
export function databaseSettings(p: Platform): DatabaseSettings {
  requireDatabasePlatform(p);
  const raw = p.config.database;
  if (!raw) throw new DbError('DB_SETTINGS_MISSING', `"${p.name}" has no database connection yet – set it under Platform → Database`, { name: p.name }, 400);
  const r = databaseSettingsSchema.safeParse(raw);
  if (!r.success)
    throw new DbError(
      'DB_SETTINGS_INVALID',
      `The database connection of "${p.name}" is not valid – save it again under Platform → Database`,
      { name: p.name },
      400,
    );
  return r.data;
}

const describeSettings = (s: DatabaseSettings) =>
  `${DB_DIALECT_INFO[s.dialect].label} at ${s.host}:${dbPort(s)}/${s.database}, TLS ${s.tls.mode}${s.tls.ca?.trim() ? ' (own CA)' : ''}`;

/** What the audit log keeps of the settings: everything but the CA certificate itself (its SHA-256). */
const auditView = (s: DatabaseSettings | null) =>
  s && { ...s, tls: { ...s.tls, ca: s.tls.ca?.trim() ? `sha256:${crypto.createHash('sha256').update(s.tls.ca).digest('hex')}` : undefined } };

/** Saves the connection (the route checked "manage"); closes the platform's connections. */
export function setDatabaseSettings(id: string, input: DatabaseSettingsInput): Platform {
  const before = getPlatform(id);
  requireDatabasePlatform(before);
  const row = db().get<Parameters<typeof requireIntact>[0]>('SELECT * FROM platforms WHERE id = ?', id);
  if (row) requireIntact(row);
  const next = databaseSettingsSchema.parse(input);
  const prev = before.config.database ? databaseSettingsSchema.safeParse(before.config.database) : null;
  db().tx(() => {
    db().run('UPDATE platforms SET config = ?, updated_at = ? WHERE id = ?', JSON.stringify({ ...before.config, database: next }), nowIso(), id);
    audit({
      action: 'platform.database_changed',
      entityType: 'platform',
      entityId: id,
      summary: `Database connection of "${before.name}" changed: ${describeSettings(next)}`,
      details: { settings: auditView(next), previous: prev?.success ? auditView(prev.data) : null },
    });
    sealPlatform(id);
  });
  invalidatePlatformCaches(id);
  return getPlatform(id);
}

// ---------- connecting ----------

const bare = (h: string) => h.replace(/^\[|\]$/g, '');
const isDemoHost = (h: string) => h.toLowerCase().endsWith('.demo.invalid');

/**
 * The outbound policy for host:port (like Kafka and MQTT): with the policy "platforms" the platform's own host and port
 * are allowed (address safety still applies); otherwise the host must be on the allow-list.
 */
export async function assertDatabaseAllowed(s: DatabaseSettings): Promise<void> {
  const host = bare(s.host);
  const port = dbPort(s);
  if ((getSettings().outboundPolicy ?? 'platforms') === 'platforms') await assertAddressSafe(`http://${net.isIP(host) === 6 ? `[${host}]` : host}:${port}`);
  else await assertNetAllowed(host, port, outboundContext());
}

async function driverFor(s: DatabaseSettings): Promise<DbDriver> {
  if (isDemoHost(s.host)) {
    if (config.demo && s.host.toLowerCase() === DEMO_DB_HOST) return demoDriver;
    throw new DbError('DB_CONNECT_FAILED', `${s.host} is the demo database – it only answers in demo mode`);
  }
  if (s.dialect === 'postgresql') return (await import('./postgres.js')).postgresDriver;
  if (s.dialect === 'mysql') return (await import('./mysql.js')).mysqlDriver;
  return (await import('./sqlserver.js')).sqlserverDriver;
}

function targetOf(p: Platform, s: DatabaseSettings, secrets: Record<string, string>): ConnectTarget {
  if (!secrets.username || secrets.password === undefined)
    throw new DbError('DB_CREDENTIALS_MISSING', `"${p.name}" needs the credentials username and password (Platform → Credentials)`, { name: p.name }, 400);
  const host = bare(s.host);
  const port = dbPort(s);
  return {
    dialect: s.dialect,
    host,
    port,
    database: s.database,
    user: secrets.username,
    password: secrets.password,
    tls: { mode: s.tls.mode, ca: s.tls.ca, serverName: s.tls.serverName },
    connectTimeoutMs: DB_LIMITS.connectTimeoutMs,
    // Steward opens the socket: the guarded lookup refuses metadata/link-local addresses and pins the checked address
    socket: () => net.connect({ host, port, lookup: guardedLookup }),
  };
}

/** Opens a connection (outbound policy first). */
async function openConnection(p: Platform, s: DatabaseSettings, secrets: Record<string, string>, signal: AbortSignal): Promise<DriverConnection> {
  const target = targetOf(p, s, secrets);
  if (!isDemoHost(s.host)) await assertDatabaseAllowed(s);
  const driver = await driverFor(s);
  return driver.connect(target, AbortSignal.any([signal, AbortSignal.timeout(DB_LIMITS.connectTimeoutMs + 5000)]));
}

/** A pooled connection for `fn`, returned to the pool afterwards (or closed when it is no longer usable). */
async function withConnection<T>(
  p: Platform,
  s: DatabaseSettings,
  secrets: Record<string, string>,
  signal: AbortSignal,
  fn: (c: DriverConnection) => Promise<T>,
): Promise<T> {
  const pool = poolFor(p.id, `${p.updatedAt}|${JSON.stringify(s)}`, s.poolSize ?? DB_LIMITS.poolSize.default, (sig) => openConnection(p, s, secrets, sig));
  const conn = await pool.acquire(signal);
  try {
    return await fn(conn);
  } finally {
    pool.release(conn);
  }
}

// ---------- statements ----------

export interface QueryRequest {
  /** The designer's statement (checked) … */
  sql?: string;
  /** … or a catalog query of Steward */
  catalog?: DbCatalog;
  params?: unknown[];
  /** The statement is written for this DBMS */
  dialect?: DbDialect;
  limits?: DbLimits & { onLimit?: 'fail' | 'truncate' };
}

export interface QueryOutcome {
  result: DbQueryResult;
  /** The statement as it was sent (the catalog query's SQL for the server) – for the evidence */
  statement: string;
  server: ServerInfo;
  settings: DatabaseSettings;
  limits: ReturnType<typeof effectiveDbLimits>;
}

/** A parameter as it is bound: scalars (and, for PostgreSQL, lists of scalars); never put into the text. */
export function bindValue(v: unknown, dialect: DbDialect, index: number): unknown {
  const bad = (why: string) => new DbError('DB_PARAM_INVALID', `Parameter ${index + 1} ${why}`, { index: index + 1 }, 400);
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') {
    if (v.length > DB_LIMITS.paramChars) throw bad(`is longer than ${DB_LIMITS.paramChars} characters`);
    return v;
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw bad('is not a finite number');
    return v;
  }
  if (typeof v === 'boolean') return dialect === 'mysql' ? (v ? 1 : 0) : v;
  if (Array.isArray(v)) {
    if (dialect !== 'postgresql') throw bad('is a list – lists are bound as arrays on PostgreSQL only (= ANY($1)); pass one value per placeholder');
    if (v.length > 1000) throw bad('is a list of more than 1,000 values');
    return v.map((x, i) => {
      const b = bindValue(x, dialect, index);
      if (Array.isArray(b)) throw bad(`has a nested list (item ${i + 1})`);
      return b;
    });
  }
  throw bad('is an object – pass a text, number or boolean (or $string(...) of it)');
}

const stripTrailing = (sql: string) => sql.replace(/[\s;]+$/, '');

/**
 * Runs one statement on a database platform: settings, credentials, the statement check for the platform's DBMS, bound
 * parameters, the limits (the platform's are the ceiling), a pooled connection in a read-only (or always rolled back)
 * transaction. Catalog queries take the statement for the server they reach.
 */
export async function runQuery(p: Platform, secrets: Record<string, string>, q: QueryRequest, signal: AbortSignal): Promise<QueryOutcome> {
  const s = databaseSettings(p);
  if (q.dialect && q.dialect !== s.dialect)
    throw new DbError(
      'DB_DIALECT_MISMATCH',
      `The statement is written for ${DB_DIALECT_INFO[q.dialect].label}, but "${p.name}" is ${DB_DIALECT_INFO[s.dialect].label}`,
      { expected: DB_DIALECT_INFO[q.dialect].label, actual: DB_DIALECT_INFO[s.dialect].label },
      400,
    );
  const params = (q.params ?? []).map((v, i) => bindValue(v, s.dialect, i));
  if (!q.catalog) {
    const problem = readOnlyStatementProblem(q.sql ?? '', s.dialect, params.length);
    if (problem)
      throw new DbError('DB_STATEMENT_REFUSED', `The statement is refused: ${problem.message}`, { problem: problem.message, reason: problem.code }, 400);
  } else if (params.length) throw new DbError('DB_PARAM_INVALID', 'Catalog queries take no parameters', undefined, 400);
  const limits = effectiveDbLimits(s.limits, q.limits ?? {});
  const run: RunLimits = { maxRows: limits.maxRows, maxBytes: limits.maxMb * 1024 * 1024, timeoutMs: limits.timeoutSeconds * 1000, truncate: limits.truncate };
  return withConnection(p, s, secrets, signal, async (conn) => {
    const sql = q.catalog ? catalogSql(q.catalog, conn.server) : stripTrailing(q.sql!);
    const result = await conn.run({ sql, params, trusted: !!q.catalog }, run, signal);
    if (q.catalog) {
      result.rows = mapCatalogRows(q.catalog, conn.server, result.rows, { database: s.database });
      result.columns = catalogColumns(q.catalog);
    }
    return {
      result,
      statement: q.catalog ? `-- catalog query "${q.catalog}" for ${conn.server.flavour}\n${sql}` : sql,
      server: conn.server,
      settings: s,
      limits,
    };
  });
}

// ---------- connection test ----------

export interface DatabaseTestResult {
  ok: boolean;
  message: string;
  checks: { name: string; ok: boolean; message: string }[];
}

/**
 * The connection test: a fresh connection (not a pooled one), the session's read-only state, whether the account can
 * write, and which catalog queries the account may read (with what is missing).
 */
export async function testDatabase(p: Platform, secrets: Record<string, string>): Promise<DatabaseTestResult> {
  const s = databaseSettings(p);
  const checks: DatabaseTestResult['checks'] = [];
  const signal = AbortSignal.timeout(60_000);
  const t0 = Date.now();
  const conn = await openConnection(p, s, secrets, signal);
  const where = `${s.host}:${dbPort(s)}/${s.database}`;
  try {
    checks.push({
      name: 'Sign-in',
      ok: true,
      message:
        `${DB_DIALECT_INFO[s.dialect].label} ${conn.server.version || ''} at ${where} – signed in as ${secrets.username}, TLS ${s.tls.mode} (${Date.now() - t0} ms)`.replace(
          /\s+/g,
          ' ',
        ),
    });
    const limits: RunLimits = { maxRows: 5, maxBytes: 256 * 1024, timeoutMs: 15_000, truncate: true };
    const status = await conn.run({ sql: catalogSql('status', conn.server), params: [], trusted: true }, limits, signal);
    const st = mapCatalogRows('status', conn.server, status.rows, { database: s.database })[0] ?? {};
    checks.push(
      s.dialect === 'sqlserver'
        ? { name: 'Read-only', ok: true, message: 'SQL Server has no read-only transaction: every statement is rolled back – the account must be read-only' }
        : { name: 'Read-only', ok: st.readOnly === true, message: st.readOnly === true ? 'The session is read-only' : 'The session is not read-only' },
    );
    checks.push({
      name: 'Account',
      ok: st.canWrite !== true,
      message:
        st.canWrite === true
          ? `The account ${String(st.currentUser ?? secrets.username)} can write – use the read-only role of docs/DATABASES.md`
          : `The account ${String(st.currentUser ?? secrets.username)} has no write privileges Steward can see`,
    });
    for (const name of ['accounts', 'role-members', 'privileges', 'replication'] as const) {
      try {
        const r = await conn.run({ sql: catalogSql(name, conn.server), params: [], trusted: true }, { ...limits, maxRows: 1 }, signal);
        checks.push({ name: `Catalog: ${name}`, ok: true, message: r.rowCount ? 'readable' : 'readable (no rows)' });
      } catch (e) {
        checks.push({ name: `Catalog: ${name}`, ok: false, message: (e as Error).message.slice(0, 300) });
      }
    }
  } finally {
    await conn.close();
  }
  const writes = checks.find((c) => c.name === 'Account' && !c.ok);
  const missing = checks.filter((c) => c.name.startsWith('Catalog:') && !c.ok).length;
  return {
    // the connection works: a writing account or a catalog the account may not read is a finding, not a failed test
    ok: true,
    message:
      `Connected to ${DB_DIALECT_INFO[s.dialect].label} ${conn.server.version} (${where})` +
      (writes ? ' – but the account can write' : '') +
      (missing ? ` – ${missing} catalog quer${missing === 1 ? 'y' : 'ies'} not readable` : ''),
    checks,
  };
}

// ---------- monitor checks ----------

const fmt = (n: number) => (Math.abs(n) >= 100 ? Math.round(n).toString() : n.toFixed(Math.abs(n) >= 10 ? 1 : 2).replace(/\.?0+$/, ''));

/** A database monitor check (#203): the connection, the replication lag, or the value of a read-only query. */
export async function databaseCheck(
  p: Platform,
  secrets: Record<string, string>,
  c: CheckOf<'database'>,
  signal: AbortSignal,
): Promise<{ status: MonitorStatus; message: string; value?: unknown }> {
  const s = databaseSettings(p);
  const label = DB_DIALECT_INFO[s.dialect].label;
  const judge = (v: number): MonitorStatus => {
    const bad = (level: number | undefined) => level !== undefined && (c.direction === 'below' ? v <= level : v >= level);
    return bad(c.crit) ? 'down' : bad(c.warn) ? 'degraded' : 'up';
  };
  const levels = [c.warn !== undefined ? `WARN ${fmt(c.warn)}` : '', c.crit !== undefined ? `CRIT ${fmt(c.crit)}` : ''].filter(Boolean).join(', ');
  const unit = c.unit ?? '';
  if (c.mode === 'connection') {
    let out;
    try {
      out = await runQuery(p, secrets, { catalog: 'status', limits: { maxRows: 1, timeoutSeconds: Math.min(60, s.limits.timeoutSeconds ?? 30) } }, signal);
    } catch (e) {
      // not reachable or the sign-in refused: that is what this check is for
      const code = (e as { code?: string }).code;
      const down = code === 'DB_CONNECT_FAILED' || code === 'DB_AUTH_FAILED' || code === 'DB_TLS_FAILED' || code === 'DB_TIMEOUT';
      return { status: down ? 'down' : 'unknown', message: `${label}: ${(e as Error).message}`.slice(0, 500) };
    }
    const st = out.result.rows[0] ?? {};
    if (st.canWrite === true)
      return {
        status: 'degraded',
        message: `${label} ${out.server.version}: connected – the account can write (use a read-only role)`,
        value: { version: out.server.version },
      };
    return {
      status: 'up',
      message: `${label} ${out.server.version}: connected in ${out.result.durationMs} ms`,
      value: { version: out.server.version, ms: out.result.durationMs },
    };
  }
  if (c.mode === 'replication') {
    const out = await runQuery(p, secrets, { catalog: 'replication', limits: { maxRows: 100 } }, signal);
    const rows = out.result.rows as { name?: string; state?: string; lagSeconds?: number | null }[];
    if (!rows.length) return { status: c.noData, message: `${label}: no replication (no replica and not a standby)`, value: { replicas: 0 } };
    const known = rows.filter((r) => typeof r.lagSeconds === 'number');
    if (!known.length)
      return {
        status: 'unknown',
        message: `${label}: ${rows.length} replica(s), lag not known (${rows.map((r) => `${r.name}: ${r.state}`).join(', ')})`.slice(0, 500),
      };
    const worst = known.reduce((a, b) => ((b.lagSeconds as number) > (a.lagSeconds as number) ? b : a));
    const lag = worst.lagSeconds as number;
    const status = judge(lag);
    return {
      status,
      message: `${label}: replication lag ${fmt(lag)} s${rows.length > 1 ? ` (worst of ${rows.length}: ${worst.name})` : ` (${worst.name})`} (${levels})`.slice(
        0,
        500,
      ),
      value: { lagSeconds: lag, replicas: rows.length },
    };
  }
  const out = await runQuery(p, secrets, { sql: c.sql, params: c.params ?? [], limits: { maxRows: 1, onLimit: 'truncate' } }, signal);
  const first = out.result.rows[0];
  if (!first) return { status: c.noData, message: `${label}: the query returned no row`, value: { rows: 0 } };
  const col = out.result.columns[0] ?? '';
  const v = Number(first[col]);
  if (!Number.isFinite(v)) return { status: 'unknown', message: `${label}: ${col} is not a number (${String(first[col]).slice(0, 60)})` };
  return { status: judge(v), message: `${label}: ${col} ${fmt(v)}${unit} (${levels})`.slice(0, 500), value: { column: col, value: v } };
}
