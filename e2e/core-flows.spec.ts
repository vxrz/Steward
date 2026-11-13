import { test, expect } from './support/fixtures';
import { authFile, PROCESS } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { expectNoHorizontalScroll, json, startRunApi, uniq, waitForRun } from './support/helpers';

/**
 * Core task flows of 0.11 (the 0.10 UX review, U5–U9, U11, U15, U16): processes, platforms and dashboards as sortable
 * tables, "New process" asks first, the wider process canvas, the notification centre's groups, the run list sorted
 * by the server, forms that say what is missing, and a demo whose service pages have content.
 */
test.use({ storageState: authFile('admin') });

test.describe('lists as tables (U6)', () => {
  test('processes: sortable, filters in the address, compact, a remembered card view', async ({ page }) => {
    await page.goto('/processes');
    await settle(page);
    const table = page.getByRole('table', { name: 'Processes' });
    await expect(table).toBeVisible();
    const name = table.getByRole('columnheader', { name: 'Process' });
    await expect(name).toHaveAttribute('aria-sort', 'ascending');
    const names = () => table.locator('tbody tr td:first-child a').allInnerTexts();
    const asc = await names();
    expect(asc.length).toBeGreaterThan(40);
    expect(asc).toEqual([...asc].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true })));
    await name.getByRole('button').click();
    await expect(name).toHaveAttribute('aria-sort', 'descending');
    expect(await names()).toEqual([...asc].reverse());
    // compact rows (about 66 px; the cards of before took about 80 px, 4,400 px for 54 processes); per row, so processes other specs add meanwhile don't count
    const rowHeight = await table.locator('tbody').evaluate((b) => b.getBoundingClientRect().height / b.querySelectorAll('tr').length);
    expect(rowHeight).toBeLessThan(72);
    await expectAccessible(page, 'processes table');

    // the sort order is remembered
    await page.reload();
    await expect(table.getByRole('columnheader', { name: 'Process' })).toHaveAttribute('aria-sort', 'descending');

    // filters live in the address: search and the outcome of the last run
    await page.goto('/processes?q=health&last=never');
    await expect(page.getByRole('searchbox', { name: 'Search' })).toHaveValue('health');
    await page.goto('/processes?q=health+check');
    await expect(table.getByRole('link', { name: 'Insights Hub – Platform health check' })).toBeVisible();
    await page.getByTestId('process-filters').locator('.mantine-MultiSelect-input').click();
    await page.getByRole('option', { name: 'Never run' }).click();
    await expect(page).toHaveURL(/last=never/);

    // the card view, remembered for this user
    await page.goto('/processes');
    await page.getByTestId('list-view-processes').locator('label').nth(1).click();
    await expect(page.getByRole('list', { name: 'Processes' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('list', { name: 'Processes' })).toBeVisible();
    await page.getByTestId('list-view-processes').locator('label').first().click();
    await expect(table).toBeVisible();
  });

  test('platforms and dashboards: sortable tables with filters in the address', async ({ page }) => {
    await page.goto('/platforms?test=never');
    await settle(page);
    const platforms = page.getByRole('table', { name: 'Platforms' });
    await expect(platforms).toBeVisible();
    await expect(platforms.getByRole('columnheader', { name: 'Connection test' })).toBeVisible();
    await expect(platforms.getByRole('link', { name: 'Insights Hub (demo)' })).toBeVisible();
    await platforms.getByRole('columnheader', { name: 'Kind' }).getByRole('button').click();
    await expect(platforms.getByRole('columnheader', { name: 'Kind' })).toHaveAttribute('aria-sort', 'ascending');
    await expectAccessible(page, 'platforms table');

    await page.goto('/dashboards?q=access');
    const dashboards = page.getByRole('table', { name: 'Dashboards' });
    await expect(dashboards.getByRole('link', { name: 'Access governance' })).toBeVisible();
    await expect(dashboards.getByRole('link', { name: 'Edge fleet' })).toHaveCount(0);
    await dashboards.getByRole('columnheader', { name: 'Updated' }).getByRole('button').click();
    await expect(dashboards.getByRole('columnheader', { name: 'Updated' })).toHaveAttribute('aria-sort', 'ascending');
  });
});

