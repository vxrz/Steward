import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

// "Test connection" says which request it made, and a failed login says where it went – a 401 from a
// portal at the base URL (no test path set) looked like a login problem before.
let s: TestServer;
beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
});
afterAll(async () => s?.app.close());

const platform = (name: string, config: Record<string, unknown>) =>
  s.api('POST', '/platforms', {
    name,
    kind: 'generic',
    baseUrl: s.base,
    config: { variables: {}, http: { proxy: 'none' }, ...config },
  });

describe('connection test messages', () => {
  it('name the request, and say when there is no test path', async () => {
    const none = await platform('No test path', { auth: { type: 'none' } });
    const r1 = await s.api('POST', `/platforms/${none.id}/test`);
    expect(r1.message).toContain('GET / (no test path set: the base URL itself)');

    const api = await platform('Test path', { auth: { type: 'none' }, testPath: '/api/v1/me' });
    const r2 = await s.api('POST', `/platforms/${api.id}/test`);
    expect(r2).toMatchObject({ ok: false, status: 401, message: 'GET /api/v1/me answered HTTP 401' });
  });

  it('a failed login request names its method and address, never its query', async () => {
    const p = await platform('Custom login', {
      auth: {
        type: 'token_request',
        request: { method: 'POST', url: '/api/auth/login?client_secret=hidden', body: { username: 'nobody', password: 'wrong-password-1' }, bodyType: 'json' },
        tokenPath: 'access_token',
      },
      testPath: '/api/v1/me',
    });
    const r = await s.api('POST', `/platforms/${p.id}/test`);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(new RegExp(`^Login request POST ${s.base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/api/auth/login failed with HTTP 4\\d\\d`));
    expect(r.message).not.toContain('hidden');
  });
});
