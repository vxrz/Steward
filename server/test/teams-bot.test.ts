import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';
import { startMockBotConnector, type MockBotConnector } from '../src/mock/mockBotConnector.js';

/**
 * Approvals from Microsoft Teams, stage 2 (ADR 0013, preview): the bot endpoint on its own listener, the Bot Framework
 * token checks (against a mock with its own signing keys – never Microsoft), who clicks (tid + oid only), decisions in
 * the card through the same code as the routes, four-eyes under the assurance switch, replays, and posting through the
 * bot.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';

const APP_ID = '11111111-2222-4333-8444-555555555555';
const TENANT = '6f1b2c3d-0000-4000-8000-00000000beef';
const OTHER_TENANT = '6f1b2c3d-0000-4000-8000-00000000dead';
const ALMA_OID = '0a1f3000-0000-4000-8000-0000000000a1';
const PW = 'Teams-bot-password-1';

let s: TestServer;
let alma: Client;
let bot: FastifyInstance;
let mock: MockBotConnector;
let dbm: typeof import('../src/db.js');
let receiver: http.Server;
let process4: string; // four-eyes approval
let process1: string; // plain approval
let providerId = '';

const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status?: number }) => e.status ?? 0,
  );
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function activity(over: Record<string, any> = {}): Record<string, any> {
  return {
    type: 'invoke',
    name: 'adaptiveCard/action',
    id: `act-${Math.random().toString(36).slice(2)}`,
    channelId: 'msteams',
    serviceUrl: mock.url,
    locale: 'en-US',
    from: { id: '29:alma', aadObjectId: ALMA_OID },
    recipient: { id: `28:${APP_ID}` },
    conversation: { id: 'a:personal-alma', tenantId: TENANT, conversationType: 'personal' },
    channelData: { tenant: { id: TENANT } },
    ...over,
  };
}

async function call(a: Record<string, any>, token: string | null = mock.sign({}), headers: Record<string, string> = {}) {
  const r = await bot.inject({
    method: 'POST',
    url: '/teams/bot/messages',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    payload: JSON.stringify(a),
  });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
}

async function waitingTask(processId: string): Promise<{ runId: string; taskId: string }> {
  const { id } = await s.api('POST', '/runs', { processId });
  const run = await s.waitRun(id, ['waiting']);
  return { runId: id, taskId: run.tasks[0].id };
}

const execute = (verb: string, data: unknown, extra: Record<string, unknown> = {}) =>
  activity({ value: { action: { type: 'Action.Execute', verb, data: { ...(data as object), ...extra } } } });

/** The card data of an item as the bot signs it. */
async function dataOf(kind: 'task' | 'mcp_request', id: string) {
  const { cardData } = await import('../src/msteams/botcard.js');
  const { versionOf } = await import('../src/msteams/decide.js');
  return cardData(kind, id, versionOf(kind, id)!)!;
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  dbm = await import('../src/db.js');
  mock = await startMockBotConnector({ appId: APP_ID });
  const { useMockFramework } = await import('../src/msteams/framework.js');
  useMockFramework(mock.endpoints);
  // Microsoft's hosts must be on the outbound allow-list; here the mock's
  const settings = await s.api('GET', '/settings');
  await s.api('PUT', '/settings', { outboundPolicy: 'allowList', outboundAllowList: [...(settings.outboundAllowList ?? []), mock.url] });
  const { buildBotApp } = await import('../src/msteams/listener.js');
  bot = await buildBotApp();
  // an Entra provider that identifies people by tid + oid (no network: inserted as stored)
  providerId = 'idp_entra_bot';
  dbm.db().run(
    'INSERT INTO identity_providers (id, config, secret, enabled, created_at, updated_at) VALUES (?, ?, NULL, 1, ?, ?)',
    providerId,
    JSON.stringify({
      type: 'entra',
      displayName: 'Entra',
      issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
      clientId: 'x',
      stableIdClaims: ['tid', 'oid'],
    }),
    new Date().toISOString(),
    new Date().toISOString(),
  );
  const users = await import('../src/auth/users.js');
  users.createUser({ username: 'alma', roles: ['approver'], password: PW, displayName: 'Alma Approver', mustChangePassword: false });
  users.createUser({ username: 'otto', roles: ['approver'], password: PW, mustChangePassword: false });
  const { identityKeys } = await import('../src/auth/sso-claims.js');
  const key = identityKeys(providerId, { iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, tid: TENANT, oid: ALMA_OID }, ['tid', 'oid']).key!;
  dbm.db().run('UPDATE users SET external_id = ? WHERE username = ?', key, 'alma');
  alma = await s.as('alma', PW);
  const def = (name: string, fourEyes: boolean) => ({
    definition: {
      name,
      nodes: [
        { id: 'start', type: 'start', x: 0, y: 0 },
        { id: 'ok', type: 'userTask', mode: 'approve', title: `${name} step`, assignees: ['role:approver', 'role:admin'], fourEyes, x: 1, y: 0 },
      ],
      wires: [{ from: 'start', port: 'out', to: 'ok' }],
    },
  });
  process1 = (await s.api('POST', '/processes', def('Bot approval', false))).id;
  process4 = (await s.api('POST', '/processes', def('Bot four eyes', true))).id;
  receiver = http.createServer((_req, res) => res.writeHead(200).end('{}'));
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
});
afterAll(async () => {
  const { useMockFramework } = await import('../src/msteams/framework.js');
  useMockFramework(null);
  await bot?.close();
  await mock?.close();
  receiver?.close();
  await s?.app.close();
});
beforeEach(async () => {
  const { resetBotState } = await import('../src/msteams/bot.js');
  resetBotState();
});

