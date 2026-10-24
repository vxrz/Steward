import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startReverseProxy, type ReverseProxy } from '../../scripts/reverse-proxy.mjs';
import { injectBaseHref, parseBasePath, resolveBasePath, stripBasePath, withBasePath, OUTSIDE_BASE } from '../src/basePath.js';
import { setup, startTestServer, type TestServer } from './helpers.js';

// Steward under https://apps.example.com/steward behind a TLS-terminating reverse proxy (issue #50):
// every request of this file goes through a real (minimal) reverse proxy, like nginx/Traefik/Caddy in production.

describe('SM_BASE_PATH parsing', () => {
  it('normalises the prefix and treats empty and / as the root', () => {
    expect(parseBasePath(undefined)).toBe('');
    expect(parseBasePath('')).toBe('');
    expect(parseBasePath(' / ')).toBe('');
    expect(parseBasePath('/steward')).toBe('/steward');
    expect(parseBasePath('steward/')).toBe('/steward');
    expect(parseBasePath('/tools/steward-prod.v2~x/')).toBe('/tools/steward-prod.v2~x');
  });

  it('refuses dot segments, empty segments, encoded or reserved characters and overlong values', () => {
    for (const bad of ['/a/../b', '/..', '/./x', '/a//b', '/st%65ward', '/a b', '/a?b', '/a#b', '/a;b', '/ä', '/a\\b', '/' + 'x'.repeat(100)]) {
      expect(() => parseBasePath(bad), bad).toThrow(/SM_BASE_PATH/);
    }
  });

  it('takes the base path from SM_PUBLIC_URL and requires both to agree', () => {
    expect(resolveBasePath({})).toEqual({ basePath: '', publicUrl: undefined });
    expect(resolveBasePath({ SM_PUBLIC_URL: 'https://steward.example.com/' })).toEqual({ basePath: '', publicUrl: 'https://steward.example.com' });
    expect(resolveBasePath({ SM_PUBLIC_URL: 'https://Apps.Example.com:443/steward/' })).toEqual({
      basePath: '/steward',
      publicUrl: 'https://apps.example.com/steward',
    });
    expect(resolveBasePath({ SM_BASE_PATH: '/steward' })).toEqual({ basePath: '/steward', publicUrl: undefined });
    expect(resolveBasePath({ SM_BASE_PATH: 'steward', SM_PUBLIC_URL: 'https://apps.example.com/steward' }).basePath).toBe('/steward');
    expect(() => resolveBasePath({ SM_BASE_PATH: '/steward', SM_PUBLIC_URL: 'https://apps.example.com' })).toThrow(/differ/);
    expect(() => resolveBasePath({ SM_BASE_PATH: '/steward', SM_PUBLIC_URL: 'https://apps.example.com/other' })).toThrow(/differ/);
    expect(() => resolveBasePath({ SM_PUBLIC_URL: 'https://apps.example.com/a/../steward' })).toThrow(/"\.\."/);
    expect(() => resolveBasePath({ SM_PUBLIC_URL: 'https://apps.example.com/st%65ward' })).toThrow(/SM_PUBLIC_URL/);
    expect(() => resolveBasePath({ SM_PUBLIC_URL: 'steward.example.com' })).toThrow(/absolute URL/);
    expect(() => resolveBasePath({ SM_PUBLIC_URL: 'ftp://steward.example.com' })).toThrow(/https:\/\//);
    expect(() => resolveBasePath({ SM_PUBLIC_URL: 'https://u:p@steward.example.com' })).toThrow(/user name/);
    expect(() => resolveBasePath({ SM_PUBLIC_URL: 'https://steward.example.com/?x=1' })).toThrow(/query/);
  });

  it('strips the prefix literally and marks everything else as outside', () => {
    const strip = (url: string) => {
      const req: { url: string; [OUTSIDE_BASE]?: boolean } = { url };
      const out = stripBasePath(req, '/steward');
      return req[OUTSIDE_BASE] ? 'outside' : out;
    };
    expect(strip('/steward')).toBe('/');
    expect(strip('/steward/')).toBe('/');
    expect(strip('/steward?x=1')).toBe('/?x=1');
    expect(strip('/steward/api/health?x=/steward')).toBe('/api/health?x=/steward');
    for (const u of ['/', '/api/health', '/stewardx', '/stewardx/api', '/Steward/api/health', '/steward%2Fapi/health', '//steward/api', '/x/steward/api'])
      expect(strip(u), u).toBe('outside');
    // not origin-form: left for the 400 check
    expect(strip('http://evil.example/steward/api/health')).toBe('http://evil.example/steward/api/health');
  });

  it('keeps redirects to app paths below the prefix, other targets unchanged', () => {
    expect(withBasePath('/?sso_error=x', '/steward')).toBe('/steward/?sso_error=x');
    expect(withBasePath('//evil.example/x', '/steward')).toBe('//evil.example/x');
    expect(withBasePath('/\\evil.example', '/steward')).toBe('/\\evil.example');
    expect(withBasePath('https://idp.example/authorize', '/steward')).toBe('https://idp.example/authorize');
    expect(withBasePath('/x', '')).toBe('/x');
  });

  it('writes the base into index.html', () => {
    expect(injectBaseHref('<html><head><base href="/" /><title>x</title>', '/steward')).toBe('<html><head><base href="/steward/" /><title>x</title>');
    expect(injectBaseHref('<html><head lang="en"><title>x</title>', '')).toBe('<html><head lang="en"><base href="/" /><title>x</title>');
    expect(injectBaseHref('<!doctype html><title>x</title>', '/a')).toBe('<!doctype html><base href="/a/" /><title>x</title>');
  });
});

let s: TestServer;
let proxy: ReverseProxy;
let stripping: ReverseProxy;
/** The public address of this test: the proxy plus the base path. */
let P: string;
const web = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-web-base-'));
const ENV = ['SM_BASE_PATH', 'SM_PUBLIC_URL', 'SM_TRUST_PROXY', 'SM_WEB_DIST', 'SM_API_DOCS'];

beforeAll(async () => {
  fs.mkdirSync(path.join(web, 'assets'));
  fs.writeFileSync(
    path.join(web, 'index.html'),
    '<!doctype html><html><head><base href="/" /><script type="module" src="./assets/app-abc123.js"></script><title>Steward</title></head><body></body></html>',
  );
  fs.writeFileSync(path.join(web, 'assets', 'app-abc123.js'), 'console.log(1);');
  fs.writeFileSync(path.join(web, 'sw.js'), '// service worker');
  fs.writeFileSync(
    path.join(web, 'manifest.webmanifest'),
    JSON.stringify({ start_url: '/', scope: '/', icons: [{ src: '/icon.svg', sizes: 'any' }], shortcuts: [{ name: 'Runs', url: '/runs' }] }),
  );
  process.env.SM_WEB_DIST = web;
  process.env.SM_BASE_PATH = '/steward';
  process.env.SM_PUBLIC_URL = 'https://apps.example.com/steward/';
  process.env.SM_TRUST_PROXY = '127.0.0.1';
  process.env.SM_API_DOCS = 'public';
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {}); // the simulated identity provider (/steward/mock/oidc)
  const origin = new URL(s.base).origin;
  proxy = await startReverseProxy({ target: origin, proto: 'https' });
  stripping = await startReverseProxy({ target: origin, proto: 'https', stripPrefix: '/steward' });
  P = `${proxy.url}/steward`;
}, 120_000);

