/**
 * Regression tests for security review 0.9.0 (a): the platform and outbound layer. Each block reproduces a proof of
 * concept of the review and checks that it no longer works.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

let s: TestServer;
type Hit = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };
const hits: Hit[] = [];
const hits2: Hit[] = [];
let echo: http.Server;
let echo2: http.Server;
let echoBase = '';
let echo2Base = '';
/** What the echo server answers on a path (default: {"ok":true}). */
const answers = new Map<string, { status: number; headers?: Record<string, string>; body?: unknown }>();

const n = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, ...extra });
const DONE = ['succeeded', 'failed', 'cancelled', 'waiting'];
const WATCH = '7d3c1a90-5b2e-4f61-8c47-1a2b3c4d5e01';

function server(list: Hit[]): http.Server {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      list.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const a = answers.get(req.url!.split('?')[0]!);
      res.writeHead(a?.status ?? 200, { 'content-type': 'application/json', ...(a?.headers ?? {}) }).end(JSON.stringify(a?.body ?? { ok: true }));
    });
  });
}

beforeAll(async () => {
  echo = server(hits);
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
  echoBase = `http://127.0.0.1:${(echo.address() as AddressInfo).port}`;
  echo2 = server(hits2);
  await new Promise<void>((r) => echo2.listen(0, '127.0.0.1', r));
  echo2Base = `http://127.0.0.1:${(echo2.address() as AddressInfo).port}`;
  s = await startTestServer();
  await setup(s);
});
afterAll(async () => {
  await s?.app.close();
  echo.close();
  echo2.close();
});

const code = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { body?: { code?: string }; status?: number }) => e.body?.code ?? e.status,
  );

async function platform(name: string, kind: string, baseUrl: string, secrets?: Record<string, string>, http: Record<string, unknown> = {}) {
  return s.api('POST', '/platforms', {
    name,
    kind,
    baseUrl,
    config: {
      auth: secrets ? { type: 'apiKey', apiKeyIn: 'header', apiKeyName: 'x-api-key' } : { type: 'none' },
      variables: {},
      http: { proxy: 'none', ...http },
    },
    ...(secrets ? { secrets } : {}),
  });
}

async function runProcess(name: string, connections: unknown[], nodes: unknown[], bindings: Record<string, string>, extra: Record<string, unknown> = {}) {
  const wires = nodes.slice(1).map((x, i) => ({ from: (nodes[i] as { id: string }).id, port: 'out', to: (x as { id: string }).id }));
  const proc = await s.api('POST', '/processes', { definition: { name, connections, inputs: [], nodes, wires } });
  const { id } = await s.api('POST', '/runs', { processId: proc.id, bindings, inputs: {}, ...extra });
  return s.waitRun(id, DONE);
}
const stepError = (run: any, key: string) => String(run.steps?.find((x: any) => x.key === key)?.error ?? '');

// ---------------------------------------------------------------------------------------------------------------
// 1 (Medium): read-only kinds and the vault deny list bypassed through another connection slot
// ---------------------------------------------------------------------------------------------------------------

