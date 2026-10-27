import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';
import { derivePathPrefix, pathPrefixProblem, serverUrlPath } from '../src/platforms/pathPrefix.js';

/** API specs keep the path of their server URL as a per-spec path prefix (in front of every operation path). */

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

const platform = async (baseUrl: string, variables: Record<string, string> = {}) =>
  (
    await s.api('POST', '/platforms', {
      name: `Prefix test ${++n}`,
      kind: 'generic',
      baseUrl,
      config: { auth: { type: 'none' }, variables, http: { proxy: 'none' } },
    })
  ).id as string;

const ok = { '200': { description: 'OK' } };
const groupPaths = {
  '/Groups': { get: { operationId: 'listGroups', responses: ok } },
  '/Groups/{id}': { get: { operationId: 'getGroup', parameters: [{ name: 'id', in: 'path', required: true }], responses: ok } },
};
const oas3 = (servers: unknown[] | undefined, paths: Record<string, unknown> = groupPaths) => ({
  openapi: '3.0.3',
  info: { title: 'Test', version: '1' },
  ...(servers ? { servers } : {}),
  paths,
});
const importSpec = (pid: string, spec: unknown) => s.api('POST', `/platforms/${pid}/specs`, { content: JSON.stringify(spec) });
const operations = async (pid: string, specId: string) => (await s.api('GET', `/platforms/${pid}/operations`)).filter((o: any) => o.specId === specId);

describe('deriving the prefix', () => {
  it('takes the path of the server URL, with server variables and normalised slashes', () => {
    const vars = { region: { default: 'eu1' }, version: { default: 'v3' } };
    expect(serverUrlPath('https://gateway.{region}.mindsphere.io/api/identitymanagement/{version}', vars)).toBe('/api/identitymanagement/v3');
    expect(serverUrlPath('/api/v1/')).toBe('/api/v1');
    expect(serverUrlPath('api/v1')).toBe('/api/v1');
    expect(serverUrlPath('/')).toBe('');
    expect(serverUrlPath('https://example.com')).toBe('');
    expect(serverUrlPath('//example.com/x?y=1#z')).toBe('/x');
    expect(derivePathPrefix('https://h/api/{tenant}')).toMatchObject({ prefix: '', invalid: expect.any(String) });
    expect(derivePathPrefix('https://h/api/v1', { basePath: '/gw/api/v1' }).prefix).toBe('');
    expect(derivePathPrefix('https://h/api/v1', { basePath: '/xapi/v1' }).prefix).toBe('/api/v1');
    // only whole segments count: a base path /apiv2 does not already contain the prefix /v2
    expect(derivePathPrefix('https://h/v2', { basePath: '/apiv2' }).prefix).toBe('/v2');
    expect(derivePathPrefix('https://h/api/v1', { basePath: undefined }).prefix).toBe('/api/v1');
  });

  it('allows only plain relative paths', () => {
    for (const ok of ['', '/api', '/api/identitymanagement/v3', '/a.b/c_d/~e-f']) expect(pathPrefixProblem(ok), ok).toBeUndefined();
    for (const bad of [
      '../x',
      '//x',
      'http://evil',
      '%2e',
      '?a',
      '/a/../b',
      '/a/./b',
      '/..',
      '/a//b',
      '/a/',
      'api',
      '/{x}',
      '/a\\b',
      '/a#b',
      '/a:b',
      '/a@b',
      `/${'a'.repeat(200)}`,
    ])
      expect(pathPrefixProblem(bad), bad).toBeDefined();
  });
});

