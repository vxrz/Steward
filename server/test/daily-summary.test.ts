import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

process.env.SM_GATUS_AUTOSTART = '0';

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

let s: TestServer;
let olivia: Client, vera: Client, dana: Client;
const PW = 'Demo-password-1';
const HOUR = 3600000;
const uniq = (p: string) => `${p}-${crypto.randomUUID().slice(0, 8)}`;
const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status: number }) => e.status,
  );
const PREFS = { enabled: true, time: '08:00', timeZone: 'Europe/Berlin', days: 'weekdays', channel: 'inApp', sections: ['runs'], skipEmpty: true };

// imported after the test server started (same module instances as the server)
let sum: typeof import('../src/notifications/summary.js');
let users: typeof import('../src/auth/users.js');
let dbm: typeof import('../src/db.js');
const user = (name: string) => users.findUserByName(name)!;
const rowsOf = (name: string) =>
  dbm.db().all<{ day: string; outcome: string }>('SELECT day, outcome FROM daily_summary_sends WHERE user_id = ? ORDER BY day', user(name).id);
const summaries = async (c: Client) => (await c('GET', '/notifications')).items.filter((n: any) => n.event === 'summary.daily');

/** A user of its own per test (summaries are per user and day). */
async function newUser(roles: string[], email?: string): Promise<{ name: string; c: Client }> {
  const name = uniq('sum').toLowerCase();
  users.createUser({ username: name, roles: roles as never, password: 'Summary-password-1', ...(email ? { email } : {}) });
  return { name, c: await s.as(name, 'Summary-password-1') };
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [olivia, vera, dana] = await Promise.all(['olivia', 'vera', 'dana'].map((u) => s.as(u, PW)));
  sum = await import('../src/notifications/summary.js');
  users = await import('../src/auth/users.js');
  dbm = await import('../src/db.js');
  const notif = await s.api('GET', '/settings/notifications');
  await s.api('PUT', '/settings/notifications', {
    ...notif,
    email: { enabled: true, host: 'smtp.example.com', port: 587, secure: false, from: 'steward@example.com' },
    allowedEmailDomains: ['example.com'],
  });
});
afterAll(async () => {
  await s?.app.close();
});

describe('daily summary: settings', () => {
  it('is off by default, validated, and administrators see who subscribed (no content)', async () => {
    const st = await vera('GET', '/me/daily-summary');
    expect(st).toMatchObject({ allowed: true, prefs: { enabled: false, days: 'weekdays', channel: 'inApp', skipEmpty: true }, lastSentAt: null });
    expect(st.emailBlockedReason).toBe('noAddress');
    expect(await status(vera('PUT', '/me/daily-summary', { ...PREFS, timeZone: 'Mars/Olympus' }))).toBe(400);
    expect(await status(vera('PUT', '/me/daily-summary', { ...PREFS, time: '25:00' }))).toBe(400);
    expect(await status(vera('PUT', '/me/daily-summary', { ...PREFS, sections: ['secrets'] }))).toBe(400);
    const saved = await vera('PUT', '/me/daily-summary', PREFS);
    expect(saved.prefs).toEqual(PREFS);
    expect(await status(vera('GET', '/settings/daily-summary'))).toBe(403);
    expect(await status(vera('PUT', '/settings/daily-summary', { allowed: false }))).toBe(403);
    const admin = await s.api('GET', '/settings/daily-summary');
    expect(admin.subscribers.find((x: any) => x.username === 'vera')).toEqual({
      username: 'vera',
      displayName: 'Vera Viewer',
      time: '08:00',
      timeZone: 'Europe/Berlin',
      days: 'weekdays',
      channel: 'inApp',
      lastSentAt: null,
    });
    // the switch: off for everyone (nothing is sent, nobody can turn it on)
    await s.api('PUT', '/settings/daily-summary', { allowed: false });
    expect(await status(olivia('PUT', '/me/daily-summary', PREFS))).toBe(409);
    expect(sum.runDailySummaries(Date.parse('2026-10-26T07:05:00Z'))).toBe(0);
    await s.api('PUT', '/settings/daily-summary', { allowed: true });
    await vera('PUT', '/me/daily-summary', { ...PREFS, enabled: false });
    const audit = await s.api('GET', '/audit?action=notification.daily_summary');
    expect(audit.length).toBeGreaterThanOrEqual(3);
  });
});

