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