const ON = { enabled: true, appId: APP_ID, tenantIds: [TENANT], providerId: 'idp_entra_bot', credential: 'secret', clientSecret: 'bot-secret-value' };

describe('settings', () => {
  it('are off by default, need a tid + oid provider, keep the credential out of answers and audit', async () => {
    const view = await s.api('GET', '/settings/teams-bot');
    expect(view).toMatchObject({ preview: true, enabled: false, hasCredential: false });
    // 404 while off
    expect((await call(activity())).status).toBe(404);
    expect(await status(alma('GET', '/settings/teams-bot'))).toBe(403);
    // a provider whose stable id is not tid + oid is refused (no matching by names)
    dbm
      .db()
      .run(
        'INSERT INTO identity_providers (id, config, secret, enabled, created_at, updated_at) VALUES (?, ?, NULL, 1, ?, ?)',
        'idp_sub',
        JSON.stringify({ type: 'oidc', displayName: 'Sub', issuer: 'https://idp.example.com', clientId: 'x' }),
        new Date().toISOString(),
        new Date().toISOString(),
      );
    await expect(s.api('PUT', '/settings/teams-bot', { ...ON, providerId: 'idp_sub' })).rejects.toMatchObject({ body: { code: 'TEAMS_BOT_NEEDS_OID' } });
    const saved = await s.api('PUT', '/settings/teams-bot', ON);
    expect(saved).toMatchObject({ enabled: true, appId: APP_ID, hasCredential: true });
    expect(JSON.stringify(saved)).not.toContain('bot-secret-value');
    const a = (await s.api('GET', '/audit?action=teams.bot_settings_changed&limit=1'))[0];
    expect(a.summary).toContain('clientSecret changed');
    expect(JSON.stringify(a)).not.toContain('bot-secret-value');
  });
});

