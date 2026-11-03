import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * "Test connection" (v0.3.1) is not satisfied by a status below 400: a base URL that redirects to a sign-in page,
 * an HTML page where an API is expected, or a Prometheus without {"status":"success"} fail with a hint; the answer's
 * headers say who answered; and a platform with authentication "none" says that the credentials entered are not sent.
 */

let s: TestServer;
let host: http.Server;
let origin: string;
const seen: Record<string, string | undefined>[] = [];

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  host = http.createServer((req, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization, privateToken: req.headers['private-token'] as string | undefined });
    const send = (status: number, type: string, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { ...(type ? { 'content-type': type } : {}), ...headers });
      res.end(body);
    };
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/sso/login') return send(200, 'text/html; charset=utf-8', '<!doctype html><html><body>Sign in</body></html>');
    if (path === '/redirect') return send(302, '', '', { location: '/sso/login?return=%2Fapi' });
    if (path === '/redirect-nowhere') return send(307, 'text/plain', '');
    if (path === '/portal') return send(200, 'text/html', '<html>Portal</html>');
    if (path === '/api/v1/json') return send(200, 'application/json', '{"ok":true}');
    if (path === '/text') return send(200, 'text/plain', 'hello');
    if (path === '/empty401') return send(401, '', '', { 'www-authenticate': 'Basic realm="prom"', server: 'nginx' });
    if (path === '/api/v1/status/buildinfo') return send(200, 'application/json', '{"status":"success","data":{"version":"3"}}');
    if (path === '/notprom/api/v1/status/buildinfo') return send(200, 'application/json', '{"version":"3"}');
    send(404, 'application/json', '{"message":"404 Not Found"}');
  });
  await new Promise<void>((r) => host.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;
});
afterAll(async () => {
  host?.close();
  await s?.app.close();
});

const platform = (
  name: string,
  kind: string,
  testPath: string,
  auth: Record<string, unknown> = { type: 'none' },
  secrets?: Record<string, string>,
  base = origin,
) =>
  s.api('POST', '/platforms', {
    name,
    kind,
    baseUrl: base,
    config: { auth, variables: {}, http: { proxy: 'none', retry: { maxRetries: 0 } }, testPath },
    secrets,
  });
const test = async (p: { id: string }) => s.api('POST', `/platforms/${p.id}/test`);

describe('connection test', () => {
  it('a redirect to a sign-in page fails and names where it went', async () => {
    const r = await test(await platform('Redirect generic', 'generic', '/redirect'));
    expect(r.ok).toBe(false);
    expect(r.message).toBe(
      `GET /redirect answered with an HTML page (redirected to ${origin}/sso/login), not the API – is the base URL the API, and reachable without browser sign-in?`,
    );
    expect(r.url).toBe(`${origin}/sso/login`);
    expect(r.headers['content-type']).toMatch(/text\/html/);
  });

  it('a redirect left over fails', async () => {
    const r = await test(await platform('Redirect GitLab', 'gitlab', '/redirect-nowhere', { type: 'bearer' }, { token: 'glpat-secret-token-1' }));
    expect(r).toMatchObject({ ok: false, status: 307, message: 'GET /redirect-nowhere answered HTTP 307 (a redirect without a target)' });
  });

  it('an HTML page from a kind with a known API fails; from a generic platform it is noted', async () => {
    const r = await test(await platform('HTML GitHub', 'github', '/portal', { type: 'bearer' }, { token: 'ghp-secret-token-1' }));
    expect(r).toMatchObject({ ok: false, status: 200 });
    expect(r.message).toBe(
      'GET /portal answered with an HTML page, not the API – is the base URL the API (https://api.github.com or https://HOST/api/v3), and reachable without browser sign-in?',
    );
    const g = await test(await platform('HTML generic', 'generic', '/portal'));
    expect(g.ok).toBe(true);
    expect(g.message).toContain('it answered with an HTML page');
  });

  it('a kind with a known API needs JSON', async () => {
    const r = await test(await platform('Text k8s', 'kubernetes', '/text', { type: 'bearer' }, { token: 'k8s-secret-token-1' }));
    expect(r.ok).toBe(false);
    expect(r.message).toBe('GET /text answered HTTP 200 with text/plain, not JSON – is the base URL the API (https://HOST:6443)?');
    const ok = await test(await platform('JSON k8s', 'kubernetes', '/api/v1/json', { type: 'bearer' }, { token: 'k8s-secret-token-1' }));
    expect(ok).toMatchObject({ ok: true, message: 'Connection works – GET /api/v1/json' });
  });

  it('Prometheus must answer {"status":"success"}', async () => {
    expect((await test(await platform('Prom ok', 'prometheus', '/api/v1/status/buildinfo'))).ok).toBe(true);
    const bad = await test(await platform('Prom bad', 'prometheus', '/api/v1/status/buildinfo', { type: 'none' }, undefined, `${origin}/notprom`));
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain('without {"status":"success"}');
  });

  it('401 with an empty body: says so, shows who answered, and that credentials of auth "none" are not sent', async () => {
    const p = await platform('Prom trap', 'prometheus', '/empty401', { type: 'none' }, { username: 'grafana', password: 'prom-password-1' });
    const r = await test(p);
    expect(r).toMatchObject({ ok: false, status: 401 });
    expect(r.message).toBe(
      'GET /empty401 answered HTTP 401 with an empty response – Authentication is set to "none" – the username/password you entered are not sent. Choose "basic" under Settings → Authentication.',
    );
    expect(r.headers).toMatchObject({ 'www-authenticate': 'Basic realm="prom"', server: 'nginx' });
    expect(seen.at(-1)?.authorization).toBeUndefined();
    // a token is meant for bearer
    const t = await test(await platform('Token trap', 'generic', '/empty401', { type: 'none' }, { token: 'some-token-1' }));
    expect(t.message).toContain('the token you entered is not sent. Choose "bearer"');
    // without credentials: the platform wants some
    const n = await test(await platform('No creds', 'generic', '/empty401'));
    expect(n.message).toContain('Authentication is set to "none", but the platform wants credentials');
  });

  it('the Prometheus and Gatus presets say which auth type their credential fields are for', async () => {
    const presets = await s.api('GET', '/platform-presets');
    for (const kind of ['prometheus', 'gatus']) {
      const fields = presets.find((p: any) => p.kind === kind).secretFields;
      expect(fields.find((f: any) => f.key === 'username').auth).toBe('basic');
      expect(fields.find((f: any) => f.key === 'token').auth).toBe('bearer');
    }
  });
});
