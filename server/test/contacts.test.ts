import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * The contacts directory (0.25.1, ADR 0038 part 1, docs/CONTACTS.md): who sees a contact (who sees one item it is linked
 * to, administrators, auditors, its creator while it is unlinked), who changes it, Replace with…, Erase, Possible
 * duplicates, what each surface shows (CONTACT_EXPOSURE) and flat statement counts. Team scope: a reader never sees,
 * counts or is told about a contact or an item they may not see – the where-used page only counts hidden links.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Own-password-123';
let s: TestServer;
let tara: Client; // designer, member of Orders
let dave: Client; // designer, not a member
let vic: Client; // viewer
let aud: Client; // auditor
let svcA: string; // owned by Orders: tara, administrators and auditors see it
let svcB: string; // of the whole instance
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
const as = <T>(name: string, fn: () => T): T => ctx.runAs(users.toAuthUser(users.findUserByName(name)!), fn);
const thrown = (fn: () => unknown): { status?: number; code?: string } => {
  try {
    fn();
    return {};
  } catch (e) {
    return { status: (e as { statusCode?: number }).statusCode, code: (e as { code?: string }).code };
  }
};
const names = (l: { items: { name: string }[] }) => l.items.map((x) => x.name).sort();

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  svc = await import('../src/contacts/service.js');
  ctx = await import('../src/auth/context.js');
  users = await import('../src/auth/users.js');
  for (const [username, roles] of [
    ['tara', ['designer']],
    ['dave', ['designer']],
    ['vic', ['viewer']],
    ['aud', ['auditor']],
  ] as const)
    users.createUser({ username, roles: [...roles], password: PW, mustChangePassword: false, email: `${username}@example.com` });
  [tara, dave, vic, aud] = await Promise.all(['tara', 'dave', 'vic', 'aud'].map((u) => s.as(u, PW)));
  const orders = (await s.api('POST', '/teams', { name: 'Orders', members: ['tara'] })).id;
  svcA = (await s.api('POST', '/services', { name: 'Invented order intake', owners: [] })).id;
  svcB = (await s.api('POST', '/services', { name: 'Invented shop front', owners: [] })).id;
  await s.api('PUT', `/owning-teams/service/${svcA}`, { teamIds: [orders] });
  for (const [key, email] of [
    ['alice', 'alice@invented.example'],
    ['bob', 'bob@invented.example'],
    ['carol', 'carol@invented.example'],
  ] as const)
    ids[key] = (await s.api('POST', '/contacts', { name: `Invented ${key}`, email, phone: '+49 30 1234567', orgUnit: 'Invented sales' })).id;
  // links as a job (no user): alice on the team's service, bob on the open one, carol on both
  svc.setLinks('service', svcA, [
    { role: 'business', contactId: ids.alice },
    { role: 'it', contactId: ids.carol },
  ]);
  svc.setLinks('service', svcB, [
    { role: 'business', contactId: ids.bob },
    { role: 'business', contactId: ids.carol },
  ]);
}, 120_000);

