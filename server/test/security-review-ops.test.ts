/**
 * Regression tests for the security review findings 7–13 (credentials, report schedules, certificates,
 * monitors, Gatus). Each block reproduces a proof of concept from the review and checks that it no
 * longer works.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const mails = vi.hoisted(() => [] as { to: string; subject: string; text: string }[]);
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: async (m: (typeof mails)[number]) => {
        mails.push(m);
      },
      close: () => undefined,
    }),
  },
}));

let s: TestServer;
let dana: Client, olivia: Client, adam: Client, vera: Client;
const PW = 'Demo-password-1';
const DAY = 86400000;
const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status: number }) => e.status,
  );
const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => '',
    (e: Error) => e.message,
  );
const db = async () => (await import('../src/db.js')).db();

const SMTP = {
  email: { enabled: true, host: 'smtp.corp.example', port: 587, secure: false, from: 'steward@corp.example' },
  teams: { enabled: false },
  webhook: { enabled: false },
  routes: {},
};

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [dana, olivia, adam, vera] = await Promise.all(['dana', 'olivia', 'adam', 'vera'].map((u) => s.as(u, PW)));
  // the company's own domain: the administrator's address
  await s.api('PATCH', '/me', { email: 'admin@corp.example' });
  await s.api('PUT', '/settings/notifications', SMTP);
});
afterAll(async () => {
  await s?.app.close();
});

const credential = (over: Record<string, unknown> = {}) => ({
  name: `Reminder entry ${Math.random().toString(36).slice(2, 8)}`,
  type: 'password',
  expiresAt: new Date(Date.now() + 20 * DAY).toISOString(),
  ...over,
});

// ---------------------------------------------------------------------------
// 7 – credential reminders to arbitrary external addresses

describe('#7 external e-mail recipients of credential reminders', () => {
  it('refuses owner addresses outside the allowed domains (default: the domains of Steward users)', async () => {
    const msg = await errorOf(dana('POST', '/credentials', credential({ owners: [{ email: 'victim@evil.example', role: 'x' }] })));
    expect(msg).toMatch(/400/);
    expect(msg).toMatch(/EMAIL_DOMAIN_NOT_ALLOWED/);
    expect(msg).toMatch(/Allowed e-mail domains for addresses outside Steward/);
    // the company's own domain works out of the box
    expect(await status(dana('POST', '/credentials', credential({ owners: [{ email: 'it@corp.example', role: 'IT' }] })))).toBe(200);
  });

  it('a single user cannot open a domain by putting it in their own profile', async () => {
    await vera('PATCH', '/me', { email: 'vera@freemail.example' });
    try {
      expect(await status(dana('POST', '/credentials', credential({ owners: [{ email: 'anyone@freemail.example' }] })))).toBe(400);
    } finally {
      await vera('PATCH', '/me', { email: '' });
    }
  });

  it('administrators allow domains (with wildcard subdomains) in the notification settings', async () => {
    expect(await status(dana('PUT', '/settings/notifications', { ...SMTP, allowedEmailDomains: ['evil.example'] }))).toBe(403);
    expect(await status(s.api('PUT', '/settings/notifications', { ...SMTP, allowedEmailDomains: ['not a domain'] }))).toBe(400);
    const saved = await s.api('PUT', '/settings/notifications', { ...SMTP, allowedEmailDomains: ['Corp.Example', '*.partner.example'] });
    expect(saved.allowedEmailDomains).toEqual(['corp.example', '*.partner.example']);
    try {
      expect(await status(dana('POST', '/credentials', credential({ owners: [{ email: 'a@eu.partner.example' }] })))).toBe(200);
      expect(await status(dana('POST', '/credentials', credential({ owners: [{ email: 'a@partner.example' }] })))).toBe(400);
      expect(await status(dana('POST', '/credentials', credential({ owners: [{ email: 'a@evil.example' }] })))).toBe(400);
      // a PUT without the field keeps the list
      expect((await s.api('PUT', '/settings/notifications', SMTP)).allowedEmailDomains).toEqual(['corp.example', '*.partner.example']);
    } finally {
      await s.api('PUT', '/settings/notifications', { ...SMTP, allowedEmailDomains: [] });
    }
  });

  it('at most 10 external addresses per entry', async () => {
    const owners = Array.from({ length: 11 }, (_, i) => ({ email: `owner${i}@corp.example` }));
    expect(await status(dana('POST', '/credentials', credential({ owners })))).toBe(400);
    expect(await status(dana('POST', '/credentials', credential({ owners: owners.slice(0, 10) })))).toBe(200);
  });

  it('notify() never mails a plain address outside the allowed domains (stored before the fix)', async () => {
    const { checkCredentialReminders } = await import('../src/credentials/reminders.js');
    const { flushNotifications } = await import('../src/notifications/service.js');
    const c = await dana('POST', '/credentials', credential({ name: 'Legacy owner entry', owners: [{ email: 'it@corp.example' }] }));
    const d = await db();
    d.run('UPDATE credentials SET owners = ? WHERE id = ?', JSON.stringify([{ email: 'it@corp.example' }, { email: 'victim@evil.example' }]), c.id);
    d.run('UPDATE credentials SET archived = 1 WHERE id <> ?', c.id);
    mails.length = 0;
    try {
      expect(checkCredentialReminders(Date.now())).toBe(1);
      await flushNotifications();
      expect(mails.map((m) => m.to)).toEqual(['it@corp.example']);
    } finally {
      d.run('UPDATE credentials SET archived = 0');
    }
  });

  it('the mail subject has a fixed prefix and a quoted, length-capped entry name', async () => {
    const { checkCredentialReminders } = await import('../src/credentials/reminders.js');
    const { flushNotifications } = await import('../src/notifications/service.js');
    const long = 'URGENT: your account is locked, call +1 555 0100 now to unlock it ' + 'x'.repeat(130);
    const c = await dana('POST', '/credentials', credential({ name: long, owners: [{ email: 'it@corp.example' }] }));
    const d = await db();
    d.run('UPDATE credentials SET archived = 1 WHERE id <> ?', c.id);
    mails.length = 0;
    try {
      expect(checkCredentialReminders(Date.now())).toBe(1);
      await flushNotifications();
      const subject = mails[0]!.subject;
      expect(subject).toMatch(/^\[Steward\] Credential reminder: "URGENT: your account/);
      expect(subject).not.toContain('x'.repeat(100));
      expect(subject.length).toBeLessThan(160);
    } finally {
      d.run('UPDATE credentials SET archived = 0');
    }
  });

  it('users who edit an entry only as its owner cannot change the owner e-mail addresses', async () => {
    const c = await dana(
      'POST',
      '/credentials',
      credential({ name: 'Owned by vera', ownerSubjects: ['user:vera'], owners: [{ email: 'it@corp.example', role: 'IT' }] }),
    );
    const base = { ...credential({ name: c.name, expiresAt: c.expiresAt }), ownerSubjects: ['user:vera'] };
    expect(await errorOf(vera('PUT', `/credentials/${c.id}`, { ...base, owners: [{ email: 'other@corp.example', role: 'IT' }] }))).toMatch(/403/);
    expect(await status(vera('PUT', `/credentials/${c.id}`, { ...base, owners: [] }))).toBe(403);
    // other fields (and the role of an owner) stay editable
    expect(await status(vera('PUT', `/credentials/${c.id}`, { ...base, description: 'checked', owners: [{ email: 'IT@corp.example', role: 'Ops' }] }))).toBe(
      200,
    );
    // editors by role may change them
    expect(await status(dana('PUT', `/credentials/${c.id}`, { ...base, owners: [{ email: 'other@corp.example' }] }))).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 8 – report schedules: seconds cron, no minimum interval, external recipients

describe('#8 report schedules', () => {
  const schedule = (over: Record<string, unknown> = {}) => ({
    name: `Schedule ${Math.random().toString(36).slice(2, 8)}`,
    preset: 'custom',
    cron: '0 6 * * 1',
    timezone: 'UTC',
    sections: { credentials: {} },
    recipients: { users: [], teams: [], emails: [] },
    ...over,
  });

  it('rejects a cron expression with seconds and anything more often than once an hour', async () => {
    expect(await errorOf(adam('POST', '/report-schedules', schedule({ cron: '* * * * * *' })))).toMatch(/400/);
    expect(await status(adam('POST', '/report-schedules', schedule({ cron: '0 0 6 * * 1' })))).toBe(400);
    expect(await errorOf(adam('POST', '/report-schedules', schedule({ cron: '*/5 * * * *' })))).toMatch(/once an hour/);
    expect(await status(adam('POST', '/report-schedules', schedule({ cron: '0,30 6 * * *' })))).toBe(400);
    expect(await status(adam('POST', '/report-schedules', schedule({ cron: '* 6 * * *' })))).toBe(400);
    const hourly = await adam('POST', '/report-schedules', schedule({ cron: '15 * * * *' }));
    expect(await status(adam('PUT', `/report-schedules/${hourly.id}`, schedule({ name: hourly.name, cron: '*/10 * * * *' })))).toBe(400);
    await adam('DELETE', `/report-schedules/${hourly.id}`);
  });

  it('a schedule stored before the limit with a seconds cron is not started', async () => {
    const schedules = await import('../src/reports/schedules.js');
    const r = await adam('POST', '/report-schedules', schedule());
    (await db()).run('UPDATE report_schedules SET cron = ? WHERE id = ?', '* * * * * *', r.id);
    schedules.startReportSchedules();
    const after = await adam('GET', `/report-schedules/${r.id}`);
    expect(after.nextRunAt).toBeNull();
    expect(after.lastError).toMatch(/not started/);
    await adam('DELETE', `/report-schedules/${r.id}`);
  });

  it('external recipients: allowed domains only, at most 20', async () => {
    const msg = await errorOf(adam('POST', '/report-schedules', schedule({ recipients: { users: [], teams: [], emails: ['x@evil.example'] } })));
    expect(msg).toMatch(/EMAIL_DOMAIN_NOT_ALLOWED/);
    const emails = Array.from({ length: 21 }, (_, i) => `r${i}@corp.example`);
    expect(await status(adam('POST', '/report-schedules', schedule({ recipients: { users: [], teams: [], emails } })))).toBe(400);
    const ok = await adam('POST', '/report-schedules', schedule({ recipients: { users: [], teams: [], emails: emails.slice(0, 20) } }));
    await adam('DELETE', `/report-schedules/${ok.id}`);
  });

  it('the report mail subject quotes and caps the schedule name', async () => {
    const schedules = await import('../src/reports/schedules.js');
    const { flushNotifications } = await import('../src/notifications/service.js');
    const name = 'Invoice overdue – pay now at https://pay.evil.example ' + 'y'.repeat(140);
    const r = await adam('POST', '/report-schedules', schedule({ name, recipients: { users: [], teams: [], emails: ['reports@corp.example'] } }));
    mails.length = 0;
    await schedules.runReportSchedule(r.id, { actor: 'adam', compress: false });
    await flushNotifications();
    const sent = mails.filter((m) => m.to === 'reports@corp.example');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toMatch(/^\[Steward\] Report ready: "Invoice overdue/);
    expect(sent[0]!.subject).not.toContain('y'.repeat(100));
    await adam('DELETE', `/report-schedules/${r.id}`);
  });

  it('at most 20 schedules per owner', async () => {
    const ids: string[] = [];
    try {
      for (let i = 0; i < 20; i++) ids.push((await olivia('POST', '/report-schedules', schedule({ enabled: false }))).id);
      expect(await errorOf(olivia('POST', '/report-schedules', schedule({ enabled: false })))).toMatch(/20 report schedules/);
    } finally {
      for (const id of ids) await olivia('DELETE', `/report-schedules/${id}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 9 – certificate PEM regex

describe('#9 certificate parsing', () => {
  it('many BEGIN markers without END are refused quickly', async () => {
    const pem = '-----BEGIN CERTIFICATE-----\n'.repeat(Math.floor(250_000 / 28));
    const t0 = Date.now();
    const msg = await errorOf(dana('POST', '/credentials/certificate/parse', { pem }));
    expect(Date.now() - t0).toBeLessThan(300);
    expect(msg).toMatch(/400/);
    const { parseCertificate } = await import('../src/credentials/certificates.js');
    const t1 = Date.now();
    expect(() => parseCertificate(Buffer.from('-----BEGIN CERTIFICATE-----\nAAAA\n'.repeat(20) + 'x'.repeat(200_000)))).toThrow();
    expect(Date.now() - t1).toBeLessThan(300);
  });
});
