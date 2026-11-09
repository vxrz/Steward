import { request as pwRequest, type APIRequestContext, type Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile, baseURL } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { chooseRunMode, expectNoHorizontalScroll, json, platformId, uniq, waitForRun } from './support/helpers';

test.use({ storageState: authFile('admin') });

/** Credential values of the simulated platforms (server/src/mock/mockPlatform.ts). They must never reach the browser. */
const SECRETS = ['demo-secret', 'demo-password'];

/**
 * Platform identities (ADR 0009): the Identities tab lists them (step 1: the default one; 0.13.0: several, editable),
 * names and flags only, never a credential value.
 */
async function openIdentities(page: Page, id: string) {
  await page.goto(`/platforms/${id}`);
  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible();
  await page.getByRole('tab', { name: 'Identities' }).click();
  return page.getByRole('tabpanel', { name: 'Identities' });
}

/**
 * A platform of its own (the demo Insights Hub's address, sign-in and specs – its credentials set through the API, never
 * typed into the browser), so other tests that use the demo platform are not affected.
 */
async function ownPlatform(api: APIRequestContext): Promise<{ id: string; name: string }> {
  const demo = await json(await api.get(`/api/platforms/${await platformId(api, 'insights-hub')}`));
  const name = uniq('E2E Directory');
  const { mcpGateway: _gateway, ...config } = demo.config;
  const p = await json(await api.post('/api/platforms', { data: { name, kind: 'insights-hub', baseUrl: demo.baseUrl, config } }));
  await json(await api.put(`/api/platforms/${p.id}/secrets`, { data: { clientId: 'demo-client', clientSecret: 'demo-secret' } }));
  for (const spec of await json<{ id: string }[]>(await api.get(`/api/platforms/${demo.id}/specs`)))
    await json(await api.post(`/api/platforms/${demo.id}/specs/${spec.id}/copy`, { data: { targets: [p.id] } }));
  return { id: p.id, name };
}

test('the Identities tab lists the default identity – names and flags, never a credential', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const id = await platformId(api, 'insights-hub');
  const platform = await json(await api.get(`/api/platforms/${id}`));
  const panel = await openIdentities(page, id);
  const row = panel.getByTestId('identity-row').filter({ hasText: 'Default' }).first();
  await expect(row).toContainText('The platform’s sign-in settings (OAuth2 client credentials)');
  for (const key of platform.secretKeys as string[]) await expect(row).toContainText(key);
  await expect(row).toContainText('All operations');
  await expect(row).toContainText('Everyone with the “use” right on this platform');
  await expect(row).toContainText('You may use it');
  await expectAccessible(page, 'platform identities');
  const html = await page.content();
  for (const s of SECRETS) expect(html).not.toContain(s);
});

test('an operator with the use right may use the default identity, and cannot change identities', async ({ loginAs, apiAs }) => {
  const api = await apiAs('admin');
  const id = await platformId(api, 'industrial-edge-management');
  const page = await loginAs('olivia');
  const panel = await openIdentities(page, id);
  const row = panel.getByTestId('identity-row').first();
  await expect(row).toContainText('You may use it');
  await expect(row).toContainText('The platform’s sign-in settings (Custom login)');
  await expect(panel.getByTestId('identity-add')).toHaveCount(0);
  await expectAccessible(page, 'platform identities (operator)');
});

test('the Identities tab on a phone @mobile', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const id = await platformId(api, 'insights-hub');
  const panel = await openIdentities(page, id);
  await expect(panel.getByTestId('identity-card').first()).toContainText('You may use it');
  await expectNoHorizontalScroll(page);
  await expectAccessible(page, 'platform identities (phone)');
});

