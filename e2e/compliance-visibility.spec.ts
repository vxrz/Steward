import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { json, uniq, waitForRun } from './support/helpers';

test.use({ storageState: authFile('olivia') });

/**
 * Evidence someone may not see (#21): the Controls page says "not visible" with the number of hidden items, as the
 * evidence pack does, instead of a gap.
 */
test('a control with evidence the reader may not see is not visible, not a gap', async ({ page, apiAs }) => {
  const admin = await apiAs('admin');
  const proc = await json(
    await admin.post('/api/processes', {
      data: { definition: { name: uniq('E2E restricted evidence'), steps: [{ id: 'a', type: 'set', values: { x: 1 } }] } },
    }),
  );
  await json(await admin.put(`/api/processes/${proc.id}/access`, { data: { acl: [{ subject: 'user:dana', permissions: ['view', 'run'] }] } }));
  const run = await json(await admin.post('/api/runs', { data: { processId: proc.id } }));
  await waitForRun(admin, run.id, ['succeeded']);
  const key = `VIS${Date.now().toString(36).toUpperCase()}`;
  await json(
    await admin.post('/api/compliance/catalogues/import', {
      data: { key, name: 'Visibility', filename: 'vis.csv', content: 'ref,title\nV.1,Restricted work\n' },
    }),
  );
  const [control] = await json(await admin.get(`/api/compliance/controls?catalogue=${key}`));
  await json(await admin.post(`/api/compliance/controls/${control.id}/tags`, { data: { kind: 'process', targetId: proc.id } }));

  await page.goto(`/compliance/controls?catalogue=${key}`);
  await expect(page.getByText('1 not visible')).toBeVisible();
  await expect(page.getByText('0 gaps')).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: 'V.1' });
  await expect(row.getByText('Not visible (1 hidden)')).toBeVisible();

  await page.goto(`/compliance/controls?catalogue=${key}&control=${control.id}`);
  await expect(page.getByText(/There is evidence in this period \(1 item\), but you may not see it/)).toBeVisible();
});
