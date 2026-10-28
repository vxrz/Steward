import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible } from './support/axe';
import { chooseOption, json, uniq } from './support/helpers';

test.use({ storageState: authFile('dana') });

const SBOM = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  metadata: { component: { type: 'container', name: 'ghcr.io/acme/orders', version: '1.4.0' } },
  components: [
    { type: 'operating-system', name: 'alpine', version: '3.20.3' },
    { type: 'application', name: 'node', version: '24.11.0', purl: 'pkg:generic/node@24.11.0' },
    { type: 'library', name: 'left-pad', version: '1.3.0', purl: 'pkg:npm/left-pad@1.3.0' },
  ],
};

/**
 * Components and tech stack of an application (#103): add a component with a stack entry by hand, then import an
 * SBOM after looking at its changes – the entry entered by hand stays.
 */
test('a component gets a tech stack by hand and from an SBOM', async ({ page, apiAs }) => {
  const api = await apiAs('dana');
  const name = uniq('E2E Orders');
  const app = await json<{ id: string }>(await api.post('/api/applications', { data: { name, owners: [] } }));
  try {
    await page.goto(`/applications/${app.id}`);
    const panel = page.getByTestId('application-components');
    await expect(panel.getByText('No components yet.')).toBeVisible();

    // add a container image with Node.js 22
    await panel.getByRole('button', { name: 'Add component' }).click();
    const form = page.getByRole('dialog', { name: `Add a component to ${name}` });
    await chooseOption(page, 'Type', 'Container image');
    await form.getByRole('textbox', { name: 'Name' }).fill('ghcr.io/acme/orders');
    await form.getByRole('button', { name: 'Add product' }).click();
    await page.getByRole('textbox', { name: 'Product' }).fill('Node.js');
    await page.getByRole('option', { name: 'Node.js', exact: true }).click();
    await form.getByRole('textbox', { name: 'Version' }).fill('22');
    await expectAccessible(page, 'component dialog');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(form).toBeHidden();
    const row = panel.getByRole('row', { name: /ghcr\.io\/acme\/orders/ });
    await expect(row).toContainText('Container image');
    await expect(row).toContainText('Node.js 22');

    // import an SBOM: the changes first, then the import
    await row.getByRole('button', { name: 'Import SBOM into ghcr.io/acme/orders' }).click();
    const dialog = page.getByRole('dialog', { name: 'Import an SBOM into ghcr.io/acme/orders' });
    await dialog
      .locator('input[type="file"]')
      .setInputFiles({ name: 'orders.cdx.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(SBOM)) });
    await expect(dialog.getByText(/orders\.cdx\.json/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Show changes' }).click();
    const preview = dialog.getByTestId('sbom-preview');
    await expect(preview).toContainText('CycloneDX “ghcr.io/acme/orders 1.4.0”: 2 of 4 entries are products endoflife.date knows.');
    await expect(preview.getByRole('row', { name: /Alpine Linux/ })).toContainText('add');
    await expect(preview.getByRole('row', { name: /Node\.js/ })).toContainText('kept (entered by hand)');
    await expectAccessible(page, 'SBOM dialog');
    await dialog.getByRole('button', { name: 'Import' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('SBOM imported: 1 added, 0 changed, 0 removed')).toBeVisible();
    await expect(row).toContainText('Alpine Linux 3.20.3');
    await expect(row).toContainText('Node.js 22');
    await expect(row).toContainText(/Last SBOM: CycloneDX “ghcr\.io\/acme\/orders 1\.4\.0”, imported by dana/);

    // the stack of all components together
    const stack = page.getByTestId('application-stack');
    await expect(stack.getByRole('listitem')).toHaveText(['Alpine Linux 3.20.3 · 1 component', 'Node.js 22 · 1 component']);
  } finally {
    await api.post(`/api/applications/${app.id}/archive`, { data: { archived: true } });
  }
});
