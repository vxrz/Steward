import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Service status pages (#26): what a page says about its services (monitors, maintenance, vendor issues), who may set
 * them up, the status viewer role that sees nothing else, and the secret link that works without signing in.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
let s: TestServer;
let dana: Client;
let olivia: Client;
let stella: Client;
let svc: string;
let quiet: string;
let monitorUp: string;
let monitorDown: string;

const db = async () => (await import('../src/db.js')).db();
const monitor = async (name: string) =>
  (
    await s.api('POST', '/monitors', {
      definition: { name, checks: [{ id: 'c', name: 'c', type: 'http', url: 'https://example.com/health' }] },
    })
  ).monitor.id as string;
const setState = async (id: string, status: string) =>
  (await db()).run(
    `INSERT INTO monitor_state (monitor_id, status, since, root_causes, last_evaluated_at) VALUES (?, ?, ?, '[]', ?)
     ON CONFLICT(monitor_id) DO UPDATE SET status = excluded.status`,
    id,
    status,
    new Date().toISOString(),
    new Date().toISOString(),
  );

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup');
  // the demo status viewer (role "status" only)
  [dana, olivia, stella] = await Promise.all(['dana', 'olivia', 'stella'].map((u) => s.as(u, PW)));
  svc = (await s.api('POST', '/services', { name: 'Plant data platform', owners: [] })).id;
  quiet = (await s.api('POST', '/services', { name: 'Quiet service', owners: [] })).id;
  monitorUp = await monitor('Status page up');
  monitorDown = await monitor('Status page down');
  for (const m of [monitorUp, monitorDown]) await s.api('POST', `/services/${svc}/links`, { kind: 'monitor', id: m });
  await setState(monitorUp, 'up');
  await setState(monitorDown, 'up');
  await s.api('POST', '/ticket-references', {
    source: 'vendor',
    externalNumber: 'CS-STATUS-1',
    title: 'Internal: their gateway drops our messages',
    vendor: 'Vendor A',
    links: [{ kind: 'service', id: svc }],
  });
});
afterAll(async () => {
  await s?.app.close();
});

describe('status pages', () => {
  let page: string;

  it('are set up by designers and administrators', async () => {
    await expect(olivia('POST', '/status-pages', { title: 'x', serviceIds: [svc] })).rejects.toThrow(/403/);
    await expect(dana('POST', '/status-pages', { title: 'x', serviceIds: ['svc_nope'] })).rejects.toThrow(/not found/);
    const p = await dana('POST', '/status-pages', { title: 'Plant services', serviceIds: [svc, quiet], notice: 'All lines run normally.' });
    page = p.id;
    expect(p).toMatchObject({ title: 'Plant services', serviceIds: [svc, quiet], publicLink: false, canEdit: true });
    expect((await olivia('GET', '/status-pages')).map((x: any) => x.id)).toContain(page);
  });

  it('say what the monitors say, without naming them or the tickets', async () => {
    const v = await olivia('GET', `/status-pages/${page}/view`);
    const plant = v.services.find((x: any) => x.name === 'Plant data platform');
    expect(plant).toMatchObject({ state: 'operational', monitors: { operational: 2 }, vendorIssues: [{ vendor: 'Vendor A' }] });
    expect(v.services.find((x: any) => x.name === 'Quiet service')).toMatchObject({ state: 'unknown', monitors: {} });
    expect(v).toMatchObject({ state: 'operational', notice: 'All lines run normally.' });
    expect(JSON.stringify(v)).not.toMatch(/Status page up|Internal: their gateway|CS-STATUS-1/);
    await setState(monitorDown, 'down');
    const v2 = await olivia('GET', `/status-pages/${page}/view`);
    expect(v2.services.find((x: any) => x.name === 'Plant data platform')).toMatchObject({ state: 'outage', monitors: { operational: 1, outage: 1 } });
    expect(v2.state).toBe('outage');
    await setState(monitorDown, 'up');
  });

  it('show planned and running maintenance', async () => {
    const soon = new Date(Date.now() + 2 * 3_600_000);
    await s.api('POST', '/maintenance-windows', {
      title: 'Firmware update of the edge devices',
      startsAt: soon.toISOString(),
      endsAt: new Date(soon.getTime() + 3_600_000).toISOString(),
      targets: [{ kind: 'service', id: svc }],
    });
    const v = await olivia('GET', `/status-pages/${page}/view`);
    expect(v.services.find((x: any) => x.name === 'Plant data platform').maintenance).toEqual([
      expect.objectContaining({ title: 'Firmware update of the edge devices', active: false }),
    ]);
  });

  it('are all a status viewer sees', async () => {
    expect((await stella('GET', '/status-pages')).map((x: any) => x.id)).toContain(page);
    expect((await stella('GET', `/status-pages/${page}/view`)).services).toHaveLength(2);
    for (const url of ['/services', '/monitors', '/platforms', '/processes', '/runs', `/status-pages/${page}`, '/me/tokens', '/tickets', '/ticket-references'])
      await expect(stella('GET', url), url).rejects.toThrow(/403/);
    await expect(stella('POST', '/status-pages', { title: 'x', serviceIds: [svc] })).rejects.toThrow(/403/);
    expect((await stella('GET', '/auth/me')).user.username).toBe('stella');
  });

  it('can be opened without signing in through a secret link, which can be revoked', async () => {
    const open = (token: string) => fetch(`${s.base}/api/public/status-page`, { headers: { 'x-status-token': token } });
    await expect(olivia('POST', `/status-pages/${page}/link`)).rejects.toThrow(/403/);
    const { token, page: p } = await dana('POST', `/status-pages/${page}/link`);
    expect(p.publicLink).toBe(true);
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // only the hash is stored
    expect(JSON.stringify((await db()).all('SELECT * FROM status_pages'))).not.toContain(token);
    const r = await open(token);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect((await r.json()).title).toBe('Plant services');
    expect((await open('x'.repeat(32))).status).toBe(404);
    expect((await fetch(`${s.base}/api/public/status-page`)).status).toBe(404);
    const audit = await s.api('GET', `/audit?entityType=status_page&entityId=${page}`);
    expect(audit.map((e: any) => e.action)).toEqual(expect.arrayContaining(['status_page.created', 'status_page.link_created', 'status_page.viewed_by_link']));
    // a new link replaces the old one; revoking ends it
    const second = (await dana('POST', `/status-pages/${page}/link`)).token;
    expect((await open(token)).status).toBe(404);
    expect((await open(second)).status).toBe(200);
    await dana('DELETE', `/status-pages/${page}/link`);
    expect((await open(second)).status).toBe(404);
  });

  it('are changed and deleted by designers and administrators', async () => {
    const p = await dana('PUT', `/status-pages/${page}`, {
      title: 'Plant services',
      serviceIds: [svc],
      showVendorIssues: false,
      notice: '',
      noticeLevel: 'info',
    });
    expect(p.serviceIds).toEqual([svc]);
    expect((await olivia('GET', `/status-pages/${page}/view`)).services[0].vendorIssues).toEqual([]);
    await expect(olivia('DELETE', `/status-pages/${page}`)).rejects.toThrow(/403/);
    await dana('DELETE', `/status-pages/${page}`);
    await expect(olivia('GET', `/status-pages/${page}/view`)).rejects.toThrow(/404/);
  });
});
