/**
 * Desktop entry: starts the server for the current user and opens the UI in an
 * app window (Edge/Chrome "--app" mode, falling back to the default browser).
 * Running it again while it is already running just opens the window.
 */
import { adminArgv, args, inExecutable, usageError } from './env.js';
import { EXIT_FAILURE, EXIT_OK, usageFailure } from '../cli/args.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BRAND } from '@sm/shared';
import { browserEnv } from './launcher-env.js';

const HELP = `${BRAND.name} – desktop launcher

Starts ${BRAND.name} for the current user and opens it in an app window.
Running it again while it is already running just opens the window.

Usage:
  ${BRAND.slug} [options]

Options:
  --port <n>           Port (default 4310, or $SM_PORT)
  --data-dir <path>    Data folder (default: per-user app data folder, or $SM_DATA_DIR)
  --no-open            Do not open a window (e.g. when started at sign-in)
  --demo               Demo mode with mock platforms
  --autostart on|off   Start automatically when you sign in (for schedules), then exit
  --send-test-error    Send a test event to the error tracker ($SM_SENTRY_DSN) and exit
  admin …              Account recovery, e.g. 'admin reset-password <user>' (see 'admin --help')
  -V, --version        Print the version
  -h, --help           Show this help

Examples:
  ${BRAND.slug}                                  start and open the window
  ${BRAND.slug} --no-open --port 4400            start in the background on another port
  ${BRAND.slug} --autostart on                   start at every sign-in
  SM_SENTRY_DSN=https://… ${BRAND.slug} --send-test-error

Environment variables (SM_HOST, SM_MASTER_PASSPHRASE_FILE, SM_SENTRY_DSN, OTEL_*, …) work as
for the server; see the README.

Exit status: 0 = ok, 1 = failure (e.g. port in use), 2 = usage error.
`;