describe('1a: a platform’s credentials only travel through its own connection', () => {
  let cd: any;
  let gen: any;
  beforeAll(async () => {
    cd = await platform('cd (read-only kind)', 'changedetection', echoBase, { apiKey: 'cd-SECRET-key-0123456789' });
    gen = await platform('some generic API', 'generic', `${s.base}/mock`);
  });

  it('refuses $secret of another slot in a header, the query, the body or the URL – before anything is sent, audited', async () => {
    const cases: Record<string, unknown>[] = [
      { method: 'DELETE', path: `${echoBase}/api/v1/watch/${WATCH}`, headers: { 'x-api-key': "{{ $secret('cd', 'apiKey') }}" } },
      { method: 'GET', path: `${echo2Base}/x`, query: { k: "{{ $secret('cd', 'apiKey') }}" } },
      { method: 'POST', path: `${echo2Base}/x`, body: { k: "{{ $secret('cd', 'apiKey') }}" } },
      { method: 'GET', path: `${echo2Base}/x/{{ $secret('cd', 'apiKey') }}` },
    ];
    for (const [i, step] of cases.entries()) {
      hits.length = 0;
      hits2.length = 0;
      const run = await runProcess(
        `bypass-${i}`,
        [{ slot: 'cd', kind: 'changedetection' }, { slot: 'gen' }],
        [n('start', 'start'), n('req', 'http', { connection: 'gen', ...step })],
        { cd: cd.id, gen: gen.id },
      );
      expect(run.status, JSON.stringify(step)).toBe('failed');
      expect(stepError(run, 'req')).toMatch(/connection "gen" contains a credential of connection "cd"/);
      expect(hits.length + hits2.length).toBe(0);
      expect(JSON.stringify(run)).not.toContain('cd-SECRET-key-0123456789');
    }
    const audit = await s.api('GET', '/audit?limit=50');
    const entry = (audit.items ?? audit).find((e: any) => e.action === 'run.secret_refused');
    expect(entry).toMatchObject({ details: { slot: 'cd', sender: 'gen', platform: 'cd (read-only kind)' } });
    expect(JSON.stringify(entry)).not.toContain('cd-SECRET-key-0123456789');
  });

  it('also in a dry run and in a test run (nothing is sent there, but the process would fail for real)', async () => {
    const def = [n('start', 'start'), n('req', 'http', { connection: 'gen', method: 'DELETE', path: '/x', headers: { k: "{{ $secret('cd', 'apiKey') }}" } })];
    const slots = [{ slot: 'cd', kind: 'changedetection' }, { slot: 'gen' }];
    const dry = await runProcess('bypass-dry', slots, def, { cd: cd.id, gen: gen.id }, { dryRun: true });
    expect(stepError(dry, 'req')).toMatch(/credential of connection "cd"/);
    await s.api('POST', `/platforms/${gen.id}/recordings`, { method: 'DELETE', path: '/x', status: 204, body: null });
    const test = await runProcess('bypass-test', slots, def, { cd: cd.id, gen: gen.id }, { recorded: true });
    expect(test.recorded).toBe(true);
    expect(stepError(test, 'req')).toMatch(/credential of connection "cd"/);
  });

  it('the own slot still sends its own secret to its own origin', async () => {
    hits.length = 0;
    const run = await runProcess(
      'own-slot',
      [{ slot: 'cd', kind: 'changedetection' }, { slot: 'gen' }],
      [
        n('start', 'start'),
        n('req', 'http', { connection: 'cd', method: 'GET', path: '/api/v1/systeminfo', headers: { 'x-check': "{{ $secret('cd', 'apiKey') }}" } }),
      ],
      { cd: cd.id, gen: gen.id },
    );
    expect(run.status).toBe('succeeded');
    expect(hits[0]?.headers['x-check']).toBe('cd-SECRET-key-0123456789');
  });
});

