import { test, expect } from './support/fixtures';
import { PROCESS, authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { expectNoHorizontalScroll, json, startRunApi, uniq } from './support/helpers';
import { BRAND } from '../shared/src/brand';

/** The UX backlog: confirmation dialog, sortable lists with "Load more", phone cards, shortcuts, Help menu, validation. */

test.describe('lists, dialogs and help (admin)', () => {
  test.use({ storageState: authFile('admin') });

  test('a destructive action asks in a themed dialog: Cancel and Escape keep, Delete deletes', async ({ page, apiAs }) => {
    const api = await apiAs('admin');
    const name = uniq('Confirm team');
    await json(await api.post('/api/teams', { data: { name, members: [] } }));
    await page.goto('/users');
    await settle(page);
    const del = page.getByRole('button', { name: `Delete team ${name}` });

    await del.click();
    const dialog = page.getByRole('dialog', { name: 'Confirm deletion' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('confirm-dialog-message')).toContainText(name);
    // focus starts on Cancel, so Enter never deletes by accident
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expectAccessible(page, 'confirmation dialog');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await del.click();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(name, { exact: true })).toHaveCount(1);

    await del.click();
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByText(name, { exact: true })).toHaveCount(0);
  });

  test('runs: columns sort, "Load more" fetches older runs, filters from the URL', async ({ page, apiAs }) => {
    const api = await apiAs('admin');
    for (let i = 0; i < 3; i++) await startRunApi(api, PROCESS.healthCheck, { dryRun: true });

    await page.goto('/runs?limit=2');
    await settle(page);
    const table = page.getByTestId('run-list');
    await expect(table.locator('tbody tr')).toHaveCount(2);
    const footer = page.getByTestId('list-footer');
    await expect(footer).toContainText('Showing the first 2 entries');
    await footer.getByRole('button', { name: 'Load more' }).click();
    await expect(table.locator('tbody tr')).toHaveCount(4);

    // sort by process: ascending, descending, back to the list order
    const header = table.getByRole('columnheader', { name: 'Process' });
    await expect(header).toHaveAttribute('aria-sort', 'none');
    await header.getByRole('button').click();
    await expect(header).toHaveAttribute('aria-sort', 'ascending');
    const names = async () => table.locator('tbody tr td:nth-child(2)').allInnerTexts();
    const asc = await names();
    expect(asc).toEqual([...asc].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true })));
    await header.getByRole('button').click();
    await expect(header).toHaveAttribute('aria-sort', 'descending');
    await header.getByRole('button').click();
    await expect(header).toHaveAttribute('aria-sort', 'none');

    // the start page's runs tile opens the failed runs when there are any
    await page.goto('/runs?status=failed');
    await expect(page.getByRole('textbox', { name: 'Status' })).toHaveValue('failed');
  });

  test('start page: tiles for monitors down and credentials due link to filtered lists', async ({ page }) => {
    await page.goto('/');
    await settle(page);
    const tiles = page.getByTestId('start-tiles');
    const monitors = tiles.getByRole('link', { name: /Monitors down/ });
    await expect(monitors).toHaveAttribute('href', '/monitors?status=down');
    await expect(tiles.getByRole('link', { name: /Credentials due/ })).toHaveAttribute('href', '/credentials?status=expired,overdue,dueSoon');
    await expect(tiles.getByRole('link')).toHaveCount(6);
    await monitors.click();
    await expect(page).toHaveURL(/\/monitors\?status=down$/);
    const filter = page.getByRole('group', { name: 'Filter by status' });
    await expect(filter.getByRole('button', { pressed: true })).toContainText('Down');
  });

  test('? lists the shortcuts; g r opens the runs; nothing happens while typing', async ({ page }) => {
    await page.goto('/');
    await settle(page);
    await page.locator('body').press('?');
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('shortcut-list')).toContainText('Go to Runs');
    await expectAccessible(page, 'shortcut dialog');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await page.keyboard.press('g');
    await page.keyboard.press('r');
    await expect(page).toHaveURL(/\/runs$/);
    await page.keyboard.press('g');
    await page.keyboard.press('d');
    await expect(page).toHaveURL(/\/$/);

    // typing "g m" into a search field stays in the field
    await page.goto('/records');
    await settle(page);
    const search = page.getByRole('textbox', { name: 'Search' });
    await search.click();
    await page.keyboard.type('gm?');
    await expect(search).toHaveValue('gm?');
    await expect(page).toHaveURL(/\/records/);
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeHidden();
  });

  test('Help menu: what is new, docs on GitHub, the checklist and About', async ({ page }) => {
    await page.goto('/');
    await settle(page);
    await page.getByRole('button', { name: 'Help' }).click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'AI assistants (MCP)' })).toHaveAttribute('href', `${BRAND.repoUrl}/blob/HEAD/docs/MCP.md`);
    await expect(menu.getByRole('menuitem', { name: 'Public REST API' })).toHaveAttribute('href', `${BRAND.repoUrl}/blob/HEAD/docs/API.md`);
    await menu.getByRole('menuitem', { name: "What's new" }).click();
    const news = page.getByRole('dialog', { name: "What's new" });
    await expect(news.getByTestId('whats-new')).toContainText('Git sync');
    await expectAccessible(page, "what's new dialog");
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Help' }).click();
    await page.getByRole('menuitem', { name: 'Getting-started checklist' }).click();
    await expect(page).toHaveURL(/\/\?checklist=1$/);
    await expect(page.getByTestId('getting-started')).toBeVisible();

    await page.getByRole('button', { name: 'Help' }).click();
    await page.getByRole('menuitem', { name: `About ${BRAND.name}` }).click();
    await expect(page).toHaveURL(/\/about$/);
  });

  test('create dialogs: the button stays enabled and names what is missing', async ({ page }) => {
    await page.goto('/records?new=1');
    const dialog = page.getByRole('dialog', { name: 'New record' });
    await expect(dialog).toBeVisible();
    const create = dialog.getByRole('button', { name: 'Create draft' });
    await expect(create).toBeEnabled();
    await create.click();
    await expect(dialog.getByText('Required')).toHaveCount(2);
    await expect(dialog.getByRole('textbox', { name: 'Type' })).toHaveAttribute('aria-invalid', 'true');
    await expect(dialog.getByRole('textbox', { name: 'Type' })).toBeFocused();
    await expectAccessible(page, 'new record dialog with errors');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectAccessible(page, 'new record dialog with errors (dark)');
  });

  test('detail pages show a skeleton while they load', async ({ page, apiAs }) => {
    const runId = await startRunApi(await apiAs('admin'), PROCESS.healthCheck, { dryRun: true });
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    await page.route(`**/api/runs/${runId}`, async (route) => {
      await held;
      await route.continue();
    });
    await page.goto(`/runs/${runId}`);
    await expect(page.getByTestId('detail-loading')).toBeVisible();
    release();
    await expect(page.getByTestId('detail-loading')).toBeHidden();
    await expect(page.getByRole('main').getByRole('heading', { level: 2 })).toBeVisible();
  });
});

test.describe('phone @mobile', () => {
  test.use({ storageState: authFile('olivia') });

  test('runs and credentials are cards with a sort menu on phones', async ({ page, apiAs }) => {
    await startRunApi(await apiAs('olivia'), PROCESS.healthCheck, { dryRun: true });
    await page.goto('/runs');
    await settle(page);
    const list = page.getByRole('list', { name: 'Runs' });
    await expect(list.getByRole('listitem').first()).toBeVisible();
    await expect(page.getByRole('main').locator('table')).toHaveCount(0);
    await expect(page.getByTestId('list-sort')).toBeVisible();
    await expectNoHorizontalScroll(page);

    await page.goto('/credentials');
    await settle(page);
    await expect(page.getByRole('main').locator('table')).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    // the footer stays, smaller, with all its parts
    await expect(page.locator('footer')).toContainText('Metropolregion Nürnberg');
    await expect(page.locator('footer')).toContainText(`${BRAND.name} 0.`);
  });
});
