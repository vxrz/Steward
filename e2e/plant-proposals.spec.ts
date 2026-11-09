import { request as pwRequest, type APIRequestContext } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile, baseURL } from './support/env';
import { json, expectNoHorizontalScroll } from './support/helpers';
import { expectAccessible } from './support/axe';

/**
 * The plant registry, 0.12.0: changes an AI assistant proposes wait under AI requests – a person sees what they add and
 * change, field by field, confirms a preview that changed since, and applies them; and a derived device profile shows
 * an inherited description with where it comes from, describes it anew and goes back to the inherited one. On a desktop
 * and on a phone, with axe. Every test makes its own invented records.
 */

const SETTINGS = { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} };
const ok = async (p: Promise<{ ok(): boolean; text(): Promise<string> }>) => {
  const r = await p;
  expect(r.ok(), await r.text()).toBe(true);
};

async function plantOn(admin: APIRequestContext) {
  await ok(admin.put('/api/settings/plant', { data: SETTINGS }));
  await ok(admin.put('/api/mcp-server', { data: { enabled: true } }));
}

/** A base profile with descriptions and a profile that extends it (ids unique per test). */
async function profiles(api: APIRequestContext, tag: string) {
  const base = `e2e-pbase-${tag}`;
  const child = `e2e-pchild-${tag}`;
  await ok(
    api.post('/api/plant/profiles', {
      data: {
        id: base,
        name: `E2E described base ${tag}`,
        description: 'A press controller with an OPC UA server.',
        interfaces: [
          {
            id: 'opc',
            name: 'OPC UA server',
            protocol: 'opc_ua',
            description: 'The controller’s own OPC UA server.',
            groups: [{ name: 'State', description: 'Machine state.', dataPoints: [{ id: 'running', name: 'Running', address: 'ns=2;s=Running' }] }],
          },
        ],
      },
    }),
  );
  await ok(api.post('/api/plant/profiles', { data: { id: child, name: `E2E described child ${tag}`, extends: base } }));
  return { base, child, baseName: `E2E described base ${tag}`, childName: `E2E described child ${tag}` };
}

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
    const body = await json<{ result: { isError?: boolean; structuredContent: { requestId: string }; content: { text: string }[] } }>(res);
    expect(body.result.isError ?? false, body.result.content?.[0]?.text).toBe(false);
    return body.result.structuredContent;
  } finally {
    await client.dispose();
  }
}