describe('1b: a request to the origin of a platform with kind rules gets those rules, whichever platform sends it', () => {
  let cd: any;
  let gen: any;
  beforeAll(async () => {
    cd = await s.api('GET', '/platforms').then((l: any[]) => l.find((p) => p.name === 'cd (read-only kind)'));
    cd ??= await platform('cd (read-only kind)', 'changedetection', echoBase, { apiKey: 'cd-SECRET-key-0123456789' });
    gen = await platform('generic for 1b', 'generic', `${s.base}/mock`);
  });

  it('the explorer: a changing method or a refused path to a changedetection.io origin through another platform', async () => {
    hits.length = 0;
    const req = (method: string, path: string, headers?: Record<string, string>) =>
      code(s.api('POST', `/platforms/${gen.id}/request`, { method, path, ...(headers ? { headers } : {}) }));
    // the review's proof of concept, with the key typed in by someone who knows it
    expect(await req('DELETE', `${echoBase}/api/v1/watch/${WATCH}`, { 'x-api-key': 'cd-SECRET-key-0123456789' })).toBe('PLATFORM_METHOD_DENIED');
    expect(await req('GET', `${echoBase}/api/v1/watch/${WATCH}/history/1762333200`)).toBe('PLATFORM_PATH_DENIED');
    expect(await req('GET', `${echoBase}/api/v1/watch?recheck_all=1`)).toBe('PLATFORM_PATH_DENIED');
    expect(hits).toHaveLength(0);
    // reading stays possible – and the answer loses the kind's value keys
    answers.set('/api/v1/watch/' + WATCH, {
      status: 200,
      body: { title: 't', notification_urls: ['posts://h?token=1'], url: 'https://u:p@site.example/?token=abc' },
    });
    const r = await s.api('POST', `/platforms/${gen.id}/request`, { method: 'GET', path: `${echoBase}/api/v1/watch/${WATCH}` });
    expect(r.body).toEqual({ title: 't', url: 'https://site.example/?token=***' });
    answers.clear();
  });

  it('a process step on another slot, and a redirect hop that ends at the read-only origin', async () => {
    hits.length = 0;
    const run = await runProcess(
      'rule-b-step',
      [{ slot: 'gen' }],
      [n('start', 'start'), n('del', 'http', { connection: 'gen', method: 'DELETE', path: `${echoBase}/api/v1/watch/${WATCH}` })],
      { gen: gen.id },
    );
    expect(stepError(run, 'del')).toMatch(/Steward only reads changedetection platforms: DELETE is refused/);
    // a 307 from another platform's origin to the read-only one keeps the method: refused on that hop
    const other = await platform('redirector', 'generic', echo2Base);
    answers.set('/to-cd', { status: 307, headers: { location: `${echoBase}/api/v1/watch/${WATCH}` } });
    expect(await code(s.api('POST', `/platforms/${other.id}/request`, { method: 'DELETE', path: '/to-cd' }))).toBe('PLATFORM_METHOD_DENIED');
    answers.clear();
    expect(hits.filter((h) => h.method === 'DELETE')).toHaveLength(0);
  });

  it('IBM Verify Privilege Vault: secret values are not read through another platform either', async () => {
    const vault = await platform('vault (deny list)', 'privilege-vault', echo2Base);
    expect(vault.kind).toBe('privilege-vault');
    hits2.length = 0;
    const r = await code(s.api('POST', `/platforms/${gen.id}/request`, { method: 'GET', path: `${echo2Base}/SecretServer/api/v1/secrets/12` }));
    expect(r).toBe('PLATFORM_PATH_DENIED');
    expect(hits2).toHaveLength(0);
    // a search stays possible, its answer without values
    answers.set('/SecretServer/api/v1/secrets', { status: 200, body: { records: [{ id: 12, name: 'db', itemValue: 'hunter2', password: 'x' }] } });
    const ok = await s.api('POST', `/platforms/${gen.id}/request`, { method: 'GET', path: `${echo2Base}/SecretServer/api/v1/secrets` });
    expect(JSON.stringify(ok.body)).not.toMatch(/hunter2|password/);
    answers.clear();
    await s.api('DELETE', `/platforms/${vault.id}`);
  });

  it('Kafka Connect and container registries are read-only through any platform', async () => {
    const kc = await platform('kc (read-only)', 'kafka-connect', echo2Base);
    hits2.length = 0;
    expect(await code(s.api('POST', `/platforms/${gen.id}/request`, { method: 'POST', path: `${echo2Base}/connectors/x/restart` }))).toBe(
      'PLATFORM_METHOD_DENIED',
    );
    expect(hits2).toHaveLength(0);
    await s.api('DELETE', `/platforms/${kc.id}`);
    // container-registry is labelled read-only and is read-only now (also through itself)
    const reg = await platform('registry', 'container-registry', echo2Base);
    expect(await code(s.api('POST', `/platforms/${reg.id}/request`, { method: 'DELETE', path: '/v2/x/manifests/1' }))).toBe('PLATFORM_METHOD_DENIED');
    await s.api('DELETE', `/platforms/${reg.id}`);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2 (Medium): confirm-config sealed identity settings the administrator never saw
// ---------------------------------------------------------------------------------------------------------------

describe('2: confirming the settings never seals what the platform page does not show', () => {
  it('a variable planted on the identity is reset at confirm; the dialog data and the audit entry name it', async () => {
    const p = await s.api('POST', '/platforms', {
      name: 'templated',
      kind: 'generic',
      baseUrl: 'http://127.0.0.1:{{ vars.port }}',
      config: {
        auth: { type: 'apiKey', apiKeyIn: 'header', apiKeyName: 'x-api-key' },
        variables: { port: echoBase.split(':').pop() },
        http: { proxy: 'none' },
      },
      secrets: { apiKey: 'tpl-SECRET-key-987654321' },
    });
    const { db } = await import('../src/db.js');
    db().run('UPDATE platform_identities SET variables = ? WHERE platform_id = ?', JSON.stringify({ port: echo2Base.split(':').pop() }), p.id);
    // a second identity, only a change in the database can make in this release
    db().run(
      `INSERT INTO platform_identities (id, platform_id, name, is_default, auth, variables, mcp, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, 'planted', 0, ?, '{}', '{"mode":"read"}', '2026-01-01', 'x', '2026-01-01', 'x')`,
      `pi_planted_${p.id}`,
      p.id,
      JSON.stringify({ type: 'token_request', request: { method: 'POST', url: `${echo2Base}/login?x=1` } }),
    );
    expect((await s.api('GET', `/platforms/${p.id}`)).integrity).toBe('mismatch'); // the default identity was changed
    const review = await s.api('GET', `/platforms/${p.id}/confirm-config`);
    expect(review.identities).toEqual([
      expect.objectContaining({
        default: true,
        action: 'reset',
        variables: { port: echo2Base.split(':').pop() },
        secretKeys: ['apiKey'],
        mcp: { mode: 'off' },
      }),
      expect.objectContaining({ default: false, name: 'planted', action: 'remove', signIn: { type: 'token_request', url: `${echo2Base}/login` } }),
    ]);
    await s.api('POST', `/platforms/${p.id}/confirm-config`);
    hits.length = 0;
    hits2.length = 0;
    // (echoBase is also the changedetection.io platform's origin above: a path its rules allow)
    await s.api('POST', `/platforms/${p.id}/request`, { method: 'GET', path: '/api/v1/watch' });
    expect(hits2).toHaveLength(0);
    expect(hits[0]?.headers['x-api-key']).toBe('tpl-SECRET-key-987654321');
    const after = await s.api('GET', `/platforms/${p.id}`);
    expect(after.identities.map((i: any) => i.name)).toEqual(['Default']);
    const audit = await s.api('GET', '/audit?limit=50');
    const entry = (audit.items ?? audit).find((e: any) => e.action === 'platform.config_confirmed' && e.entityId === p.id);
    expect(entry.summary).toMatch(/reset to the platform's – 1 other identity removed/);
    expect(entry.details.reviewed).toEqual([
      expect.objectContaining({ name: 'Default', action: 'reset', variables: { port: echo2Base.split(':').pop() } }),
      expect.objectContaining({ name: 'planted', action: 'remove' }),
    ]);
    expect(JSON.stringify(entry)).not.toContain('tpl-SECRET-key-987654321');
  });

  it('a sealed identity variable used in the base URL is ignored at use time (IDENTITY_VARIABLE_FIXED)', async () => {
    const p = await s.api('POST', '/platforms', {
      name: 'templated 2',
      kind: 'generic',
      baseUrl: 'http://127.0.0.1:{{ vars.port }}',
      config: { auth: { type: 'none' }, variables: { port: echoBase.split(':').pop(), team: 'a' }, http: { proxy: 'none' } },
    });
    const { db } = await import('../src/db.js');
    const { sealIdentity } = await import('../src/platforms/integrity.js');
    const { getConnection } = await import('../src/platforms/service.js');
    db().run('UPDATE platform_identities SET variables = ? WHERE platform_id = ?', JSON.stringify({ port: '1', team: 'b' }), p.id);
    sealIdentity(`pi_${p.id.slice(3)}`);
    expect(getConnection(p.id).platform.config.variables).toEqual({ port: echoBase.split(':').pop(), team: 'b' });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 3 (Medium): IPv6 literals skipped address safety and the own-API guard
// ---------------------------------------------------------------------------------------------------------------

describe('3: every address form is classified', () => {
  it('refuses metadata and link-local addresses in IPv6, IPv4-mapped, NAT64 and compatible forms', async () => {
    const { assertAddressSafe, blockedAddressReason } = await import('../src/platforms/outbound.js');
    for (const u of [
      'http://169.254.169.254/latest/meta-data/',
      'http://[::ffff:169.254.169.254]/latest/meta-data/',
      'http://[::ffff:a9fe:a9fe]/',
      'http://[0:0:0:0:0:ffff:a9fe:a9fe]/',
      'http://[64:ff9b::a9fe:a9fe]/',
      'http://[::169.254.169.254]/',
      'http://[fd00:ec2::254]/latest/meta-data/',
      'http://[fe80::1]/',
      'http://[febf::1]/',
      'http://[::ffff:100.100.100.200]/',
    ])
      await expect(assertAddressSafe(u), u).rejects.toThrow(/Blocked/);
    expect(blockedAddressReason('::ffff:a9fe:a9fe')).toMatch(/link-local/);
    expect(blockedAddressReason('[fe80::1%eth0]')).toMatch(/link-local/);
    // private and unique-local addresses stay reachable (on-premises platforms)
    for (const ip of ['10.1.2.3', 'fd12:3456::1', '::ffff:10.0.0.1', '2001:db8::1']) expect(blockedAddressReason(ip), ip).toBeNull();
  });

  it('the own-API guard: [::1], [::ffff:127.0.0.1], 0.0.0.0, [::] and localhost on the server port', async () => {
    const { assertAddressSafe } = await import('../src/platforms/outbound.js');
    const port = new URL(s.base).port;
    for (const h of ['127.0.0.1', '[::1]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '0.0.0.0', '[::]', 'localhost', 'LOCALHOST.', '127.1'])
      await expect(assertAddressSafe(`http://${h}:${port}/api/users`), h).rejects.toThrow(/Steward server itself/);
    // other paths of the port (the demo's mock platforms) and the public health check stay reachable
    await expect(assertAddressSafe(`http://[::1]:${port}/mock/x`)).resolves.toBeUndefined();
    await expect(assertAddressSafe(`http://localhost:${port}/api/health`)).resolves.toBeUndefined();
  });

  it('a platform request to an IP literal is checked before connecting (the pinning lookup never sees literals)', async () => {
    const p = await platform('v6 literal', 'generic', 'http://[::ffff:169.254.169.254]');
    const err = await s.api('POST', `/platforms/${p.id}/request`, { method: 'GET', path: '/latest/meta-data/' }).catch((e: any) => e);
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/link-local/);
    await s.api('DELETE', `/platforms/${p.id}`);
  });

  it('notification channels and monitor HTTP checks', async () => {
    const { sendWebhook } = await import('../src/notifications/channels.js');
    await expect(sendWebhook('http://[fd00:ec2::254]/hook', { title: 'x', text: 'x' } as never)).rejects.toThrow(/Blocked/);
    const checks = await import('../src/monitors/checks.js');
    const r = await checks.runActiveCheck({ id: 'v6', name: 'v6', type: 'http', url: 'http://[::ffff:a9fe:a9fe]/', method: 'GET' } as never, {
      owner: 'admin',
      signal: new AbortController().signal,
      timeoutMs: 5000,
      now: () => Date.now(),
    });
    expect(r).toMatchObject({ status: 'unknown', message: expect.stringMatching(/Target not allowed: .*link-local/) });
  });

  it('IPv6 CIDRs and IPv4 CIDRs for IPv4-mapped hosts on the allow-list', async () => {
    const { allowListMatches } = await import('../src/platforms/outbound.js');
    expect(allowListMatches('fd12::/16', new URL('http://[fd12::5]/'))).toBe(true);
    expect(allowListMatches('fd12::/16', new URL('http://[fd13::5]/'))).toBe(false);
    expect(allowListMatches('10.0.0.0/8', new URL('http://[::ffff:10.1.2.3]/'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 4–8 (Low / Info)
// ---------------------------------------------------------------------------------------------------------------

describe('4: Kafka Connect redaction', () => {
  it('masks authorization headers, JDBC credentials, user:password@ and keys or tokens in lists and nested values', async () => {
    const { redactConnectAnswer } = await import('@sm/shared');
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop';
    const out = redactConnectAnswer({
      config: {
        headers: 'Authorization:Bearer s3cr3tT0ken|Content-Type:application/json',
        'http.headers': 'Authorization: Basic dXNlcjpodW50ZXIy',
        'request.header.x': 'Authorization: Bearer abcdefgh123',
        'connection.url': 'jdbc:oracle:thin:scott/tiger@//db.example:1521/ORCL',
        'connection.url2': 'jdbc:oracle:thin:scott:tiger@db.example:1521:ORCL',
        'proxy.url': 'user:hunter2@proxy.example:8080',
        'proxy.auth': 'user:hunter2',
        list: ['-----BEGIN PRIVATE KEY-----xyz', jwt, 'orders'],
        nested: { deep: [{ v: '-----BEGIN PRIVATE KEY-----xyz' }, jwt] },
        note: 'basic tier, mail ops@example.com',
        'connection.url3': 'jdbc:oracle:thin:@//db.example:1521/ORCL',
      },
    });
    const text = JSON.stringify(out);
    for (const secret of ['s3cr3tT0ken', 'dXNlcjpodW50ZXIy', 'abcdefgh123', 'tiger', 'hunter2', 'BEGIN PRIVATE', jwt])
      expect(text, secret).not.toContain(secret);
    expect(out.config).toMatchObject({
      'connection.url': 'jdbc:oracle:thin:scott/***@//db.example:1521/ORCL',
      'proxy.url': 'user:***@proxy.example:8080',
      'connection.url3': 'jdbc:oracle:thin:@//db.example:1521/ORCL',
      note: 'basic tier, mail ops@example.com',
      list: ['***', '***', 'orders'],
    });
  });
});

describe('5: changedetection.io watch URLs', () => {
  it('lose user info, fragments and secret-looking query values; only http(s)', async () => {
    const { parseWatch } = await import('../src/changedetection/client.js');
    const { stripValues } = await import('../src/platforms/deniedPaths.js');
    const w = parseWatch(WATCH, { url: 'https://admin:hunter2@intranet.example/status?token=abc&page=2#k', title: 'S' }, new Map());
    expect(w?.url).toBe('https://intranet.example/status?token=***&page=2');
    expect(parseWatch(WATCH, { url: 'javascript:alert(1)' }, new Map())?.url).toBe('');
    expect(stripValues('changedetection', { url: 'https://admin:hunter2@intranet.example/?sig=x', Headers: { a: 1 } })).toEqual({
      url: 'https://intranet.example/?sig=***',
    });
  });
});

describe('6: example process 76 puts payload text into the task as code', () => {
  it('a forged tag or title cannot add a link', async () => {
    const cdId = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'changedetection' && p.name === 'changedetection.io (demo)')?.id;
    if (!cdId) await s.api('POST', '/demo/setup', {});
    const cd = cdId ?? (await s.api('GET', '/platforms')).find((p: any) => p.name === 'changedetection.io (demo)').id;
    const ex = (await s.api('GET', '/triggers/examples')).find((x: any) => x.id === '10-changedetection-review');
    const created = await s.api('POST', '/triggers', {
      name: 'cd notification (090a)',
      processId: 'changedetection-review-change',
      bindings: { changedetection: cd },
      inputMapping: ex.inputMapping,
      authMode: ex.authMode,
    });
    const evil = '[Open the diff](https://evil.example.net/x) `x` **y**';
    const res = await fetch(`${s.base}/api/hooks/${created.trigger.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-steward-token': created.secret },
      body: JSON.stringify({ ...ex.samplePayload, watch_tag: evil }),
    });
    const run = await s.waitRun((await res.json()).runId);
    const task = run.tasks.find((t: any) => t.status === 'open');
    expect(task.instructions).toContain("– tags: `[Open the diff](https://evil.example.net/x) 'x' **y**`");
    await s.api('POST', `/runs/${run.id}/cancel`).catch(() => undefined);
    await s.api('DELETE', `/triggers/${created.trigger.id}`);
  });
});

describe('7: monitor HTTP checks and a 307/308 to another origin', () => {
  it('do not send a body with a header value of the check again', async () => {
    await s.api('PUT', '/settings', { outboundAllowList: ['127.0.0.1'] });
    answers.set('/login', { status: 307, headers: { location: `${echo2Base}/elsewhere` } });
    hits2.length = 0;
    const checks = await import('../src/monitors/checks.js');
    const r = await checks.runActiveCheck(
      {
        id: 'post',
        name: 'post',
        type: 'http',
        url: `${echoBase}/login`,
        method: 'POST',
        headers: { 'x-api-key': 'monitor-key-424242' },
        body: '{"key":"monitor-key-424242"}',
      } as never,
      { owner: 'admin', signal: new AbortController().signal, timeoutMs: 5000, now: () => Date.now() },
    );
    expect(r).toMatchObject({ status: 'unknown', message: expect.stringMatching(/Target not allowed: Blocked: .* would receive the request body again/) });
    expect(hits2).toHaveLength(0);
    answers.clear();
    await s.api('PUT', '/settings', { outboundAllowList: [] });
  });
});

describe('8: hardening notes', () => {
  it('fetchSpec allows plain http only to the loopback host itself', async () => {
    const p = await platform('spec source', 'generic', echoBase);
    const { fetchSpec } = await import('../src/platforms/connectors.js');
    await expect(fetchSpec(p.id, 'http://localhost.evil.example/spec.json')).rejects.toThrow(/Only https URLs are allowed/);
    await expect(fetchSpec(p.id, 'http://127.0.0.1.evil.example/spec.json')).rejects.toThrow(/Only https URLs are allowed/);
  });

  it('stripValues of changedetection.io answers keeps __proto__ out of the copy', async () => {
    const { stripValues } = await import('../src/platforms/deniedPaths.js');
    const out = stripValues('changedetection', JSON.parse('{"a":{"__proto__":{"polluted":1},"b":2}}')) as { a: Record<string, unknown> };
    expect(Object.getPrototypeOf(out.a)).toBe(Object.prototype);
    expect(out.a).toEqual({ b: 2 });
  });
});
