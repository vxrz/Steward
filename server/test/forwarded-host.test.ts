import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// behind a reverse proxy on this machine, without SM_PUBLIC_URL: the forwarded headers of the test client are believed
process.env.SM_TRUST_PROXY = 'loopback';
delete process.env.SM_PUBLIC_URL;
process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const { setup, startTestServer } = await import('./helpers.js');
type TestServer = Awaited<ReturnType<typeof startTestServer>>;

/**
 * Security review 0.10.0 S5: the Host allow-list checked the Host header only, while the OAuth issuer and the single
 * sign-on redirect address are built from X-Forwarded-Host (believed from a trusted proxy). A proxy that passes a
 * client's X-Forwarded-Host through made it the issuer of cacheable discovery documents.
 */
let s: TestServer;
beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('PUT', '/mcp-server', { enabled: true });
  await s.api('PUT', '/settings/mcp-oauth', { enabled: true });
});
afterAll(async () => {
  await s?.app.close();
});

const get = (path: string, headers: Record<string, string> = {}) => fetch(`${s.base}${path}`, { headers, redirect: 'manual' });

describe('X-Forwarded-Host behind a trusted proxy', () => {
  it('is checked against the host allow-list like the Host header', async () => {
    const evil = { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' };
    for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/api/mcp', '/api/auth/status', '/']) {
      const r = await get(path, evil);
      expect(r.status, path).toBe(403);
      expect(await r.text(), path).not.toContain('evil.example');
    }
    // a port and a second (proxy-appended) value are judged by what Steward would use: the last one
    expect((await get('/api/auth/status', { 'x-forwarded-host': 'localhost:8443' })).status).toBe(200);
    expect((await get('/api/auth/status', { 'x-forwarded-host': 'localhost, evil.example' })).status).toBe(403);
    // the single sign-on start would send the browser to the identity provider with a redirect address built from it
    expect((await get('/api/auth/oidc/x/start', evil)).status).toBe(403);
  });

  it('an allowed forwarded host still works, and its discovery documents are not cached', async () => {
    const r = await get('/.well-known/oauth-authorization-server', { 'x-forwarded-host': 'localhost', 'x-forwarded-proto': 'https' });
    expect(r.status).toBe(200);
    expect((await r.json()).issuer).toBe('https://localhost');
    // built from the request: a shared cache in front must not keep it (with SM_PUBLIC_URL it may, for 5 minutes)
    expect(r.headers.get('cache-control')).toBe('no-store');
    const pr = await get('/.well-known/oauth-protected-resource/api/mcp');
    expect(pr.headers.get('cache-control')).toBe('no-store');
  });

  it('start-up warns when SM_TRUST_PROXY is set without SM_PUBLIC_URL', async () => {
    const { securityWarnings, parseEnv } = await import('../src/config.js');
    const c = { host: '127.0.0.1', demo: false, secureCookies: true };
    expect(securityWarnings(parseEnv({}), { ...c, trustProxy: ['loopback'] }, false).join()).toMatch(/SM_TRUST_PROXY is set without SM_PUBLIC_URL/);
    expect(securityWarnings(parseEnv({}), { ...c, trustProxy: ['loopback'], publicUrl: 'https://steward.example' }, false)).toEqual([]);
    expect(securityWarnings(parseEnv({}), c, false)).toEqual([]);
  });
});
