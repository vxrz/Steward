import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

// Steward caches a platform's access token until shortly before it expires. Roles granted to the
// technical user in the meantime only appear in a new token: the platform answers 403 and the old
// token stays valid. "Get a new token" drops the cached one and logs in again right away.
let s: TestServer;
let idp: http.Server;
let idpBase = '';
let issued = 0;
/** Tokens issued after the "role change" carry the new role. */
let roleGranted = false;
const withRole = new Set<string>();

beforeAll(async () => {
  idp = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/oauth/token') {
      issued++;
      const token = `token-${issued}`;
      if (roleGranted) withRole.add(token);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: token, expires_in: 1800, token_type: 'Bearer' }));
      return;
    }
    if (req.url === '/api/groups') {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const status = withRole.has(token) ? 200 : 403;
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(status === 200 ? { groups: [] } : { error: 'forbidden' }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => idp.listen(0, '127.0.0.1', resolve));
  idpBase = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
  s = await startTestServer();
  await setup(s);
});
afterAll(async () => {
  await s?.app.close();
  idp?.close();
});

const oauthPlatform = async () => {
  const p = await s.api('POST', '/platforms', {
    name: `Token platform ${Date.now()}`,
    kind: 'generic',
    baseUrl: idpBase,
    config: {
      variables: {},
      http: { proxy: 'none' },
      auth: { type: 'oauth2_client_credentials', tokenUrl: `${idpBase}/oauth/token`, clientAuth: 'body' },
      testPath: '/api/groups',
    },
  });
  await s.api('PUT', `/platforms/${p.id}/secrets`, { clientId: 'svc-steward', clientSecret: 'client-secret-value-1' });
  return p;
};

describe('get a new platform token', () => {
  it('a role granted later only works after a new token – renewing fetches it at once', async () => {
    const p = await oauthPlatform();
    roleGranted = false;
    const before = await s.api('POST', `/platforms/${p.id}/test`);
    expect(before.status).toBe(403);
    expect(before.token).toMatchObject({ fetchedAt: expect.any(String), expiresAt: expect.any(String) });
    const loginsBefore = issued;

    roleGranted = true; // the administrator grants the role on the platform
    const cached = await s.api('POST', `/platforms/${p.id}/test`);
    expect(cached.status).toBe(403); // the cached token does not have it
    expect(issued).toBe(loginsBefore);

    const renewed = await s.api('POST', `/platforms/${p.id}/token/renew`);
    expect(renewed).toMatchObject({ ok: true, token: { fetchedAt: expect.any(String), expiresAt: expect.any(String) } });
    expect(issued).toBe(loginsBefore + 1);
    expect(JSON.stringify(renewed)).not.toContain('token-');

    const after = await s.api('POST', `/platforms/${p.id}/test`);
    expect(after.status).toBe(200);
    expect(issued).toBe(loginsBefore + 1); // the new token is reused

    const entry = (await s.api('GET', `/audit?entityType=platform&entityId=${p.id}`)).find((a: { action: string }) => a.action === 'platform.token_renewed');
    expect(entry.summary).toContain('New access token');
    expect(entry.summary).not.toContain('token-');
  });

  it('reports a failed login without the secret, and refuses platforms without a token login', async () => {
    const p = await oauthPlatform();
    await s.api('PUT', `/platforms/${p.id}`, {
      config: { variables: {}, http: { proxy: 'none' }, auth: { type: 'oauth2_client_credentials', tokenUrl: `${idpBase}/oauth/missing`, clientAuth: 'body' } },
    });
    const failed = await s.api('POST', `/platforms/${p.id}/token/renew`);
    expect(failed.ok).toBe(false);
    expect(failed.message).toContain('Token request POST');
    expect(failed.message).not.toContain('client-secret-value-1');

    const plain = await s.api('POST', '/platforms', {
      name: `No login ${Date.now()}`,
      kind: 'generic',
      baseUrl: idpBase,
      config: { variables: {}, http: { proxy: 'none' }, auth: { type: 'none' } },
    });
    await expect(s.api('POST', `/platforms/${plain.id}/token/renew`)).rejects.toMatchObject({ status: 400 });
  });

  it('needs the manage right on the platform', async () => {
    const p = await oauthPlatform();
    await s.api('POST', '/users', { username: 'oscar', roles: ['operator'], password: 'Oscar-password-123' });
    const operator = await s.as('oscar', 'Oscar-password-123');
    await expect(operator('POST', `/platforms/${p.id}/token/renew`)).rejects.toMatchObject({ status: 403 });
  });
});
