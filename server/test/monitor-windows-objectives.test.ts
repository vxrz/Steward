import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * One maintenance-window concept and monitors as an objective source (0.11, ADR 0018):
 * - a catalogue maintenance window lists monitors directly; the monitor honours it (status, alerts, objectives);
 * - the monitors' own windows of earlier versions are copied into such windows once (marked, audited);
 * - the monitor API's maintenance routes (deprecated) read and write those windows;
 * - an availability objective takes its figures from a Steward monitor, the same figure the monitor and the
 *   availability section of scheduled reports show for the same window; reports take the SLA target from it.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Demo-password-1';
let dana: Client, olivia: Client, vera: Client;
const HOUR = 3600000;
const DAY = 24 * HOUR;
const iso = (t: number) => new Date(t).toISOString();
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

let monitorId: string;
let svc: { id: string };

/** A monitor with a known history over the last 8 days: up, down 12 h (5 days ago), up; 2 h maintenance yesterday. */
async function monitorWithHistory(name: string): Promise<string> {
  const id = (
    await dana('POST', '/monitors', {
      definition: { name, checks: [{ id: 'hb', name: 'Heartbeat', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 600 }] },
    })
  ).monitor.id as string;
  const { db } = await import('../src/db.js');
  const now = Date.now();
  for (const [ts, st, prev] of [
    [now - 8 * DAY, 'up', null],
    [now - 5 * DAY, 'down', 'up'],
    [now - 5 * DAY + 12 * HOUR, 'up', 'down'],
    [now - DAY, 'maintenance', 'up'],
    [now - DAY + 2 * HOUR, 'up', 'maintenance'],
  ] as const)
    db().run("INSERT INTO monitor_history (monitor_id, check_id, ts, status, previous, message) VALUES (?, '', ?, ?, ?, '')", id, iso(ts), st, prev);
  return id;
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [dana, olivia, vera] = await Promise.all(['dana', 'olivia', 'vera'].map((u) => s.as(u, PW)));
  monitorId = await monitorWithHistory('Order intake');
  svc = await dana('POST', '/services', { name: 'Order service', owners: ['user:olivia'] });
});
afterAll(async () => {
  await s?.app.close();
});

const windowOf = (over: Record<string, unknown> = {}) => ({
  title: 'Broker upgrade',
  startsAt: iso(Date.now() - HOUR),
  endsAt: iso(Date.now() + HOUR),
  targets: [{ kind: 'monitor', id: monitorId }],
  ...over,
});

describe('catalogue windows that list monitors', () => {
  it('needs the acknowledge right on the monitor; the monitor is in maintenance while it lasts', async () => {
    expect(await status(vera('POST', '/maintenance-windows', windowOf()))).toBe(403);
    const w = await dana('POST', '/maintenance-windows', windowOf());
    expect(w.targets).toEqual([{ kind: 'monitor', id: monitorId, name: 'Order intake' }]);
    expect(w.affected.monitors).toBe(1);
    const m = await dana('GET', `/monitors/${monitorId}`);
    expect(m.maintenance).toMatchObject({ id: w.id, reason: 'Broker upgrade', createdBy: 'dana' });
    // the monitor page lists it (windows that list or reach the monitor)
    const list = await vera('GET', `/maintenance-windows?target=monitor:${monitorId}`);
    expect(list.windows.map((x: any) => x.id)).toContain(w.id);
    const maint = await import('../src/catalogue/maintenance.js');
    expect(maint.objectiveInMaintenance({ service_id: svc.id, application_id: null, monitor_id: monitorId })).toBe(true);
    expect(maint.objectiveInMaintenance({ service_id: svc.id, application_id: null })).toBe(false);
    await dana('POST', `/maintenance-windows/${w.id}/cancel`, {});
    expect((await dana('GET', `/monitors/${monitorId}`)).maintenance).toBeNull();
  });

  it('hides a monitor the reader may not see', async () => {
    const hidden = await s.api('POST', '/monitors', {
      definition: { name: 'Admins only – Vault', checks: [{ id: 'hb', name: 'Heartbeat', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 600 }] },
    });
    await s.api('PUT', `/monitors/${hidden.monitor.id}/access`, { acl: [{ subject: 'user:admin', permissions: ['view'] }] });
    const w = await s.api('POST', '/maintenance-windows', windowOf({ title: 'Vault patch', targets: [{ kind: 'monitor', id: hidden.monitor.id }] }));
    expect(await status(vera('GET', `/maintenance-windows/${w.id}`))).toBe(404);
    expect(JSON.stringify(await vera('GET', '/maintenance-windows'))).not.toContain('Vault patch');
    // a designer who may not see it cannot plan for it: to her it does not exist
    expect(await code(dana('POST', '/maintenance-windows', windowOf({ targets: [{ kind: 'monitor', id: hidden.monitor.id }] })))).toBe(
      'MAINTENANCE_TARGET_NOT_FOUND',
    );
    // an operator who sees a monitor but may not acknowledge it may not plan for it either
    await s.api('PUT', `/monitors/${monitorId}/access`, {
      acl: [
        { subject: 'user:olivia', permissions: ['view'] },
        { subject: 'user:dana', permissions: ['acknowledge'] },
      ],
    });
    try {
      expect(await code(olivia('POST', '/maintenance-windows', windowOf()))).toBe('FORBIDDEN');
    } finally {
      await s.api('PUT', `/monitors/${monitorId}/access`, { acl: [] });
    }
    // deleting the monitor removes the windows that listed only it
    await s.api('DELETE', `/monitors/${hidden.monitor.id}`);
    expect(await status(s.api('GET', `/maintenance-windows/${w.id}`))).toBe(404);
  });
});