describe('import', () => {
  it('OpenAPI 3 with an absolute server URL and variables', async () => {
    const pid = await platform('https://gateway.eu1.mindsphere.io');
    const url = 'https://gateway.{region}.mindsphere.io/api/identitymanagement/v3';
    const spec = await importSpec(pid, oas3([{ url, variables: { region: { default: 'eu1', enum: ['eu1', 'eu2'] } } }]));
    expect(spec).toMatchObject({ serverUrl: url, pathPrefix: '/api/identitymanagement/v3', operationCount: 2 });
    const ops = await operations(pid, spec.id);
    expect(ops.map((o: any) => [o.path, o.specPath])).toEqual([
      ['/api/identitymanagement/v3/Groups', '/Groups'],
      ['/api/identitymanagement/v3/Groups/{id}', '/Groups/{id}'],
    ]);
    const audit = await s.api('GET', `/audit?entityType=platform&entityId=${pid}`);
    expect(audit.find((a: any) => a.action === 'platform.spec_added').details).toMatchObject({ pathPrefix: '/api/identitymanagement/v3' });
  });

  it('OpenAPI 3 with a relative server URL', async () => {
    const pid = await platform('https://edge.example.com');
    const spec = await importSpec(pid, oas3([{ url: '/device/api/v1/' }]));
    expect(spec.pathPrefix).toBe('/device/api/v1');
    expect((await operations(pid, spec.id))[0].path).toBe('/device/api/v1/Groups');
  });

  it('Swagger 2 with basePath (with and without host)', async () => {
    const pid = await platform('https://edge.example.com');
    const swagger = (extra: Record<string, unknown>) => ({ swagger: '2.0', info: { title: 'IE', version: '1' }, ...extra, paths: groupPaths });
    const a = await importSpec(pid, swagger({ host: 'edge.example.com', schemes: ['https'], basePath: '/portal/api/v1' }));
    expect(a).toMatchObject({ serverUrl: 'https://edge.example.com/portal/api/v1', pathPrefix: '/portal/api/v1' });
    const b = await importSpec(pid, swagger({ basePath: '/edge/api/v2/' }));
    expect(b.pathPrefix).toBe('/edge/api/v2');
    expect((await operations(pid, b.id))[0].path).toBe('/edge/api/v2/Groups');
  });

  it('a spec without a server URL keeps its paths', async () => {
    const pid = await platform('https://edge.example.com');
    const spec = await importSpec(pid, oas3(undefined));
    expect(spec.pathPrefix).toBe('');
    const [op] = await operations(pid, spec.id);
    expect(op.path).toBe('/Groups');
    expect(op.specPath).toBeUndefined();
    const root = await importSpec(pid, oas3([{ url: 'https://edge.example.com/' }]));
    expect(root.pathPrefix).toBe('');
  });

  it('does not double the prefix when the base URL already ends with it', async () => {
    const server = [{ url: 'https://gateway.{region}.mindsphere.io/api/identitymanagement/v3', variables: { region: { default: 'eu1' } } }];
    const literal = await platform('https://gateway.eu1.mindsphere.io/api/identitymanagement/v3/');
    expect((await importSpec(literal, oas3(server))).pathPrefix).toBe('');
    expect((await operations(literal, (await s.api('GET', `/platforms/${literal}/specs`))[0].id))[0].path).toBe('/Groups');
    // templates in the base URL path are rendered first
    const templated = await platform('https://gateway.{{ vars.region }}.mindsphere.io{{ vars.idmPath }}', {
      region: 'eu1',
      idmPath: '/api/identitymanagement/v3',
    });
    expect((await importSpec(templated, oas3(server))).pathPrefix).toBe('');
    // a base URL that cannot be rendered keeps the derived prefix
    const broken = await platform('{{ vars.missing }}');
    expect((await importSpec(broken, oas3(server))).pathPrefix).toBe('/api/identitymanagement/v3');
    // paths that already repeat the server path
    const repeat = await platform('https://gateway.eu1.mindsphere.io');
    expect((await importSpec(repeat, oas3([{ url: '/api/v1' }], { '/api/v1/Groups': { get: { responses: ok } } }))).pathPrefix).toBe('');
  });

  it('stores an empty prefix when the server URL path is not a plain path', async () => {
    const pid = await platform('https://edge.example.com');
    const spec = await importSpec(pid, oas3([{ url: 'https://edge.example.com/api/{tenant}/v1' }]));
    expect(spec.pathPrefix).toBe('');
    expect((await importSpec(pid, oas3([{ url: '/api/%2e%2e/v1' }]))).pathPrefix).toBe('');
  });
});

