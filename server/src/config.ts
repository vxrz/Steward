import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseDatabaseTarget, type DatabaseTarget } from './database/sql.js';

// In the single-file executable import.meta is not available; paths then come from SM_* variables.
const here = typeof import.meta.url === 'string' ? path.dirname(fileURLToPath(import.meta.url)) : process.cwd();
export const ROOT_DIR = path.resolve(here, '..', '..');

const dataDir = path.resolve(process.env.SM_DATA_DIR ?? path.join(ROOT_DIR, 'data'));

export const config = {
  version: '0.1.0',
  host: process.env.SM_HOST ?? '127.0.0.1',
  port: Number(process.env.SM_PORT ?? 4310),
  dataDir,
  /**
   * SQLite file in the data directory (default) or PostgreSQL (SM_DATABASE_URL=postgres://…,
   * optional SM_DATABASE_SCHEMA and SM_DATABASE_CA). The data directory is needed either way
   * (vault file, artifacts, reports, uploaded docs).
   */
  database: (process.env.SM_DATABASE_URL
    ? parseDatabaseTarget(process.env.SM_DATABASE_URL, { schema: process.env.SM_DATABASE_SCHEMA, ca: process.env.SM_DATABASE_CA })
    : { kind: 'sqlite', file: path.join(dataDir, 'service-manager.db') }) as DatabaseTarget,
  demo: process.env.SM_DEMO === '1' || process.env.SM_DEMO === 'true',
  webDist: process.env.SM_WEB_DIST ?? path.join(ROOT_DIR, 'web', 'dist'),
  templatesDir: path.join(process.env.SM_EXAMPLES_DIR ?? path.join(ROOT_DIR, 'examples'), 'processes'),
  dashboardsDir: path.join(process.env.SM_EXAMPLES_DIR ?? path.join(ROOT_DIR, 'examples'), 'dashboards'),
  /** Optional passphrase for unattended start (scheduled runs after reboot). */
  masterPassphrase: process.env.SM_MASTER_PASSPHRASE,
  /** Serve HTTPS (recommended when other people access the tool over the network). */
  tls: process.env.SM_TLS_CERT && process.env.SM_TLS_KEY ? { cert: process.env.SM_TLS_CERT, key: process.env.SM_TLS_KEY } : undefined,
};

export function ensureDataDirs(): void {
  for (const d of ['', 'artifacts', 'docs', 'reports']) {
    fs.mkdirSync(path.join(config.dataDir, d), { recursive: true });
  }
}
