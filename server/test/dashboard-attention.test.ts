import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

// monitor states are set by the test, not by the engine
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

/**
 * The start page's tiles (GET /dashboard → attention): what needs the viewer's attention, counted with
 * their permissions. A tile the viewer has no right for is left out (not a 0).
 */
let s: TestServer;
let olivia: Client, audrey: Client, vera: Client;
const PW = 'Demo-password-1';
const DAY = 86400000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const attention = async (c: Client) => (await c('GET', '/dashboard')).attention;
const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status: number }) => e.status,
  );

async function monitor(name: string, opts: { status: string; acl?: unknown[]; enabled?: boolean }): Promise<string> {
  const r = await s.api('POST', '/monitors', {
    definition: {
      name,
      checks: [{ id: 'hb', name: 'Heartbeat', type: 'heartbeat', key: `att.${name.toLowerCase().replace(/\W+/g, '-')}`, mode: 'maxAge', maxAgeSeconds: 600 }],
    },
  });
  const id = r.monitor?.id ?? r.id;
  if (opts.acl) await s.api('PUT', `/monitors/${id}/access`, { acl: opts.acl });
  if (opts.enabled === false) await s.api('POST', `/monitors/${id}/enabled`, { enabled: false });
  const { db } = await import('../src/db.js');
  db().run('DELETE FROM monitor_state WHERE monitor_id = ?', id);
  db().run('INSERT INTO monitor_state (monitor_id, status, since) VALUES (?, ?, ?)', id, opts.status, new Date().toISOString());
  return id;
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [olivia, audrey, vera] = await Promise.all(['olivia', 'audrey', 'vera'].map((u) => s.as(u, PW)));
}, 120_000);
afterAll(async () => {
  await s?.app.close();
});

