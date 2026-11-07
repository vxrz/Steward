import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_NOTIFICATION_PREFS, type NotificationPrefs, type UserInfo } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Quiet hours and digests (ADR 0012): settings, holding instead of sending, the catch-up at the end, digests,
 * break-throughs, the instance Teams channel, rights at release and the daily summary's "While you were away".
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';

const mails = vi.hoisted(() => [] as { to: string; subject: string; text: string; html: string }[]);
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: async (m: { to: string; subject: string; text: string; html: string }) => {
        mails.push(m);
      },
      close: () => undefined,
    }),
  },
}));

const PW = 'Quiet-password-123';
const HOUR = 3_600_000;
let s: TestServer;
let qara: Client;
let receiver: http.Server;
let receiverUrl = '';
const received: { path: string; body: any }[] = [];

let svc: typeof import('../src/notifications/service.js');
let outbox: typeof import('../src/notifications/outbox.js');
let users: typeof import('../src/auth/users.js');
let dbm: typeof import('../src/db.js');
let summary: typeof import('../src/notifications/summary.js');

const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status?: number }) => e.status ?? 0,
  );
const user = (name: string): UserInfo => users.findUserByName(name)!;
const ALWAYS: NotificationPrefs['quietHours'] = {
  enabled: true,
  timeZone: 'Europe/Berlin',
  windows: [],
  allDay: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
  urgentBreaksThrough: true,
};
const prefs = (p: Partial<NotificationPrefs> = {}): NotificationPrefs => ({ ...DEFAULT_NOTIFICATION_PREFS, ...p });
const held = (target: string) =>
  dbm
    .db()
    .all<{ item_key: string; reason: string; states: string; event: string }>(
      'SELECT item_key, reason, states, event FROM notification_outbox WHERE target = ? AND released_at IS NULL ORDER BY first_at, item_key',
      target,
    );
const flush = async () => {
  await svc.flushNotifications();
};
const mailsTo = (addr: string) => mails.filter((m) => m.to === addr);

function notice(over: Partial<Parameters<typeof svc.notify>[0]> & { recipients: UserInfo[] }): Parameters<typeof svc.notify>[0] {
  return {
    event: 'credential.due',
    text: () => ({ title: 'Credential “Orders key” is due', body: 'Rotate it.' }),
    link: '/credentials',
    inAppKey: `k-${Math.random()}`,
    externalKey: 'cred:orders',
    ...over,
  };
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  svc = await import('../src/notifications/service.js');
  outbox = await import('../src/notifications/outbox.js');
  users = await import('../src/auth/users.js');
  dbm = await import('../src/db.js');
  summary = await import('../src/notifications/summary.js');
  for (const [name, email] of [
    ['qara', 'qara@example.com'],
    ['quinn', 'quinn@example.com'],
    ['rhea', 'rhea@example.com'],
  ] as const)
    users.createUser({ username: name, roles: ['approver'], password: PW, email, mustChangePassword: false });
  qara = await s.as('qara', PW);
  receiver = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      received.push({ path: req.url ?? '', body: JSON.parse(data || 'null') });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  const notif = await s.api('GET', '/settings/notifications');
  await s.api('PUT', '/settings/notifications', {
    ...notif,
    email: { enabled: true, host: 'smtp.example.com', port: 587, secure: false, from: 'steward@example.com' },
    teams: { enabled: true, webhookUrl: `${receiverUrl}/instance` },
    webhook: { enabled: false },
    allowedEmailDomains: ['example.com'],
    routes: { ...notif.routes, 'credential.due': ['inApp', 'email', 'teams'], 'run.failed': ['inApp', 'email'], 'mcp.request': ['inApp', 'email'] },
    baseUrl: 'https://sm.example.com/',
  });
});
afterAll(async () => {
  await s?.app.close();
  receiver?.close();
});
beforeEach(async () => {
  mails.length = 0;
  received.length = 0;
  dbm.db().run('DELETE FROM notification_outbox');
  dbm.db().run('DELETE FROM notification_digest_sends');
  dbm.db().run('DELETE FROM notification_sends');
  for (const n of ['qara', 'quinn', 'rhea']) dbm.db().run('DELETE FROM notification_prefs WHERE user_id = ?', user(n).id);
  await s.api('PUT', '/settings/quiet-hours', { allowed: true });
});

