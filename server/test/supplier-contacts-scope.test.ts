import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Contacts with a scope (0.18.0, ADR 0031 part 6): company-wide or scoped to contracts, applications and systems; who
 * sees a scoped contact and who changes it; removing one's own item; the last item removes the contact; items that are
 * gone; the public shape without e-mail and phone.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Demo-password-1';
let dana: Client, olivia: Client, vera: Client, audrey: Client, bert: Client;
const refused = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { status: number; body: any }) => ({ status: e.status, code: (typeof e.body === 'string' ? JSON.parse(e.body) : e.body)?.code }),
  );

let supplier: string, shopContract: string, careContract: string, app: string, system: string, serviceShop: string;
const contacts = async (c: Client) => ((await c('GET', `/suppliers/${supplier}`)) as any).contacts as any[];
const names = async (c: Client) => (await contacts(c)).map((x) => x.name).sort();

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [dana, olivia, vera, audrey] = await Promise.all(['dana', 'olivia', 'vera', 'audrey'].map((u) => s.as(u, PW)));
  const users = await import('../src/auth/users.js');
  users.createUser({ username: 'bert', roles: ['operator'], password: 'Bert-password-123', mustChangePassword: false });
  bert = await s.as('bert', 'Bert-password-123');
  const shop = (await s.api('POST', '/teams', { name: 'Contact shop team', members: ['olivia'] })).id;
  const care = (await s.api('POST', '/teams', { name: 'Contact care team', members: ['bert'] })).id;
  const svcShop = (await s.api('POST', '/services', { name: 'Contact shop', owners: ['user:olivia'] })).id;
  serviceShop = svcShop;
  const svcCare = (await s.api('POST', '/services', { name: 'Contact care', owners: ['user:bert'] })).id;
  await s.api('PUT', `/owning-teams/service/${svcShop}`, { teamIds: [shop] });
  await s.api('PUT', `/owning-teams/service/${svcCare}`, { teamIds: [care] });
  supplier = (await dana('POST', '/suppliers', { name: 'Invented Contact Platform AG', owners: ['user:dana'] })).id;
  await olivia('POST', `/suppliers/${supplier}/contracts`, { title: 'Shop hosting', services: [{ serviceId: svcShop }] });
  await bert('POST', `/suppliers/${supplier}/contracts`, { title: 'Care licences', services: [{ serviceId: svcCare }] });
  const all = (await s.api('GET', `/suppliers/${supplier}`)).contracts;
  shopContract = all.find((c: any) => c.title === 'Shop hosting').id;
  careContract = all.find((c: any) => c.title === 'Care licences').id;
  // an application olivia owns (whole instance) and a system of the Care team
  app = (await s.api('POST', '/applications', { name: 'Contact shop app', owners: ['user:olivia'], supplierId: supplier })).id;
  system = (await s.api('POST', '/systems', { name: 'Contact care system', kind: 'server', owners: ['user:bert'] })).id;
  await s.api('PUT', `/owning-teams/system/${system}`, { teamIds: [care] });
}, 240_000);

