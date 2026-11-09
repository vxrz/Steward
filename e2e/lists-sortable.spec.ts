import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile, PROCESS } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { expectNoHorizontalScroll, json, platformId, uniq } from './support/helpers';

/**
 * 0.13: systems, services, schedules, triggers, document types, person reviews and the access reconciliation are
 * sortable lists (DataTable) with their filters in the address and cards on phones.
 */
test.use({ storageState: authFile('admin') });

const collate = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true });

/** Two systems, two services, two schedules and two webhook triggers whose names start with `tag` (one of each inactive). */
async function createLists(api: APIRequestContext, tag: string) {
  const hub = await platformId(api, 'insights-hub');
  const systems = [
    await json<{ id: string }>(await api.post('/api/systems', { data: { name: `${tag} sys 10`, kind: 'server' } })),
    await json<{ id: string }>(await api.post('/api/systems', { data: { name: `${tag} sys 2`, kind: 'vm' } })),
  ];
  const services = [
    await json<{ id: string }>(await api.post('/api/services', { data: { name: `${tag} svc Kiln`, criticality: 'high', owners: [] } })),
    await json<{ id: string }>(await api.post('/api/services', { data: { name: `${tag} svc anvil`, criticality: 'low', owners: [] } })),
  ];
  // once a year at night: never fires during the tests
  const schedules = [
    await json<{ id: string }>(
      await api.post('/api/schedules', {
        data: { name: `${tag} sched b`, processId: PROCESS.healthCheck, cron: '17 3 1 1 *', timezone: 'UTC', bindings: { hub }, enabled: true },
      }),
    ),
    await json<{ id: string }>(
      await api.post('/api/schedules', {
        data: { name: `${tag} sched a`, processId: PROCESS.healthCheck, cron: '17 3 1 1 *', timezone: 'UTC', bindings: { hub }, enabled: false },
      }),
    ),
  ];
  const triggers = [
    (
      await json<{ trigger: { id: string } }>(
        await api.post('/api/triggers', { data: { name: `${tag} hook b`, processId: PROCESS.healthCheck, bindings: { hub } } }),
      )
    ).trigger,
    (
      await json<{ trigger: { id: string } }>(
        await api.post('/api/triggers', {
          data: { name: `${tag} hook a`, processId: PROCESS.healthCheck, bindings: { hub }, enabled: false, authMode: 'hmac' },
        }),
      )
    ).trigger,
  ];
  return async () => {
    for (const s of systems) await api.delete(`/api/systems/${s.id}`);
    for (const s of services) await api.post(`/api/services/${s.id}/archive`, { data: { archived: true } });
    for (const s of schedules) await api.delete(`/api/schedules/${s.id}`);
    for (const tr of triggers) await api.delete(`/api/triggers/${tr.id}`);
  };
}

/** The texts of the first link (or bold name) in each row's name cell. */
const namesIn = (page: Page, table: string, column = 1) =>
  page
    .getByRole('table', { name: table })
    .locator(`tbody tr td:nth-child(${column})`)
    .evaluateAll((cells) => cells.map((c) => (c.querySelector('a, p') as HTMLElement | null)?.innerText.trim() ?? ''));

