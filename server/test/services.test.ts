import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

let s: TestServer;
const PW = 'Demo-password-1';
let dana: Client, olivia: Client, adam: Client, vera: Client;
const status = (p: Promise<unknown>) => p.then(() => 200, (e: { status: number }) => e.status);

const SERVICE = {
  name: 'Plant data platform',
  description: '## Purpose\n\nCollects machine data.',
  contacts: [
    { role: 'business', email: 'erika@example.com', name: 'Erika' },
    { role: 'it', email: 'ops@example.com' },
  ],
  owners: ['team:Service Desk'],
  criticality: 'high',
  cmdb: { system: 'ServiceNow', id: 'CI0012345', url: 'https://example.service-now.com/nav_to.do?uri=cmdb_ci.do?sys_id=1' },
  tags: ['Plant', 'data'],
};

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [dana, olivia, adam, vera] = await Promise.all(['dana', 'olivia', 'adam', 'vera'].map((u) => s.as(u, PW)));
});
afterAll(async () => {
  await s?.app.close();
});

describe('service catalogue', () => {
  let svc: any;
  it('designers and administrators create services; everyone reads them', async () => {
    expect(await status(olivia('POST', '/services', SERVICE))).toBe(403);
    expect(await status(vera('POST', '/services', SERVICE))).toBe(403);
    expect(await status(adam('POST', '/services', SERVICE))).toBe(403);
    svc = await dana('POST', '/services', SERVICE);
    expect(svc).toMatchObject({ name: SERVICE.name, criticality: 'high', owners: ['team:service desk'], tags: ['data', 'plant'], archived: false, canEdit: true });
    expect(svc.cmdb).toEqual(SERVICE.cmdb);
    expect(svc.contacts).toHaveLength(2);
    expect((await vera('GET', '/services')).map((x: any) => x.id)).toContain(svc.id);
    expect((await vera('GET', `/services/${svc.id}`)).canEdit).toBe(false);
    expect(await status(dana('POST', '/services', SERVICE))).toBe(409); // same name
    expect((await s.api('GET', `/audit?entityType=service&entityId=${svc.id}`))[0].action).toBe('service.created');
  });

  it('validates input', async () => {
    const bad = [
      { ...SERVICE, name: '' },
      { ...SERVICE, name: 'x1', contacts: [{ role: 'business', email: 'not-an-email' }] },
      { ...SERVICE, name: 'x2', contacts: [{ role: 'boss', email: 'a@example.com' }] },
      { ...SERVICE, name: 'x3', criticality: 'extreme' },
      { ...SERVICE, name: 'x4', cmdb: { system: 'X', id: '1', url: 'javascript:alert(1)' } },
      { ...SERVICE, name: 'x5', owners: ['dana'] },
      { ...SERVICE, name: 'x6', extra: true },
    ];
    for (const b of bad) expect(await status(dana('POST', '/services', b)), JSON.stringify(b)).toBe(400);
  });

  it('owners named on the service may edit it', async () => {
    // olivia is in the demo team "Service Desk", named as owner
    expect((await olivia('GET', `/services/${svc.id}`)).canEdit).toBe(true);
    await dana('PUT', `/services/${svc.id}`, { ...SERVICE, owners: [] });
    expect(await status(olivia('PUT', `/services/${svc.id}`, { ...SERVICE, description: 'x' }))).toBe(403);
    await dana('PUT', `/services/${svc.id}`, { ...SERVICE, owners: ['user:olivia'] });
    const upd = await olivia('PUT', `/services/${svc.id}`, { ...SERVICE, owners: ['user:olivia'], criticality: null, cmdb: null });
    expect(upd).toMatchObject({ criticality: null, cmdb: null, canEdit: true });
    const audit = await s.api('GET', `/audit?entityType=service&entityId=${svc.id}&action=service.updated`);
    expect(audit[0].summary).toContain('criticality');
  });

  it('links services to platforms, monitors and records, with backlinks both ways', async () => {
    const platform = (await s.api('GET', '/platforms'))[0];
    const monitor = (await s.api('GET', '/monitors'))[0];
    const l1 = await dana('POST', `/services/${svc.id}/links`, { kind: 'platform', id: platform.id, note: 'runs on' });
    expect(l1).toMatchObject({ kind: 'platform', label: platform.name, visible: true });
    await dana('POST', `/services/${svc.id}/links`, { kind: 'monitor', id: monitor.id });
    await dana('POST', `/services/${svc.id}/links`, { url: 'https://wiki.example.com/plant-data', label: 'Runbook' });
    expect(await status(vera('POST', `/services/${svc.id}/links`, { url: 'https://example.com' }))).toBe(403);
    expect(await status(dana('POST', `/services/${svc.id}/links`, { url: 'file:///etc/passwd' }))).toBe(400);
    // a record that names the service as affected
    const rec = await dana('POST', '/records', { type: 'CR', title: 'Upgrade the plant data platform' });
    await dana('POST', `/records/${rec.id}/links`, { kind: 'service', id: svc.id, note: 'affected' });
    await dana('POST', `/services/${svc.id}/links`, { kind: 'record', id: rec.id });
    const detail = await vera('GET', `/services/${svc.id}`);
    expect(detail.links.map((l: any) => l.kind)).toEqual(['platform', 'monitor', null, 'record']);
    expect(detail.backlinks).toEqual([expect.objectContaining({ kind: 'record', id: rec.id, note: 'affected', path: `/records/${rec.id}` })]);
    const r = await vera('GET', `/records/${rec.id}`);
    expect(r.links[0]).toMatchObject({ kind: 'service', targetId: svc.id, label: SERVICE.name, path: `/services/${svc.id}` });
    expect(r.backlinks).toEqual([expect.objectContaining({ kind: 'service', id: svc.id, label: SERVICE.name })]);
    expect((await vera('GET', `/backlinks?kind=platform&id=${platform.id}`)).map((b: any) => b.id)).toContain(svc.id);
    expect((await vera('GET', '/services')).find((x: any) => x.id === svc.id).linkCount).toBe(4);
    // the link picker finds services
    expect((await dana('GET', '/link-targets?kind=service&q=plant')).map((t: any) => t.id)).toContain(svc.id);
    await dana('DELETE', `/services/${svc.id}/links/${l1.id}`);
    expect((await vera('GET', `/services/${svc.id}`)).links).toHaveLength(3);
    expect(await status(dana('DELETE', `/services/${svc.id}/links/lnk_nope`))).toBe(404);
  });

  it('archives instead of deleting', async () => {
    expect(await status(vera('POST', `/services/${svc.id}/archive`, { archived: true }))).toBe(403);
    expect((await dana('POST', `/services/${svc.id}/archive`, { archived: true })).archived).toBe(true);
    expect((await vera('GET', '/services')).map((x: any) => x.id)).not.toContain(svc.id);
    expect((await vera('GET', '/services?archived=1')).map((x: any) => x.id)).toContain(svc.id);
    expect((await dana('GET', '/link-targets?kind=service&q=plant')).map((t: any) => t.id)).not.toContain(svc.id);
    // a new service may reuse the name of an archived one; restoring then needs a rename
    const again = await dana('POST', '/services', SERVICE);
    expect(await status(dana('POST', `/services/${svc.id}/archive`, { archived: false }))).toBe(409);
    await dana('POST', `/services/${again.id}/archive`, { archived: true });
    expect((await dana('POST', `/services/${svc.id}/archive`, { archived: false })).archived).toBe(false);
    const audit = await s.api('GET', `/audit?entityType=service&entityId=${svc.id}`);
    expect(audit.map((a: any) => a.action)).toEqual(expect.arrayContaining(['service.archived', 'service.restored', 'service.link_added', 'service.link_removed']));
    expect(await status(vera('GET', '/services/svc_nope'))).toBe(404);
  });
});