describe('scoped contacts', () => {
  it('are added company-wide by the supplier’s editors, scoped by who may change every item', async () => {
    await dana('POST', `/suppliers/${supplier}/contacts`, { name: 'Company switchboard', role: 'support', email: 'desk@platform.example', phone: '+49 30 1' });
    // olivia owns the shop contract: she adds its account manager
    await olivia('POST', `/suppliers/${supplier}/contacts`, {
      name: 'Hosting account manager',
      role: 'accountManager',
      email: 'am-hosting@platform.example',
      scope: [{ kind: 'contract', id: shopContract }],
    });
    // but not a company-wide contact, nor one scoped to an item she may not see
    expect(await refused(olivia('POST', `/suppliers/${supplier}/contacts`, { name: 'x' }))).toEqual({ status: 403, code: 'FORBIDDEN' });
    expect(await refused(olivia('POST', `/suppliers/${supplier}/contacts`, { name: 'x', scope: [{ kind: 'contract', id: careContract }] }))).toEqual({
      status: 404,
      code: 'SUPPLIER_CONTACT_SCOPE_UNKNOWN',
    });
    await bert('POST', `/suppliers/${supplier}/contacts`, {
      name: 'Licence desk',
      role: 'support',
      scope: [
        { kind: 'contract', id: careContract },
        { kind: 'system', id: system },
      ],
    });
    // shared by both teams: scoped to the shop contract and the care system (an administrator adds it)
    await s.api('POST', `/suppliers/${supplier}/contacts`, {
      name: 'Security contact',
      role: 'security',
      scope: [
        { kind: 'contract', id: shopContract },
        { kind: 'system', id: system },
        { kind: 'application', id: app },
      ],
    });
  });

  it('are seen by who sees one of their items (and the supplier), administrators and auditors – others do not know they exist', async () => {
    expect(await names(olivia)).toEqual(['Company switchboard', 'Hosting account manager', 'Security contact']);
    expect(await names(bert)).toEqual(['Company switchboard', 'Licence desk', 'Security contact']);
    // vera sees the application (whole instance), not the contracts or the system
    expect(await names(vera)).toEqual(['Company switchboard', 'Security contact']);
    expect(await names(audrey)).toEqual(['Company switchboard', 'Hosting account manager', 'Licence desk', 'Security contact']);
    const sec = (await contacts(olivia)).find((x) => x.name === 'Security contact');
    // company-wide first; olivia may not change every item: no count of the hidden ones
    expect((await contacts(olivia))[0]).toMatchObject({ name: 'Company switchboard', companyWide: true, scope: [] });
    expect(sec).toMatchObject({ companyWide: false, canEdit: false, hiddenScope: 0 });
    expect(sec.scope.map((x: any) => x.kind).sort()).toEqual(['application', 'contract']);
    expect(sec.scope.find((x: any) => x.kind === 'contract')).toMatchObject({ id: shopContract, name: 'Shop hosting', canRemove: true });
    // the supplier's editor sees the hidden items counted
    const asDana = (await contacts(dana)).find((x) => x.name === 'Security contact');
    expect(asDana).toMatchObject({ canEdit: true, hiddenScope: 2 });
    // the item pages
    expect((await olivia('GET', `/suppliers/${supplier}/contracts/${shopContract}`)).contacts.map((x: any) => x.name).sort()).toEqual([
      'Hosting account manager',
      'Security contact',
    ]);
    const onSystem = await bert('GET', `/suppliers/scoped-contacts?kind=system&id=${system}`);
    expect(onSystem[0].contacts.map((x: any) => x.name).sort()).toEqual(['Licence desk', 'Security contact']);
    expect(await olivia('GET', `/suppliers/scoped-contacts?kind=system&id=${system}`)).toEqual([]);
  });

  it('are changed by who may change the supplier or every item; others take only their own items off', async () => {
    const sec = (await contacts(olivia)).find((x) => x.name === 'Security contact');
    expect(
      await refused(
        olivia('PUT', `/suppliers/${supplier}/contacts/${sec.id}`, { name: 'Security contact', role: 'other', scope: [{ kind: 'application', id: app }] }),
      ),
    ).toEqual({ status: 403, code: 'FORBIDDEN' });
    // "Remove from my contract": only her item, nothing else
    await olivia('PUT', `/suppliers/${supplier}/contacts/${sec.id}`, { name: 'Security contact', role: 'security', scope: [{ kind: 'application', id: app }] });
    expect(await names(olivia)).toContain('Security contact');
    const asDana = (await contacts(dana)).find((x) => x.name === 'Security contact');
    // the system she may not see stayed
    expect(asDana.hiddenScope).toBe(1);
    expect(asDana.scope.map((x: any) => x.id)).toEqual([app]);
    // who may change every item changes it all
    const am = (await contacts(olivia)).find((x) => x.name === 'Hosting account manager');
    expect(am.canEdit).toBe(true);
    await olivia('PUT', `/suppliers/${supplier}/contacts/${am.id}`, {
      name: 'Hosting account manager',
      role: 'accountManager',
      phone: '+49 30 2',
      scope: [{ kind: 'contract', id: shopContract }],
    });
    // the audit names the scope, never the e-mail or phone values
    const entries = await s.api('GET', `/audit?entityType=supplier&entityId=${supplier}&limit=100`);
    const changed = entries.find((a: any) => a.action === 'supplier.contact_changed' && a.details.contactId === sec.id);
    expect(changed.details.scope.after).toEqual(expect.arrayContaining([{ kind: 'application', id: app }]));
    expect(JSON.stringify(entries)).not.toContain('am-hosting@');
    expect(JSON.stringify(entries)).not.toContain('+49 30');
  });

  it('never becomes company-wide by losing its scope: the last item removes the contact', async () => {
    const am = (await contacts(olivia)).find((x) => x.name === 'Hosting account manager');
    expect(
      await refused(olivia('PUT', `/suppliers/${supplier}/contacts/${am.id}`, { name: 'Hosting account manager', role: 'accountManager', scope: [] })),
    ).toEqual({
      status: 409,
      code: 'SUPPLIER_CONTACT_LAST_ITEM',
    });
    await olivia('DELETE', `/suppliers/${supplier}/contacts/${am.id}`);
    expect(await names(audrey)).not.toContain('Hosting account manager');
  });

  it('shows a contact whose items are all gone only to the supplier’s owners, administrators and auditors', async () => {
    await bert('POST', `/suppliers/${supplier}/contacts`, { name: 'Care-only contact', scope: [{ kind: 'contract', id: careContract }] });
    await bert('DELETE', `/suppliers/${supplier}/contracts/${careContract}`);
    expect(await names(bert)).not.toContain('Care-only contact');
    expect(await names(vera)).not.toContain('Care-only contact');
    const asDana = (await contacts(dana)).find((x) => x.name === 'Care-only contact');
    expect(asDana).toMatchObject({ unused: true, companyWide: false, scope: [] });
    expect((await contacts(audrey)).find((x) => x.name === 'Care-only contact')).toMatchObject({ unused: true });
  });

  it('gives the public API name, role, note and the visible scope – never e-mail or phone; tokens get the same', async () => {
    const { token } = await vera('POST', '/me/tokens', { name: 'contacts read', scope: 'read' });
    const res = await fetch(`${s.base}/api/v1/suppliers/${supplier}`, { headers: { authorization: `Bearer ${token}` } });
    const body = (await res.json()) as any;
    expect(body.contacts.map((c: any) => c.name).sort()).toEqual(['Company switchboard', 'Security contact']);
    for (const c of body.contacts) expect(Object.keys(c).sort()).toEqual(['id', 'name', 'note', 'role', 'scope']);
    expect(body.contacts.find((c: any) => c.name === 'Security contact').scope).toEqual([{ kind: 'application', id: app, name: 'Contact shop app' }]);
    expect(JSON.stringify(body)).not.toContain('@platform.example');
    const internal = await fetch(`${s.base}/api/suppliers/scoped-contacts?kind=application&id=${app}`, { headers: { authorization: `Bearer ${token}` } });
    expect(JSON.stringify(await internal.json())).not.toContain('@');
  });

  it('never gives e-mail or phone to an API token on any supplier or contract route (ADR 0029 decided 8)', async () => {
    await s.api('POST', `/suppliers/${supplier}/contacts`, {
      name: 'Crawled contact',
      email: 'crawl@platform.example',
      phone: '+49 30 777',
      scope: [{ kind: 'contract', id: shopContract }],
    });
    await s.api('POST', `/suppliers/${supplier}/contacts`, { name: 'Crawled desk', email: 'crawl-desk@platform.example', phone: '+49 30 778' });
    // an administrator's read token sees every contact: the widest view a token can have
    const { token } = await s.api('POST', '/me/tokens', { name: 'crawl read', scope: 'read' });
    const { routeAccess } = await import('../src/app.js');
    const routes = Object.keys(routeAccess(s.app))
      .filter((k) => k.startsWith('GET '))
      .map((k) => k.slice(4))
      .filter((u) => /^\/api\/(v1\/)?suppliers|^\/api\/(v1\/)?services\/[^/]+\/contracts$/.test(u));
    const fill = (u: string) => {
      const service = u.startsWith('/api/services/') || u.startsWith('/api/v1/services/');
      return (
        u
          .replace(/:contractId/g, shopContract)
          .replace(/:(supplierId|serviceId|id)/g, service ? serviceShop : supplier)
          .replace(/:key/g, 'none') + (u.endsWith('/scoped-contacts') ? `?kind=application&id=${app}` : '')
      );
    };
    const seen: string[] = [];
    const problems: string[] = [];
    for (const u of routes) {
      const res = await fetch(s.base + fill(u), { headers: { authorization: `Bearer ${token}` } });
      const text = await res.text();
      if (res.status === 200) seen.push(u);
      if (/crawl(-desk)?@|\+49 30 77[78]/.test(text)) problems.push(`${u}: ${res.status}`);
      // the token still gets the contacts themselves (name and role)
      if (u === '/api/suppliers/:id/contracts/:contractId') expect(text).toContain('Crawled contact');
    }
    expect(problems).toEqual([]);
    // the routes that return contacts were read, not refused
    expect(seen).toEqual(
      expect.arrayContaining([
        '/api/suppliers/:id',
        '/api/suppliers/:id/contracts/:contractId',
        '/api/suppliers/scoped-contacts',
        '/api/services/:id/contracts',
        '/api/v1/suppliers/:supplierId',
      ]),
    );
  });

  it('keeps the limits', async () => {
    expect(
      await refused(
        dana('POST', `/suppliers/${supplier}/contacts`, { name: 'x', scope: Array.from({ length: 21 }, () => ({ kind: 'application', id: app })) }),
      ),
    ).toMatchObject({ status: 400 });
  });
});
