import { request as pwRequest } from '@playwright/test';
import { test, expect, pageSessionHeaders, sessionHeaders } from './support/fixtures';
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

  test('audit anchoring: signed checkpoints and verification against a kept checkpoint', async ({ page }) => {
    await page.goto('/audit');
    await expect(page.getByRole('heading', { name: 'Anchoring outside the database' })).toBeVisible();
    await expect(page.getByText(/Signing key fingerprint:/)).toBeVisible();
    await page.getByRole('button', { name: 'Verify chain', exact: true }).click();
    await expect(page.getByText(/Signed checkpoint written at entry #\d+/)).toBeVisible();
    const kept = await (await page.request.get('/api/audit/anchor.json', { headers: await pageSessionHeaders(page) })).text();
    await page.getByRole('button', { name: 'Verify against checkpoint' }).click();
    await page.getByRole('dialog').getByLabel('Checkpoint (JSON, or seq:hash)').fill(kept);
    await page.getByRole('dialog').getByRole('button', { name: 'Verify chain' }).click();
    await expect(page.getByText(/matches the checkpoint you entered/)).toBeVisible();
  });

  test('audit epochs and archives: state, incremental check and a full verification in the background', async ({ page }) => {
    await page.goto('/audit');
    await expect(page.getByRole('heading', { name: 'Epochs, archives and retention' })).toBeVisible();
    await expect(page.getByText(/^Epochs: \d+ closed, \d+ archived/)).toBeVisible();
    await expect(page.getByLabel('Archive closed epochs')).not.toBeChecked();
    // (the first verification of a log without a checkpoint checks everything; the next one starts at its checkpoint)
    await page.getByRole('button', { name: 'Verify chain', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Audit chain intact' })).toContainText(/Signed checkpoint written at entry #\d+/);
    await page.getByRole('button', { name: 'Verify chain', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Audit chain intact' })).toContainText(/after the signed checkpoint are intact/);
    await page.getByRole('button', { name: 'Full verification' }).click();
    await expect(page.getByText(/^Last full verification:/)).toContainText(/intact/, { timeout: 30_000 });
  });

  test('audit chain verifies', async ({ request }) => {
    const r = await (await request.get('/api/audit/verify', { headers: sessionHeaders('admin') })).json();
    expect(r.ok, r.message).toBe(true);
  });
});
