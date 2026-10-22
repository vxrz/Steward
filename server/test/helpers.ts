import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  const port = 20000 + Math.floor(Math.random() * 20000);
  process.env.SM_DATA_DIR = dataDir;
  process.env.SM_PORT = String(port);
  process.env.SM_DEMO = '1';
  await import('../src/bootstrap.js');
  const { ensureDataDirs } = await import('../src/config.js');
  ensureDataDirs();
  const { buildApp } = await import('../src/app.js');
  const app = await buildApp();
  await app.listen({ host: '127.0.0.1', port });
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
