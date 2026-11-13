import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { chooseOption, json, uniq } from './support/helpers';

/**
 * The monitor editor's check type _Data element_ (ADR 0036 part 10, docs/DATA-PRODUCTS.md#checks-and-health): offered
 * while the data products module is on; an element searched in the catalogue, the modes its kind supports, Check now
 * against the demo Snowflake account, saving – with axe.
 */

test.use({ storageState: authFile('dana') });

async function ordersElement(admin: APIRequestContext): Promise<string> {
  const platforms = await json<{ id: string; kind: string }[]>(await admin.get('/api/platforms'));
  const sf = platforms.find((p) => p.kind === 'snowflake')!.id;
  const found = await json<{ items: { id: string }[] }>(await admin.get(`/api/data-elements?platformId=${sf}&prefix=SHOP.SALES.ORDERS&environment=prod`));
  if (found.items[0]) return found.items[0].id;
  const made = await admin.post('/api/data-elements', {
    data: { platformId: sf, kind: 'snowflake.table', qualifiedName: 'SHOP.SALES.ORDERS', environment: 'prod' },
  });
  return (await json<{ id: string }>(made)).id;
}

test('a data element check: search the element, try it, save it', async ({ page, apiAs }) => {
  const admin = await apiAs('admin');
  // switched on and left on: the other data specs run beside this one and need it (switching it off again made their
  // requests answer 404 in the middle of a test)
  expect((await admin.put('/api/settings/modules/dataProducts', { data: { enabled: true } })).ok()).toBe(true);
  let monitorId: string | null = null;
  try {
    const element = await ordersElement(admin);
    await page.goto('/monitors/new');
    await settle(page);
    const palette = page.getByLabel('Check palette');
    const form = page.getByTestId('check-form');
    await palette.getByRole('button', { name: 'Data element', exact: true }).click();
    await expect(form.getByRole('combobox', { name: /^Data element/ })).toHaveAttribute('required', '');
    // the element: searched by name in the catalogue
    await form.getByRole('combobox', { name: /^Data element/ }).fill('SALES.ORDERS');
    await page.getByRole('option', { name: /SHOP\.SALES\.ORDERS \(prod\)/ }).click();
    await form.getByRole('textbox', { name: 'Maximum age (minutes)' }).fill('60');
    await form.getByRole('button', { name: 'Check now' }).click();
    await expect(form.getByTestId('check-preview')).toContainText('SHOP.SALES.ORDERS changed');
    await expectAccessible(page, 'monitor editor: data element check');
    // a table supports the schema mode too: it is compared with the contract of its output port
    await chooseOption(page, 'What is checked', 'Schema against the contract');
    await expect(form.getByText(/INFORMATION_SCHEMA\.COLUMNS/)).toBeVisible();
    await expect(form.getByRole('textbox', { name: 'Maximum age (minutes)' })).toHaveCount(0);
    await chooseOption(page, 'What is checked', 'Freshness');
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.getByLabel(/^Name/).fill(uniq('E2E data element'));
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page).toHaveURL(/\/monitors\/mon_/);
    monitorId = new URL(page.url()).pathname.split('/').find((p) => p.startsWith('mon_')) ?? null;
    const saved = await json<{ definition: { checks: { type: string; element: string; maxAgeMinutes: number }[] } }>(
      await admin.get(`/api/monitors/${monitorId}`),
    );
    expect(saved.definition.checks[0]).toMatchObject({ type: 'data-element', element, maxAgeMinutes: 60 });
  } finally {
    if (monitorId) await admin.delete(`/api/monitors/${monitorId}`);
  }
});