test.describe('lists on phones (U6) @mobile', () => {
  test('processes, platforms and dashboards are cards with a sort menu', async ({ page }) => {
    for (const [path, label] of [
      ['/processes', 'Processes'],
      ['/platforms', 'Platforms'],
      ['/dashboards', 'Dashboards'],
    ] as const) {
      await page.goto(path);
      await settle(page);
      await expect(page.getByRole('list', { name: label }), path).toBeVisible();
      await expect(page.getByTestId('list-sort'), path).toBeVisible();
      await expectNoHorizontalScroll(page);
    }
  });
});

test('"New process" asks first and saves nothing until confirmed (U7, U16)', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const before = (await json<{ id: string }[]>(await api.get('/api/processes'))).length;
  await page.goto('/processes');
  await page.getByRole('button', { name: 'New process' }).click();
  const dialog = page.getByRole('dialog', { name: 'New process' });
  // the button stays enabled: a submit without a name says what is missing
  const create = dialog.getByRole('button', { name: 'Create and edit' });
  await expect(create).toBeEnabled();
  await create.click();
  await expect(dialog.getByRole('textbox', { name: /^Name/ })).toHaveAttribute('aria-invalid', 'true');
  await expect(dialog.getByText('Required')).toBeVisible();
  await expectAccessible(page, 'new process dialog with errors');
  // cancelling saves nothing
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect((await json<unknown[]>(await api.get('/api/processes'))).length).toBe(before);

  // the id follows the name until it is changed; a wrong id is explained
  await page.getByRole('button', { name: 'New process' }).click();
  const name = uniq('E2E restore test');
  await dialog.getByRole('textbox', { name: /^Name/ }).fill(name);
  const id = dialog.getByRole('textbox', { name: /^ID/ });
  await expect(id).toHaveValue(name.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  await id.fill('Not valid!');
  await create.click();
  await expect(dialog.getByText(/Use lower-case letters, digits and dashes/)).toBeVisible();
  const chosen = `e2e-restore-${Date.now().toString(36)}`;
  await id.fill(chosen);
  await dialog.getByRole('textbox', { name: 'Description' }).fill('Restores the shop database into a test instance.');
  // from a template
  await dialog.getByText('From a template').click();
  await create.click();
  await expect(dialog.getByRole('combobox', { name: /^Template/ })).toHaveAttribute('aria-invalid', 'true');
  await dialog.getByRole('combobox', { name: /^Template/ }).fill('Platform health check');
  await page.getByRole('option', { name: 'Insights Hub – Platform health check' }).click();
  await create.click();
  await expect(page).toHaveURL(new RegExp(`/processes/${chosen}$`));
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  const saved = await json<{ description: string; definition: { nodes: unknown[] } }>(await api.get(`/api/processes/${chosen}`));
  expect(saved.description).toBe('Restores the shop database into a test instance.');
  expect(saved.definition.nodes.length).toBeGreaterThan(1);

  // the same id again is refused on the field
  await page.goto('/processes');
  await page.getByRole('button', { name: 'New process' }).click();
  await dialog.getByRole('textbox', { name: /^Name/ }).fill(uniq('E2E other'));
  await dialog.getByRole('textbox', { name: /^ID/ }).fill(chosen);
  await create.click();
  await expect(dialog.getByText(new RegExp(`A process with the id “${chosen}” exists already`))).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

test('the process canvas is wider: the side panels fold and stay folded (U8)', async ({ page }) => {
  await page.goto(`/processes/${PROCESS.accessReview1}`);
  await settle(page);
  const canvas = page.locator('.react-flow').first();
  await expect(canvas).toBeVisible();
  const narrow = (await canvas.boundingBox())!.width;
  // nothing selected: the properties panel is a thin strip unless kept open
  await expect(page.getByTestId('flow-properties-strip')).toBeVisible();
  const fold = page.getByRole('button', { name: 'Fold the steps panel' });
  await fold.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('flow-palette-strip')).toBeVisible();
  const wide = (await canvas.boundingBox())!.width;
  expect(wide).toBeGreaterThan(narrow);
  expect(wide).toBeGreaterThan(1000);
  // remembered for this user
  await page.reload();
  await expect(page.getByTestId('flow-palette-strip')).toBeVisible();
  // selecting a step opens its properties; the help panel can be kept open
  await page.locator('.react-flow__node').filter({ hasText: 'Resolve API paths' }).click();
  await expect(page.getByTestId('flow-properties')).toBeVisible();
  await page.getByRole('button', { name: 'Show the steps panel' }).click();
  await expect(page.getByRole('textbox', { name: 'Search nodes' })).toBeVisible();
  await expectAccessible(page, 'process editor with folded panels');
});

test('notification centre: decisions first, groups by kind, a group marked read (U9)', async ({ loginAs, apiAs }) => {
  // olivia's dry run waits for adam's decision
  const olivia = await apiAs('olivia');
  const runId = await startRunApi(olivia, PROCESS.accessReview1, { dryRun: true });
  const adam = await loginAs('adam');
  await adam.goto('/');
  await expect
    .poll(async () => {
      const list = await json<{ items: { event: string; link?: string }[] }>(await (await apiAs('adam')).get('/api/notifications'));
      return list.items.some((n) => n.event === 'task.assigned' && n.link?.includes(runId));
    })
    .toBe(true);
  await adam.reload();
  await adam.getByRole('button', { name: /^Notifications/ }).click();
  const drawer = adam.getByRole('dialog', { name: /Notifications/ });
  const groups = drawer.locator('section[data-category]');
  await expect(groups.first()).toHaveAttribute('data-category', 'decision');
  await expect(drawer.getByRole('region', { name: 'Decision', exact: true })).toBeVisible();
  // the filter: decisions only, then unread only
  await drawer
    .getByTestId('notification-filter')
    .getByText(/^Decisions? \d+/)
    .click();
  for (const c of await groups.evaluateAll((l) => l.map((x) => x.getAttribute('data-category')))) expect(c).toBe('decision');
  await drawer
    .getByTestId('notification-filter')
    .getByText(/^(All|Latest) \d+/)
    .click();
  await drawer.getByRole('switch', { name: 'Unread only' }).check();
  // mark one group read
  const group = drawer.getByRole('region', { name: 'Decision', exact: true });
  await group.getByRole('button', { name: 'Mark read: Decision' }).click();
  await expect(group).toBeHidden();
  await expectAccessible(adam, 'notification centre');
  // leave no waiting decision behind for the other tests (a task badge changes the sidebar's link names)
  await json(await (await apiAs('admin')).post(`/api/runs/${runId}/cancel`, { data: { reason: 'E2E cleanup' } }));
  await waitForRun(olivia, runId, ['cancelled']);
});

test('notification centre: a full list says it holds the latest messages only', async ({ page }) => {
  // the bell loads the latest 50: with more unread than that, "All 50" next to "68 unread" was wrong
  await page.route(
    (url) => url.pathname.endsWith('/api/notifications'),
    (route) =>
      route.fulfill({
        json: {
          unread: 68,
          items: Array.from({ length: 50 }, (_, i) => ({
            id: `ntf_e2e_${i}`,
            ts: new Date(Date.now() - i * 60_000).toISOString(),
            event: 'run.failed',
            title: `Run ${i} failed`,
            body: '',
            read: false,
          })),
        },
      }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: /^Notifications/ }).click();
  const drawer = page.getByRole('dialog', { name: /Notifications/ });
  await expect(drawer.getByTestId('notification-filter')).toContainText('Latest 50');
  await expect(drawer.getByTestId('notification-filter')).not.toContainText('All 50');
  await expect(drawer.getByTestId('notifications-capped')).toHaveText('The latest 50 messages are listed here; older ones are not shown.');
});

test('runs are sorted by the server, and the order is remembered (U15)', async ({ page }) => {
  await page.goto('/runs');
  await settle(page);
  const table = page.getByRole('table', { name: 'Runs' });
  const duration = table.getByRole('columnheader', { name: 'Duration' });
  const [req] = await Promise.all([
    page.waitForRequest((r) => r.url().includes('/api/runs?') && r.url().includes('sort=duration')),
    duration.getByRole('button').click(),
  ]);
  expect(new URL(req.url()).searchParams.get('dir')).toBe('asc');
  await expect(duration).toHaveAttribute('aria-sort', 'ascending');
  const [req2] = await Promise.all([
    page.waitForRequest((r) => r.url().includes('sort=duration') && r.url().includes('dir=desc')),
    duration.getByRole('button').click(),
  ]);
  expect(req2).toBeTruthy();
  await expect(duration).toHaveAttribute('aria-sort', 'descending');
  await page.reload();
  await expect(table.getByRole('columnheader', { name: 'Duration' })).toHaveAttribute('aria-sort', 'descending');
  // back to the newest first
  const started = table.getByRole('columnheader', { name: 'Started' });
  await started.getByRole('button').click();
  await started.getByRole('button').click();
  await expect(started).toHaveAttribute('aria-sort', 'descending');
});

test('forms keep the button enabled and say what is missing (U16)', async ({ page }) => {
  await page.goto('/status-pages');
  await page.getByRole('button', { name: 'New status page' }).click();
  const dialog = page.getByRole('dialog', { name: 'New status page' });
  const save = dialog.getByRole('button', { name: 'Save' });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(dialog.getByRole('textbox', { name: /^Title/ })).toHaveAttribute('aria-invalid', 'true');
  await expect(dialog.getByText('Choose at least one')).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: /^Title/ })).toBeFocused();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