describe('quiet hours: settings', () => {
  it('are off by default, validated, audited, and go back to the default', async () => {
    const st = await qara('GET', '/me/notification-prefs');
    expect(st).toMatchObject({ source: { from: 'instance' }, allowed: true, prefs: { quietHours: { enabled: false } }, quiet: { active: false } });
    expect(await status(qara('PUT', '/me/notification-prefs', prefs({ quietHours: { ...ALWAYS, timeZone: 'Mars/Olympus' } })))).toBe(400);
    expect(
      await status(qara('PUT', '/me/notification-prefs', prefs({ quietHours: { ...ALWAYS, windows: [{ days: ['mon'], from: '25:00', to: '07:00' }] } }))),
    ).toBe(400);
    // decisions: immediately or hourly only (a run waits)
    expect(
      await status(qara('PUT', '/me/notification-prefs', prefs({ digests: { timeZone: 'UTC', groups: { decisions: { rhythm: 'daily', time: '17:00' } } } }))),
    ).toBe(400);
    const saved = await qara('PUT', '/me/notification-prefs', prefs({ quietHours: ALWAYS }));
    expect(saved).toMatchObject({ source: { from: 'own' }, quiet: { active: true, held: 0 } });
    const a = (await s.api('GET', '/audit?action=notification.quiet_hours_changed&limit=1'))[0];
    expect(a).toMatchObject({ entityType: 'user', entityId: user('qara').id, details: { to: { enabled: true } } });
    expect((await s.api('GET', '/settings/quiet-hours')).users.map((x: { username: string }) => x.username)).toContain('qara');
    expect(await status(qara('GET', '/settings/quiet-hours'))).toBe(403);
    expect(await status(qara('PUT', '/settings/quiet-hours', { allowed: false }))).toBe(403);
    expect((await qara('DELETE', '/me/notification-prefs')).source).toEqual({ from: 'instance' });
  });

  it('take a team default for members without their own', async () => {
    const team = (await s.api('POST', '/teams', { name: `Night shift ${Date.now()}`, members: ['rhea'] })).id;
    await s.api('PUT', `/teams/${team}/settings`, { quietHours: ALWAYS });
    const st = await s.as('rhea', PW).then((c) => c('GET', '/me/notification-prefs'));
    expect(st.source).toMatchObject({ from: 'team' });
    expect(st.prefs.quietHours.enabled).toBe(true);
    expect((await s.api('GET', '/audit?action=notification.quiet_hours_changed&limit=1'))[0]).toMatchObject({ entityType: 'team', entityId: team });
    await s.api('PUT', `/teams/${team}/settings`, { quietHours: null });
  });
});

