import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible } from './support/axe';
import { expectNoHorizontalScroll, json, platformId, uniq } from './support/helpers';

test.use({ storageState: authFile('admin') });

/**
 * Access lists became shares (0.23.0, ADR 0033 phase 2): the Access tab replaces the access-list editors of processes,
 * platforms, identities and monitors – a migrated entry no level expresses shows as Custom, a process's and a
 * monitor's owner is changed above the tab, a platform offers View and Manage with "use".
 */

test('a process: its access list is shares with a Custom one, the owner above the tab', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const proc = await json<{ id: string }>(
    await api.post('/api/processes', { data: { definition: { name: uniq('Invented shared process'), nodes: [{ id: 'start', type: 'start', x: 0, y: 0 }] } } }),
  );
  try {
    // the deprecated route still takes a list: written as shares, the item Restricted
    const res = await api.put(`/api/processes/${proc.id}/access`, {
      data: {
        acl: [
          { subject: 'user:vera', permissions: ['view', 'manage'] },
          { subject: 'role:operator', permissions: ['view', 'run'] },
        ],
      },
    });
    expect(res.ok(), await res.text()).toBe(true);
    expect(res.headers()['deprecation']).toBe('true');
    await page.goto(`/processes/${proc.id}`);
    await page.getByRole('tab', { name: 'Access' }).click();
    await expect(page.getByTestId('owner-field')).toBeVisible();
    const panel = page.getByTestId('shares-panel');
    await expect(panel.getByTestId('shares-scope')).toContainText('Restricted');
    await expect(panel.getByTestId('share-row')).toHaveCount(2);
    // the owner of a Restricted item without owning teams: not "outside the owning teams" – there are none
    await expect(panel.getByTestId('shares-implied')).toContainText('gives access to a Restricted item');
    await expect(panel.getByTestId('shares-implied')).not.toContainText('outside the owning teams');
    await expect(panel.getByTestId('share-custom')).toHaveText(/^Custom: manage, view/);
    await expectAccessible(page, 'process access tab with shares');

    // changing the Custom share replaces it with its level; reset brings it back
    const vera = panel.getByTestId('share-row').filter({ has: page.getByTestId('share-custom') });
    // a Custom share has no level: its level field says Custom, not View
    await expect(vera.getByRole('combobox', { name: /^Level for / })).toHaveValue('');
    await expect(vera.getByRole('combobox', { name: /^Level for / })).toHaveAttribute('placeholder', 'Custom');
    await vera.getByRole('combobox', { name: /^Level for / }).click();
    await page.getByRole('option', { name: 'Edit' }).click();
    await expect(panel.getByTestId('share-custom')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Reset' }).click();
    await expect(panel.getByTestId('share-custom')).toHaveCount(1);

    // removing the role's share narrows: the preview says who loses what, no step-up
    await panel.getByRole('button', { name: /^Remove the share with Everyone with role operator/ }).click();
    // the focus stays in the panel (its heading), not on the page's body
    await expect(panel.getByRole('heading', { name: 'Shared with' })).toBeFocused();
    await panel.getByRole('button', { name: 'Save shares' }).click();
    const preview = page.getByRole('dialog', { name: 'Before you save' });
    await expect(preview).toContainText('loses');
    await preview.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Shares saved')).toBeVisible();
    const after = await json<{ shares: { subject: string; rights?: string[] | null }[] }>(await api.get(`/api/access/process/${proc.id}/shares`));
    expect(after.shares).toEqual([expect.objectContaining({ subject: 'user:vera', rights: ['manage', 'view'] })]);

    // the phone layout
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panel.getByTestId('share-row')).toHaveCount(1);
    // a card: the level and the end date side by side under the name, within the screen
    const card = panel.getByTestId('share-row').first();
    const level = await card.getByRole('combobox', { name: /^Level for / }).boundingBox();
    const until = await card.getByLabel(/^End date for /).boundingBox();
    expect(Math.abs(level!.y - until!.y)).toBeLessThan(4);
    expect(until!.x + until!.width).toBeLessThanOrEqual(390);
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'process access tab (phone)');
  } finally {
    await api.delete(`/api/processes/${proc.id}`);
  }
});

test('a platform offers View and Manage with "use"; a monitor shows its owner above the tab', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const id = await platformId(api, 'insights-hub');
  await page.goto(`/platforms/${id}`);
  await page.getByRole('tab', { name: 'Access' }).click();
  const panel = page.getByTestId('shares-panel');
  await expect(panel.getByRole('heading', { name: 'Shared with' })).toBeVisible();
  // a new share: View or Manage – Edit is not offered on a platform
  await panel.getByRole('combobox', { name: 'Share with' }).click();
  await page.keyboard.type('vera');
  await page.getByRole('option', { name: /\(vera\)/ }).click();
  await panel.getByRole('combobox', { name: 'Level of the new share' }).click();
  await expect(page.getByRole('option', { name: 'View' })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Manage' })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Edit' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expectAccessible(page, 'platform access tab');
  // nothing is saved (other tests use this platform)

  const monitors = await json<{ items?: { id: string }[] } | { id: string }[]>(await api.get('/api/monitors'));
  const monitor = (Array.isArray(monitors) ? monitors : (monitors.items ?? []))[0]!;
  await page.goto(`/monitors/${monitor.id}`);
  await page.getByRole('tab', { name: 'Access' }).click();
  await expect(page.getByTestId('owner-field').getByRole('combobox', { name: 'Owner' })).not.toHaveValue('');
  await expect(page.getByTestId('shares-panel')).toBeVisible();
  await expectAccessible(page, 'monitor access tab');
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalScroll(page);
});

test('a dashboard and a data contract have the Access section; a contract share offers "relax the breaking-change rule"', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const boards = await json<{ id: string }[]>(await api.get('/api/dashboards'));
  await page.goto(`/dashboards/${boards[0]!.id}`);
  await expect(page.getByTestId('access-tab').getByTestId('shares-panel')).toBeVisible();
  await expectAccessible(page, 'dashboard access section');

  await page.goto('/data-contracts');
  await page.getByRole('link', { name: 'Shop orders' }).first().click();
  const panel = page.getByTestId('shares-panel');
  await expect(panel).toBeVisible();
  // a new share (nothing is saved): the contract's action rights beside the level
  await panel.getByRole('combobox', { name: 'Share with' }).click();
  await page.keyboard.type('vera');
  await page.getByRole('option', { name: /\(vera\)/ }).click();
  await panel.getByRole('button', { name: 'Add', exact: true }).click();
  const row = panel.getByTestId('share-row').filter({ hasText: /vera/i });
  // the new share's level field has the focus (the Add button is disabled again)
  await expect(row.getByRole('combobox', { name: /^Level for / })).toBeFocused();
  // labels in sentence case (the rights' names are lower case for running text)
  await expect(row.getByRole('checkbox', { name: 'Relax the breaking-change rule', exact: true })).toBeVisible();
  await expect(row.getByRole('checkbox', { name: 'Test', exact: true })).toBeVisible();
  await expectAccessible(page, 'data contract access section');
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalScroll(page);
});
