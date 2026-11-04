import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import jsonata from 'jsonata';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import { validateProcess, type AuthConfig, type Platform } from '@sm/shared';
import { JS_HELPERS, parseSubset, stepsJs, toJs, type JsScope } from '../src/export/jsonata-js.js';
import {
  JSONATA_VERSION,
  platformToPostman,
  processToPostman,
  stepOrder,
  type PmCollection,
  type PmFolder,
  type PmItem,
  type PostmanExport,
} from '../src/export/postman.js';

/**
 * Postman export (#204), the pure part: the JSONata subset and its JavaScript, the sign-in of every platform type, that
 * no secret is ever exported, the notes for steps that do not map, and the Postman Collection v2.1 schema (the official
 * schema, vendored in fixtures/postman – Apache License 2.0, see NOTICE). The routes are tested in postman-routes.test.ts.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const OPTS = { stewardVersion: '0.5.0', exportedAt: '2026-11-04T12:00:00.000Z' };

const schema = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/postman/collection-v2.1.0.schema.json'), 'utf8'));
const validateCollection = new Ajv({ allErrors: true, strict: false }).compile(schema);
function expectValid(c: PmCollection) {
  const ok = validateCollection(c);
  expect(validateCollection.errors ?? [], JSON.stringify(validateCollection.errors?.slice(0, 5))).toEqual([]);
  expect(ok).toBe(true);
}

function platform(auth: AuthConfig, extra: Partial<Platform> = {}): Platform {
  return {
    id: 'plt_1',
    name: 'Demo API',
    kind: 'generic',
    description: '',
    baseUrl: 'https://api.example.com/v1',
    environment: 'test',
    config: { auth, variables: {}, http: {} },
    secretKeys: [],
    acl: [],
    permissions: ['use'],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

function definition(raw: unknown) {
  const r = validateProcess(raw);
  if (!r.definition) throw new Error(JSON.stringify(r.issues));
  return r.definition;
}

function exportProcess(raw: unknown, platforms: Record<string, Platform | undefined> = {}): PostmanExport {
  const def = definition(raw);
  return processToPostman(
    { id: 'p-test', name: def.name, version: 3, definition: def },
    Object.fromEntries(Object.entries(platforms).map(([slot, p]) => [slot, { platform: p }])),
    OPTS,
  );
}

const folderOf = (c: PmCollection) => c.item[0] as PmFolder;
const requests = (c: PmCollection) => folderOf(c).item as PmItem[];
const scriptOf = (item: { event?: { listen: string; script: { exec: string[] } }[] }, listen: 'test' | 'prerequest') =>
  (item.event ?? []).find((e) => e.listen === listen)?.script.exec.join('\n') ?? '';
const envValue = (x: PostmanExport, key: string) => x.environment.values.find((v) => v.key === key);
const collVar = (x: PostmanExport, key: string) => x.collection.variable?.find((v) => v.key === key);

// ---------------------------------------------------------------------------
// The JSONata subset
// ---------------------------------------------------------------------------

describe('JSONata subset → JavaScript', () => {
  const data = {
    vars: {
      a: {
        status: 200,
        durationMs: 120,
        body: {
          items: [
            { id: 1, tags: ['x', 'y'], active: true },
            { id: 2, tags: [], active: false },
          ],
          total: 2,
          name: 'Ann',
          nested: [[{ b: 1 }], [{ b: 2 }]],
          one: [5],
          empty: [],
          obj: {},
          s: '',
          'odd key': 'v',
        },
      },
    },
    inputs: { max: 3000, mode: 'delete', list: ['a'] },
  };
  const scope: JsScope = {
    path: (steps, variable) => (variable ? `$p(R[${JSON.stringify(variable)}], ${stepsJs(steps)})` : `$p(R, ${stepsJs(steps)})`),
  };
  const compile = (src: string) => {
    const tree = parseSubset(src);
    expect(tree, src).not.toBeNull();
    const code = toJs(tree!, scope);
    expect(code, src).not.toBeNull();
    // the translation is a pure function of the data: evaluated here only to compare it with JSONata itself
    return new Function(`${JS_HELPERS.join('\n')}\nreturn function (R) { return ${code}; };`)() as (r: unknown) => unknown;
  };
  const norm = (x: unknown) => (x === undefined ? 'undefined' : JSON.stringify(x));

  it.each([
    'vars.a.status = 200',
    'vars.a.status != 200',
    'vars.a.body.items.id',
    'vars.a.body.items[0].id',
    'vars.a.body.items[-1].id',
    'vars.a.body.items.tags',
    'vars.a.body.items.tags[0]',
    'vars.a.body.items.tags[1]',
    'vars.a.body.items[1].tags',
    'vars.a.body.one',
    'vars.a.body.one[0]',
    'vars.a.body.nested',
    'vars.a.body.nested[0]',
    'vars.a.body.nested.b',
    'vars.a.body.`odd key`',
    '$count(vars.a.body.items)',
    '$count(vars.a.body.one)',
    '$count(vars.a.body.total)',
    '$count(vars.a.body.missing)',
    '$exists(vars.a.body.missing)',
    '$exists(vars.a.body.s)',
    '$length(vars.a.body.name)',
    '$length(vars.a.body.missing)',
    '$not(vars.a.body.empty)',
    '$not(vars.a.body.obj)',
    '$not(vars.a.body.missing)',
    'vars.a.body.items.active and vars.a.body.total > 1',
    'vars.a.body.empty or vars.a.body.obj',
    'vars.a.body.s or 0',
    'vars.a.body.items.active or false',
    'vars.a.durationMs <= $inputs.max',
    "vars.a.body.name = 'Ann'",
    'vars.a.body.name = "Bob"',
    'vars.a.body.missing = 1',
    'vars.a.body.missing != 1',
    'vars.a.body.missing < 1',
    'vars.a.body.items[0] = vars.a.body.items[0]',
    'vars.a.body.items = vars.a.body.items',
    'vars.a.body.items.id = 1',
    '$inputs.list',
    "$inputs.mode = 'delete'",
    '(vars.a.status = 200) and ($count(vars.a.body.items) >= 2)',
    'true',
    'null',
    '-1 < 0',
    '2.5e1 >= 25',
    "'a\\nb' = 'a\\nb'",
  ])('%s evaluates like JSONata', async (src) => {
    const expected = await jsonata(src).evaluate(data, { inputs: data.inputs });
    expect(norm(compile(src)(data))).toBe(norm(JSON.parse(JSON.stringify(expected ?? null)) ?? (expected === undefined ? undefined : null)));
  });

  it('a comparison of a string with a number fails like in JSONata', async () => {
    await expect(jsonata('vars.a.body.name < 1').evaluate(data)).rejects.toBeTruthy();
    expect(() => compile('vars.a.body.name < 1')(data)).toThrow(/compare/);
  });

  it.each([
    '$count(vars.a.body.items[active = false])',
    "vars.a.body.name & 'x'",
    'vars.a.status = 200 ? 1 : 2',
    '$string(vars.a.status)',
    '$lowercase(vars.a.body.name)',
    'vars.a.status + 1',
    '$sum(vars.a.body.items.id)',
    'vars.a.status in [200, 201]',
    'vars.a.body.items.(id)',
    'vars.a.body.items[0][0]',
    '$$.vars',
    'vars.a.body.**',
    'vars.a.body.items^(id)',
    'vars.a.body.items@$i',
    '{"a": 1}',
    '[1, 2]',
    'a = b = c',
    'function($x) { $x }',
    '$count()',
    '"x".length',
    '/* comment */ true',
    '',
  ])('%s is outside the subset (falls back)', (src) => {
    expect(parseSubset(src)).toBeNull();
  });

  it('the jsonata version of the fallback is the one Steward uses', () => {
    const main = createRequire(import.meta.url).resolve('jsonata');
    let dir = path.dirname(main);
    while (!fs.existsSync(path.join(dir, 'package.json'))) dir = path.dirname(dir);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version).toBe(JSONATA_VERSION);
  });
});

