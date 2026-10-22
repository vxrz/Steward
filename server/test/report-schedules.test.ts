import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { authHeaders, loginCookie, setup, startTestServer, ADMIN, type Client, type TestServer } from './helpers.js';

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const mails = vi.hoisted(() => [] as { to: string; subject: string; text: string; attachments?: { filename: string; content: Buffer }[] }[]);
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
let dana: Client, olivia: Client, adam: Client, audrey: Client, vera: Client;
let gatusId: string;
let monitorId: string;
let secretMonitorId: string;
const PW = 'Demo-password-1';
const H = 3600000;
const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status: number }) => e.status,
  );
const hasTool = (bin: string) => spawnSync(bin, ['-v'], { stdio: 'ignore' }).error === undefined;

async function download(url: string, user: string, password: string) {
  const cookie = await loginCookie(s.base, user, password);
  const res = await fetch(`${s.base}/api${url}`, { headers: { ...authHeaders(cookie), 'x-sm-client': '1' } });
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [dana, olivia, adam, audrey, vera] = await Promise.all(['dana', 'olivia', 'adam', 'audrey', 'vera'].map((u) => s.as(u, PW)));
  gatusId = (await s.api('GET', '/platforms')).find((p: any) => p.name === 'Gatus (demo)').id;
  // a monitor with a known history: up, down for 6 h, up again (inside the last 48 h)
  monitorId = (
    await dana('POST', '/monitors', {
      definition: { name: 'Report test – Historian', checks: [{ id: 'hb', name: 'Report', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 600 }] },
    })
  ).monitor.id;
  const { db } = await import('../src/db.js');
  const now = Date.now();
  for (const [ts, st, prev] of [
    [now - 48 * H, 'up', null],
    [now - 24 * H, 'down', 'up'],
    [now - 18 * H, 'up', 'down'],
  ] as const) {
    db().run(
      "INSERT INTO monitor_history (monitor_id, check_id, ts, status, previous, message) VALUES (?, '', ?, ?, ?, '')",
      monitorId,
      new Date(ts).toISOString(),
      st,
      prev,
    );
  }
  db().run(
    "INSERT INTO monitor_results (monitor_id, check_id, ts, status, message, duration_ms) VALUES (?, 'hb', ?, 'up', '', 120)",
    monitorId,
    new Date(now - 2 * H).toISOString(),
  );
  db().run(
    "INSERT INTO monitor_results (monitor_id, check_id, ts, status, message, duration_ms) VALUES (?, 'hb', ?, 'up', '', 480)",
    monitorId,
    new Date(now - 3 * H).toISOString(),
  );
  // a monitor dana may not see
  const secret = await s.api('POST', '/monitors', {
    definition: { name: 'Admins only – Payroll gateway', checks: [{ id: 'hb', name: 'Report', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 600 }] },
  });
  secretMonitorId = secret.monitor.id;
  await s.api('PUT', `/monitors/${secretMonitorId}/access`, { acl: [{ subject: 'user:admin', permissions: ['view'] }] });
  // Gatus metrics with two scrapes
  await s.api('PUT', `/gatus/sources/${gatusId}`, { enabled: true, metricsPath: '/metrics' });
  await s.api('POST', `/gatus/sources/${gatusId}/scrape`);
  await s.api('POST', `/gatus/sources/${gatusId}/scrape`);
  // credentials
  await dana('POST', '/credentials', {
    name: 'Expired agent certificate',
    type: 'agentCertificate',
    platformText: 'Insights Hub',
    expiresAt: new Date(now - 5 * 86400000).toISOString(),
    owners: [{ email: 'it@example.com', role: 'IT' }],
  });
  await dana('POST', '/credentials', { name: 'API client due soon', type: 'apiClient', expiresAt: new Date(now + 10 * 86400000).toISOString() });
  await s.api('PUT', '/settings/notifications', {
    email: { enabled: true, host: 'smtp.example.com', port: 587, secure: false, from: 'steward@example.com' },
    teams: { enabled: false },
    webhook: { enabled: false },
    routes: {},
  });
});
afterAll(async () => {
  await s?.app.close();
});