afterAll(async () => {
  await proxy?.close();
  await stripping?.close();
  await s?.app.close();
  for (const k of ENV) delete process.env[k];
  fs.rmSync(web, { recursive: true, force: true });
});

const get = (url: string, headers: Record<string, string> = {}) => fetch(url, { redirect: 'manual', headers });

/** A request with a raw request target (fetch would normalise it) and a Host header of our choice. */
function raw(
  target: string,
  opts: { port?: number; host?: string; method?: string } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: opts.port ?? proxy.port, method: opts.method ?? 'GET', path: target, headers: { host: opts.host ?? '127.0.0.1' } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function signIn(): Promise<{ cookie: string; key: string; setCookie: string }> {
  const res = await fetch(`${P}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sm-client': '1' },
    body: JSON.stringify({ username: 'admin', password: 'Admin-password-1' }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie')!;
  return { cookie: setCookie.split(';')[0]!, key: res.headers.get('x-sm-session-key')!, setCookie };
}

describe('behind a reverse proxy under /steward', () => {
  it('serves health, readiness and the API below the prefix', async () => {
    const health = await get(`${P}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });
    expect(health.headers.get('strict-transport-security')).toContain('max-age=');
    expect((await get(`${P}/api/ready`)).status).toBe(200);
    expect((await get(`${P}/api/auth/status`)).status).toBe(200);
    expect((await get(`${P}/api/runs`)).status).toBe(401);
  });

  it('answers nothing outside the prefix (404), only / redirects to it', async () => {
    const root = await get(`${proxy.url}/`);
    expect(root.status).toBe(302);
    expect(root.headers.get('location')).toBe('/steward/');
    for (const p of [
      '/api/health',
      '/api/v1/openapi.json',
      '/api/mcp',
      '/manifest.webmanifest',
      '/sw.js',
      '/assets/app-abc123.js',
      '/runs',
      '/stewardx',
      '/stewardx/api/health',
      '/Steward/api/health',
      '/steward%2Fapi/health',
      '/steward%2fapi%2fhealth',
      '//steward/api/health',
      '/x/steward/api/health',
      '/%73teward/api/health',
    ]) {
      const r = await raw(p);
      expect(r.status, p).toBe(404);
      expect(r.headers.location, p).toBeUndefined();
    }
    // dot segments and double slashes below the prefix never reach the API either
    for (const p of ['/steward/../api/health', '/steward/./api/health', '/steward//api/health', '/steward/%2e%2e/api/health']) {
      const r = await raw(p);
      expect(r.status !== 200 || !r.headers['content-type']?.includes('json'), `${p}: ${r.status} ${r.body.slice(0, 80)}`).toBe(true);
    }
    // absolute-form request targets are refused
    expect((await raw('http://evil.example/steward/api/health', { port: Number(new URL(s.base).port) })).status).toBe(400);
  });

  it('refuses every registered route without the prefix', async () => {
    const { registeredRoutes } = await import('../src/app.js');
    const problems: string[] = [];
    for (const r of registeredRoutes(s.app)) {
      const url = r.url.replace(/:[A-Za-z]+/g, 'x').replace(/\*/g, 'x');
      const res = await fetch(proxy.url + url, {
        method: r.method,
        redirect: 'manual',
        headers: { 'x-sm-client': '1', ...(r.method === 'GET' ? {} : { 'content-type': 'application/json' }) },
        body: r.method === 'GET' ? undefined : '{}',
      });
      await res.arrayBuffer();
      const expected = r.method === 'GET' && url === '/' ? 302 : 404;
      if (res.status !== expected) problems.push(`${r.method} ${url}: ${res.status}`);
    }
    expect(problems).toEqual([]);
  }, 120_000);

  it('logs a hint about prefix stripping at most once a minute', async () => {
    const { logger } = await import('../src/log.js');
    // a proxy that strips the prefix: requests arrive without it and fail clearly
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 10 * 60_000 });
    const warn = vi.spyOn(logger, 'warn');
    try {
      expect((await get(`${stripping.url}/steward/api/health`)).status).toBe(404);
      expect((await get(`${stripping.url}/steward/api/ready`)).status).toBe(404);
      const hints = warn.mock.calls.filter((c) => String(c[1] ?? '').includes('outside the base path'));
      expect(hints).toHaveLength(1);
      expect(String(hints[0]![1])).toMatch(/prefix stripping/);
      expect(hints[0]![0]).toMatchObject({ path: '/api/health', basePath: '/steward' });
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('session cookie: __Secure- with Path=<base>, Secure, HttpOnly, SameSite=Strict and no Domain', async () => {
    const c = await signIn();
    expect(c.setCookie).toMatch(/^__Secure-sm_session=/);
    expect(c.setCookie).toContain('; Path=/steward;');
    expect(c.setCookie).toContain('; Secure');
    expect(c.setCookie).toContain('; HttpOnly');
    expect(c.setCookie).toContain('SameSite=Strict');
    expect(c.setCookie).not.toMatch(/domain=/i);
    const me = await get(`${P}/api/auth/me`, { cookie: c.cookie, 'x-sm-session': c.key });
    expect(me.status).toBe(200);
    expect((await me.json()).user.username).toBe('admin');
    // the cookie alone is still not enough (session binding), and a write needs the CSRF header
    expect((await get(`${P}/api/runs`, { cookie: c.cookie })).status).toBe(401);
    const noCsrf = await fetch(`${P}/api/me`, {
      method: 'PATCH',
      headers: { cookie: c.cookie, 'x-sm-session': c.key, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(noCsrf.status).toBe(403);
    const out = await fetch(`${P}/api/auth/logout`, { method: 'POST', headers: { cookie: c.cookie, 'x-sm-session': c.key, 'x-sm-client': '1' } });
    expect(out.headers.get('set-cookie')).toMatch(/^__Secure-sm_session=; Path=\/steward; .*Max-Age=0/);
  });

  it('serves the web UI: page with <base href>, assets, deep links, manifest and service worker', async () => {
    for (const p of ['', '/', '/index.html', '/runs/run_123', '/records?subject=a@example.com']) {
      const r = await get(`${P}${p}`);
      expect(r.status, p).toBe(200);
      expect(r.headers.get('content-type'), p).toContain('text/html');
      const html = await r.text();
      expect(html, p).toContain('<base href="/steward/" />');
      expect(html, p).not.toContain('<base href="/" />');
      expect(r.headers.get('content-security-policy'), p).toContain("base-uri 'self'");
    }
    const asset = await get(`${P}/assets/app-abc123.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect((await get(`${P}/assets/missing.js`)).status).toBe(404);
    expect((await get(`${P}/sw.js`)).status).toBe(200);
    const m = await (await get(`${P}/manifest.webmanifest`)).json();
    expect(m).toMatchObject({ start_url: '/steward/', scope: '/steward/', icons: [{ src: '/steward/icon.svg' }], shortcuts: [{ url: '/steward/runs' }] });
  });

  it('public API v1 and OpenAPI: servers and Link headers include the prefix', async () => {
    const c = await signIn();
    const tok = await fetch(`${P}/api/me/tokens`, {
      method: 'POST',
      headers: { cookie: c.cookie, 'x-sm-session': c.key, 'x-sm-client': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'base path', scope: 'read' }),
    });
    const token = (await tok.json()).token as string;
    const auth = { authorization: `Bearer ${token}` };
    const doc = await (await get(`${P}/api/v1/openapi.json`, auth)).json();
    expect(doc.servers).toEqual([{ url: '/steward/api/v1', description: 'This server' }]);
    const page = await get(`${P}/api/v1/audit?limit=1`, auth);
    expect(page.status).toBe(200);
    expect(page.headers.get('link')).toMatch(/^<\/steward\/api\/v1\/audit\?limit=1&cursor=[^>]+>; rel="next"$/);
    // the committed document stays the root variant
    const { buildOpenApiDocument } = await import('../src/api/index.js');
    expect((await buildOpenApiDocument()).servers).toEqual([{ url: '/api/v1', description: 'This server' }]);
  });

  it('MCP endpoint and inbound webhooks answer below the prefix', async () => {
    expect((await s.api('PUT', '/mcp-server', { enabled: true })).path).toBe('/api/mcp');
    const c = await signIn();
    const tok = await fetch(`${P}/api/me/tokens`, {
      method: 'POST',
      headers: { cookie: c.cookie, 'x-sm-session': c.key, 'x-sm-client': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'mcp base path', scope: 'mcp' }),
    });
    const token = (await tok.json()).token as string;
    const init = await fetch(`${P}/api/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      }),
    });
    expect(init.status).toBe(200);
    expect((await init.json()).result.serverInfo.name).toBe('steward');
    // monitor gateway webhook: reached (refused for the wrong secret), not a 404 outside the prefix
    const hook = await fetch(`${P}/api/hooks/monitors`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
      body: '{"reports":[]}',
    });
    expect([401, 403]).toContain(hook.status);
  });

  it('single sign-on: redirect URI, return path and error redirects stay on the public origin and below the prefix', async () => {
    const providerId = (await (await get(`${P}/api/auth/status`)).json()).ssoProviders[0].id as string;
    expect((await s.api('GET', '/sso/redirect-uri')).redirectUri).toBe('https://apps.example.com/steward/api/auth/oidc/callback');
    const start = await get(`${P}/api/auth/oidc/${providerId}/start?returnTo=/tasks`);
    expect(start.status).toBe(302);
    const authorize = new URL(start.headers.get('location')!);
    expect(authorize.pathname).toBe('/steward/mock/oidc/authorize');
    expect(authorize.searchParams.get('redirect_uri')).toBe('https://apps.example.com/steward/api/auth/oidc/callback');
    authorize.pathname = '/steward/mock/oidc/authorize/approve';
    authorize.searchParams.set('login', 'c3d5'); // a demo identity (Oskar)
    const approve = await get(authorize.href);
    const callback = new URL(approve.headers.get('location')!);
    expect(callback.origin + callback.pathname).toBe('https://apps.example.com/steward/api/auth/oidc/callback');
    // the browser reaches the public URL through the proxy
    const res = await get(`${P}/api/auth/oidc/callback${callback.search}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/^__Secure-sm_session=[^;]+; Path=\/steward; HttpOnly; SameSite=Strict; Secure/);
    expect(await res.text()).toContain('location.replace("/steward/tasks")');
    // failures go back to the sign-in page below the prefix (a relative Location, so the public origin)
    const fail = await get(`${P}/api/auth/oidc/does-not-exist/start`);
    expect(fail.status).toBe(302);
    expect(fail.headers.get('location')).toMatch(/^\/steward\/\?sso_error=/);
    // an open redirect via returnTo is still impossible
    const evil = await get(`${P}/api/auth/oidc/${providerId}/start?returnTo=//evil.example/x`);
    expect(evil.status).toBe(302);
  });

  it('links in notifications, e-mails and the daily summary use the public URL with the prefix', async () => {
    const { absoluteLink, publicBaseUrl } = await import('../src/notifications/settings.js');
    expect(publicBaseUrl()).toBe('https://apps.example.com/steward');
    expect(absoluteLink('/runs/run_1')).toBe('https://apps.example.com/steward/runs/run_1');
    expect(absoluteLink(undefined)).toBe('https://apps.example.com/steward/');
    const { config } = await import('../src/config.js');
    expect(config.publicUrl).toBe('https://apps.example.com/steward');
    expect(config.basePath).toBe('/steward');
  });

  it('the self-call guard knows the API below the prefix', async () => {
    const { assertAddressSafe } = await import('../src/platforms/outbound.js');
    const own = new URL(s.base).origin;
    for (const p of ['/steward/api/runs', '/steward/api/v1/runs', '/steward/%61pi/runs', '/api/runs', '/steward//api/runs'])
      await expect(assertAddressSafe(own + p), p).rejects.toMatchObject({ statusCode: 403 });
    await expect(assertAddressSafe(`${own}/steward/api/health`)).resolves.toBeUndefined();
    await expect(assertAddressSafe(`${own}/steward/mock/ih/x`)).resolves.toBeUndefined();
  });

  it('the Swagger UI and its redirects stay below the prefix', async () => {
    const page = await get(`${P}/api/docs`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('/steward/api/docs/static/swagger-ui.css');
    expect((await get(`${P}/api/docs/static/swagger-ui.css`)).status).toBe(200);
    const r = await get(`${P}/api/docs/static/index.html`);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/steward/api/docs/');
  });
});
