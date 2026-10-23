import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

// Capture e-mails instead of talking to an SMTP server.
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
const PW = 'Demo-password-1';
let olivia: Client, adam: Client;
let receiver: http.Server;
let receiverUrl: string;
const received: { path: string; body: any }[] = [];
let approvalProcess: string;

const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status: number }) => e.status,
  );
const flush = async () => (await import('../src/notifications/service.js')).flushNotifications();
const inbox = async (c: Client) => ((await c('GET', '/notifications?limit=100')) as { items: any[] }).items;

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, what: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Starts the approval process as olivia and waits until adam has the task notification. */
async function startApproval(): Promise<string> {
  const { id } = await olivia('POST', '/runs', { processId: approvalProcess });
  await s.waitRun(id, ['waiting']);
  await waitFor(async () => (await inbox(adam)).find((n) => n.event === 'task.assigned' && n.link === `/runs/${id}`), 'task notification');
  await flush();
  return id;
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [olivia, adam] = await Promise.all(['olivia', 'adam'].map((u) => s.as(u, PW)));
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
  approvalProcess = (
    await s.api('POST', '/processes', {
      definition: {
        name: 'Needs approval',
        nodes: [
          { id: 'start', type: 'start', x: 0, y: 0 },
          { id: 'ok', type: 'userTask', mode: 'approve', title: 'Approve cleanup', x: 1, y: 0 },
        ],
        wires: [{ from: 'start', port: 'out', to: 'ok' }],
      },
    })
  ).id;
});

afterAll(async () => {
  await s?.app.close();
  receiver?.close();
});

describe('language of the profile (PATCH /api/me)', () => {
  it('starts unset and accepts only supported languages', async () => {
    const st = await adam('GET', '/auth/status');
    expect(st.me.user.locale).toBeNull();
    expect((await adam('PATCH', '/me', { locale: 'de' })).locale).toBe('de');
    expect((await adam('GET', '/auth/status')).me.user.locale).toBe('de');
    expect(await status(adam('PATCH', '/me', { locale: 'xx' }))).toBe(400);
    expect(await status(adam('PATCH', '/me', { locale: 'DE' }))).toBe(400);
    expect((await adam('PATCH', '/me', { locale: null })).locale).toBeNull();
    expect((await adam('PATCH', '/me', { locale: 'de', emailNotifications: true, email: 'adam@example.com' })).locale).toBe('de');
  });

  it('records the change in the audit log', async () => {
    const audit = (await s.api('GET', '/audit?action=user.profile_updated')) as { summary: string }[];
    expect(audit.some((a) => a.summary === 'adam updated their profile: language de')).toBe(true);
  });

  it('keeps the language of other users untouched', async () => {
    expect((await olivia('GET', '/auth/status')).me.user.locale).toBeNull();
    const users = (await s.api('GET', '/users')) as { username: string; locale: string | null }[];
    expect(users.find((u) => u.username === 'adam')?.locale).toBe('de');
  });
});

describe('default language setting', () => {
  it('defaults to English and is validated', async () => {
    expect((await s.api('GET', '/settings')).defaultLocale).toBe('en');
    expect(await status(olivia('PUT', '/settings', { defaultLocale: 'de' }))).toBe(403);
    expect(await status(s.api('PUT', '/settings', { defaultLocale: 'fr' }))).toBe(400);
    expect((await s.api('PUT', '/settings', { defaultLocale: 'de' })).defaultLocale).toBe('de');
    expect((await s.api('PUT', '/settings', { defaultLocale: 'en' })).defaultLocale).toBe('en');
  });
});

