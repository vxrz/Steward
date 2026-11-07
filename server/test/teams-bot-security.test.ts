import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';
import { startMockBotConnector, type MockBotConnector } from '../src/mock/mockBotConnector.js';

/**
 * Regression tests of the security review of 0.10.0 (Teams approvals, ADR 0013): a Teams decision needs a recent Steward
 * sign-in; bot calls follow no redirects; the card refresh checks the one task; personal cards show what is decided,
 * channel cards do not; refreshes check visibility and old card data is refused; the metadata is not fetched again on
 * every failing request.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';

const APP_ID = '11111111-2222-4333-8444-555555555555';
const TENANT = '6f1b2c3d-0000-4000-8000-00000000beef';
const NINA_OID = '0a1f3000-0000-4000-8000-0000000000b2';
const RIA_OID = '0a1f3000-0000-4000-8000-0000000000b3';
const PW = 'Teams-sec-password-1';

let s: TestServer;
let bot: FastifyInstance;
let mock: MockBotConnector;
let admin2: Client;
let dbm: typeof import('../src/db.js');
let processId = '';
let hiddenProcess = '';

const ISS = `https://login.microsoftonline.com/${TENANT}/v2.0`;

function activity(oid: string, over: Record<string, any> = {}): Record<string, any> {
  return {
    type: 'invoke',
    name: 'adaptiveCard/action',
    id: `act-${Math.random().toString(36).slice(2)}`,
    channelId: 'msteams',
    serviceUrl: mock.url,
    locale: 'en-US',
    from: { id: '29:x', aadObjectId: oid },
    recipient: { id: `28:${APP_ID}` },
    conversation: { id: `a:personal-${oid}`, tenantId: TENANT, conversationType: 'personal' },
    channelData: { tenant: { id: TENANT } },
    ...over,
  };
}
async function call(a: Record<string, any>) {
  const r = await bot.inject({
    method: 'POST',
    url: '/teams/bot/messages',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${mock.sign({})}` },
    payload: JSON.stringify(a),
  });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
}
const execute = (oid: string, verb: string, data: unknown) => activity(oid, { value: { action: { type: 'Action.Execute', verb, data } } });

async function dataOf(kind: 'task' | 'mcp_request', id: string, now?: number) {
  const { cardData } = await import('../src/msteams/botcard.js');
  const { versionOf } = await import('../src/msteams/decide.js');
  return cardData(kind, id, versionOf(kind, id)!, now)!;
}
async function waitingTask(pid: string): Promise<string> {
  const { id } = await s.api('POST', '/runs', { processId: pid });
  return (await s.waitRun(id, ['waiting'])).tasks[0].id;
}
const taskStatus = (id: string) => dbm.db().get<{ status: string }>('SELECT status FROM run_tasks WHERE id = ?', id)!.status;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  dbm = await import('../src/db.js');
  mock = await startMockBotConnector({ appId: APP_ID });
  const { useMockFramework } = await import('../src/msteams/framework.js');
  useMockFramework(mock.endpoints);
  const settings = await s.api('GET', '/settings');
  await s.api('PUT', '/settings', { outboundPolicy: 'allowList', outboundAllowList: [...(settings.outboundAllowList ?? []), mock.url] });
  const { buildBotApp } = await import('../src/msteams/listener.js');
  bot = await buildBotApp();
  dbm
    .db()
    .run(
      'INSERT INTO identity_providers (id, config, secret, enabled, created_at, updated_at) VALUES (?, ?, NULL, 1, ?, ?)',
      'idp_entra_sec',
      JSON.stringify({ type: 'entra', displayName: 'Entra', issuer: ISS, clientId: 'x', stableIdClaims: ['tid', 'oid'] }),
      new Date().toISOString(),
      new Date().toISOString(),
    );
  const users = await import('../src/auth/users.js');
  const { identityKeys } = await import('../src/auth/sso-claims.js');
  for (const [name, oid] of [
    ['nina', NINA_OID],
    ['ria', RIA_OID],
  ] as const) {
    users.createUser({ username: name, roles: ['approver'], password: PW, mustChangePassword: false });
    dbm
      .db()
      .run('UPDATE users SET external_id = ? WHERE username = ?', identityKeys('idp_entra_sec', { iss: ISS, tid: TENANT, oid }, ['tid', 'oid']).key!, name);
  }
  // ria signed in to Steward today; nina never did
  await s.as('ria', PW);
  dbm.db().run("UPDATE users SET last_login_at = NULL WHERE username = 'nina'");
  const { temporaryPassword } = await s.api('POST', '/users', { username: 'admin2', roles: ['admin'] });
  const first = await s.as('admin2', temporaryPassword);
  await first('POST', '/auth/password', { current: temporaryPassword, next: 'Admin2-password-1' });
  admin2 = await s.as('admin2', 'Admin2-password-1');
  await s.api('PUT', '/settings/teams-bot', {
    enabled: true,
    appId: APP_ID,
    tenantIds: [TENANT],
    providerId: 'idp_entra_sec',
    credential: 'secret',
    clientSecret: 'bot-secret-value',
  });
  await admin2('POST', `/assurance/policy/changes/${(await s.api('GET', '/assurance/policy')).pending.id}/approve`, {});
  const def = (name: string) => ({
    definition: {
      name,
      nodes: [
        { id: 'start', type: 'start', x: 0, y: 0 },
        {
          id: 'ok',
          type: 'userTask',
          mode: 'approve',
          title: `${name} step`,
          instructions: 'Check ticket CHG-4711 before you approve.',
          assignees: ['role:approver'],
          x: 1,
          y: 0,
        },
      ],
      wires: [{ from: 'start', port: 'out', to: 'ok' }],
    },
  });
  processId = (await s.api('POST', '/processes', def('Sec approval'))).id;
  hiddenProcess = (await s.api('POST', '/processes', def('Hidden approval'))).id;
});
afterAll(async () => {
  const { useMockFramework } = await import('../src/msteams/framework.js');
  useMockFramework(null);
  await bot?.close();
  await mock?.close();
  await s?.app.close();
});

describe('a Teams decision needs a recent Steward sign-in (F1)', () => {
  it('refuses a linked account that never signed in, and one whose last sign-in is older than the setting', async () => {
    const taskId = await waitingTask(processId);
    const r = await call(execute(NINA_OID, 'approve', await dataOf('task', taskId)));
    expect(JSON.stringify(r.body)).toContain('Sign in to Steward once to decide here');
    expect(taskStatus(taskId)).toBe('open');
    // 8 days ago: still refused with the default of 7 days …
    dbm.db().run("UPDATE users SET last_login_at = ? WHERE username = 'nina'", new Date(Date.now() - 8 * 86_400_000).toISOString());
    expect(JSON.stringify((await call(execute(NINA_OID, 'approve', await dataOf('task', taskId)))).body)).toContain('within the last 7 days');
    expect(taskStatus(taskId)).toBe('open');
    // … decided with 10 days
    const { preview: _p, hasCredential: _h, listener: _l, approved: _a, approvalPending: _ap, ...cur } = await s.api('GET', '/settings/teams-bot');
    await s.api('PUT', '/settings/teams-bot', { ...cur, signInDays: 10 });
    await call(execute(NINA_OID, 'approve', await dataOf('task', taskId)));
    expect(taskStatus(taskId)).toBe('completed');
    await s.api('PUT', '/settings/teams-bot', { ...cur, signInDays: 7 });
  });
});

describe('bot calls follow no redirects (F2)', () => {
  it('a redirect from a service host is an error, and the token goes nowhere else', async () => {
    const seen: string[] = [];
    const sink = http.createServer((req, res) => {
      seen.push(String(req.headers.authorization ?? ''));
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"x"}');
    });
    await new Promise<void>((r) => sink.listen(0, '127.0.0.1', r));
    const redirector = http.createServer((req, res) =>
      res.writeHead(307, { location: `http://127.0.0.1:${(sink.address() as AddressInfo).port}${req.url}` }).end(),
    );
    await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', r));
    // both hosts allowed by the outbound policy: only the no-redirect rule stops the token
    const settings = await s.api('GET', '/settings');
    await s.api('PUT', '/settings', {
      outboundPolicy: 'allowList',
      outboundAllowList: [
        ...(settings.outboundAllowList ?? []),
        `http://127.0.0.1:${(redirector.address() as AddressInfo).port}`,
        `http://127.0.0.1:${(sink.address() as AddressInfo).port}`,
      ],
    });
    const { sendActivity } = await import('../src/msteams/connector.js');
    await expect(sendActivity(`http://127.0.0.1:${(redirector.address() as AddressInfo).port}`, 'conv', { type: 'message', text: 'hi' })).rejects.toThrow(
      /redirect/i,
    );
    expect(seen).toEqual([]);
    sink.close();
    redirector.close();
  });
});

describe('cards (F4, F5, F8)', () => {
  it('a refresh checks the one task: an open step behind 600 newer tasks is still decidable', async () => {
    const taskId = await waitingTask(processId);
    const later = new Date(Date.now() + 60_000).toISOString();
    for (let i = 0; i < 600; i++) {
      dbm
        .db()
        .run(
          `INSERT INTO runs (id, process_id, process_name, process_version, definition_hash, status, trigger, actor, inputs, bindings, started_at) VALUES (?, ?, 'P', 1, 'h', 'succeeded', 'manual', 'admin', '{}', '{}', ?)`,
          `run_sec${i}`,
          processId,
          later,
        );
      dbm
        .db()
        .run(
          `INSERT INTO run_tasks (id, run_id, step_key, mode, title, columns, items, status, created_at) VALUES (?, ?, 'ok', 'approve', 't', '[]', '[]', 'completed', ?)`,
          `tsk_sec${i}`,
          `run_sec${i}`,
          later,
        );
    }
    const users = await import('../src/auth/users.js');
    const { teamsDecidable } = await import('../src/msteams/decide.js');
    expect(teamsDecidable(users.findUserByName('ria')!, 'task', taskId)).toEqual({ ok: true });
    const card = (await call(execute(RIA_OID, 'refresh', await dataOf('task', taskId)))).body.value;
    expect(card.actions.map((a: { verb?: string; type: string }) => a.verb ?? a.type)).toEqual(['approve', 'reject', 'Action.OpenUrl']);
  });

  it('a personal card shows the instructions; a channel card does not', async () => {
    const taskId = await waitingTask(processId);
    const personal = await call(execute(RIA_OID, 'refresh', await dataOf('task', taskId)));
    expect(JSON.stringify(personal.body)).toContain('Check ticket CHG-4711');
    const channel = await call({
      ...execute(RIA_OID, 'refresh', await dataOf('task', taskId)),
      conversation: { id: '19:ops@thread.tacv2', tenantId: TENANT, conversationType: 'channel' },
    });
    expect(JSON.stringify(channel.body)).not.toContain('CHG-4711');
    const { itemCard } = await import('../src/msteams/botcard.js');
    expect(JSON.stringify(itemCard('en', 'task', taskId, { viewer: null }))).not.toContain('CHG-4711');
  });

  it('a refresh by someone who may not see the item shows no facts; card data older than 30 days is refused', async () => {
    const taskId = await waitingTask(hiddenProcess);
    await s.api('PUT', `/processes/${hiddenProcess}/access`, { acl: [{ subject: 'role:admin', permissions: ['run'] }] });
    const r = await call(execute(RIA_OID, 'refresh', await dataOf('task', taskId)));
    expect(JSON.stringify(r.body)).toContain('This item is no longer available');
    expect(JSON.stringify(r.body)).not.toContain('Hidden approval');
    const own = await waitingTask(processId);
    const old = await call(execute(RIA_OID, 'refresh', await dataOf('task', own, Date.now() - 31 * 86_400_000)));
    expect(JSON.stringify(old.body)).toContain('This changed');
    expect(JSON.stringify(old.body)).not.toContain('Sec approval');
  });

  it('switching the bot on alone does not let it decide: the policy point teams.bot needs a second administrator', async () => {
    const { defaultAssurancePolicy, instanceRule, controlPoint } = await import('@sm/shared');
    expect(instanceRule(controlPoint('teams.bot')!, defaultAssurancePolicy()).teams).toBe(false);
    expect(instanceRule(controlPoint('mcp.write')!, defaultAssurancePolicy()).teams).toBe(false);
    expect(instanceRule(controlPoint('run.decide')!, defaultAssurancePolicy()).teams).toBe(true);
  });
});

describe('the Bot Framework metadata (F9)', () => {
  it('is not fetched again on every request while it fails', async () => {
    let hits = 0;
    const down = http.createServer((_req, res) => {
      hits++;
      res.writeHead(503).end();
    });
    await new Promise<void>((r) => down.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(down.address() as AddressInfo).port}`;
    const settings = await s.api('GET', '/settings');
    await s.api('PUT', '/settings', { outboundPolicy: 'allowList', outboundAllowList: [...(settings.outboundAllowList ?? []), url] });
    const { useMockFramework } = await import('../src/msteams/framework.js');
    const { resetKeyCache, verifyBotToken, keyFetchState } = await import('../src/msteams/bot-auth.js');
    useMockFramework({ ...mock.endpoints, openIdMetadata: `${url}/meta` });
    resetKeyCache();
    for (let i = 0; i < 5; i++) await verifyBotToken(`Bearer ${mock.sign({}, { kid: `k${i}` })}`, { serviceUrl: mock.url, channelId: 'msteams' }, APP_ID);
    expect(hits).toBe(1);
    expect(keyFetchState().backoffMs).toBeGreaterThanOrEqual(60_000);
    useMockFramework(mock.endpoints);
    resetKeyCache();
    down.close();
  });
});
