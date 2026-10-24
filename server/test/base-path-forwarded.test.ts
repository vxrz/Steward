import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startReverseProxy, type ReverseProxy } from '../../scripts/reverse-proxy.mjs';
import { setup, startTestServer, type TestServer } from './helpers.js';

// SM_BASE_PATH without SM_PUBLIC_URL behind a TLS-terminating proxy: addresses Steward builds from the request
// come from X-Forwarded-Proto/-Host of the trusted proxy (SM_TRUST_PROXY) plus the base path.
let s: TestServer;
let proxy: ReverseProxy;
const ENV = ['SM_BASE_PATH', 'SM_TRUST_PROXY'];

beforeAll(async () => {
  process.env.SM_BASE_PATH = 'steward/';
  process.env.SM_TRUST_PROXY = '127.0.0.1';
  s = await startTestServer();
  await setup(s);
  proxy = await startReverseProxy({ target: new URL(s.base).origin, proto: 'https' });
}, 120_000);

afterAll(async () => {
  await proxy?.close();
  await s?.app.close();
  for (const k of ENV) delete process.env[k];
});

/** A request to the proxy as the browser sends it to https://apps.example.com (Host header of the public name). */
function viaProxy(
  target: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: proxy.port, method: opts.method ?? 'GET', path: target, headers: { host: 'apps.example.com', ...opts.headers } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

describe('base path from SM_BASE_PATH, addresses from the trusted proxy', () => {
  it('normalises SM_BASE_PATH', async () => {
    const { config } = await import('../src/config.js');
    expect(config.basePath).toBe('/steward');
    expect(config.publicUrl).toBeUndefined();
    expect(s.base).toMatch(/\/steward$/);
  });

  it('builds the SSO redirect URI from X-Forwarded-Proto/-Host and the base path', async () => {
    const login = await viaProxy('/steward/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sm-client': '1' },
      body: JSON.stringify({ username: 'admin', password: 'Admin-password-1' }),
    });
    expect(login.status).toBe(200);
    const setCookie = String(login.headers['set-cookie']);
    // without SM_PUBLIC_URL=https://… Steward does not know it is reached over TLS: no Secure (docs/INSTALL.md)
    expect(setCookie).toMatch(/^sm_session=[^;]+; Path=\/steward; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
    const r = await viaProxy('/steward/api/sso/redirect-uri', {
      headers: { cookie: setCookie.split(';')[0]!, 'x-sm-session': String(login.headers['x-sm-session-key']) },
    });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).redirectUri).toBe('https://apps.example.com/steward/api/auth/oidc/callback');
  });

  it('keeps redirects relative (the public origin) and below the prefix', async () => {
    const fail = await viaProxy('/steward/api/auth/oidc/nope/start');
    expect(fail.status).toBe(302);
    expect(fail.headers.location).toMatch(/^\/steward\/\?sso_error=/);
    const root = await viaProxy('/');
    expect(root.status).toBe(302);
    expect(root.headers.location).toBe('/steward/');
    expect((await viaProxy('/api/health')).status).toBe(404);
    expect((await viaProxy('/steward/api/health')).status).toBe(200);
  });

  it('falls back to this server below the base path for links without a public URL', async () => {
    const { publicBaseUrl } = await import('../src/notifications/settings.js');
    expect(publicBaseUrl()).toMatch(/^http:\/\/localhost:\d+\/steward$/);
    // the notification settings' own base URL wins (entered with its path)
    const current = await s.api('GET', '/settings/notifications');
    await s.api('PUT', '/settings/notifications', { ...current, baseUrl: 'https://apps.example.com/steward/' });
    expect(publicBaseUrl()).toBe('https://apps.example.com/steward');
  });
});