describe('notifications in the recipient language', () => {
  beforeAll(async () => {
    await s.api('PUT', '/settings/notifications', {
      email: { enabled: true, host: 'smtp.example.com', port: 587, secure: false, from: 'steward@example.com' },
      teams: { enabled: true, webhookUrl: `${receiverUrl}/teams` },
      webhook: { enabled: true, url: `${receiverUrl}/hook` },
      routes: { 'task.assigned': ['inApp', 'email', 'teams', 'webhook'] },
    });
  });

  it('writes in-app notifications and e-mails in each recipient’s language', async () => {
    mails.length = 0;
    received.length = 0;
    const runId = await startApproval();
    const forAdam = (await inbox(adam)).find((n) => n.link === `/runs/${runId}`);
    expect(forAdam.title).toBe('Entscheidung erforderlich: Approve cleanup');
    expect(forAdam.body).toBe('Die Ausführung von „Needs approval“ (gestartet von olivia) wartet auf Ihre Entscheidung.');
    // the administrator has not chosen a language: default language (English)
    const forAdmin = (await inbox(s.api)).find((n) => n.link === `/runs/${runId}`);
    expect(forAdmin.title).toBe('Decision needed: Approve cleanup');

    const mail = mails.find((m) => m.to === 'adam@example.com');
    expect(mail?.subject).toBe('[Steward] Entscheidung erforderlich: Approve cleanup');
    expect(mail?.html).toContain('lang="de"');
    expect(mail?.html).toContain('In Steward öffnen');
    expect(mail?.text).toContain('wartet auf Ihre Entscheidung');
  });

  it('posts to channels in the default language', async () => {
    const hook = received.find((r) => r.path === '/hook');
    expect(hook?.body).toMatchObject({ event: 'task.assigned', locale: 'en', title: 'Decision needed: Approve cleanup' });
    const card = received.find((r) => r.path === '/teams')?.body.attachments[0].content;
    expect(card.actions[0].title).toBe('Open in Steward');
  });

  it('switches channel posts and users without a language when the default changes', async () => {
    await s.api('PUT', '/settings', { defaultLocale: 'de' });
    received.length = 0;
    const runId = await startApproval();
    expect((await inbox(s.api)).find((n) => n.link === `/runs/${runId}`).title).toBe('Entscheidung erforderlich: Approve cleanup');
    const hook = received.find((r) => r.path === '/hook');
    expect(hook?.body).toMatchObject({ locale: 'de', title: 'Entscheidung erforderlich: Approve cleanup' });
    expect(received.find((r) => r.path === '/teams')?.body.attachments[0].content.actions[0].title).toBe('In Steward öffnen');
    await s.api('PUT', '/settings', { defaultLocale: 'en' });
  });

  it('translates schedule skip reasons', async () => {
    const { onScheduleSkipped } = await import('../src/notifications/service.js');
    onScheduleSkipped({
      scheduleId: 'sch_test',
      name: 'Nightly review',
      owner: 'adam',
      reason: 'adam may not run this process',
      reasonCode: 'mayNotRun',
      reasonVars: { user: 'adam' },
    });
    const n = await waitFor(async () => (await inbox(adam)).find((x) => x.event === 'schedule.skipped'), 'skip notification');
    expect(n.title).toBe('Zeitplan übersprungen: Nightly review');
    expect(n.body).toBe('Der Zeitplan hat keine Ausführung gestartet: adam darf diesen Prozess nicht ausführen.');
    const admin = (await inbox(s.api)).find((x) => x.event === 'schedule.skipped');
    expect(admin.body).toBe('The schedule did not start a run: adam may not run this process.');
  });
});

describe('PDF report language', () => {
  it('follows the requesting user’s language unless the request names one', async () => {
    const runId = await startApproval();
    await olivia('PATCH', '/me', { locale: 'de' });
    try {
      const fromProfile = (await olivia('POST', `/runs/${runId}/reports`, {})) as { lang: string };
      expect(fromProfile.lang).toBe('de');
      const explicit = (await olivia('POST', `/runs/${runId}/reports`, { lang: 'en' })) as { lang: string };
      expect(explicit.lang).toBe('en');
    } finally {
      await olivia('PATCH', '/me', { locale: null });
    }
    const unset = (await olivia('POST', `/runs/${runId}/reports`, {})) as { lang: string };
    expect(unset.lang).toBe('en');
  });
});

describe('server message catalog', () => {
  it('translates with plurals, placeholders and English fallback', async () => {
    const { t, resolveLocale } = await import('../src/i18n/index.js');
    expect(t('de', 'common.minutes', { count: 1 })).toBe('1 Minute');
    expect(t('de', 'common.minutes', { count: 90 })).toBe('90 Minuten');
    expect(t('en', 'common.minutes', { count: 1 })).toBe('1 minute');
    expect(t('de', 'runFailed.title', { process: 'Backup' })).toBe('Ausführung fehlgeschlagen: Backup');
    expect(t('en', 'runFailed.titleDryRun', { process: 'Backup' })).toBe('Run failed: Backup (dry run)');
    expect(resolveLocale('xx', null, 'de')).toBe('de');
    expect(resolveLocale(undefined)).toBe('en');
  });

  it('formats dates in the given language', async () => {
    const { formatDateTime } = await import('../src/i18n/index.js');
    const iso = '2026-03-05T14:07:00Z';
    expect(formatDateTime('de', iso)).toMatch(/5\. März 2026/);
    expect(formatDateTime('en', iso)).toMatch(/Mar 5, 2026/);
    expect(formatDateTime('en', 'not a date')).toBe('not a date');
  });
});

describe('error codes', () => {
  it('returns a code for well-known errors (the message stays English)', async () => {
    const res = await fetch(`${s.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sm-client': '1' },
      body: JSON.stringify({ username: 'nobody', password: 'wrong-password-1' }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'WRONG_CREDENTIALS', error: 'Wrong user name or password' });
  });

  it('labels team and role subjects with their name for translated display', async () => {
    const subjects = (await s.api('GET', '/subjects')) as { value: string; kind: string; name?: string }[];
    expect(subjects.find((x) => x.value === 'role:approver')).toMatchObject({ kind: 'role', name: 'approver' });
    expect(subjects.find((x) => x.value === 'team:service desk')).toMatchObject({ kind: 'team', name: 'Service Desk' });
  });
});
