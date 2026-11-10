import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationPrefs, UserInfo } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';
import { startMockBotConnector, type MockBotConnector } from '../src/mock/mockBotConnector.js';

/**
 * Personal Teams notifications (0.15.0, ADR 0025): the chat with the bot as a personal channel. The conversation
 * reference (installation, first message, removal, deactivation, a blocked bot, pseudonymisation, the data export), the
 * person's choice per event (off by default, audited, hidden while the bot is off), delivery instead of e-mail with the
 * person's text, quiet hours and digests, only to recipients, and the fallback to e-mail once after repeated throttling.
 * Against the mock Bot Connector – never Microsoft.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';

const mails = vi.hoisted(() => [] as { to: string; subject: string; text: string }[]);
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: async (m: { to: string; subject: string; text: string }) => {
        mails.push(m);
      },
      close: () => undefined,
    }),
  },
}));

const APP_ID = '21111111-2222-4333-8444-555555555555';
const TENANT = '7f1b2c3d-0000-4000-8000-00000000beef';
const TILDA_OID = '1a1f3000-0000-4000-8000-0000000000a1';
const UGO_OID = '1a1f3000-0000-4000-8000-0000000000b2';
const PW = 'Teams-personal-pw-1';
const PROVIDER = 'idp_entra_personal';
const ON = { enabled: true, appId: APP_ID, tenantIds: [TENANT], providerId: PROVIDER, credential: 'secret', clientSecret: 'bot-secret-personal' };
const ALWAYS: NotificationPrefs['quietHours'] = {
  enabled: true,
  timeZone: 'Europe/Berlin',
  windows: [],
  allDay: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
  urgentBreaksThrough: true,
};

let s: TestServer;
let tilda: Client;
let ugo: Client;
let admin2: Client;
let bot: FastifyInstance;
let mock: MockBotConnector;
let dbm: typeof import('../src/db.js');
let svc: typeof import('../src/notifications/service.js');
let users: typeof import('../src/auth/users.js');
let outbox: typeof import('../src/notifications/outbox.js');
let personal: typeof import('../src/msteams/personal.js');

const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status?: number }) => e.status ?? 0,
  );
const user = (name: string): UserInfo => users.findUserByName(name)!;
const chatPosts = (conv: string) => mock.sent.filter((x) => x.method === 'POST' && x.path === `/v3/conversations/${encodeURIComponent(conv)}/activities`);
const cardText = (body: unknown) => JSON.stringify(body);

function activity(over: Record<string, any> = {}): Record<string, any> {
  return {
    type: 'installationUpdate',
    action: 'add',
    id: `act-${Math.random().toString(36).slice(2)}`,
    channelId: 'msteams',
    serviceUrl: mock.url,
    locale: 'en-US',
    from: { id: '29:tilda', aadObjectId: TILDA_OID },
    recipient: { id: `28:${APP_ID}` },
    conversation: { id: 'a:personal-tilda', tenantId: TENANT, conversationType: 'personal' },
    channelData: { tenant: { id: TENANT } },
    ...over,
  };
}
const ugoActivity = (over: Record<string, any> = {}) =>
  activity({ from: { id: '29:ugo', aadObjectId: UGO_OID }, conversation: { id: 'a:personal-ugo', tenantId: TENANT, conversationType: 'personal' }, ...over });

async function call(a: Record<string, any>) {
  const r = await bot.inject({
    method: 'POST',
    url: '/teams/bot/messages',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${mock.sign({})}` },
    payload: JSON.stringify(a),
  });
  return r.statusCode;
}

function notice(over: Partial<Parameters<typeof svc.notify>[0]> & { recipients: UserInfo[] }): Parameters<typeof svc.notify>[0] {
  return {
    event: 'credential.due',
    personal: true,
    text: (_l, u) => ({ title: `Credential “Orders key” is due${u ? ` (for ${u.username})` : ''}`, body: 'Rotate it before Friday.' }),
    link: '/credentials',
    inAppKey: `k-${Math.random()}`,
    externalKey: `cred:orders:${Math.random()}`,
    ...over,
  };
}
const send = async (n: Parameters<typeof svc.notify>[0]) => {
  svc.notify(n);
  await svc.flushNotifications();
};

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  dbm = await import('../src/db.js');
  svc = await import('../src/notifications/service.js');
  users = await import('../src/auth/users.js');
  outbox = await import('../src/notifications/outbox.js');
  personal = await import('../src/msteams/personal.js');
  personal.setNoticeRetryDelays([5, 5, 5]);
  mock = await startMockBotConnector({ appId: APP_ID });
  const { useMockFramework } = await import('../src/msteams/framework.js');
  useMockFramework(mock.endpoints);
  const settings = await s.api('GET', '/settings');
  await s.api('PUT', '/settings', { outboundPolicy: 'allowList', outboundAllowList: [...(settings.outboundAllowList ?? []), mock.url] });
  const { buildBotApp } = await import('../src/msteams/listener.js');
  bot = await buildBotApp();
  const issuer = `https://login.microsoftonline.com/${TENANT}/v2.0`;
  dbm
    .db()
    .run(
      'INSERT INTO identity_providers (id, config, secret, enabled, created_at, updated_at) VALUES (?, ?, NULL, 1, ?, ?)',
      PROVIDER,
      JSON.stringify({ type: 'entra', displayName: 'Entra', issuer, clientId: 'x', stableIdClaims: ['tid', 'oid'] }),
      new Date().toISOString(),
      new Date().toISOString(),
    );
  const { identityKeys } = await import('../src/auth/sso-claims.js');
  for (const [name, oid] of [
    ['tilda', TILDA_OID],
    ['ugo', UGO_OID],
  ] as const) {
    users.createUser({ username: name, roles: ['operator'], password: PW, email: `${name}@example.com`, mustChangePassword: false });
    dbm.db().run('UPDATE users SET external_id = ? WHERE username = ?', identityKeys(PROVIDER, { iss: issuer, tid: TENANT, oid }, ['tid', 'oid']).key!, name);
  }
  tilda = await s.as('tilda', PW);
  ugo = await s.as('ugo', PW);
  const { temporaryPassword } = await s.api('POST', '/users', { username: 'admin2', roles: ['admin'] });
  const first = await s.as('admin2', temporaryPassword);
  await first('POST', '/auth/password', { current: temporaryPassword, next: 'Admin2-password-1' });
  admin2 = await s.as('admin2', 'Admin2-password-1');
  const notif = await s.api('GET', '/settings/notifications');
  await s.api('PUT', '/settings/notifications', {
    ...notif,
    email: { enabled: true, host: 'smtp.example.com', port: 587, secure: false, from: 'steward@example.com' },
    allowedEmailDomains: ['example.com'],
    routes: { ...notif.routes, 'credential.due': ['inApp', 'email'], 'dataset.stale': ['inApp'] },
    baseUrl: 'https://sm.example.com/',
  });
});
afterAll(async () => {
  const { useMockFramework } = await import('../src/msteams/framework.js');
  useMockFramework(null);
  personal?.setNoticeRetryDelays([1000, 2000, 4000]);
  await bot?.close();
  await mock?.close();
  await s?.app.close();
});
beforeEach(async () => {
  mails.length = 0;
  mock.sent.length = 0;
  mock.refused.length = 0;
  mock.refuseNext(0);
  dbm.db().run('DELETE FROM notification_outbox');
  dbm.db().run('DELETE FROM notification_digest_sends');
  dbm.db().run('DELETE FROM notification_sends');
  const { resetBotState } = await import('../src/msteams/bot.js');
  resetBotState();
});

describe('while the bot is off', () => {
  it('the channel is not available: nothing to choose, nothing sent, a choice is refused', async () => {
    expect(await tilda('GET', '/me/teams-personal')).toMatchObject({ available: false, connected: false, events: [] });
    await expect(tilda('PUT', '/me/teams-personal', { events: ['credential.due'] })).rejects.toMatchObject({
      status: 409,
      body: { code: 'TEAMS_PERSONAL_OFF' },
    });
  });

  it('turning the bot on (a second administrator approves)', async () => {
    await s.api('PUT', '/settings/teams-bot', ON);
    const pending = (await s.api('GET', '/assurance/policy')).pending;
    await admin2('POST', `/assurance/policy/changes/${pending.id}/approve`, {});
    expect(await s.api('GET', '/settings/teams-bot')).toMatchObject({ enabled: true, approved: true });
    expect(await tilda('GET', '/me/teams-personal')).toMatchObject({ available: true, connected: false, notLinked: false });
  });
});

describe('the conversation reference', () => {
  it('is recorded on installation, tenant-bound with the Entra object id, and removed on uninstall', async () => {
    expect(await call(activity())).toBe(200);
    const row = dbm
      .db()
      .get<{ user_id: string; aad_object_id: string; tenant_id: string }>(
        "SELECT user_id, aad_object_id, tenant_id FROM teams_conversations WHERE conversation_id = 'a:personal-tilda'",
      );
    expect(row).toEqual({ user_id: user('tilda').id, aad_object_id: TILDA_OID, tenant_id: TENANT });
    expect(await tilda('GET', '/me/teams-personal')).toMatchObject({ connected: true });
    expect(await call(activity({ action: 'remove' }))).toBe(200);
    expect(await tilda('GET', '/me/teams-personal')).toMatchObject({ connected: false });
    expect((await s.api('GET', '/audit?action=teams.conversation_removed&limit=1'))[0].details).toMatchObject({ kind: 'personal' });
  });

  it('is recorded again on the first message of the person (audited), once', async () => {
    expect(await call(activity({ type: 'message', text: 'hello', action: undefined }))).toBe(200);
    expect(await tilda('GET', '/me/teams-personal')).toMatchObject({ connected: true });
    const added = await s.api('GET', '/audit?action=teams.conversation_added&limit=5');
    expect(added[0].details).toMatchObject({ kind: 'personal', user: 'tilda', via: 'message' });
    const n = added.length;
    await call(activity({ type: 'message', text: 'again', action: undefined }));
    expect(await s.api('GET', '/audit?action=teams.conversation_added&limit=5')).toHaveLength(n);
    // a message from someone not linked records nothing
    await call(activity({ type: 'message', text: 'x', action: undefined, from: { id: '29:x', aadObjectId: '1a1f3000-0000-4000-8000-00000000ffff' } }));
    expect(dbm.db().get<{ n: number }>("SELECT COUNT(*) AS n FROM teams_conversations WHERE kind = 'personal' AND user_id IS NULL")!.n).toBe(0);
  });

  it('is used only while the person is linked to the object id it was recorded for and the tenant is allowed', async () => {
    const u = user('tilda');
    expect(personal.personalChat(u)).toBeTruthy();
    dbm.db().run("UPDATE teams_conversations SET aad_object_id = '1a1f3000-0000-4000-8000-0000000000ee' WHERE conversation_id = 'a:personal-tilda'");
    expect(personal.personalChat(u)).toBeUndefined();
    dbm.db().run('UPDATE teams_conversations SET aad_object_id = ? WHERE conversation_id = ?', TILDA_OID, 'a:personal-tilda');
    await s.api('PUT', '/settings/teams-bot', { ...ON, tenantIds: ['7f1b2c3d-0000-4000-8000-0000000000aa'], clientSecret: undefined });
    expect(personal.personalChat(u)).toBeUndefined();
    await s.api('PUT', '/settings/teams-bot', { ...ON, clientSecret: undefined });
    expect(personal.personalChat(u)).toBeTruthy();
  });
});

describe('the choice per event', () => {
  it('is off by default, offers only events routed to e-mail and no decision cards, and is audited', async () => {
    const st = await tilda('GET', '/me/teams-personal');
    expect(st.events).toEqual([]);
    expect(st.offered).toContain('credential.due');
    for (const e of ['task.assigned', 'mcp.request', 'summary.daily', 'dataset.stale']) expect(st.offered).not.toContain(e);
    expect(await status(tilda('PUT', '/me/teams-personal', { events: ['task.assigned'] }))).toBe(400);
    expect(await status(tilda('PUT', '/me/teams-personal', { events: ['no.such'] }))).toBe(400);
    const saved = await tilda('PUT', '/me/teams-personal', { events: ['credential.due', 'run.failed'] });
    expect(saved.events).toEqual(['run.failed', 'credential.due']);
    const a = (await s.api('GET', '/audit?action=notification.personal_channel_changed&limit=1'))[0];
    expect(a).toMatchObject({
      actor: 'tilda',
      entityId: user('tilda').id,
      details: { channel: 'teamsPersonal', from: [], to: ['run.failed', 'credential.due'] },
    });
    // the same again changes nothing
    await tilda('PUT', '/me/teams-personal', { events: ['credential.due', 'run.failed'] });
    expect(await s.api('GET', '/audit?action=notification.personal_channel_changed&limit=5')).toHaveLength(1);
  });
});

describe('delivery', () => {
  it('goes to the chat instead of e-mail, with the person’s own text and links only, to recipients only', async () => {
    await call(ugoActivity());
    await send(notice({ recipients: [user('tilda'), user('ugo')] }));
    const posts = chatPosts('a:personal-tilda');
    expect(posts).toHaveLength(1);
    const body = cardText(posts[0]!.body);
    expect(body).toContain('Credential “Orders key” is due (for tilda)');
    expect(body).toContain('https://sm.example.com/credentials');
    expect(body).not.toContain('Action.Execute');
    expect(posts[0]!.auth).toBe('Bearer mock-bot-access-token');
    // tilda: no e-mail for the chosen event; ugo (has a chat, chose nothing): his e-mail, no chat message
    expect(mails.map((m) => m.to)).toEqual(['ugo@example.com']);
    expect(chatPosts('a:personal-ugo')).toHaveLength(0);
    // a notice that is not for tilda never reaches her chat
    mock.sent.length = 0;
    await send(notice({ recipients: [user('ugo')] }));
    expect(chatPosts('a:personal-tilda')).toHaveLength(0);
  });

  it('follows the route: an event not routed to e-mail, or a decision, does not take this path', async () => {
    await send(
      notice({ event: 'credential.due', recipients: [user('tilda')], source: { kind: 'schedule', id: 'x', policy: { channels: ['inApp'] } } as never }),
    );
    expect(chatPosts('a:personal-tilda')).toHaveLength(0);
    await send(notice({ event: 'run.failed', recipients: [user('tilda')], decision: { kind: 'task', id: 'tsk_none' } }));
    expect(mock.sent.filter((x) => cardText(x.body).includes('Orders key'))).toHaveLength(0);
  });

  it('holds it during quiet hours and releases one catch-up card in the chat', async () => {
    await tilda('PUT', '/me/notification-prefs', { quietHours: ALWAYS, digests: { timeZone: 'UTC', groups: {} } });
    await send(notice({ recipients: [user('tilda')] }));
    expect(chatPosts('a:personal-tilda')).toHaveLength(0);
    expect(mails).toHaveLength(0);
    const held = dbm.db().all<{ target: string; reason: string }>('SELECT target, reason FROM notification_outbox WHERE released_at IS NULL');
    expect(held).toEqual([{ target: `teamsChat:${user('tilda').id}`, reason: 'quiet' }]);
    await tilda('DELETE', '/me/notification-prefs');
    expect(await outbox.runOutbox()).toBe(1);
    const posts = chatPosts('a:personal-tilda');
    expect(posts).toHaveLength(1);
    expect(cardText(posts[0]!.body)).toContain('While you were away');
    expect(cardText(posts[0]!.body)).toContain('Orders key');
    expect(mails).toHaveLength(0);
  });

  it('follows the person’s digest and leaves out at release what they may no longer see', async () => {
    await tilda('PUT', '/me/notification-prefs', {
      quietHours: { ...ALWAYS, enabled: false },
      digests: { timeZone: 'UTC', groups: { reminders: { rhythm: 'hourly' } } },
    });
    await send(notice({ recipients: [user('tilda')] }));
    expect(dbm.db().all<{ reason: string }>('SELECT reason FROM notification_outbox WHERE released_at IS NULL')).toEqual([{ reason: 'hourly' }]);
    expect(await outbox.runOutbox(Date.now() + 2 * 3_600_000)).toBe(1);
    expect(cardText(chatPosts('a:personal-tilda')[0]!.body)).toContain('Orders key');
    // a held item about a credential she cannot see is left out
    mock.sent.length = 0;
    dbm.db().run('DELETE FROM notification_digest_sends');
    await send(notice({ recipients: [user('tilda')], about: { kind: 'credential', id: 'cred_does_not_exist' } }));
    await outbox.runOutbox(Date.now() + 4 * 3_600_000);
    expect(mock.sent.filter((x) => cardText(x.body).includes('Orders key'))).toHaveLength(0);
    await tilda('DELETE', '/me/notification-prefs');
  });

  it('retries when throttled and then falls back to e-mail once', async () => {
    mock.refuseNext(2, 429, 0);
    await send(notice({ recipients: [user('tilda')] }));
    expect(mock.refused).toHaveLength(2);
    expect(chatPosts('a:personal-tilda')).toHaveLength(1);
    expect(mails).toHaveLength(0);
    // throttled beyond the retries: the same message by e-mail, once
    mock.refused.length = 0;
    mock.sent.length = 0;
    mock.refuseNext(4, 429);
    const n = notice({ recipients: [user('tilda')], externalKey: 'cred:throttled' });
    await send(n);
    expect(mock.refused).toHaveLength(4);
    expect(chatPosts('a:personal-tilda')).toHaveLength(0);
    expect(mails.map((m) => m.to)).toEqual(['tilda@example.com']);
    expect(mails[0]!.subject).toContain('Orders key');
    // the same notice again within the hour: nothing more
    mock.refuseNext(4, 429);
    await send({ ...n, inAppKey: 'again' });
    expect(mails).toHaveLength(1);
    mock.refuseNext(0);
  });

  it('a blocked bot (403) retires the chat (audited) and the message goes by e-mail', async () => {
    mock.refuseNext(1, 403);
    await send(notice({ recipients: [user('tilda')] }));
    expect(mock.refused).toHaveLength(1);
    expect(mails.map((m) => m.to)).toEqual(['tilda@example.com']);
    expect(await tilda('GET', '/me/teams-personal')).toMatchObject({ connected: false, events: ['run.failed', 'credential.due'] });
    expect((await s.api('GET', '/audit?action=teams.conversation_removed&limit=1'))[0].details).toMatchObject({ reason: 'unreachable', status: 403 });
    // without a chat, the chosen event goes by e-mail as before
    mails.length = 0;
    await send(notice({ recipients: [user('tilda')] }));
    expect(mails.map((m) => m.to)).toEqual(['tilda@example.com']);
    // writing to the bot records the chat again
    await call(activity({ type: 'message', text: 'back', action: undefined }));
    expect(await tilda('GET', '/me/teams-personal')).toMatchObject({ connected: true });
  });

  it('nothing goes to the chat while the bot is off; the choice is kept', async () => {
    await s.api('PUT', '/settings/teams-bot', { ...ON, enabled: false, clientSecret: undefined });
    expect(await tilda('GET', '/me/teams-personal')).toMatchObject({ available: false, events: ['run.failed', 'credential.due'] });
    await send(notice({ recipients: [user('tilda')] }));
    expect(chatPosts('a:personal-tilda')).toHaveLength(0);
    expect(mails.map((m) => m.to)).toEqual(['tilda@example.com']);
    await s.api('PUT', '/settings/teams-bot', { ...ON, clientSecret: undefined });
    expect(await tilda('GET', '/me/teams-personal')).toMatchObject({ available: true, connected: true });
  });
});

describe('the account', () => {
  it('export lists the chats and the choice', async () => {
    const data = await tilda('GET', '/me/data-export');
    expect(data.settings.personalChannels).toMatchObject({ teams: ['run.failed', 'credential.due'] });
    expect(data.teamsChats.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(data.teamsChats)).not.toContain('a:personal-tilda');
  });

  it('deactivation retires the chat (audited); pseudonymisation deletes chat and choice', async () => {
    await ugo('PUT', '/me/teams-personal', { events: ['credential.due'] });
    const id = user('ugo').id;
    await s.api('PUT', `/users/${id}`, { active: false });
    expect(
      dbm.db().get<{ n: number }>("SELECT COUNT(*) AS n FROM teams_conversations WHERE user_id = ? AND removed_at IS NULL AND kind = 'personal'", id)!.n,
    ).toBe(0);
    expect((await s.api('GET', '/audit?action=teams.conversation_removed&limit=1'))[0].details).toMatchObject({ user: 'ugo', reason: 'deactivated' });
    await send(notice({ recipients: [user('ugo')] }));
    expect(chatPosts('a:personal-ugo')).toHaveLength(0);
    const { pseudonymiseUser } = await import('../src/auth/personal-data.js');
    const r = pseudonymiseUser(id, { actor: 'admin' });
    expect(r.pseudonymisedAt).toBeTruthy();
    expect(dbm.db().get<{ n: number }>('SELECT COUNT(*) AS n FROM teams_conversations WHERE user_id = ?', id)!.n).toBe(0);
    expect(dbm.db().get<{ n: number }>('SELECT COUNT(*) AS n FROM notification_personal_channels WHERE user_id = ?', id)!.n).toBe(0);
    const audit = (await s.api('GET', '/audit?action=user.pseudonymised&limit=1'))[0];
    expect(audit.details.removed).toMatchObject({ teamsChats: 1, personalChannels: 1 });
  });
});
