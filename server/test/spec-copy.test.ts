import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Copying an API specification to other platforms of the same kind (e.g. one Insights Hub tenant to the next):
 * each target gets its own, independent spec – platforms of one kind can run different API versions.
 */
let s: TestServer;
let demoPassword: string;
let n = 0;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  demoPassword = (await s.api('POST', '/demo/setup', {})).password;
});
afterAll(async () => {
  await s?.app.close();
});

const platform = async (kind = 'generic', baseUrl = 'https://gateway.eu1.mindsphere.io') =>
  (
    await s.api('POST', '/platforms', {
      name: `Copy test ${++n}`,
      kind,
      baseUrl,
      config: { auth: { type: 'none' }, variables: {}, http: { proxy: 'none' } },
    })
  ).id as string;

const ok = { '200': { description: 'OK' } };
const spec = (version = '3') => ({
  openapi: '3.0.3',
  info: { title: 'Identity Management', version },
  servers: [{ url: 'https://gateway.eu1.mindsphere.io/api/identitymanagement/v3' }],
  paths: {
    '/Groups': { get: { operationId: 'listGroups', responses: ok } },
    '/Users': { get: { operationId: 'listUsers', responses: ok } },
  },
});
const importSpec = async (pid: string, body: unknown) => s.api('POST', `/platforms/${pid}/specs`, { name: 'IAM', content: JSON.stringify(body) });
const specs = async (pid: string) => (await s.api('GET', `/platforms/${pid}/specs`)) as any[];
const paths = async (pid: string) => ((await s.api('GET', `/platforms/${pid}/operations`)) as any[]).map((o) => `${o.method} ${o.path}`).sort();

describe('copying API specifications', () => {
  it('copies to several platforms of the same kind as independent specs, with the path prefix', async () => {
    const [a, b, c] = [await platform('insights-hub'), await platform('insights-hub'), await platform('insights-hub')];
    const src = await importSpec(a, spec());
    await s.api('PATCH', `/platforms/${a}/specs/${src.id}`, { pathPrefix: '/api/identitymanagement/v3' });
    const r = await s.api('POST', `/platforms/${a}/specs/${src.id}/copy`, { targets: [b, c] });
    expect(r.copied.map((x: any) => x.platformId).sort()).toEqual([b, c].sort());
    expect(r.copied.every((x: any) => x.replaced === false && x.specId !== src.id)).toBe(true);
    expect(r.skipped).toEqual([]);
    for (const t of [b, c]) {
      expect(await specs(t)).toMatchObject([
        { name: 'IAM', title: 'Identity Management', version: '3', pathPrefix: '/api/identitymanagement/v3', operationCount: 2 },
      ]);
      expect(await paths(t)).toEqual(['GET /api/identitymanagement/v3/Groups', 'GET /api/identitymanagement/v3/Users']);
    }
    // independent: removing the copy on b leaves the source and c alone
    await s.api('DELETE', `/platforms/${b}/specs/${(await specs(b))[0].id}`);
    expect(await specs(a)).toHaveLength(1);
    expect(await specs(c)).toHaveLength(1);

    const added = ((await s.api('GET', `/audit?entityType=platform&entityId=${c}`)) as any[]).find((e) => e.action === 'platform.spec_added');
    expect(added.summary).toContain('copied from');
    expect(added.details.copiedFrom).toEqual({ platformId: a, specId: src.id });
  });

  it('skips a platform that already has the spec, or replaces it and keeps its id', async () => {
    const [a, b] = [await platform('insights-hub'), await platform('insights-hub')];
    const src = await importSpec(a, spec());
    const old = await importSpec(b, { ...spec(), paths: { '/Groups': { get: { operationId: 'listGroups', responses: ok } } } });
    const skipped = await s.api('POST', `/platforms/${a}/specs/${src.id}/copy`, { targets: [b, a] });
    expect(skipped.copied).toEqual([]);
    expect(skipped.skipped).toEqual(
      expect.arrayContaining([
        { platformId: b, reason: 'exists' },
        { platformId: a, reason: 'source' },
      ]),
    );
    expect((await specs(b))[0].operationCount).toBe(1);

    const replaced = await s.api('POST', `/platforms/${a}/specs/${src.id}/copy`, { targets: [b], replace: true });
    expect(replaced.copied).toEqual([{ platformId: b, specId: old.id, replaced: true }]);
    expect(await specs(b)).toMatchObject([{ id: old.id, operationCount: 2 }]);
    const updated = ((await s.api('GET', `/audit?entityType=platform&entityId=${b}`)) as any[]).find((e) => e.action === 'platform.spec_updated');
    expect(updated.details.copiedFrom).toEqual({ platformId: a, specId: src.id });

    // another version is a different spec: copied next to the existing one
    const v4 = await importSpec(a, spec('4'));
    await s.api('POST', `/platforms/${a}/specs/${v4.id}/copy`, { targets: [b] });
    expect((await specs(b)).map((x) => x.version).sort()).toEqual(['3', '4']);
  });

  it('does not add a prefix the target base URL already ends with', async () => {
    const a = await platform('insights-hub');
    const b = await platform('insights-hub', 'https://gateway.eu2.mindsphere.io/api/identitymanagement/v3');
    const src = await importSpec(a, spec());
    await s.api('PATCH', `/platforms/${a}/specs/${src.id}`, { pathPrefix: '/api/identitymanagement/v3' });
    await s.api('POST', `/platforms/${a}/specs/${src.id}/copy`, { targets: [b] });
    expect((await specs(b))[0].pathPrefix).toBe('');
    expect(await paths(b)).toEqual(['GET /Groups', 'GET /Users']);
  });

  it('refuses platforms of another kind and targets without the manage right – nothing is copied', async () => {
    const [a, b] = [await platform('insights-hub'), await platform('insights-hub')];
    const other = await platform('generic');
    const src = await importSpec(a, spec());
    await expect(s.api('POST', `/platforms/${a}/specs/${src.id}/copy`, { targets: [b, other] })).rejects.toMatchObject({ status: 400 });
    expect(await specs(b)).toHaveLength(0);
    await expect(s.api('POST', `/platforms/${a}/specs/${src.id}/copy`, { targets: [] })).rejects.toMatchObject({ status: 400 });

    // dana may manage the source but only use the target
    await s.api('PUT', `/platforms/${a}/access`, { acl: [{ subject: 'user:dana', permissions: ['manage'] }] });
    await s.api('PUT', `/platforms/${b}/access`, { acl: [{ subject: 'user:dana', permissions: ['use'] }] });
    const dana = await s.as('dana', demoPassword);
    await expect(dana('POST', `/platforms/${a}/specs/${src.id}/copy`, { targets: [b] })).rejects.toMatchObject({ status: 403 });
    expect(await specs(b)).toHaveLength(0);
    await s.api('PUT', `/platforms/${b}/access`, { acl: [{ subject: 'user:dana', permissions: ['manage'] }] });
    const r = await dana('POST', `/platforms/${a}/specs/${src.id}/copy`, { targets: [b] });
    expect(r.copied).toHaveLength(1);
  });
});
