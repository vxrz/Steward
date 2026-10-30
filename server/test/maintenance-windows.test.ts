import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nthStart, occurrencesBetween } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Maintenance windows (#108): planned work on platforms, systems, applications and services, once or repeating; who
 * may plan it; what it reaches (monitors stay quiet, run messages can be paused, objectives send no breach message
 * and show the planned minutes); announcements and reminders; the calendar file; cancelling; the public API.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Demo-password-1';
let dana: Client, olivia: Client, vera: Client;
const HOUR = 3600000;
const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status: number }) => e.status,
  );
const code = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { body: unknown }) => ((typeof e.body === 'string' ? JSON.parse(e.body) : e.body) as { code?: string }).code,
  );
const iso = (t: number) => new Date(t).toISOString();
const flush = async () => (await import('../src/notifications/service.js')).flushNotifications();
const inbox = async (c: Client) => ((await c('GET', '/notifications?limit=500')) as { items: any[] }).items;

let app: any, svc: any, platformId: string, monitorId: string;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [dana, olivia, vera] = await Promise.all(['dana', 'olivia', 'vera'].map((u) => s.as(u, PW)));
  const { db } = await import('../src/db.js');
  // a monitor that checks a platform, and that platform in an application of a service
  const m = db()
    .all<{ id: string; definition: string }>('SELECT id, definition FROM monitors WHERE is_template = 0')
    .map((x) => ({ id: x.id, platform: /"platform":"(pf_[^"]+)"/.exec(x.definition)?.[1] }))
    .find((x) => x.platform);
  expect(m, 'a demo monitor that checks a platform').toBeTruthy();
  monitorId = m!.id;
  platformId = m!.platform!;
  app = await dana('POST', '/applications', { name: 'Maintained app', owners: ['user:olivia'] });
  await s.api('POST', `/applications/${app.id}/platforms`, { platformId });
  svc = await dana('POST', '/services', { name: 'Maintained service', owners: ['user:olivia'] });
  await dana('PUT', `/services/${svc.id}/applications/${app.id}`, { role: 'primary' });
});
afterAll(async () => {
  await s?.app.close();
});

const windowOf = (over: Record<string, unknown> = {}) => ({
  title: 'Patch day',
  startsAt: iso(Date.now() + 3 * 24 * HOUR),
  endsAt: iso(Date.now() + 3 * 24 * HOUR + 2 * HOUR),
  targets: [{ kind: 'application', id: app.id }],
  ...over,
});

describe('repetition', () => {
  it('keeps the local time across daylight saving and moves the 31st to the end of shorter months', () => {
    // 10:00 in Berlin on a Sunday in March, before the change to summer time: 10:00 again a week later
    const start = Date.parse('2026-03-22T09:00:00Z');
    const next = nthStart(start, { freq: 'weekly', interval: 1, until: null }, 1, 'Europe/Berlin');
    expect(new Date(next).toISOString()).toBe('2026-03-29T08:00:00.000Z');
    const monthly = Date.parse('2026-01-31T21:00:00Z');
    const r = { freq: 'monthly' as const, interval: 1, until: null };
    expect(new Date(nthStart(monthly, r, 1, 'UTC')).toISOString()).toBe('2026-02-28T21:00:00.000Z');
    expect(new Date(nthStart(monthly, r, 2, 'UTC')).toISOString()).toBe('2026-03-31T21:00:00.000Z');
    const w = {
      startsAt: '2026-01-05T20:00:00Z',
      endsAt: '2026-01-05T22:00:00Z',
      recurrence: { freq: 'weekly' as const, interval: 2, until: '2026-03-01T00:00:00Z' },
      timeZone: 'UTC',
    };
    const occ = occurrencesBetween(w, Date.parse('2026-01-01T00:00:00Z'), Date.parse('2026-12-31T00:00:00Z'));
    expect(occ.map((o) => new Date(o.start).toISOString().slice(0, 10))).toEqual(['2026-01-05', '2026-01-19', '2026-02-02', '2026-02-16']);
  });
});

