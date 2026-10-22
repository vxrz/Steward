/**
 * Starts ONE demo server for the whole UI test run:
 *   fresh temp data dir · SM_DEMO=1 (mock platforms under /mock) · serves the built web/dist
 * then sets up the vault + admin, loads the demo data, waits for the initial feeder runs
 * and stores a signed-in session (storage state) for the admin and every demo user.
 * The returned function is the global teardown (kills the server, removes the data dir).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FullConfig } from '@playwright/test';
import { AUTH_DIR, MASTER_PASSPHRASE, ROOT, USERS, authFile, baseURL, type UserKey } from './support/env';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tail = (file: string, lines = 25) => {
  try {
    return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
};

/** A signed-in session: the cookie plus the keys the web app keeps in localStorage (session binding). */
interface Session {
  cookie: string;
  sessionKey: string;
  linkKey: string;
}

async function http(method: string, url: string, body?: unknown, session?: Session): Promise<{ status: number; json: any; session?: Session }> {
  const res = await fetch(baseURL() + url, {
    method,
    headers: {
      'x-sm-client': '1',
      ...(session ? { cookie: session.cookie, 'x-sm-session': session.sessionKey } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const set = res.headers.get('set-cookie');
  const key = res.headers.get('x-sm-session-key');
  return {
    status: res.status,
    json: text ? JSON.parse(text) : null,
    session: set && key ? { cookie: set.split(';')[0]!, sessionKey: key, linkKey: res.headers.get('x-sm-link-key') ?? '' } : undefined,
  };
}

async function must(method: string, url: string, body?: unknown, cookie?: Session) {
  const r = await http(method, url, body, cookie);
  if (r.status >= 400) throw new Error(`${method} ${url} → HTTP ${r.status}: ${JSON.stringify(r.json)}`);
  return r;
}

function writeStorageState(user: UserKey, session: Session) {
  const [name, ...v] = session.cookie.split('=');
  const state = {
    cookies: [{ name, value: v.join('='), domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Strict' as const }],
    origins: [
      {
        origin: baseURL(),
        localStorage: [
          { name: 'sm.lastUser', value: USERS[user].username },
          { name: 'sm.sessionKey', value: session.sessionKey },
          { name: 'sm.linkKey', value: session.linkKey },
        ],
      },
    ],
  };
  fs.writeFileSync(authFile(user), JSON.stringify(state, null, 2));
}

export default async function globalSetup(_config: FullConfig): Promise<() => Promise<void>> {
  const dist = path.join(ROOT, 'web', 'dist', 'index.html');
  if (!fs.existsSync(dist)) {
    throw new Error(`\n\nThe UI tests need the built web UI, but ${path.relative(ROOT, dist)} is missing.\nRun "npm run build" first, then "npm run test:ui".\n`);
  }
  if (!process.env.SM_E2E_PORT) throw new Error('SM_E2E_PORT is not set (playwright.config.ts chooses it)');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-e2e-'));
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const logFile = path.join(AUTH_DIR, 'server.log');
  const log = fs.createWriteStream(logFile);

  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: path.join(ROOT, 'server'),
    env: {
      ...process.env,
      SM_DATA_DIR: dataDir,
      SM_PORT: process.env.SM_E2E_PORT,
      SM_HOST: '127.0.0.1',
      SM_DEMO: '1',
      SM_MASTER_PASSPHRASE: MASTER_PASSPHRASE,
      SM_LOG_LEVEL: process.env.SM_LOG_LEVEL ?? 'info',
      // never reach out to a real collector or proxy from the tests
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.pipe(log);
  child.stderr!.pipe(log);
  let exited: number | null | undefined;
  child.on('close', (code) => (exited = code));
  const killOnExit = () => child.kill('SIGKILL');
  process.on('exit', killOnExit);

  const teardown = async () => {
    process.off('exit', killOnExit);
    if (exited === undefined) {
      child.kill('SIGTERM');
      for (let i = 0; i < 50 && exited === undefined; i++) await sleep(100);
      if (exited === undefined) child.kill('SIGKILL');
    }
    log.end();
    if (!process.env.SM_E2E_KEEP_DATA) fs.rmSync(dataDir, { recursive: true, force: true });
    else console.log(`[e2e] kept data dir ${dataDir}`);
  };

  try {
    // 1. wait for the server
    const started = Date.now();
    for (;;) {
      if (exited !== undefined) throw new Error(`demo server exited with code ${exited} – log ${logFile}:\n${tail(logFile)}`);
      try {
        if ((await fetch(baseURL() + '/api/health')).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() - started > 60_000) throw new Error(`demo server did not start within 60 s – log ${logFile}:\n${tail(logFile)}`);
      await sleep(200);
    }

    // 2. vault + first admin, demo data
    const setup = await must('POST', '/api/auth/setup', { passphrase: MASTER_PASSPHRASE, username: USERS.admin.username, password: USERS.admin.password });
    const adminCookie = setup.session!;
    await must('POST', '/api/demo/setup', {}, adminCookie);

    // 3. wait until the initial feeder runs (dashboards) have finished
    for (let i = 0; ; i++) {
      const runs = (await must('GET', '/api/runs?limit=200', undefined, adminCookie)).json as { status: string }[];
      if (runs.length > 0 && runs.every((r) => !['queued', 'running'].includes(r.status))) break;
      if (i > 300) throw new Error('initial demo runs did not finish within 60 s');
      await sleep(200);
    }

    // 4. one session per user (the admin re-uses the setup session)
    writeStorageState('admin', adminCookie);
    for (const key of Object.keys(USERS) as UserKey[]) {
      if (key === 'admin') continue;
      const r = await must('POST', '/api/auth/login', { username: USERS[key].username, password: USERS[key].password });
      writeStorageState(key, r.session!);
    }
  } catch (e) {
    await teardown();
    throw e;
  }
  return teardown;
}