describe('who sees a contact', () => {
  it('who sees one item it is linked to; administrators and auditors all; others are never told', async () => {
    expect(names(await dave('GET', '/contacts'))).toEqual(['Invented bob', 'Invented carol']);
    expect(names(await vic('GET', '/contacts'))).toEqual(['Invented bob', 'Invented carol']);
    expect(names(await tara('GET', '/contacts'))).toEqual(['Invented alice', 'Invented bob', 'Invented carol']);
    expect(names(await aud('GET', '/contacts'))).toEqual(['Invented alice', 'Invented bob', 'Invented carol']);
    // search by name and e-mail: nothing about the hidden one, not even "more"
    expect(await dave('GET', '/contacts?q=alice')).toMatchObject({ items: [], more: false });
    expect(names(await tara('GET', '/contacts?q=ALICE@invented'))).toEqual(['Invented alice']);
    // the same answer as for a contact that does not exist
    expect(await refusal(dave('GET', `/contacts/${ids.alice}`))).toEqual({ status: 404, code: 'CONTACT_NOT_FOUND' });
    expect(await refusal(dave('GET', '/contacts/ct_nothing'))).toEqual({ status: 404, code: 'CONTACT_NOT_FOUND' });
  });

  it('shows the links on items the reader may see, and counts the others without naming them', async () => {
    const forDave = await dave('GET', `/contacts/${ids.carol}`);
    expect(forDave.links).toEqual([{ kind: 'service', itemId: svcB, itemName: 'Invented shop front', role: 'business', href: `/services/${svcB}` }]);
    expect(forDave.hiddenLinks).toBe(1);
    expect(JSON.stringify(forDave)).not.toContain(svcA);
    expect(JSON.stringify(forDave)).not.toContain('Invented order intake');
    const forTara = await tara('GET', `/contacts/${ids.carol}`);
    expect(forTara.links.map((l: { itemId: string }) => l.itemId).sort()).toEqual([svcA, svcB].sort());
    expect(forTara.hiddenLinks).toBe(0);
    // usage in the list: visible links only
    const carol = (await dave('GET', '/contacts?q=carol')).items[0];
    expect(carol).toMatchObject({ name: 'Invented carol', usedBy: 1, email: 'carol@invented.example' });
  });

  it('its creator while it is linked to nothing', async () => {
    const mine = await dave('POST', '/contacts', { name: 'Invented dora', email: 'dora@invented.example' });
    expect(mine).toMatchObject({ name: 'Invented dora', links: [], hiddenLinks: 0, canEdit: true, createdBy: 'dave' });
    expect(await refusal(vic('GET', `/contacts/${mine.id}`))).toMatchObject({ status: 404 });
    expect(await refusal(vic('POST', '/contacts', { name: 'Invented x' }))).toMatchObject({ status: 403 });
    // linked to the team's service: the creator does not see it any more
    svc.setLinks('service', svcA, [{ role: 'business', contactId: mine.id }], { roles: ['business'] });
    expect(await refusal(dave('GET', `/contacts/${mine.id}`))).toMatchObject({ status: 404, code: 'CONTACT_NOT_FOUND' });
    // the item's other role kept its contact (opts.roles), alice went from business; the new link comes last
    expect(
      svc
        .linksOf('service', [svcA])
        .get(svcA)!
        .map((l) => [l.role, l.contact.name]),
    ).toEqual([
      ['it', 'Invented carol'],
      ['business', 'Invented dora'],
    ]);
    svc.setLinks('service', svcA, [{ role: 'business', contactId: ids.alice }], { roles: ['business'] });
  });

  it('link kinds no module registered: administrators and auditors only', async () => {
    const lone = await s.api('POST', '/contacts', { name: 'Invented erin' });
    const db = (await import('../src/db.js')).db();
    db.run(
      "INSERT INTO contact_links (kind, item_id, role, contact_id, position, created_at, created_by) VALUES ('data_object', 'dpo_x', 'dataOwner', ?, 0, 'now', 'admin')",
      lone.id,
    );
    expect(await refusal(tara('GET', `/contacts/${lone.id}`))).toMatchObject({ status: 404 });
    expect((await aud('GET', `/contacts/${lone.id}`)).links).toHaveLength(1);
    expect((await s.api('GET', `/contacts/${lone.id}`)).canEdit).toBe(true);
    ids.erin = lone.id;
  });
});

describe('who creates a contact', () => {
  it('who works in Steward, and whom a link kind lets (a module-only contributor)', async () => {
    expect(await refusal(vic('POST', '/contacts', { name: 'Invented viewer contact' }))).toMatchObject({ status: 403 });
    const { registerContactKind, contactKind } = await import('../src/contacts/registry.js');
    const before = contactKind('data_consumer');
    registerContactKind('data_consumer', { ...before, createsContacts: (u) => u.username === 'vic' });
    try {
      expect((await vic('POST', '/contacts', { name: 'Invented viewer contact' })).createdBy).toBe('vic');
      expect((await vic('GET', '/contacts?q=viewer%20contact')).canCreate).toBe(true);
    } finally {
      registerContactKind('data_consumer', { ...before, createsContacts: () => false });
    }
  });
});

