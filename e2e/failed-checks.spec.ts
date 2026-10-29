import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { json, startRunApi, uniq, waitForRun } from './support/helpers';

/** The start page's failed checks (#138): one entry per process and check, collapsible, remembered per user. */

test.use({ storageState: authFile('admin') });

test('failed checks are grouped per check and the card folds and stays folded', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const name = uniq('E2E failing check');
  const proc = await json(
    await api.post('/api/processes', {
      data: {
        definition: {
          name,
          nodes: [
            { id: 'start', type: 'start', x: 0, y: 0 },
            {
              id: 'c',
              type: 'check',
              x: 0,
              y: 0,
              name: `${name} – endpoints healthy`,
              condition: 'false',
              severity: 'error',
              message: 'Historian API, MES frontend down',
            },
          ],
          wires: [{ from: 'start', port: 'out', to: 'c' }],
        },
      },
    }),
  );
  try {
    for (let i = 0; i < 3; i++) await waitForRun(api, await startRunApi(api, proc.id, { bindings: {} }), ['succeeded', 'failed']);
    await page.goto('/');
    await settle(page);
    const card = page.getByTestId('failed-checks');
    const toggle = card.getByTestId('failed-checks-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // one entry for three failed runs
    const entry = card.getByTestId('failed-check').filter({ hasText: `${name} – endpoints healthy` });
    await expect(entry).toHaveCount(1);
    await expect(entry).toContainText('3 runs');
    await expect(entry.getByRole('link', { name: 'runs with failed checks' })).toHaveAttribute('href', new RegExp(`checks=failed`));
    await expectAccessible(page, 'start page failed checks');

    // folded: the counts stay in the header, the choice is remembered
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(card.getByTestId('failed-checks-counts')).toContainText(/\d+ checks? failing/);
    await expect(entry).toBeHidden();
    await page.reload();
    await expect(page.getByTestId('failed-checks-toggle')).toHaveAttribute('aria-expanded', 'false');
    // keyboard: Enter unfolds it
    await page.getByTestId('failed-checks-toggle').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('failed-checks-toggle')).toHaveAttribute('aria-expanded', 'true');

    // the link opens the runs of the process with failed checks
    await page
      .getByTestId('failed-check')
      .filter({ hasText: `${name} – endpoints healthy` })
      .getByRole('link', { name: 'runs with failed checks' })
      .click();
    await expect(page).toHaveURL(/\/runs\?processId=.*&checks=failed$/);
    await expect(page.getByRole('row').filter({ hasText: name })).toHaveCount(3);
  } finally {
    await api.delete(`/api/processes/${proc.id}`);
  }
});
