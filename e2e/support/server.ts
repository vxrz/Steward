import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MASTER_PASSPHRASE, ROOT, USERS } from './env';

/**
 * A separate, empty server for tests that change global state (e.g. the theme),
 * so they cannot disturb the tests running in parallel against the shared demo server.
 * Vault and the admin are set up; returns the base URL, the admin's session cookie and stop().
 */
export interface IsolatedServer {
  baseURL: string;
  adminCookie: string;
  /** Session binding keys of the admin session (the web app keeps them in localStorage) */
  sessionKey: string;
  linkKey: string;
  /** JSON API call as the admin */
  api: (method: string, url: string, body?: unknown) => Promise<any>;
  stop: () => Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): number {
  const script = "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})";
  return Number(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim());
}

export async function startIsolatedServer(): Promise<IsolatedServer> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-e2e-iso-'));
  const port = freePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const logFile = path.join(dataDir, 'server.log');
  const log = fs.createWriteStream(logFile);
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: path.join(ROOT, 'server'),
    env: {
      ...process.env,
      SM_DATA_DIR: dataDir,
      SM_PORT: String(port),
      SM_HOST: '127.0.0.1',
      SM_DEMO: '',
      SM_MASTER_PASSPHRASE: MASTER_PASSPHRASE,
      SM_LOG_LEVEL: 'warn',
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.pipe(log);
  child.stderr!.pipe(log);
  let exited: number | null | undefined;
  child.on('close', (code) => (exited = code));
  const stop = async () => {
    if (exited === undefined) {
      child.kill('SIGTERM');
      for (let i = 0; i < 50 && exited === undefined; i++) await sleep(100);
      if (exited === undefined) child.kill('SIGKILL');
    }
    log.end();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  try {
    const started = Date.now();
    for (;;) {
      if (exited !== undefined) throw new Error(`server exited with code ${exited}: ${fs.readFileSync(logFile, 'utf8').slice(-2000)}`);
      try {
        if ((await fetch(`${baseURL}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() - started > 60_000) throw new Error('server did not start within 60 s');
      await sleep(200);
    }
    const res = await fetch(`${baseURL}/api/auth/setup`, {
      method: 'POST',
      headers: { 'x-sm-client': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: MASTER_PASSPHRASE, username: USERS.admin.username, password: USERS.admin.password }),
    });
    if (!res.ok) throw new Error(`setup failed: HTTP ${res.status}`);
    const adminCookie = res.headers.get('set-cookie')!.split(';')[0]!;
    // session binding: the web app sends the session key with every API call
    const sessionKey = res.headers.get('x-sm-session-key') ?? '';
    const linkKey = res.headers.get('x-sm-link-key') ?? '';
    const api = async (method: string, url: string, body?: unknown) => {
      const r = await fetch(baseURL + '/api' + url, {
        method,
        headers: {
          'x-sm-client': '1',
          cookie: adminCookie,
          ...(sessionKey ? { 'x-sm-session': sessionKey } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`${method} ${url} → HTTP ${r.status}: ${text}`);
      return text ? JSON.parse(text) : null;
    };
    return { baseURL, adminCookie, sessionKey, linkKey, api, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}

/** Storage state with the given session cookie for a browser context on `baseURL`. */
export function sessionState(baseURL: string, cookie: string, keys: { sessionKey?: string; linkKey?: string } = {}) {
  const [name, ...v] = cookie.split('=');
  return {
    cookies: [{ name: name!, value: v.join('='), domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Strict' as const }],
    origins: [
      {
        origin: baseURL,
        localStorage: [
          ...(keys.sessionKey ? [{ name: 'sm.sessionKey', value: keys.sessionKey }] : []),
          ...(keys.linkKey ? [{ name: 'sm.linkKey', value: keys.linkKey }] : []),
        ],
      },
    ],
  };
}
