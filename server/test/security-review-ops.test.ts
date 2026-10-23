/**
 * Regression tests for the security review findings 7–13 (credentials, report schedules, certificates,
 * monitors, Gatus). Each block reproduces a proof of concept from the review and checks that it no
 * longer works.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { quiesce, setup, startTestServer, type Client, type TestServer } from './helpers.js';

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
let gatusId: string;
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
  // the demo's feeder runs (and its schedules) would send check notifications to the admin during the e-mail tests
  await quiesce();
  [dana, olivia, adam, vera] = await Promise.all(['dana', 'olivia', 'adam', 'vera'].map((u) => s.as(u, PW)));
  gatusId = (await s.api('GET', '/platforms')).find((p: any) => p.name === 'Gatus (demo)').id;
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

// ---------------------------------------------------------------------------
// 10 – monitors: sub-monitors the viewer may not see

describe('#10 sub-monitors the viewer cannot view', () => {
  const SECRETS = ['Secret backend Zeta', 'secret-backend-zeta', 'Zeta heartbeat probe'];
  let subId: string;
  let parentId: string;
  let parentKey: string;
  const leaks = (x: unknown): string[] => {
    const text = typeof x === 'string' ? x : JSON.stringify(x);
    return [...SECRETS, subId].filter((n) => text.includes(n));
  };

  beforeAll(async () => {
    const eng = await import('../src/monitors/engine.js');
    const sub = await dana('POST', '/monitors', {
      key: 'secret-backend-zeta',
      definition: {
        name: 'Secret backend Zeta',
        failuresBeforeDown: 1,
        checks: [{ id: 'hb', name: 'Zeta heartbeat probe', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 60 }],
      },
    });
    subId = sub.monitor.id;
    await dana('PUT', `/monitors/${subId}/access`, { acl: [{ subject: 'user:dana', permissions: ['manage'] }] });
    const parent = await dana('POST', '/monitors', {
      definition: {
        name: 'Public production line',
        checks: [{ id: 'backend', name: 'Backend', type: 'monitor', monitor: subId }],
        outputs: [{ id: 'notify', type: 'notification', subscribers: ['role:viewer'] }],
      },
    });
    parentId = parent.monitor.id;
    parentKey = parent.monitor.key;
    const t0 = Date.now();
    try {
      eng.setMonitorClock(() => t0 + 2 * 60000);
      await eng.evaluateMonitorNow(subId);
      await eng.settle();
      await eng.evaluateMonitorNow(parentId);
      await eng.settle();
    } finally {
      eng.setMonitorClock(null);
    }
    (await import('../src/monitors/datasets.js')).publishDirtyDatasets();
    await (await import('../src/notifications/service.js')).flushNotifications();
  });

  it('the parent is down for everyone; its owner still sees the root cause in the sub-monitor', async () => {
    expect(await status(vera('GET', `/monitors/${subId}`))).toBe(404);
    const p = await dana('GET', `/monitors/${parentId}`);
    expect(p.status).toBe('down');
    expect(p.rootCauses).toEqual([expect.objectContaining({ monitorId: subId, checkId: 'hb', monitorName: 'Secret backend Zeta' })]);
    expect(p.checks[0].monitorRef).toMatchObject({ id: subId, name: 'Secret backend Zeta' });
  });

  it('UI API: list, detail, history, results and export hide the sub-monitor', async () => {
    const p = await vera('GET', `/monitors/${parentId}`);
    expect(p.status).toBe('down');
    expect(p.rootCauses).toEqual([expect.objectContaining({ hidden: true, monitorId: '', checkName: '' })]);
    expect(p.checks[0].status).toBe('down');
    expect(p.checks[0].monitorRef).toMatchObject({ hidden: true, id: '' });
    expect(leaks(p)).toEqual([]);
    const list = (await vera('GET', '/monitors')).find((m: any) => m.id === parentId);
    expect(list.rootCauses).toEqual([expect.objectContaining({ hidden: true })]);
    expect(leaks(list)).toEqual([]);
    const history = await vera('GET', `/monitors/${parentId}/history`);
    expect(history.length).toBeGreaterThan(0);
    expect(leaks(history)).toEqual([]);
    expect(leaks(await vera('GET', `/monitors/${parentId}/checks/backend/results`))).toEqual([]);
    expect(leaks(await vera('GET', `/monitors/${parentId}/export`))).toEqual([]);
  });

  it('public API v1 hides the sub-monitor', async () => {
    const token = (await vera('POST', '/me/tokens', { name: 'v1-monitors', scope: 'read' })).token;
    const v1 = async (url: string) => {
      const res = await fetch(`${s.base}/api/v1${url}`, { headers: { authorization: `Bearer ${token}` } });
      expect(res.status, url).toBe(200);
      return res.json();
    };
    for (const url of ['/monitors', `/monitors/${parentId}`, `/monitors/${parentId}/status`, `/monitors/${parentId}/history`]) {
      expect(leaks(await v1(url)), url).toEqual([]);
    }
    const st = await v1(`/monitors/${parentId}/status`);
    expect(st.rootCauses).toEqual([expect.objectContaining({ hidden: true })]);
  });

  it('MCP monitor tools hide the sub-monitor', async () => {
    await s.api('PUT', '/mcp-server', { enabled: true });
    const token = (await vera('POST', '/me/tokens', { name: 'mcp-monitors', scope: 'mcp' })).token;
    const MODERN = '2026-07-28';
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await fetch(`${s.base}/api/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
          'mcp-protocol-version': MODERN,
          'mcp-method': 'tools/call',
          'mcp-name': name,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name,
            arguments: args,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': MODERN,
              'io.modelcontextprotocol/clientCapabilities': {},
              'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
            },
          },
        }),
      });
      const text = await res.text();
      expect(res.status, text).toBe(200);
      const r = JSON.parse(text).result;
      expect(r?.isError, text).toBeFalsy();
      return r.structuredContent;
    };
    const m = await call('get_monitor', { monitor: parentId });
    expect(m.rootCauses).toEqual([expect.objectContaining({ hidden: true })]);
    expect(leaks(m)).toEqual([]);
    expect(leaks(await call('get_monitor_history', { monitor: parentId }))).toEqual([]);
    expect(leaks(await call('list_monitors', {}))).toEqual([]);
  });

  it('the dashboard dataset of the parent hides the sub-monitor', async () => {
    const ds = await vera('GET', `/datasets/monitor.${parentKey}`);
    expect(ds.rows.length).toBe(1);
    expect(leaks(ds)).toEqual([]);
  });

  it('notifications to users who cannot view the sub-monitor hide it', async () => {
    const inbox = (await vera('GET', '/notifications')).items.filter((n: any) => n.link?.startsWith(`/monitors/${parentId}`));
    expect(inbox.length).toBeGreaterThan(0);
    expect(inbox[0].body).toMatch(/a monitor you cannot view/);
    expect(leaks(inbox)).toEqual([]);
  });

  it('an editor who cannot view the sub-monitor can still save the parent unchanged', async () => {
    await dana('PUT', `/monitors/${parentId}/access`, {
      acl: [
        { subject: 'user:olivia', permissions: ['edit'] },
        { subject: 'role:viewer', permissions: ['view'] },
      ],
    });
    const p = await olivia('GET', `/monitors/${parentId}`);
    expect(leaks(p)).toEqual([]);
    const saved = await olivia('PUT', `/monitors/${parentId}`, { definition: { ...p.definition, description: 'edited by olivia' }, version: p.version });
    expect(saved.monitor.description).toBe('edited by olivia');
    const own = await dana('GET', `/monitors/${parentId}`);
    expect(own.definition.checks[0].monitor).toBe(subId);
  });
});

// ---------------------------------------------------------------------------
// 11 – credentials: platform names of platforms the viewer has no rights on

describe('#11 linked platforms of credentials', () => {
  it('the platform name is only shown to users with rights on the platform', async () => {
    const c = await dana('POST', '/credentials', credential({ name: 'Linked to Gatus', platformId: gatusId, ownerSubjects: ['user:vera'] }));
    expect(c.platformName).toBe('Gatus (demo)');
    const mine = await vera('GET', `/credentials/${c.id}`);
    expect(mine.platformName).toBeNull();
    expect((await vera('GET', '/credentials?q=Gatus (demo)')).items.map((x: any) => x.id)).not.toContain(c.id);
  });

  it('editors cannot link platforms they cannot see (no existence oracle)', async () => {
    const zabbix =
      (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'zabbix') ?? (await s.api('GET', '/platforms')).find((p: any) => p.id !== gatusId);
    await s.api('PUT', `/platforms/${zabbix.id}/access`, { acl: [{ subject: 'role:admin', permissions: ['manage'] }] });
    try {
      const hidden = await errorOf(dana('POST', '/credentials', credential({ platformId: zabbix.id })));
      const missing = await errorOf(dana('POST', '/credentials', credential({ platformId: 'plat_does_not_exist' })));
      expect(hidden).toMatch(/400/);
      expect(hidden.replaceAll(zabbix.id, 'ID')).toBe(missing.replaceAll('plat_does_not_exist', 'ID'));
      // an entry linked by an administrator stays editable for others (the link is kept)
      const c = await s.api('POST', '/credentials', credential({ name: 'Linked by admin', platformId: zabbix.id }));
      const seen = await dana('GET', `/credentials/${c.id}`);
      expect(seen.platformName).toBeNull();
      const saved = await dana('PUT', `/credentials/${c.id}`, {
        ...credential({ name: c.name, expiresAt: c.expiresAt }),
        platformId: seen.platformId,
        description: 'x',
      });
      expect(saved.platformId).toBe(zabbix.id);
    } finally {
      await s.api('PUT', `/platforms/${zabbix.id}/access`, { acl: [] });
    }
  });
});

// ---------------------------------------------------------------------------
// 12 / 13 – Gatus metrics

describe('#12 Gatus metrics path', () => {
  it('percent-encoded dots cannot leave the base path', async () => {
    const { checkMetricsPath } = await import('../src/gatus/metrics.js');
    for (const p of ['/%2e%2e/admin', '/%2E%2E/admin', '/.%2e/admin', '/x/%2e./y', '/a%2fb', '/a%5cb', '/a\\b', '/%252e%252e/admin', '/./metrics'])
      expect(() => checkMetricsPath(p), p).toThrow();
    expect(checkMetricsPath('/metrics')).toBe('/metrics');
    expect(checkMetricsPath('/gatus/metrics')).toBe('/gatus/metrics');
    const body = { enabled: false, intervalSeconds: 60, retentionDays: 30, rawRetentionDays: 7, metricsPath: '/%2e%2e/admin' };
    expect(await status(s.api('PUT', `/gatus/sources/${gatusId}`, body))).toBe(400);
  });

  it('the resolved scrape URL stays below the base path', async () => {
    const { metricsUrlBelow } = await import('../src/gatus/metrics.js');
    expect(metricsUrlBelow('https://h.example/gatus', '/metrics')).toBe('https://h.example/gatus/metrics');
    expect(() => metricsUrlBelow('https://h.example/gatus', '/../admin')).toThrow();
    expect(() => metricsUrlBelow('https://h.example/gatus', '/%2e%2e/admin')).toThrow();
  });
});

describe('#13 Gatus scrape throttling and clean-up', () => {
  const source = { enabled: false, intervalSeconds: 60, retentionDays: 30, rawRetentionDays: 7, metricsPath: '/metrics' };

  it('manual scrapes are throttled per source', async () => {
    await s.api('PUT', `/gatus/sources/${gatusId}`, source);
    expect((await olivia('POST', `/gatus/sources/${gatusId}/scrape`)).ok).toBe(true);
    const msg = await errorOf(olivia('POST', `/gatus/sources/${gatusId}/scrape`));
    expect(msg).toMatch(/429/);
  });

  it('endpoints not seen within the retention period are pruned', async () => {
    const d = await db();
    const old = new Date(Date.now() - 40 * DAY).toISOString();
    d.run(
      `INSERT INTO gatus_endpoints (platform_id, key, group_name, name, type, success, total_ok, total_fail, first_seen_at, last_seen_at)
       VALUES (?, 'gone_endpoint', '', 'gone', 'HTTP', 1, 1, 0, ?, ?)`,
      gatusId,
      old,
      old,
    );
    const { pruneGatusData } = await import('../src/gatus/metrics.js');
    pruneGatusData();
    expect(d.get('SELECT 1 AS x FROM gatus_endpoints WHERE platform_id = ? AND key = ?', gatusId, 'gone_endpoint')).toBeUndefined();
    expect(d.get<{ n: number }>('SELECT COUNT(*) AS n FROM gatus_endpoints WHERE platform_id = ?', gatusId)!.n).toBeGreaterThan(0);
  });

  it('deleting the platform removes its Gatus data', async () => {
    const d = await db();
    expect(d.get<{ n: number }>('SELECT COUNT(*) AS n FROM gatus_samples WHERE platform_id = ?', gatusId)!.n).toBeGreaterThan(0);
    // credentials and monitors that use the platform are not part of this test
    d.run('UPDATE credentials SET gatus_platform_id = NULL, gatus_endpoint_key = NULL WHERE gatus_platform_id = ?', gatusId);
    await s.api('DELETE', `/platforms/${gatusId}`);
    for (const t of ['gatus_sources', 'gatus_samples', 'gatus_hourly', 'gatus_transitions', 'gatus_endpoints']) {
      expect(d.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE platform_id = ?`, gatusId)!.n, t).toBe(0);
    }
  });
});