describe('who changes a contact', () => {
  it('who may change one item it is linked to, and administrators; audited without the e-mail address', async () => {
    expect(await refusal(vic('PUT', `/contacts/${ids.carol}`, { name: 'Invented carol', email: 'x@invented.example' }))).toMatchObject({ status: 403 });
    expect(await refusal(aud('PUT', `/contacts/${ids.carol}`, { name: 'Invented carol' }))).toMatchObject({ status: 403 });
    expect(await refusal(dave('PUT', `/contacts/${ids.alice}`, { name: 'Invented alice' }))).toMatchObject({ status: 404 });
    const c = await dave('PUT', `/contacts/${ids.carol}`, {
      name: 'Invented carol',
      email: 'carol.new@invented.example',
      phone: '+49 30 7654321',
      orgUnit: 'Invented sales',
    });
    expect(c).toMatchObject({ email: 'carol.new@invented.example', updatedBy: 'dave', canEdit: true });
    const entry = (await s.api('GET', '/audit?action=contact.updated&limit=1'))[0];
    expect(entry).toMatchObject({ entityType: 'contact', entityId: ids.carol });
    expect(JSON.stringify(entry)).not.toContain('carol.new@invented.example');
    expect(JSON.stringify(entry)).not.toContain('7654321');
    expect(entry.details.changed).toEqual(['email', 'phone']);
    // a Steward user it is: documentation only
    expect(await refusal(s.api('PUT', `/contacts/${ids.carol}`, { name: 'Invented carol', email: 'carol.new@invented.example', userId: 'nobody' }))).toEqual({
      status: 400,
      code: 'CONTACT_USER_UNKNOWN',
    });
  });

  it('links name only contacts the user may see, active ones, roles of the kind, at most 20 per role', async () => {
    // alice is hidden from dave: as if she did not exist
    expect(as('dave', () => thrown(() => svc.setLinks('service', svcB, [{ role: 'it', contactId: ids.alice }])))).toEqual({
      status: 404,
      code: 'CONTACT_NOT_FOUND',
    });
    expect(as('dave', () => thrown(() => svc.setLinks('service', svcB, [{ role: 'owner', contactId: ids.bob }])))).toMatchObject({
      code: 'CONTACT_ROLE_UNKNOWN',
    });
    const many = Array.from({ length: 21 }, (_, i) => ({ role: 'it', contact: { name: `Invented ${i}` } }));
    expect(as('dave', () => thrown(() => svc.setLinks('service', svcB, many)))).toMatchObject({ code: 'CONTACT_ROLE_LIMIT' });
    expect(thrown(() => svc.setLinks('teapot' as never, 'x', []))).toMatchObject({ code: 'CONTACT_KIND_UNKNOWN' });
    // plant sites: free-text roles of up to 80 characters
    const free = svc.setLinks('plant_site', 'site_x', [{ role: 'Shift lead (night)', contactId: ids.bob }]);
    expect(free.added).toEqual([{ role: 'Shift lead (night)', contactId: ids.bob, name: 'Invented bob' }]);
    svc.removeItemLinks('plant_site', 'site_x');
    // a new contact on the way, and the same contact twice counts once
    const r = as('dave', () =>
      svc.setLinks('service', svcB, [
        { role: 'business', contactId: ids.bob },
        { role: 'business', contactId: ids.bob },
        { role: 'business', contactId: ids.carol },
        { role: 'it', contact: { name: 'Invented fred', email: 'fred@invented.example' } },
      ]),
    );
    expect(r.created).toHaveLength(1);
    expect(r.added).toEqual([{ role: 'it', contactId: r.created[0], name: 'Invented fred' }]);
    expect(r.removed).toEqual([]);
    ids.fred = r.created[0]!;
    expect((await s.api('GET', '/audit?action=contact.created&limit=1'))[0]).toMatchObject({ entityId: ids.fred, actor: 'dave' });
    // a contact who has left is offered nowhere new, but stays where it is
    await s.api('PUT', `/contacts/${ids.fred}`, { name: 'Invented fred', email: 'fred@invented.example', status: 'left' });
    expect(thrown(() => svc.setLinks('service', svcA, [{ role: 'it', contactId: ids.fred }], { roles: ['it'] }))).toMatchObject({
      status: 409,
      code: 'CONTACT_LEFT',
    });
    svc.setLinks('service', svcB, [{ role: 'it', contactId: ids.fred }], { roles: ['it'] });
    expect(names(await dave('GET', '/contacts?status=left'))).toEqual(['Invented fred']);
    expect(names(await dave('GET', '/contacts'))).not.toContain('Invented fred');
  });
});

