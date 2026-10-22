/**
 * Desktop mode setup. Imported first by the desktop entry so the SM_* variables
 * are in place before config.ts is evaluated.
 *
 * - per-user data folder (unless SM_DATA_DIR / --data-dir is given)
 * - in the single-file executable: unpacks the embedded web UI, example
 *   library and Swagger UI assets once per version into the data folder
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sea from 'node:sea';
import { BRAND } from '@sm/shared';

export interface DesktopArgs {
  open: boolean;
  autostart?: 'on' | 'off';
  help: boolean;
  version: boolean;
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(name + '='));
  return eq?.slice(name.length + 1);
}
const flag = (name: string) => process.argv.includes(name);

export const args: DesktopArgs = {
  open: !flag('--no-open'),
  autostart: argValue('--autostart') as DesktopArgs['autostart'],
  help: flag('--help') || flag('-h'),
  version: flag('--version'),
};

/** Per-user application data folder. */
export function userDataDir(): string {
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), BRAND.slug);
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', BRAND.slug);
  return path.join(process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), BRAND.slug);
}

const port = argValue('--port');
if (port) process.env.SM_PORT = port;
const dataDir = argValue('--data-dir');
if (dataDir) process.env.SM_DATA_DIR = path.resolve(dataDir);
if (flag('--demo')) process.env.SM_DEMO = '1';
process.env.SM_DATA_DIR ??= userDataDir();
process.env.SM_LOG_LEVEL ??= 'warn';

export const inExecutable = sea.isSea();

if (inExecutable) {
  // The build embeds "manifest.json" (list of asset keys) plus one asset per file.
  const manifest = JSON.parse(sea.getAsset('manifest.json', 'utf8')) as { version: string; files: string[] };
  const hash = createHash('sha256').update(manifest.files.join('\n')).update(manifest.version).digest('hex').slice(0, 10);
  const appDir = path.join(process.env.SM_DATA_DIR, 'app', `${manifest.version}-${hash}`);
  const marker = path.join(appDir, '.complete');
  if (!fs.existsSync(marker)) {
    fs.rmSync(appDir, { recursive: true, force: true });
    for (const key of manifest.files) {
      const target = path.join(appDir, ...key.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(sea.getAsset(key)));
    }
    fs.writeFileSync(marker, new Date().toISOString());
    // remove older unpacked versions
    for (const d of fs.readdirSync(path.dirname(appDir))) {
      if (d !== path.basename(appDir)) fs.rmSync(path.join(path.dirname(appDir), d), { recursive: true, force: true });
    }
  }
  process.env.SM_WEB_DIST ??= path.join(appDir, 'web');
  process.env.SM_EXAMPLES_DIR ??= path.join(appDir, 'examples');
  if (fs.existsSync(path.join(appDir, 'swagger-ui'))) process.env.SM_SWAGGER_UI_DIR ??= path.join(appDir, 'swagger-ui');
}