describe('start page tiles', () => {
  it('administrators and auditors get all nine tiles; viewers only what they may read', async () => {
    const admin = await attention(s.api);
    expect(Object.keys(admin).sort()).toEqual(['credentials', 'duties', 'findings', 'monitors', 'reviews', 'runs', 'scorecard', 'tasks', 'vendorTickets']);
    expect(Object.keys(await attention(audrey)).sort()).toEqual([
      'credentials',
      'duties',
      'findings',
      'monitors',
      'reviews',
      'runs',
      'scorecard',
      'tasks',
      'vendorTickets',
    ]);
    // the operator may use the reconciled platform, so they read its check
    expect(await attention(olivia)).toHaveProperty('findings');
    // vera (viewer) reads no access check and owns no credential: no tile, not a 0
    const v = await attention(vera);
    expect(await vera('GET', '/compliance/access-checks')).toEqual([]);
    expect(v).not.toHaveProperty('findings');
    expect(v).not.toHaveProperty('credentials');
    // and reviews no living document
    expect(v).not.toHaveProperty('reviews');
    // and is responsible for no service duty
    expect(v).not.toHaveProperty('duties');
    // and owns no service (the scorecard tile)
    expect(v).not.toHaveProperty('scorecard');
    expect(v).toHaveProperty('monitors');
    expect(v.vendorTickets).toEqual({ open: 0, oldestDays: null });
    // the old fields stay for the getting-started checklist
    expect((await s.api('GET', '/dashboard')).counts).toHaveProperty('platforms');
  });

  it('monitors: only those the viewer may view; down and degraded, not disabled or other states', async () => {
    const before = { admin: await attention(s.api), audrey: await attention(audrey), vera: await attention(vera) };
    await monitor('Att public down', { status: 'down' });
    await monitor('Att hidden down', { status: 'down', acl: [{ subject: 'role:admin', permissions: ['manage'] }] });
    await monitor('Att public degraded', { status: 'degraded' });
    await monitor('Att hidden degraded', { status: 'degraded', acl: [{ subject: 'role:admin', permissions: ['manage'] }] });
    await monitor('Att disabled down', { status: 'down', enabled: false });
    await monitor('Att public unknown', { status: 'unknown' });
    const delta = async (c: Client, b: any) => {
      const m = (await attention(c)).monitors;
      return { down: m.down - b.monitors.down, degraded: m.degraded - b.monitors.degraded };
    };
    expect(await delta(s.api, before.admin)).toEqual({ down: 2, degraded: 2 });
    // auditors view every monitor
    expect(await delta(audrey, before.audrey)).toEqual({ down: 2, degraded: 2 });
    expect(await delta(vera, before.vera)).toEqual({ down: 1, degraded: 1 });
    // the same as vera's monitor list
    const list = await vera('GET', '/monitors');
    expect((await attention(vera)).monitors.down).toBe(list.filter((m: any) => m.status === 'down').length);
  });

  it('credentials: overdue, expired and due soon entries the viewer may see', async () => {
    const before = await attention(s.api);
    const nobody = { type: 'technicalUser', ownerSubjects: [] };
    await s.api('POST', '/credentials', { ...nobody, name: 'Att expired', expiresAt: ago(2) });
    await s.api('POST', '/credentials', { ...nobody, name: 'Att overdue', rotationIntervalDays: 30, lastRotatedAt: ago(100) });
    await s.api('POST', '/credentials', { ...nobody, name: 'Att due soon', expiresAt: ago(-10) });
    await s.api('POST', '/credentials', { ...nobody, name: 'Att fine', expiresAt: ago(-300) });
    const after = (await attention(s.api)).credentials;
    expect({
      expired: after.expired - before.credentials.expired,
      overdue: after.overdue - before.credentials.overdue,
      dueSoon: after.dueSoon - before.credentials.dueSoon,
    }).toEqual({ expired: 1, overdue: 1, dueSoon: 1 });
    // vera gets the tile once she owns an entry – and counts only hers
    await s.api('POST', '/credentials', { type: 'technicalUser', name: 'Att vera due soon', ownerSubjects: ['user:vera'], expiresAt: ago(-5) });
    expect((await attention(vera)).credentials).toEqual({ expired: 0, overdue: 0, dueSoon: 1 });
  });

  it('findings: open findings of readable checks only', async () => {
    const before = { admin: (await attention(s.api)).findings.open, audrey: (await attention(audrey)).findings.open };
    const check = (await s.api('GET', '/compliance/access-checks'))[0];
    const r = await s.api('POST', '/compliance/demo/simulate-change', { accessCheckId: check.id });
    expect(r.result.findings).toHaveLength(1);
    expect((await attention(s.api)).findings.open).toBe(before.admin + 1);
    expect((await attention(audrey)).findings.open).toBe(before.audrey + 1);
    expect((await attention(olivia)).findings.open).toBe((await olivia('GET', '/compliance/findings?status=open')).length);
    expect(await attention(vera)).not.toHaveProperty('findings');
    // dismissed findings no longer count
    const f = r.result.findings[0];
    await s.api('POST', `/compliance/findings/${f.id}/dismiss`, { comment: 'Test account, removed again' });
    expect((await attention(s.api)).findings.open).toBe(before.admin);
  });

  it('vendor tickets: waiting for a vendor, or open with a vendor source; the age of the oldest', async () => {
    const t = (externalNumber: string, source: string, st: string, days: number) =>
      olivia('POST', '/ticket-references', { source, externalNumber, title: `Ticket ${externalNumber}`, status: st, openedAt: ago(days) });
    await t('V-1', 'servicenow-incident', 'waitingVendor', 12);
    await t('V-2', 'vendor', 'open', 3);
    await t('V-3', 'vendor', 'waitingUs', 30); // ours to do
    await t('V-4', 'servicenow-incident', 'open', 40); // not a vendor ticket
    await t('V-5', 'vendor', 'resolved', 50);
    for (const c of [s.api, vera]) expect((await attention(c)).vendorTickets).toEqual({ open: 2, oldestDays: 12 });
    // the tile's link lists the same tickets
    const list = await vera('GET', '/ticket-references?waitingOn=vendor');
    expect(list.items.map((x: any) => x.externalNumber).sort()).toEqual(['V-1', 'V-2']);
    expect(await status(vera('GET', '/ticket-references?waitingOn=us'))).toBe(400);
  });

  it('runs: failed runs of the last 24 hours out of all; the run list filters by start time', async () => {
    const a = await attention(s.api);
    const d = await s.api('GET', '/dashboard');
    expect(a.runs).toEqual({ failed: d.counts.failed24h, total: d.counts.runs24h });
    expect(a.tasks).toBe(d.openTasks.length);
    const since = ago(1);
    expect((await s.api('GET', `/runs?status=failed&since=${encodeURIComponent(since)}&limit=1000`)).length).toBe(a.runs.failed);
    expect((await s.api('GET', `/runs?since=${encodeURIComponent(since)}&limit=1000`)).length).toBe(a.runs.total);
    expect(await s.api('GET', `/runs?since=${encodeURIComponent(ago(-1))}`)).toEqual([]);
    expect(await status(s.api('GET', '/runs?since=yesterday'))).toBe(400);
  });
});
