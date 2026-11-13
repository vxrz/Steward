import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible } from './support/axe';
import { expectNoHorizontalScroll, json, uniq } from './support/helpers';

test.use({ storageState: authFile('admin') });

/**
 * Contract conditions and derived books (0.23.0, ADR 0035 phase 2, docs/PRICE-BOOKS.md): a contract's Prices section
 * with a condition added in the dialog, an estimate whose lines say how their price was found, a derived book with its
 * base, terms and Access tab, an estimate line from it with base, discount and fee, a platform book's source – on a
 * desktop and on a phone, with axe.
 */

interface Fixture {
  provider: string;
  supplier: string;
  contract: string;
  list: string;
  derived: string;
  service: string;
  estimate: string;
  viaProvider: string;
}

async function fixture(api: APIRequestContext): Promise<Fixture> {
  const provider = uniq('Invented Cloud E2E');
  const list = await json<{ id: string }>(
    await api.post('/api/costs/price-books', { data: { name: uniq('E2E list'), kind: 'list', provider, currency: 'USD' } }),
  );
  const entries = [
    { sku: 'vm', name: 'Small VM', service: 'Compute', unit: 'h', price: '0.10', currency: 'USD' },
    { sku: 'egress', name: 'Egress', service: 'Network', unit: 'GBy', price: '0.09', currency: 'USD' },
  ];
  expect((await api.put(`/api/costs/price-books/${list.id}/entries`, { data: { mode: 'replace', entries } })).ok()).toBe(true);
  const supplier = await json<{ id: string }>(await api.post('/api/suppliers', { data: { name: uniq('Invented supplier'), type: 'saas' } }));
  const sup = await json<{ contracts: { id: string; title: string }[] }>(
    await api.post(`/api/suppliers/${supplier.id}/contracts`, { data: { title: 'E2E price agreement', reference: 'E2E-1' } }),
  );
  const contract = sup.contracts.find((c) => c.title === 'E2E price agreement')!.id;
  expect(
    (
      await api.put(`/api/costs/contracts/${contract}/conditions`, {
        data: {
          conditions: [
            { kind: 'percentOff', provider, on: 'service', target: 'Compute', percent: '12' },
            { kind: 'negotiatedPrice', provider, on: 'item', target: 'egress', price: '0.05', currency: 'USD' },
            { kind: 'baseDiscount', provider, on: 'provider', percent: '10' },
            { kind: 'markup', provider, on: 'provider', percent: '8' },
          ],
        },
      })
    ).ok(),
  ).toBe(true);
  const derived = await json<{ id: string }>(
    await api.post('/api/costs/price-books', {
      data: {
        name: uniq('E2E derived'),
        kind: 'derived',
        provider,
        currency: 'USD',
        supplierId: supplier.id,
        supplierContractId: contract,
        baseBookId: list.id,
      },
    }),
  );
  const service = await json<{ id: string }>(await api.post('/api/services', { data: { name: uniq('Priced service') } }));
  const lines = [
    { key: 'vm', provider, sku: 'vm', quantity: '1000', unit: 'h' },
    { key: 'out', provider, sku: 'egress', quantity: '1000', unit: 'GBy' },
  ];
  const estimate = await json<{ id: string }>(
    await api.post('/api/costs/estimates', {
      data: {
        title: 'Priced by contract',
        ownerKind: 'service',
        ownerId: service.id,
        currency: 'USD',
        lines,
        books: [{ provider, bookId: list.id }],
        contracts: [{ provider, contractId: contract }],
      },
    }),
  );
  const via = await json<{ id: string }>(
    await api.post('/api/costs/estimates', {
      data: { title: 'Through the provider', ownerKind: 'service', ownerId: service.id, currency: 'USD', lines, books: [{ provider, bookId: derived.id }] },
    }),
  );
  return { provider, supplier: supplier.id, contract, list: list.id, derived: derived.id, service: service.id, estimate: estimate.id, viaProvider: via.id };
}

