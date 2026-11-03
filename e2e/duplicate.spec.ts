import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { json, uniq } from './support/helpers';

/**
 * Duplicate (0.4.0): several cards of a monitor at once with the links between them, an application with the parts
 * chosen in the dialog, and a schedule whose copy starts disabled.
 */

test.describe('as a designer', () => {
  test.use({ storageState: authFile('dana') });

  test('duplicates a group of monitor checks with the links between them', async ({ page, apiAs }) => {
    const api = await apiAs('dana');
    const { monitor } = await json<{ monitor: { id: string } }>(
      await api.post('/api/monitors', {
        data: {
          definition: {
            name: uniq('E2E group'),
            checks: [
              { id: 'web', name: 'Web', type: 'tcp', host: '127.0.0.1', port: 9, x: 0, y: 0 },
              { id: 'db', name: 'Database', type: 'tcp', host: '127.0.0.1', port: 10, x: 0, y: 160 },
              { id: 'other', name: 'Other', type: 'tcp', host: '127.0.0.1', port: 11, x: 300, y: 0 },
            ],
            links: [{ from: 'web', to: 'db', mode: 'hard' }],
          },
        },
      }),
    );
    await page.goto(`/monitors/${monitor.id}/edit`);
    await settle(page);
    await page.getByTestId('monitor-node-web').click();
    await page.getByTestId('monitor-node-db').click({ modifiers: ['Shift'] });
    const panel = page.getByTestId('selection-panel');
    await expect(panel).toContainText('2 checks selected');
    await expectAccessible(page, 'monitor editor with a selection');
    await panel.getByRole('button', { name: 'Duplicate selection' }).click();
    await expect(page.getByTestId('monitor-node-web-copy')).toBeVisible();
    await expect(page.getByTestId('monitor-node-db-copy')).toBeVisible();
    await expect(page.getByTestId('monitor-node-other-copy')).toHaveCount(0);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/monitors/${monitor.id}$`));
    const saved = await json<{ definition: { checks: { id: string; name: string }[]; links: unknown[] } }>(await api.get(`/api/monitors/${monitor.id}`));
    expect(saved.definition.checks.map((c) => c.id)).toEqual(['web', 'db', 'other', 'web-copy', 'db-copy']);
    expect(saved.definition.checks.find((c) => c.id === 'web-copy')?.name).toBe('Web (copy)');
    expect(saved.definition.links).toEqual([
      { from: 'web', to: 'db', mode: 'hard' },
      { from: 'web-copy', to: 'db-copy', mode: 'hard' },
    ]);
  });

  test('duplicates an application with the parts chosen, and opens the copy to edit it', async ({ page, apiAs }) => {
    const admin = await apiAs('admin');
    const name = uniq('E2E shop');
    const app = await json<{ id: string }>(await admin.post('/api/applications', { data: { name, owners: ['user:dana'] } }));
    await admin.post(`/api/applications/${app.id}/components`, { data: { type: 'repository', name: 'shop-web', url: 'https://git.example.com/shop-web' } });
    await admin.post(`/api/applications/${app.id}/links`, { data: { url: 'https://wiki.example.com/shop', label: 'Wiki' } });
    await page.goto(`/applications/${app.id}`);
    await page.getByTestId('duplicate-action').click();
    const dialog = page.getByRole('dialog', { name: 'Duplicate' });
    await expect(dialog.getByRole('textbox', { name: 'Name of the copy' })).toHaveValue(`${name} (copy)`);
    await expect(dialog.getByText('Platform mappings are not copied')).toBeVisible();
    await expectAccessible(page, 'duplicate dialog');
    // dana owns the original: she may copy its owners
    await dialog.getByLabel('Copy the owners and owning teams').check();
    await dialog.getByLabel('1 component').uncheck();
    await dialog.getByRole('button', { name: 'Create copy' }).click();
    await expect(page.getByRole('dialog', { name: `Edit ${name} (copy)` })).toBeVisible();
    await page
      .getByRole('dialog', { name: `Edit ${name} (copy)` })
      .getByRole('button', { name: 'Cancel' })
      .click();
    await expect(page.getByTestId('copied-from')).toContainText(`Copied from ${name}`);
    const id = new URL(page.url()).pathname.split('/').pop()!;
    const copy = await json<{ owners: string[]; components: unknown[]; links: { url: string }[] }>(await admin.get(`/api/applications/${id}`));
    expect(copy.owners).toEqual(['user:dana']);
    expect(copy.components).toEqual([]);
    expect(copy.links.map((l) => l.url)).toEqual(['https://wiki.example.com/shop']);
  });
});

test.describe('as an operator', () => {
  test.use({ storageState: authFile('olivia') });

  test('duplicates a schedule: the copy starts disabled and opens to edit it', async ({ page, apiAs }) => {
    const api = await apiAs('olivia');
    const processes = await json<{ id: string; name: string }[]>(await api.get('/api/processes'));
    const proc = processes.find((p) => p.name === 'Industrial Edge – Device status check')!;
    const platforms = await json<{ id: string; kind: string }[]>(await api.get('/api/platforms'));
    const iem = platforms.find((p) => p.kind === 'industrial-edge-management')!;
    const name = uniq('E2E nightly');
    const s = await json<{ id: string }>(
      await api.post('/api/schedules', { data: { name, processId: proc.id, cron: '0 3 * * *', bindings: { iem: iem.id }, enabled: true } }),
    );
    await page.goto('/schedules');
    await page
      .getByRole('row')
      .filter({ hasText: name })
      .getByRole('button', { name: `Duplicate “${name}”` })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Duplicate' });
    await expect(dialog).toContainText('The copy starts disabled.');
    await dialog.getByRole('button', { name: 'Create copy' }).click();
    // the copy opens in the schedule's editor
    const editor = page.getByRole('dialog', { name: /schedule/i });
    await expect(editor.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(`${name} (copy)`);
    await page.keyboard.press('Escape');
    const row = page.getByRole('row').filter({ hasText: `${name} (copy)` });
    await expect(row.getByRole('switch', { name: 'Enabled' })).not.toBeChecked();
    await expect(page.getByRole('row').filter({ hasText: name }).first().getByRole('switch', { name: 'Enabled' })).toBeChecked();
    const all = await json<{ id: string; name: string; enabled: boolean }[]>(await api.get('/api/schedules'));
    expect(all.find((x) => x.name === `${name} (copy)`)?.enabled).toBe(false);
    expect(all.find((x) => x.id === s.id)?.enabled).toBe(true);
  });
});
