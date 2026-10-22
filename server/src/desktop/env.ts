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
import { UsageError, parseCli } from '../cli/args.js';

export interface DesktopArgs {
  open: boolean;
  autostart?: 'on' | 'off';
  help: boolean;
  version: boolean;
  /** Send a test event to the configured error tracker and exit. */
  sendTestError: boolean;
  port?: string;
  dataDir?: string;
  demo: boolean;
}

export const inExecutable = sea.isSea();

/** Command-line arguments (in the single executable argv[1] is the executable as invoked, like a script path). */
function userArgv(): string[] {
  const rest = process.argv.slice(2);
  // macOS may add a process serial number when started from the Finder
  return rest.filter((a) => !a.startsWith('-psn_'));
}

/** `steward admin …`: the recovery commands (cli/admin.ts) instead of the server. */
export const adminArgv: string[] | undefined = userArgv()[0] === 'admin' ? userArgv().slice(1) : undefined;

/** `steward mcp …`: the MCP stdio bridge (mcp/bridge.ts) instead of the server – it never opens the database. */
export const mcpArgv: string[] | undefined = userArgv()[0] === 'mcp' ? userArgv().slice(1) : undefined;

/** `steward evidence …`: offline checks of audit evidence packs (cli/evidence-verify.ts) – never opens the database. */
export const evidenceArgv: string[] | undefined = userArgv()[0] === 'evidence' ? userArgv().slice(1) : undefined;

/** Set when the arguments are invalid; the launcher prints it and exits with status 2. */
export let usageError: UsageError | undefined;

function parse(): DesktopArgs {
  const fallback: DesktopArgs = { open: true, help: false, version: false, sendTestError: false, demo: false };
  if (adminArgv || mcpArgv || evidenceArgv) return fallback; // cli/admin.ts and mcp/bridge.ts parse their own options
  try {
    const { values } = parseCli(userArgv(), {
      port: { type: 'string' },
      'data-dir': { type: 'string' },
      'no-open': { type: 'boolean' },
      demo: { type: 'boolean' },
      autostart: { type: 'string' },
      'send-test-error': { type: 'boolean' },
      version: { type: 'boolean', short: 'V' },
      help: { type: 'boolean', short: 'h' },
    });
    const port = values.port;
    if (port !== undefined && !(/^\d+$/.test(port) && Number(port) > 0 && Number(port) < 65536)) {
      throw new UsageError(`--port must be a number between 1 and 65535, not '${port}'`);
    }
    const autostart = values.autostart;
    if (autostart !== undefined && autostart !== 'on' && autostart !== 'off') {
      throw new UsageError(`--autostart takes 'on' or 'off', not '${autostart}'`);
    }
    return {
      open: !values['no-open'],
      autostart,
      help: !!values.help,
      version: !!values.version,
      sendTestError: !!values['send-test-error'],
      port,
      dataDir: values['data-dir'],
      demo: !!values.demo,
    };
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    usageError = e;
    return fallback;
  }
}

export const args: DesktopArgs = parse();

/** Per-user application data folder. */
export function userDataDir(): string {
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), BRAND.slug);
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', BRAND.slug);
  return path.join(process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), BRAND.slug);
}

if (args.port) process.env.SM_PORT = args.port;
if (args.dataDir) process.env.SM_DATA_DIR = path.resolve(args.dataDir);
if (args.demo) process.env.SM_DEMO = '1';
process.env.SM_DATA_DIR ??= userDataDir();
process.env.SM_LOG_LEVEL ??= 'warn';

/** Only unpack the embedded files when the server is going to start. */
const willStart = !adminArgv && !mcpArgv && !usageError && !args.help && !args.version && !args.autostart && !args.sendTestError;

if (inExecutable && willStart) {
  // The build embeds "manifest.json" (list of asset keys) plus one asset per file.
  const manifest = JSON.parse(sea.getAsset('manifest.json', 'utf8')) as { version: string; files: string[]; sha256?: Record<string, string> };
  const hash = createHash('sha256').update(manifest.files.join('\n')).update(manifest.version).digest('hex').slice(0, 10);
  const appDir = path.join(process.env.SM_DATA_DIR, 'app', `${manifest.version}-${hash}`);
  const marker = path.join(appDir, '.complete');
  // The unpacked copy is what the server serves and runs: check it against the hashes embedded in the
  // executable at every start, and unpack it again if a file was changed or removed.
  const intact = (): boolean => {
    if (!manifest.sha256) return true;
    for (const key of manifest.files) {
      const want = manifest.sha256[key];
      if (!want) continue;
      try {
        if (
          createHash('sha256')
            .update(fs.readFileSync(path.join(appDir, ...key.split('/'))))
            .digest('hex') !== want
        )
          return false;
      } catch {
        return false;
      }
    }
    return true;
  };
  if (fs.existsSync(marker) && !intact()) {
    console.error(`${BRAND.name}: the unpacked application files in ${appDir} were changed – unpacking them again.`);
    fs.rmSync(marker, { force: true });
  }
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
  process.env.SM_ASSETS_DIR ??= path.join(appDir, 'assets');
}
