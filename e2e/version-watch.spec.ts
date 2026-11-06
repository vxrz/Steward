import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible } from './support/axe';
import { chooseOption, expectNoHorizontalScroll, json, uniq } from './support/helpers';

test.use({ storageState: authFile('dana') });

/**
 * Version watch of the tech stack (#241): a designer reads the newest versions (the demo's simulated npm registry and
 * endoflife.date), the component shows the newest version next to an entry that is behind, the application's tech
 * stack lists installed → newest, behind by, end of life, and the dialog of an entry shows what each source said and
 * lets an editor choose the source. The settings are for administrators only.
 */

async function setup(api: APIRequestContext, name: string): Promise<string> {
  const app = await json<{ id: string }>(await api.post('/api/applications', { data: { name, owners: [] } }));
  await json(
    await api.post(`/api/applications/${app.id}/components`, {
      data: {
        type: 'container-image',
        name: 'ghcr.io/acme/shop-ui',
        stack: [
          { product: 'react', version: '18.3.1' },
          { product: 'nodejs', version: '24.11.0' },
        ],
      },
    }),
  );
  await json(await api.post('/api/catalogue/lifecycle/refresh', { data: {} }));
  await json(await api.post('/api/catalogue/versions/refresh', { data: {} }));
  return app.id;
}

async function entryDialog(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'React in ghcr.io/acme/shop-ui' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('version-newest')).toHaveText('19.2.0');
  await expect(dialog.getByText('Found by Package registry: npm, pkg:npm/react')).toBeVisible();
  await expect(dialog.getByRole('table', { name: 'What each source said' })).toContainText('endoflife.date');
  return dialog;
}

test('the tech stack shows the newest version and how far behind', async ({ page, apiAs }) => {
  const api = await apiAs('dana');
  const id = await setup(api, uniq('E2E versions'));
  try {
    await page.goto(`/applications/${id}`);
    const row = page.getByTestId('application-components').getByRole('row', { name: /ghcr\.io\/acme\/shop-ui/ });
    const badge = row.getByRole('button', { name: 'React 18.3.1: newest 19.2.0, 1 major release behind – details' });
    await expect(badge).toHaveAttribute('data-lag', 'major');

    const versions = page.getByTestId('stack-versions');
    await expect(versions.getByRole('table', { name: 'Versions' })).toBeVisible();
    const react = versions.getByRole('row', { name: /React 18\.3\.1/ });
    await expect(react).toContainText('19.2.0');
    await expect(react).toContainText('1 major');
    await expect(versions.getByRole('row', { name: /Node\.js 24\.11\.0/ })).toContainText('end of life');
    await expectAccessible(page, 'tech stack with versions');

    // the entry: what each source said, and where to look (an editor)
    await badge.click();
    let dialog = await entryDialog(page);
    await expectAccessible(page, 'version watch of an entry');
    await chooseOption(page, 'Source', 'endoflife.date');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved and read again.')).toBeVisible();
    await expect(dialog.getByTestId('version-newest')).toHaveText('19.4');
    await chooseOption(page, 'Source', 'Automatic');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByTestId('version-newest')).toHaveText('19.2.0');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // the same from the table, by keyboard
    await versions.getByRole('button', { name: 'Version watch of React in ghcr.io/acme/shop-ui' }).focus();
    await page.keyboard.press('Enter');
    dialog = await entryDialog(page);
    await page.keyboard.press('Escape');
  } finally {
    await api.post(`/api/applications/${id}/archive`, { data: { archived: true } });
  }
});

test('the version watch settings: the state of the sources, administrators change them', async ({ page }) => {
  await page.goto('/applications');
  await page.getByRole('button', { name: 'Version watch' }).click();
  const dialog = page.getByRole('dialog', { name: 'Version watch of the tech stack' });
  await expect(dialog.getByTestId('version-status')).toContainText(/entries/);
  await expect(dialog.getByText('Only administrators change these settings.')).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: /Package registry/ })).toBeDisabled();
  await expect(dialog.getByRole('switch', { name: 'Count on the scorecard' })).toBeDisabled();
  await expectAccessible(page, 'version watch settings');
});

test('versions on a phone: cards instead of the table @mobile', async ({ page, apiAs }) => {
  const api = await apiAs('dana');
  const id = await setup(api, uniq('E2E versions phone'));
  try {
    await page.goto(`/applications/${id}`);
    const versions = page.getByTestId('stack-versions');
    const card = versions.getByRole('listitem').filter({ hasText: 'React 18.3.1' });
    await expect(card).toContainText('Newest 19.2.0 (npm)');
    await card.getByRole('button', { name: 'Version watch of React in ghcr.io/acme/shop-ui' }).click();
    await entryDialog(page);
    await expectAccessible(page, 'version watch of an entry on a phone');
    await page.keyboard.press('Escape');
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'versions on a phone');
  } finally {
    await api.post(`/api/applications/${id}/archive`, { data: { archived: true } });
  }
});
