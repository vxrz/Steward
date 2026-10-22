import './bootstrap.js';
import { initTelemetry, shutdownTelemetry } from './telemetry.js';
import { logger } from './log.js';
import { config, ensureDataDirs } from './config.js';
import { buildApp } from './app.js';
import { unlockFromEnv } from './routes/index.js';
import { vault } from './vault.js';
import { activeRunIds } from './engine/runner.js';
import { BRAND } from '@sm/shared';

export interface Started {
  url: string;
  stop: () => Promise<void>;
}

/** Starts the server (used by `npm start` and by the desktop executable). */
export async function start(opts: { banner?: boolean } = {}): Promise<Started> {
  ensureDataDirs();
  const tracing = initTelemetry();
  const app = await buildApp({ logger: true });
  await app.listen({ host: config.host, port: config.port });
  await unlockFromEnv().catch((e) => logger.error({ err: e }, 'automatic unlock failed'));
  const url = `${config.tls ? 'https' : 'http'}://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
  logger.info({ url, dataDir: config.dataDir, demo: config.demo, tracing }, 'service manager started');

  if (opts.banner ?? process.stdout.isTTY) {
    console.log(`\n  ${BRAND.name} ${config.version} running at ${url}`);
    console.log(`  Data directory: ${config.dataDir}${config.demo ? '\n  DEMO MODE: mock platforms available under /mock' : ''}`);
    console.log(vault().initialized ? (vault().unlocked ? '  Vault unlocked.' : '  Open the UI to unlock the vault.') : '  Open the UI to set up your master passphrase.');
    console.log('');
  }

  const stop = async () => {
    const active = activeRunIds();
    if (active.length) logger.info({ activeRuns: active.length }, 'stopping with active runs; they are resumed or marked interrupted on next start');
    await app.close();
    await shutdownTelemetry();
  };
  const onSignal = () => void stop().finally(() => process.exit(0));
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return { url, stop };
}
