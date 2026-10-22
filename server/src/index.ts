import './bootstrap.js';
import { initTelemetry, shutdownTelemetry } from './telemetry.js';
import { logger } from './log.js';
import { config, ensureDataDirs } from './config.js';
import { buildApp } from './app.js';
import { unlockFromEnv } from './routes/index.js';
import { vault } from './vault.js';
import { activeRunIds } from './engine/runner.js';

ensureDataDirs();
const tracing = initTelemetry();
const app = await buildApp({ logger: true });
await app.listen({ host: config.host, port: config.port });
await unlockFromEnv().catch((e) => logger.error({ err: e }, 'automatic unlock failed'));
logger.info({ url: `http://${config.host}:${config.port}`, dataDir: config.dataDir, demo: config.demo, tracing }, 'service manager started');

if (process.stdout.isTTY) {
  const url = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
  console.log(`\n  Service Manager ${config.version} running at ${url}`);
  console.log(`  Data directory: ${config.dataDir}${config.demo ? '\n  DEMO MODE: mock platforms available under /mock' : ''}`);
  console.log(vault().initialized ? (vault().unlocked ? '  Vault unlocked.' : '  Open the UI to unlock the vault.') : '  Open the UI to set up your master passphrase.');
  console.log('');
}

const shutdown = async () => {
  const active = activeRunIds();
  if (active.length) logger.info({ activeRuns: active.length }, 'stopping with active runs; they are resumed or marked interrupted on next start');
  await app.close();
  await shutdownTelemetry();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
