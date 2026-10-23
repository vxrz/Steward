import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';

export type Client = <T = any>(method: string, url: string, body?: unknown) => Promise<T>;

export const ADMIN = { username: 'admin', password: 'Admin-password-1' };

/** Set up vault + first admin (signed in on `api`). */
export async function setup(s: TestServer): Promise<void> {
  await s.api('POST', '/auth/setup', { passphrase: 'correct horse battery', username: ADMIN.username, displayName: 'Admin', password: ADMIN.password });
}

export interface TestServer {
  app: FastifyInstance;
  base: string;
  api: Client;
  /** Sign in as another user */
  as: (username: string, password: string) => Promise<Client>;
  waitRun: (id: string, statuses?: string[]) => Promise<any>;
  dataDir: string;
}

export async function startTestServer(): Promise<TestServer> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-test-'));
  process.env.SM_DATA_DIR = dataDir;
  // Port 0: the system assigns a free port, so parallel test runs (and outgoing connections, whose
  // local ports come from the same range) can never take it between choosing and binding.
  process.env.SM_PORT = '0';
  process.env.SM_DEMO = '1';
  await import('../src/bootstrap.js');
  const { config, ensureDataDirs } = await import('../src/config.js');
  ensureDataDirs();
  const { buildApp } = await import('../src/app.js');
  const app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  // what main.ts does for SM_PORT=0: the instance proof, the own-API guard and demo URLs use the real port
  config.port = port;
  process.env.SM_PORT = String(port);
  const base = `http://127.0.0.1:${port}`;
  const client = (): Client => {
    let cookie = '';
    // the session cookie plus the session key the web app keeps in localStorage (session binding)
    let sessionKey = '';
    const call = async (method: string, url: string, body?: unknown) => {
      const res = await fetch(base + '/api' + url, {
        method,
        headers: {
          'x-sm-client': '1',
          ...(cookie ? { cookie } : {}),
          ...(sessionKey ? { 'x-sm-session': sessionKey } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0]!;
      const key = res.headers.get('x-sm-session-key');
      if (key !== null) sessionKey = key;
      const text = await res.text();
      const data = text ? (res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) : null;
      if (!res.ok) throw Object.assign(new Error(`${method} ${url} → ${res.status}: ${text}`), { status: res.status });
      return data;
    };
    return call as Client;
  };
  const api = client();
  const as = async (username: string, password: string) => {
    const c = client();
    await c('POST', '/auth/login', { username, password });
    return c;
  };
  const waitRun = async (id: string, statuses = ['succeeded', 'failed', 'cancelled', 'waiting']) => {
    for (let i = 0; i < 300; i++) {
      const r = await api('GET', `/runs/${id}`);
      if (statuses.includes(r.status)) return r;
      await new Promise((res) => setTimeout(res, 100));
    }
    throw new Error(`Run ${id} did not reach ${statuses}`);
  };
  return { app, base, api, as, waitRun, dataDir };
}

const sessionKeys = new Map<string, string>();
/** Signs in with fetch and returns the raw session cookie (its session key is remembered for authHeaders). */
export async function loginCookie(base: string, username: string, password: string): Promise<string> {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sm-client': '1' },
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 200) throw new Error(`login ${username} → ${res.status}`);
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  sessionKeys.set(cookie, res.headers.get('x-sm-session-key') ?? '');
  return cookie;
}
/** Cookie plus session key header (session binding) for a cookie from loginCookie. */
export function authHeaders(cookie: string): Record<string, string> {
  const key = sessionKeys.get(cookie);
  return { cookie, ...(key ? { 'x-sm-session': key } : {}) };
}

/** Allows plain e-mail addresses of these domains (credential owners, report recipients; see notifications/domains.ts). */
export async function allowEmailDomains(s: TestServer, domains: string[]): Promise<void> {
  const current = await s.api('GET', '/settings/notifications');
  await s.api('PUT', '/settings/notifications', { ...current, allowedEmailDomains: domains });
}

/**
 * The address a server child process announces in its "service manager started" log line
 * (SM_LOG_LEVEL=info) – start it with SM_PORT=0 and read the port the system assigned from here.
 */
export function startedUrl(stdout: string): string | undefined {
  for (const line of stdout.split('\n')) {
    if (!line.includes('"service manager started"')) continue;
    return (JSON.parse(line) as { url: string }).url;
  }
  return undefined;
}

/**
 * Stops the background work that writes audit entries and sends notifications on its own: waits
 * until no process run is active (e.g. the feeder runs that /demo/setup starts), disarms the cron
 * schedules (the demo schedules fire every few minutes) and stops the demo gateway simulator (it
 * posts heartbeats through the real API). For tests that rewrite the audit chain or count entries,
 * e-mails or pending items – under load those runs finish seconds later and would interleave with
 * the test. Call it before the test starts runs that wait for a user task (they stay active).
 */
export async function quiesce(timeoutMs = 60000): Promise<void> {
  const { stopScheduler } = await import('../src/scheduler.js');
  const { activeRunIds } = await import('../src/engine/runner.js');
  const { stopGatewaySimulator } = await import('../src/monitors/demo.js');
  stopScheduler();
  stopGatewaySimulator();
  const until = Date.now() + timeoutMs;
  while (activeRunIds().length) {
    if (Date.now() > until) throw new Error(`runs still active after ${timeoutMs} ms: ${activeRunIds().join(', ')}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  const { flushNotifications } = await import('../src/notifications/service.js');
  await flushNotifications();
}