test('add a read-only identity, run a process with it – the write is refused – and use it over MCP and in a monitor', async ({ page, apiAs }) => {
  test.setTimeout(180_000);
  const api = await apiAs('admin');
  const platform = await ownPlatform(api);
  const identityName = uniq('Read only');

  // add it in the Identities tab: read only, then its MCP mode (credentials through the API: never typed here)
  const panel = await openIdentities(page, platform.id);
  await panel.getByTestId('identity-add').click();
  const dialog = page.getByRole('dialog', { name: 'Add an identity' });
  await dialog.getByRole('textbox', { name: 'Name' }).fill(identityName);
  await dialog.getByRole('textbox', { name: 'Description' }).fill('Reads the directory');
  await dialog.getByText('Read only', { exact: true }).click();
  await expect(dialog.getByRole('switch', { name: 'Read only' })).toBeChecked();
  await dialog.getByTestId('identity-save').click();
  const edit = page.getByRole('dialog', { name: `Identity “${identityName}”` });
  await expect(edit.getByRole('tab', { name: 'Credentials' })).toBeVisible();
  const identity = (await json(await api.get(`/api/platforms/${platform.id}`))).identities.find((i: { name: string }) => i.name === identityName);
  expect(identity).toMatchObject({ readOnly: true, default: false, acl: [], mcp: { mode: 'off' } });
  await json(
    await api.put(`/api/platforms/${platform.id}/identities/${identity.id}/secrets`, { data: { clientId: 'demo-client', clientSecret: 'demo-secret' } }),
  );
  await edit.getByTestId('identity-tab-mcp').click();
  await edit.getByTestId('identity-mcp-mode').click();
  await page.getByRole('option', { name: 'Read only', exact: true }).click();
  await edit.getByTestId('identity-mcp-save').click();
  await expect(page.getByText('MCP mode saved')).toBeVisible();
  await edit.getByTestId('identity-tab-access').click();
  await expect(edit).toContainText('Closed');
  await expectAccessible(page, 'identity dialog');
  await page.keyboard.press('Escape');
  await expect(panel.getByTestId('identity-row').filter({ hasText: identityName })).toContainText('Read only');

  // a process that writes: started from the run dialog with the read-only identity, the dry run fails before sending
  const proc = await json(
    await api.post('/api/processes', {
      data: {
        definition: {
          name: uniq('E2E create user'),
          connections: [{ slot: 'hub', kind: 'insights-hub' }],
          nodes: [
            { id: 'start', type: 'start', x: 0, y: 0 },
            {
              id: 'create',
              type: 'http',
              connection: 'hub',
              method: 'POST',
              path: '/api/identitymanagement/v3/Users',
              body: { userName: 'e2e@example.com' },
              x: 1,
              y: 0,
            },
          ],
          wires: [{ from: 'start', port: 'out', to: 'create' }],
        },
      },
    }),
  );
  await page.goto(`/processes/${proc.id}`);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  const run = page.getByRole('dialog', { name: /^Run: / });
  await run.getByRole('combobox', { name: /^Connection .hub/ }).click();
  await page.getByRole('option', { name: platform.name }).click();
  await run.getByTestId('identity-select-hub').click();
  await page.getByRole('option', { name: new RegExp(identityName) }).click();
  await chooseRunMode(run, 'Dry run');
  await expectAccessible(page, 'run dialog with an identity');
  await run.getByRole('button', { name: 'Start dry run' }).click();
  await expect(page).toHaveURL(/\/runs\/[^/]+$/);
  const runId = page.url().split('/').pop()!;
  const done = await waitForRun(api, runId, ['failed', 'succeeded']);
  expect(done.status).toBe('failed');
  expect(done.error).toMatch(/read-only/);
  expect(done.bindings.hub).toMatchObject({ identityId: identity.id, identityName });
  await page.getByRole('tab', { name: 'Inputs' }).click();
  await expect(page.getByRole('tabpanel')).toContainText(` · ${identityName}`);

  // MCP: the identity named in the call reads; it offers no changing operation
  await json(await api.put('/api/mcp-server', { data: { enabled: true } }));
  const token = (await json(await api.post('/api/me/tokens', { data: { name: uniq('E2E identity'), scope: 'mcp' } }))).token as string;
  const client = await pwRequest.newContext({ baseURL: baseURL(), storageState: { cookies: [], origins: [] } });
  try {
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await client.post('/api/mcp', {
        headers: { authorization: `Bearer ${token}`, 'mcp-protocol-version': '2025-06-18', accept: 'application/json, text/event-stream' },
        data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      });
      expect(res.ok()).toBeTruthy();
      return (await res.json()).result;
    };
    const list = await call('list_platforms', {});
    const item = list.structuredContent.items.find((x: { id: string }) => x.id === platform.id);
    expect(item.mcpIdentities).toEqual([{ name: identityName, default: false, mode: 'read', readOnly: true }]);
    const ops = await call('platform_find_operations', { platformId: platform.id, identity: identityName, query: 'users', limit: 50 });
    expect(ops.isError).toBeFalsy();
    expect(ops.structuredContent.items.length).toBeGreaterThan(0);
    expect(ops.structuredContent.items.every((o: { method: string }) => o.method === 'GET' || o.method === 'HEAD')).toBe(true);
    const listUsers = ops.structuredContent.items.find((o: { path: string; method: string }) => o.method === 'GET' && /\/Users$/.test(o.path));
    const users = await call('platform_call_operation', { platformId: platform.id, identity: identityName, operation: listUsers.operation });
    expect(users.isError).toBeFalsy();
    expect(JSON.stringify(users)).not.toContain('demo-secret');
  } finally {
    await client.dispose();
  }

  // a monitor check that reads with the identity: it runs, and the editor shows the choice
  const monitor = await json(
    await api.post('/api/monitors', {
      data: {
        definition: {
          name: uniq('E2E identity monitor'),
          checks: [{ id: 'users', name: 'Users', type: 'platform', platform: platform.id, identity: identityName, path: '/api/identitymanagement/v3/Users' }],
        },
      },
    }),
  );
  const monitorId = monitor.monitor?.id ?? monitor.id;
  const saved = await json(await api.get(`/api/monitors/${monitorId}`));
  expect(saved.definition.checks[0].identity).toBe(identity.id);
  const evaluated = await json(await api.post(`/api/monitors/${monitorId}/run`));
  expect(evaluated.checks[0].status).toBe('up');
  await page.goto(`/monitors/${monitorId}/edit`);
  await settle(page);
  await page.getByTestId('monitor-node-users').click();
  await expect(page.getByTestId('check-form').getByTestId('identity-select')).toHaveValue(new RegExp(identityName));
  const html = await page.content();
  for (const s of SECRETS) expect(html).not.toContain(s);
  await api.delete(`/api/monitors/${monitorId}`);
});

