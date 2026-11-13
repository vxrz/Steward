import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible } from './support/axe';
import { chooseOption, expectNoHorizontalScroll, json, uniq } from './support/helpers';

test.use({ storageState: authFile('admin') });

/**
 * Suppliers (0.17.0, ADR 0029, docs/SUPPLIERS.md): the list "To confirm" that the free-text vendors of the demo became
 * – confirm one, merge another into a supplier –, a new supplier with a contract, and a cost plan line that names the
 * supplier and the contract it pays for; the list and a supplier on a phone. With axe.
 */

type Supplier = { id: string; name: string; status: string };

test('suppliers: confirm and merge suppliers made from free-text vendors', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const pending = await json<Supplier[]>(await api.get('/api/suppliers?status=unconfirmed'));
  // the demo's page watches and cost plan lines named vendors as text: they wait under "To confirm"
  expect(pending.length).toBeGreaterThanOrEqual(2);
  const [toConfirm, toMerge] = [pending[0]!, pending[1]!];
  const target = (await json<Supplier[]>(await api.get('/api/suppliers?status=active'))).find((s) => s.name === 'Paylumen');
  expect(target, 'the demo supplier Paylumen').toBeTruthy();

  await page.goto('/suppliers');
  await expect(page.getByRole('heading', { name: 'Suppliers', level: 1 })).toBeVisible();
  await page.getByTestId('tab-to-confirm').click();
  await expect(page).toHaveURL(/\/suppliers\?status=unconfirmed$/);
  const list = page.getByTestId('supplier-list');
  await expect(list).toContainText(toConfirm.name);
  await expectAccessible(page, 'suppliers: to confirm');

  // confirm one: it leaves the list
  await page.getByTestId(`confirm-${toConfirm.id}`).click();
  await expect(page.getByText('Supplier confirmed')).toBeVisible();
  await expect(page.getByTestId(`confirm-${toConfirm.id}`)).toHaveCount(0);
  expect((await json<Supplier>(await api.get(`/api/suppliers/${toConfirm.id}`))).status).toBe('active');

  // merge another into Paylumen: its links and spellings move
  await page.getByTestId(`merge-${toMerge.id}`).click();
  const dialog = page.getByRole('dialog', { name: `Merge “${toMerge.name}” into another supplier` });
  await chooseOption(page, 'Merge into', 'Paylumen');
  await expectAccessible(page, 'suppliers: merge dialog');
  await dialog.getByRole('button', { name: 'Merge' }).click();
  await expect(page.getByText('Supplier merged')).toBeVisible();
  await expect(page.getByTestId(`merge-${toMerge.id}`)).toHaveCount(0);
  const merged = await json<{ aliases: string[] }>(await api.get(`/api/suppliers/${target!.id}`));
  expect(merged.aliases).toContain(toMerge.name);
  expect((await api.get(`/api/suppliers/${toMerge.id}`)).status()).toBe(404);

  // the supplier page of the demo's payment platform: a certificate about to run out, a contract with its notice date
  await page.goto(`/suppliers/${target!.id}`);
  await expect(page.getByRole('heading', { name: /Paylumen/ })).toBeVisible();
  await expectAccessible(page, 'supplier: demo payment platform');
  // the tabs (0.18.0, ADR 0031)
  await page.getByTestId('supplier-tab-certificates').click();
  await expect(page.getByTestId('supplier-certificates')).toContainText('ISO/IEC 27001');
  await page.getByTestId('supplier-tab-contracts').click();
  await expect(page.getByTestId('supplier-contracts')).toContainText('Payment platform subscription');
  await page.getByTestId('supplier-tab-usedBy').click();
  await expect(page.getByTestId('supplier-used-by')).toContainText('Ticket reference');
});

