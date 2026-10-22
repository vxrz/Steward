/**
 * Desktop entry: starts the server for the current user and opens the UI in an
 * app window (Edge/Chrome "--app" mode, falling back to the default browser).
 * Running it again while it is already running just opens the window.
 */
import { args, inExecutable } from './env.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BRAND } from '@sm/shared';

const HELP = `${BRAND.name}

Usage: ${BRAND.slug} [options]

  --port <n>           Port (default 4310)
  --data-dir <path>    Data folder (default: per-user app data folder)
  --no-open            Do not open a window (e.g. when started at sign-in)
  --demo               Demo mode with mock platforms
  --autostart on|off   Start automatically when you sign in (for schedules)
  --version            Print the version
  --help               This help

Environment variables (SM_HOST, SM_MASTER_PASSPHRASE, OTEL_*, …) work as for the server.
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
  const p = spawn(cmd, argv, { detached: true, stdio: 'ignore', windowsHide: true });
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

async function alreadyRunning(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
    const body = (await res.json()) as { ok?: boolean };
    return res.ok && body.ok === true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  if (args.help) return void console.log(HELP);
  const { config } = await import('../config.js');
  if (args.version) return void console.log(config.version);
  if (args.autostart) return void console.log(setAutostart(args.autostart === 'on'));
  if (inExecutable && config.database.kind !== 'sqlite') {
    console.error('The desktop executable always uses its built-in SQLite database – PostgreSQL (SM_DATABASE_URL) needs the Node.js or container version. Unset SM_DATABASE_URL.');
    process.exitCode = 1;
    return;
  }

  const host = config.host === '0.0.0.0' ? 'localhost' : config.host;
  const url = `${config.tls ? 'https' : 'http'}://${host}:${config.port}`;
  if (await alreadyRunning(url)) {
    console.log(`${BRAND.name} is already running – opening ${url}`);
    if (args.open) openWindow(url);
    return;
  }
  const { start } = await import('../main.js');
  const started = await start({ banner: true });
  console.log(`  Close this window (or press Ctrl+C) to stop ${BRAND.name}.\n`);
  if (args.open) openWindow(started.url);
}

main().catch((e) => {
  const err = e as NodeJS.ErrnoException;
  if (err.code === 'EADDRINUSE') console.error(`Port in use. Start with --port <other port>.`);
  else console.error(err?.stack ?? err);
  process.exitCode = 1;
});
