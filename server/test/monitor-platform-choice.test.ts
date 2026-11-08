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

  it('offers every platform for a freshness check that reads an API (the kind descriptors, 0.11)', async () => {
    const yaml = [
      'kind: monitor',
      'name: API data',
      'checks:',
      '  - id: api-data',
      '    name: API data',
      '    type: freshness',
      '    source: platform',
      '    platform: Some API',
      '    path: /data',
      '    timestamp: ts',
      '    mode: maxAge',
      '    maxAgeSeconds: 600',
    ].join('\n');
    const { platforms } = await s.api('POST', '/monitors/import/preview', { yaml });
    expect(platforms[0]).toMatchObject({ ref: 'Some API', kind: null });
    expect(platforms[0].candidates.map((c: { id: string }) => c.id)).toContain(gatus.id);
    await s.api('POST', '/monitors/import', { yaml, key: 'api-data', platforms: { 'Some API': gatus.id } });
    expect(await platformOfCheck('api-data', 'api-data')).toBe(gatus.id);
  });

  it('offers only platforms of a kind the check reads – also one of several – and refuses another one before saving (0.11)', async () => {
    const forge = await platform('Forge', 'forgejo');
    const yaml = (ref: string) =>
      [
        'kind: monitor',
        `name: Pipelines ${ref}`,
        'checks:',
        '  - id: pipe',
        '    name: Pipeline',
        '    type: git',
        `    platform: ${ref}`,
        '    repository: acme/shop',
      ].join('\n');
    const { platforms } = await s.api('POST', '/monitors/import/preview', { yaml: yaml('Code') });
    expect(platforms[0]).toMatchObject({ ref: 'Code', kind: null, kinds: ['github', 'gitlab', 'forgejo'] });
    const offered = platforms[0].candidates.map((c: { id: string }) => c.id);
    expect(offered).toContain(forge.id);
    expect(offered).not.toContain(gatus.id);
    expect(offered).not.toContain(modev.id);
    // a choice of another kind: refused before the monitor is saved
    const chosen = await s.api('POST', '/monitors/import', { yaml: yaml('Code'), key: 'pipes-kind', platforms: { Code: gatus.id } }).catch((e) => e);
    expect(chosen.body).toMatchObject({
      code: 'PLATFORM_CHOICE_KIND',
      params: { ref: 'Code', name: 'Gatus', kinds: ['github', 'gitlab', 'forgejo'], context: 'several' },
    });
    // a file that names a platform of another kind by its id: refused when saving
    const named = await s.api('POST', '/monitors/import', { yaml: yaml(gatus.id), key: 'pipes-id' }).catch((e) => e);
    expect(named.body).toMatchObject({ code: 'CHECK_PLATFORM_KIND', params: { check: 'pipe', type: 'git', name: 'Gatus', kind: 'gatus' } });
    await s.api('POST', '/monitors/import', { yaml: yaml('Code'), key: 'pipes-ok', platforms: { Code: forge.id } });
    expect(await platformOfCheck('pipes-ok', 'pipe')).toBe(forge.id);
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
    // only Insights Hub platforms are offered; another kind is refused before anything is saved (0.11)
    expect(detail.platforms[0].candidates.map((c: { id: string }) => c.id)).not.toContain(gatus.id);
    const wrong = await s.api('POST', `/sync-updates/${u!.id}/accept`, { platforms: { 'Insights Hub': gatus.id } }).catch((e) => e);
    expect(wrong.body).toMatchObject({ code: 'PLATFORM_CHOICE_KIND', params: { kind: 'insights-hub', name: 'Gatus' } });
    await s.api('POST', `/sync-updates/${u!.id}/accept`, { platforms: { 'Insights Hub': prod.id } });
    expect(await platformOfCheck('m17-from-git', 'machine-ih')).toBe(prod.id);
  });

  it('asks for a platform when a check names one of another kind by its id – also one of several kinds (0.11)', async () => {
    const forge = await platform('Forge (sync)', 'forgejo');
    const repo = `team/kinds-${Date.now().toString(36)}`;
    const file = [
      'kind: monitor',
      'key: git-from-git',
      'name: Pipeline from Git',
      'checks:',
      '  - id: pipe',
      '    name: Pipeline',
      '    type: git',
      `    platform: ${modev.id}`,
      '    repository: acme/shop',
    ].join('\n');
    await fetch(`${s.base}/mock/git/_commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo, files: { 'steward/gatus.yaml': file }, signed: true }),
    });
    const { source } = await s.api('POST', '/sync-sources', {
      name: 'Kinds',
      provider: 'forgejo',
      repoUrl: `${s.base}/mock/git/${repo}`,
      branch: 'main',
      folder: 'steward',
      kinds: ['monitor'],
    });
    await s.api('POST', `/sync-sources/${source.id}/fetch`);
    const [u] = (await s.api('GET', `/sync-updates?sourceId=${source.id}&status=pending`)) as { id: string }[];
    const detail = await s.api('GET', `/sync-updates/${u!.id}`);
    // the id resolves to nothing the check may read: no candidate of another kind is offered
    expect(detail.platforms[0]).toMatchObject({ ref: modev.id, kind: null, kinds: ['github', 'gitlab', 'forgejo'], resolved: null });
    const offered = detail.platforms[0].candidates.map((c: { id: string }) => c.id);
    expect(offered).toContain(forge.id);
    expect(offered).not.toContain(modev.id);
    expect(offered).not.toContain(gatus.id);
    // so accepting it as it is asks for a choice first, before anything is saved
    const refused = await s.api('POST', `/sync-updates/${u!.id}/accept`, {}).catch((e) => e);
    expect(refused.body).toMatchObject({ code: 'SYNC_PLATFORM_CHOICE_NEEDED', params: { refs: modev.id } });
    expect((await s.api('GET', '/monitors')).some((m: { key: string }) => m.key === 'git-from-git')).toBe(false);
    const wrong = await s.api('POST', `/sync-updates/${u!.id}/accept`, { platforms: { [modev.id]: gatus.id } }).catch((e) => e);
    expect(wrong.body).toMatchObject({ code: 'PLATFORM_CHOICE_KIND', params: { context: 'several' } });
    await s.api('POST', `/sync-updates/${u!.id}/accept`, { platforms: { [modev.id]: forge.id } });
    expect(await platformOfCheck('git-from-git', 'pipe')).toBe(forge.id);
  });
});
