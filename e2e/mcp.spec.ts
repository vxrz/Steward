import AxeBuilder from '@axe-core/playwright';
import { request as pwRequest, type Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile, baseURL } from './support/env';
import { json, uniq } from './support/helpers';

test.use({ storageState: authFile('admin') });

async function expectAccessible(page: Page, name: string) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const bad = result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.help} ${v.nodes.map((n) => n.html.slice(0, 200)).join(' | ')}`);
  expect(bad, `accessibility violations on ${name}`).toEqual([]);
}

test('MCP server: turn it on, create an MCP token with its client configuration, connect', async ({ page }) => {
  await page.goto('/settings/security');
  const card = page.locator('.mantine-Card-root').filter({ has: page.getByRole('heading', { name: 'MCP server (AI assistants)' }) });
  const toggle = card.getByRole('switch', { name: 'Turn on the MCP server' });
  if (!(await toggle.isChecked())) {
    await card.getByText('Turn on the MCP server', { exact: true }).click(); // Mantine hides the input behind its label
    await expect(page.getByText('MCP server turned on')).toBeVisible();
  }
  await expect(toggle).toBeChecked();
  await expect(card.getByText(`${baseURL()}/api/mcp`)).toBeVisible();
  // ready-to-copy configuration: stdio bridge for desktop clients, HTTP with a bearer header
  await expect(card.getByText('"mcpServers"')).toBeVisible();
  await expect(card.getByText('"--api-key-file"')).toBeVisible();
  await card.getByText('HTTP', { exact: true }).click();
  await expect(card.getByText('"type": "http"')).toBeVisible();
  await expect(card.getByText('Bearer ${input:steward-mcp-token}')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Copy: HTTP' })).toBeVisible();
  await expectAccessible(page, 'settings with the MCP card');

  // a token with scope "MCP client" shows the configuration with the real token, once
  await page.goto('/profile');
  await page.getByRole('button', { name: 'New token' }).click();
  const create = page.getByRole('dialog', { name: 'New API token' });
  await create.getByRole('textbox', { name: 'Name' }).fill(uniq('E2E assistant'));
  await create.getByText('MCP client', { exact: true }).click();
  await expect(create.getByText(/Only for AI assistants/)).toBeVisible();
  await create.getByRole('button', { name: 'Create token' }).click();
  const shown = page.getByRole('dialog', { name: 'Token created' });
  await expect(shown.getByText('Put it into your MCP client:')).toBeVisible();
  const token = (await shown.getByText(/^smt_/).first().innerText()).trim();
  await shown.getByText('HTTP', { exact: true }).click();
  await expect(shown.getByText(`"Authorization": "Bearer ${token}"`)).toBeVisible();
  await shown.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'MCP client' }).first()).toBeVisible();

  // the endpoint answers an MCP client with that token – and nothing else accepts it
  const client = await pwRequest.newContext({ baseURL: baseURL(), storageState: { cookies: [], origins: [] } });
  try {
    const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
    const res = await client.post('/api/mcp', {
      headers: {
        authorization: `Bearer ${token}`,
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/list',
        accept: 'application/json, text/event-stream',
      },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta } },
    });
    const body = await json<{ result: { tools: { name: string }[] } }>(res);
    expect(body.result.tools.map((t) => t.name)).toContain('search_processes');
    expect((await client.get('/api/v1/runs', { headers: { authorization: `Bearer ${token}` } })).status()).toBe(403);
  } finally {
    await client.dispose();
  }
});

test('platform: turn on the read-only MCP gateway (manage right), operators only see it', async ({ page, apiAs, loginAs }) => {
  const api = await apiAs('admin');
  const name = uniq('E2E gateway');
  const p = await json<{ id: string }>(
    await api.post('/api/platforms', {
      data: { name, kind: 'generic', baseUrl: `${baseURL()}/mock/test`, config: { auth: { type: 'none' }, variables: {}, http: { proxy: 'none' } } },
    }),
  );
  try {
    await page.goto(`/platforms/${p.id}`);
    await page.getByRole('tab', { name: 'MCP' }).click();
    const toggle = page.getByRole('switch', { name: 'Allow access for MCP clients' });
    await expect(toggle).not.toBeChecked();
    await expect(page.getByText(/0 read operations and \d+ changing operations/)).toBeVisible();
    await page.getByText('Allow access for MCP clients', { exact: true }).click();
    await expect(toggle).toBeChecked();
    await page.getByRole('textbox', { name: /Allowed GET path prefixes/ }).fill('/echo-headers');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('MCP gateway saved')).toBeVisible();
    const saved = await json<{ config: { mcpGateway?: { enabled: boolean; allowedPathPrefixes?: string[] } } }>(await api.get(`/api/platforms/${p.id}`));
    expect(saved.config.mcpGateway).toEqual({ enabled: true, allowedPathPrefixes: ['/echo-headers'] });
    await expectAccessible(page, 'platform MCP tab');

    // an operator ("use", no "manage") sees the setting but cannot change it
    const op = await loginAs('olivia');
    await op.goto(`/platforms/${p.id}`);
    await op.getByRole('tab', { name: 'MCP' }).click();
    await expect(op.getByRole('switch', { name: 'Allow access for MCP clients' })).toBeChecked();
    await expect(op.getByRole('switch', { name: 'Allow access for MCP clients' })).toBeDisabled();
    await expect(op.getByRole('button', { name: 'Save' })).toHaveCount(0);
  } finally {
    await api.delete(`/api/platforms/${p.id}`);
  }
});