describe('quiet hours: holding and the catch-up', () => {
  it('holds e-mail and channel posts, keeps the app, collapses repeats and sends one catch-up at the end', async () => {
    await qara('PUT', '/me/notification-prefs', prefs({ quietHours: ALWAYS }));
    const notif = await s.api('GET', '/settings/notifications');
    await s.api('PUT', '/settings/notifications', { ...notif, teams: { enabled: true, quietHours: ALWAYS } });
    svc.notify(notice({ recipients: [user('qara')] }));
    svc.notify(notice({ recipients: [user('qara')], text: () => ({ title: 'Credential “Orders key” is overdue', body: 'Rotate it now.' }) }));
    await flush();
    expect(mailsTo('qara@example.com')).toHaveLength(0);
    expect(received).toHaveLength(0);
    // the app got both at once
    expect((await qara('GET', '/notifications')).items.filter((n: { event: string }) => n.event === 'credential.due').length).toBeGreaterThan(0);
    const rows = held(`email:${user('qara').id}`);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.states)).toHaveLength(2);
    expect(held('teams:instance')).toHaveLength(1);
    expect((await qara('GET', '/me/notification-prefs')).quiet).toMatchObject({ active: true, held: 1 });
    // still quiet: nothing released
    expect(await outbox.runOutbox()).toBe(0);
    // the quiet hours end
    await qara('PUT', '/me/notification-prefs', prefs({ quietHours: { ...ALWAYS, enabled: false } }));
    await s.api('PUT', '/settings/notifications', { ...notif, teams: { enabled: true, quietHours: null } });
    expect(await outbox.runOutbox()).toBe(2);
    await flush();
    const m = mailsTo('qara@example.com');
    expect(m).toHaveLength(1);
    expect(m[0]!.subject).toContain('While you were away: 1 message');
    expect(m[0]!.text).toContain('Credential “Orders key” is overdue');
    expect(m[0]!.text).toContain('https://sm.example.com/credentials');
    expect(received.map((r) => r.path)).toEqual(['/instance']);
    expect(JSON.stringify(received[0]!.body)).toContain('While you were away');
    // at most once
    expect(await outbox.runOutbox()).toBe(0);
    expect(held(`email:${user('qara').id}`)).toHaveLength(0);
  });

  it('lets emergency access, urgent sources and expiring decisions through, with the reason in the footer', async () => {
    await qara('PUT', '/me/notification-prefs', prefs({ quietHours: ALWAYS }));
    svc.notify(notice({ event: 'security.emergency', recipients: [user('qara')], externalKey: 'emergency' }));
    await flush();
    expect(mailsTo('qara@example.com')).toHaveLength(1);
    expect(mailsTo('qara@example.com')[0]!.text).toContain('Sent during your quiet hours: someone used emergency access.');
    // an urgent source: a failed run breaks through (unless the person turned that off)
    const source = {
      key: 'schedule:x',
      kind: 'schedule',
      id: 'x',
      name: 'Nightly',
      owner: null,
      settingsLink: '/schedules',
      policy: { urgent: true },
    } as never;
    svc.notify(notice({ event: 'run.failed', recipients: [user('qara')], externalKey: 'run:urgent', source }));
    await flush();
    expect(mailsTo('qara@example.com')).toHaveLength(2);
    await qara('PUT', '/me/notification-prefs', prefs({ quietHours: { ...ALWAYS, urgentBreaksThrough: false } }));
    svc.notify(notice({ event: 'run.failed', recipients: [user('qara')], externalKey: 'run:urgent2', source }));
    await flush();
    expect(mailsTo('qara@example.com')).toHaveLength(2);
    // a decision that expires inside the quiet hours: through for everybody when nobody else is reachable …
    await s.as('quinn', PW).then((c) => c('PUT', '/me/notification-prefs', prefs({ quietHours: ALWAYS })));
    const soon = new Date(Date.now() + HOUR).toISOString();
    svc.notify(notice({ event: 'mcp.request', recipients: [user('qara'), user('quinn')], externalKey: 'mcp:1', expiresAt: soon }));
    await flush();
    expect(mailsTo('quinn@example.com')).toHaveLength(1);
    expect(mailsTo('quinn@example.com')[0]!.text).toMatch(/this request expires at \d\d:\d\d/);
    // … held for someone in quiet hours while another decider is reachable
    svc.notify(notice({ event: 'mcp.request', recipients: [user('quinn'), user('rhea')], externalKey: 'mcp:2', expiresAt: soon }));
    await flush();
    expect(mailsTo('quinn@example.com')).toHaveLength(1);
    expect(mailsTo('rhea@example.com')).toHaveLength(1);
    expect(held(`email:${user('quinn').id}`).map((r) => r.event)).toEqual(['mcp.request']);
  });

  it('leaves out decisions taken meanwhile and items the person may no longer see', async () => {
    await qara('PUT', '/me/notification-prefs', prefs({ quietHours: ALWAYS }));
    svc.notify(notice({ event: 'task.assigned', recipients: [user('qara')], externalKey: 'task:gone', decision: { kind: 'task', id: 'tsk_gone' } }));
    svc.notify(notice({ recipients: [user('qara')], externalKey: 'hidden', runId: 'run_does_not_exist' }));
    svc.notify(notice({ recipients: [user('qara')], externalKey: 'visible' }));
    await flush();
    expect(held(`email:${user('qara').id}`)).toHaveLength(3);
    await qara('PUT', '/me/notification-prefs', prefs());
    await outbox.runOutbox();
    await flush();
    const m = mailsTo('qara@example.com');
    expect(m).toHaveLength(1);
    expect(m[0]!.text).toContain('1 decided by others meanwhile');
    expect(m[0]!.subject).toContain('1 message');
  });

  it('administrators can switch quiet hours off for everyone: held messages go out', async () => {
    await qara('PUT', '/me/notification-prefs', prefs({ quietHours: ALWAYS }));
    svc.notify(notice({ recipients: [user('qara')] }));
    await flush();
    expect(held(`email:${user('qara').id}`)).toHaveLength(1);
    const view = await s.api('PUT', '/settings/quiet-hours', { allowed: false });
    expect(view.allowed).toBe(false);
    expect((await s.api('GET', '/audit?action=notification.quiet_hours_switch&limit=1'))[0].details).toEqual({ allowed: false });
    // new messages go out at once, held ones at the next tick
    svc.notify(notice({ recipients: [user('qara')], externalKey: 'cred:other' }));
    await outbox.runOutbox();
    await flush();
    expect(mailsTo('qara@example.com')).toHaveLength(2);
  });
});

