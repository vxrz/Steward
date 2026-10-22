import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

// Capture e-mails instead of talking to an SMTP server.
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

let s: TestServer;
beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
});
afterAll(async () => {
  await s?.app.close();
});

describe('audit checkpoints leave the system (SIEM line, e-mail)', () => {
  it('logs each signed checkpoint as one line for the SIEM and e-mails it to auditors', async () => {
    const { logger } = await import('../src/log.js');
    const info = vi.spyOn(logger, 'info');
    await s.api('PUT', '/settings/notifications', {
      email: { enabled: true, host: 'smtp.example.com', port: 587, secure: false, from: 'steward@example.com' },
      teams: { enabled: false },
      webhook: { enabled: false },
      routes: {},
    });
    const a = await s.api('PUT', '/audit/anchoring', { emailRecipients: ['auditor@example.com', 'worm-archive@example.com'], emailIntervalHours: 24 });
    expect(a.emailRecipients).toEqual(['auditor@example.com', 'worm-archive@example.com']);
    await expect(s.api('PUT', '/audit/anchoring', { emailRecipients: ['not-an-address'] })).rejects.toMatchObject({ status: 400 });

    const cp = await s.api('POST', '/audit/checkpoint');
    const line = info.mock.calls.find((c) => c[1] === 'audit checkpoint');
    expect((line?.[0] as { auditCheckpoint: { seq: number } }).auditCheckpoint.seq).toBe(cp.seq);

    await vi.waitFor(() => expect(mails.length).toBe(2));
    expect(mails.map((m) => m.to).sort()).toEqual(['auditor@example.com', 'worm-archive@example.com']);
    expect(mails[0]!.subject).toBe(`[Steward] Audit checkpoint #${cp.seq}`);
    const json = mails[0]!.text.split('\n').find((l) => l.startsWith('{"'))!;
    // what the auditor keeps is accepted as an anchor
    expect((await s.api('POST', '/audit/verify', { anchor: json })).ok).toBe(true);

    // at most once per interval
    await s.api('POST', '/audit/checkpoint');
    await new Promise((r) => setTimeout(r, 200));
    expect(mails.length).toBe(2);
  });
});