const body = (over: Record<string, unknown> = {}) => ({
  name: 'Weekly service report',
  preset: 'custom',
  cron: '0 6 * * 1',
  timezone: 'Europe/Berlin',
  periodDays: 2,
  lang: 'en',
  title: 'Service report',
  sections: {
    availability: { monitorIds: null, slaTarget: 99 },
    gatus: { sources: [{ platformId: gatusId, endpointKeys: null }], slaTarget: 99.5 },
    credentials: { dueWithinDays: 30 },
    runs: { processIds: null },
  },
  recipients: { users: ['olivia'], teams: [], emails: ['service-manager@example.com'] },
  attachPdf: true,
  ...over,
});

describe('report periods', () => {
  it('daily, weekly and monthly periods are calendar periods in the schedule time zone (DST-safe)', async () => {
    const { reportPeriod } = await import('../src/reports/schedules.js');
    const iso = (p: { from: number; to: number }) => [new Date(p.from).toISOString(), new Date(p.to).toISOString()];
    // Tuesday 2026-03-31 06:00 Berlin (summer time since Sunday 29th)
    const at = Date.parse('2026-03-31T04:00:00Z');
    expect(iso(reportPeriod('daily', 1, 'Europe/Berlin', at))).toEqual(['2026-03-29T22:00:00.000Z', '2026-03-30T22:00:00.000Z']);
    // the week Monday 23rd – Monday 30th spans the DST change: 167 hours
    expect(iso(reportPeriod('weekly', 7, 'Europe/Berlin', at))).toEqual(['2026-03-22T23:00:00.000Z', '2026-03-29T22:00:00.000Z']);
    expect(iso(reportPeriod('monthly', 30, 'Europe/Berlin', at))).toEqual(['2026-01-31T23:00:00.000Z', '2026-02-28T23:00:00.000Z']);
    expect(iso(reportPeriod('monthly', 30, 'UTC', Date.parse('2026-01-01T06:00:00Z')))).toEqual(['2025-12-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']);
    expect(iso(reportPeriod('custom', 3, 'UTC', Date.parse('2026-01-10T00:00:00Z')))).toEqual(['2026-01-07T00:00:00.000Z', '2026-01-10T00:00:00.000Z']);
  });
});