describe('specs imported before path prefixes', () => {
  it('derive the prefix from the stored server URL', async () => {
    const { db } = await import('../src/db.js');
    const pid = await platform('https://gateway.eu1.mindsphere.io');
    const a = await importSpec(pid, oas3([{ url: 'https://gateway.eu1.mindsphere.io/api/assetmanagement/v3' }]));
    const b = await importSpec(pid, oas3([{ url: 'https://gw/api/{version}', variables: { version: { default: 'v4' } } }]));
    db().run('UPDATE platform_specs SET path_prefix = NULL WHERE platform_id = ?', pid);
    const specs = await s.api('GET', `/platforms/${pid}/specs`);
    const prefixOf = (id: string) => specs.find((x: any) => x.id === id).pathPrefix;
    expect([prefixOf(a.id), prefixOf(b.id)]).toEqual(['/api/assetmanagement/v3', '/api/v4']);
    expect((await operations(pid, a.id))[0]).toMatchObject({ path: '/api/assetmanagement/v3/Groups', specPath: '/Groups' });
    expect((await operations(pid, b.id))[0].path).toBe('/api/v4/Groups');
    // the base URL (as written) already ends with it: not doubled
    const covered = await platform('https://gateway.eu1.mindsphere.io/api/assetmanagement/v3');
    const c = await importSpec(covered, oas3(undefined));
    db().run("UPDATE platform_specs SET path_prefix = NULL, server_url = '/api/assetmanagement/v3' WHERE id = ?", c.id);
    expect((await s.api('GET', `/platforms/${covered}/specs`))[0].pathPrefix).toBe('');
    // a stored value changed outside the application is not used
    db().run("UPDATE platform_specs SET path_prefix = '/../x' WHERE id = ?", a.id);
    expect((await operations(pid, a.id))[0].path).toBe('/Groups');
  });
});

