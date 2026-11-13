import fs from 'node:fs';
import { afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';

export type Client = (<T = any>(method: string, url: string, body?: unknown) => Promise<T>) & {
  /** The client's cookies as a Cookie header (session cookie, single sign-on binding cookies) */
  cookies?: () => string;
};
export interface ClientOptions {
  /** Confirm with the sign-in password when a route asks for a step-up (default: true) */
  autoStepUp?: boolean;
}

export const ADMIN = { username: 'admin', password: 'Admin-password-1' };

/** Set up vault + first admin (signed in on `api`). */
export async function setup(s: TestServer): Promise<void> {
  await s.api('POST', '/auth/setup', { passphrase: 'correct horse battery', username: ADMIN.username, displayName: 'Admin', password: ADMIN.password });
}

/**
 * Sets (or, with undefined, removes) environment variables while the server runs and re-reads them: the server
 * validates SM_* variables once (config.ts), so a change only counts after reloadConfig(). Before the server
 * started, set process.env directly – the configuration reads it when it loads.
 */
export async function setEnv(vars: Record<string, string | undefined>): Promise<void> {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  (await import('../src/config.js')).reloadConfig();
}

export interface TestServer {
  app: FastifyInstance;
  base: string;
  api: Client;
  /**
   * Sign in as another user. Like the web app's step-up dialog, the client confirms with the password it signed in with
   * when a sensitive route answers STEP_UP_REQUIRED, and sends the request again once (`autoStepUp: false`: never).
   */
  as: (username: string, password: string, opts?: ClientOptions) => Promise<Client>;
  /** A new client without a session (sign in with POST /auth/login) */
  client: (opts?: ClientOptions) => Client;
  waitRun: (id: string, statuses?: string[]) => Promise<any>;
  dataDir: string;
}

/**
 * `dataDir`: start on an existing data folder (e.g. a copy of an upgrade fixture) instead of a new one. `routes`:
 * test-only routes, added before the server listens.
 */
/**
 * Servers this test file started and has not closed yet, and the data folders it created: after the file's last hook
 * the servers are closed and the folders removed. Registered at import, so with vitest's stacked hooks this runs after
 * the file's own afterAll hooks: a file needs no afterAll of its own for its server, and one that closes a server
 * early (or starts a second server on a folder) keeps working.
 */
const openServers = new Set<FastifyInstance>();
const createdDataDirs: string[] = [];
afterAll(async () => {
  for (const app of [...openServers]) await app.close();
  for (const dir of createdDataDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // a file still open (e.g. on Windows) keeps the folder; the system's temp cleanup takes it later
    }
  }
});

