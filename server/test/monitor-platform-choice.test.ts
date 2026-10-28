import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

// A monitor file names its platform ("platform: Insights Hub"). With several Insights Hub platforms
// ("Insights Hub (modev)", "Insights Hub (prod)") the name is not unique: the import and Git sync let
// the user choose the platform per reference instead of failing.
let s: TestServer;
let dagmar: Client;
let modev: { id: string }, prod: { id: string }, gatus: { id: string };
const EXAMPLE = '10-machine-17-machine-data.yaml';
const exampleYaml = () => fs.readFileSync(path.resolve(import.meta.dirname, '../../examples/monitors', EXAMPLE), 'utf8');

const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status: number }) => e.status,
  );
const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => '',
    (e: Error) => e.message,
  );
const platform = (name: string, kind: string) =>
  s.api('POST', '/platforms', { name, kind, baseUrl: s.base, config: { variables: {}, http: { proxy: 'none' }, auth: { type: 'none' } } });

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  modev = await platform('Insights Hub (modev)', 'insights-hub');
  prod = await platform('Insights Hub (prod)', 'insights-hub');
  gatus = await platform('Gatus', 'gatus');
  await s.api('POST', '/users', { username: 'dagmar', roles: ['designer'], password: 'Dagmar-password-123' });
  dagmar = await s.as('dagmar', 'Dagmar-password-123');
  // new accounts change their initial password first
  await dagmar('POST', '/auth/password', { current: 'Dagmar-password-123', next: 'Dagmar-password-456' });
}, 120_000);
afterAll(async () => {
  await s?.app.close();
  if (s) fs.rmSync(s.dataDir, { recursive: true, force: true });
});

const platformOfCheck = async (key: string, checkId: string) =>
  ((await s.api('GET', `/monitors/${key}`)).definition.checks as { id: string; platform?: string }[]).find((c) => c.id === checkId)?.platform;

describe('monitor import: choose the platform', () => {
  it('lists the reference with the platforms of its kind; the import needs a choice, then uses it', async () => {
    const { platforms } = await s.api('POST', `/monitors/examples/${EXAMPLE}/preview`);
    expect(platforms).toHaveLength(1);
    expect(platforms[0]).toMatchObject({ ref: 'Insights Hub', kind: 'insights-hub', resolved: null });
    expect(platforms[0].usedBy).toEqual([{ type: 'check', id: 'machine-ih', name: 'Machine data in Insights Hub' }]);
    expect(platforms[0].candidates.map((c: { name: string }) => c.name).sort()).toEqual(['Insights Hub (modev)', 'Insights Hub (prod)']);

    // without a choice: as before, the name is not unique
    expect(await status(s.api('POST', `/monitors/examples/${EXAMPLE}`, {}))).toBe(400);
    await s.api('POST', `/monitors/examples/${EXAMPLE}`, { platforms: { 'Insights Hub': modev.id } });
    expect(await platformOfCheck('machine-17-machine-data', 'machine-ih')).toBe(modev.id);
  });

  it('refuses a platform of another kind and one the user may not use', async () => {
    const yaml = exampleYaml().replaceAll('m17.', 'm17b.');
    expect(await codeOf(s.api('POST', '/monitors/import', { yaml, key: 'm17-kind', platforms: { 'Insights Hub': gatus.id } }))).toContain('not insights-hub');

    // prod is visible to the administrator only: not offered to Dagmar, and refused like a missing platform
    await s.api('PUT', `/platforms/${prod.id}/access`, { acl: [{ subject: 'user:admin', permissions: ['manage'] }] });
    const { platforms } = await dagmar('POST', '/monitors/import/preview', { yaml });
    expect(platforms[0].candidates.map((c: { id: string }) => c.id)).not.toContain(prod.id);
    expect(JSON.stringify(platforms)).not.toContain('Insights Hub (prod)');
    expect(await status(dagmar('POST', '/monitors/import', { yaml, key: 'm17-hidden', platforms: { 'Insights Hub': prod.id } }))).toBe(400);
    // she may only pick modev (the dialog preselects a single candidate); the name itself stays ambiguous
    expect(platforms[0].candidates.map((c: { id: string }) => c.id)).toEqual([modev.id]);
    await dagmar('POST', '/monitors/import', { yaml, key: 'm17-dagmar', platforms: { 'Insights Hub': modev.id } });
    expect(await platformOfCheck('m17-dagmar', 'machine-ih')).toBe(modev.id);
    await s.api('PUT', `/platforms/${prod.id}/access`, { acl: [] });
  });

  it('lists templates by a readable name instead of their parameter placeholder', async () => {
    const examples = (await s.api('GET', '/monitors/examples')) as { kind: string; name: string; description: string }[];
    const template = examples.find((e) => e.kind === 'monitorTemplate')!;
    expect(template.name).not.toContain('{{');
    expect(template.description).not.toContain('{{');
  });
});

describe('Git sync: choose the platform when accepting', () => {
  it('stages a monitor whose platform name is not unique, and accepts it once a platform is chosen', async () => {
    const repo = `team/monitors-${Date.now().toString(36)}`;
    await fetch(`${s.base}/mock/git/_commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo,
        // its own key and heartbeat keys: the example itself was imported above
        files: { [`steward/${EXAMPLE}`]: exampleYaml().replace('machine-17-machine-data', 'm17-from-git').replaceAll('m17.', 'm17git.') },
        signed: true,
      }),
    });
    const { source } = await s.api('POST', '/sync-sources', {
      name: 'Monitors',
      provider: 'forgejo',
      repoUrl: `${s.base}/mock/git/${repo}`,
      branch: 'main',
      folder: 'steward',
      kinds: ['monitor'],
    });
    await s.api('POST', `/sync-sources/${source.id}/fetch`);
    const [u] = (await s.api('GET', `/sync-updates?sourceId=${source.id}&status=pending`)) as { id: string }[];
    expect(u).toBeDefined();
    const detail = await s.api('GET', `/sync-updates/${u!.id}`);
    expect(detail.platforms).toHaveLength(1);
    expect(detail.platforms[0]).toMatchObject({ ref: 'Insights Hub', resolved: null });

    expect(await codeOf(s.api('POST', `/sync-updates/${u!.id}/accept`, {}))).toContain('Choose the platform');
    await s.api('POST', `/sync-updates/${u!.id}/accept`, { platforms: { 'Insights Hub': prod.id } });
    expect(await platformOfCheck('m17-from-git', 'machine-ih')).toBe(prod.id);
  });
});