describe('report schedules', () => {
  let id: string;

  it('validates sections, references and recipients; viewers may not create', async () => {
    expect(await status(vera('POST', '/report-schedules', body()))).toBe(403);
    expect(await status(dana('POST', '/report-schedules', body({ sections: {} })))).toBe(400);
    expect(await status(dana('POST', '/report-schedules', body({ sections: { nope: {} } })))).toBe(400);
    expect(await status(dana('POST', '/report-schedules', body({ sections: { availability: { monitorIds: [secretMonitorId] } } })))).toBe(400); // dana may not see it
    expect(await status(dana('POST', '/report-schedules', body({ recipients: { users: ['ghost'], teams: [], emails: [] } })))).toBe(400);
    expect(await status(dana('POST', '/report-schedules', body({ recipients: { users: [], teams: [], emails: ['not-an-address'] } })))).toBe(400);
    expect(await status(dana('POST', '/report-schedules', body({ cron: 'every day' })))).toBe(400);
    expect(await status(dana('POST', '/report-schedules', body({ timezone: 'Mars/Olympus' })))).toBe(400);
    expect(await status(vera('POST', '/report-schedules', body({ sections: { gatus: { sources: [{ platformId: gatusId }] } } })))).toBe(403);
  });

  it('creates a schedule (owner = creator, audited, armed) and presets set the cron', async () => {
    const r = await dana('POST', '/report-schedules', body());
    id = r.id;
    expect(r).toMatchObject({ owner: 'dana', preset: 'custom', cron: '0 6 * * 1', canEdit: true });
    expect(r.nextRunAt).toBeTruthy();
    const weekly = await dana('POST', '/report-schedules', body({ name: 'Weekly preset', preset: 'weekly', cron: undefined, enabled: false }));
    expect(weekly.cron).toBe('0 6 * * 1');
    expect(weekly.nextRunAt).toBeNull(); // disabled
    expect((await s.api('GET', '/audit?action=report_schedule.created')).some((a: any) => a.entityId === id)).toBe(true);
    // visibility: owner, recipients, auditors and admins
    expect((await olivia('GET', '/report-schedules')).items.map((x: any) => x.id)).toContain(id);
    expect((await audrey('GET', '/report-schedules')).items.map((x: any) => x.id)).toContain(id);
    expect((await adam('GET', '/report-schedules')).items.map((x: any) => x.id)).not.toContain(id);
    expect(await status(adam('GET', `/report-schedules/${id}`))).toBe(404);
    expect((await olivia('GET', `/report-schedules/${id}`)).canEdit).toBe(false);
    expect(await status(olivia('PUT', `/report-schedules/${id}`, body()))).toBe(403);
    expect(await status(olivia('POST', `/report-schedules/${id}/run`))).toBe(403);
    expect(await status(olivia('DELETE', `/report-schedules/${id}`))).toBe(403);
  });

  it('generates the report now: sections, owner permissions, archive, audit, delivery', async () => {
    mails.length = 0;
    const schedules = await import('../src/reports/schedules.js');
    const rec = await schedules.runReportSchedule(id, { actor: 'dana', compress: false });
    expect(rec).toMatchObject({ kind: 'scheduled', scheduleId: id, createdBy: 'dana', title: 'Service report' });
    const text = rec.texts.join('\n');
    for (const fact of [
      'Service report',
      'Availability of monitors',
      'Report test – Historian',
      '87.50 %', // 42 of 48 hours up
      'missed', // SLA 99 %
      'Availability of Gatus endpoints',
      'plant/MES frontend',
      'plant/Historian API',
      'Credentials register',
      'Expired agent certificate',
      'API client due soon',
      'Runs',
      'PREPARED FOR (PERMISSIONS OF)',
      'Dana Designer (dana)',
      'Integrity and verification',
    ]) {
      expect(text, fact).toContain(fact);
    }
    // only what the owner may see
    expect(text).not.toContain('Admins only – Payroll gateway');
    // the outage of 6 hours and response times (avg 300, p95 480)
    expect(text).toContain('6 h 0 min');
    expect(text).toContain('480');
    // archived: immutable file with the recorded SHA-256, audited
    const file = path.join(s.dataDir, 'reports', 'scheduled', `${rec.id}.pdf`);
    if (process.env.SM_REPORT_SAMPLES) fs.copyFileSync(file, path.join(process.env.SM_REPORT_SAMPLES, 'scheduled-report-en.pdf'));
    const pdf = fs.readFileSync(file);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('utf8')).toContain('<stw:reportKind>scheduled</stw:reportKind>');
    if (hasTool('pdftotext')) {
      const out = spawnSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
      expect(out.stdout).toContain('Availability of monitors');
      expect(out.stdout).toContain('Credentials register');
    }
    const audit = await s.api('GET', '/audit?action=report.generated');
    expect(audit.some((a: any) => a.entityId === rec.id && a.details.sha256 === rec.sha256 && a.actor === 'dana')).toBe(true);
    const sched = await dana('GET', `/report-schedules/${id}`);
    expect(sched).toMatchObject({ lastReportId: rec.id, lastError: null });
    // delivery: in-app to the recipient user, e-mail with the PDF to the address
    const { flushNotifications } = await import('../src/notifications/service.js');
    await flushNotifications();
    expect(mails.map((m) => m.to)).toEqual(['service-manager@example.com']);
    expect(mails[0]!.subject).toContain('Report ready: Weekly service report');
    expect(mails[0]!.attachments?.[0]?.filename).toBe(rec.filename);
    expect((await olivia('GET', '/notifications')).items.some((n: any) => n.title === 'Report ready: Weekly service report')).toBe(true);
  });

  it('downloads: owner, recipients, auditors and admins; nobody else', async () => {
    const rec = (await dana('GET', `/report-schedules/${id}/reports`))[0];
    for (const [u, pw, code] of [
      ['dana', PW, 200],
      ['olivia', PW, 200],
      ['audrey', PW, 200],
      [ADMIN.username, ADMIN.password, 200],
      ['adam', PW, 404],
      ['vera', PW, 404],
    ] as const) {
      expect((await download(`/reports/${rec.id}/download`, u, pw)).status, u).toBe(code);
    }
    expect((await olivia('GET', '/report-schedules/reports')).map((r: any) => r.id)).toContain(rec.id);
    expect((await adam('GET', '/report-schedules/reports')).map((r: any) => r.id)).not.toContain(rec.id);
  });

  it('run now through the API; the admin’s report of the same sections contains the restricted monitor', async () => {
    const rec = await dana('POST', `/report-schedules/${id}/run`);
    expect(rec.kind).toBe('scheduled');
    const admins = await s.api(
      'POST',
      '/report-schedules',
      body({ name: 'Admin report', recipients: { users: [], teams: [], emails: [] }, sections: { availability: { monitorIds: null } } }),
    );
    const schedules = await import('../src/reports/schedules.js');
    const r = await schedules.runReportSchedule(admins.id, { actor: 'admin' });
    expect(r.texts.join('\n')).toContain('Admins only – Payroll gateway');
  });

  it('a deactivated owner stops the schedule (recorded, audited)', async () => {
    const tmp = await dana(
      'POST',
      '/report-schedules',
      body({ name: 'Owner gone', recipients: { users: [], teams: [], emails: [] }, sections: { credentials: {} } }),
    );
    const { db } = await import('../src/db.js');
    db().run("UPDATE report_schedules SET owner = 'ghost' WHERE id = ?", tmp.id);
    const schedules = await import('../src/reports/schedules.js');
    await expect(schedules.runReportSchedule(tmp.id, { actor: 'system' })).rejects.toThrow(/owner ghost is missing/);
    expect((await s.api('GET', `/report-schedules/${tmp.id}`)).lastError).toMatch(/owner ghost/);
    expect((await s.api('GET', '/audit?action=report_schedule.skipped')).some((a: any) => a.entityId === tmp.id)).toBe(true);
  });

  it('extension point: another feature registers a section (e.g. records)', async () => {
    const { registerReportSection } = await import('../src/reports/sections.js');
    registerReportSection<{ label: string }, { count: number; label: string }>({
      id: 'records',
      schema: z.object({ label: z.string().default('Change requests') }) as never,
      title: () => 'Records',
      build: (c) => ({ count: 3, label: c.label }),
      render: (d, { w, section }) => {
        section('Records');
        w.paragraph(`${d.count} ${d.label}`);
      },
      glance: (d) => [{ label: 'Records', value: String(d.count) }],
    });
    const r = await dana(
      'POST',
      '/report-schedules',
      body({ name: 'With records', recipients: { users: [], teams: [], emails: [] }, sections: { records: {}, credentials: {} } }),
    );
    const schedules = await import('../src/reports/schedules.js');
    const rec = await schedules.runReportSchedule(r.id, { actor: 'dana' });
    expect(rec.texts.join('\n')).toContain('3 Change requests');
    expect((await dana('GET', '/report-schedules')).sections).toContain('records');
  });

  it('owner or admin deletes the schedule; the reports stay archived', async () => {
    const rec = (await dana('GET', `/report-schedules/${id}/reports`))[0];
    await dana('DELETE', `/report-schedules/${id}`);
    expect(await status(dana('GET', `/report-schedules/${id}`))).toBe(404);
    expect((await download(`/reports/${rec.id}/download`, 'dana', PW)).status).toBe(200); // the generator keeps access
    expect((await download(`/reports/${rec.id}/download`, 'olivia', PW)).status).toBe(404); // recipients only while the schedule exists
    expect((await download(`/reports/${rec.id}/download`, 'audrey', PW)).status).toBe(200);
  });
});
