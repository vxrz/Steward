import net from 'node:net';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { allowEmailDomains, setup, startTestServer, type TestServer } from './helpers.js';

process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

// Capture e-mails instead of talking to an SMTP server.
type Mail = { to: string; subject: string; text: string; html: string; headers?: Record<string, string> };
const mails = vi.hoisted(() => [] as Mail[]);
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: async (m: Mail) => {
        mails.push(m);
      },
      close: () => undefined,
    }),
  },
}));

let s: TestServer;
let eng: typeof import('../src/monitors/engine.js');

async function closedPort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise((r) => srv.close(r));
  return port;
}

const def = (port: number, emails?: string[]) => ({
  name: 'Invented line monitor',
  failuresBeforeDown: 1,
  checks: [{ id: 'tcp', name: 'Line reachable', type: 'tcp', host: '127.0.0.1', port }],
  outputs: [{ id: 'notify', type: 'notification', subscribers: [], ...(emails ? { emails } : {}) }],
});
const unsubscribe = (token: string, init: RequestInit = {}) => fetch(`${s.base}/unsubscribe/${token}`, { redirect: 'manual', ...init });
const tokenOf = (m: Mail) => /\/unsubscribe\/([A-Za-z0-9_.-]+)/.exec(m.headers!['List-Unsubscribe'])![1]!;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  eng = await import('../src/monitors/engine.js');
  const current = await s.api('GET', '/settings/notifications');
  await s.api('PUT', '/settings/notifications', {
    ...current,
    email: { enabled: true, host: 'smtp.example.com', port: 587, secure: false, from: 'steward@example.com' },
    routes: { ...current.routes, 'monitor.status': ['inApp', 'email'] },
  });
});

