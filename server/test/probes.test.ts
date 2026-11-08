import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * GET /api/ready/traffic (routing: Kubernetes readinessProbe, load balancers) against GET /api/ready (alerting):
 * a new installation or a locked vault must stay reachable, or nobody can set it up or unlock it.
 */
let s: TestServer;
const get = (path: string, headers: Record<string, string> = {}) => fetch(`${s.base}${path}`, { headers });

beforeAll(async () => {
  s = await startTestServer();
});
afterAll(async () => {
  await s?.app.close();
});

describe('routing probe', () => {
  it('answers 200 before the first set-up, while /api/ready answers 503', async () => {
    const ready = await get('/api/ready');
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ ready: false, checks: { vault: { ok: false, message: 'Not set up yet' } } });
    const traffic = await get('/api/ready/traffic');
    expect(traffic.status).toBe(200);
    expect(await traffic.json()).toEqual({ ready: true });
    expect(traffic.headers.get('cache-control')).toBe('no-store');
  });

  it('answers 200 with a locked vault, while /api/ready answers 503', async () => {
    await setup(s);
    expect((await get('/api/ready')).status).toBe(200);
    const { vault } = await import('../src/vault.js');
    vault().lock();
    const ready = await get('/api/ready');
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ ready: false, checks: { vault: { ok: false, message: 'Vault is locked' } } });
    expect((await get('/api/ready/traffic')).status).toBe(200);
  });

  it('needs no sign-in, but an allowed host name, like the other probes', async () => {
    expect((await get('/api/ready/traffic', { cookie: 'sm_session=nonsense' })).status).toBe(200);
    for (const path of ['/api/health', '/api/ready/traffic']) {
      const res = await s.app.inject({ method: 'GET', url: path, headers: { host: 'evil.example.com' } });
      expect(res.statusCode).toBe(403);
    }
  });
});
