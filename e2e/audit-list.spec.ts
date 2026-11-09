import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { expectNoHorizontalScroll, json, uniq } from './support/helpers';

/**
 * 0.13: the audit log is sorted and filtered by the server, with its filters and order in the address, the shared
 * list table with cards on phones, and the expandable entries of 0.12.
 */
test.use({ storageState: authFile('audrey') });

/** Two systems (one by the administrator, then one by Dana): two audit entries whose summaries hold `tag`. */
async function twoEntries(apiAs: (u: 'admin' | 'dana') => Promise<APIRequestContext>, tag: string) {
  const admin = await apiAs('admin');
  const dana = await apiAs('dana');
  const a = await json<{ id: string }>(await admin.post('/api/systems', { data: { name: `${tag} sys a`, kind: 'server' } }));
  const b = await json<{ id: string }>(await dana.post('/api/systems', { data: { name: `${tag} sys b`, kind: 'vm' } }));
  return async () => {
    for (const s of [a, b]) await admin.delete(`/api/systems/${s.id}`);
  };
}

/** The actors of the rows shown, top to bottom. */
const actors = (page: Page) =>
  page
    .getByRole('table', { name: 'Audit log' })
    .locator('tbody tr[data-testid="audit-row"] td:nth-child(3)')
    .evaluateAll((cells) => cells.map((c) => (c as HTMLElement).innerText.trim()));

test.describe('audit log sorted by the server', () => {
  test('sorts by a column, keeps the order and the filters in the address', async ({ page, apiAs }) => {
    const tag = uniq('E2E audit');
    const cleanup = await twoEntries(apiAs, tag);
    try {
      await page.goto(`/audit?q=${encodeURIComponent(tag)}&action=system.created`);
      await settle(page);
      await expect(page.getByRole('searchbox', { name: 'Search' })).toHaveValue(tag);
      const table = page.getByRole('table', { name: 'Audit log' });
      // newest first by default
      await expect.poll(() => actors(page)).toEqual(['dana', 'admin']);
      const time = table.getByRole('columnheader', { name: 'Time' });
      await expect(time).toHaveAttribute('aria-sort', 'descending');
      const actor = table.getByRole('columnheader', { name: 'Actor' });
      await actor.getByRole('button').click();
      await expect(actor).toHaveAttribute('aria-sort', 'ascending');
      await expect(page).toHaveURL(/sort=actor&order=asc/);
      await expect.poll(() => actors(page)).toEqual(['admin', 'dana']);
      await actor.getByRole('button').click();
      await expect(actor).toHaveAttribute('aria-sort', 'descending');
      await expect.poll(() => actors(page)).toEqual(['dana', 'admin']);
      // the order survives a reload (it is in the address)
      await page.reload();
      await expect(table.getByRole('columnheader', { name: 'Actor' })).toHaveAttribute('aria-sort', 'descending');
      await expect.poll(() => actors(page)).toEqual(['dana', 'admin']);
      // the entries still open with their toggle
      const toggle = table.getByTestId('audit-row-toggle').first();
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByTestId('audit-row-details')).toContainText('hash');
      await expectAccessible(page, 'audit log sorted by actor');

      // a filter chosen on the page goes into the address
      const filters = page.getByTestId('audit-filters');
      await filters.getByRole('combobox', { name: 'Actor' }).fill('dana');
      await page.getByRole('option', { name: 'dana', exact: true }).click();
      await expect(page).toHaveURL(/actor=dana/);
      await expect.poll(() => actors(page)).toEqual(['dana']);
      // target type and dates from the address
      await page.goto(`/audit?q=${encodeURIComponent(tag)}&type=system`);
      await expect.poll(() => actors(page)).toEqual(['dana', 'admin']);
      await expect(table).toContainText('system');
      await page.goto(`/audit?q=${encodeURIComponent(tag)}&type=platform`);
      await expect(page.getByText('No entries match the filters.')).toBeVisible();
      const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
      await page.goto(`/audit?q=${encodeURIComponent(tag)}&from=${today}&to=${today}`);
      await expect.poll(() => actors(page)).toEqual(['dana', 'admin']);
      await expect(page.getByTestId('audit-filters').getByLabel('From')).toHaveValue(today);
      await page.goto(`/audit?q=${encodeURIComponent(tag)}&to=2001-01-01`);
      await expect(page.getByText('No entries match the filters.')).toBeVisible();
    } finally {
      await cleanup();
    }
  });
});

test.describe('audit log on phones @mobile', () => {
  test('cards with a sort menu and entries that open', async ({ page, apiAs }) => {
    const tag = uniq('E2E audit');
    const cleanup = await twoEntries(apiAs, tag);
    try {
      await page.goto(`/audit?q=${encodeURIComponent(tag)}&action=system.created`);
      await settle(page);
      const list = page.getByRole('list', { name: 'Audit log' });
      await expect(list.getByRole('listitem')).toHaveCount(2);
      await expect(list.getByRole('listitem').first()).toContainText('dana');
      await expect(page.getByRole('table', { name: 'Audit log' })).toHaveCount(0);
      await expect(page.getByTestId('list-sort')).toBeVisible();
      const toggle = list.getByTestId('audit-row-toggle').first();
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(list.getByTestId('audit-row-details')).toContainText('hash');
      await expectNoHorizontalScroll(page);
      await expectAccessible(page, 'audit log cards');
    } finally {
      await cleanup();
    }
  });
});