describe('daily summary: content per role', () => {
  it('collects only what the recipient may see', async () => {
    const { db } = dbm;
    const procs = await s.api('GET', '/processes');
    const [open, secret] = [procs[0], procs[1]];
    await s.api('PUT', `/processes/${secret.id}/access`, { acl: [{ subject: 'user:dana', permissions: ['view'] }] });
    const now = Date.now();
    const at = new Date(now - HOUR).toISOString();
    const run = (p: { id: string; name: string }, status: string, error: string | null) =>
      db().run(
        `INSERT INTO runs (id, process_id, process_name, process_version, definition_hash, status, dry_run, trigger, schedule_id, actor, inputs, bindings, started_at, finished_at, error, stats)
         VALUES (?, ?, ?, 1, 'x', ?, 0, 'manual', NULL, 'admin', '{}', '{}', ?, ?, ?, '{}')`,
        uniq('run_sum'),
        p.id,
        p.name,
        status,
        at,
        at,
        error,
      );
    run(open, 'failed', 'HTTP 503 from the open platform');
    run(secret, 'failed', 'HTTP 500 from the secret platform');
    run(open, 'succeeded', null);

    const mons = await s.api('GET', '/monitors');
    const list = (mons.items ?? mons).filter((m: any) => !m.isTemplate);
    const [visible, restricted] = [list[0], list[1]];
    await s.api('PUT', `/monitors/${restricted.id}/access`, { acl: [{ subject: 'user:dana', permissions: ['view'] }] });
    const cause = [{ monitorId: restricted.id, monitorKey: restricted.key, monitorName: restricted.name, checkId: 'c1', checkName: 'Secret check' }];
    const hist = (id: string, causes: unknown[]) =>
      db().run(
        "INSERT INTO monitor_history (monitor_id, check_id, ts, status, previous, message, caused_by) VALUES (?, '', ?, 'down', 'up', '', ?)",
        id,
        at,
        JSON.stringify(causes),
      );
    hist(visible.id, cause);
    hist(restricted.id, []);

    const t = await dana('POST', '/ticket-references', {
      source: 'vendor',
      externalNumber: uniq('CS'),
      title: 'Summary ticket for olivia',
      vendor: 'Vendor A',
      responsible: ['user:olivia'],
    });
    await dana('POST', '/credentials', {
      name: uniq('Vera cert'),
      type: 'certificate',
      ownerSubjects: ['user:vera'],
      expiresAt: new Date(now + 5 * 86400000).toISOString(),
    });
    const other = await dana('POST', '/credentials', { name: uniq('Other cert'), type: 'certificate', expiresAt: new Date(now + 5 * 86400000).toISOString() });
    const rec = await dana('POST', '/records', { type: 'CR', title: uniq('Summary CR'), fields: { reason: 'r', risk: 'low', rollbackPlan: 'p' } });
    await dana('POST', `/records/${rec.id}/transition`, { action: 'submit' });

    const all = { ...PREFS, sections: ['runs', 'tasks', 'monitors', 'credentials', 'tickets', 'records', 'reports'] } as any;
    const build = (name: string) => sum.buildSummary(user(name), all, now - 2 * HOUR, Date.now() + 1000);
    const text = (c: ReturnType<typeof build>, id: string) => JSON.stringify(c.sections.find((x) => x.id === id));

    const v = build('vera');
    expect(text(v, 'runs')).toContain('HTTP 503 from the open platform');
    expect(text(v, 'runs')).not.toContain('secret platform');
    expect(text(v, 'monitors')).toContain(visible.name);
    expect(text(v, 'monitors')).not.toContain(restricted.name);
    expect(text(v, 'monitors')).not.toContain('Secret check');
    expect(text(v, 'monitors')).toContain('a monitor you cannot view');
    expect(text(v, 'credentials')).toContain('Vera cert');
    expect(text(v, 'credentials')).not.toContain(other.name);
    expect(v.sections.find((x) => x.id === 'tickets')!.count).toBe(0);

    const d = build('dana');
    expect(text(d, 'runs')).toContain('secret platform');
    expect(text(d, 'monitors')).toContain(restricted.name);
    expect(text(d, 'credentials')).toContain(other.name);
    // dana submitted her own record: she sees the change, not an approval (four-eyes)
    expect(text(d, 'records')).toContain(`${rec.number}`);
    expect(text(d, 'records')).not.toContain('waits for your approval');

    expect(text(build('olivia'), 'tickets')).toContain(t.externalNumber);
    expect(text(build('adam'), 'records')).toContain(`${rec.number} ${rec.title} – waits for your approval`);
    // the preview of the profile page is the same content, nothing sent
    await olivia('PUT', '/me/daily-summary', { ...all, enabled: false });
    const preview = await olivia('GET', '/me/daily-summary/preview');
    expect(JSON.stringify(preview)).toContain(t.externalNumber);
    expect(rowsOf('olivia')).toEqual([]);
  });
});

