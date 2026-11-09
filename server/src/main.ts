import './warnings.js';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { initTelemetry, shutdownTelemetry } from './telemetry.js';
import { logger } from './log.js';
import { config, ensureDataDirs, env, securityWarnings } from './config.js';
import { vacuumAtStart } from './database/sqlite-space.js';
import { unknownVariables } from './config-schema.js';
import { buildApp } from './app.js';
import { unlockFromEnv } from './routes/auth.js';
import { vault } from './vault.js';
import { BRAND } from '@sm/shared';
import { flushNotifications } from './notifications/service.js';
import { db } from './db.js';
import { tlsServerOptions } from './tls.js';
import { passwordLoginPending } from './settings.js';
import { closeErrorReporting, initErrorReporting, isUnexpected, reportError } from './errorReporting.js';
import { listPlatforms, allSecretsUnchecked } from './platforms/service.js';
import { secretValues } from './platforms/http.js';
import { removeInstanceFile, writeInstanceFile } from './instance.js';
import { warnEmailVerifiedProviders } from './auth/sso.js';
import { flushFailedLoginAudit } from './auth/login-audit.js';
import { shutdown, startBackground } from './bootstrap.js';
import { registerFeatureJobs } from './features/index.js';
import { InstanceLease, type LeaseWait } from './database/lease.js';
import { describeHolder, SqliteInstanceLock } from './database/sqlite-lock.js';
import { engine } from './engine/index.js';
import { stopScheduler } from './scheduler.js';

/** All platform secret values (and cached access tokens) – never part of an error report. */
function platformSecretValues(): string[] {
  if (!vault().unlocked) return [];
  return listPlatforms().flatMap((p) => {
    try {
      // every identity's credentials, not only the default one's (ADR 0009)
      return allSecretsUnchecked(p.id).flatMap((x) => secretValues(x));
    } catch {
      return [];
    }
  });
}

export interface Started {
  url: string;
  stop: () => Promise<void>;
}

const WAIT_LOG_EVERY_MS = 60_000;

function describeWait(w: LeaseWait): Record<string, unknown> {
  if (w.reason === 'held')
    return { holder: w.current.holder, holderVersion: w.current.version, renewedAt: w.current.renewedAt, expiresAt: w.current.expiresAt };
  if (w.reason === 'advisoryLock') return { advisoryLockHeldBy: w.session };
  return { error: w.message };
}

/**
 * While another instance holds the database lease (PostgreSQL) or the instance lock (SQLite): a minimal server on the
 * configured address, so probes see this instance alive (/api/health 200) but not ready (/api/ready and
 * /api/ready/traffic 503), instead of a process that exits and restarts.
 */
function waitingServer(message: string): Promise<http.Server> {
  const handler: http.RequestListener = (req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '10' });
      res.end(JSON.stringify(body));
    };
    if (path === `${config.basePath}/api/health`) return json(200, { ok: true, version: config.version });
    if (path === `${config.basePath}/api/ready`)
      return json(503, { ready: false, checks: { vault: { ok: false, message }, database: { ok: false, message }, scheduler: { ok: false, message } } });
    // not this one yet: the instance that holds the database gets the traffic
    if (path === `${config.basePath}/api/ready/traffic`) return json(503, { ready: false, message });
    json(503, { error: `${BRAND.name} is starting. ${message}.`, code: 'WAITING_FOR_DATABASE_LEASE' });
  };
  const server = config.tls ? https.createServer(tlsServerOptions()!, handler) : http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: config.host, port: config.port }, () => resolve(server));
  });
}

/**
 * PostgreSQL: the single-instance lease (database/lease.ts) before the database is opened and migrated. Waits as long
 * as another instance holds it (logging every minute), serving /api/health and /api/ready meanwhile.
 */
