import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile, baseURL } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { chooseOption, expectNoHorizontalScroll, json, uniq } from './support/helpers';

test.use({ storageState: authFile('admin') });

/**
 * changedetection.io (#242, docs/CHANGEDETECTION.md): the preset in the setup wizard (a wrong API key, fixed), the
 * watches as components of the platform (read, filtered, linked, their snapshot times), a watch among the backlinks of
 * its application, and the monitor check "Page watch" in the editor with Check now – on a desktop and a phone.
 */

const KEY = 'demo-changedetection-api-key';
const TERMS = '7d3c1a90-5b2e-4f61-8c47-1a2b3c4d5e01';
const PRICING = '7d3c1a90-5b2e-4f61-8c47-1a2b3c4d5e02';

async function demoPlatform(api: APIRequestContext): Promise<string> {
  const list = await json<{ id: string; kind: string; name: string }[]>(await api.get('/api/platforms'));
  return list.find((p) => p.kind === 'changedetection' && p.name.endsWith('(demo)'))!.id;
}

async function addWithWizard(page: Page, api: APIRequestContext, mobile: boolean) {
  const name = uniq('changedetection.io');
  await page.goto('/platforms');
  await page.getByRole('button', { name: 'Add platform' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a platform' });
  await expect(dialog.getByRole('region', { name: 'Monitoring' })).toContainText('changedetection.io (page watches, read-only)');
  await dialog.getByRole('textbox', { name: 'Search connectors' }).fill('changedetection');
  const connector = dialog.getByTestId('wizard-connector').filter({ hasText: 'changedetection.io (page watches, read-only)' });
  await expect(connector).toHaveCount(1);
  await connector.click();
  await dialog.getByRole('textbox', { name: 'Name' }).first().fill(name);
  await dialog.getByRole('textbox', { name: 'Base URL' }).fill(`${baseURL()}/mock/changedetection`);
  await dialog.getByLabel('API key', { exact: true }).fill('wrong-key');
  await dialog.getByTestId('wizard-create').click();
  const result = dialog.getByTestId('wizard-test-result');
  await expect(result).toContainText('Connection failed');
  await expect(result).toContainText('403');
  await expectAccessible(page, 'changedetection wizard: wrong key');
  if (mobile) await expectNoHorizontalScroll(page);
  await dialog.getByRole('button', { name: 'Change the settings' }).click();
  await dialog.getByLabel('API key', { exact: true }).fill(KEY);
  await dialog.getByTestId('wizard-create').click();
  await expect(result).toContainText('Connection works');
  await dialog.getByTestId('wizard-continue').click();
  const next = dialog.getByTestId('platform-get-started');
  await expect(next).toContainText('changedetection.io – Review a changed page');
  await expectAccessible(page, 'changedetection wizard: what next');
  await page.keyboard.press('Escape');

  const p = (await json<{ id: string; name: string; config: { auth: Record<string, string> } }[]>(await api.get('/api/platforms'))).find(
    (x) => x.name === name,
  )!;
  expect(p.config.auth).toMatchObject({ type: 'apiKey', apiKeyIn: 'header', apiKeyName: 'x-api-key' });
  // the platform opens on its watches: not read yet, then read once
  await page.goto(`/platforms/${p.id}`);
  const tab = page.getByTestId('watches-tab');
  await expect(tab.getByText('Watches not read yet')).toBeVisible();
  await expectAccessible(page, 'watches: not read');
  await tab.getByRole('button', { name: 'Read now' }).first().click();
  await expect(tab.getByText('Zentrova Cloud – Terms of service')).toBeVisible();
  await expect(tab).toContainText('6 watches');
  if (mobile) await expectNoHorizontalScroll(page);
  await api.delete(`/api/platforms/${p.id}`);
}

async function watchesOfTheDemo(page: Page, api: APIRequestContext, mobile: boolean) {
  const id = await demoPlatform(api);
  // the demo linked the vendor text to a supplier to confirm (0.17, docs/SUPPLIERS.md): this part is about the text
  await json(await api.put(`/api/changedetection/${id}/watches/${PRICING}/link`, { data: { supplierId: null } }));
  await page.goto(`/platforms/${id}`);
  await settle(page);
  const tab = page.getByTestId('watches-tab');
  await expect(tab.getByText('Paylumen – Status page')).toBeVisible();
  await expect(tab.getByText('1 failing')).toBeVisible();
  await expect(tab.getByText('Received HTTP 503', { exact: false }).first()).toBeVisible();
  await expectAccessible(page, 'watches of the demo');
  if (mobile) await expectNoHorizontalScroll(page);

  // filters (folded behind a button on a phone)
  if (mobile) await tab.getByRole('button', { name: 'Filters' }).click();
  await chooseOption(page, 'State', 'Failing');
  await expect(tab.getByText('Paylumen – Status page')).toBeVisible();
  await expect(tab.getByText('Zentrova Cloud – Pricing')).toHaveCount(0);
  await page.getByRole('combobox', { name: 'State' }).click();
  await page.keyboard.press('Escape');
  await tab.getByRole('searchbox', { name: /^Search/ }).fill('zentrova');
  await chooseOption(page, 'State', 'OK');
  await expect(tab.getByText('Zentrova Cloud – Pricing')).toBeVisible();

  // snapshot times, never the snapshots
  await tab.getByRole('button', { name: 'History of Zentrova Cloud – Terms of service' }).click();
  const history = page.getByRole('dialog', { name: /History of/ });
  await expect(history).toContainText('3 snapshots, 2 changes');
  expect(await history.getByRole('link', { name: 'Diff' }).getAttribute('href')).toContain(`/mock/changedetection/diff/${TERMS}`);
  await expectAccessible(page, 'watch history');
  await page.keyboard.press('Escape');

  // link a watch to an application and a vendor (and back)
  await tab.getByRole('button', { name: 'Link Zentrova Cloud – Pricing' }).click();
  const link = page.getByRole('dialog', { name: /^Link/ });
  await chooseOption(page, 'Application', 'CRM (demo)');
  await link.getByRole('combobox', { name: 'Vendor' }).fill('Zentrova Cloud AG');
  await expectAccessible(page, 'link a watch');
  await link.getByRole('button', { name: 'Save' }).click();
  await expect(link).toHaveCount(0);
  await expect(tab.getByText('Vendor: Zentrova Cloud AG')).toBeVisible();
  const shop = (await json<{ id: string; name: string }[]>(await api.get('/api/applications'))).find((a) => a.name === 'Webshop (demo)')!;
  await json(await api.put(`/api/changedetection/${id}/watches/${PRICING}/link`, { data: { applicationId: shop.id, vendor: 'Zentrova Cloud' } }));

  // the application lists its watches among the backlinks; one opens the platform's watch
  await page.goto(`/applications/${shop.id}`);
  // on a phone the links (with the backlinks) start folded, their count in the header
  if (mobile) await page.getByTestId('section-links-toggle').tap();
  const backlink = page.getByRole('link', { name: 'Zentrova Cloud – Terms of service' });
  await backlink.scrollIntoViewIfNeeded();
  await expect(page.getByText('Page watch:').first()).toBeVisible();
  await backlink.click();
  await expect(page).toHaveURL((u) => u.pathname.endsWith(`/platforms/${id}`) && u.search === `?tab=watches&watch=${TERMS}`);
  await expect(page.getByTestId('watches-tab').getByText('Zentrova Cloud – Terms of service')).toBeVisible();
  await expect(page.getByTestId('watches-tab').getByText('Paylumen – Status page')).toHaveCount(0);
}

async function checkInTheEditor(page: Page, mobile: boolean) {
  await page.goto('/monitors/new');
  await settle(page);
  const form = page.getByTestId('check-form');
  await page.getByLabel('Check palette').getByRole('button', { name: 'Page watch (changedetection.io)', exact: true }).click();
  await chooseOption(page, /^Platform/, /^changedetection\.io \(demo\)/);
  await form.getByText('With a tag', { exact: true }).click();
  await form.getByRole('combobox', { name: /^Tag/ }).fill('vendor-terms');
  await chooseOption(page, 'A change counts as', 'Degraded');
  await form.getByRole('button', { name: 'Check now' }).click();
  await expect(form.getByTestId('check-preview')).toContainText('changedetection.io: tag "vendor-terms" – 1 changed in the last 24 h');
  await expectAccessible(page, 'page watch check: tag');
  if (mobile) await expectNoHorizontalScroll(page);
  await form.getByText('One watch', { exact: true }).click();
  await chooseOption(page, /^Watch/, 'Paylumen – Status page');
  await chooseOption(page, 'A failing watch counts as', 'Down');
  await form.getByRole('textbox', { name: /^Not checked for/ }).fill('48');
  await form.getByRole('button', { name: 'Check now' }).click();
  await expect(form.getByTestId('check-preview')).toContainText('1 failing: Paylumen – Status page');
  await expectAccessible(page, 'page watch check: one watch');
  if (mobile) await expectNoHorizontalScroll(page);
  await page.getByRole('tab', { name: 'YAML' }).click();
  const yaml = page.getByRole('textbox', { name: 'YAML source' });
  await expect(yaml).toHaveValue(/type: page-watch[\s\S]*failingAs: down/);
  await expect(yaml).toHaveValue(/watch: 7d3c1a90-5b2e-4f61-8c47-1a2b3c4d5e04[\s\S]*maxCheckAgeHours: 48/);
}

test('the changedetection.io preset in the wizard', async ({ page, apiAs }) => {
  await addWithWizard(page, await apiAs('admin'), false);
});

test('the watches of a changedetection.io platform: filter, history, links and backlinks', async ({ page, apiAs }) => {
  await watchesOfTheDemo(page, await apiAs('admin'), false);
});

test('the Page watch check in the editor, tried with Check now', async ({ page }) => {
  await checkInTheEditor(page, false);
});

test('changedetection.io on a phone @mobile', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  await addWithWizard(page, api, true);
  await watchesOfTheDemo(page, api, true);
  await checkInTheEditor(page, true);
});