describe('daily summary: scheduling and delivery', () => {
  // Monday 26 October 2026; Berlin is on CET (UTC+1) after 25 October
  const MON = Date.parse('2026-10-26T07:05:00Z');

  it('sends once per local day on the chosen days (fake clock) and skips empty days if asked', async () => {
    const u = await newUser(['viewer']);
    await u.c('PUT', '/me/daily-summary', { ...PREFS, sections: ['tickets'], skipEmpty: false });
    sum.runDailySummaries(MON - 10 * 60000); // 07:55 local: not yet
    expect(rowsOf(u.name)).toEqual([]);
    sum.runDailySummaries(MON);
    sum.runDailySummaries(MON + 5 * 60000);
    sum.runDailySummaries(MON + HOUR);
    expect(rowsOf(u.name)).toEqual([{ day: '2026-10-26', outcome: 'sent' }]);
    const inbox = await summaries(u.c);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].title).toBe('Daily summary for Mon, Oct 26, 2026');
    expect(inbox[0].body).toBe('Nothing to report.');
    // the next weekday again; not on Saturday; past the catch-up window neither
    sum.runDailySummaries(MON + 24 * HOUR);
    sum.runDailySummaries(Date.parse('2026-10-31T07:05:00Z'));
    sum.runDailySummaries(Date.parse('2026-10-28T13:30:00Z'));
    expect(rowsOf(u.name).map((r) => r.day)).toEqual(['2026-10-26', '2026-10-27']);
    // every day: Saturday too
    await u.c('PUT', '/me/daily-summary', { ...PREFS, days: 'everyday', sections: ['tickets'], skipEmpty: true });
    sum.runDailySummaries(Date.parse('2026-10-31T07:05:00Z'));
    // nothing to report and "skip empty": claimed (no retry), nothing delivered
    expect(rowsOf(u.name).at(-1)).toEqual({ day: '2026-10-31', outcome: 'empty' });
    expect(await summaries(u.c)).toHaveLength(2);
    expect((await u.c('GET', '/me/daily-summary')).lastSentAt).toBeTruthy();
  });

  it('writes in the user’s language and e-mails only allowed addresses with e-mail turned on', async () => {
    const de = await newUser(['operator'], `${uniq('de')}@example.com`);
    await de.c('PATCH', '/me', { locale: 'de', emailNotifications: true });
    await de.c('PUT', '/me/daily-summary', { ...PREFS, channel: 'inAppEmail', sections: ['tickets'], skipEmpty: false });
    const outside = await newUser(['operator'], `${uniq('ext')}@outside.test`);
    await outside.c('PATCH', '/me', { emailNotifications: true });
    await outside.c('PUT', '/me/daily-summary', { ...PREFS, channel: 'inAppEmail', sections: ['tickets'], skipEmpty: false });
    expect((await outside.c('GET', '/me/daily-summary')).emailBlockedReason).toBe('domainNotAllowed');
    const inAppOnly = await newUser(['operator'], `${uniq('in')}@example.com`);
    await inAppOnly.c('PATCH', '/me', { emailNotifications: true });
    await inAppOnly.c('PUT', '/me/daily-summary', { ...PREFS, sections: ['tickets'], skipEmpty: false });
    const optedOut = await newUser(['operator'], `${uniq('off')}@example.com`);
    await optedOut.c('PATCH', '/me', { emailNotifications: false });
    await optedOut.c('PUT', '/me/daily-summary', { ...PREFS, channel: 'inAppEmail', sections: ['tickets'], skipEmpty: false });

    mails.length = 0;
    sum.runDailySummaries(MON + 2 * 24 * HOUR);
    await sum.flushSummaryMails();
    const inbox = await summaries(de.c);
    expect(inbox[0].title).toBe('Tageszusammenfassung für Mi., 28. Okt. 2026');
    expect(inbox[0].body).toBe('Nichts zu berichten.');
    expect(mails.map((m) => m.to)).toEqual([user(de.name).email]);
    expect(mails[0]!.subject).toBe('[Steward] Tageszusammenfassung für Mi., 28. Okt. 2026');
    expect(mails[0]!.text).toContain('Nichts zu berichten.');
    expect(mails[0]!.html).toContain('<div lang="de"');
    expect(mails[0]!.html).toContain('/profile');
    // the others still got their in-app summary
    for (const x of [outside, inAppOnly, optedOut]) expect(await summaries(x.c)).toHaveLength(1);
  });

  it('escapes user-written text in the e-mail', async () => {
    const u = await newUser(['operator'], `${uniq('esc')}@example.com`);
    await u.c('PATCH', '/me', { emailNotifications: true });
    await u.c('PUT', '/me/daily-summary', { ...PREFS, channel: 'inAppEmail', sections: ['tickets'] });
    await dana('POST', '/ticket-references', {
      source: 'other',
      externalNumber: uniq('X'),
      title: '<img src=x onerror=alert(1)> & "quotes"',
      responsible: [`user:${u.name}`],
    });
    mails.length = 0;
    sum.runDailySummaries(MON + 3 * 24 * HOUR);
    await sum.flushSummaryMails();
    const mine = mails.filter((m) => m.to === user(u.name).email);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.html).not.toContain('<img');
    expect(mine[0]!.html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quotes&quot;');
    expect(mine[0]!.text).toContain('<img src=x onerror=alert(1)>'); // the text part is plain text
  });
});
