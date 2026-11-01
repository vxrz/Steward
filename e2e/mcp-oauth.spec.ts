import crypto from 'node:crypto';
import { test, expect } from './support/fixtures';
import { authFile, baseURL } from './support/env';
import { expectAccessible } from './support/axe';

test.use({ storageState: authFile('dana') });

/**
 * OAuth sign-in for MCP clients (#12): a client registers itself, the person sees who asks and where the browser
 * returns, allows it, and finds the client under Connected MCP clients in the profile, where they revoke it.
 */
test('a person allows an MCP client on the consent page and revokes it in the profile', async ({ page, apiAs }) => {
  const admin = await apiAs('admin');
  await admin.put('/api/mcp-server', { data: { enabled: true } });
  await admin.put('/api/settings/mcp-oauth', { data: { enabled: true } });
  try {
    const redirect = 'http://127.0.0.1:33419/callback';
    const reg = await (
      await fetch(`${baseURL()}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'E2E assistant', redirect_uris: [redirect] }),
      })
    ).json();
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: reg.client_id,
      redirect_uri: redirect,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'mcp',
      state: 'e2e-state',
    });
    // the browser would go to the client's loopback listener: catch it instead
    let returned = '';
    await page.route('http://127.0.0.1:33419/**', async (route) => {
      returned = route.request().url();
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Signed in</p>' });
    });
    await page.goto(`/oauth/authorize?${q}`);
    await expect(page.getByRole('heading', { name: 'Allow an AI assistant' })).toBeVisible();
    await expect(page.getByText('E2E assistant')).toBeVisible();
    await expect(page.getByText('127.0.0.1:33419')).toBeVisible();
    await expect(page.getByText(/registered itself/)).toBeVisible();
    await expectAccessible(page, 'OAuth consent');
    await page.getByRole('button', { name: 'Allow' }).click();
    await expect.poll(() => returned).toContain('code=');
    const back = new URL(returned);
    expect(back.searchParams.get('state')).toBe('e2e-state');

    const token = await (
      await fetch(`${baseURL()}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: back.searchParams.get('code')!,
          redirect_uri: redirect,
          client_id: reg.client_id,
          code_verifier: verifier,
        }),
      })
    ).json();
    expect(token.access_token).toMatch(/^smo_/);

    await page.goto('/profile');
    const card = page.getByTestId('mcp-connected-clients');
    await expect(card.getByText('E2E assistant')).toBeVisible();
    await page.getByRole('button', { name: 'Revoke access of E2E assistant' }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /Revoke/ })
      .click();
    await expect(page.getByText('Access revoked')).toBeVisible();
    await expect(page.getByText(/No assistant is connected/)).toBeVisible();
  } finally {
    // OAuth off again; the MCP server stays on (e2e/mcp.spec.ts turns it on too and may run at the same time)
    await admin.put('/api/settings/mcp-oauth', { data: { enabled: false } });
  }
});