describe('the deprecated monitor maintenance API', () => {
  it('plans, lists and ends catalogue windows that list the monitor, quietly as before', async () => {
    const { db } = await import('../src/db.js');
    expect(await status(vera('POST', `/monitors/${monitorId}/maintenance`, { endsAt: iso(Date.now() + HOUR), reason: 'x' }))).toBe(403);
    const w = await dana('POST', `/monitors/${monitorId}/maintenance`, { endsAt: iso(Date.now() + HOUR), reason: 'Disk swap' });
    expect(w).toMatchObject({ monitorId, reason: 'Disk swap', createdBy: 'dana', active: true });
    expect(w.id).toMatch(/^mtw_/);
    // it is a catalogue window: the same id, the monitor as its target, no reminder
    const cw = await dana('GET', `/maintenance-windows/${w.id}`);
    expect(cw).toMatchObject({ title: 'Disk swap', targets: [{ kind: 'monitor', id: monitorId }], quietMonitors: true, reminderHours: 0 });
    // no announcements: the notices of its one occurrence are claimed
    expect(db().all('SELECT kind FROM maintenance_notices WHERE window_id = ?', w.id).length).toBe(3);
    const { runMaintenanceJob } = await import('../src/catalogue/maintenance.js');
    runMaintenanceJob(Date.now());
    expect(db().all('SELECT kind FROM maintenance_notices WHERE window_id = ?', w.id).length).toBe(3);
    expect((await dana('GET', `/monitors/${monitorId}/maintenance`)).map((x: any) => x.id)).toContain(w.id);
    expect((await dana('GET', `/monitors/${monitorId}`)).maintenance?.id).toBe(w.id);
    await dana('DELETE', `/monitors/${monitorId}/maintenance/${w.id}`);
    expect((await dana('GET', `/monitors/${monitorId}`)).maintenance).toBeNull();
    expect((await dana('GET', `/maintenance-windows/${w.id}`)).cancelledAt).not.toBeNull();
    const audit = await s.api('GET', `/audit?entityType=monitor&entityId=${monitorId}&limit=50`);
    expect(audit.map((a: any) => a.action)).toEqual(expect.arrayContaining(['monitor.maintenance_added', 'monitor.maintenance_ended']));
    // a window that lists more than the monitor is changed under Maintenance
    const shared = await dana(
      'POST',
      '/maintenance-windows',
      windowOf({
        targets: [
          { kind: 'monitor', id: monitorId },
          { kind: 'service', id: svc.id },
        ],
      }),
    );
    expect(await code(dana('DELETE', `/monitors/${monitorId}/maintenance/${shared.id}`))).toBe('MAINTENANCE_SHARED');
    await dana('POST', `/maintenance-windows/${shared.id}/cancel`, {});
  });
});