describe('documented decisions', () => {
  it('freeze visible, active contacts', () => {
    expect(as('dave', () => svc.snapshotsOf([{ contactId: ids.bob, role: 'productOwner' }]))).toEqual([
      { contactId: ids.bob, name: 'Invented bob', role: 'productOwner' },
    ]);
    expect(as('dave', () => thrown(() => svc.snapshotsOf([{ contactId: ids.alice, role: 'x' }])))).toEqual({ status: 404, code: 'CONTACT_NOT_FOUND' });
    expect(as('dave', () => thrown(() => svc.snapshotsOf([{ contactId: ids.fred, role: 'x' }])))).toEqual({ status: 409, code: 'CONTACT_LEFT' });
  });
});

describe('making contacts for other modules', () => {
  it('a Steward user, a group, an import matched by e-mail among visible contacts only', () => {
    const u1 = as('tara', () => svc.contactForUser('dave'))!;
    expect(u1).toMatchObject({ name: 'dave', email: 'dave@example.com', user: 'dave', kind: 'person' });
    // tara sees it (she made it, unlinked); a second call finds it
    expect(as('tara', () => svc.contactForUser('user:DAVE'))!.id).toBe(u1.id);
    expect(svc.contactForUser('nobody')).toBeNull();
    const g = svc.contactForGroup('team:Invented data office');
    expect(g).toMatchObject({ kind: 'group', name: 'Invented data office' });
    expect(svc.contactForGroup('invented  DATA office').id).toBe(g.id);
    // alice's address: dave may not see her, so his import makes a separate contact; tara's import finds her
    const d = as('dave', () => svc.importContact({ name: 'Invented alice', email: 'ALICE@invented.example' }));
    expect(d.id).not.toBe(ids.alice);
    expect(as('tara', () => svc.importContact({ name: 'A. Invented', email: 'alice@invented.example' })).id).toBe(ids.alice);
    ids.alice2 = d.id;
  });

  it('administrators see the contacts that share an e-mail address', async () => {
    const dup = await s.api('GET', '/contacts/duplicates');
    const group = dup.find((g: { email: string }) => g.email === 'alice@invented.example');
    expect(group.contacts.map((c: { id: string }) => c.id).sort()).toEqual([ids.alice, ids.alice2].sort());
    expect(await refusal(dave('GET', '/contacts/duplicates'))).toMatchObject({ status: 403 });
  });
});

describe('exposure per surface', () => {
  it('follows the link kind, never the contact', () => {
    const db = svc;
    db.setLinks('data_product', 'dp_x', [{ role: 'productOwner', contactId: ids.bob }]);
    db.setLinks('supplier', 'sc_x', [{ role: 'support', contactId: ids.bob }]);
    const one = (kind: 'service' | 'data_product' | 'supplier', id: string, surface?: 'app' | 'api' | 'export' | 'file') =>
      svc
        .linksOf(kind, [id], { surface })
        .get(id)!
        .find((l) => l.contact.id === ids.bob)!.contact;
    expect(one('data_product', 'dp_x')).toMatchObject({ email: 'bob@invented.example', phone: '+49 30 1234567' });
    expect(one('data_product', 'dp_x', 'api')).toEqual({ id: ids.bob, kind: 'person', name: 'Invented bob', status: 'active' });
    expect(one('data_product', 'dp_x', 'export')).toEqual({ id: ids.bob, kind: 'person', name: 'Invented bob', status: 'active' });
    expect(one('data_product', 'dp_x', 'file')).toEqual({ id: ids.bob, kind: 'person', name: 'Invented bob', status: 'active', email: 'bob@invented.example' });
    // suppliers: in the app only
    expect(one('supplier', 'sc_x', 'api')).not.toHaveProperty('email');
    expect(one('supplier', 'sc_x', 'file')).not.toHaveProperty('email');
    // services: as before 0.25.1 (name, role and e-mail where they were shown)
    expect(one('service', svcB, 'api')).toMatchObject({ email: 'bob@invented.example' });
    svc.removeItemLinks('data_product', 'dp_x');
    svc.removeItemLinks('supplier', 'sc_x');
  });
});