test.describe('the demo shows the service half (U5)', () => {
  test('scorecard, costs, the service hub and the Home tiles have content', async ({ page }) => {
    await page.goto('/scorecard');
    await settle(page);
    await expect(page.getByRole('link', { name: 'Online shop (demo)' }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Customer care (demo)' }).first()).toBeVisible();

    await page.goto('/costs');
    await expect(page.getByText('Online shop (demo)').first()).toBeVisible();

    await page.goto('/services');
    await page.getByRole('link', { name: 'Online shop (demo)' }).first().click();
    const tabs = page.getByRole('navigation', { name: /^Sections of Online shop/ });
    await expect(tabs.getByRole('link', { name: /^Applications\s*2$/ })).toBeVisible();
    await tabs.getByRole('link', { name: /^Duties/ }).click();
    await expect(page.getByTestId('duties-panel')).toContainText('Monthly access key review');
    await tabs.getByRole('link', { name: /^Objectives/ }).click();
    await expect(page.getByTestId('objectives-panel')).toContainText('Shop instances up');
    await tabs.getByRole('link', { name: /^Maintenance/ }).click();
    await expect(page.getByTestId('maintenance-panel')).toContainText('Shop database upgrade');
    await tabs.getByRole('link', { name: /^Documents/ }).click();
    await expect(page.getByTestId('service-documents')).toContainText('Operations manual – Online shop');
    await tabs.getByRole('link', { name: /^Tickets/ }).click();
    await expect(page.getByTestId('tickets-panel')).toContainText('PL-48213');
    await tabs.getByRole('link', { name: /^Scorecard/ }).click();
    await expect(page.getByTestId('scorecard-panel')).toBeVisible();
    await expectAccessible(page, 'demo service scorecard');

    await page.goto('/credentials');
    await expect(page.getByText('Shop order API client (demo)')).toBeVisible();
    await page.goto('/status-pages');
    await expect(page.getByText('Shop and customer care (demo)')).toBeVisible();

    // Home: the service tiles count, none says "not set up yet"
    await page.goto('/');
    await settle(page);
    const tiles = page.getByTestId('start-tiles');
    for (const label of ['Credentials due', 'Reviews due', 'Duties due', 'Services needing attention', 'Waiting on vendor tickets'])
      await expect(tiles.getByRole('link', { name: new RegExp(`^${label} \\d`) }), label).toBeVisible();
    await expect(page.getByText('Not set up yet')).toHaveCount(0);
  });

  test('the Check findings header wraps below its title on a phone (U11) @mobile', async ({ page }) => {
    await page.goto('/');
    await settle(page);
    const card = page.getByTestId('failed-checks');
    await expect(card).toBeVisible();
    const title = card.getByRole('heading', { name: 'Check findings' });
    const counts = card.getByTestId('failed-checks-counts');
    const t = (await title.boundingBox())!;
    const c = (await counts.boundingBox())!;
    // one line for the title (counted from its text, not its height: the toggle button around it has a 24 px target),
    // the counts below it starting at the title's left edge
    const titleLines = await title.evaluate((el) => {
      // the line boxes of the heading's text only (its chevron icon sits at another height)
      const tops: number[] = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) if (r.width > 0 && !tops.some((y) => Math.abs(y - r.top) < 4)) tops.push(r.top);
      }
      return tops.length;
    });
    expect(titleLines).toBe(1);
    expect(c.y).toBeGreaterThanOrEqual(t.y + t.height - 2);
    expect(Math.abs(c.x - t.x)).toBeLessThan(4);
    await expectNoHorizontalScroll(page);
  });
});