describe('copying the monitors’ own windows (from before 0.11)', () => {
  it('copies each window once, marks the old row and audits the copy', async () => {
    const { db } = await import('../src/db.js');
    const maint = await import('../src/catalogue/maintenance.js');
    const engine = await import('../src/monitors/engine.js');
    const now = Date.now();
    const insert = (id: string, mid: string, start: number, end: number, reason: string) =>
      db().run(
        'INSERT INTO monitor_maintenance (id, monitor_id, starts_at, ends_at, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id,
        mid,
        iso(start),
        iso(end),
        reason,
        'olivia',
        iso(now - DAY),
      );
    insert('mw_running', monitorId, now - HOUR, now + HOUR, 'Firmware update');
    insert('mw_past', monitorId, now - 3 * DAY, now - 3 * DAY + HOUR, `${'Long reason. '.repeat(20)}`);
    insert('mw_gone', 'mon_deleted', now - HOUR, now + HOUR, 'Monitor deleted since');
    // not copied yet: the engine still honours the old row
    expect(engine.activeMaintenance(monitorId, now)).toMatchObject({ id: 'mw_running' });
    expect(maint.migrateMonitorWindows()).toBe(2);
    expect(maint.migrateMonitorWindows()).toBe(0);
    const rows = db().all<{ id: string; migrated_to: string | null; migrated_at: string | null }>(
      "SELECT id, migrated_to, migrated_at FROM monitor_maintenance WHERE id IN ('mw_running', 'mw_past', 'mw_gone') ORDER BY id",
    );
    expect(rows.every((r) => r.migrated_at)).toBe(true);
    expect(rows.find((r) => r.id === 'mw_gone')!.migrated_to).toBeNull();
    const running = rows.find((r) => r.id === 'mw_running')!.migrated_to!;
    const w = await dana('GET', `/maintenance-windows/${running}`);
    expect(w).toMatchObject({ title: 'Firmware update', createdBy: 'olivia', targets: [{ kind: 'monitor', id: monitorId }], current: { active: true } });
    const past = await dana('GET', `/maintenance-windows/${rows.find((r) => r.id === 'mw_past')!.migrated_to}`);
    expect(past.title.length).toBeLessThanOrEqual(160);
    expect(past.note).toContain('Long reason.');
    // now the catalogue window is what the engine sees
    expect(engine.activeMaintenance(monitorId, Date.now())).toMatchObject({ id: running, reason: 'Firmware update' });
    const audit = await s.api('GET', `/audit?entityType=maintenance&entityId=${running}`);
    expect(audit.map((a: any) => a.action)).toContain('maintenance.migrated');
    // the old id still ends it through the deprecated API
    await dana('DELETE', `/monitors/${monitorId}/maintenance/mw_running`);
    expect((await dana('GET', `/maintenance-windows/${running}`)).cancelledAt).not.toBeNull();
  });
});

describe('a Steward monitor as the source of an objective', () => {
  it('shows the monitor’s uptime – the same number as the monitor and the report for the same window', async () => {
    const o = await olivia('POST', '/objectives', { serviceId: svc.id, name: 'Orders accepted', monitorId, targets: { h24: 99, d7: 95, d30: 99.9 } });
    expect(o).toMatchObject({ sourceKind: 'monitor', sourceVisible: true, monitorId, monitorName: 'Order intake', platformId: null, endpointKey: null });
    const byWindow = Object.fromEntries(o.windows.map((w: any) => [w.window, w]));
    const mon = await dana('GET', `/monitors/${monitorId}`);
    // 12 h down in the last 7 days, maintenance time left out: (7 d − 2 h − 12 h) / (7 d − 2 h)
    expect(byWindow.d7.value).toBeCloseTo(mon.uptime.d7, 5);
    expect(byWindow.d7.value).toBeCloseTo(Math.round(((7 * 24 - 2 - 12) / (7 * 24 - 2)) * 10000) / 100, 5);
    expect(byWindow.d7.status).toBe('below');
    expect(byWindow.h24.value).toBe(100);
    expect(byWindow.d30.value).toBeCloseTo(mon.uptime.d30, 5);
    const { monitorAvailability } = await import('../src/reports/builtin-sections.js');
    const now = Date.now();
    expect(monitorAvailability(monitorId, now - 7 * DAY, now).uptime).toBeCloseTo(byWindow.d7.value, 5);
    // the scorecard names the monitor as the source
    const card = await dana('GET', `/scorecard/services/${svc.id}`);
    expect(card.availability.objectives).toEqual([expect.objectContaining({ name: 'Orders accepted', status: 'below', source: 'Order intake' })]);
    // hourly samples store the monitor's figures
    const { sampleObjectives } = await import('../src/scorecard/jobs.js');
    expect(sampleObjectives(now).sampled).toBeGreaterThanOrEqual(1);
    const detail = await dana('GET', `/objectives/${o.id}`);
    expect(detail.samples[0].values.d7).toBeCloseTo(byWindow.d7.value, 5);
  });

  it('checks the monitor, keeps it from readers who may not see it, and needs exactly one source', async () => {
    expect(await code(olivia('POST', '/objectives', { serviceId: svc.id, name: 'x', monitorId: 'mon_none', targets: { h24: 99 } }))).toBe(
      'OBJECTIVE_MONITOR_UNKNOWN',
    );
    expect(
      await status(olivia('POST', '/objectives', { serviceId: svc.id, name: 'x', monitorId, platformId: 'pf_x', endpointKey: 'k', targets: { h24: 99 } })),
    ).toBe(400);
    expect(await status(olivia('POST', '/objectives', { serviceId: svc.id, name: 'x', targets: { h24: 99 } }))).toBe(400);
    const hidden = await s.api('POST', '/monitors', {
      definition: { name: 'Admins only – Ledger', checks: [{ id: 'hb', name: 'Heartbeat', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 600 }] },
    });
    await s.api('PUT', `/monitors/${hidden.monitor.id}/access`, { acl: [{ subject: 'user:admin', permissions: ['view'] }] });
    expect(await code(olivia('POST', '/objectives', { serviceId: svc.id, name: 'x', monitorId: hidden.monitor.id, targets: { h24: 99 } }))).toBe(
      'OBJECTIVE_MONITOR_UNKNOWN',
    );
    const o = await s.api('POST', '/objectives', { serviceId: svc.id, name: 'Ledger up', monitorId: hidden.monitor.id, targets: { h24: 99 } });
    const seen = await olivia('GET', `/objectives/${o.id}`);
    expect(seen).toMatchObject({ sourceKind: 'monitor', sourceVisible: false, monitorId: null, monitorName: null });
    expect(JSON.stringify(await olivia('GET', `/scorecard/services/${svc.id}`))).not.toContain('Admins only – Ledger');
    // the owner changes the targets of an objective whose monitor she may not see: the source stays
    const kept = await olivia('PUT', `/objectives/${o.id}`, { name: 'Ledger up', targets: { h24: 98 } });
    expect(kept.targets.h24).toBe(98);
    const { db } = await import('../src/db.js');
    expect(db().get<{ monitor_id: string }>('SELECT monitor_id FROM availability_objectives WHERE id = ?', o.id)!.monitor_id).toBe(hidden.monitor.id);
    // a disabled monitor records nothing new: no data
    await s.api('POST', `/monitors/${hidden.monitor.id}/enabled`, { enabled: false });
    expect((await olivia('GET', `/objectives/${o.id}`)).noDataReason).toBe('monitorOff');
    await s.api('POST', `/objectives/${o.id}/archive`, { archived: true });
  });

  it('a maintenance window that lists the monitor shows its planned minutes and holds the breach message', async () => {
    const o = (await dana('GET', `/objectives?serviceId=${svc.id}`)).find((x: any) => x.name === 'Orders accepted');
    const w = await dana(
      'POST',
      '/maintenance-windows',
      windowOf({ title: 'Planned', startsAt: iso(Date.now() - 30 * 60000), endsAt: iso(Date.now() + HOUR) }),
    );
    const now = await dana('GET', `/objectives/${o.id}`);
    expect(now.windows.find((x: any) => x.window === 'h24').plannedMinutes).toBeGreaterThanOrEqual(30);
    const maint = await import('../src/catalogue/maintenance.js');
    const { db } = await import('../src/db.js');
    const row = db().get<any>('SELECT * FROM availability_objectives WHERE id = ?', o.id);
    expect(maint.objectiveInMaintenance(row)).toBe(true);
    await dana('POST', `/maintenance-windows/${w.id}/cancel`, {});
  });
});

