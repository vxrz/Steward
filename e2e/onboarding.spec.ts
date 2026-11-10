import { test, expect } from './support/fixtures';
import { authFile, baseURL } from './support/env';
import { expectAccessible } from './support/axe';
import { chooseOption, expectNoHorizontalScroll, json, uniq } from './support/helpers';

test.use({ storageState: authFile('admin') });

/** The simulated Confluent Cloud API (server/src/mock/mockConfluent.ts). */
const CLOUD = { key: 'CLOUDKEY', secret: 'demo-confluent-cloud-secret' };

/**
 * Onboarding (v0.4.0): the platform setup wizard (connector, settings, live test with fix hints, what's next), the
 * platform page's health and "Get started", template bundles in the gallery, and Kafka topics by prefix.
 */
test('the setup wizard: connector, credentials, a failing test with hints, fixed, what next', async ({ page, apiAs }) => {
  const name = uniq('Confluent wizard');
  await page.goto('/platforms');
  await page.getByRole('button', { name: 'Add platform' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a platform' });
  await dialog.getByRole('textbox', { name: 'Search connectors' }).fill('confluent');
  await expect(dialog.getByTestId('wizard-connector')).toHaveCount(2);
  await expectAccessible(page, 'setup wizard: connectors');
  await dialog.getByTestId('wizard-connector').filter({ hasText: 'Confluent Cloud API' }).click();

  // only the connector's fields; a wrong secret first
  // the platform's name (the variables' name fields come after it)
  await dialog.getByRole('textbox', { name: 'Name' }).first().fill(name);
  await dialog.getByRole('textbox', { name: 'Base URL' }).fill(`${baseURL()}/mock/confluent`);
  await dialog.getByLabel('Cloud API key', { exact: true }).fill(CLOUD.key);
  await dialog.getByLabel('Cloud API secret', { exact: true }).fill('wrong-secret');
  await dialog.getByTestId('wizard-create').click();
  const result = dialog.getByTestId('wizard-test-result');
  await expect(result).toContainText('Connection failed');
  await expect(result).toContainText('HTTP 401');
  await expect(dialog.getByTestId('platform-test-hints')).toContainText('did not accept the credentials');
  await expectAccessible(page, 'setup wizard: failed test');

  // fixed: change the settings, test again
  await dialog.getByRole('button', { name: 'Change the settings' }).click();
  await dialog.getByLabel('Cloud API secret', { exact: true }).fill(CLOUD.secret);
  await dialog.getByTestId('wizard-create').click();
  await expect(result).toContainText('Connection works');
  await dialog.getByTestId('wizard-continue').click();

  // what next: access reviews for Confluent, the MCP gateway; the link opens a new access check on the platform
  const next = dialog.getByTestId('platform-get-started');
  await expect(next.getByText('Access reviews')).toBeVisible();
  await expect(next.getByText('AI assistants (MCP gateway)')).toBeVisible();
  await expectAccessible(page, 'setup wizard: what next');
  await next.getByRole('link', { name: 'Create an access check' }).click();
  const check = page.getByRole('dialog', { name: 'New check' });
  await expect(check.getByRole('combobox', { name: 'Source' })).toHaveValue('Confluent Cloud role bindings and ACLs');
  await expect(check.getByRole('textbox', { name: 'Confluent resource (CRN)' })).toBeVisible();
  await page.keyboard.press('Escape');

  const api = await apiAs('admin');
  const p = (await json<{ id: string; name: string }[]>(await api.get('/api/platforms'))).find((x) => x.name === name)!;
  await api.delete(`/api/platforms/${p.id}`);
});

test('platform health: the last test prominently, the periodic test, the Get started tab', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const name = uniq('Health');
  const p = await json<{ id: string }>(
    await api.post('/api/platforms', {
      data: {
        name,
        kind: 'confluent-cloud',
        baseUrl: `${baseURL()}/mock/confluent`,
        config: { auth: { type: 'basic' }, variables: {}, http: {}, testPath: '/iam/v2/users?page_size=1' },
        secrets: { username: CLOUD.key, password: CLOUD.secret },
      },
    }),
  );
  try {
    await page.goto(`/platforms/${p.id}`);
    const health = page.getByTestId('platform-health');
    await expect(health).toContainText('Not tested yet');
    await page.getByRole('button', { name: 'Test connection' }).click();
    await expect(health).toContainText('Last connection test passed');
    await expect(health).toContainText('by admin');
    // saved at once (the switch follows the server's answer)
    const periodic = health.getByRole('switch', { name: 'Test periodically' });
    await periodic.click();
    await expect(periodic).toBeChecked();
    await chooseOption(page, 'Interval of the periodic test', 'every 15 minutes');
    await expect(health).toContainText('Platform connection failing');
    const h = await json(await api.get(`/api/platforms/${p.id}/health`));
    expect(h.periodic).toMatchObject({ enabled: true, intervalMinutes: 15 });
    await expectAccessible(page, 'platform page with health');

    await page.getByRole('tab', { name: 'Get started' }).click();
    await expect(page.getByTestId('platform-get-started')).toContainText('Access reviews');
  } finally {
    await api.delete(`/api/platforms/${p.id}`);
  }
});

test('template bundles: set up together, with the result and the turn-on step', async ({ page, apiAs }) => {
  await page.goto('/processes?bundle=70-kubernetes');
  const gallery = page.getByRole('dialog', { name: 'Start from a template' });
  const setup = gallery.getByTestId('bundle-setup');
  await expect(setup.getByRole('heading', { name: 'Kubernetes (namespace health)' })).toBeVisible();
  // the only Kubernetes platform is chosen
  await expect(setup.getByTestId('bundle-platform')).toHaveValue(/Kubernetes \(demo\)/);
  await expectAccessible(page, 'bundle setup');
  await setup.getByRole('button', { name: 'Back to the templates' }).click();
  // the gallery lists the bundles above the templates
  const section = gallery.getByTestId('bundle-section');
  // one card per bundle in examples/bundles
  await expect(section.getByTestId('bundle-card')).toHaveCount(11);
  await gallery.getByRole('textbox', { name: 'Search' }).fill('snowflake');
  await expect(section.getByTestId('bundle-card')).toHaveCount(1);
  await section.getByRole('button', { name: 'Set up Snowflake (project access and account hygiene)' }).click();
  await setup.getByRole('checkbox', { name: 'Start one dry run per process' }).uncheck();
  await setup.getByTestId('bundle-submit').click();
  const result = gallery.getByTestId('bundle-result');
  await expect(result).toContainText('“Snowflake (project access and account hygiene)” is set up');
  await expect(result.getByTestId('bundle-item-action').first()).toBeVisible();
  await expectAccessible(page, 'bundle result');
  const turnOn = result.getByTestId('bundle-turn-on');
  if (await turnOn.isVisible()) {
    await turnOn.click();
    await expect(result.getByTestId('bundle-turned-on')).toContainText('turned on');
  }
  const api = await apiAs('admin');
  const log = await json<{ action: string }[]>(await api.get('/api/audit?entityType=template_bundle&limit=5'));
  expect(log.map((e) => e.action)).toContain('template_bundle.setup');
});

test('Kafka topics by prefix: list, add with an environment, keep in sync', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const app = await json<{ id: string }>(await api.post('/api/applications', { data: { name: uniq('E2E Kafka prefix'), owners: [] } }));
  try {
    await page.goto(`/applications/${app.id}`);
    await page.getByTestId('add-topics-by-prefix').click();
    const dialog = page.getByRole('dialog', { name: 'Add Kafka topics by prefix' });
    await chooseOption(page, 'Kafka platform', 'Kafka (demo)');
    await dialog.getByTestId('topic-prefix-input').fill('or');
    await dialog.getByTestId('topic-prefix-list').click();
    const topics = dialog.getByTestId('topic-prefix-topics');
    await expect(topics).toContainText('1 topic starts with “or”');
    await expect(topics.getByRole('checkbox', { name: 'orders' })).toBeChecked();
    await topics.getByRole('switch', { name: 'Keep in sync' }).check();
    await expectAccessible(page, 'topics by prefix');
    await dialog.getByTestId('topic-prefix-add').click();
    await expect(dialog).toBeHidden();
    const panel = page.getByTestId('application-components');
    await expect(panel.getByText('orders', { exact: true })).toBeVisible();
    await expect(page.getByTestId('topic-offers')).toContainText('Kept in sync: or');
    const syncs = await json<{ prefix: string }[]>(await api.get(`/api/applications/${app.id}/topic-prefixes`));
    expect(syncs.map((x) => x.prefix)).toEqual(['or']);
  } finally {
    await api.delete(`/api/applications/${app.id}`).catch(() => undefined);
  }
});

test.describe('phone @mobile', () => {
  test('the setup wizard and the bundles fit a phone', async ({ page }) => {
    await page.goto('/platforms');
    await page.getByRole('button', { name: 'Add platform' }).tap();
    const dialog = page.getByRole('dialog', { name: 'Add a platform' });
    await expect(dialog.getByTestId('wizard-connector').first()).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'setup wizard on a phone');
    await page.keyboard.press('Escape');
    await page.goto('/processes?bundle=80-dependency-track');
    await expect(page.getByTestId('bundle-setup')).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});
