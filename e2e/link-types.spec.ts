import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { chooseOption, expectNoHorizontalScroll, json, uniq } from './support/helpers';

test.use({ storageState: authFile('admin') });

/** Link types: an administrator adds one; typed external links on a service are grouped by type with icons. */
test('an administrator adds a link type; typed links on a service are grouped by type', async ({ page, loginAs, apiAs }) => {
  const typeName = uniq('E2E wiki');
  await page.goto('/records/types');
  await page.getByRole('link', { name: 'Link types' }).click();
  await expect(page).toHaveURL(/\/records\/link-types$/);
  const table = page.getByRole('table', { name: 'Link types' });
  await expect(table.getByRole('row').filter({ hasText: 'Runbook' })).toContainText('Built-in');
  await page.getByRole('button', { name: 'New link type' }).click();
  const dialog = page.getByRole('dialog', { name: 'New link type' });
  await dialog.getByRole('textbox', { name: 'Name' }).fill(typeName);
  await chooseOption(page, 'Icon', 'Globe');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(table.getByRole('row').filter({ hasText: typeName })).toContainText('Your own');
  await settle(page);
  await expectAccessible(page, 'link types');

  // Dana adds typed links to a service
  const api = await apiAs('dana');
  const name = uniq('E2E typed links service');
  const svc = await json<{ id: string }>(await api.post('/api/services', { data: { name, owners: [] } }));
  const dana = await loginAs('dana');
  await dana.goto(`/services/${svc.id}`);
  const add = async (url: string, label: string, type: string | RegExp) => {
    await dana.getByRole('button', { name: 'Add link' }).click();
    const d = dana.getByRole('dialog', { name: 'Add link' });
    await chooseOption(dana, 'Kind', 'External link');
    await d.getByRole('textbox', { name: 'URL' }).fill(url);
    await d.getByRole('textbox', { name: 'Label' }).fill(label);
    await chooseOption(dana, 'Type', type);
    await d.getByRole('button', { name: 'Add link' }).click();
    await expect(d).toBeHidden();
  };
  await add('https://wiki.example.com/restart', 'Restart runbook', 'Runbook');
  await add('https://git.example.com/plant/gateway', 'Gateway repository', 'Repository');
  await add('https://wiki.example.com/team', 'Team page', typeName);

  const external = dana.getByTestId('external-links');
  await expect(dana.getByRole('list', { name: 'Runbook links' }).getByRole('link', { name: /Restart runbook/ })).toHaveAttribute(
    'href',
    'https://wiki.example.com/restart',
  );
  await expect(dana.getByRole('list', { name: 'Repository links' })).toContainText('Gateway repository');
  await expect(dana.getByRole('list', { name: `${typeName} links` })).toContainText('Team page');
  // built-in types first, in their order
  await expect(external.locator('[data-link-type]').first()).toHaveAttribute('data-link-type', 'runbook');
  await settle(dana);
  await expectAccessible(dana, 'typed links');

  // phone width
  await dana.setViewportSize({ width: 390, height: 844 });
  await dana.goto(`/services/${svc.id}`);
  await expect(dana.getByRole('list', { name: 'Runbook links' })).toBeVisible();
  await expectNoHorizontalScroll(dana);
});

/** Editing a link (#68): an untyped ("Other") link gets a type and moves to its group; internal links take a note. */
test('editing a link changes its type, label and note; it moves to its group', async ({ loginAs, apiAs }) => {
  const api = await apiAs('dana');
  const svc = await json<{ id: string }>(await api.post('/api/services', { data: { name: uniq('E2E link edit service'), owners: [] } }));
  const target = await json<{ id: string; name: string }>(await api.post('/api/services', { data: { name: uniq('E2E link edit target'), owners: [] } }));
  await json(await api.post(`/api/services/${svc.id}/links`, { data: { url: 'https://wiki.example.com/restart-gateway', label: 'Restart notes' } }));
  await json(await api.post(`/api/services/${svc.id}/links`, { data: { kind: 'service', id: target.id, note: 'depends on' } }));
  const dana = await loginAs('dana');
  await dana.goto(`/services/${svc.id}`);
  const other = dana.getByRole('list', { name: 'Other links' });
  await expect(other).toContainText('Restart notes');
  await expect(dana.getByRole('list', { name: 'Runbook links' })).toHaveCount(0);

  await dana.getByRole('button', { name: 'Edit link to Restart notes' }).click();
  const d = dana.getByRole('dialog', { name: 'Edit link' });
  // the target stays as it is
  await expect(d.getByRole('textbox', { name: 'URL' })).toHaveValue('https://wiki.example.com/restart-gateway');
  await expect(d.getByRole('textbox', { name: 'URL' })).toBeDisabled();
  await expect(d.getByRole('textbox', { name: 'Label' })).toHaveValue('Restart notes');
  await d.getByRole('textbox', { name: 'Label' }).fill('Restart runbook');
  await chooseOption(dana, 'Type', 'Runbook');
  await d.getByRole('textbox', { name: 'Note' }).fill('checked in October');
  await settle(dana);
  await expectAccessible(dana, 'edit link dialog');
  await d.getByRole('button', { name: 'Save' }).click();
  await expect(d).toBeHidden();

  const runbook = dana.getByRole('list', { name: 'Runbook links' });
  await expect(runbook.getByRole('link', { name: /Restart runbook/ })).toHaveAttribute('href', 'https://wiki.example.com/restart-gateway');
  await expect(runbook).toContainText('checked in October');
  await expect(other).toHaveCount(0);

  // internal links: only the note (keyboard: Enter opens the dialog)
  await dana.getByRole('button', { name: `Edit link to ${target.name}` }).focus();
  await dana.keyboard.press('Enter');
  const d2 = dana.getByRole('dialog', { name: 'Edit link' });
  await expect(d2.getByRole('textbox', { name: 'Target' })).toHaveValue(target.name);
  await expect(d2.getByRole('textbox', { name: 'Label' })).toHaveCount(0);
  await expect(d2.getByRole('textbox', { name: 'Type' })).toHaveCount(0);
  await d2.getByRole('textbox', { name: 'Note' }).fill('runs on');
  await d2.getByRole('button', { name: 'Save' }).click();
  await expect(d2).toBeHidden();
  await expect(dana.getByRole('table', { name: 'Links' }).getByRole('row').filter({ hasText: target.name })).toContainText('runs on');

  // phone width: both actions next to each link, no horizontal scroll
  await dana.setViewportSize({ width: 390, height: 844 });
  await expect(dana.getByRole('button', { name: 'Edit link to Restart runbook' })).toBeVisible();
  await expect(dana.getByRole('button', { name: 'Remove link to Restart runbook' })).toBeVisible();
  await expectNoHorizontalScroll(dana);

  // one audit entry per change, with old and new values
  const admin = await apiAs('admin');
  const audit = await json<{ items: { action: string; details: { changes: string[]; old: Record<string, unknown> } }[] }>(
    await admin.get(`/api/audit?entityId=${svc.id}&action=service.link_updated`),
  );
  const items = audit.items ?? (audit as unknown as typeof audit.items);
  expect(items).toHaveLength(2);
  expect(items.some((e) => e.details.old.linkType === null && e.details.changes.includes('linkType'))).toBe(true);
});
