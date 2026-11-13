import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible } from './support/axe';
import { expectNoHorizontalScroll, json, uniq } from './support/helpers';

test.use({ storageState: authFile('admin') });

/**
 * Price books, calculators and estimates (0.21.0, ADR 0035, docs/PRICE-BOOKS.md): a book with two versions and What
 * changed, a calculator tried with Calculate, an estimate with a ranged input, its lines with low–high bars and Compare,
 * and the estimates of a service's cost plan – on a desktop and on a phone, with axe.
 */

interface Fixture {
  provider: string;
  book: { id: string; name: string };
  calculator: { id: string };
  service: { id: string; name: string };
  estimate: { id: string };
}

const definition = (id: string, provider: string) => `kind: costCalculator
id: ${id}
name: E2E messaging
inputs:
  - { key: rate, label: Requests per second, type: number, unit: '{request}/s', default: 20, min: 0 }
lines:
  - { key: requests, label: API requests, item: { provider: ${provider}, sku: api }, quantity: inputs.rate * 3600 * const.hoursPerMonth, unit: '{request}' }
  - { key: seats, label: Seats, item: { provider: ${provider}, sku: seat }, quantity: 3, unit: '{seat}.mo' }
`;

async function fixture(api: APIRequestContext): Promise<Fixture> {
  const provider = uniq('Invented E2E AG');
  const book = await json<{ id: string; name: string }>(
    await api.post('/api/costs/price-books', { data: { name: uniq('E2E prices'), kind: 'list', provider, currency: 'EUR' } }),
  );
  const entries = (seat: string) => [
    {
      sku: 'api',
      name: 'API requests',
      unit: '{request}',
      price: '0.40',
      block: 1_000_000,
      currency: 'EUR',
      tiers: [
        { from: '0', price: '0.40' },
        { from: '100000000', price: '0.25' },
      ],
    },
    { sku: 'seat', name: 'Seats', unit: '{seat}.mo', charge: 'recurring', price: seat, currency: 'EUR' },
  ];
  expect((await api.put(`/api/costs/price-books/${book.id}/entries`, { data: { mode: 'replace', entries: entries('12') } })).ok()).toBe(true);
  expect((await api.put(`/api/costs/price-books/${book.id}/entries`, { data: { mode: 'replace', entries: entries('15') } })).ok()).toBe(true);
  const calculator = await json<{ id: string }>(
    await api.post('/api/costs/calculators', {
      data: {
        definition: definition(
          uniq('e2e-calc')
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, '-'),
          provider,
        ),
        publish: true,
      },
    }),
  );
  const service = await json<{ id: string; name: string }>(await api.post('/api/services', { data: { name: uniq('Estimated service') } }));
  const estimate = await json<{ id: string }>(
    await api.post('/api/costs/estimates', {
      data: {
        title: 'Order notifications',
        ownerKind: 'service',
        ownerId: service.id,
        currency: 'EUR',
        calculatorId: calculator.id,
        inputs: [{ key: 'rate', value: { low: 10, expected: 50, high: 100 } }],
        adjustments: [{ line: 'seats', kind: 'percent', percent: '-20', reason: 'Negotiation target' }],
      },
    }),
  );
  return { provider, book, calculator, service, estimate };
}

async function cleanup(api: APIRequestContext, f: Fixture) {
  await api.delete(`/api/costs/estimates/${f.estimate.id}`);
  await api.delete(`/api/costs/calculators/${f.calculator.id}`);
  await api.delete(`/api/costs/price-books/${f.book.id}`);
  await api.post(`/api/services/${f.service.id}/archive`, { data: { archived: true } });
}

async function flow(page: Page, f: Fixture, mobile: boolean) {
  // ---- price books: the list, one book, What changed ----
  await page.goto('/costs/price-books');
  const list = page.getByTestId('price-books-page');
  await expect(list).toContainText(f.book.name);
  await expect(page.getByTestId('fx-rates')).toBeVisible();
  await expectAccessible(page, 'price books');
  if (mobile) await expectNoHorizontalScroll(page);
  await page.goto(`/costs/price-books/${f.book.id}`);
  const book = page.getByTestId('price-book-page');
  await expect(book.getByTestId('price-items')).toContainText('API requests');
  await expect(book.getByTestId('price-versions')).toContainText('v2');
  await expectAccessible(page, 'price book');
  if (mobile) await expectNoHorizontalScroll(page);
  await page.getByTestId('version-2').click();
  const diff = page.getByTestId('version-diff');
  await expect(diff).toContainText('seat');
  await expect(diff).toContainText('+25');
  await expectAccessible(page, 'price book: what changed');
  await page.keyboard.press('Escape');

  // ---- the calculator: Calculate (a dry run) ----
  await page.goto(`/costs/calculators/${f.calculator.id}`);
  await expect(page.getByTestId('calculator-definition')).toBeVisible();
  await page.getByTestId('calculator-calculate').click();
  await expect(page.getByTestId('estimate-lines')).toContainText('API requests');
  await expectAccessible(page, 'calculator');
  if (mobile) await expectNoHorizontalScroll(page);

  // ---- the estimate: lines with their ranges, the adjustment, Compare ----
  await page.goto(`/costs/estimates/${f.estimate.id}`);
  const est = page.getByTestId('estimate-page');
  await expect(est.getByTestId('estimate-result')).toContainText('API requests');
  await expect(est.getByTestId('line-adjustment')).toContainText('Negotiation target');
  await expect(est.getByTestId('estimate-result')).toContainText('a span, not a probability');
  await est.getByTestId('compare-add').click();
  await est.getByTestId('compare-run').click();
  await expect(est.getByTestId('compare-result')).toContainText('Cheapest');
  await expectAccessible(page, 'estimate');
  if (mobile) await expectNoHorizontalScroll(page);

  // ---- the service's cost plan lists it ----
  await page.goto(`/services/${f.service.id}/costs`);
  await expect(page.getByTestId('cost-estimates')).toContainText('Order notifications');
  if (mobile) await expectNoHorizontalScroll(page);
}

test('price books, a calculator and an estimate with ranges and Compare', async ({ page, apiAs }) => {
  test.setTimeout(180_000);
  const api = await apiAs('admin');
  const f = await fixture(api);
  try {
    await flow(page, f, false);
  } finally {
    await cleanup(api, f);
  }
});

test('price books and estimates on a phone @mobile', async ({ page, apiAs }) => {
  test.setTimeout(180_000);
  const api = await apiAs('admin');
  const f = await fixture(api);
  try {
    await flow(page, f, true);
  } finally {
    await cleanup(api, f);
  }
});
