import { request as pwRequest } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile, baseURL } from './support/env';

/** Cheap HTTP-level checks of the browser-facing security settings. */
test.describe('security headers and guards', () => {
  test.use({ storageState: authFile('admin') });

  test('pages are served with CSP and anti-framing headers', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status()).toBe(200);
    const h = res.headers();
    expect(h['content-security-policy']).toContain("default-src 'self'");
    expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(h['content-security-policy']).toContain("script-src 'self'");
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['referrer-policy']).toBe('no-referrer');
  });

  test('state-changing requests need the CSRF header', async ({ request }) => {
    const without = await request.post('/api/notifications/read-all', { data: {} });
    expect(without.status()).toBe(403);
    expect(await without.text()).toContain('x-sm-client');
  });

  test('foreign Host headers are rejected (DNS rebinding)', async () => {
    const ctx = await pwRequest.newContext({ baseURL: baseURL(), storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { host: 'evil.example.com' } });
    try {
      expect((await ctx.get('/api/health')).status()).toBe(403);
    } finally {
      await ctx.dispose();
    }
  });

  test('API requires sign-in', async () => {
    const anon = await pwRequest.newContext({ baseURL: baseURL(), storageState: { cookies: [], origins: [] } });
    try {
      expect((await anon.get('/api/runs')).status()).toBe(401);
      expect((await anon.get('/api/health')).status()).toBe(200);
    } finally {
      await anon.dispose();
    }
  });

  test('audit chain verifies', async ({ request }) => {
    const r = await (await request.get('/api/audit/verify')).json();
    expect(r.ok, r.message).toBe(true);
  });
});
