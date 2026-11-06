import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible } from './support/axe';
import { expectNoHorizontalScroll, json, platformId } from './support/helpers';

test.use({ storageState: authFile('admin') });

/** Credential values of the simulated platforms (server/src/mock/mockPlatform.ts). They must never reach the browser. */
const SECRETS = ['demo-secret', 'demo-password'];

/**
 * Platform identities, step 1 (0.9.0, ADR 0009): the Identities tab shows the platform's one default identity,
 * read-only – names and flags, never a credential value.
 */
async function openIdentities(page: import('@playwright/test').Page, id: string) {
  await page.goto(`/platforms/${id}`);
  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible();
  await page.getByRole('tab', { name: 'Identities' }).click();
  const card = page.getByTestId('identity-card');
  await expect(card).toHaveCount(1);
  return card;
}

test('the Identities tab shows the default identity read-only', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const id = await platformId(api, 'insights-hub');
  const platform = await json(await api.get(`/api/platforms/${id}`));
  expect(platform.identities).toHaveLength(1);

  const card = await openIdentities(page, id);
  await expect(card.getByRole('heading', { name: 'Default', level: 5 })).toBeVisible();
  await expect(card.getByText('Default', { exact: true }).last()).toBeVisible();
  await expect(card).toContainText('The platform’s sign-in settings (OAuth2 client credentials)');
  for (const key of platform.secretKeys as string[]) await expect(card).toContainText(key);
  await expect(card).toContainText('All operations');
  await expect(card).toContainText('Everyone with the “use” right on this platform');
  await expect(card).toContainText('You may use it');
  // read-only: no inputs, no buttons besides the links to the tabs that change it
  await expect(card.getByRole('textbox')).toHaveCount(0);
  await expectAccessible(page, 'platform identities');
  const html = await page.content();
  for (const s of SECRETS) expect(html).not.toContain(s);

  // the links open the tabs where the default identity's credentials and MCP mode are changed
  await card.getByRole('button', { name: 'Change on the Credentials tab' }).click();
  await expect(page.getByRole('tab', { name: 'Credentials' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Identities' }).click();
  await page.getByTestId('identity-card').getByRole('button', { name: 'Change on the MCP tab' }).click();
  await expect(page.getByRole('tab', { name: 'MCP' })).toHaveAttribute('aria-selected', 'true');
});

test('an operator with the use right may use the default identity', async ({ loginAs, apiAs }) => {
  const api = await apiAs('admin');
  const id = await platformId(api, 'industrial-edge-management');
  const page = await loginAs('olivia');
  const card = await openIdentities(page, id);
  await expect(card).toContainText('You may use it');
  await expect(card).toContainText('The platform’s sign-in settings (Custom login)');
  await expectAccessible(page, 'platform identities (operator)');
});

test('the Identities tab on a phone @mobile', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const id = await platformId(api, 'insights-hub');
  const card = await openIdentities(page, id);
  await expect(card).toContainText('You may use it');
  await expectNoHorizontalScroll(page);
  await expectAccessible(page, 'platform identities (phone)');
});

/**
 * Settings changed outside Steward (0.9.0): the confirmation dialog shows what the platform page does not – each
 * identity's MCP mode and credential names, the settings that confirming resets and the identities it removes. The
 * changed state cannot be made from a browser: the platform and the review are answered by the test.
 */
async function withChangedSettings(page: import('@playwright/test').Page, api: import('@playwright/test').APIRequestContext, id: string) {
  const platform = await json(await api.get(`/api/platforms/${id}`));
  const review = {
    baseUrl: platform.baseUrl,
    integrity: 'mismatch',
    identities: [
      {
        id: platform.identities[0].id,
        name: 'Default',
        default: true,
        integrity: 'mismatch',
        mcp: { mode: 'read' },
        secretKeys: platform.secretKeys,
        variables: { port: '8443', region: 'eu-west' },
        signIn: { type: 'token_request', url: 'https://login.example.net/token' },
        flags: ['privileged'],
        action: 'reset',
      },
      {
        id: 'pi_planted',
        name: 'Planted',
        default: false,
        integrity: 'unsealed',
        mcp: { mode: 'off' },
        secretKeys: [],
        variables: {},
        signIn: null,
        flags: [],
        action: 'remove',
      },
    ],
  };
  const confirmed: string[] = [];
  await page.route(`**/api/platforms/${id}`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ json: { ...platform, integrity: 'mismatch' } });
  });
  await page.route(`**/api/platforms/${id}/confirm-config`, async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: review });
    confirmed.push(route.request().method());
    return route.fulfill({ json: platform });
  });
  return confirmed;
}

test('confirming changed settings lists what is reset and removed', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const id = await platformId(api, 'insights-hub');
  const confirmed = await withChangedSettings(page, api, id);
  await page.goto(`/platforms/${id}`);
  await expect(page.getByText('Connection settings changed outside Steward')).toBeVisible();
  await page.getByRole('button', { name: 'I reviewed the settings – confirm' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Identity “Default”');
  await expect(dialog).toContainText('MCP clients: Read only');
  await expect(dialog).toContainText('they go back to the platform’s when you confirm');
  await expect(dialog).toContainText('Variables: port = 8443, region = eu-west');
  await expect(dialog).toContainText('Its own sign-in: token_request at https://login.example.net/token');
  await expect(dialog).toContainText('Flags: privileged');
  await expect(dialog.getByTestId('confirm-identity-remove')).toContainText('this identity is removed when you confirm');
  await expectAccessible(page, 'confirm changed platform settings');
  await dialog.getByTestId('confirm-dialog-confirm').click();
  await expect(page.getByText('Settings confirmed')).toBeVisible();
  expect(confirmed).toEqual(['POST']);
});

test('the confirmation of changed settings on a phone @mobile', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const id = await platformId(api, 'insights-hub');
  await withChangedSettings(page, api, id);
  await page.goto(`/platforms/${id}`);
  await page.getByRole('button', { name: 'I reviewed the settings – confirm' }).click();
  await expect(page.getByRole('dialog')).toContainText('Variables: port = 8443, region = eu-west');
  await expectNoHorizontalScroll(page);
  await expectAccessible(page, 'confirm changed platform settings (phone)');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
});
