import { test, expect } from './support/fixtures';
import { appHref, authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { json, uniq } from './support/helpers';

/** The service page as the hub of the catalogue (v0.4.0): one tab per part, each with its own address. */

test.use({ storageState: authFile('dana') });

test('the service hub has a tab for each part, with addresses that can be shared', async ({ page, apiAs }) => {
  const api = await apiAs('dana');
  const svc = await json<{ id: string; name: string }>(await api.post('/api/services', { data: { name: uniq('E2E hub service'), criticality: 'high' } }));
  const app = await json<{ id: string; name: string }>(await api.post('/api/applications', { data: { name: uniq('E2E hub app'), owners: [] } }));
  const sys = await json<{ id: string; name: string }>(await api.post('/api/systems', { data: { name: uniq('E2E hub system'), kind: 'server', owners: [] } }));
  try {
    await json(await api.put(`/api/services/${svc.id}/applications/${app.id}`, { data: { role: 'primary' } }));
    await json(await api.post(`/api/applications/${app.id}/systems`, { data: { systemId: sys.id, environment: 'Production', note: '' } }));

    // the address of the service is its overview
    await page.goto(`/services/${svc.id}`);
    await settle(page);
    const tabs = page.getByRole('navigation', { name: `Sections of ${svc.name}` });
    await expect(tabs.getByRole('link')).toHaveText([
      'Overview',
      'Applications1',
      'Systems',
      'Duties',
      'Objectives',
      'Maintenance',
      'Documents',
      'Tickets',
      'Scorecard',
    ]);
    await expect(tabs.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('protection-need')).toBeVisible();
    await expect(page.getByTestId('service-applications')).toHaveCount(0);
    await expectAccessible(page, 'service hub overview');

    // each tab has its address and shows the panel of before
    const cases: [string, string, string][] = [
      ['Applications', 'applications', 'service-applications'],
      ['Duties', 'duties', 'duties-panel'],
      ['Objectives', 'objectives', 'objectives-panel'],
      ['Maintenance', 'maintenance', 'maintenance-panel'],
      ['Documents', 'documents', 'service-documents'],
      ['Tickets', 'tickets', 'tickets-panel'],
      ['Scorecard', 'scorecard', 'scorecard-panel'],
    ];
    for (const [name, path, testId] of cases) {
      await tabs.getByRole('link', { name }).click();
      await expect(page, name).toHaveURL((u) => u.pathname.endsWith(`/services/${svc.id}/${path}`));
      await expect(page.getByTestId(testId), name).toBeVisible();
      await expect(tabs.getByRole('link', { name })).toHaveAttribute('aria-current', 'page');
    }
    await expect(page.getByTestId('service-applications')).toHaveCount(0);

    // Systems: what the service's applications run on, with the way to the application
    await tabs.getByRole('link', { name: 'Systems' }).click();
    const systems = page.getByTestId('service-systems');
    const row = systems.getByRole('row').filter({ hasText: sys.name });
    await expect(row).toContainText('Production');
    await expect(row.getByRole('link', { name: sys.name })).toHaveAttribute('href', appHref(`/systems/${sys.id}`));
    await expect(row.getByRole('link', { name: app.name })).toHaveAttribute('href', appHref(`/applications/${app.id}`));
    await settle(page);
    await expectAccessible(page, 'service hub systems');

    // a deep link opens the tab directly; the browser's back button goes to the tab before
    await page.goto(`/services/${svc.id}/duties`);
    await expect(page.getByTestId('duties-panel')).toBeVisible();
    await page
      .getByRole('navigation', { name: `Sections of ${svc.name}` })
      .getByRole('link', { name: 'Tickets' })
      .click();
    await expect(page.getByTestId('tickets-panel')).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL((u) => u.pathname.endsWith(`/services/${svc.id}/duties`));
  } finally {
    await api.delete(`/api/services/${svc.id}`);
    await api.delete(`/api/systems/${sys.id}`).catch(() => undefined);
  }
});

test.describe('on a phone @mobile', () => {
  test.use({ storageState: authFile('dana') });
  test('the tabs scroll sideways instead of widening the page @mobile', async ({ page, apiAs }) => {
    const api = await apiAs('dana');
    const svc = await json<{ id: string; name: string }>(await api.post('/api/services', { data: { name: uniq('E2E hub phone') } }));
    try {
      await page.goto(`/services/${svc.id}`);
      await settle(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await page.getByTestId('service-tab-scorecard').scrollIntoViewIfNeeded();
      await page.getByTestId('service-tab-scorecard').tap();
      await expect(page).toHaveURL((u) => u.pathname.endsWith(`/services/${svc.id}/scorecard`));
    } finally {
      await api.delete(`/api/services/${svc.id}`);
    }
  });
});
