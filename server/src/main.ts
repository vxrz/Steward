import './warnings.js';
import type { AddressInfo } from 'node:net';
import { initTelemetry, shutdownTelemetry } from './telemetry.js';
import { logger } from './log.js';
import { config, ensureDataDirs, securityWarnings } from './config.js';
import { buildApp } from './app.js';
import { unlockFromEnv } from './routes/auth.js';
import { vault } from './vault.js';
import { BRAND } from '@sm/shared';
import { flushNotifications } from './notifications/service.js';
import { db } from './db.js';
import { passwordLoginPending } from './settings.js';
import { closeErrorReporting, initErrorReporting, isUnexpected, reportError } from './errorReporting.js';
import { listPlatforms, getSecretsUnchecked } from './platforms/service.js';
import { secretValues } from './platforms/http.js';
import { removeInstanceFile, writeInstanceFile } from './instance.js';
import { warnEmailVerifiedProviders } from './auth/sso.js';
import { flushFailedLoginAudit } from './auth/login-audit.js';
import { shutdown, startBackground } from './bootstrap.js';

/** All platform secret values (and cached access tokens) – never part of an error report. */
function platformSecretValues(): string[] {
  if (!vault().unlocked) return [];
  return listPlatforms().flatMap((p) => {
    try {
      return secretValues(getSecretsUnchecked(p.id));
    } catch {
      return [];
    }
  });
}

export interface Started {
  url: string;
  stop: () => Promise<void>;
}

/** Starts the server (used by `npm start` and by the desktop executable). */
export async function start(opts: { banner?: boolean } = {}): Promise<Started> {
  // Files the server creates (database, WAL, vault, artifacts, reports) are private to the service account.
  if (process.platform !== 'win32') process.umask(0o077);
  const permissionProblems = ensureDataDirs();
  for (const p of permissionProblems) logger.warn({ problem: p }, 'could not restrict permissions in the data directory');
  for (const w of securityWarnings()) logger.warn({ security: true }, w);
  // Open (and migrate) the database before anything listens: a failed upgrade stops the start here,
  // with the path of the automatic backup in the message.
  db();
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
  // background jobs, event-loop monitor and backups now; recovery, scheduler and monitors once the vault is unlocked
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
      await Promise.race([flushNotifications(), new Promise((r) => setTimeout(r, 3000).unref())]);
      await shutdownTelemetry();
      await closeErrorReporting();
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
