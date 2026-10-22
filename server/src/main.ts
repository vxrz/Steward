import './bootstrap.js';
import { initTelemetry, shutdownTelemetry } from './telemetry.js';
import { logger } from './log.js';
import { config, ensureDataDirs } from './config.js';
import { buildApp } from './app.js';
import { unlockFromEnv } from './routes/index.js';
import { vault } from './vault.js';
import { activeRunIds } from './engine/runner.js';
import { BRAND } from '@sm/shared';
import { startNotificationJobs, stopNotificationJobs, flushNotifications } from './notifications/service.js';
import { startMaintenanceJobs, stopMaintenanceJobs } from './maintenance.js';
import { db } from './db.js';
import { closeErrorReporting, initErrorReporting, isUnexpected, reportError } from './errorReporting.js';
import { listPlatforms, getSecrets } from './platforms/service.js';
import { secretValues } from './platforms/http.js';

/** All platform secret values (and cached access tokens) – never part of an error report. */
function platformSecretValues(): string[] {
  if (!vault().unlocked) return [];
  return listPlatforms().flatMap((p) => {
    try {
      return secretValues(getSecrets(p.id));
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
  ensureDataDirs();
  const tracing = initTelemetry();
  const errorReporting = await initErrorReporting({ secretValues: platformSecretValues });
  const app = await buildApp({ logger: true });
  await app.listen({ host: config.host, port: config.port });
  await unlockFromEnv().catch((e) => {
    logger.error({ err: e }, 'automatic unlock failed');
    if (isUnexpected(e)) reportError(e, { tags: { phase: 'unlock' } });
  });
  startNotificationJobs();
  startMaintenanceJobs();
  const url = `${config.tls ? 'https' : 'http'}://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
  logger.info({ url, dataDir: config.dataDir, database: db().label, demo: config.demo, tracing, errorReporting }, 'service manager started');

  if (opts.banner ?? process.stdout.isTTY) {
    console.log(`\n  ${BRAND.name} ${config.version} running at ${url}`);
    console.log(`  Data directory: ${config.dataDir}`);
    if (db().dialect !== 'sqlite') console.log(`  Database: ${db().label}`);
    if (config.demo) console.log('  DEMO MODE: mock platforms available under /mock');
    console.log(vault().initialized ? (vault().unlocked ? '  Vault unlocked.' : '  Open the UI to unlock the vault.') : '  Open the UI to set up your master passphrase.');
    console.log('');
  }

  const stop = async () => {
    const active = activeRunIds();
    if (active.length) logger.info({ activeRuns: active.length }, 'stopping with active runs; they are resumed or marked interrupted on next start');
    stopNotificationJobs();
    stopMaintenanceJobs();
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