async function acquireLease(): Promise<InstanceLease | null> {
  const target = config.database;
  if (target.kind !== 'postgres' || target.lock === false) return null;
  const lease = new InstanceLease({ url: target.url, schema: target.schema, version: config.version });
  let server: http.Server | undefined;
  let serverStarting: Promise<void> | undefined;
  let lastLog = 0;
  const onSignal = () => {
    logger.info('stopped while waiting for the database lease');
    void lease.release(2000).finally(() => process.exit(0));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const got = await lease.acquire((w) => {
    if (Date.now() - lastLog >= WAIT_LOG_EVERY_MS) {
      lastLog = Date.now();
      logger.warn(
        { schema: target.schema, ...describeWait(w) },
        w.reason === 'error'
          ? 'waiting for the database lease: the database is not reachable yet'
          : w.reason === 'advisoryLock'
            ? 'waiting for the database lease: a session of an older version (or a command-line tool such as db:copy) holds the instance lock of this schema'
            : 'waiting for the database lease: another instance uses this database schema; this one takes over when it stops or its lease expires',
      );
    }
    serverStarting ??= waitingServer('Waiting for the database: another instance uses this database schema').then(
      (s) => void (server = s),
      (err) => logger.warn({ err }, 'could not answer health probes while waiting for the database lease'),
    );
  });
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  await closeWaitingServer(serverStarting, () => server);
  if (got.takeover)
    logger.warn({ previous: got.takeover, lingeringSession: got.terminated }, 'took over the database lease of an instance that stopped renewing it');
  else logger.info({ schema: target.schema }, 'database lease acquired');
  // the lease worker holds the advisory lock; the app's own connection must not ask for it again
  config.database = { ...target, lock: false };
  return lease;
}

async function closeWaitingServer(starting: Promise<void> | undefined, server: () => http.Server | undefined): Promise<void> {
  await starting;
  const s = server();
  if (!s) return;
  s.closeAllConnections();
  await new Promise((r) => s.close(r));
}

/**
 * SQLite: the single-instance lock (database/sqlite-lock.ts) before the database is opened and migrated. Waits as
 * long as another process holds it (logging every minute), serving /api/health and /api/ready meanwhile, as on
 * PostgreSQL; the lock of a stopped or crashed process is free at once.
 */
async function acquireSqliteLock(): Promise<SqliteInstanceLock | null> {
  const target = config.database;
  if (target.kind !== 'sqlite' || target.file === ':memory:') return null;
  const lock = new SqliteInstanceLock({ file: target.file, version: config.version });
  if (lock.tryAcquire()) {
    logger.info({ lockFile: lock.lockFile }, 'database lock acquired');
    return lock;
  }
  let server: http.Server | undefined;
  let serverStarting: Promise<void> | undefined;
  let lastLog = 0;
  const onSignal = () => {
    logger.info('stopped while waiting for the database lock');
    lock.release();
    void closeWaitingServer(serverStarting, () => server).finally(() => process.exit(0));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const got = await lock.acquire((holder) => {
    if (Date.now() - lastLog >= WAIT_LOG_EVERY_MS) {
      lastLog = Date.now();
      logger.warn(
        { lockFile: lock.lockFile, holder: describeHolder(holder), holderPid: holder?.pid, holderHost: holder?.host, holderVersion: holder?.version },
        'waiting for the database lock: another instance uses this SQLite database; this one takes over when it stops',
      );
    }
    serverStarting ??= waitingServer('Waiting for the database: another instance uses this SQLite database').then(
      (s) => void (server = s),
      (err) => logger.warn({ err }, 'could not answer health probes while waiting for the database lock'),
    );
  });
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  // stopped while waiting: the signal handler exits; never go on to open the database
  if (!got) return new Promise<never>(() => undefined);
  await closeWaitingServer(serverStarting, () => server);
  logger.info({ lockFile: lock.lockFile }, 'database lock acquired: the other instance has stopped');
  return lock;
}

/** Starts the server (used by `npm start` and by the desktop executable). */
export async function start(opts: { banner?: boolean } = {}): Promise<Started> {
  // Files the server creates (database, WAL, vault, artifacts, reports) are private to the service account.
  if (process.platform !== 'win32') process.umask(0o077);
  const permissionProblems = ensureDataDirs();
  for (const p of permissionProblems) logger.warn({ problem: p }, 'could not restrict permissions in the data directory');
  for (const w of securityWarnings()) logger.warn({ security: true }, w);
  // a misspelt variable is otherwise ignored without a word (SM_DATABSE_URL starts on SQLite); names only, never values
  for (const u of unknownVariables(process.env))
    logger.warn(
      { variable: u.name, ...(u.suggestion ? { didYouMean: u.suggestion } : {}) },
      u.suggestion ? `unknown environment variable ${u.name} is ignored – did you mean ${u.suggestion}?` : `unknown environment variable ${u.name} is ignored`,
    );
  // one instance per database (ADR 0002): the lease on PostgreSQL, a file lock on SQLite
  const lease: { onLost(fn: (reason: string) => void): void; release(): unknown } | null = (await acquireLease()) ?? (await acquireSqliteLock());
  lease?.onLost((reason) => {
    // another instance may run now: stop at once, without writing (no drain – the other one recovers the runs)
    logger.fatal({ reason }, config.database.kind === 'sqlite' ? 'lost the database lock: stopping now' : 'lost the database lease: stopping now');
    try {
      engine().stopAccepting();
      stopScheduler();
    } catch {
      /* exiting anyway */
    }
    process.exit(70);
  });
  // Open (and migrate) the database before anything listens: a failed upgrade stops the start here,
  // with the path of the automatic backup in the message.
  try {
    db();
    // SQLite, once after a large clean-up: give the free space back before anything listens (database/sqlite-space.ts)
    if (env.SM_SQLITE_VACUUM_AT_START) vacuumAtStart(db());
  } catch (e) {
    await lease?.release();
    throw e;
  }
  if (passwordLoginPending()) {
    logger.warn(
      { security: true },
      'SM_PASSWORD_LOGIN=none is not in effect yet: administrators can still sign in with a password until one of them signs in with single sign-on',
    );
  }
  // providers whose sign-ins need email_verified since #77 (named, so the administrator can decide)
  warnEmailVerifiedProviders();
  const tracing = initTelemetry();
  const errorReporting = await initErrorReporting({ secretValues: platformSecretValues });
  const app = await buildApp({ logger: true });
  await app.listen({ host: config.host, port: config.port });
  // SM_PORT=0: the system picks a free port; everything that needs the real port (the instance proof,
  // the own-API outbound guard, links) reads config.port, and the start line below shows it.
  if (config.port === 0) config.port = (app.server.address() as AddressInfo).port;
  // the Teams bot's own listener (ADR 0013, preview): only POST /teams/bot/messages
  const botListener = await (await import('./msteams/listener.js')).startBotListener();
  // background jobs, event-loop monitor and backups now; recovery, scheduler and monitors once the vault is unlocked
  registerFeatureJobs();
  startBackground();
  await unlockFromEnv().catch((e) => {
    logger.error({ err: e }, 'automatic unlock failed');
    if (isUnexpected(e)) reportError(e, { tags: { phase: 'unlock' } });
  });
  const url = `${config.tls ? 'https' : 'http'}://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}${config.basePath}`;
  writeInstanceFile(url);
  logger.info({ url, dataDir: config.dataDir, database: db().label, demo: config.demo, tracing, errorReporting }, 'service manager started');

  if (opts.banner ?? process.stdout.isTTY) {
    console.log(`\n  ${BRAND.name} ${config.version} running at ${url}`);
    console.log(`  Data directory: ${config.dataDir}`);
    if (db().dialect !== 'sqlite') console.log(`  Database: ${db().label}`);
    if (config.demo) console.log('  DEMO MODE: mock platforms available under /mock');
    console.log(
      vault().initialized ? (vault().unlocked ? '  Vault unlocked.' : '  Open the UI to unlock the vault.') : '  Open the UI to set up your master passphrase.',
    );
    console.log('');
  }

  let stopped: Promise<void> | undefined;
  const stop = () =>
    (stopped ??= (async () => {
      // background work first (bootstrap.ts: no new runs or fires, up to SM_SHUTDOWN_GRACE_SECONDS for running steps)
      await shutdown();
      flushFailedLoginAudit();
      removeInstanceFile();
      await app.close();
      await botListener?.close();
      await Promise.race([flushNotifications(), new Promise((r) => setTimeout(r, 3000).unref())]);
      await shutdownTelemetry();
      await closeErrorReporting();
      // the next instance takes over at once
      await lease?.release();
      logger.info('service manager stopped');
      logger.flush();
    })());
  let signals = 0;
  const onSignal = (signal: NodeJS.Signals) => {
    // a second signal while draining: stop now (the runs are marked interrupted at the next start)
    if (++signals > 1) {
      logger.warn({ signal }, 'second stop signal: exiting without waiting');
      process.exit(1);
    }
    logger.info({ signal, graceSeconds: Math.round(config.shutdownGraceMs / 1000) }, 'stop signal received');
    void stop().then(
      () => process.exit(0),
      (err) => {
        logger.error({ err }, 'clean shutdown failed');
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return { url, stop };
}