describe('editing the prefix', () => {
  it('validates, checks the permission and audits the change', async () => {
    const pid = await platform('https://gateway.eu1.mindsphere.io');
    const spec = await importSpec(pid, oas3([{ url: 'https://gateway.eu1.mindsphere.io/api/identitymanagement/v3' }]));
    const url = `/platforms/${pid}/specs/${spec.id}`;
    const changed = await s.api('PATCH', url, { pathPrefix: '/api/identitymanagement/v4' });
    expect(changed).toMatchObject({ id: spec.id, pathPrefix: '/api/identitymanagement/v4', serverUrl: spec.serverUrl });
    expect((await operations(pid, spec.id))[0].path).toBe('/api/identitymanagement/v4/Groups');
    const entry = (await s.api('GET', `/audit?entityType=platform&entityId=${pid}`)).find((a: any) => a.action === 'platform.spec_updated');
    expect(entry.details).toMatchObject({
      specId: spec.id,
      before: { pathPrefix: '/api/identitymanagement/v3' },
      after: { pathPrefix: '/api/identitymanagement/v4' },
    });

    for (const bad of ['../x', '//x', 'http://evil', '%2e', '?a', '/a/../b', '/a/', '/{id}', `/${'a'.repeat(200)}`]) {
      await expect(s.api('PATCH', url, { pathPrefix: bad }), bad).rejects.toMatchObject({ status: 400 });
    }
    await expect(s.api('PATCH', url, { pathPrefix: '../x' })).rejects.toMatchObject({ body: { code: 'SPEC_PATH_PREFIX_INVALID' } });
    await expect(s.api('PATCH', url, { pathPrefix: '/x', other: 1 })).rejects.toMatchObject({ status: 400 });
    expect((await operations(pid, spec.id))[0].path).toBe('/api/identitymanagement/v4/Groups');

    // empty: the paths of the specification as they are
    expect((await s.api('PATCH', url, { pathPrefix: '' })).pathPrefix).toBe('');
    expect((await operations(pid, spec.id))[0].path).toBe('/Groups');

    // only users who may manage the platform; specs of other platforms are not found
    const olivia = await s.as('olivia', demoPassword);
    await expect(olivia('PATCH', url, { pathPrefix: '/x' })).rejects.toMatchObject({ status: 403 });
    const other = await platform('https://other.example.com');
    await expect(s.api('PATCH', `/platforms/${other}/specs/${spec.id}`, { pathPrefix: '/x' })).rejects.toMatchObject({ status: 404 });
    await expect(s.api('PATCH', `/platforms/${pid}/specs/sp_none`, { pathPrefix: '/x' })).rejects.toMatchObject({ status: 404 });
  });

  it('connector types keep the prefix of their specs', async () => {
    const pid = await platform('https://gateway.eu1.mindsphere.io');
    const spec = await importSpec(pid, oas3([{ url: '/api/v1' }]));
    await s.api('PATCH', `/platforms/${pid}/specs/${spec.id}`, { pathPrefix: '/api/v9' });
    const t = await s.api('POST', '/platform-types', { fromPlatformId: pid, kind: `prefix-type-${n}`, label: 'Prefix type' });
    const copy = await s.api('POST', '/platforms', { name: `Prefix copy ${n}`, typeKind: t.kind, baseUrl: 'https://gateway.eu1.mindsphere.io' });
    expect((await s.api('GET', `/platforms/${copy.id}/specs`))[0].pathPrefix).toBe('/api/v9');
    const pkg = await s.api('GET', `/platform-types/${t.kind}/export`);
    pkg.kind = `prefix-bad-${n}`;
    pkg.specs[0].pathPrefix = '/../admin';
    await expect(s.api('POST', '/platform-types/import', pkg)).rejects.toMatchObject({ status: 400 });
  });
});

describe('consumers of operations', () => {
  it('the contract check calls prefix + path and reads the schema of the spec path', async () => {
    const pid = await platform(`${s.base}/mock`);
    await importSpec(
      pid,
      oas3([{ url: '/test' }], {
        '/flaky/calls': {
          get: {
            operationId: 'calls',
            responses: {
              '200': {
                description: 'ok',
                content: { 'application/json': { schema: { type: 'object', required: ['calls', 'total'], properties: { calls: { type: 'integer' } } } } },
              },
            },
          },
        },
      }),
    );
    const r = await s.api('POST', `/platforms/${pid}/contract-check`, {});
    expect(r.checked).toBe(1);
    expect(r.results[0]).toMatchObject({ path: '/test/flaky/calls', status: 200 });
    // the response schema was found under the specification's own path "/flaky/calls"
    expect(r.results[0].problems).toEqual(['missing required property "total"']);
  });

  it('the MCP gateway finds operations by the new and by the old (spec path) reference', async () => {
    const { findOperation } = await import('../src/mcp/gateway.js');
    const pid = await platform('https://gateway.eu1.mindsphere.io');
    await importSpec(pid, oas3([{ url: '/api/v1' }], { '/things': { get: { responses: ok } }, '/things/{id}': { get: { responses: ok } } }));
    const now = findOperation(pid, 'GET /api/v1/things/{id}');
    expect(now).toMatchObject({ path: '/api/v1/things/{id}', specPath: '/things/{id}' });
    expect(findOperation(pid, 'GET /things/{id}')).toEqual(now);
    expect(findOperation(pid, 'get /things')).toMatchObject({ path: '/api/v1/things' });
    expect(() => findOperation(pid, 'GET /nothing')).toThrow(/not found/);
  });
});
