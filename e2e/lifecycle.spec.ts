import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible } from './support/axe';
import { json, uniq } from './support/helpers';

test.use({ storageState: authFile('dana') });

/**
 * End of life of the tech stack (#104): a designer reads the end-of-life data now (the demo's endoflife.date platform
 * is the built-in mock: Node.js 24 has reached its end of life, 25 ends soon, Python 3.15 is supported), and the
 * badges show the state. The settings are for administrators only.
 */
test('the tech stack shows the end of life of each version', async ({ page, apiAs }) => {
  const api = await apiAs('dana');
  const name = uniq('E2E EOL');
  const app = await json<{ id: string }>(await api.post('/api/applications', { data: { name, owners: [] } }));
  try {
    await json(
      await api.post(`/api/applications/${app.id}/components`, {
        data: {
          type: 'container-image',
          name: 'ghcr.io/acme/eol',
          stack: [
            { product: 'nodejs', version: '24.11.0' },
            { product: 'python', version: '3.15' },
          ],
        },
      }),
    );

    await page.goto('/applications');
    await page.getByRole('button', { name: 'End of life' }).click();
    const dialog = page.getByRole('dialog', { name: 'End of life of the tech stack' });
    await expect(dialog.getByText('Only administrators change these settings.')).toBeVisible();
    await expect(dialog.getByRole('switch', { name: 'Count on the scorecard' })).toBeDisabled();
    await expectAccessible(page, 'end-of-life dialog');
    await dialog.getByRole('button', { name: 'Refresh now' }).click();
    await expect(page.getByText(/End-of-life data read: \d+ of \d+ products/)).toBeVisible();
    await expect(dialog.getByTestId('lifecycle-status')).toContainText(/products have end-of-life data, last read/);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await page.goto(`/applications/${app.id}`);
    const row = page.getByTestId('application-components').getByRole('row', { name: /ghcr\.io\/acme\/eol/ });
    const node = row.getByLabel('Node.js 24.11.0: end of life');
    await expect(node).toHaveAttribute('data-lifecycle', 'eol');
    await expect(row.getByLabel('Python 3.15: supported')).toHaveAttribute('data-lifecycle', 'supported');
    await node.hover();
    await expect(page.getByRole('tooltip')).toContainText(/Release cycle 24 .*end of life since/);
    await expect(page.getByTestId('application-stack').getByRole('listitem', { name: 'Node.js 24.11.0 · 1 component: end of life' })).toBeVisible();
    await expectAccessible(page, 'tech stack with end of life');
  } finally {
    await api.post(`/api/applications/${app.id}/archive`, { data: { archived: true } });
  }
});
