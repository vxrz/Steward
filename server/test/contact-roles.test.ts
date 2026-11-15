import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Contact roles, inherited contacts, deputy and until (0.26.0, ADR 0039 parts 1–3, docs/CONTACTS.md):
 *  - the role catalogue: the built-in roles of before (keys and kinds unchanged) and the new ones of applications and
 *    systems; administrators make, change, switch off and delete own roles – built-in ones are relabelled and switched
 *    off, never deleted or re-keyed; audited (contact.role_*); who else reads it gets no usage counts;
 *  - every validator reads the catalogue: a role of another kind or a free text is refused with a hint, a role switched
 *    off takes no new link but keeps the old ones, cardinality one, deputies of the same role and until dates;
 *  - applications and systems are link kinds with the catalogue's visibility and edit rules, /api/v1 by name and role;
 *    an application shows its services' contacts read only;
 *  - a sub-domain and a data product show their domain's contacts per role, never copied, only from domains the reader
 *    may see (team scope: nothing is told about a hidden domain), counting for expected roles (the scorecard notes it);
 *  - plant sites' free-text roles become own roles at the upgrade (convertPlantSiteRoles), idempotent and audited, and
 *    the plant registry shows and takes the same texts.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Own-password-123';
let s: TestServer;
let dana: Client; // designer, member of Finance
let dave: Client; // designer, no team
let vic: Client; // viewer, no team
let token = '';
const ids: Record<string, string> = {};

type Svc = typeof import('../src/contacts/service.js');
let svc: Svc;
let ctx: typeof import('../src/auth/context.js');
let users: typeof import('../src/auth/users.js');

