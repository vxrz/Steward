import { request as pwRequest, type APIRequestContext } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile, baseURL } from './support/env';
import { json, expectNoHorizontalScroll } from './support/helpers';
import { expectAccessible } from './support/axe';

/**
 * The plant registry, 0.17.0: an assistant reads a manual and proposes a device profile's data points in two parts,
 * each data point with its source. The review lists the sources by document, offers to attach the manual on the
 * profile's Documents panel – or names the record that keeps it – and the profile's data points show their source once
 * applied. On a desktop and on a phone, with axe. Every test makes its own invented records.
 */

const SETTINGS = { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} };
const MANUAL = 'C80 Operating Manual v4';
const ok = async (p: Promise<{ ok(): boolean; text(): Promise<string> }>) => {
  const r = await p;
  expect(r.ok(), await r.text()).toBe(true);
};

/** A tool call of an MCP client with the token (no browser session). */
async function mcpCall(token: string, name: string, args: Record<string, unknown>) {
  const client = await pwRequest.newContext({ baseURL: baseURL(), storageState: { cookies: [], origins: [] } });
  try {
    const res = await client.post('/api/mcp', {
      headers: {
        authorization: `Bearer ${token}`,
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': name,
        accept: 'application/json, text/event-stream',
      },
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name,
          arguments: args,
          _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} },
        },
      },
    });
    const body = await json<{ result: { isError?: boolean; structuredContent: { requestId: string; proposalId?: string }; content: { text: string }[] } }>(res);
    expect(body.result.isError ?? false, body.result.content?.[0]?.text).toBe(false);
    return body.result.structuredContent;
  } finally {
    await client.dispose();
  }
}

const point = (id: string, name: string, page: string) => ({
  id,
  name,
  data_type: 'Double',
  address: `ns=3;s=/C80/${id}`,
  source: { document: MANUAL, page, section: '6.3 OPC UA variables' },
});

/** A profile with one data point (no source) and an MCP token of dana's. */
async function prepare(admin: APIRequestContext, dana: APIRequestContext, tag: string) {
  await ok(admin.put('/api/settings/plant', { data: SETTINGS }));
  await ok(admin.put('/api/mcp-server', { data: { enabled: true } }));
  const id = `e2e-c80-${tag}`.toLowerCase().replace(/[^a-z0-9.-]+/g, '-');
  const name = `E2E Example Controls C80 ${tag}`;
  await ok(
    dana.post('/api/plant/profiles', {
      data: {
        id,
        name,
        interfaces: [
          {
            id: 'opc',
            name: 'OPC UA server',
            protocol: 'opc_ua',
            groups: [{ name: 'State', dataPoints: [{ id: 'running', name: 'Running', address: 'ns=3;s=Running' }] }],
          },
        ],
      },
    }),
  );
  const token = (await json<{ token: string }>(await dana.post('/api/me/tokens', { data: { name: `e2e sources ${id}`, scope: 'mcp' } }))).token;
  return { id, name, token };
}

/** The assistant's proposal in two parts: the existing data point with two new ones, then a group more. */
async function proposeInParts(f: { id: string; name: string; token: string }) {
  const part = (groups: unknown[]) => ({
    version: 1,
    device_profile: { id: f.id, name: f.name, interfaces: [{ id: 'opc', name: 'OPC UA server', protocol: 'opc_ua', groups }] },
  });
  const first = await mcpCall(f.token, 'propose_plant_changes', {
    title: 'C80 data points from the manual',
    rationale: `Read from the ${MANUAL} (example)`,
    more: true,
    document: part([
      {
        name: 'State',
        data_points: [{ id: 'running', name: 'Running', address: 'ns=3;s=Running' }, point('alarm_count', 'Alarm count', '102')],
      },
    ]),
  });
  const last = await mcpCall(f.token, 'propose_plant_changes', {
    proposalId: first.proposalId,
    document: part([{ name: 'Spindle', data_points: [point('spindle_speed', 'Spindle speed', '112')] }]),
  });
  expect(last.requestId).toBe(first.proposalId);
  return last.requestId;
}

