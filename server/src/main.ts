import './bootstrap.js';
import type { AddressInfo } from 'node:net';
import { initTelemetry, shutdownTelemetry } from './telemetry.js';
import { logger } from './log.js';
import { config, ensureDataDirs, securityWarnings } from './config.js';
import { buildApp } from './app.js';
import { unlockFromEnv } from './routes/index.js';
import { vault } from './vault.js';
import { activeRunIds } from './engine/runner.js';
import { BRAND } from '@sm/shared';
import { startNotificationJobs, stopNotificationJobs, flushNotifications } from './notifications/service.js';
import { startMaintenanceJobs, stopMaintenanceJobs } from './maintenance.js';
import { db } from './db.js';
import { passwordLoginPending } from './settings.js';
import { stopMonitorEngine } from './monitors/engine.js';
import { stopGatusScraper } from './gatus/metrics.js';
import { stopReportSchedules } from './reports/schedules.js';
import { closeErrorReporting, initErrorReporting, isUnexpected, reportError } from './errorReporting.js';
import { listPlatforms, getSecretsUnchecked } from './platforms/service.js';
import { secretValues } from './platforms/http.js';
import { startAuditJobs, stopAuditJobs } from './audit-anchor.js';
import { startBackupJobs, stopBackupJobs } from './backup/service.js';
import { removeInstanceFile, writeInstanceFile } from './instance.js';
import { warnEmailVerifiedProviders } from './auth/sso.js';
import { flushFailedLoginAudit } from './auth/login-audit.js';

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
  await unlockFromEnv().catch((e) => {
    logger.error({ err: e }, 'automatic unlock failed');
    if (isUnexpected(e)) reportError(e, { tags: { phase: 'unlock' } });
  });
  startNotificationJobs();
  startMaintenanceJobs();
  startAuditJobs();
  startBackupJobs();
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

  const stop = async () => {
    const active = activeRunIds();
    if (active.length) logger.info({ activeRuns: active.length }, 'stopping with active runs; they are resumed or marked interrupted on next start');
    stopNotificationJobs();
    stopMaintenanceJobs();
    await stopMonitorEngine();
    stopGatusScraper();
    stopReportSchedules();
    stopAuditJobs();
    stopBackupJobs();
    flushFailedLoginAudit();
    removeInstanceFile();
    await app.close();
    await Promise.race([flushNotifications(), new Promise((r) => setTimeout(r, 5000))]);
    await shutdownTelemetry();
    await closeErrorReporting();
  };
  const onSignal = () => void stop().finally(() => process.exit(0));
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return { url, stop };
}
