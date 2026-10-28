import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { json, platformId, uniq } from './support/helpers';

test.use({ storageState: authFile('admin') });

/** Credential values of the simulated platforms (server/src/mock/mockPlatform.ts). They must never reach the browser. */
const SECRETS = ['demo-secret', 'demo-password'];

test('platform: test connection, API explorer, credentials stay hidden', async ({ page, apiAs }) => {
  await page.goto('/platforms');
  await page.getByText('Insights Hub (demo)', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Insights Hub (demo)', level: 2 })).toBeVisible();

  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Connection works' })).toContainText('HTTP 200');

  // credentials: names only, values masked
  await page.getByRole('tab', { name: 'Credentials' }).click();
  await expect(page.getByRole('cell', { name: 'clientSecret' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '••••••••' }).first()).toBeVisible();

  // API explorer against the mock tenant
  await page.getByRole('tab', { name: 'Explorer' }).click();
  await page.getByRole('textbox', { name: 'Path (relative to base URL)' }).fill('/api/identitymanagement/v3/Users?count=2');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('HTTP 200', { exact: true })).toBeVisible();
  await expect(page.getByText(/"userName": ".+@example\.com"/).first()).toBeVisible();

  const html = await page.content();
  for (const s of SECRETS) expect(html).not.toContain(s);

  // the API never returns secret values either
  const api = await apiAs('admin');
  for (const kind of ['insights-hub', 'industrial-edge-management'] as const) {
    const id = await platformId(api, kind);
    const body = await (await api.get(`/api/platforms/${id}`)).text();
    for (const s of SECRETS) expect(body).not.toContain(s);
  }
});

test('operator may use the explorer read-only', async ({ loginAs }) => {
  const page = await loginAs('olivia');
  await page.goto('/platforms');
  await page.getByText('Industrial Edge Management (demo)', { exact: true }).click();
  await expect(page.getByText(/You may use this platform in runs and send read-only requests/)).toBeVisible();
  await page.getByRole('tab', { name: 'Explorer' }).click();
  await page.getByRole('textbox', { name: 'Method' }).click();
  await expect(page.getByRole('option')).toHaveText(['GET', 'HEAD']);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('HTTP 200', { exact: true })).toBeVisible();
  await expect(page.getByText(/edge-line-1/).first()).toBeVisible();
});

test('API specs: the path prefix from the server URL can be edited, with a preview of the request URL', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const name = uniq('Prefix platform');
  const p = await json<{ id: string }>(await api.post('/api/platforms', { data: { name, kind: 'generic', baseUrl: 'https://edge.example.com' } }));
  const spec = {
    openapi: '3.0.3',
    info: { title: 'Edge devices', version: '1' },
    servers: [{ url: 'https://edge.example.com/device/api/v1' }],
    paths: { '/things': { get: { operationId: 'listThings', summary: 'List things', responses: { '200': { description: 'OK' } } } } },
  };
  await json(await api.post(`/api/platforms/${p.id}/specs`, { data: { name: 'Edge devices', content: JSON.stringify(spec) } }));

  await page.goto(`/platforms/${p.id}`);
  await page.getByRole('tab', { name: 'API specs' }).click();
  await expect(page.getByRole('cell', { name: /Requests go to: https:\/\/edge\.example\.com\/device\/api\/v1\/…/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: '/device/api/v1/things', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Edit path prefix of Edge devices' }).click();
  const dialog = page.getByRole('dialog', { name: 'Path prefix of the specification' });
  const input = dialog.getByRole('textbox', { name: 'Path prefix' });
  await input.fill('/../admin');
  await expect(dialog.getByText(/Use \/segment\/segment/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
  await input.fill('/device/api/v2');
  await expect(dialog.getByText('https://edge.example.com/device/api/v2/…')).toBeVisible();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('cell', { name: '/device/api/v2/things', exact: true })).toBeVisible();

  await api.delete(`/api/platforms/${p.id}`);
});

test('API specs: a specification is copied to another platform of the same kind', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const kind = `copykind${Date.now().toString(36)}`;
  const make = async (label: string) =>
    json<{ id: string }>(await api.post('/api/platforms', { data: { name: uniq(label), kind, baseUrl: 'https://edge.example.com' } }));
  const a = await make('Copy source');
  const b = await make('Copy target');
  const other = await json<{ id: string }>(
    await api.post('/api/platforms', { data: { name: uniq('Other kind'), kind: 'generic', baseUrl: 'https://x.example.com' } }),
  );
  const spec = {
    openapi: '3.0.3',
    info: { title: 'Edge devices', version: '1' },
    servers: [{ url: 'https://edge.example.com/device/api/v1' }],
    paths: { '/things': { get: { operationId: 'listThings', responses: { '200': { description: 'OK' } } } } },
  };
  await json(await api.post(`/api/platforms/${a.id}/specs`, { data: { name: 'Edge devices', content: JSON.stringify(spec) } }));
  const targetName = ((await json<{ name: string }>(await api.get(`/api/platforms/${b.id}`))) as { name: string }).name;

  await page.goto(`/platforms/${a.id}`);
  await page.getByRole('tab', { name: 'API specs' }).click();
  await page.getByRole('button', { name: 'Copy Edge devices to other platforms' }).click();
  const dialog = page.getByRole('dialog', { name: /Copy .Edge devices. to other platforms/ });
  await dialog.getByRole('textbox', { name: 'Platforms' }).click();
  // only platforms of the same kind are offered
  await expect(page.getByRole('option', { name: targetName })).toBeVisible();
  await expect(page.getByRole('option')).toHaveCount(1);
  await page.getByRole('option', { name: targetName }).click();
  await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(dialog.getByTestId('spec-copy-result')).toContainText(`${targetName}: copied`);

  const copies = await json<{ title: string; pathPrefix: string }[]>(await api.get(`/api/platforms/${b.id}/specs`));
  expect(copies).toMatchObject([{ title: 'Edge devices', pathPrefix: '/device/api/v1' }]);

  for (const p of [a, b, other]) await api.delete(`/api/platforms/${p.id}`);
});

test('access: a team or role picked from the list can be added', async ({ page, apiAs }) => {
  // Picking an option puts its label into the field ("Team …"); "Add" used to stay disabled because it expected "team:…".
  const api = await apiAs('admin');
  const team = uniq('Access team');
  await json(await api.post('/api/teams', { data: { name: team, members: [] } }));
  const id = await platformId(api, 'insights-hub');
  await page.goto(`/platforms/${id}`);
  await page.getByRole('tab', { name: 'Access' }).click();

  const field = page.getByRole('textbox', { name: 'Add user, team or role' });
  const add = page.getByRole('button', { name: 'Add', exact: true });
  await expect(add).toBeDisabled();
  await field.fill(team.slice(0, 12));
  await page.getByRole('option', { name: `Team ${team}` }).click();
  await expect(field).toHaveValue(`Team ${team}`);
  await expect(add).toBeEnabled();
  await add.click();
  await expect(page.getByRole('table').getByText(`Team ${team}`, { exact: true })).toBeVisible();
  await expect(field).toHaveValue('');

  // a role works the same way; nothing is saved (other tests use this platform)
  await field.fill('operator');
  await page.getByRole('option', { name: 'Everyone with role operator' }).click();
  await expect(add).toBeEnabled();
  await add.click();
  await expect(page.getByRole('table').getByText('Everyone with role operator', { exact: true })).toBeVisible();
});