function candidates(): string[] {
  const pf = process.env.PROGRAMFILES ?? 'C:\\Program Files';
  const pf86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  if (process.platform === 'win32') {
    return [
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  return ['microsoft-edge', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].flatMap((b) => dirs.map((d) => path.join(d, b)));
}

function detached(cmd: string, argv: string[]): void {
  const p = spawn(cmd, argv, { detached: true, stdio: 'ignore', windowsHide: true, env: browserEnv() });
  p.on('error', () => undefined);
  p.unref();
}

/** Opens the UI as an app window if Edge/Chrome is installed, else in the default browser. */
export function openWindow(url: string): void {
  const browser = candidates().find((c) => fs.existsSync(c));
  if (browser) return detached(browser, [`--app=${url}`]);
  if (process.platform === 'win32') return detached('cmd', ['/c', 'start', '""', url]);
  if (process.platform === 'darwin') return detached('open', [url]);
  detached('xdg-open', [url]);
}

/** Sign-in autostart without admin rights (Startup folder / LaunchAgent / XDG autostart). */
export function setAutostart(on: boolean): string {
  const exe = process.execPath;
  const runArgs = inExecutable ? ['--no-open'] : [process.argv[1]!, '--no-open'];
  if (process.platform === 'win32') {
    const dir = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    const file = path.join(dir, `${BRAND.slug}.vbs`);
    if (!on) return (fs.rmSync(file, { force: true }), `Removed ${file}`);
    // VBScript wrapper starts it without a console window
    const cmd = [exe, ...runArgs].map((a) => `""${a}""`).join(' ');
    fs.writeFileSync(file, `CreateObject("WScript.Shell").Run "${cmd}", 0, False\r\n`);
    return `Created ${file}`;
  }
  if (process.platform === 'darwin') {
    const file = path.join(os.homedir(), 'Library', 'LaunchAgents', `com.${BRAND.slug}.plist`);
    if (!on) return (fs.rmSync(file, { force: true }), `Removed ${file} (takes effect at next sign-in)`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const items = [exe, ...runArgs].map((a) => `<string>${a.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string>`).join('');
    fs.writeFileSync(
      file,
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.${BRAND.slug}</string><key>ProgramArguments</key><array>${items}</array><key>RunAtLoad</key><true/></dict></plist>\n`,
    );
    return `Created ${file}`;
  }
  const file = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'autostart', `${BRAND.slug}.desktop`);
  if (!on) return (fs.rmSync(file, { force: true }), `Removed ${file}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const execLine = [exe, ...runArgs].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
  fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=${BRAND.name}\nExec=${execLine}\nX-GNOME-Autostart-enabled=true\n`);
  return `Created ${file}`;
}

/** Whether anything answers on the port (Steward or not). */
async function portAnswers(url: string): Promise<boolean> {
  try {
    await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

/** --send-test-error: checks the error reporting configuration end to end. */
async function sendTestError(): Promise<number> {
  const { initErrorReporting, sendTestEvent, errorReportingSettings, parseDsn } = await import('../errorReporting.js');
  const settings = errorReportingSettings();
  if (!settings.dsn) {
    console.error(
      process.env.SM_SENTRY_DSN ? 'SM_SENTRY_DSN is not a valid DSN (https://<key>@<host>/<project>).' : 'SM_SENTRY_DSN is not set – error reporting is off.',
    );
    return EXIT_FAILURE;
  }
  if (!(await initErrorReporting())) {
    console.error('Error reporting could not be started (see the warning above).');
    return EXIT_FAILURE;
  }
  const host = parseDsn(settings.dsn)!.host;
  console.error(`Sending a test event to ${host} …`);
  const { id, status } = await sendTestEvent(10000);
  if (!id || !status || status >= 400) {
    console.error(
      status
        ? `The error tracker at ${host} answered HTTP ${status} (wrong DSN or project?).`
        : `Could not deliver the test event to ${host} within 10 s (network, proxy or DSN?).`,
    );
    return EXIT_FAILURE;
  }
  console.log(`Sent test event ${id} (environment ${settings.environment}, release ${settings.release}).`);
  return EXIT_OK;
}

async function main(): Promise<number> {
  if (adminArgv) {
    const { runAdmin } = await import('../cli/admin.js');
    return runAdmin(adminArgv, `${BRAND.slug} admin`);
  }
  if (usageError) return usageFailure(usageError, BRAND.slug);
  if (args.help) {
    process.stdout.write(HELP);
    return EXIT_OK;
  }
  const { config } = await import('../config.js');
  if (args.version) {
    console.log(config.version);
    return EXIT_OK;
  }
  if (args.autostart) {
    console.log(setAutostart(args.autostart === 'on'));
    return EXIT_OK;
  }
  if (inExecutable && config.database.kind !== 'sqlite') {
    console.error(
      'The desktop executable always uses its built-in SQLite database – PostgreSQL (SM_DATABASE_URL) needs the Node.js or container version. Unset SM_DATABASE_URL.',
    );
    return EXIT_FAILURE;
  }
  if (args.sendTestError) return sendTestError();

  const host = config.host === '0.0.0.0' ? 'localhost' : config.host;
  const url = `${config.tls ? 'https' : 'http'}://${host}:${config.port}`;
  if (await portAnswers(url)) {
    // Only open the window when it is *our* Steward: it has to prove that it knows the secret in our data folder.
    const { verifyInstance } = await import('../instance.js');
    const identity = await verifyInstance(url, config.dataDir);
    if (identity !== 'ok') {
      console.error(
        `Port ${config.port} is in use by another program – it is not ${BRAND.name} started from your data folder (${config.dataDir}).\n` +
          `Not opening it: it could be a look-alike asking for your passphrase. Start with --port <other port>, or find out what listens on port ${config.port}.`,
      );
      return EXIT_FAILURE;
    }
    console.log(`${BRAND.name} is already running – opening ${url}`);
    if (args.open) openWindow(url);
    return EXIT_OK;
  }
  const { start } = await import('../main.js');
  const started = await start({ banner: true });
  console.log(`  Close this window (or press Ctrl+C) to stop ${BRAND.name}.\n`);
  if (args.open) openWindow(started.url);
  return EXIT_OK;
}

main().then(
  (code) => {
    if (code !== EXIT_OK) process.exitCode = code;
  },
  (e) => {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'EADDRINUSE') console.error(`Port in use. Start with --port <other port>.`);
    else console.error(err?.stack ?? err);
    process.exitCode = EXIT_FAILURE;
  },
);
