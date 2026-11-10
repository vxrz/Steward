import fs from 'node:fs';
import type { Download, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { json, platformId } from './support/helpers';

/**
 * Postman export (#204): the download in the process editor's actions menu and on the platform page – a ZIP with
 * Postman's collection and environment, without the demo platforms' secrets.
 */

test.use({ storageState: authFile('olivia') });

/** Credential values of the simulated platforms (server/src/mock/mockPlatform.ts) */
const SECRETS = ['demo-secret', 'demo-client', 'demo-password'];

async function zipEntries(download: Download): Promise<string[]> {
  const data = fs.readFileSync((await download.path())!);
  expect(data.subarray(0, 4).toString('latin1')).toBe('PK\x03\x04');
  // the names in the central directory (signature 0x02014b50), stored as plain UTF-8
  const names: string[] = [];
  for (let i = data.indexOf('PK\x01\x02', 0, 'latin1'); i >= 0; i = data.indexOf('PK\x01\x02', i + 4, 'latin1')) {
    const len = data.readUInt16LE(i + 28);
    names.push(data.subarray(i + 46, i + 46 + len).toString('utf8'));
  }
  return names.sort();
}

async function processDownload(page: Page): Promise<Download> {
  await page.goto('/processes/ih-health-check');
  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toContainText('Platform health check');
  await page.getByTestId('detail-actions').click();
  const item = page.getByRole('menuitem', { name: /Export for Postman/ });
  await expect(item).toContainText('Collection and environment (ZIP), without secrets');
  const [download] = await Promise.all([page.waitForEvent('download'), item.click()]);
  return download;
}

async function platformDownload(page: Page): Promise<Download> {
  await page.goto('/platforms');
  await page.getByText('Insights Hub (demo)', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Insights Hub (demo)', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /Export for Postman/ }).click()]);
  return download;
}

test('process editor: Export for Postman downloads the collection and the environment', async ({ page, apiAs }) => {
  await page.goto('/processes/ih-health-check');
  await settle(page);
  // (no axe scan with the menu open: every Mantine menu fails aria-required-children there – not this item's doing)
  await expectAccessible(page, 'process editor with the actions menu button');
  const download = await processDownload(page);
  expect(download.suggestedFilename()).toBe('ih-health-check.postman.zip');
  expect(await zipEntries(download)).toEqual(['ih-health-check.postman_collection.json', 'ih-health-check.postman_environment.json']);

  // the same export as JSON: the requests in step order, the secrets as empty variables
  const api = await apiAs('olivia');
  // the demo Insights Hub named for the slot: other tests add platforms of the same kind, and with more than one the
  // export leaves a slot without a chosen platform unbound
  const process = await json<{ definition: { connections: { slot: string }[] } }>(await api.get('/api/processes/ih-health-check'));
  const bindings = `${process.definition.connections[0]!.slot}:${await platformId(api, 'insights-hub')}`;
  const collection = await json(await api.get(`/api/processes/ih-health-check/export/postman?file=collection&bindings=${bindings}`));
  expect(collection.item[0].item.map((i: { id: string }) => i.id)).toEqual(['idm', 'am']);
  const env = await json(await api.get(`/api/processes/ih-health-check/export/postman?file=environment&bindings=${bindings}`));
  expect(env.values).toContainEqual({ key: 'hub.clientSecret', value: '', type: 'secret', enabled: true });
  for (const s of SECRETS) expect(JSON.stringify([collection, env])).not.toContain(s);
});

test('platform page: Export for Postman downloads the environment and the API operations', async ({ page, apiAs }) => {
  const download = await platformDownload(page);
  expect(download.suggestedFilename()).toBe('Insights-Hub-demo.postman.zip');
  expect(await zipEntries(download)).toEqual(['Insights-Hub-demo.postman_collection.json', 'Insights-Hub-demo.postman_environment.json']);
  const api = await apiAs('olivia');
  const id = await platformId(api, 'insights-hub');
  const audit = await json<{ actor: string; entityId: string }[]>(await (await apiAs('admin')).get('/api/audit?action=platform.exported_postman&limit=20'));
  expect(audit.some((a) => a.actor === 'olivia' && a.entityId === id)).toBe(true);
});

test('on a phone both downloads are in the actions menus @mobile', async ({ page }) => {
  const p = await processDownload(page);
  expect(p.suggestedFilename()).toBe('ih-health-check.postman.zip');
  const f = await platformDownload(page);
  expect(f.suggestedFilename()).toBe('Insights-Hub-demo.postman.zip');
});