describe('maintenance windows', () => {
  it('designers and the owners of every listed item plan maintenance; others are refused', async () => {
    expect(await status(vera('POST', '/maintenance-windows', windowOf()))).toBe(403);
    // olivia owns the application, but has no manage right on the platform
    const mine = await olivia('POST', '/maintenance-windows', windowOf());
    expect(mine.canEdit).toBe(true);
    expect(await code(olivia('POST', '/maintenance-windows', windowOf({ targets: [{ kind: 'platform', id: platformId }] })))).toBe('FORBIDDEN');
    expect(await code(dana('POST', '/maintenance-windows', windowOf({ targets: [{ kind: 'service', id: 'svc_nope' }] })))).toBe('MAINTENANCE_TARGET_NOT_FOUND');
    const t = Date.now() + 24 * HOUR;
    expect(await code(dana('POST', '/maintenance-windows', windowOf({ startsAt: iso(t), endsAt: iso(t - HOUR) })))).toBe('MAINTENANCE_END_BEFORE_START');
    expect(await code(dana('POST', '/maintenance-windows', windowOf({ startsAt: iso(t), endsAt: iso(t + 40 * 24 * HOUR) })))).toBe('MAINTENANCE_TOO_LONG');
    expect(
      await code(dana('POST', '/maintenance-windows', windowOf({ startsAt: iso(t), endsAt: iso(t + 8 * 24 * HOUR), recurrence: { freq: 'weekly' } }))),
    ).toBe('MAINTENANCE_OVERLAPS_ITSELF');
    expect(await code(dana('POST', '/maintenance-windows', windowOf({ recurrence: { freq: 'weekly', until: iso(Date.now()) } })))).toBe(
      'MAINTENANCE_UNTIL_BEFORE_START',
    );
    // vera reads it, but may not change it
    const read = await vera('GET', `/maintenance-windows/${mine.id}`);
    expect(read.canEdit).toBe(false);
    expect(await status(vera('PUT', `/maintenance-windows/${mine.id}`, windowOf()))).toBe(403);
    await dana('POST', `/maintenance-windows/${mine.id}/cancel`, { reason: 'test' });
  });

  it('reaches the platforms, monitors and services below and above what it lists', async () => {
    const w = await dana('POST', '/maintenance-windows', windowOf({ targets: [{ kind: 'service', id: svc.id }] }));
    expect(w.affected).toMatchObject({ applications: 1, services: 1, platforms: 1 });
    expect(w.affected.monitors).toBeGreaterThanOrEqual(1);
    const byTarget = await vera('GET', `/maintenance-windows?target=platform:${platformId}`);
    expect(byTarget.windows.map((x: any) => x.id)).toContain(w.id);
    const none = await vera('GET', `/maintenance-windows?target=service:svc_other`);
    expect(none.windows.map((x: any) => x.id)).not.toContain(w.id);
    await dana('POST', `/maintenance-windows/${w.id}/cancel`, {});
  });

  it('lists repeating windows with each occurrence in the range', async () => {
    const start = Date.now() + 2 * 24 * HOUR;
    const w = await dana(
      'POST',
      '/maintenance-windows',
      windowOf({ title: 'Weekly patch', startsAt: iso(start), endsAt: iso(start + HOUR), recurrence: { freq: 'weekly', interval: 1, until: null } }),
    );
    expect(w.upcoming).toHaveLength(20);
    const list = await vera(
      'GET',
      `/maintenance-windows?from=${encodeURIComponent(iso(Date.now()))}&to=${encodeURIComponent(iso(Date.now() + 30 * 24 * HOUR))}`,
    );
    expect(list.occurrences.filter((o: any) => o.windowId === w.id).length).toBeGreaterThanOrEqual(4);
    expect(list.canPlan).toBe(false);
    expect(await code(vera('GET', `/maintenance-windows?from=${encodeURIComponent(iso(Date.now()))}&to=${encodeURIComponent(iso(Date.now() - HOUR))}`))).toBe(
      'MAINTENANCE_RANGE',
    );
    await dana('POST', `/maintenance-windows/${w.id}/cancel`, {});
  });

  it('keeps affected monitors quiet, pauses run messages and objective breach messages while it lasts', async () => {
    const m = await import('../src/catalogue/maintenance.js');
    const { db } = await import('../src/db.js');
    const now = Date.now();
    const w = await dana(
      'POST',
      '/maintenance-windows',
      windowOf({ title: 'Now', startsAt: iso(now - HOUR), endsAt: iso(now + HOUR), targets: [{ kind: 'platform', id: platformId }], pauseMessages: true }),
    );
    expect(w.current.active).toBe(true);
    expect(m.maintenanceForMonitor(monitorId, Date.now())).toMatchObject({ id: w.id, reason: 'Now' });
    // the engine asks the catalogue for monitors without a window of their own
    const mon = await dana('GET', `/monitors/${monitorId}`);
    expect(mon.maintenance?.reason).toBe('Now');
    // a run with the platform bound
    db().run(
      `INSERT INTO runs (id, process_id, process_name, process_version, definition_hash, status, dry_run, trigger, actor, inputs, bindings, started_at, finished_at, stats)
       VALUES ('run_maint', 'prc_x', 'x', 1, 'x', 'failed', 0, 'manual', 'dana', '{}', ?, ?, ?, '{}')`,
      JSON.stringify({ platform: platformId }),
      iso(now),
      iso(now),
    );
    expect(m.maintenancePausesRun('run_maint', Date.now())).toBe(true);
    expect(m.maintenancePausesRun('run_none', Date.now())).toBe(false);
    // objectives of the service of the application on the platform
    expect(m.objectiveInMaintenance({ service_id: svc.id, application_id: null }, Date.now())).toBe(true);
    expect(m.objectiveInMaintenance({ service_id: 'svc_other', application_id: null }, Date.now())).toBe(false);
    const planned = m.plannedMinutes({ service_id: svc.id, application_id: null }, { h1: HOUR, h24: 24 * HOUR }, now);
    expect(planned.h1).toBe(60);
    expect(planned.h24).toBe(60);
    // cancelled: no longer in effect, the minutes until the cancellation still count
    await dana('POST', `/maintenance-windows/${w.id}/cancel`, { reason: 'done early' });
    expect(m.maintenanceForMonitor(monitorId, Date.now())).toBeUndefined();
    expect(m.objectiveInMaintenance({ service_id: svc.id, application_id: null }, Date.now())).toBe(false);
    expect(m.plannedMinutes({ service_id: svc.id, application_id: null }, { h24: 24 * HOUR }).h24).toBe(60);
    expect(await code(dana('PUT', `/maintenance-windows/${w.id}`, windowOf()))).toBe('MAINTENANCE_CANCELLED');
    const audit = await s.api('GET', `/audit?entityType=maintenance&entityId=${w.id}&limit=10`);
    expect(audit.map((a: any) => a.action)).toEqual(expect.arrayContaining(['maintenance.created', 'maintenance.cancelled']));
    db().run("DELETE FROM runs WHERE id = 'run_maint'");
  });

  it('announces a window, reminds before each occurrence and tells when it starts and ends (once each)', async () => {
    const m = await import('../src/catalogue/maintenance.js');
    const { db } = await import('../src/db.js');
    const start = Date.now() + 48 * HOUR;
    const w = await dana('POST', '/maintenance-windows', windowOf({ title: 'Announced', startsAt: iso(start), endsAt: iso(start + HOUR), reminderHours: 24 }));
    await flush();
    const mine = async () => (await inbox(olivia)).filter((n) => n.link?.includes(w.id));
    expect((await mine()).map((n) => n.title)).toEqual([expect.stringContaining('Announced')]);
    // planned more than 24 h ahead: a reminder 24 h before, then start and end
    expect(m.runMaintenanceJob(start - 23 * HOUR)).toBeGreaterThanOrEqual(1);
    expect(m.runMaintenanceJob(start - 22 * HOUR)).toBe(0);
    m.runMaintenanceJob(start + 10 * 60000);
    m.runMaintenanceJob(start + HOUR + 60000);
    await flush();
    const kinds = db()
      .all<{ kind: string }>('SELECT kind FROM maintenance_notices WHERE window_id = ? ORDER BY sent_at', w.id)
      .map((r) => r.kind);
    expect(kinds.sort()).toEqual(['end', 'planned', 'reminder', 'start']);
    expect((await mine()).length).toBe(4);
    await dana('POST', `/maintenance-windows/${w.id}/cancel`, {});
  });

  it('offers a calendar file with the repetition', async () => {
    const start = Date.parse('2030-01-31T22:00:00Z');
    const w = await dana(
      'POST',
      '/maintenance-windows',
      windowOf({ title: 'Month end; backup', startsAt: iso(start), endsAt: iso(start + 2 * HOUR), recurrence: { freq: 'monthly', interval: 1, until: null } }),
    );
    const body = (await dana('GET', `/maintenance-windows/${w.id}/ics`)) as string;
    expect(body).toContain('BEGIN:VEVENT');
    expect(body).toContain('SUMMARY:Month end\\; backup');
    expect(body).toMatch(/DTSTART;TZID=[^:]+:\d{8}T\d{6}/);
    expect(body).toMatch(/RRULE:FREQ=MONTHLY;INTERVAL=1(;BYMONTHDAY=28,29,30,31;BYSETPOS=-1)?/);
    expect(body.split('\r\n').every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
    await dana('POST', `/maintenance-windows/${w.id}/cancel`, {});
  });

  it('is in the public API without edit flags', async () => {
    const w = await dana('POST', '/maintenance-windows', windowOf({ title: 'Public' }));
    const token = (await vera('POST', '/me/tokens', { name: 'maintenance', scope: 'read' })).token;
    const r = await (await fetch(`${s.base}/api/v1/maintenance-windows`, { headers: { authorization: `Bearer ${token}` } })).json();
    const x = r.windows.find((y: any) => y.id === w.id);
    expect(x).toMatchObject({ title: 'Public', targets: [{ kind: 'application', id: app.id, name: 'Maintained app' }] });
    expect(x.canEdit).toBeUndefined();
    expect(r.occurrences.some((o: any) => o.windowId === w.id)).toBe(true);
    await dana('POST', `/maintenance-windows/${w.id}/cancel`, {});
  });
});