const refusal = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> => {
  try {
    await p;
    return { status: 200 };
  } catch (e) {
    const x = e as { status: number; body?: { code?: string } };
    return { status: x.status, code: x.body?.code };
  }
};
const thrown = (fn: () => unknown): { status?: number; code?: string } => {
  try {
    fn();
    return {};
  } catch (e) {
    return { status: (e as { statusCode?: number }).statusCode, code: (e as { code?: string }).code };
  }
};
const as = <T>(name: string, fn: () => T): T => ctx.runAs(users.toAuthUser(users.findUserByName(name)!), fn);
type Link = { role: string; contact: { id: string; name: string }; deputyOf?: string; until?: string; from?: { id: string; name: string } };
const lines = (links: Link[]) => links.map((l) => `${l.role}: ${l.contact.name}${l.from ? ` (${l.from.name})` : ''}`).sort();
const v1 = async (url: string) => {
  const res = await fetch(`${s.base}/api/v1${url}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw Object.assign(new Error(`${url}: ${res.status}`), { status: res.status });
  return res.json() as Promise<any>;
};

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  svc = await import('../src/contacts/service.js');
  ctx = await import('../src/auth/context.js');
  users = await import('../src/auth/users.js');
  for (const [username, roles] of [
    ['dana', ['designer']],
    ['dave', ['designer']],
    ['vic', ['viewer']],
  ] as const)
    users.createUser({ username, roles: [...roles], password: PW, mustChangePassword: false, email: `${username}@example.com` });
  [dana, dave, vic] = await Promise.all(['dana', 'dave', 'vic'].map((u) => s.as(u, PW)));
  token = (await s.api('POST', '/me/tokens', { name: 'Invented read token', scope: 'read' })).token;
  ids.team = (await s.api('POST', '/teams', { name: 'Finance', members: ['dana'] })).id;
  for (const [key, name] of [
    ['ann', 'Invented Ann'],
    ['ben', 'Invented Ben'],
    ['cara', 'Invented Cara'],
  ] as const)
    ids[key] = (await s.api('POST', '/contacts', { name, email: `${key}@invented.example` })).id;
  // named on a service of the whole instance: everyone working in Steward sees them
  ids.open = (await s.api('POST', '/services', { name: 'Invented open service', owners: [] })).id;
  ctx.runAs(null, () =>
    svc.setLinks('service', ids.open!, [
      { role: 'business', contactId: ids.ann! },
      { role: 'business', contactId: ids.ben! },
      { role: 'it', contactId: ids.cara! },
    ]),
  );
}, 120_000);

describe('the role catalogue', () => {
  it('starts with the built-in roles of before, keys and kinds unchanged, and those of applications and systems', async () => {
    const roles = await vic('GET', '/contact-roles');
    const kindsOf = (key: string) => roles.find((r: { key: string }) => r.key === key)?.kinds;
    expect(kindsOf('business')).toEqual(['service']);
    expect(kindsOf('accountManager')).toEqual(['supplier']);
    expect(kindsOf('productOwner')).toEqual(['data_product']);
    expect(kindsOf('domainOwner')).toEqual(['data_domain']);
    expect(kindsOf('consumerContact')).toEqual(['data_consumer']);
    expect(kindsOf('businessOwner')).toEqual(['application', 'system']);
    expect(kindsOf('applicationManager')).toEqual(['application']);
    expect(kindsOf('systemManager')).toEqual(['system']);
    expect(roles.every((r: { builtIn: boolean; active: boolean }) => r.builtIn && r.active)).toBe(true);
    // a reader who is not an administrator is not told how often a role is used
    expect(roles.some((r: { usage?: unknown }) => r.usage)).toBe(false);
    expect(typeof (await s.api('GET', '/contact-roles'))[0].usage).toBe('object');
  });

  it('administrators make own roles; nobody else may', async () => {
    expect(await refusal(dana('POST', '/contact-roles', { labels: { en: 'Domain architect' }, kinds: ['data_domain'] }))).toMatchObject({ status: 403 });
    const arch = await s.api('POST', '/contact-roles', {
      labels: { en: 'Domain architect', de: 'Domänenarchitekt' },
      description: 'Invented: keeps the domain’s data model',
      kinds: ['data_domain', 'data_product'],
    });
    expect(arch).toMatchObject({ key: 'domainArchitect', builtIn: false, active: true, cardinality: 'many', expected: false });
    // the key is unique (built-in ones too), letter case aside
    expect(await refusal(s.api('POST', '/contact-roles', { key: 'productowner', labels: { en: 'X' }, kinds: ['service'] }))).toEqual({
      status: 409,
      code: 'CONTACT_ROLE_TAKEN',
    });
    // two roles of one kind never share a label (a role text of a file would be ambiguous)
    expect(await refusal(s.api('POST', '/contact-roles', { labels: { en: 'product OWNER' }, kinds: ['data_product'] }))).toEqual({
      status: 409,
      code: 'CONTACT_ROLE_LABEL_TAKEN',
    });
    expect(await refusal(s.api('POST', '/contact-roles', { labels: { en: 'Nothing' }, kinds: [] }))).toEqual({ status: 400, code: 'CONTACT_ROLE_KINDS' });
    const lead = await s.api('POST', '/contact-roles', { labels: { en: 'Technical lead' }, kinds: ['application', 'data_product'], cardinality: 'one' });
    expect(lead.key).toBe('technicalLead');
    const audit = await s.api('GET', '/audit?action=contact.role_created&limit=5');
    expect(audit.map((e: { entityId: string }) => e.entityId)).toEqual(expect.arrayContaining(['domainArchitect', 'technicalLead']));
  });

  it('built-in roles are relabelled and switched off per kind, never deleted, re-keyed or given other kinds', async () => {
    const body = { labels: { en: 'Business owner', de: 'Fachlich verantwortlich' }, kinds: ['application'], cardinality: 'many' };
    const r = await s.api('PUT', '/contact-roles/businessOwner', body);
    expect(r).toMatchObject({ key: 'businessOwner', builtIn: true, kinds: ['application'], builtInKinds: ['application', 'system'] });
    expect(await refusal(s.api('PUT', '/contact-roles/businessOwner', { ...body, kinds: ['application', 'service'] }))).toEqual({
      status: 409,
      code: 'CONTACT_ROLE_BUILT_IN',
    });
    expect(await refusal(s.api('PUT', '/contact-roles/businessOwner', { ...body, key: 'owner' }))).toMatchObject({ code: 'CONTACT_ROLE_BUILT_IN' });
    expect(await refusal(s.api('DELETE', '/contact-roles/businessOwner'))).toEqual({ status: 409, code: 'CONTACT_ROLE_BUILT_IN' });
    expect(await refusal(dana('PUT', '/contact-roles/businessOwner', body))).toMatchObject({ status: 403 });
    // a system cannot name a business owner now; applications still can
    expect(thrown(() => svc.setLinks('system', 'sys_x', [{ role: 'businessOwner', contactId: ids.ann }]))).toMatchObject({ code: 'CONTACT_ROLE_OFF' });
    await s.api('PUT', '/contact-roles/businessOwner', { ...body, kinds: ['application', 'system'] });
    // relabelled: the label shows where the role is named
    const re = await s.api('PUT', '/contact-roles/business', { labels: { en: 'Service owner', de: 'Serviceverantwortliche' }, kinds: ['service'] });
    expect(re.labels).toEqual({ en: 'Service owner', de: 'Serviceverantwortliche' });
    const updated = (await s.api('GET', '/audit?action=contact.role_updated&limit=1'))[0];
    expect(updated).toMatchObject({ entityId: 'business', details: { changed: ['labels'] } });
    await s.api('PUT', '/contact-roles/business', { labels: { en: 'Business owner', de: 'Fachlich verantwortlich' }, kinds: ['service'] });
  });

  it('a role in use is switched off, not deleted; an unused own role is deleted', async () => {
    const tmp = await s.api('POST', '/contact-roles', { labels: { en: 'Invented temporary' }, kinds: ['service'] });
    const service = (await s.api('POST', '/services', { name: 'Invented role service', owners: [] })).id;
    svc.setLinks('service', service, [{ role: tmp.key, contactId: ids.ann }]);
    const listed = (await s.api('GET', '/contact-roles')).find((r: { key: string }) => r.key === tmp.key);
    expect(listed.usage).toEqual({ service: 1 });
    expect(await refusal(s.api('DELETE', `/contact-roles/${tmp.key}`))).toEqual({ status: 409, code: 'CONTACT_ROLE_IN_USE' });
    await s.api('PUT', `/contact-roles/${tmp.key}`, { labels: { en: 'Invented temporary' }, kinds: ['service'], active: false });
    // switched off: no new link, the old one stays (and is written back unchanged)
    expect(thrown(() => svc.setLinks('service', service, [{ role: tmp.key, contactId: ids.ben }]))).toMatchObject({ code: 'CONTACT_ROLE_OFF' });
    const svcB = (await s.api('POST', '/services', { name: 'Invented other service', owners: [] })).id;
    expect(thrown(() => svc.setLinks('service', svcB, [{ role: tmp.key, contactId: ids.ann }]))).toMatchObject({ code: 'CONTACT_ROLE_OFF' });
    svc.setLinks('service', service, [{ role: tmp.key, contactId: ids.ann }]);
    expect(
      svc
        .linksOf('service', [service])
        .get(service)!
        .map((l) => l.role),
    ).toEqual([tmp.key]);
    svc.removeItemLinks('service', service);
    await s.api('DELETE', `/contact-roles/${tmp.key}`);
    expect((await s.api('GET', '/contact-roles')).some((r: { key: string }) => r.key === tmp.key)).toBe(false);
    expect((await s.api('GET', '/audit?action=contact.role_deleted&limit=1'))[0]).toMatchObject({ entityId: tmp.key });
    expect(await refusal(s.api('DELETE', '/contact-roles/nothingHere'))).toEqual({ status: 404, code: 'CONTACT_ROLE_NOT_FOUND' });
  });

  it('every validator reads the catalogue: roles of another kind and free texts are refused with a hint', async () => {
    const service = (await s.api('POST', '/services', { name: 'Invented validated service', owners: [] })).id;
    expect(thrown(() => svc.setLinks('service', service, [{ role: 'productOwner', contactId: ids.ann }]))).toMatchObject({
      status: 400,
      code: 'CONTACT_ROLE_UNKNOWN',
    });
    expect(thrown(() => svc.setLinks('service', service, [{ role: 'Shift lead', contactId: ids.ann }]))).toMatchObject({ code: 'CONTACT_ROLE_UNKNOWN' });
    // the service API of before (role, e-mail, name) too
    expect(
      await refusal(
        s.api('PUT', `/services/${service}`, {
          name: 'Invented validated service',
          owners: [],
          contacts: [{ role: 'it', email: 'ann@invented.example', name: 'Invented Ann' }],
        }),
      ),
    ).toEqual({ status: 200 });
  });
});

describe('cardinality, deputy and until', () => {
  it('a role of one contact takes one current contact; deputies and ended links aside', async () => {
    const app = (await s.api('POST', '/applications', { name: 'Invented one app', owners: [] })).id;
    const put = (contacts: unknown[]) => dana('PUT', `/applications/${app}/contacts`, { contacts });
    expect(
      await refusal(
        put([
          { role: 'technicalLead', contactId: ids.ann },
          { role: 'technicalLead', contactId: ids.ben },
        ]),
      ),
    ).toEqual({
      status: 400,
      code: 'CONTACT_ROLE_ONE',
    });
    // Ben stands in for Ann; Cara's link ended yesterday
    const r = await put([
      { role: 'technicalLead', contactId: ids.ann, until: '2999-12-31' },
      { role: 'technicalLead', contactId: ids.ben, deputyOf: ids.ann },
      { role: 'technicalLead', contactId: ids.cara, until: '2000-01-01' },
    ]);
    expect(r.contacts).toEqual([
      expect.objectContaining({ role: 'technicalLead', contact: expect.objectContaining({ id: ids.ann }), until: '2999-12-31' }),
      expect.objectContaining({ role: 'technicalLead', contact: expect.objectContaining({ id: ids.ben }), deputyOf: ids.ann }),
      expect.objectContaining({ role: 'technicalLead', contact: expect.objectContaining({ id: ids.cara }), until: '2000-01-01' }),
    ]);
    expect(r.contacts[0].deputyOf).toBeUndefined();
    // a deputy of a contact in another role, of itself, or of another deputy is refused
    expect(
      await refusal(
        put([
          { role: 'technicalLead', contactId: ids.ann },
          { role: 'businessOwner', contactId: ids.ben, deputyOf: ids.ann },
        ]),
      ),
    ).toEqual({
      status: 400,
      code: 'CONTACT_DEPUTY_INVALID',
    });
    expect(await refusal(put([{ role: 'businessOwner', contactId: ids.ben, deputyOf: ids.ben }]))).toMatchObject({ code: 'CONTACT_DEPUTY_INVALID' });
    expect(
      await refusal(
        put([
          { role: 'businessOwner', contactId: ids.ann },
          { role: 'businessOwner', contactId: ids.ben, deputyOf: ids.ann },
          { role: 'businessOwner', contactId: ids.cara, deputyOf: ids.ben },
        ]),
      ),
    ).toMatchObject({ code: 'CONTACT_DEPUTY_INVALID' });
    // a client that leaves deputy and until out keeps them
    const kept = await put([
      { role: 'technicalLead', contactId: ids.ann },
      { role: 'technicalLead', contactId: ids.ben },
      { role: 'technicalLead', contactId: ids.cara },
    ]);
    expect(kept.contacts.map((l: Link) => [l.deputyOf ?? null, l.until ?? null])).toEqual([
      [null, '2999-12-31'],
      [ids.ann, null],
      [null, '2000-01-01'],
    ]);
    // the audit entry says which links changed
    await put([
      { role: 'technicalLead', contactId: ids.ann, until: null },
      { role: 'technicalLead', contactId: ids.ben, deputyOf: ids.ann },
      { role: 'technicalLead', contactId: ids.cara },
    ]);
    const entry = (await s.api('GET', '/audit?action=application.updated&limit=1'))[0];
    expect(entry.details.contacts.updated).toEqual(['technicalLead: Invented Ann']);
    // /api/v1: by name and role, with the deputy's principal by name and until
    const pub = await v1(`/applications/${app}`);
    expect(pub.contacts).toEqual([
      { role: 'technicalLead', roleLabel: 'Technical lead', name: 'Invented Ann' },
      { role: 'technicalLead', roleLabel: 'Technical lead', name: 'Invented Ben', deputyOf: 'Invented Ann' },
      { role: 'technicalLead', roleLabel: 'Technical lead', name: 'Invented Cara', until: '2000-01-01' },
    ]);
    ids.app = app;
  });

  it('Replace with… moves deputy and until with the link; Erase leaves the deputy standing in for nobody', async () => {
    const dora = (await s.api('POST', '/contacts', { name: 'Invented Dora', email: 'dora@invented.example' })).id;
    await s.api('POST', `/contacts/${ids.ann}/replace`, { targetId: dora });
    const after = (await s.api('GET', `/applications/${ids.app}`)).contacts as Link[];
    expect(after.find((l) => l.contact.id === ids.ben)!.deputyOf).toBe(dora);
    await s.api('POST', `/contacts/${dora}/replace`, { targetId: ids.ann });
    const erasable = (await s.api('POST', '/contacts', { name: 'Invented Eve' })).id;
    await s.api('PUT', `/applications/${ids.app}/contacts`, {
      contacts: [
        { role: 'businessOwner', contactId: erasable },
        { role: 'businessOwner', contactId: ids.cara, deputyOf: erasable },
      ],
    });
    await s.api('DELETE', `/contacts/${erasable}`);
    const left = (await s.api('GET', `/applications/${ids.app}`)).contacts as Link[];
    expect(left.map((l) => [l.role, l.contact.name, l.deputyOf ?? null])).toEqual([['businessOwner', 'Invented Cara', null]]);
  });
});

describe('applications and systems', () => {
  it('follow the catalogue’s visibility and edit rules; their owners are unchanged', async () => {
    const own = (await dana('POST', '/applications', { name: 'Invented finance app', owners: [] })).id;
    await s.api('PUT', `/owning-teams/application/${own}`, { teamIds: [ids.team] });
    await dana('PUT', `/applications/${own}/contacts`, { contacts: [{ role: 'applicationManager', contactId: ids.cara }] });
    expect((await dana('GET', `/applications/${own}`)).owners).toEqual([]);
    // dave may not change it, vic not at all; nobody outside the team is told about the link
    expect(await refusal(dave('PUT', `/applications/${own}/contacts`, { contacts: [] }))).toMatchObject({ status: 404 });
    expect(await refusal(vic('PUT', `/applications/${ids.app}/contacts`, { contacts: [] }))).toMatchObject({ status: 403 });
    const forDave = await dave('GET', `/contacts/${ids.cara}`);
    expect(JSON.stringify(forDave.links)).not.toContain(own);
    expect(forDave.hiddenLinks).toBeGreaterThan(0);
    const forDana = await dana('GET', `/contacts/${ids.cara}`);
    expect(forDana.links).toEqual(
      expect.arrayContaining([
        { kind: 'application', itemId: own, itemName: 'Invented finance app', role: 'applicationManager', href: `/applications/${own}` },
      ]),
    );
    const sys = (await dana('POST', '/systems', { name: 'Invented system', kind: 'server' })).id;
    const d = await dana('PUT', `/systems/${sys}/contacts`, { contacts: [{ role: 'systemManager', contactId: ids.ben }] });
    expect(lines(d.contacts)).toEqual(['systemManager: Invented Ben']);
    expect((await v1(`/systems/${sys}`)).contacts).toEqual([{ role: 'systemManager', roleLabel: 'System manager', name: 'Invented Ben' }]);
    expect((await v1('/systems')).items.find((x: { id: string }) => x.id === sys).contacts).toEqual([
      { role: 'systemManager', roleLabel: 'System manager', name: 'Invented Ben' },
    ]);
    // a role of applications is not one of systems
    expect(await refusal(dana('PUT', `/systems/${sys}/contacts`, { contacts: [{ role: 'applicationManager', contactId: ids.ben }] }))).toMatchObject({
      code: 'CONTACT_ROLE_UNKNOWN',
    });
  });

  it('an application shows the contacts of the services it belongs to, read only, never inherited', async () => {
    const service = (await s.api('POST', '/services', { name: 'Invented service of the app', owners: [] })).id;
    await s.api('PUT', `/services/${service}`, {
      name: 'Invented service of the app',
      owners: [],
      contacts: [{ role: 'business', email: 'ann@invented.example', name: 'Invented Ann' }],
    });
    await s.api('PUT', `/services/${service}/applications/${ids.app}`, { role: 'primary' });
    const hidden = (await s.api('POST', '/services', { name: 'Invented hidden service', owners: [] })).id;
    await s.api('PUT', `/owning-teams/service/${hidden}`, { teamIds: [ids.team] });
    await s.api('PUT', `/services/${hidden}`, {
      name: 'Invented hidden service',
      owners: [],
      contacts: [{ role: 'it', email: 'ben@invented.example', name: 'Invented Ben' }],
    });
    await s.api('PUT', `/services/${hidden}/applications/${ids.app}`, { role: 'primary' });
    const forDave = await dave('GET', `/applications/${ids.app}`);
    expect(forDave.serviceContacts.map((x: { serviceName: string; contacts: Link[] }) => [x.serviceName, lines(x.contacts)])).toEqual([
      ['Invented service of the app', ['business: Invented Ann']],
    ]);
    expect(lines(forDave.contacts)).not.toContain('business: Invented Ann');
    const forDana = await dana('GET', `/applications/${ids.app}`);
    expect(forDana.serviceContacts.map((x: { serviceName: string }) => x.serviceName).sort()).toEqual([
      'Invented hidden service',
      'Invented service of the app',
    ]);
  });
});

describe('inherited along the domain hierarchy', () => {
  it('a sub-domain shows its parent’s contacts per role, a product its domain’s – never copied, only from domains the reader sees', async () => {
    await s.api('PUT', '/settings/modules/dataProducts', { enabled: true });
    const finance = await s.api('POST', '/data-domains', {
      key: 'inv-finance',
      name: 'Invented Finance',
      contacts: [
        { role: 'domainOwner', contactId: ids.ann },
        { role: 'domainArchitect', contactId: ids.ben },
      ],
    });
    const payments = await s.api('POST', '/data-domains', {
      key: 'inv-payments',
      name: 'Invented Payments',
      parentId: finance.id,
      contacts: [{ role: 'domainOwner', contactId: ids.cara }],
    });
    const product = await s.api('POST', '/data-products', { key: 'inv-ledger', name: 'Invented ledger', domainId: payments.id });
    ids.product = product.id;
    ids.finance = finance.id;
    const sub = await dave('GET', `/data-domains/${payments.id}`);
    expect(lines(sub.contacts)).toEqual(['domainOwner: Invented Cara']);
    expect(lines(sub.inheritedContacts)).toEqual(['domainArchitect: Invented Ben (Invented Finance)']);
    const p = await dave('GET', `/data-products/${product.id}`);
    expect(lines(p.inheritedContacts)).toEqual(['domainArchitect: Invented Ben (Invented Finance)', 'domainOwner: Invented Cara (Invented Payments)']);
    // the product names its own architect: the domain's goes
    await s.api('PUT', `/data-products/${product.id}`, {
      key: 'inv-ledger',
      name: 'Invented ledger',
      domainId: payments.id,
      contacts: [{ role: 'domainArchitect', contactId: ids.cara }],
    });
    expect(lines((await dave('GET', `/data-products/${product.id}`)).inheritedContacts)).toEqual(['domainOwner: Invented Cara (Invented Payments)']);
    // never copied: the product's own links are its own only
    expect(
      svc
        .linksOf('data_product', [product.id])
        .get(product.id)!
        .map((l) => l.role),
    ).toEqual(['domainArchitect']);
    await s.api('PUT', `/data-products/${product.id}`, { key: 'inv-ledger', name: 'Invented ledger', domainId: payments.id, contacts: [] });
    // Finance belongs to the team: dave sees Payments and the product, nothing of Finance – not even that there is any
    await s.api('PUT', `/owning-teams/data_domain/${finance.id}`, { teamIds: [ids.team] });
    const daveSub = await dave('GET', `/data-domains/${payments.id}`);
    expect(daveSub.inheritedContacts).toEqual([]);
    const daveProduct = await dave('GET', `/data-products/${product.id}`);
    expect(lines(daveProduct.inheritedContacts)).toEqual(['domainOwner: Invented Cara (Invented Payments)']);
    expect(JSON.stringify(daveProduct)).not.toContain('Invented Finance');
    expect(JSON.stringify(daveProduct)).not.toContain('Invented Ben');
    expect(lines((await dana('GET', `/data-products/${product.id}`)).inheritedContacts)).toContain('domainArchitect: Invented Ben (Invented Finance)');
  });

  it('inherited contacts count for expected roles; the scorecard notes the missing ones, and the owner check stays', async () => {
    await s.api('PUT', '/contact-roles/domainArchitect', {
      labels: { en: 'Domain architect', de: 'Domänenarchitekt' },
      description: 'Invented: keeps the domain’s data model',
      kinds: ['data_domain', 'data_product'],
      expected: true,
    });
    const evidence = async (c: Client) =>
      (
        (await c('GET', `/data-products/${ids.product}/scorecard`)).parts as { id: string; evidence: { key: string; values?: Record<string, unknown> }[] }[]
      ).find((x) => x.id === 'documented')!.evidence;
    // dana sees Finance's architect: nothing missing; dave does not: the role is missing for him
    expect((await evidence(dana)).map((e) => e.key)).not.toContain('evidence.documented.missingRoles');
    expect((await evidence(dave)).find((e) => e.key === 'evidence.documented.missingRoles')).toEqual({
      key: 'evidence.documented.missingRoles',
      values: { count: 1, roles: 'Domain architect' },
    });
    // an ended link does not count
    await s.api('PUT', `/data-domains/${ids.finance}`, {
      key: 'inv-finance',
      name: 'Invented Finance',
      contacts: [
        { role: 'domainOwner', contactId: ids.ann },
        { role: 'domainArchitect', contactId: ids.ben, until: '2000-01-01' },
      ],
    });
    expect((await evidence(dana)).map((e) => e.key)).toContain('evidence.documented.missingRoles');
    // the "needs an owner" check still reads productOwner
    expect((await evidence(dana)).map((e) => e.key)).toContain('evidence.documented.missing.owner');
    await s.api('PUT', '/contact-roles/domainArchitect', {
      labels: { en: 'Domain architect', de: 'Domänenarchitekt' },
      kinds: ['data_domain', 'data_product'],
    });
  });

  it('the file format and ODPS carry the role key and label; unknown roles are refused with a hint', async () => {
    await s.api('PUT', `/data-products/${ids.product}`, {
      key: 'inv-ledger',
      name: 'Invented ledger',
      domainId: null,
      contacts: [
        { role: 'productOwner', contactId: ids.ann, until: '2999-01-31' },
        { role: 'productOwner', contactId: ids.ben, deputyOf: ids.ann },
        { role: 'technicalLead', contactId: ids.cara },
      ],
    });
    const odps = await s.api('GET', `/data-products/${ids.product}/odps`);
    const members = (typeof odps === 'string' ? (await import('yaml')).parse(odps) : odps).team.members;
    expect(members).toEqual([
      expect.objectContaining({ role: 'productOwner', name: 'Invented Ann', description: 'Product owner', dateOut: '2999-01-31' }),
      expect.objectContaining({ role: 'productOwner', name: 'Invented Ben', description: 'Product owner (deputy for Invented Ann)' }),
      expect.objectContaining({ role: 'technicalLead', name: 'Invented Cara', description: 'Technical lead' }),
    ]);
    const pub = await v1(`/data-products/${ids.product}`);
    expect(pub.contacts).toEqual([
      { role: 'productOwner', roleLabel: 'Product owner', name: 'Invented Ann', until: '2999-01-31' },
      { role: 'productOwner', roleLabel: 'Product owner', name: 'Invented Ben', deputyOf: 'Invented Ann' },
      { role: 'technicalLead', roleLabel: 'Technical lead', name: 'Invented Cara' },
    ]);
  });
});

describe('plant sites at the upgrade', () => {
  it('each distinct free-text role becomes an own role; links name it; the registry shows the same texts; once', async () => {
    await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Invented Plant AG', labels: {}, fields: {} });
    for (const id of ['inv-north', 'inv-south']) await s.api('POST', '/plant/sites', { id, name: `Invented ${id}` });
    const { writeItemLinks } = svc;
    const { db } = await import('../src/db.js');
    // the links as 0.25.1 left them: free-text roles (two spellings of one), a long one, none
    const long = 'Backup (nights and weekends, call the gate first if the line is busy)';
    db().tx(() => {
      writeItemLinks('plant_site', 'inv-north', [
        { role: 'Shift lead', contactId: ids.ann },
        { role: long, contactId: ids.ben },
        { role: '', contactId: ids.cara },
      ]);
      writeItemLinks('plant_site', 'inv-south', [
        { role: 'shift  LEAD', contactId: ids.ben },
        { role: 'Shift lead', contactId: ids.ben },
        { role: 'Energy', contactId: ids.cara },
      ]);
    });
    const before = {
      north: (await s.api('GET', '/plant/sites/inv-north')).contacts.map((c: { role: string }) => c.role),
      south: (await s.api('GET', '/plant/sites/inv-south')).contacts.map((c: { role: string }) => c.role),
    };
    const { convertPlantSiteRoles } = await import('../src/contacts/upgrade.js');
    // five links before; the two spellings of one role on one contact became one
    expect(ctx.runAs(null, () => convertPlantSiteRoles())).toEqual({ roles: 3, links: 4 });
    const roles = (await s.api('GET', '/contact-roles')).filter((r: { kinds: string[]; builtIn: boolean }) => r.kinds.includes('plant_site'));
    expect(roles.map((r: { key: string; labels: { en: string } }) => [r.key, r.labels.en]).sort()).toEqual(
      [
        ['shiftLead', 'Shift lead'],
        ['energy', 'Energy'],
        ['backupNightsAndWeekendsCallTheGateFirstIfTheLineIs', long],
        // the demo's role (the test server runs in demo mode: Load demo made it when the registry was turned on)
        ['siteManagement', 'Site management'],
      ].sort(),
    );
    const after = {
      north: (await s.api('GET', '/plant/sites/inv-north')).contacts.map((c: { role: string }) => c.role),
      south: (await s.api('GET', '/plant/sites/inv-south')).contacts.map((c: { role: string }) => c.role),
    };
    expect(after.north).toEqual(before.north);
    // the two spellings of one role on one contact became one link, shown as the most used spelling
    expect(before.south.map((r: string) => r.toLowerCase().replace(/\s+/g, ' '))).toEqual(['shift lead', 'shift lead', 'energy']);
    expect(after.south).toEqual(['Shift lead', 'Energy']);
    expect((await s.api('GET', '/plant/sites/inv-north')).contactLinks.map((l: Link) => l.role)).toEqual(['shiftLead', expect.stringMatching(/^backup/), '']);
    const entry = (await s.api('GET', '/audit?action=contact.role_created&limit=1'))[0];
    expect(entry).toMatchObject({ actor: 'system', details: { kind: 'plant_site', upgrade: '0.26.0', links: 4 } });
    // once: a second run finds nothing to do
    expect(ctx.runAs(null, () => convertPlantSiteRoles())).toEqual({ roles: 0, links: 0 });
  });

  it('the registry’s API and files take the old text and give the label; an unknown text is refused with a hint', async () => {
    const site = await s.api('GET', '/plant/sites/inv-north');
    // the shape of before, written back as read
    await s.api('PUT', '/plant/sites/inv-north', { name: site.name, contacts: site.contacts });
    expect((await s.api('GET', '/plant/sites/inv-north')).contacts).toEqual(site.contacts);
    // the text in other letter case is the role
    const again = await s.api('PUT', '/plant/sites/inv-north', { name: site.name, contacts: [{ ...site.contacts[0], role: 'SHIFT LEAD' }] });
    expect(again.contacts.map((c: { role: string }) => c.role)).toEqual(['Shift lead']);
    expect(await refusal(s.api('PUT', '/plant/sites/inv-north', { name: site.name, contacts: [{ ...site.contacts[0], role: 'Invented new role' }] }))).toEqual({
      status: 400,
      code: 'CONTACT_ROLE_UNKNOWN',
    });
    // the picker: the catalogue's keys
    const picked = await s.api('PUT', '/plant/sites/inv-north', { name: site.name, contactLinks: [{ role: 'energy', contactId: ids.ann }] });
    expect(picked.contacts.map((c: { role: string }) => c.role)).toEqual(['Energy']);
    // the import's preview names the unknown role
    const file = [
      'version: 1',
      'sites:',
      '  - id: inv-east',
      '    name: Invented east',
      '    contacts:',
      '      - name: Invented Ann',
      '        role: Invented unknown role',
    ].join('\n');
    const preview = await s.api('POST', '/plant/import/preview', { files: [{ name: 'east.plant.yaml', content: file }], mode: 'add' });
    expect(preview.problems).toEqual([
      expect.objectContaining({ path: expect.stringMatching(/contacts\[0\]\.role$/), message: expect.stringContaining('Settings → Contacts → Roles') }),
    ]);
  });
});

describe('statements', () => {
  it('validating, labelling and inheriting read in bulk: the count does not grow with the links, deputies or roles', async () => {
    const { requestDbStats } = await import('../src/database/timing.js');
    const { db } = await import('../src/db.js');
    const count = (fn: () => unknown) => {
      const stats = { statements: 0, ms: 0 };
      requestDbStats.run(stats, fn);
      return stats.statements;
    };
    const apps = Array.from({ length: 40 }, (_, i) => `app_stmt_${i}`);
    const write = (n: number) =>
      db().tx(() => {
        for (const id of apps.slice(0, n))
          svc.writeItemLinks('application', id, [
            { role: 'businessOwner', contactId: ids.ann },
            { role: 'businessOwner', contactId: ids.ben, deputyOf: ids.ann, until: '2999-01-01' },
          ]);
      });
    write(4);
    const few = count(() => svc.namesOfLinks(svc.linksOf('application', apps).get(apps[0]!)));
    write(40);
    expect(count(() => svc.namesOfLinks(svc.linksOf('application', apps).get(apps[0]!)))).toBe(few);
    // validating 20 links reads the catalogue from memory: the same statements as for two
    const two = count(() => as('dana', () => svc.setLinks('application', 'app_stmt_x', [{ role: 'businessOwner', contactId: ids.ann }])));
    const many = count(() =>
      as('dana', () =>
        svc.setLinks('application', 'app_stmt_x', [
          { role: 'businessOwner', contactId: ids.ann },
          ...Array.from({ length: 19 }, () => ({ role: 'businessOwner', contactId: ids.ben, deputyOf: ids.ann })),
        ]),
      ),
    );
    expect(many).toBeLessThanOrEqual(two + 3);
  });
});