for (const tag of ['', ' @mobile'])
  test.describe(`plant proposals and descriptions${tag}`, () => {
    test.describe('in the AI requests', () => {
      test.use({ storageState: authFile('admin') });

      test('an administrator reviews what an assistant proposes, field by field, and applies it', async ({ page, apiAs }, info) => {
        const admin = await apiAs('admin');
        const dana = await apiAs('dana');
        await plantOn(admin);
        const f = await profiles(dana, `${info.project.name}-${Date.now()}`);
        const token = (await json<{ token: string }>(await dana.post('/api/me/tokens', { data: { name: `e2e plant ${f.child}`, scope: 'mcp' } }))).token;
        const { requestId } = await mcpCall(token, 'propose_plant_changes', {
          title: 'Describe the second generation',
          rationale: 'From the vendor’s release notes (example)',
          document: {
            version: 1,
            device_profile: {
              id: f.child,
              name: f.childName,
              extends: f.base,
              description: 'The second generation of the press controller.',
              interfaces: [{ id: 'opc', groups: [{ name: 'State', data_points: [{ id: 'running', address: 'ns=3;s=Running' }] }] }],
            },
          },
        });

        await page.goto(`/mcp-requests/${requestId}`);
        const review = page.getByTestId('plant-proposal');
        await expect(review).toContainText('Describe the second generation');
        await expect(page.getByText('From the vendor’s release notes (example)')).toBeVisible();
        const changed = review.getByTestId('plant-proposal-preview-changed');
        await expect(changed).toContainText('Changed (1 entry)');
        await expect(changed.getByTestId('field-diffs')).toContainText('The second generation of the press controller.');
        await expect(changed.getByTestId('field-diffs')).toContainText('pointOverrides[running]');
        await expect(changed.getByTestId('field-diffs')).toContainText('ns=3;s=Running');
        await expect(changed.getByTestId('field-diffs')).not.toContainText('name');
        await expectAccessible(page, 'plant proposal');
        await expectNoHorizontalScroll(page);
        await page.getByRole('button', { name: 'Accept 1 entry' }).click();
        await expect(page.getByText('0 added, 1 changed.')).toBeVisible();
        const after = await json<{ description: string; interfaces: { groups: { dataPoints: { address: string }[] }[] }[] }>(
          await dana.get(`/api/plant/profiles/${f.child}`),
        );
        expect(after.description).toBe('The second generation of the press controller.');
        expect(after.interfaces[0]!.groups[0]!.dataPoints[0]!.address).toBe('ns=3;s=Running');
      });

      test('an assistant documents a gateway end to end: a data collection with its items and a sink', async ({ page, apiAs }, info) => {
        const admin = await apiAs('admin');
        const dana = await apiAs('dana');
        await plantOn(admin);
        const f = await profiles(dana, `${info.project.name}-${Date.now()}g`);
        const asset = `e2e-passet-${f.child}`.slice(0, 80);
        await ok(dana.post('/api/plant/assets', { data: { id: asset, siteId: 'riverside', name: `E2E press ${f.child}` } }));
        await ok(dana.put(`/api/plant/assets/${asset}/assignment`, { data: { profileId: f.child, interfaces: [{ interface: 'opc', active: true }] } }));
        const token = (await json<{ token: string }>(await dana.post('/api/me/tokens', { data: { name: `e2e plant g ${f.child}`, scope: 'mcp' } }))).token;
        const { requestId } = await mcpCall(token, 'propose_plant_changes', {
          title: 'Edge gateway of the press',
          rationale: 'From the gateway’s exported configuration (example)',
          document: {
            version: 1,
            asset_networks: [
              {
                asset,
                collections: [
                  {
                    id: 'edge',
                    name: 'Edge gateway',
                    collector: { kind: 'job', ref: 'example-edge-gateway' },
                    interface: 'opc',
                    mode: 'on_change',
                    items: [
                      { address: 'ns=2;s=Running', output_name: 'PressRunning', data_point: 'running', description: 'For the availability KPI' },
                      { address: 'ns=2;s=Pressure', output_name: 'Pressure' },
                    ],
                  },
                ],
                collection_sinks: [
                  {
                    collection: 'edge',
                    sinks: [
                      { id: 'broker', name: 'Broker', object: 'plant/press', transforms: [{ kind: 'rename', field: 'PressRunning', expression: 'running' }] },
                    ],
                  },
                ],
              },
            ],
          },
        });

        await page.goto(`/mcp-requests/${requestId}`);
        const review = page.getByTestId('plant-proposal');
        const added = review.getByTestId('plant-proposal-preview-added');
        await expect(added).toContainText('Data collection');
        await expect(added).toContainText('Edge gateway');
        await expect(review.getByTestId('plant-proposal-preview-changed')).toContainText('Sinks of a data collection');
        await expectAccessible(page, 'plant proposal with a collection');
        await expectNoHorizontalScroll(page);
        await page.getByRole('button', { name: 'Accept 2 entries' }).click();
        await expect(page.getByText('1 added, 1 changed.')).toBeVisible();
        const c = await json<{ items: { dataPoint: string | null }[]; sinks: { id: string }[] }>(await dana.get(`/api/plant/assets/${asset}/collections/edge`));
        expect(c.items.map((i) => i.dataPoint)).toEqual(['running', null]);
        expect(c.sinks.map((x) => x.id)).toEqual(['broker']);
        await dana.delete(`/api/plant/assets/${asset}?cascade=true`);
      });

      test('a preview that changed since the proposal is confirmed before it is applied', async ({ page, apiAs }, info) => {
        const admin = await apiAs('admin');
        const dana = await apiAs('dana');
        await plantOn(admin);
        const f = await profiles(dana, `${info.project.name}-${Date.now()}c`);
        const token = (await json<{ token: string }>(await dana.post('/api/me/tokens', { data: { name: `e2e plant c ${f.child}`, scope: 'mcp' } }))).token;
        const { requestId } = await mcpCall(token, 'propose_plant_changes', {
          title: 'Describe the base',
          rationale: 'From the vendor’s manual (example)',
          document: { version: 1, device_profile: { id: f.base, name: f.baseName, description: 'A press controller, firmware 1.' } },
        });
        // the registry changes in the meantime
        const base = await json<Record<string, unknown>>(await dana.get(`/api/plant/profiles/${f.base}`));
        await ok(dana.put(`/api/plant/profiles/${f.base}`, { data: { ...(base.own as object), id: undefined, description: 'Changed by hand.' } }));

        await page.goto(`/mcp-requests/${requestId}`);
        const since = page.getByTestId('plant-proposal-changed-since');
        await expect(since).toBeVisible();
        const apply = page.getByRole('button', { name: /^Accept/ });
        await expect(apply).toBeDisabled();
        await expectAccessible(page, 'plant proposal changed since');
        await since.getByTestId('plant-proposal-confirm').check();
        await expect(page.getByRole('button', { name: 'Accept 1 entry' })).toBeEnabled();
        await page.getByRole('button', { name: 'Accept 1 entry' }).click();
        await expect(page.getByText('0 added, 1 changed.')).toBeVisible();
        expect((await json<{ description: string }>(await dana.get(`/api/plant/profiles/${f.base}`))).description).toBe('A press controller, firmware 1.');
      });
    });

    test.describe('on a derived profile', () => {
      test.use({ storageState: authFile('dana') });

      test('an inherited description says where it comes from, is described anew and goes back', async ({ page, apiAs }, info) => {
        await plantOn(await apiAs('admin'));
        const f = await profiles(await apiAs('dana'), `${info.project.name}-${Date.now()}d`);
        await page.goto(`/plant/profiles/${f.child}`);
        const desc = page.getByTestId('profile-description');
        await expect(desc).toContainText('A press controller with an OPC UA server.');
        await expect(desc.getByTestId('description-inherited')).toContainText('Inherited from E2E described base');
        const ifaceDesc = page.getByTestId('interface-description-opc');
        await expect(ifaceDesc.getByTestId('description-inherited')).toBeVisible();
        await expectAccessible(page, 'inherited descriptions');
        await expectNoHorizontalScroll(page);
        // described anew here
        await ifaceDesc.getByRole('button', { name: 'Describe it here' }).click();
        const dialog = page.getByRole('dialog', { name: 'Description of OPC UA server' });
        await dialog.getByRole('textbox', { name: 'Description' }).fill('The OPC UA server of the second generation.');
        await expectAccessible(page, 'description dialog');
        await dialog.getByRole('button', { name: 'Save' }).click();
        await expect(dialog).toBeHidden();
        await expect(ifaceDesc).toContainText('The OPC UA server of the second generation.');
        await expect(ifaceDesc.getByTestId('description-changed')).toBeVisible();
        await expect(ifaceDesc.getByTestId('description-inherited')).toHaveCount(0);
        // and back to the inherited one
        await ifaceDesc.getByRole('button', { name: 'Back to the inherited description' }).click();
        await expect(ifaceDesc).toContainText('The controller’s own OPC UA server.');
        await expect(ifaceDesc.getByTestId('description-inherited')).toBeVisible();
        // the group's description, too
        const group = page.getByTestId('group-description-opc-State');
        await group.getByRole('button', { name: 'Describe it here' }).click();
        const g = page.getByRole('dialog', { name: 'Description of State' });
        await g.getByRole('textbox', { name: 'Description' }).fill('Machine state, second generation.');
        await g.getByRole('button', { name: 'Save' }).click();
        await expect(group).toContainText('Machine state, second generation.');
        await expect(group.getByTestId('description-changed')).toBeVisible();
      });
    });
  });
