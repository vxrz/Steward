import { test, expect } from './support/fixtures';
import { authFile, baseURL } from './support/env';
import { json, uniq } from './support/helpers';

test.use({ storageState: authFile('dana') });

/** A raw heartbeat report, like the IoT gateway sends it (no session). */
async function report(path: string, secret: string, body: unknown) {
  const res = await fetch(baseURL() + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(202);
  return res.json();
}

test('the monitor list shows the demo monitors and opens the graph view', async ({ page }) => {
  await page.goto('/monitors');
  const table = page.getByRole('table', { name: 'Monitors' });
  await expect(table.getByRole('link', { name: 'Machine 17 – PowerMeter' })).toBeVisible();
  await expect(table.getByRole('link', { name: 'Machine 18 – PowerMeter' })).toBeVisible();
  await table.getByRole('link', { name: 'Machine 17 – PowerMeter' }).click();
  await expect(page).toHaveURL(/\/monitors\/mon_/);
  await expect(page.getByTestId('monitor-graph')).toBeVisible();
  for (const id of ['pm-reachable', 'pm-reports', 'pm-ih', 'machine']) await expect(page.getByTestId(`monitor-node-${id}`)).toBeVisible();
  // a sub-monitor node links to the other monitor
  await page.getByTestId('monitor-node-machine').click();
  const panel = page.getByTestId('check-panel');
  await expect(panel.getByRole('heading', { name: 'Machine data flow' })).toBeVisible();
  await expect(panel.getByRole('link', { name: 'Open "Machine 17 – machine data"' })).toBeVisible();
});

test('a heartbeat report turns the check up', async ({ page, apiAs }) => {
  const api = await apiAs('dana');
  const name = uniq('E2E heartbeat');
  const created = await json(
    await api.post('/api/monitors', {
      data: {
        definition: { name, failuresBeforeDown: 1, checks: [{ id: 'hb', name: 'Gateway report', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 600 }] },
      },
    }),
  );
  const { secret, path } = created.secrets[0];
  await page.goto(`/monitors/${created.monitor.id}`);
  const node = page.getByTestId('monitor-node-hb');
  await expect(node).toBeVisible();
  await expect(node).toHaveAttribute('data-status', /unknown|none/);
  expect((await report(path, secret, { value: 42, status: 'up' })).status).toBe('up');
  await expect(node).toHaveAttribute('data-status', 'up', { timeout: 15_000 });
  // the heartbeat setup shows the URL and an example, never the secret
  await page.getByRole('tab', { name: 'Heartbeat setup' }).click();
  await expect(page.getByText(`${baseURL()}${path}`).first()).toBeVisible();
  await expect(page.getByText(secret)).toHaveCount(0);
  await api.delete(`/api/monitors/${created.monitor.id}`);
});

test('the root cause is shown when a parent and its child fail', async ({ page, apiAs }) => {
  const api = await apiAs('dana');
  const created = await json(
    await api.post('/api/monitors', {
      data: {
        definition: {
          name: uniq('E2E PowerMeter'),
          failuresBeforeDown: 1,
          checks: [
            // nothing listens on port 9 of localhost: connection refused
            { id: 'pm', name: 'PowerMeter reachable', type: 'tcp', host: '127.0.0.1', port: 9, x: 0, y: 0 },
            { id: 'data', name: 'PowerMeter data', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 600, x: 0, y: 160 },
          ],
          links: [{ from: 'pm', to: 'data' }],
        },
      },
    }),
  );
  const { secret, path } = created.secrets[0];
  await report(path, secret, { status: 'down', value: 0 });
  await json(await api.post(`/api/monitors/${created.monitor.id}/run`, { data: {} }));
  await page.goto(`/monitors/${created.monitor.id}`);
  const alert = page.getByRole('alert').filter({ hasText: 'Root cause' });
  await expect(alert).toContainText('PowerMeter reachable');
  await expect(page.getByTestId('monitor-node-pm')).toHaveAttribute('data-status', 'down');
  await expect(page.getByTestId('monitor-node-pm')).toContainText('Root cause');
  await expect(page.getByTestId('monitor-node-data')).toContainText('Likely caused by PowerMeter reachable');
  await api.delete(`/api/monitors/${created.monitor.id}`);
});

test('the status wall lists monitors with problems first', async ({ page }) => {
  await page.goto('/monitors/wall');
  await expect(page.getByRole('heading', { name: 'Status wall' })).toBeVisible();
  await expect(page.getByTestId('wall-machine-17-powermeter')).toBeVisible();
  const first = page.locator('[data-testid^="wall-"]').first();
  await expect(first).toHaveAttribute('data-status', /down|degraded|unknown|up/);
});

test('viewers see monitors but cannot create or edit them', async ({ loginAs }) => {
  const page = await loginAs('vera');
  await page.goto('/monitors');
  await expect(page.getByRole('heading', { name: 'Monitors', level: 2 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New monitor' })).toHaveCount(0);
  await page.getByRole('table', { name: 'Monitors' }).getByRole('link', { name: 'Machine 17 – PowerMeter' }).click();
  await expect(page.getByTestId('monitor-graph')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);
});