describe('Replace with…', () => {
  it('moves the links the reader may change; the hidden ones stay; audited per item', async () => {
    expect(await refusal(dave('POST', `/contacts/${ids.carol}/replace`, { targetId: ids.carol }))).toMatchObject({ code: 'CONTACT_REPLACE_SAME' });
    expect(await refusal(dave('POST', `/contacts/${ids.carol}/replace`, { targetId: ids.alice }))).toMatchObject({ status: 404 });
    expect(await refusal(vic('POST', `/contacts/${ids.carol}/replace`, { targetId: ids.bob }))).toMatchObject({ status: 403 });
    // carol is on svcB (business, next to bob) and svcA (it, hidden from dave)
    const r = await dave('POST', `/contacts/${ids.carol}/replace`, { targetId: ids.bob });
    expect(r).toMatchObject({ moved: 1, skipped: 0 });
    expect(r.target.links.map((l: { itemId: string; role: string }) => `${l.itemId}:${l.role}`)).toContain(`${svcB}:business`);
    expect((await tara('GET', `/contacts/${ids.carol}`)).links.map((l: { itemId: string }) => l.itemId)).toEqual([svcA]);
    // bob was business on svcB already: merged, not twice
    expect(
      svc
        .linksOf('service', [svcB])
        .get(svcB)!
        .filter((l) => l.role === 'business')
        .map((l) => l.contact.name),
    ).toEqual(['Invented bob']);
    const entry = (await s.api('GET', '/audit?action=contact.replaced&limit=1'))[0];
    expect(entry).toMatchObject({ entityType: 'service', entityId: svcB, actor: 'dave' });
    // administrators move every link, and may mark the replaced contact as left
    const all = await s.api('POST', `/contacts/${ids.carol}/replace`, { targetId: ids.bob, markLeft: true });
    expect(all).toMatchObject({ moved: 1, skipped: 0 });
    expect((await s.api('GET', `/contacts/${ids.carol}`)).status).toBe('left');
  });
});

describe('Erase', () => {
  it('administrators only; links go, frozen snapshots keep the name with a null id', async () => {
    const { registerContactHooks } = await import('../src/contacts/registry.js');
    const erased: string[] = [];
    registerContactHooks({ onErased: (id) => erased.push(id), countDecisions: (cids) => new Map(cids.map((c) => [c, c === ids.bob ? 2 : 0])) });
    expect((await dave('GET', `/contacts/${ids.bob}`)).decisions).toBe(2);
    expect(await refusal(dave('DELETE', `/contacts/${ids.bob}`))).toMatchObject({ status: 403 });
    await s.api('DELETE', `/contacts/${ids.bob}`);
    expect(erased).toEqual([ids.bob]);
    expect(await refusal(s.api('GET', `/contacts/${ids.bob}`))).toMatchObject({ status: 404 });
    expect(
      svc
        .linksOf('service', [svcA, svcB])
        .get(svcB)!
        .map((l) => l.contact.id),
    ).not.toContain(ids.bob);
    const entry = (await s.api('GET', '/audit?action=contact.erased&limit=1'))[0];
    expect(entry).toMatchObject({ entityId: ids.bob });
    expect(JSON.stringify(entry)).not.toContain('Invented bob');
  });
});

