import { request as pwRequest } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile, baseURL } from './support/env';
import { json } from './support/helpers';
import { expectAccessible } from './support/axe';

test.use({ storageState: authFile('admin') });

/**
 * A control catalogue proposed by an AI assistant (#74): it waits under AI requests, the administrator compares it with
 * the catalogue, edits a control, leaves one out and accepts the rest.
 */
test('an administrator reviews, edits and partly accepts a catalogue an assistant proposed', async ({ page, apiAs }) => {
  const admin = await apiAs('admin');
  const dana = await apiAs('dana');
  await admin.put('/api/mcp-server', { data: { enabled: true, controlProposals: true } });
  const token = (await json<{ token: string }>(await dana.post('/api/me/tokens', { data: { name: 'e2e proposals', scope: 'mcp' } }))).token;
  const key = `E2E${Date.now().toString(36).toUpperCase()}`;
  const client = await pwRequest.newContext({ baseURL: baseURL(), storageState: { cookies: [], origins: [] } });
  let requestId: string;
  try {
    const res = await client.post('/api/mcp', {
      headers: {
        authorization: `Bearer ${token}`,
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'propose_control_catalogue',
        accept: 'application/json, text/event-stream',
      },
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'propose_control_catalogue',
          arguments: {
            key,
            name: 'E2E company policy',
            version: '1.0',
            controls: [
              { ref: 'POL-1', title: 'Access is reviewed quarterly', description: 'Owners review access every quarter.' },
              { ref: 'POL-2', title: 'Backups are tested', description: '' },
              { ref: 'POL-3', title: 'Not really a control', description: '' },
            ],
            reason: 'Converted from the E2E policy document',
          },
          _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} },
        },
      },
    });
    requestId = (await json<{ result: { structuredContent: { requestId: string } } }>(res)).result.structuredContent.requestId;
  } finally {
    await client.dispose();
  }

  await page.goto(`/mcp-requests/${requestId}`);
  await expect(page.getByText(`${key} – E2E company policy`).first()).toBeVisible();
  await expect(page.getByText('Creates a new catalogue.')).toBeVisible();
  await expect(page.getByText('3 new')).toBeVisible();
  await expectAccessible(page, 'catalogue proposal');
  // edit POL-1, leave POL-3 out
  await page.getByRole('button', { name: 'Edit POL-1' }).click();
  await page.getByRole('textbox', { name: 'Title of POL-1' }).fill('Access is reviewed every quarter');
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('checkbox', { name: 'Accept POL-3' }).uncheck();
  await page.getByRole('button', { name: 'Accept 2 entries' }).click();
  await expect(page.getByText(`Catalogue ${key}: 2 added, 0 changed, 0 removed.`)).toBeVisible();

  const controls = await json<{ ref: string; title: string }[]>(await admin.get(`/api/compliance/controls?catalogue=${key}`));
  expect(controls.map((c) => [c.ref, c.title])).toEqual([
    ['POL-1', 'Access is reviewed every quarter'],
    ['POL-2', 'Backups are tested'],
  ]);
});