async function cleanup(api: APIRequestContext, f: Fixture) {
  await api.delete(`/api/costs/estimates/${f.estimate}`);
  await api.delete(`/api/costs/estimates/${f.viaProvider}`);
  await api.delete(`/api/costs/price-books/${f.derived}`);
  await api.delete(`/api/costs/price-books/${f.list}`);
  await api.post(`/api/services/${f.service}/archive`, { data: { archived: true } });
}

async function flow(page: Page, api: APIRequestContext, f: Fixture, mobile: boolean) {
  // ---- the contract's Prices: the conditions, a new one added in the dialog ----
  await page.goto(`/suppliers/${f.supplier}/contracts/${f.contract}`);
  const prices = page.getByTestId('contract-prices');
  await expect(prices.getByTestId('contract-conditions')).toContainText('12 % off');
  await expect(prices.getByTestId('contract-conditions')).toContainText('Negotiated unit price');
  await expectAccessible(page, 'contract prices');
  if (mobile) {
    await expectNoHorizontalScroll(page);
    // a card per condition on a phone, not a table to scroll sideways
    await expect(prices.getByTestId('condition-card')).toHaveCount(4);
    await expect(prices.getByRole('table')).toHaveCount(0);
  }
  if (!mobile) {
    await prices.getByTestId('contract-prices-edit').click();
    // the target suggests what the provider's books name; a book is picked from them
    await page.getByTestId('condition-0-target').fill('Netw');
    await expect(page.getByRole('option', { name: 'Network', exact: true })).toBeVisible();
    await page.getByTestId('condition-0-target').fill('Compute');
    await page.getByTestId('conditions-form').getByText('The most specific condition wins').click();
    await page.getByTestId('condition-add').click();
    // a commitment's bands, a row each – the short form pasted is read into rows
    await page.getByTestId('condition-4-kind').click();
    await page.getByRole('option', { name: 'Commitment', exact: true }).click();
    const bands = page.getByTestId('condition-4-bands');
    await bands.getByRole('textbox', { name: 'Committed amount per year, band 1' }).fill('0:0;100000:15');
    await expect(bands.getByRole('textbox', { name: 'Committed amount per year, band 2' })).toHaveValue('100000');
    await expect(bands.getByRole('textbox', { name: 'Percentage, band 2' })).toHaveValue('15');
    await expectAccessible(page, 'contract prices: a commitment with its bands');
    await page.getByTestId('condition-4-kind').click();
    await page.getByRole('option', { name: 'Percent off list', exact: true }).click();
    // saving without a percentage: the form marks the field in plain words and puts the focus there
    await page.getByTestId('conditions-save').click();
    await expect(page.getByTestId('condition-4-percent')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByTestId('condition-4-percent')).toBeFocused();
    await expect(page.getByTestId('conditions-form')).toContainText('A percentage from 0 to 100');
    await expect(page.getByTestId('conditions-form')).not.toContainText('conditions.4');
    // a decimal comma as typed in German is taken
    await page.getByTestId('condition-4-percent').fill('5,5');
    await expectAccessible(page, 'contract prices: the dialog');
    await page.getByTestId('conditions-save').click();
    await expect(prices.getByTestId('contract-conditions')).toContainText('5.5 % off');
  }

  // ---- an estimate priced with them: how each price was found ----
  await page.goto(`/costs/estimates/${f.estimate}`);
  const est = page.getByTestId('estimate-page');
  await expect(est.getByTestId('estimate-result')).toContainText('12 % off by contract E2E-1');
  await expect(est.getByTestId('estimate-result')).toContainText('Negotiated price of contract E2E-1');
  await expectAccessible(page, 'estimate priced by contract');
  if (mobile) await expectNoHorizontalScroll(page);

  // ---- a list book's item: its validity picked as days ----
  if (!mobile) {
    await page.goto(`/costs/price-books/${f.list}`);
    await page.getByTestId('entry-add').click();
    const entry = page.getByRole('dialog');
    await expect(entry.getByLabel('Valid from')).toHaveAttribute('type', 'date');
    await expect(entry.getByLabel('Valid to')).toHaveAttribute('type', 'date');
    await entry.getByRole('button', { name: 'Cancel' }).click();
  }

  // ---- the derived book: its base, its terms on the contract, Access ----
  await page.goto(`/costs/price-books/${f.derived}`);
  const info = page.getByTestId('derived-info');
  await expect(info).toContainText('Based on');
  await expect(info.getByTestId('derived-terms')).toContainText('Markup');
  await expect(page.getByTestId('access-tab')).toBeVisible();
  await expect(page.getByTestId('entry-add')).toHaveCount(0);
  await expectAccessible(page, 'derived book');
  if (mobile) await expectNoHorizontalScroll(page);

  // ---- an estimate through the provider: base, discount, markup ----
  await page.goto(`/costs/estimates/${f.viaProvider}`);
  await expect(page.getByTestId('estimate-result')).toContainText('Customer price of');
  await expect(page.getByTestId('line-breakdown').first()).toContainText('Discount 10 %');
  await expectAccessible(page, 'estimate through a provider');
  if (mobile) await expectNoHorizontalScroll(page);

  // ---- a platform's contracted book can be read from a source ----
  const books = await json<{ id: string; kind: string; platform: { id: string } | null }[]>(await api.get('/api/costs/price-books'));
  const platformBook = books.find((b) => b.kind === 'contracted' && b.platform);
  if (platformBook) {
    await page.goto(`/costs/price-books/${platformBook.id}`);
    await expect(page.getByTestId('book-source')).toBeVisible();
    await expectAccessible(page, 'platform book with its source');
    if (mobile) await expectNoHorizontalScroll(page);
  }
}

