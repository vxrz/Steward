import './bootstrap.js';
import { config, ensureDataDirs } from './config.js';
import { buildApp } from './app.js';
import { unlockFromEnv } from './routes/index.js';
import { vault } from './vault.js';
import { activeRunIds } from './engine/runner.js';

ensureDataDirs();
const app = await buildApp({ logger: true });
await app.listen({ host: config.host, port: config.port });
await unlockFromEnv().catch((e) => console.error('Automatic unlock failed:', (e as Error).message));

const url = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
console.log(`\n  Service Manager ${config.version} running at ${url}`);
console.log(`  Data directory: ${config.dataDir}${config.demo ? '\n  DEMO MODE: mock platforms available under /mock' : ''}`);
console.log(vault().initialized ? (vault().unlocked ? '  Vault unlocked.' : '  Open the UI to unlock the vault.') : '  Open the UI to set up your master passphrase.');

const shutdown = async () => {
  const active = activeRunIds();
  if (active.length) console.log(`Stopping with ${active.length} active run(s); they will be marked interrupted/resumed on next start.`);
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