for (const tag of ['', ' @mobile'])
  test.describe(`plant proposal sources${tag}`, () => {
    test.use({ storageState: authFile('admin') });

    test('the review lists where the data points come from and offers to attach the manual', async ({ page, apiAs }, info) => {
      const admin = await apiAs('admin');
      const dana = await apiAs('dana');
      const f = await prepare(admin, dana, `${info.project.name}-${Date.now()}`);
      const requestId = await proposeInParts(f);

      await page.goto(`/mcp-requests/${requestId}`);
      const review = page.getByTestId('plant-proposal');
      await expect(review.getByTestId('plant-proposal-parts')).toContainText('Sent in 2 parts');
      const sources = review.getByTestId('plant-proposal-sources');
      await expect(sources).toContainText('Sources (2 data points)');
      const doc = sources.getByTestId('plant-proposal-source-doc');
      await expect(doc).toContainText(MANUAL);
      await expect(doc).toContainText(`Device profile ${f.name}`);
      await expect(doc.getByTestId('plant-proposal-source-points')).toContainText('Spindle speed');
      await expect(doc.getByTestId('plant-proposal-source-points')).toContainText('p. 112 · 6.3 OPC UA variables');
      await expect(doc.getByTestId('plant-proposal-source-points')).not.toContainText('Running');
      const attach = doc.getByTestId('plant-proposal-attach').getByRole('link', { name: 'Attach the manual' });
      await expect(attach).toHaveAttribute('href', /#plant-docs-device-profile$/);
      expect((await attach.getAttribute('href')) ?? '').toContain(`/plant/profiles/${f.id}#`);
      await expectAccessible(page, 'plant proposal sources');
      await expectNoHorizontalScroll(page);

      // the manual kept as a record linked to the profile: the review names it
      const rec = await json<{ id: string; number: string }>(
        await dana.post('/api/records', { data: { type: 'DOC', title: MANUAL, links: [{ kind: 'device-profile', id: f.id, note: '' }] } }),
      );
      await page.reload();
      const kept = page.getByTestId('plant-proposal-source-record');
      await expect(kept).toContainText('Kept in Steward:');
      await expect(kept.getByRole('link', { name: `${rec.number} ${MANUAL}` })).toBeVisible();
      await expect(page.getByTestId('plant-proposal-attach')).toHaveCount(0);

      await page.getByRole('button', { name: 'Accept 1 entry' }).click();
      await expect(page.getByText('0 added, 1 changed.')).toBeVisible();

      // the profile's data points show their source
      await page.goto(`/plant/profiles/${f.id}`);
      const sourceLines = page.getByTestId('point-source');
      await expect(sourceLines.filter({ hasText: 'p. 112' })).toContainText(`${MANUAL} · p. 112 · 6.3 OPC UA variables`);
      await expect(sourceLines).toHaveCount(2);
      await expectAccessible(page, 'profile with sources');
      await expectNoHorizontalScroll(page);
      await page.goto(`/plant/profiles/${f.id}/points/spindle_speed`);
      await expect(page.getByTestId('point-source-view')).toContainText(`${MANUAL} · p. 112 · 6.3 OPC UA variables`);
    });

    test('an unfinished proposal shows only its parts so far, to its owner', async ({ apiAs, browser }, info) => {
      const admin = await apiAs('admin');
      const dana = await apiAs('dana');
      const f = await prepare(admin, dana, `${info.project.name}-${Date.now()}u`);
      const first = await mcpCall(f.token, 'propose_plant_changes', {
        title: 'C80 data points, first part',
        rationale: `Read from the ${MANUAL} (example)`,
        more: true,
        document: {
          version: 1,
          device_profile: {
            id: f.id,
            name: f.name,
            interfaces: [{ id: 'opc', groups: [{ name: 'Axes', data_points: [point('x_pos', 'X position', '120')] }] }],
          },
        },
      });
      const ctx = await browser.newContext({ storageState: authFile('dana'), baseURL: baseURL() });
      try {
        const page = await ctx.newPage();
        await page.goto(`/mcp-requests/${first.proposalId}`);
        await expect(page.getByTestId('plant-proposal-incomplete')).toContainText('still sending this proposal in parts: 1 part');
        await expect(page.getByRole('button', { name: /^Accept/ })).toHaveCount(0);
        await expectAccessible(page, 'unfinished plant proposal');
      } finally {
        await ctx.close();
      }
      await ok(dana.post(`/api/mcp-requests/${first.proposalId}/decision`, { data: { approve: false, comment: '' } }));
    });
  });
