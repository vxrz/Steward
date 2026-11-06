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
