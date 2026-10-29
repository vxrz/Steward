import { test, expect } from './support/fixtures';
import { PROCESS, authFile, appHref } from './support/env';
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

  test('start page: nine tiles of what needs attention, each opening its filtered list', async ({ page, apiAs }) => {
    // a ticket waiting for a vendor since 12 days, so that tile needs attention
    const number = uniq('VEND');
    const openedAt = new Date(Date.now() - 12 * 86400000).toISOString();
    await json(
      await (
        await apiAs('olivia')
      ).post('/api/ticket-references', {
        data: { source: 'vendor', externalNumber: number, title: 'Firmware bug in the edge runtime', status: 'waitingVendor', openedAt },
      }),
    );
    await page.goto('/');
    await settle(page);
    const tiles = page.getByTestId('start-tiles');
    const links = tiles.getByRole('link');
    await expect(links).toHaveCount(9);
    // the approved order; every link names its label and number
    const names = await links.evaluateAll((l) => l.map((a) => a.getAttribute('aria-label') ?? ''));
    expect(names.map((n) => n.replace(/: .*/, ''))).toEqual([
      'Waiting for you',
      'Failed runs (24 h)',
      'Monitors down',
      'Credentials due',
      'Undocumented access changes',
      'Reviews due',
      'Duties due',
      'Services needing attention',
      'Waiting on vendors',
    ]);
    for (const n of names) expect(n).toMatch(/^[^:]+: \d+ – .+/);
    expect(await links.evaluateAll((l) => l.map((a) => a.getAttribute('href')))).toEqual(
      [
        '/tasks',
        '/runs?status=failed&within=24h',
        '/monitors?status=down,degraded',
        '/credentials?status=expired,overdue,dueSoon',
        '/compliance/reconciliation?findings=open',
        '/records?workflow=document&review=overdue,dueSoon',
        '/duties?level=mandatory&status=attention',
        '/scorecard?attention=1',
        '/tickets?waiting=vendor',
      ].map(appHref),
    );
    const vendor = tiles.getByRole('link', { name: /^Waiting on vendors: [1-9]\d* – oldest \d+ days$/ });
    await expect(vendor).toHaveAttribute('data-state', 'attention');
    // keyboard: the tiles are in the tab order
    await links.nth(7).focus();
    await page.keyboard.press('Tab');
    await expect(vendor).toBeFocused();
    await expectAccessible(page, 'start page tiles');

    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/tickets\?waiting=vendor$/);
    await expect(page.getByTestId('filter-waiting-vendor')).toBeVisible();
    await expect(page.getByRole('link', { name: number, exact: true }).first()).toBeVisible();

    await page.goto('/');
    await tiles.getByRole('link', { name: /^Monitors down/ }).click();
    await expect(page).toHaveURL(/\/monitors\?status=down,degraded$/);
    const filter = page.getByRole('group', { name: 'Filter by status' });
    await expect(filter.getByRole('button', { pressed: true })).toHaveCount(2);

    await page.goto('/runs?status=failed&within=24h');
    await expect(page.getByRole('textbox', { name: 'Started' })).toHaveValue('Last 24 hours');
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

test.describe('start page zero state (viewer)', () => {
  test.use({ storageState: authFile('vera') });

  test('a quiet day: green zeros with a check, and no tiles the viewer has no right for', async ({ page, apiAs }) => {
    // vera may read no access check and owns no credential: the server leaves those tiles out
    const real = await json(await (await apiAs('vera')).get('/api/dashboard'));
    expect(Object.keys(real.attention).sort()).toEqual(['monitors', 'runs', 'tasks', 'vendorTickets']);
    // the shared demo server's counts change with the other tests, so answer with a quiet day
    await page.route('**/api/dashboard', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      body.attention = { tasks: 0, runs: { failed: 0, total: 3 }, monitors: { down: 0, degraded: 0 }, vendorTickets: { open: 0, oldestDays: null } };
      await route.fulfill({ response: res, json: body });
    });
    await page.goto('/');
    await settle(page);
    const tiles = page.getByTestId('start-tiles');
    await expect(tiles.getByRole('link')).toHaveCount(4);
    await expect(tiles.locator('[data-state="quiet"]')).toHaveCount(4);
    await expect(tiles.getByRole('link', { name: 'Waiting for you: 0 – All quiet' })).toBeVisible();
    await expect(tiles.getByRole('link', { name: 'Failed runs (24 h): 0 – All quiet · 3 runs' })).toBeVisible();
    await expect(tiles.getByRole('link', { name: 'Monitors down: 0 – All quiet' })).toBeVisible();
    await expect(tiles.getByRole('link', { name: 'Waiting on vendors: 0 – All quiet' })).toBeVisible();
    await expect(tiles.getByText(/Undocumented access changes|Credentials due/)).toHaveCount(0);
    await expectAccessible(page, 'start page zero state');
    // the start page refreshes the counts in the background: let a refresh still in the handler end quietly
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });
});

test.describe('phone @mobile', () => {
  test.use({ storageState: authFile('olivia') });

  test('start page tiles: two balanced columns at 390 px', async ({ page }) => {
    await page.goto('/');
    await settle(page);
    const links = page.getByTestId('start-tiles').getByRole('link');
    await expect(links).toHaveCount(7);
    const boxes = await Promise.all([0, 1, 2, 5, 6].map(async (i) => (await links.nth(i).boundingBox())!));
    expect(Math.round(boxes[0]!.y)).toBe(Math.round(boxes[1]!.y));
    expect(boxes[2]!.y).toBeGreaterThan(boxes[0]!.y);
    expect(Math.round(boxes[3]!.width)).toBe(Math.round(boxes[0]!.width));
    // seven tiles: the last one takes the whole row
    expect(boxes[4]!.width).toBeGreaterThan(boxes[0]!.width * 1.5);
    await expectNoHorizontalScroll(page);
  });

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
    // the footer is on the About page only (#140), with all its parts on phones too
    await expect(page.locator('footer')).toHaveCount(0);
    await page.goto('/about');
    await expect(page.locator('footer')).toContainText('Metropolregion Nürnberg');
    await expect(page.locator('footer')).toContainText(`${BRAND.name} 0.`);
    await expectNoHorizontalScroll(page);
  });
});