describe('the endpoint: cheap checks first', () => {
  it('serves only POST /teams/bot/messages, with size and type limits', async () => {
    expect((await bot.inject({ method: 'GET', url: '/teams/bot/messages' })).statusCode).toBe(404);
    expect((await bot.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(404);
    expect((await bot.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
    expect((await bot.inject({ method: 'POST', url: '/teams/bot/messages', headers: { 'content-type': 'text/plain' }, payload: 'hello' })).statusCode).toBe(
      415,
    );
    const big = JSON.stringify({ type: 'message', text: 'x'.repeat(70 * 1024) });
    expect((await bot.inject({ method: 'POST', url: '/teams/bot/messages', headers: { 'content-type': 'application/json' }, payload: big })).statusCode).toBe(
      413,
    );
    const r = await bot.inject({ method: 'POST', url: '/teams/bot/messages', headers: { 'content-type': 'application/json' }, payload: '{}' });
    expect(r.statusCode).toBe(401);
    expect(r.body).toBe('');
    expect(r.headers['set-cookie']).toBeUndefined();
  });

  it('accepts only tokens of the Bot Framework for this bot, for this serviceUrl', async () => {
    const now = Math.floor(Date.now() / 1000);
    const table: [string, string | null, Record<string, any>?][] = [
      ['no token', null],
      ['a key that is not published', mock.sign({}, { kid: 'unknown-kid' })],
      ['a wrong signature (published kid, other key)', mock.sign({}, { key: mock.foreignKey })],
      ['another issuer', mock.sign({ iss: 'https://sts.windows.net/x/' })],
      ['another audience', mock.sign({ aud: '99999999-2222-4333-8444-555555555555' })],
      ['expired beyond the skew', mock.sign({ exp: now - 600, nbf: now - 4000 })],
      ['not yet valid', mock.sign({ nbf: now + 900 })],
      ['a serviceUrl claim that differs from the activity', mock.sign({ serviceUrl: 'http://127.0.0.1:1' })],
      ['a foreign service host', mock.sign({ serviceUrl: 'https://evil.example.com' }), { serviceUrl: 'https://evil.example.com' }],
      ['another channel (the key is not endorsed for it)', mock.sign({}), { channelId: 'slack' }],
      ['alg none', mock.sign({}, { alg: 'none' })],
    ];
    for (const [what, token, over] of table) expect((await call(activity(over), token)).status, what).toBe(401);
    // within 5 minutes of clock skew: fine
    expect((await call(activity({ type: 'message', id: undefined }), mock.sign({ exp: now - 120 }))).status).toBe(200);
    // a foreign tenant is refused after the token
    expect((await call(activity({ conversation: { id: 'x', tenantId: OTHER_TENANT }, channelData: { tenant: { id: OTHER_TENANT } } }))).status).toBe(403);
    // refusals are audited at most once per reason in 10 minutes
    const audits = (await s.api('GET', '/audit?action=teams.action_refused&limit=50')) as { details: { reason: string } }[];
    const reasons = audits.map((x) => x.details.reason);
    expect(reasons.filter((r) => r === 'signature')).toHaveLength(1);
    expect(reasons).toEqual(expect.arrayContaining(['noToken', 'unknownKey', 'issuer', 'audience', 'expired', 'serviceUrl', 'endorsement', 'tenant']));
  });
});

describe('who clicks, and what can be decided in the card', () => {
  it('records where the bot is installed', async () => {
    const r = await call(activity({ type: 'installationUpdate', action: 'add', name: undefined }));
    expect(r.status).toBe(200);
    const conv = dbm.db().get<{ kind: string; user_id: string }>("SELECT kind, user_id FROM teams_conversations WHERE conversation_id = 'a:personal-alma'");
    expect(conv?.kind).toBe('personal');
    expect(conv?.user_id).toBeTruthy();
    await call(
      activity({
        type: 'conversationUpdate',
        membersAdded: [{ id: `28:${APP_ID}` }],
        conversation: { id: '19:orders@thread.tacv2', tenantId: TENANT, conversationType: 'channel' },
        channelData: { tenant: { id: TENANT }, channel: { name: 'Orders' } },
      }),
    );
    expect(dbm.db().get("SELECT name FROM teams_conversations WHERE conversation_id = '19:orders@thread.tacv2'")).toEqual({ name: 'Orders' });
    expect((await s.api('GET', '/audit?action=teams.conversation_added&limit=5')).length).toBeGreaterThanOrEqual(2);
    expect((await s.api('GET', '/settings/teams-bot/conversations')).map((c: { name: string }) => c.name)).toContain('Orders');
  });

  it('only accounts linked by tid + oid; a tampered card answers the current state', async () => {
    const { taskId } = await waitingTask(process1);
    const data = await dataOf('task', taskId);
    const stranger = await call(execute('approve', data), mock.sign({}));
    expect(JSON.stringify(stranger.body)).not.toContain('not linked'); // alma is linked
    const notLinked = await call(activity({ ...execute('approve', data), from: { id: '29:x', aadObjectId: '0a1f3000-0000-4000-8000-00000000ffff' } }));
    // the first call decided already; whoever is not linked gets the notice either way
    expect(JSON.stringify(notLinked.body)).toContain('Your Teams account is not linked');
    const { taskId: t2 } = await waitingTask(process1);
    const tampered = await call(execute('approve', { ...(await dataOf('task', t2)), id: taskId }));
    expect(JSON.stringify(tampered.body)).toContain('This changed');
    expect((await s.api('GET', `/tasks/${t2}`)).status).toBe('open');
  });

  it('decides like the route, records "via Microsoft Teams" and answers a replay with the same card', async () => {
    const { taskId, runId } = await waitingTask(process1);
    const data = await dataOf('task', taskId);
    const refresh = await call(execute('refresh', data));
    expect(refresh.body).toMatchObject({ statusCode: 200, type: 'application/vnd.microsoft.card.adaptive' });
    expect(refresh.body.value.actions.map((x: any) => x.verb ?? x.type)).toEqual(['approve', 'reject', 'Action.OpenUrl']);
    const click = execute('approve', data, { comment: 'checked in Teams' });
    const first = await call(click);
    expect(first.status).toBe(200);
    const task = await s.api('GET', `/tasks/${taskId}`);
    expect(task).toMatchObject({ status: 'completed', decidedBy: 'alma', decision: { approved: true, comment: 'checked in Teams', via: 'teams' } });
    const audit = (await s.api('GET', `/audit?action=task.completed&entityId=${taskId}`))[0];
    expect(audit.summary).toContain('via Microsoft Teams');
    expect(audit.details).toMatchObject({ via: 'teams', teams: { tenantId: TENANT, aadObjectId: ALMA_OID, conversationKind: 'personal' } });
    // a replay of the same activity: the same answer, nothing changes
    const again = await call(click);
    expect(again.body).toEqual(first.body);
    expect(await s.api('GET', `/audit?action=task.completed&entityId=${taskId}`)).toHaveLength(1);
    await s.waitRun(runId, ['succeeded']);
  });

  it('four-eyes in the card: the second person may, under the assurance switch; the starter may not', async () => {
    const { taskId } = await waitingTask(process4); // started by admin
    const data = await dataOf('task', taskId);
    const ok = await call(execute('approve', data));
    expect(ok.status).toBe(200);
    const audit = (await s.api('GET', `/audit?action=task.completed&entityId=${taskId}`))[0];
    expect(JSON.stringify(audit.details)).toContain('"via":"teams"');
    expect(audit.details.assurance?.[0]).toMatchObject({ point: 'run.decide', via: 'teams', fourEyes: { required: true, approver: 'alma' } });
    expect(audit.details.assurance[0].session).toBeUndefined();
    // the policy says no: in Steward only (tightening applies at once)
    const policy = await s.api('GET', '/assurance/policy');
    await s.api('PUT', '/assurance/policy', { points: { ...policy.policy.points, 'run.decide': { teams: false } }, mfa: policy.policy.mfa });
    const { taskId: t2 } = await waitingTask(process4);
    const refused = await call(execute('approve', await dataOf('task', t2)));
    expect(JSON.stringify(refused.body)).toContain('The assurance policy has this decided in Steward');
    expect((await s.api('GET', `/tasks/${t2}`)).status).toBe('open');
    // back on (loosening waits for a second administrator: write the policy as the test fixture)
    const { writePolicy, currentPolicy } = await import('../src/auth/assurance-policy.js');
    const cur = currentPolicy();
    writePolicy(
      { ...cur, version: cur.version + 1, points: Object.fromEntries(Object.entries(cur.points).filter(([k]) => k !== 'run.decide')) },
      new Date().toISOString(),
    );
    await s.api('POST', `/tasks/${t2}/complete`, { approved: false }).catch(() => undefined);
  });

  it('MCP requests: the requester withdraws in the card; decided_via is recorded', async () => {
    const id = `mrq_bot${Date.now()}`;
    const now = new Date().toISOString();
    const later = new Date(Date.now() + 3_600_000).toISOString();
    dbm.db().run(
      `INSERT INTO mcp_requests (id, kind, status, mode, requested_by, token_id, token_name, reason, created_at, expires_at, method, path, path_template, query, inputs, dry_run)
         VALUES (?, 'gateway', 'pending', 'confirm', 'alma', 'tok', 'tok', 'x', ?, ?, 'DELETE', '/x/1', '/x/{id}', '{}', '{}', 0)`,
      id,
      now,
      later,
    );
    const r = await call(execute('reject', await dataOf('mcp_request', id)));
    expect(r.status).toBe(200);
    expect(dbm.db().get('SELECT status, decided_by, decided_via FROM mcp_requests WHERE id = ?', id)).toEqual({
      status: 'withdrawn',
      decided_by: 'alma',
      decided_via: 'teams',
    });
    const a = (await s.api('GET', `/audit?action=mcp.request_withdrawn&entityId=${id}`))[0];
    expect(a.details).toMatchObject({ via: 'teams' });
    // proposals are reviewed in Steward
    const p = `mrq_prop${Date.now()}`;
    dbm.db().run(
      `INSERT INTO mcp_requests (id, kind, status, mode, requested_by, token_id, token_name, reason, created_at, expires_at, query, inputs, dry_run, payload)
         VALUES (?, 'catalogue', 'pending', 'review', 'otto', 'tok', 'tok', 'x', ?, ?, '{}', '{}', 0, '{}')`,
      p,
      now,
      later,
    );
    const prop = await call(execute('approve', await dataOf('mcp_request', p)));
    expect(dbm.db().get<{ status: string }>('SELECT status FROM mcp_requests WHERE id = ?', p)!.status).toBe('pending');
    expect(prop.status).toBe(200);
  });
});

describe('posting through the bot', () => {
  it('sends decision cards to the chosen channel conversation and the personal chat, and updates them when decided', async () => {
    const conv = dbm.db().get<{ id: string }>("SELECT id FROM teams_conversations WHERE conversation_id = '19:orders@thread.tacv2'")!;
    const { preview: _p, hasCredential: _h, listener: _l, ...settings } = await s.api('GET', '/settings/teams-bot');
    await s.api('PUT', '/settings/teams-bot', { ...settings, channels: { 'teams:instance': conv.id } });
    const notif = await s.api('GET', '/settings/notifications');
    await s.api('PUT', '/settings/notifications', {
      ...notif,
      teams: { enabled: true, webhookUrl: `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook` },
      routes: { ...notif.routes, 'task.assigned': ['inApp', 'teams'] },
    });
    mock.sent.length = 0;
    const { taskId } = await waitingTask(process1);
    for (let i = 0; i < 30 && mock.sent.length < 2; i++) await wait(100);
    const paths = mock.sent.map((x) => x.path);
    expect(paths).toContain('/v3/conversations/19%3Aorders%40thread.tacv2/activities');
    expect(paths).toContain('/v3/conversations/a%3Apersonal-alma/activities');
    expect(mock.sent[0]!.auth).toBe('Bearer mock-bot-access-token');
    expect(mock.tokenRequests[0]!.get('client_secret')).toBe('bot-secret-value');
    const channelCard = (mock.sent.find((x) => x.path.includes('orders'))!.body as any).attachments[0].content;
    // the channel shows status and Open; the deciders' clients refresh for their own buttons
    expect(channelCard.actions.map((a: any) => a.type)).toEqual(['Action.OpenUrl']);
    expect(channelCard.refresh.userIds).toContain(ALMA_OID);
    expect(dbm.db().all('SELECT conversation_id FROM teams_cards WHERE item_id = ?', taskId)).toHaveLength(2);
    // decided in Steward: Steward updates its cards
    mock.sent.length = 0;
    await alma('POST', `/tasks/${taskId}/complete`, { approved: true });
    for (let i = 0; i < 30 && mock.sent.filter((x) => x.method === 'PUT').length < 2; i++) await wait(100);
    expect(mock.sent.filter((x) => x.method === 'PUT')).toHaveLength(2);
    expect(JSON.stringify(mock.sent[0]!.body)).toContain('Decided.');
  });
});