test('a supplier with a contract that a cost plan line pays for', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const name = uniq('Example Analytics GmbH');
  const service = await json<{ id: string; name: string }>(await api.post('/api/services', { data: { name: uniq('Supplier service') } }));
  try {
    await page.goto('/suppliers');
    await page.getByRole('button', { name: 'New supplier' }).first().click();
    let dialog = page.getByRole('dialog', { name: 'New supplier' });
    await dialog.getByRole('textbox', { name: 'Name' }).fill(name);
    await expect(dialog.getByRole('combobox', { name: 'Type' })).toHaveValue('SaaS');
    await dialog.getByRole('textbox', { name: 'Website' }).fill('https://analytics.example');
    await expectAccessible(page, 'suppliers: new supplier');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page).toHaveURL(/\/suppliers\/sup_/);
    await expect(page.getByRole('heading', { name })).toBeVisible();

    // a contract with a notice period
    await page.getByTestId('supplier-tab-contracts').click();
    await page.getByRole('button', { name: 'Add contract' }).click();
    dialog = page.getByRole('dialog', { name: 'Add contract' });
    await dialog.getByRole('textbox', { name: 'Title' }).fill('Analytics subscription');
    await dialog.getByRole('textbox', { name: 'Contract number' }).fill('EA-2027-01');
    await dialog.getByLabel('End').fill('2030-12-31');
    await dialog.getByRole('textbox', { name: 'Notice period (days)' }).fill('90');
    await dialog.getByRole('textbox', { name: 'RTO (hours)' }).fill('8');
    await expectAccessible(page, 'supplier: contract dialog');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    const contracts = page.getByTestId('supplier-contracts');
    await expect(contracts).toContainText('Analytics subscription');
    await expect(contracts).toContainText('EA-2027-01');
    await expect(contracts).toContainText('2 Oct 2030');

    // a cost plan line of the service names the supplier and the contract
    await page.goto(`/services/${service.id}/costs`);
    const view = page.getByTestId('service-cost-plan');
    await view.getByTestId('plan-add-line').click();
    dialog = page.getByRole('dialog', { name: /^New plan line, FY / });
    // the dialog says that a line needs no contract (a licence to buy later)
    await expect(dialog.getByText(/A line needs no contract/)).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Title' }).fill('Analytics licence');
    await chooseOption(page, 'Supplier', name);
    await chooseOption(page, 'Contract', 'Analytics subscription (EA-2027-01)');
    await dialog.getByRole('textbox', { name: 'Amount per year' }).fill('6000');
    await dialog.getByRole('textbox', { name: 'Currency' }).fill('EUR');
    await expectAccessible(page, 'cost plan: line with a supplier');
    await dialog.getByTestId('plan-line-save').click();
    await expect(dialog).toBeHidden();
    await expect(view.getByTestId('plan-lines')).toContainText(`${name} – Analytics subscription`);

    // the supplier page lists the line under the contract and under "Used by"
    const sup = (await json<Supplier[]>(await api.get('/api/suppliers'))).find((s) => s.name === name)!;
    await page.goto(`/suppliers/${sup.id}?tab=usedBy`);
    await expect(page.getByTestId('supplier-used-by')).toContainText('Cost plan line');
    await page.getByTestId('supplier-tab-contracts').click();
    await page.getByRole('link', { name: 'Analytics subscription' }).click();
    await expect(page.getByTestId('contract-plan-lines')).toContainText('Analytics licence');
    await expectAccessible(page, 'supplier: a paid contract');
    // the line opens the service's cost plan (it led to the service's overview before)
    await page
      .getByTestId('contract-plan-lines')
      .getByRole('link', { name: /Analytics licence/ })
      .click();
    await expect(page).toHaveURL((u) => u.pathname.endsWith(`/services/${service.id}/costs`));
    await expect(page.getByTestId('service-cost-plan')).toBeVisible();
  } finally {
    await api.post(`/api/services/${service.id}/archive`, { data: { archived: true } });
  }
});

test('suppliers on a phone @mobile', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const target = (await json<Supplier[]>(await api.get('/api/suppliers'))).find((s) => s.name === 'Example Cloud GmbH');
  expect(target, 'the demo supplier Example Cloud GmbH').toBeTruthy();
  await page.goto('/suppliers');
  await expect(page.getByRole('heading', { name: 'Suppliers', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Example Cloud GmbH' }).first()).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expectAccessible(page, 'suppliers: phone');
  await page.goto(`/suppliers/${target!.id}?tab=contracts`);
  await expect(page.getByTestId('supplier-contracts')).toContainText('Managed Kubernetes');
  await expectNoHorizontalScroll(page);
  await expectAccessible(page, 'supplier: phone');
});