test('contract conditions, derived books and how each estimate line was priced', async ({ page, apiAs }) => {
  test.setTimeout(180_000);
  const api = await apiAs('admin');
  const f = await fixture(api);
  try {
    await flow(page, api, f, false);
  } finally {
    await cleanup(api, f);
  }
});

test('contract conditions and derived books on a phone @mobile', async ({ page, apiAs }) => {
  test.setTimeout(180_000);
  const api = await apiAs('admin');
  const f = await fixture(api);
  try {
    await flow(page, api, f, true);
  } finally {
    await cleanup(api, f);
  }
});

test('the contract’s prices in German: percentages and days in the UI language', async ({ page, apiAs }) => {
  test.setTimeout(120_000);
  const api = await apiAs('admin');
  const f = await fixture(api);
  try {
    const conditions = [
      { kind: 'percentOff', provider: f.provider, on: 'service', target: 'Compute', percent: '12.5', validFrom: '2026-01-01', validTo: '2026-12-31' },
    ];
    expect((await api.put(`/api/costs/contracts/${f.contract}/conditions`, { data: { conditions } })).ok()).toBe(true);
    await page.addInitScript(() => localStorage.setItem('steward.language', 'de'));
    await page.goto(`/suppliers/${f.supplier}/contracts/${f.contract}`);
    const table = page.getByTestId('contract-prices').getByTestId('contract-conditions');
    // "12,5 % Nachlass", the validity as German days – not "12.5" and "2026-01-01"
    await expect(table).toContainText('12,5 % Nachlass');
    await expect(table).toContainText('01.01.2026');
    await expect(table).not.toContainText('2026-01-01');
    // the derived book's versions name their cause in German (a code, not the server's English text)
    await page.goto(`/costs/price-books/${f.derived}`);
    await expect(page.getByText('Die Konditionen des Vertrags wurden geändert').first()).toBeVisible();
    await expectAccessible(page, 'contract prices (de)');
  } finally {
    await cleanup(api, f);
  }
});
