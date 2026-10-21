import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, '..', '..');

export const config = {
  version: '0.1.0',
  host: process.env.SM_HOST ?? '127.0.0.1',
  port: Number(process.env.SM_PORT ?? 4310),
  dataDir: path.resolve(process.env.SM_DATA_DIR ?? path.join(ROOT_DIR, 'data')),
  demo: process.env.SM_DEMO === '1' || process.env.SM_DEMO === 'true',
  webDist: path.join(ROOT_DIR, 'web', 'dist'),
  templatesDir: path.join(ROOT_DIR, 'server', 'templates'),
  /** Optional passphrase for unattended start (scheduled runs after reboot). */
  masterPassphrase: process.env.SM_MASTER_PASSPHRASE,
  operator: process.env.SM_OPERATOR,
};

export function ensureDataDirs(): void {
  for (const d of ['', 'artifacts', 'docs', 'reports']) {
    fs.mkdirSync(path.join(config.dataDir, d), { recursive: true });
  }
}