describe('limits', () => {
  it('keeps at most 500 open items per target and folds the oldest into a count', async () => {
    const at = new Date().toISOString();
    for (let i = 0; i < 503; i++)
      outbox.holdMessage({
        target: 'team:limit',
        itemKey: `k${i}`,
        event: 'run.failed',
        reason: 'quiet',
        locale: 'en',
        state: { ts: at, title: `Run ${i} failed` },
      });
    const rows = held('team:limit');
    expect(rows).toHaveLength(500);
    const more = rows.find((r) => r.item_key === 'more:run.failed')!;
    expect(JSON.parse(more.states)[0].more).toBe(4);
    const content = outbox.renderHeld(
      dbm.db().all('SELECT * FROM notification_outbox WHERE target = ? AND released_at IS NULL', 'team:limit') as never,
      'catchup',
      'en',
    )!;
    expect(content.text).toContain('+ 4 more messages (run.failed)');
    dbm.db().run("DELETE FROM notification_outbox WHERE target = 'team:limit'");
  });
});

describe('security review 0.10.0', () => {
  it('never folds a waiting decision into the count of the 500-row limit (F3)', async () => {
    const at = Date.now() - 3_600_000;
    outbox.holdMessage({
      target: 'team:fold',
      itemKey: 'task.assigned:task:t1',
      event: 'task.assigned',
      reason: 'quiet',
      locale: 'en',
      state: { ts: new Date(at).toISOString(), title: 'Approve: delete the test database', link: '/runs/r1' },
    });
    for (let i = 0; i < 499; i++)
      outbox.holdMessage({
        target: 'team:fold',
        itemKey: `run:${i}`,
        event: 'run.failed',
        reason: 'quiet',
        locale: 'en',
        state: { ts: new Date(at + 1000 + i).toISOString(), title: `Run ${i} failed` },
      });
    outbox.holdMessage({
      target: 'team:fold',
      itemKey: 'check:x',
      event: 'check.failed',
      reason: 'quiet',
      locale: 'en',
      state: { ts: new Date().toISOString(), title: 'Check x failed' },
    });
    const rows = held('team:fold');
    expect(rows.map((r) => r.item_key)).toContain('task.assigned:task:t1');
    expect(rows.map((r) => r.item_key)).not.toContain('more:task.assigned');
    const content = outbox.renderHeld(
      dbm.db().all('SELECT * FROM notification_outbox WHERE target = ? AND released_at IS NULL', 'team:fold') as never,
      'catchup',
      'en',
    )!;
    expect(content.text).toContain('Decisions waiting for you (1)');
    expect(content.text).toContain('Approve: delete the test database');
    dbm.db().run("DELETE FROM notification_outbox WHERE target = 'team:fold'");
  });

  it('checks visibility at release for every kind an item can be about (F7)', async () => {
    await qara('PUT', '/me/notification-prefs', prefs({ quietHours: ALWAYS }));
    svc.notify(notice({ recipients: [user('qara')], externalKey: 'cred:gone', about: { kind: 'credential', id: 'cred_does_not_exist' } }));
    svc.notify(notice({ recipients: [user('qara')], externalKey: 'svc:gone', about: { kind: 'service', id: 'svc_does_not_exist' } }));
    svc.notify(notice({ recipients: [user('qara')], externalKey: 'plain', text: () => ({ title: 'A plain reminder', body: '' }) }));
    await flush();
    expect(held(`email:${user('qara').id}`)).toHaveLength(3);
    await qara('PUT', '/me/notification-prefs', prefs());
    await outbox.runOutbox();
    await flush();
    const m = mailsTo('qara@example.com');
    expect(m).toHaveLength(1);
    expect(m[0]!.subject).toContain('1 message');
    expect(m[0]!.text).toContain('A plain reminder');
  });

  it('team default quiet hours of members need the step-up, like channel quiet hours (F6)', async () => {
    const { changesTeamChannel } = await import('../src/auth/step-up-rules.js');
    const team = (await s.api('POST', '/teams', { name: `Step-up ${Date.now()}`, members: [] })).id;
    const req = (body: unknown) => ({ body, params: { id: team } }) as never;
    expect(changesTeamChannel(req({ quietHours: ALWAYS }))).toBe(true);
    expect(changesTeamChannel(req({ newResources: 'auto' }))).toBe(false);
    expect(changesTeamChannel(req({ quietHours: null }))).toBe(false);
  });
});