describe('the upgrade of stored contacts (0.25.1)', () => {
  it('converts the lists services, suppliers and sites kept, once, and shows them as before', async () => {
    const db = (await import('../src/db.js')).db();
    const { convertItemContacts } = await import('../src/contacts/upgrade.js');
    const stored = [
      { role: 'business', email: 'gus@invented.example', name: 'Gus Invented' },
      { role: 'it', email: 'it-desk@invented.example' },
    ];
    const svcC = (await s.api('POST', '/services', { name: 'Invented legacy service', owners: [] })).id;
    db.run('UPDATE services SET contacts = ? WHERE id = ?', JSON.stringify(stored), svcC);
    const sup = (await s.api('POST', '/suppliers', { name: 'Invented Legacy AG', type: 'saas' })).id;
    db.run(
      "INSERT INTO supplier_contacts (id, supplier_id, name, role, email, phone, note, created_at) VALUES ('spc_legacy', ?, 'Gus Invented', 'support', 'gus@invented.example', '+49 30 5', 'Old', ?)",
      sup,
      new Date().toISOString(),
    );
    db.run(
      "INSERT INTO plant_sites (id, name, contacts, created_at, created_by, updated_at, updated_by) VALUES ('legacy-site', 'Invented legacy site', ?, 'now', 'admin', 'now', 'admin')",
      JSON.stringify([{ name: 'Gus Invented', role: '', email: '', phone: '', url: '' }]),
    );
    // before: the stored lists, as 0.25.0 showed them
    expect((await s.api('GET', `/services/${svcC}`)).contacts).toEqual(stored);
    expect((await s.api('GET', `/suppliers/${sup}`)).contacts[0]).toMatchObject({
      id: 'spc_legacy',
      name: 'Gus Invented',
      email: 'gus@invented.example',
      phone: '+49 30 5',
      contactId: null,
    });
    expect(convertItemContacts()).toMatchObject({ services: 1, suppliers: 1, sites: 1 });
    expect(convertItemContacts()).toEqual({ services: 0, suppliers: 0, sites: 0 });
    // after: the same, from the directory – three contacts for Gus (kinds are never merged), one for the IT desk
    expect((await s.api('GET', `/services/${svcC}`)).contacts).toEqual(stored);
    const after = (await s.api('GET', `/suppliers/${sup}`)).contacts[0];
    expect(after).toMatchObject({ id: 'spc_legacy', name: 'Gus Invented', email: 'gus@invented.example', phone: '+49 30 5', note: 'Old' });
    expect(after.contactId).toMatch(/^ct_/);
    expect(
      svc
        .linksOf('plant_site', ['legacy-site'])
        .get('legacy-site')!
        .map((l) => [l.role, l.contact.name]),
    ).toEqual([['', 'Gus Invented']]);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM contacts WHERE name = 'Gus Invented'")!.n).toBe(3);
    expect(db.get<{ c: string }>('SELECT contacts AS c FROM services WHERE id = ?', svcC)!.c).toBe('[]');
  });
});

describe('statements', () => {
  it('do not grow with the number of items or contacts', async () => {
    const { requestDbStats } = await import('../src/database/timing.js');
    const count = (fn: () => unknown) => {
      const stats = { statements: 0, ms: 0 };
      requestDbStats.run(stats, fn);
      return stats.statements;
    };
    const items = Array.from({ length: 60 }, (_, i) => `svc_bulk_${i}`);
    for (const id of items.slice(0, 5)) svc.setLinks('service', id, [{ role: 'business', contact: { name: `Invented bulk ${id}` } }]);
    const few = count(() => svc.linksOf('service', items.slice(0, 5)));
    for (const id of items.slice(5)) svc.setLinks('service', id, [{ role: 'business', contact: { name: `Invented bulk ${id}` } }]);
    expect(count(() => svc.linksOf('service', items))).toBe(few);
    // the list as a reader who sees some: one contact on a service of the whole instance, then 20 (the second call:
    // caches of the first are warm)
    svc.setLinks('service', svcB, [{ role: 'it', contact: { name: 'Invented many x' } }], { roles: ['it'] });
    const listed = () => count(() => as('dave', () => svc.listContacts({ q: '' })));
    listed();
    const before = listed();
    const many = Array.from({ length: 20 }, (_, i) => ({ role: 'it', contact: { name: `Invented many ${i}` } }));
    svc.setLinks('service', svcB, many, { roles: ['it'] });
    expect(listed()).toBe(before);
    expect(names(as('dave', () => svc.listContacts({ q: 'many', limit: 50 })))).toHaveLength(20);
  });
});