test.describe('lists as sortable tables', () => {
  test('systems and services: sorted by name, remembered, filters in the address', async ({ page, apiAs }) => {
    const api = await apiAs('admin');
    const tag = uniq('E2E list');
    const cleanup = await createLists(api, tag);
    try {
      await page.goto(`/systems?q=${encodeURIComponent(tag)}`);
      await settle(page);
      await expect(page.getByRole('searchbox', { name: 'Search' })).toHaveValue(tag);
      const systems = page.getByRole('table', { name: 'Systems' });
      const name = systems.getByRole('columnheader', { name: 'Name' });
      await expect(name).toHaveAttribute('aria-sort', 'ascending');
      // locale-aware with numbers: 2 before 10
      await expect.poll(() => namesIn(page, 'Systems')).toEqual([`${tag} sys 2`, `${tag} sys 10`]);
      await name.getByRole('button').click();
      await expect(name).toHaveAttribute('aria-sort', 'descending');
      await expect.poll(() => namesIn(page, 'Systems')).toEqual([`${tag} sys 10`, `${tag} sys 2`]);
      await expectAccessible(page, 'systems table');
      // remembered for this user
      await page.reload();
      await expect(systems.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'descending');
      // a filter from the address, and a filter chosen on the page goes into the address
      await page.goto(`/systems?q=${encodeURIComponent(tag)}&kind=vm`);
      await expect(systems.getByRole('row')).toHaveCount(2);
      await expect(systems).toContainText(`${tag} sys 2`);
      await page.getByTestId('system-filters').getByRole('combobox', { name: 'Kind' }).click();
      await page.getByRole('option', { name: 'Server' }).click();
      await expect(page).toHaveURL(/kind=server/);
      await expect(systems).toContainText(`${tag} sys 10`);

      await page.goto(`/services?q=${encodeURIComponent(tag)}`);
      await settle(page);
      const services = page.getByRole('table', { name: 'Services' });
      await expect(services.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'ascending');
      await expect.poll(() => namesIn(page, 'Services')).toEqual([`${tag} svc anvil`, `${tag} svc Kiln`]);
      // criticality sorts by severity, not by its label
      const criticality = services.getByRole('columnheader', { name: 'Criticality' });
      await criticality.getByRole('button').click();
      await criticality.getByRole('button').click();
      await expect(criticality).toHaveAttribute('aria-sort', 'descending');
      await expect.poll(() => namesIn(page, 'Services')).toEqual([`${tag} svc Kiln`, `${tag} svc anvil`]);
      await page.goto(`/services?q=${encodeURIComponent(tag)}&criticality=low`);
      await expect(services.getByRole('row')).toHaveCount(2);
      await expect(services).toContainText(`${tag} svc anvil`);
      await expectAccessible(page, 'services table');
    } finally {
      await cleanup();
    }
  });

  test('schedules and triggers: sortable, state filter in the address', async ({ page, apiAs }) => {
    const api = await apiAs('admin');
    const tag = uniq('E2E list');
    const cleanup = await createLists(api, tag);
    try {
      await page.goto(`/schedules?q=${encodeURIComponent(tag)}`);
      await settle(page);
      const schedules = page.getByRole('table', { name: 'Schedules' });
      await expect(schedules.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'ascending');
      await expect.poll(() => namesIn(page, 'Schedules', 2)).toEqual([`${tag} sched a`, `${tag} sched b`]);
      const next = schedules.getByRole('columnheader', { name: 'Next run' });
      await next.getByRole('button').click();
      await expect(next).toHaveAttribute('aria-sort', 'ascending');
      // the inactive schedule has no next run: it comes last
      await expect.poll(() => namesIn(page, 'Schedules', 2)).toEqual([`${tag} sched b`, `${tag} sched a`]);
      await expectAccessible(page, 'schedules table');
      await page.goto(`/schedules?q=${encodeURIComponent(tag)}&state=inactive`);
      await expect(schedules.getByRole('row')).toHaveCount(2);
      await expect(schedules).toContainText(`${tag} sched a`);

      await page.goto(`/triggers?q=${encodeURIComponent(tag)}`);
      await settle(page);
      const triggers = page.getByRole('table', { name: 'Triggers' });
      await expect(triggers.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'ascending');
      await expect.poll(() => namesIn(page, 'Triggers', 2)).toEqual([`${tag} hook a`, `${tag} hook b`]);
      await triggers.getByRole('columnheader', { name: 'Name' }).getByRole('button').click();
      await expect.poll(() => namesIn(page, 'Triggers', 2)).toEqual([`${tag} hook b`, `${tag} hook a`]);
      await expectAccessible(page, 'triggers table');
      await page.goto(`/triggers?q=${encodeURIComponent(tag)}&state=active`);
      await expect(triggers.getByRole('row')).toHaveCount(2);
      await expect(triggers).toContainText(`${tag} hook b`);
      await page.goto(`/triggers?q=${encodeURIComponent(tag)}&auth=hmac`);
      await expect(triggers.getByRole('row')).toHaveCount(2);
      await expect(triggers).toContainText(`${tag} hook a`);
    } finally {
      await cleanup();
    }
  });

  test('document types, person reviews and the access reconciliation: sortable, newest first', async ({ page, apiAs }) => {
    await page.goto('/records/types');
    await settle(page);
    const types = page.getByRole('table', { name: 'Document types' });
    await expect(types.getByRole('columnheader', { name: 'Key' })).toHaveAttribute('aria-sort', 'ascending');
    const keys = await types.locator('tbody tr td:first-child').allInnerTexts();
    expect(keys.length).toBeGreaterThan(2);
    expect(keys).toEqual([...keys].sort(collate));
    await expectAccessible(page, 'document types');

    const api = await apiAs('admin');
    const hub = await platformId(api, 'insights-hub');
    const check = await json<{ id: string }>(
      await api.post('/api/compliance/access-checks', {
        data: { name: uniq('E2E list check'), platformId: hub, source: 'insights-hub', cron: '0 5 * * *', timezone: 'UTC' },
      }),
    );
    await json(await api.post(`/api/compliance/access-checks/${check.id}/run`, { data: {} })); // baseline
    await json(await api.post('/api/compliance/demo/simulate-change', { data: { accessCheckId: check.id } }));
    await page.goto(`/compliance/reconciliation?check=${check.id}`);
    await settle(page);
    const findings = page.getByRole('table', { name: 'Findings' });
    await expect(findings.getByRole('columnheader', { name: 'Between' })).toHaveAttribute('aria-sort', 'descending');
    await expect(findings.getByRole('row')).toHaveCount(2);
    await page.getByRole('tab', { name: 'Snapshots' }).click();
    const snapshots = page.getByRole('table', { name: 'Snapshots' });
    await expect(snapshots.getByRole('columnheader', { name: 'Taken at' })).toHaveAttribute('aria-sort', 'descending');
    const taken = await snapshots.locator('tbody tr').count();
    expect(taken).toBeGreaterThan(1);
    await expectAccessible(page, 'access reconciliation');

    const title = uniq('E2E list review');
    await json(
      await api.post('/api/compliance/person-reviews', {
        data: { title, personName: 'Imke Imaginary', identifiers: ['imke.imaginary@example.com'], checkIds: [check.id] },
      }),
    );
    await page.goto(`/compliance/person-reviews?q=${encodeURIComponent(title)}`);
    await settle(page);
    const reviews = page.getByRole('table', { name: 'Person reviews' });
    await expect(reviews.getByRole('columnheader', { name: 'Started' })).toHaveAttribute('aria-sort', 'descending');
    await expect(reviews.getByRole('link', { name: title })).toBeVisible();
    await expectAccessible(page, 'person reviews');
    await page.goto(`/compliance/person-reviews?q=${encodeURIComponent(title)}&status=closed`);
    await expect(page.getByText('No person review matches the filters.')).toBeVisible();
    await page.goto(`/compliance/person-reviews?q=${encodeURIComponent(title)}&status=open`);
    await expect(reviews.getByRole('link', { name: title })).toBeVisible();
  });
});

test.describe('lists on phones @mobile', () => {
  test('systems, services, schedules and triggers are cards with a sort menu', async ({ page, apiAs }) => {
    const api = await apiAs('admin');
    const tag = uniq('E2E list');
    const cleanup = await createLists(api, tag);
    try {
      for (const [path, label, name] of [
        ['/systems', 'Systems', `${tag} sys 2`],
        ['/services', 'Services', `${tag} svc anvil`],
        ['/schedules', 'Schedules', `${tag} sched a`],
        ['/triggers', 'Triggers', `${tag} hook a`],
      ] as const) {
        await page.goto(`${path}?q=${encodeURIComponent(tag)}`);
        await settle(page);
        const list = page.getByRole('list', { name: label });
        await expect(list.getByRole('listitem'), path).toHaveCount(2);
        await expect(list.getByRole('listitem').first(), path).toContainText(name);
        await expect(page.getByRole('main').locator('table'), path).toHaveCount(0);
        await expect(page.getByTestId('list-sort'), path).toBeVisible();
        await expectNoHorizontalScroll(page);
      }
      await expectAccessible(page, 'trigger cards');
    } finally {
      await cleanup();
    }
  });
});