// ---------------------------------------------------------------------------
// Sign-in → Postman auth
// ---------------------------------------------------------------------------

describe('sign-in → collection auth', () => {
  const exp = (auth: AuthConfig, extra: Partial<Platform> = {}) => platformToPostman(platform(auth, extra), [], OPTS);
  const attrs = (a: { key: string; value: string }[] | undefined) => Object.fromEntries((a ?? []).map((x) => [x.key, x.value]));

  it('none', () => {
    const x = exp({ type: 'none' });
    expect(x.collection.auth).toEqual({ type: 'noauth' });
    expect(x.collection.event).toBeUndefined();
    expectValid(x.collection);
  });

  it('basic (and the Schema Registry key of a Kafka platform)', () => {
    const x = exp({ type: 'basic' }, { secretKeys: ['username', 'password'] });
    expect(x.collection.auth?.type).toBe('basic');
    expect(attrs(x.collection.auth?.basic)).toEqual({ username: '{{username}}', password: '{{password}}' });
    expect(envValue(x, 'password')).toEqual({ key: 'password', value: '', type: 'secret', enabled: true });
    const k = exp({ type: 'basic' }, { kind: 'kafka' });
    expect(attrs(k.collection.auth?.basic)).toEqual({ username: '{{registryKey}}', password: '{{registrySecret}}' });
    expectValid(x.collection);
  });

  it('bearer: Postman bearer auth, or an API-key header for another header name (GitLab)', () => {
    const x = exp({ type: 'bearer' });
    expect(x.collection.auth).toEqual({ type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] });
    expect(envValue(x, 'token')?.type).toBe('secret');
    const g = exp({ type: 'bearer' }, { kind: 'gitlab' });
    expect(g.collection.auth?.type).toBe('apikey');
    expect(attrs(g.collection.auth?.apikey)).toEqual({ key: 'PRIVATE-TOKEN', value: '{{token}}', in: 'header' });
    expectValid(g.collection);
  });

  it('API key in a header or in the query', () => {
    const h = exp({ type: 'apiKey', apiKeyName: 'X-Api-Key' });
    expect(attrs(h.collection.auth?.apikey)).toEqual({ key: 'X-Api-Key', value: '{{apiKey}}', in: 'header' });
    const q = exp({ type: 'apiKey', apiKeyIn: 'query' });
    expect(attrs(q.collection.auth?.apikey)).toEqual({ key: 'api_key', value: '{{apiKey}}', in: 'query' });
    expectValid(q.collection);
  });

  it('AWS SigV4: Postman awsv4 with region and service; an assumed role is a note', () => {
    const x = exp({ type: 'aws_sigv4', aws: { region: 'eu-central-1', service: 's3', roleArn: 'arn:aws:iam::123456789012:role/reader' } });
    expect(x.collection.auth?.type).toBe('awsv4');
    expect(attrs(x.collection.auth?.awsv4)).toEqual({
      accessKey: '{{accessKeyId}}',
      secretKey: '{{secretAccessKey}}',
      sessionToken: '{{sessionToken}}',
      region: '{{awsRegion}}',
      service: '{{awsService}}',
    });
    expect(envValue(x, 'awsRegion')?.value).toBe('eu-central-1');
    expect(envValue(x, 'secretAccessKey')?.type).toBe('secret');
    expect(x.collection.info.description).toContain('assumes the role arn:aws:iam::123456789012:role/reader');
    expectValid(x.collection);
  });

  it('OAuth 2.0 client credentials: a collection pre-request script that caches the token until it expires', () => {
    const p = platform(
      {
        type: 'oauth2_client_credentials',
        tokenUrl: '{{ baseUrl }}/oauth/token?tenant={{ vars.tenant }}',
        scope: 'read',
        clientAuth: 'body',
        extraParams: { audience: 'api' },
      },
      { secretKeys: ['clientId', 'clientSecret'] },
    );
    p.config.variables = { tenant: 't1' };
    const o = platformToPostman(p, [], OPTS);
    expect(o.collection.auth).toEqual({ type: 'bearer', bearer: [{ key: 'token', value: '{{accessToken}}', type: 'string' }] });
    const pre = scriptOf(o.collection, 'prerequest');
    expect(pre).toContain('pm.sendRequest');
    expect(pre).toContain('"{{baseUrl}}/oauth/token?tenant={{tenant}}"');
    expect(pre).toContain("{ key: 'client_id', value: clientId }");
    expect(pre).toContain('form.push({ key: "audience"');
    expect(pre).toContain('pm.collectionVariables.set(P + "accessTokenExpiresAt"');
    expect(pre).toContain('until > Date.now() + 30000');
    expect(collVar(o, 'accessToken')).toMatchObject({ value: '' });
    expect(envValue(o, 'clientSecret')).toEqual({ key: 'clientSecret', value: '', type: 'secret', enabled: true });
    expect(envValue(o, 'tenant')?.value).toBe('t1');
    expect(() => new Function(pre)).not.toThrow();
    expectValid(o.collection);
  });

  it('a login request: the script sends it and reads the token with the JSONata subset, or with JSONata itself', () => {
    const p = platform(
      {
        type: 'token_request',
        request: { method: 'POST', url: '/login', body: { user: '{{ secrets.username }}', password: '{{ secrets.password }}' } },
        tokenPath: 'data.token',
        expiresInPath: 'data.ttl',
        headerName: 'X-Auth',
        headerValue: 'Token {{ token }}',
      },
      { secretKeys: ['username', 'password'] },
    );
    const o = platformToPostman(p, [], OPTS);
    expect(o.collection.auth?.type).toBe('apikey');
    expect(o.collection.auth?.apikey).toContainEqual({ key: 'value', value: 'Token {{accessToken}}', type: 'string' });
    const pre = scriptOf(o.collection, 'prerequest');
    expect(pre).toContain('pm.variables.replaceIn("{{baseUrl}}/login")');
    expect(pre).toContain('"password": pm.variables.replaceIn("{{password}}")');
    expect(pre).toContain('save($p(body, [["data"],["token"]]), $p(body, [["data"],["ttl"]]))');
    expect(pre).not.toContain('pm.require');
    expect(() => new Function(pre)).not.toThrow();
    expectValid(o.collection);

    const f = platformToPostman(
      { ...p, config: { ...p.config, auth: { ...p.config.auth, tokenPath: "$substringAfter(headers.`set-cookie`, 'sid=')" } } },
      [],
      OPTS,
    );
    const pre2 = scriptOf(f.collection, 'prerequest');
    expect(pre2).toContain(`pm.require('npm:jsonata@${JSONATA_VERSION}')`);
    expect(f.collection.info.description).toContain('not Newman');
    expect(() => new Function(pre2)).not.toThrow();
  });

  it('key-pair JWT: a note and an empty secret variable to paste a token into', () => {
    const o = exp({ type: 'jwt', jwt: { alg: 'RS256', claims: { iss: 'x' } } }, { kind: 'snowflake', secretKeys: ['privateKey', 'privateKeyPassphrase'] });
    expect(o.collection.auth).toEqual({ type: 'bearer', bearer: [{ key: 'token', value: '{{accessToken}}', type: 'string' }] });
    expect(envValue(o, 'accessToken')).toEqual({ key: 'accessToken', value: '', type: 'secret', enabled: true });
    expect(envValue(o, 'privateKey')?.type).toBe('secret');
    expect(o.collection.info.description).toMatch(/cannot sign it.*paste it into the environment variable \{\{accessToken\}\}/);
    expect(o.collection.event).toBeUndefined();
    expectValid(o.collection);
  });
});