describe('digests', () => {
  it('collect a group hourly and send one digest when the hour began', async () => {
    await qara('PUT', '/me/notification-prefs', prefs({ digests: { timeZone: 'UTC', groups: { runs: { rhythm: 'hourly' } } } }));
    svc.notify(notice({ event: 'run.failed', recipients: [user('qara')], externalKey: 'run:a' }));
    svc.notify(notice({ event: 'run.failed', recipients: [user('qara')], externalKey: 'run:b' }));
    // another group: immediately
    svc.notify(notice({ recipients: [user('qara')], externalKey: 'cred:now' }));
    await flush();
    expect(mailsTo('qara@example.com')).toHaveLength(1);
    expect(held(`email:${user('qara').id}`).map((r) => r.reason)).toEqual(['hourly', 'hourly']);
    const at = Date.now();
    await outbox.runOutbox(at);
    await flush();
    // due once the next hour began
    await outbox.runOutbox(at + HOUR);
    await flush();
    const m = mailsTo('qara@example.com');
    expect(m.length).toBeGreaterThanOrEqual(2);
    expect(m.at(-1)!.subject).toContain('Your digest: 2 messages');
  });

  it('the daily summary takes the catch-up as its first section', async () => {
    const now = Date.now();
    const local = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hourCycle: 'h23' }).format(new Date(now));
    await qara('PUT', '/me/daily-summary', {
      enabled: true,
      time: local,
      timeZone: 'UTC',
      days: 'everyday',
      channel: 'inAppEmail',
      sections: ['runs'],
      skipEmpty: true,
    });
    await qara('PUT', '/me/notification-prefs', prefs({ quietHours: ALWAYS }));
    svc.notify(notice({ recipients: [user('qara')] }));
    await flush();
    await qara('PUT', '/me/notification-prefs', prefs());
    // the outbox waits: the summary is due
    expect(await outbox.runOutbox(now)).toBe(0);
    expect(summary.runDailySummaries(now)).toBe(1);
    await summary.flushSummaryMails();
    const m = mailsTo('qara@example.com');
    expect(m).toHaveLength(1);
    expect(m[0]!.text).toContain('While you were away');
    expect(m[0]!.text).toContain('Credential “Orders key” is due');
    expect(held(`email:${user('qara').id}`)).toHaveLength(0);
    await qara('DELETE', '/me/daily-summary');
  });

  it('a weekly daily summary is due on its day only', () => {
    const p = {
      enabled: true,
      time: '08:00',
      timeZone: 'UTC',
      days: 'weekly' as const,
      weekday: 'mon' as const,
      channel: 'inApp' as const,
      sections: [],
      skipEmpty: true,
    };
    expect(summary.dueDay(p, Date.parse('2026-11-09T08:05:00Z'))).toBe('2026-11-09'); // Monday
    expect(summary.dueDay(p, Date.parse('2026-11-10T08:05:00Z'))).toBeNull();
  });
});