export async function startTestServer(opts: { dataDir?: string; routes?: (app: FastifyInstance) => void } = {}): Promise<TestServer> {
  const dataDir = opts.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sm-test-'));
  if (!opts.dataDir) createdDataDirs.push(dataDir);
  process.env.SM_DATA_DIR = dataDir;
  // Port 0: the system assigns a free port, so parallel test runs (and outgoing connections, whose
  // local ports come from the same range) can never take it between choosing and binding.
  process.env.SM_PORT = '0';
  process.env.SM_DEMO = '1';
  await import('../src/warnings.js');
  const { config, ensureDataDirs } = await import('../src/config.js');
  ensureDataDirs();
  const { buildApp } = await import('../src/app.js');
  const app = await buildApp();
  // Close every connection before the server waits for them: a raw fetch whose body is never read keeps its keep-alive
  // socket busy, and app.close() would wait for it up to the hook timeout (seen in CI on plant-map.test.ts).
  app.addHook('preClose', async () => app.server.closeAllConnections());
  app.addHook('onClose', async () => {
    openServers.delete(app);
  });
  openServers.add(app);
  opts.routes?.(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  // what main.ts does for SM_PORT=0: the instance proof, the own-API guard and demo URLs use the real port
  config.port = port;
  process.env.SM_PORT = String(port);
  // under a path prefix (SM_BASE_PATH) everything lives below it
  const base = `http://127.0.0.1:${port}${config.basePath}`;
  const client = (opts: ClientOptions = {}): Client => {
    // a small cookie jar, like a browser's: the session cookie and the single sign-on binding cookies (auth/cookies.ts)
    const jar = new Map<string, string>();
    let cookie = '';
    // the session cookie plus the session key the web app keeps in localStorage (session binding)
    let sessionKey = '';
    // the password of the sign-in, for step-ups (auth/step-up.ts)
    let password = '';
    const call = async (method: string, url: string, body?: unknown, retried = false): Promise<any> => {
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
      storeCookies(jar, res);
      cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      const key = res.headers.get('x-sm-session-key');
      if (key !== null) sessionKey = key;
      const text = await res.text();
      const data = text ? (res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) : null;
      if (!res.ok) {
        if (
          res.status === 403 &&
          data?.code === 'STEP_UP_REQUIRED' &&
          data.stepUp?.method === 'password' &&
          password &&
          !retried &&
          opts.autoStepUp !== false
        ) {
          await call('POST', '/auth/step-up', { password }, true);
          return call(method, url, body, true);
        }
        throw Object.assign(new Error(`${method} ${url} → ${res.status}: ${text}`), { status: res.status, body: data });
      }
      if ((url === '/auth/login' || url === '/auth/setup') && typeof (body as { password?: unknown })?.password === 'string')
        password = (body as { password: string }).password;
      return data;
    };
    return Object.assign((method: string, url: string, body?: unknown) => call(method, url, body), { cookies: () => cookie }) as Client;
  };
  const api = client();
  const as = async (username: string, password: string, opts?: ClientOptions) => {
    const c = client(opts);
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
  return { app, base, api, as, client, waitRun, dataDir };
}

/**
 * A client for a session from a single sign-on (cookie and session key from the callback page). It keeps the cookies
 * the answers set, like a browser: a step-up through single sign-on sets a binding cookie (`cookies()` for the callback).
 */
export function sessionClient(base: string, sessionCookie: string, sessionKey: string): Client {
  const at = sessionCookie.indexOf('=');
  const jar = new Map([[sessionCookie.slice(0, at), sessionCookie.slice(at + 1)]]);
  const cookies = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(base + '/api' + url, {
      method,
      headers: { 'x-sm-client': '1', cookie: cookies(), 'x-sm-session': sessionKey, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    storeCookies(jar, res);
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw Object.assign(new Error(`${method} ${url} → ${res.status}: ${text}`), { status: res.status, body: data });
    return data;
  };
  return Object.assign(call, { cookies }) as Client;
}

/** Keeps the cookies a response sets in `jar` (a cookie set with Max-Age=0 is removed). */
export function storeCookies(jar: Map<string, string>, res: Response): void {
  for (const set of res.headers.getSetCookie()) {
    const [pair = '', ...attributes] = set.split(';');
    const at = pair.indexOf('=');
    const name = pair.slice(0, at).trim();
    if (attributes.some((a) => /^\s*max-age=0\s*$/i.test(a))) jar.delete(name);
    else jar.set(name, pair.slice(at + 1));
  }
}

/**
 * The single sign-on binding cookie(s) a start response sets (auth/cookies.ts ssoBindingCookie), as a Cookie header:
 * the browser that started the sign-in sends it with the callback.
 */
export function ssoBinding(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .filter((c) => /^(__Host-|__Secure-)?sm_sso_/.test(c))
    .join('; ');
}

/** The Set-Cookie header of the session cookie in a response, or null (other cookies, such as a cleared binding cookie, are left out). */
export function sessionSetCookie(res: Response): string | null {
  return res.headers.getSetCookie().find((c) => /^(__Host-|__Secure-)?sm_session=/.test(c)) ?? null;
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
/** Confirms the session of a cookie from loginCookie with the password (step-up, auth/step-up.ts). */
export async function stepUpCookie(base: string, cookie: string, password: string): Promise<void> {
  const res = await fetch(base + '/api/auth/step-up', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sm-client': '1', ...authHeaders(cookie) },
    body: JSON.stringify({ password }),
  });
  if (res.status !== 200) throw new Error(`step-up → ${res.status}: ${await res.text()}`);
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

/**
 * A refused single sign-on shows the person only a reference (?sso_error=SSO_SIGN_IN_REFUSED&sso_ref=abcd1234); the
 * reason is in the audit entry with that reference. Returns the redirect followed by that entry's summary.
 */
export async function withRefusalReason(s: TestServer, location: string): Promise<string> {
  const text = decodeURIComponent(location);
  const ref = /[?&]sso_ref=([0-9a-f]{8})/.exec(text)?.[1];
  if (!ref) return text;
  const entries = (await s.api('GET', '/audit?action=auth.login_failed&limit=50')) as { summary: string }[];
  return `${text} | ${entries.find((e) => e.summary.includes(`reference ${ref}`))?.summary ?? 'no audit entry'}`;
}

/**
 * Stores an access list of a process, platform, identity, monitor or site the way the migration of 0.23.0 does (ADR
 * 0033: shares, and Restricted when the list has entries) – directly in the database, without audit, for tests that
 * plant a state. An empty list removes the shares and the scope.
 */
export async function storeAcl(
  kind: 'process' | 'platform' | 'platform_identity' | 'monitor' | 'site',
  id: string,
  acl: { subject: string; permissions: string[] }[],
): Promise<void> {
  const { db } = await import('../src/db.js');
  const { aclToShares } = await import('../src/auth/acl-shares.js');
  const { sharesChanged } = await import('../src/auth/share-store.js');
  const at = new Date().toISOString();
  db().tx(() => {
    db().run('DELETE FROM resource_shares WHERE kind = ? AND resource_id = ?', kind, id);
    db().run('DELETE FROM resource_restrictions WHERE kind = ? AND resource_id = ?', kind, id);
    for (const s of aclToShares(kind, acl))
      db().run(
        'INSERT INTO resource_shares (kind, resource_id, subject, level, actions, expires_at, rights, created_by, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)',
        kind,
        id,
        s.subject,
        s.level,
        JSON.stringify(s.actions ?? []),
        s.rights ? JSON.stringify(s.rights) : null,
        'test',
        at,
      );
    if (kind !== 'platform_identity' && acl.length)
      db().run('INSERT INTO resource_restrictions (kind, resource_id, created_by, created_at) VALUES (?, ?, ?, ?)', kind, id, 'test', at);
  });
  sharesChanged();
}