describe('monitor notification output to addresses outside Steward', () => {
  it('refuses a domain that is not allowed (naming the setting) and an invalid address', async () => {
    const port = await closedPort();
    await expect(s.api('POST', '/monitors', { definition: def(port, ['ext@other.example']) })).rejects.toMatchObject({
      status: 400,
      body: { code: 'EMAIL_DOMAIN_NOT_ALLOWED' },
    });
    await allowEmailDomains(s, ['partner.example']);
    await expect(s.api('POST', '/monitors', { definition: def(port, ['no-address']) })).rejects.toMatchObject({
      status: 400,
      body: { code: 'OUTPUT_EMAIL_INVALID' },
    });
    await expect(s.api('POST', '/monitors', { definition: def(port, ['ext@other.example']) })).rejects.toMatchObject({ status: 400 });
  });

  it('sends to the address with List-Unsubscribe headers; the link removes it, a wrong token does not; both are audited without the address', async () => {
    const port = await closedPort();
    const r = await s.api('POST', '/monitors', { definition: def(port, ['Ext.One@Partner.example', 'ext.two@partner.example']) });
    const id = r.monitor.id;
    expect(r.monitor.definition.outputs[0].emails).toEqual(['ext.one@partner.example', 'ext.two@partner.example']);
    // adding addresses is a change of the monitor: counted in the audit entry, never named
    const created = await s.api('GET', `/audit?action=monitor.created&limit=20`);
    expect(JSON.stringify(created)).not.toContain('ext.one@');

    mails.length = 0;
    await eng.evaluateMonitorNow(id);
    const { flushEmails } = await import('../src/notifications/email.js');
    await flushEmails();
    const ext = mails.filter((m) => m.to.endsWith('@partner.example'));
    expect(ext.map((m) => m.to).sort()).toEqual(['ext.one@partner.example', 'ext.two@partner.example']);
    const one = ext.find((m) => m.to === 'ext.one@partner.example')!;
    expect(one.headers!['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(one.headers!['List-Unsubscribe']).toMatch(/^<https?:\/\/[^>]+\/unsubscribe\/[^>]+>$/);
    expect(one.text).toContain('/unsubscribe/');
    // the token carries no address
    const token = tokenOf(one);
    expect(token).not.toContain('ext');
    expect(Buffer.from(token.split('.')[0]!, 'base64url').toString()).not.toContain('@');
    // each recipient has their own link
    expect(tokenOf(ext.find((m) => m.to === 'ext.two@partner.example')!)).not.toBe(token);

    // a wrong token is refused and changes nothing
    const wrong = `${token.split('.')[0]}.${'A'.repeat(43)}`;
    expect((await unsubscribe(wrong, { method: 'POST' })).status).toBe(404);
    expect((await unsubscribe('garbage')).status).toBe(404);
    expect((await s.api('GET', `/monitors/${id}`)).definition.outputs[0].emails).toHaveLength(2);

    // GET asks (German by the browser language) and changes nothing; one-click POST removes
    const page = await unsubscribe(token, { headers: { 'accept-language': 'de-DE,de;q=0.9' } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Abbestellen');
    expect((await s.api('GET', `/monitors/${id}`)).definition.outputs[0].emails).toHaveLength(2);
    const done = await unsubscribe(token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('receive');
    expect((await s.api('GET', `/monitors/${id}`)).definition.outputs[0].emails).toEqual(['ext.two@partner.example']);
    // the link works once
    expect((await unsubscribe(token, { method: 'POST' })).status).toBe(404);

    const entries = await s.api('GET', `/audit?action=monitor.recipient_unsubscribed&limit=20`);
    expect(entries.filter((a: any) => a.entityId === id)).toHaveLength(1);
    expect(JSON.stringify(entries)).not.toContain('ext.one');
  });

  it('an unsubscribe is a version of the monitor: an editor holding the older version gets VERSION_CONFLICT', async () => {
    const port = await closedPort();
    const r = await s.api('POST', '/monitors', { definition: def(port, ['ext.v@partner.example', 'ext.w@partner.example']) });
    const id = r.monitor.id;
    const before = (await s.api('GET', `/monitors/${id}`)).version;
    mails.length = 0;
    await eng.evaluateMonitorNow(id);
    const { flushEmails } = await import('../src/notifications/email.js');
    await flushEmails();
    const mail = mails.find((m) => m.to === 'ext.v@partner.example')!;
    expect((await unsubscribe(tokenOf(mail), { method: 'POST' })).status).toBe(200);
    const after = await s.api('GET', `/monitors/${id}`);
    expect(after.version).toBe(before + 1);
    await expect(
      s.api('PUT', `/monitors/${id}`, { definition: def(port, ['ext.v@partner.example', 'ext.w@partner.example']), version: before }),
    ).rejects.toMatchObject({
      status: 409,
      body: { code: 'VERSION_CONFLICT' },
    });
  });

  it('shows the addresses only to those who may edit the monitor: a viewer gets a count', async () => {
    const port = await closedPort();
    const r = await s.api('POST', '/monitors', { definition: def(port, ['ext.hide@partner.example', 'ext.hide2@partner.example']) });
    const id = r.monitor.id;
    await s.api('PUT', `/owning-teams/monitor/${id}`, { teamIds: [] });
    const vera = await s.as('vera', 'Demo-password-1');
    const seen = await vera('GET', `/monitors/${id}`);
    expect(seen.definition.outputs[0].emails).toBeUndefined();
    expect(seen.definition.outputs[0].emailCount).toBe(2);
    expect(JSON.stringify(seen)).not.toContain('ext.hide');
    const login = await fetch(`${s.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sm-client': '1' },
      body: JSON.stringify({ username: 'vera', password: 'Demo-password-1' }),
    });
    const exported = await fetch(`${s.base}/api/monitors/${id}/export`, {
      headers: { 'x-sm-client': '1', cookie: login.headers.get('set-cookie')!.split(';')[0]!, 'x-sm-session': login.headers.get('x-sm-session-key') ?? '' },
    });
    expect(exported.status).toBe(200);
    expect(await exported.text()).not.toContain('ext.hide');
    // the owner still sees them
    expect((await s.api('GET', `/monitors/${id}`)).definition.outputs[0].emails).toHaveLength(2);
  });

  it('counts added addresses in the audit entry of an update, never naming them', async () => {
    const port = await closedPort();
    const r = await s.api('POST', '/monitors', { definition: def(port) });
    await s.api('PUT', `/monitors/${r.monitor.id}`, { definition: def(port, ['ext.three@partner.example']) });
    const entries = (await s.api('GET', `/audit?action=monitor.updated&limit=20`)).filter((a: any) => a.entityId === r.monitor.id);
    expect(entries[0].details.externalRecipientsAdded).toBe(1);
    expect(JSON.stringify(entries)).not.toContain('ext.three');
  });

  it('redacts the finding text of a check of a module an internal recipient does not use for the external address too (ADR 0034)', async () => {
    await s.api('POST', '/demo/setup', {});
    const svc = (await s.api('POST', '/services', { name: 'Invented external redaction service' })).id as string;
    await s.api('PUT', `/owning-teams/service/${svc}`, { teamIds: [] });
    const r = await s.api('POST', '/monitors', {
      definition: {
        name: 'Invented costs alerts (external)',
        checks: [{ id: 'cost', name: 'Costs not rising', type: 'cost', scope: 'service', target: svc, period: 'month', maxIncreasePct: 20 }],
        outputs: [{ id: 'notify', type: 'notification', subscribers: ['user:vera'], emails: ['ext.red@partner.example'], holdSeconds: 0, include: 'checks' }],
      },
    });
    const id = (r.monitor ?? r).id as string;
    await s.api('PUT', `/owning-teams/monitor/${id}`, { teamIds: [] });
    const { db } = await import('../src/db.js');
    const { loadMonitor } = await import('../src/monitors/model.js');
    const { dispatchOutputs } = await import('../src/monitors/outputs.js');
    const { flushEmails } = await import('../src/notifications/email.js');
    const monitor = loadMonitor(db().get('SELECT * FROM monitors WHERE id = ?', id)!);
    const secret = 'Service "Invented secret service" rose by 40 %';
    await s.api('PUT', '/settings/modules/costs/access', { mode: 'selected', grants: [{ subject: 'user:dana' }] });
    try {
      mails.length = 0;
      await dispatchOutputs({
        monitor,
        subjects: [
          {
            dependent: false,
            event: {
              subject: 'cost',
              level: 'check',
              status: 'down',
              since: new Date().toISOString(),
              message: secret,
              causedBy: [],
              ts: new Date().toISOString(),
              monitor: { id, key: monitor.key, name: monitor.name, status: 'down' },
              check: { id: 'cost', key: 'cost', name: 'Costs not rising', type: 'cost' },
            },
          },
        ],
        maintenance: false,
        acknowledged: false,
        now: Date.now(),
      });
      await flushEmails();
      const ext = mails.filter((m) => m.to === 'ext.red@partner.example');
      expect(ext.length).toBeGreaterThan(0);
      expect(ext.map((m) => m.text + m.html).join(' ')).not.toContain('Invented secret service');
      expect(ext.map((m) => m.text).join(' ')).toContain('A check of a module you do not use');
    } finally {
      await s.api('PUT', '/settings/modules/costs/access', { mode: 'everyone', grants: [] });
    }
  });
});