/**
 * Settings changed outside Steward: the confirmation dialog shows every identity with what confirming seals – since
 * 0.13.0 every identity is kept. The changed state cannot be made from a browser: the platform and the review are
 * answered by the test.
 */
async function withChangedSettings(page: Page, api: APIRequestContext, id: string) {
  const platform = await json(await api.get(`/api/platforms/${id}`));
  const review = {
    baseUrl: platform.baseUrl,
    integrity: 'mismatch',
    identities: [
      {
        id: platform.identities[0].id,
        name: 'Default',
        default: true,
        integrity: 'mismatch',
        mcp: { mode: 'read' },
        secretKeys: platform.secretKeys,
        variables: { port: '8443', region: 'eu-west' },
        signIn: { type: 'token_request', url: 'https://login.example.net/token' },
        flags: ['readOnly'],
        access: [],
        action: 'keep',
      },
      {
        id: 'pi_planted',
        name: 'Planted',
        default: false,
        integrity: 'unsealed',
        mcp: { mode: 'off' },
        secretKeys: [],
        variables: {},
        signIn: null,
        flags: [],
        access: ['user:mallory'],
        action: 'keep',
      },
    ],
  };
  const confirmed: string[] = [];
  await page.route(`**/api/platforms/${id}`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ json: { ...platform, integrity: 'mismatch' } });
  });
  await page.route(`**/api/platforms/${id}/confirm-config`, async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: review });
    confirmed.push(route.request().method());
    return route.fulfill({ json: platform });
  });
  return confirmed;
}

test('confirming changed settings lists every identity it keeps and seals', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const id = await platformId(api, 'insights-hub');
  const confirmed = await withChangedSettings(page, api, id);
  await page.goto(`/platforms/${id}`);
  await expect(page.getByText('Connection settings changed outside Steward')).toBeVisible();
  await page.getByRole('button', { name: 'I reviewed the settings – confirm' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Identity “Default” (Default)');
  await expect(dialog).toContainText('MCP clients: Read only');
  await expect(dialog).toContainText('Kept and sealed as shown');
  await expect(dialog).toContainText('Variables: port = 8443, region = eu-west');
  await expect(dialog).toContainText('Its own sign-in: token_request at https://login.example.net/token');
  await expect(dialog).toContainText('Flags: readOnly');
  await expect(dialog.getByTestId('confirm-identity-keep').last()).toContainText('Who may use it besides administrators and its owning teams: user:mallory');
  await expectAccessible(page, 'confirm changed platform settings');
  await dialog.getByTestId('confirm-dialog-confirm').click();
  await expect(page.getByText('Settings confirmed')).toBeVisible();
  expect(confirmed).toEqual(['POST']);
});

test('the confirmation of changed settings on a phone @mobile', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const id = await platformId(api, 'insights-hub');
  await withChangedSettings(page, api, id);
  await page.goto(`/platforms/${id}`);
  await page.getByRole('button', { name: 'I reviewed the settings – confirm' }).click();
  await expect(page.getByRole('dialog')).toContainText('Variables: port = 8443, region = eu-west');
  await expectNoHorizontalScroll(page);
  await expectAccessible(page, 'confirm changed platform settings (phone)');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
});