// ---------------------------------------------------------------------------
// Secrets are never exported
// ---------------------------------------------------------------------------

describe('secrets', () => {
  const LITERALS = ['Bearer literal-abc123', 'query-key-xyz', 'hunter2-body', 'topsecret-default', 'const-key-123', 'var-token-456', 'header-cookie-789'];

  it('every secret becomes an empty variable of type secret – platform secrets, secret variables, headers, query, body, inputs, constants', () => {
    const p = platform(
      { type: 'bearer' },
      {
        secretKeys: ['token', 'extraSecret'],
        config: {
          auth: { type: 'bearer' },
          variables: { tenant: 'acme', apiToken: 'var-token-456' },
          http: { defaultHeaders: { 'X-Trace': 'on', Cookie: 'header-cookie-789' } },
        },
      },
    );
    const x = exportProcess(
      {
        name: 'Secrets',
        connections: [{ slot: 'api' }],
        inputs: [
          { name: 'password', type: 'secret', default: 'topsecret-default' },
          { name: 'user', type: 'string', default: 'ann' },
        ],
        constants: { apiKey: 'const-key-123', region: 'eu' },
        steps: [
          {
            id: 'call',
            type: 'http',
            connection: 'api',
            method: 'POST',
            path: '/things',
            headers: { Authorization: 'Bearer literal-abc123', 'X-Other': "{{ $secret('api', 'extraSecret') }}", 'X-User': '{{ inputs.user }}' },
            query: { api_key: 'query-key-xyz', q: '{{ inputs.password }}', region: '{{ const.region }}' },
            body: { login: { password: 'hunter2-body', key: '{{ const.apiKey }}' }, note: 'plain' },
          },
        ],
      },
      { api: p },
    );
    const text = JSON.stringify(x);
    for (const s of LITERALS) expect(text).not.toContain(s);
    const secret = (key: string) => expect(envValue(x, key), key).toEqual({ key, value: '', type: 'secret', enabled: true });
    for (const key of [
      'api.token',
      'api.extraSecret',
      'api.apiToken',
      'api.header.Cookie',
      'inputs.password',
      'const.apiKey',
      'secret.call.header.Authorization',
      'secret.call.query.api_key',
      'secret.call.body.password',
    ])
      secret(key);
    expect(envValue(x, 'api.tenant')).toMatchObject({ value: 'acme', type: 'default' });
    const req = requests(x.collection)[0]!.request;
    expect(req.header).toContainEqual({ key: 'Authorization', value: '{{secret.call.header.Authorization}}' });
    expect(req.header).toContainEqual({ key: 'X-Other', value: '{{api.extraSecret}}' });
    expect(req.header).toContainEqual({ key: 'X-Trace', value: 'on' });
    expect(req.url.raw).toBe('{{api.baseUrl}}/things?api_key={{secret.call.query.api_key}}&q={{inputs.password}}&region={{const.region}}');
    expect(JSON.parse(req.body!.raw!)).toEqual({ login: { password: '{{secret.call.body.password}}', key: '{{const.apiKey}}' }, note: 'plain' });
    // the secret input is in the environment only, not a collection variable
    expect(collVar(x, 'inputs.password')).toBeUndefined();
    expect(collVar(x, 'inputs.user')?.value).toBe('ann');
    expectValid(x.collection);
  });

  it('credentials written literally into sign-in settings and headers are replaced too (by name or by their form)', () => {
    const p = platform(
      { type: 'none' },
      { config: { auth: { type: 'none' }, variables: {}, http: { defaultHeaders: { 'X-Custom': 'Bearer literal-tok-3' } } } },
    );
    p.config.auth = {
      type: 'token_request',
      request: {
        method: 'POST',
        url: '/login',
        headers: { 'X-Login': 'Basic bGl0ZXJhbA==' },
        body: { user: 'svc', password: 'literal-pw-1', nested: { apiKey: 'literal-key-2' } },
      },
      tokenPath: 'token',
    };
    const o = platformToPostman(p, [], OPTS);
    const q = platformToPostman(
      platform({ type: 'oauth2_client_credentials', tokenUrl: 'https://x/token', extraParams: { client_assertion: 'literal-assert-4', audience: 'api' } }),
      [],
      OPTS,
    );
    const text = JSON.stringify([o, q]);
    for (const s of ['bGl0ZXJhbA==', 'literal-pw-1', 'literal-key-2', 'literal-tok-3', 'literal-assert-4']) expect(text).not.toContain(s);
    expect(text).toContain('\\"svc\\"');
    expect(text).toContain('audience');
    for (const key of ['login.X-Login', 'login.password', 'login.apiKey', 'header.X-Custom']) expect(envValue(o, key)?.type, key).toBe('secret');
    expect(envValue(q, 'login.client_assertion')?.type).toBe('secret');
    const x = exportProcess(
      {
        name: 'H',
        connections: [{ slot: 'api' }],
        steps: [{ id: 'c', type: 'http', connection: 'api', method: 'GET', path: '/', headers: { 'X-Auth': 'Token literal-5' } }],
      },
      {},
    );
    expect(JSON.stringify(x)).not.toContain('literal-5');
    expect(envValue(x, 'secret.c.header.X-Auth')?.type).toBe('secret');
  });

  it('the platform export holds no secret either', () => {
    const p = platform(
      { type: 'oauth2_client_credentials', tokenUrl: 'https://login.example.com/token' },
      {
        secretKeys: ['clientId', 'clientSecret'],
        config: {
          auth: { type: 'oauth2_client_credentials', tokenUrl: 'https://login.example.com/token' },
          variables: { password: 'var-token-456' },
          http: {},
        },
      },
    );
    const x = platformToPostman(p, [], OPTS);
    expect(JSON.stringify(x)).not.toContain('var-token-456');
    expect(envValue(x, 'password')?.type).toBe('secret');
    expect(x.environment.values.filter((v) => v.type === 'secret').every((v) => v.value === '')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Processes: order, values between steps, checks, notes
// ---------------------------------------------------------------------------

const ih = platform(
  { type: 'oauth2_client_credentials', tokenUrl: '{{ baseUrl }}/oauth/token' },
  {
    kind: 'insights-hub',
    name: 'Insights Hub',
    baseUrl: 'https://{{ vars.tenant }}.example.com',
    secretKeys: ['clientId', 'clientSecret'],
  },
);
ih.config.variables = { tenant: 'demo' };

describe('processes', () => {
  it('requests in step order, values a later step reads set by the test script of the request that produces them', () => {
    const x = exportProcess(
      {
        name: 'Flow',
        connections: [{ slot: 'hub', kind: 'insights-hub' }],
        inputs: [{ name: 'count', type: 'number', default: 5 }],
        steps: [
          { id: 'setup', type: 'set', values: { idm: "{{ $pvar('hub', 'idmPath', '/api/idm/v3') }}", fixed: 'abc' } },
          {
            id: 'users',
            type: 'http',
            connection: 'hub',
            method: 'GET',
            path: '{{ vars.idm }}/Users',
            query: { count: '{{ inputs.count }}' },
            saveAs: 'users',
          },
          { id: 'enough', type: 'check', condition: '$count(vars.users.body.resources) > 0 and vars.users.status = 200' },
          {
            id: 'one',
            type: 'http',
            connection: 'hub',
            method: 'GET',
            path: '{{ vars.idm }}/Users/{{ vars.users.body.resources[0].id }}',
            headers: { 'X-Fixed': '{{ vars.fixed }}' },
            saveAs: 'one',
          },
          { id: 'same', type: 'check', condition: 'vars.one.body.id = vars.users.body.resources[0].id' },
        ],
      },
      { hub: ih },
    );
    const [users, one] = requests(x.collection);
    expect([users!.name, one!.name]).toEqual(['users', 'one']);
    expect(users!.request.url.raw).toBe('{{hub.baseUrl}}{{vars.idm}}/Users?count={{inputs.count}}');
    expect(users!.request.url.host).toEqual(['{{hub.baseUrl}}{{vars.idm}}']);
    expect(collVar(x, 'vars.idm')?.value).toBe('{{hub.idmPath}}');
    expect(envValue(x, 'hub.idmPath')?.value).toBe('/api/idm/v3');
    expect(envValue(x, 'hub.baseUrl')?.value).toBe('https://{{hub.tenant}}.example.com');
    expect(collVar(x, 'inputs.count')).toMatchObject({ value: '5', type: 'number' });
    expect(one!.request.url.raw).toBe('{{hub.baseUrl}}{{vars.idm}}/Users/{{vars.users.body.resources[0].id}}');
    expect(one!.request.header).toContainEqual({ key: 'X-Fixed', value: '{{vars.fixed}}' });
    expect(collVar(x, 'vars.fixed')?.value).toBe('abc');
    // the producer stores what the later template and the later check read
    const t1 = scriptOf(users!, 'test');
    expect(t1).toContain('$w("vars.users.body.resources[0].id", $p($out, [["body"],["resources",0],["id"]]));');
    expect(t1).toContain('$wj("steward.vars.users.body.resources[0].id", $p($out, [["body"],["resources",0],["id"]]));');
    expect(t1).toContain('pm.test("enough", function () {');
    expect(t1).toContain('$count($p($out, [["body"],["resources"]]))');
    const t2 = scriptOf(one!, 'test');
    expect(t2).toContain('$eq($p($out, [["body"],["id"]]), $j("steward.vars.users.body.resources[0].id"))');
    expect(t2).not.toContain('pm.require');
    for (const item of [users!, one!]) expect(() => new Function(scriptOf(item, 'test'))).not.toThrow();
    expect(scriptOf(x.collection, 'prerequest')).toContain('const P = "hub.";');
    expect(folderOf(x.collection).description).not.toContain('Set by hand');
    expectValid(x.collection);
  });

  it('checks outside the subset fall back to JSONata via pm.require – and the folder says they need the Postman app or CLI', () => {
    const x = exportProcess(
      {
        name: 'Fallback',
        connections: [{ slot: 'api' }],
        steps: [
          { id: 'list', type: 'http', connection: 'api', method: 'GET', path: '/items', saveAs: 'list' },
          { id: 'plain', type: 'check', condition: 'vars.list.status = 200' },
          { id: 'filtered', type: 'check', name: 'No inactive items', condition: '$count(vars.list.body[active = false]) = 0', severity: 'warning' },
          { id: 'stewardData', type: 'check', condition: "$trend('ih.users/total', '7d').change < 10" },
        ],
      },
      { api: platform({ type: 'none' }) },
    );
    const t = scriptOf(requests(x.collection)[0]!, 'test');
    expect(t).toContain(`pm.require('npm:jsonata@${JSONATA_VERSION}')`);
    expect(t).toContain('pm.test("[warning] No inactive items", function (done) {');
    expect(t).toContain('"list": $out');
    expect(t).toContain('jsonata("$count(vars.list.body[active = false]) = 0").evaluate(scope, bindings)');
    expect(() => new Function(t)).not.toThrow();
    const d = folderOf(x.collection).description!;
    expect(d).toContain('### Checks that need the Postman app or the Postman CLI');
    expect(d).toContain('Newman does not');
    expect(d).toContain('"No inactive items"');
    expect(d).not.toContain('"plain"');
    expect(d).toContain('### Checks not exported');
    expect(d).toContain('"stewardData"');
    expectValid(x.collection);
  });

  it('a JSONata check reading an earlier answer gets it stored whole by that request', () => {
    const x = exportProcess(
      {
        name: 'Whole',
        connections: [{ slot: 'api' }],
        steps: [
          { id: 'a', type: 'http', connection: 'api', method: 'GET', path: '/a', saveAs: 'a' },
          { id: 'b', type: 'http', connection: 'api', method: 'GET', path: '/b', saveAs: 'b' },
          { id: 'cmp', type: 'check', condition: '$sum(vars.a.body.n) = $sum(vars.b.body.n)' },
        ],
      },
      {},
    );
    const [a, b] = requests(x.collection);
    expect(scriptOf(a!, 'test')).toContain('$wj("steward.vars.a", $out);');
    expect(scriptOf(b!, 'test')).toContain('"a": $j("steward.vars.a"), "b": $out');
  });

  it('values the export cannot compute are variables set by hand, listed in the folder description', () => {
    const x = exportProcess({
      name: 'By hand',
      connections: [{ slot: 'api' }],
      inputs: [{ name: 'users', type: 'list', default: 'a@example.com\nb@example.com\n' }],
      steps: [
        {
          id: 'loop',
          type: 'forEach',
          name: 'Each user',
          items: 'inputs.users',
          as: 'u',
          steps: [
            {
              id: 'find',
              type: 'http',
              connection: 'api',
              method: 'GET',
              path: '/users',
              query: { filter: 'userName eq "{{ $lowercase(vars.u) }}"', id: '{{ vars.u }}' },
            },
          ],
        },
        { id: 'who', type: 'http', connection: 'api', method: 'GET', path: '/whoami/{{ run.actor }}' },
      ],
    });
    const [find, who] = requests(x.collection);
    expect(find!.request.url.raw).toBe('{{api.baseUrl}}/users?filter=userName eq "{{expr.find.1}}"&id={{vars.u}}');
    expect(find!.request.description).toContain('In the loop "Each user": Steward runs this once per item of `inputs.users`');
    expect(who!.request.url.raw).toBe('{{api.baseUrl}}/whoami/{{expr.who.1}}');
    expect(collVar(x, 'inputs.users')?.value).toBe('["a@example.com","b@example.com"]');
    const d = folderOf(x.collection).description!;
    expect(d).toContain('### Set by hand');
    expect(d).toContain('Set {{expr.find.1}} by hand – Steward computes `$lowercase(vars.u)` there.');
    expect(d).toContain('Set {{vars.u}} by hand – Steward computes each item of `inputs.users` (loop "Each user") there.');
    expect(d).toContain('Set {{expr.who.1}} by hand – Steward computes `run.actor` there.');
    expect(d).toContain('`api`: exported without a platform');
    expect(collVar(x, 'expr.find.1')?.description).toContain('Set by hand');
    expectValid(x.collection);
  });

  it('steps without a request are notes: approvals (four-eyes), manual steps, browser, datasets, sub-processes, loops, waits', () => {
    const x = exportProcess({
      name: 'Notes',
      connections: [{ slot: 'api' }],
      steps: [
        { id: 'approve', type: 'userTask', name: 'Approve', mode: 'approve', title: 'OK?', assignees: ['role:approver'], fourEyes: true },
        { id: 'manual', type: 'userTask', name: 'Replace device', mode: 'manual', title: 'Replace', checklist: ['a', 'b'], verification: { required: true } },
        { id: 'br', type: 'browser', name: 'Portal', actions: [{ action: 'goto', value: 'https://portal.example.com' }] },
        { id: 'pub', type: 'publish', name: 'Publish', dataset: 'x.users', rows: 'vars.rows' },
        { id: 'sub', type: 'subprocess', name: 'Child', process: 'child-process' },
        { id: 'pause', type: 'wait', name: 'Pause', seconds: 30 },
        { id: 'acc', type: 'accessChange', name: 'Record', connection: 'api', kind: 'revoke', subjectId: 'x' },
        { id: 'call', type: 'http', connection: 'api', method: 'GET', path: '/x', paginate: { mode: 'page' }, retry: { attempts: 3 } },
        {
          id: 'cond',
          type: 'if',
          name: 'Big?',
          condition: 'vars.call.body.total > 10',
          then: [{ id: 'big', type: 'http', connection: 'api', method: 'POST', path: '/big' }],
          else: [{ id: 'small', type: 'http', connection: 'api', method: 'POST', path: '/small' }],
        },
        { id: 'after', type: 'http', connection: 'api', method: 'GET', path: '/after' },
      ],
    });
    const d = folderOf(x.collection).description!;
    expect(d).toContain('"Approve": an approval by role:approver (four-eyes: not by the person who started the run).');
    expect(d).toContain('"Replace device": a manual step with a checklist of 2, verified by a second person (four-eyes).');
    expect(d).toContain('"Portal": browser automation (1 action(s)).');
    expect(d).toContain('"Publish": publishes the dataset `x.users` for dashboards.');
    expect(d).toContain('"Child": runs the sub-process `child-process`');
    expect(d).toContain('"Pause": waits 30 s.');
    expect(d).toContain('"Record": records an access change (revoke) for compliance.');
    expect(d).toContain('"Big?": a branch on `vars.call.body.total > 10`');
    const items = requests(x.collection);
    expect(items.map((i) => i.id)).toEqual(['call', 'big', 'small', 'after']);
    const byId = (id: string) => items.find((i) => i.id === id)!;
    expect(byId('call').request.description).toContain('Steward reads all pages (page); this request fetches the first one.');
    expect(byId('call').request.description).toContain('up to 3 time(s)');
    expect(byId('big').request.description).toContain('Only when `vars.call.body.total > 10` ("Big?").');
    expect(byId('small').request.description).toContain('Only when this is false: `vars.call.body.total > 10`');
    // after the branch both paths meet: no condition
    expect(byId('after').request.description ?? '').not.toContain('Only when');
    expectValid(x.collection);
  });

  it('step order follows the wires (ports in their order), not the order of the nodes', () => {
    const def = definition({
      name: 'Graph',
      nodes: [
        { id: 'z', type: 'log', message: 'z', x: 0, y: 300 },
        { id: 'b', type: 'log', message: 'b', x: 0, y: 200 },
        { id: 'start', type: 'start', x: 0, y: 0 },
        { id: 'a', type: 'if', condition: 'true', x: 0, y: 100 },
      ],
      wires: [
        { from: 'start', port: 'out', to: 'a' },
        { from: 'a', port: 'false', to: 'z' },
        { from: 'a', port: 'true', to: 'b' },
        { from: 'b', port: 'out', to: 'z' },
      ],
    });
    const { placed } = stepOrder(def);
    expect(placed.map((p) => p.node.id)).toEqual(['a', 'b', 'z']);
    expect(placed.find((p) => p.node.id === 'z')!.context).toEqual([]);
  });

  it('every example process exports a collection that passes the Postman Collection v2.1 schema, with scripts that compile', () => {
    const dir = path.join(here, '..', '..', 'examples', 'processes');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) {
      const def = definition(YAML.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
      const x = processToPostman(
        { id: f.replace(/\.yaml$/, ''), name: def.name, version: 1, definition: def },
        Object.fromEntries(
          def.connections.map((c) => [c.slot, { platform: c.kind === 'insights-hub' ? ih : platform({ type: 'bearer' }, { kind: c.kind ?? 'generic' }) }]),
        ),
        OPTS,
      );
      const ok = validateCollection(x.collection);
      expect(ok, `${f}: ${JSON.stringify(validateCollection.errors?.slice(0, 3))}`).toBe(true);
      const scripts = [x.collection, ...requests(x.collection)].flatMap((i) => (i.event ?? []).map((e) => e.script.exec.join('\n')));
      for (const s of scripts) expect(() => new Function(s), f).not.toThrow();
      expect(
        x.environment.values.filter((v) => v.type === 'secret').every((v) => v.value === ''),
        f,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Platforms: OpenAPI operations
// ---------------------------------------------------------------------------

describe('platform API descriptions', () => {
  it('operations become requests in folders per tag, with path variables, query and header parameters and an example body', () => {
    const p = platform({ type: 'bearer' }, { config: { auth: { type: 'bearer' }, variables: {}, http: { insecureTls: true } }, ...{ secretKeys: ['token'] } });
    p.config.testPath = '/health';
    const x = platformToPostman(
      p,
      [
        {
          specId: 's1',
          method: 'get',
          path: '/users/{id}',
          summary: 'Get a user',
          tag: 'Users',
          operationId: 'getUser',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'expand', in: 'query', schema: { type: 'string', enum: ['groups'] } },
            { name: 'limit', in: 'query', required: true, schema: { type: 'integer', default: 10 } },
            { name: 'X-Request-Id', in: 'header' },
          ],
          successStatus: [200],
        },
        {
          specId: 's1',
          method: 'post',
          path: '/users',
          tag: 'Users',
          hasBody: true,
          requestContentType: 'application/json',
          requestBodyExample: { name: 'string' },
        },
        { specId: 's1', method: 'delete', path: '/cache' },
      ],
      OPTS,
    );
    const names = x.collection.item.map((i) => i.name);
    expect(names).toEqual(['Connection test', 'Users', 'Operations']);
    const users = (x.collection.item[1] as PmFolder).item as PmItem[];
    const get = users[0]!;
    expect(get.name).toBe('Get a user');
    expect(get.request.url.raw).toBe('{{baseUrl}}/users/:id?limit=10');
    expect(get.request.url.variable).toEqual([{ key: 'id', value: '' }]);
    expect(get.request.url.query).toEqual([
      { key: 'expand', value: 'groups', disabled: true },
      { key: 'limit', value: '10' },
    ]);
    expect(get.request.header).toContainEqual({ key: 'X-Request-Id', value: '', disabled: true });
    expect(get.protocolProfileBehavior).toEqual({ strictSSL: false });
    expect(scriptOf(get, 'test')).toContain('pm.expect(pm.response.code).to.be.oneOf([200]);');
    const post = users[1]!;
    expect(JSON.parse(post.request.body!.raw!)).toEqual({ name: 'string' });
    expect(post.request.header).toContainEqual({ key: 'Content-Type', value: 'application/json' });
    expect((x.collection.item[0] as PmItem).request.url.raw).toBe('{{baseUrl}}/health');
    expect(envValue(x, 'baseUrl')?.value).toBe('https://api.example.com/v1');
    expect(x.collection.info.description).toContain('3 operation(s)');
    expect(x.collection.info.description).toContain('strictSSL false');
    expect(x.fileBase).toBe('Demo-API');
    expectValid(x.collection);
  });

  it('the schema refuses what is not a collection (the validation is not vacuous)', () => {
    const x = platformToPostman(platform({ type: 'none' }), [], OPTS);
    expect(validateCollection({ ...x.collection, auth: { type: 'oauth9' } })).toBe(false);
    expect(validateCollection({ ...x.collection, item: [{ name: 'x', request: { method: 'GET', url: 1 } }] })).toBe(false);
    expect(validateCollection({ info: x.collection.info })).toBe(false);
  });
});