describe('the SLA of scheduled reports from the objective', () => {
  it('judges each monitor by its objective’s target for the window closest to the period, else by the section’s target', async () => {
    const other = await monitorWithHistory('Invoice export');
    const { reportSection } = await import('../src/reports/sections.js');
    const { runAs } = await import('../src/auth/context.js');
    const { findUserByName, toAuthUser } = await import('../src/auth/users.js');
    const section = reportSection('availability')!;
    const now = Date.now();
    const build = (config: Record<string, unknown>, days: number) =>
      runAs(toAuthUser(findUserByName('dana')!), () => section.build(section.schema.parse(config), { from: now - days * DAY, to: now, now, lang: 'en' })) as {
        monitors: { id: string; target: number | null; targetFrom: string | null; objective: string | null; uptime: number | null }[];
      };
    // a weekly report: the 7-day target (95) of "Orders accepted"; the other monitor keeps the section's 99.5
    const weekly = build({ monitorIds: [monitorId, other], slaTarget: 99.5, slaFromObjectives: true }, 7);
    expect(weekly.monitors.find((m) => m.id === monitorId)).toMatchObject({ target: 95, targetFrom: 'objective', objective: 'Orders accepted' });
    expect(weekly.monitors.find((m) => m.id === other)).toMatchObject({ target: 99.5, targetFrom: 'section', objective: null });
    // a monthly report: the 30-day target
    expect(build({ monitorIds: [monitorId], slaTarget: null, slaFromObjectives: true }, 31).monitors[0]).toMatchObject({ target: 99.9 });
    // schedules from before 0.11: the section's target only
    expect(build({ monitorIds: [monitorId], slaTarget: 99.5 }, 7).monitors[0]).toMatchObject({ target: 99.5, targetFrom: 'section' });
    // the same figure as the objective for the same window
    const o = (await dana('GET', `/objectives?serviceId=${svc.id}`)).find((x: any) => x.name === 'Orders accepted');
    expect(weekly.monitors.find((m) => m.id === monitorId)!.uptime).toBeCloseTo(o.windows.find((x: any) => x.window === 'd7').value, 5);
  });
});
