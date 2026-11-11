import { beforeAll, describe, expect, it } from 'vitest';
import { addDays, contractDates, soc2ValidUntil, SUPPLIER_LIMITS } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Suppliers (0.17.0, ADR 0029 part 1): records with contacts, contracts and certificates; permissions like systems
 * (designers and administrators create, confirm, merge and archive; owners change); team scope; the notice-by date;
 * reminders sent once; the links from applications, systems, ticket references, cost plan lines and duties; the public
 * API, MCP and the dataset without the contacts' e-mail and phone; limits; audit; personal data of owners.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Demo-password-1';
let dana: Client, olivia: Client, vera: Client, audrey: Client;
const refused = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { status: number; body: any }) => ({ status: e.status, code: (typeof e.body === 'string' ? JSON.parse(e.body) : e.body)?.code }),
  );
const auditOf = (id: string) => s.api('GET', `/audit?entityType=supplier&entityId=${id}&limit=100`);
const MODERN = '2026-07-28';

async function mcp(token: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; data: any; text: string }> {
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
  return { isError: !!r.isError, data: r.isError ? r.content[0].text : r.structuredContent, text };
}

let acme: any;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [dana, olivia, vera, audrey] = await Promise.all(['dana', 'olivia', 'vera', 'audrey'].map((u) => s.as(u, PW)));
});

describe('the notice-by date and certificate validity', () => {
  it('derives the notice-by date from the end, the notice period and the renewal', () => {
    expect(contractDates({ endsOn: '2027-03-31', noticeDays: 90, renewal: 'fixedEnd', renewalMonths: null }, '2026-11-10')).toEqual({
      termEnd: '2027-03-31',
      noticeBy: '2026-12-31',
    });
    // an automatic renewal whose notice date passed already: the next term counts
    expect(contractDates({ endsOn: '2027-01-31', noticeDays: 90, renewal: 'automatic', renewalMonths: 12 }, '2026-11-10')).toEqual({
      termEnd: '2028-01-31',
      noticeBy: '2027-11-02',
    });
    // a fixed end that passed stays where it is
    expect(contractDates({ endsOn: '2025-01-31', noticeDays: 30, renewal: 'fixedEnd', renewalMonths: null }, '2026-11-10').noticeBy).toBe('2025-01-01');
    expect(contractDates({ endsOn: null, noticeDays: 30, renewal: 'fixedEnd', renewalMonths: null }, '2026-11-10')).toEqual({ termEnd: null, noticeBy: null });
    expect(soc2ValidUntil('2026-02-28')).toBe('2027-02-28');
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
  });
});

describe('suppliers', () => {
  it('designers create suppliers, owners change them, everyone reads them', async () => {
    expect((await refused(vera('POST', '/suppliers', { name: 'x' })))?.status).toBe(403);
    expect((await refused(olivia('POST', '/suppliers', { name: 'x' })))?.status).toBe(403);
    acme = await dana('POST', '/suppliers', {
      name: 'Acme Hosting GmbH',
      type: 'managedPlatform',
      website: 'https://acme-hosting.example',
      owners: ['user:olivia'],
      personalData: true,
    });
    expect(acme).toMatchObject({ name: 'Acme Hosting GmbH', type: 'managedPlatform', status: 'active', dpaStatus: 'missing', canEdit: true, canManage: true });
    expect(await refused(dana('POST', '/suppliers', { name: 'acme hosting gmbh' }))).toEqual({ status: 409, code: 'SUPPLIER_EXISTS' });
    expect((await refused(dana('POST', '/suppliers', { name: 'Bad', website: 'ftp://x' })))?.status).toBe(400);
    // an owner changes it, but does not manage suppliers
    const o = await olivia('GET', `/suppliers/${acme.id}`);
    expect(o).toMatchObject({ canEdit: true, canManage: false });
    const changed = await olivia('PUT', `/suppliers/${acme.id}`, {
      name: 'Acme Hosting GmbH',
      type: 'managedPlatform',
      owners: ['user:olivia'],
      personalData: true,
      dpaStatus: 'inPlace',
      dpaSince: '2025-02-01',
      dpaLink: 'https://contracts.example/dpa-acme',
    });
    expect(changed).toMatchObject({ dpaStatus: 'inPlace', dpaSince: '2025-02-01' });
    expect((await refused(olivia('POST', `/suppliers/${acme.id}/archive`, { archived: true })))?.status).toBe(403);
    // a viewer reads, but changes nothing
    expect(await vera('GET', `/suppliers/${acme.id}`)).toMatchObject({ canEdit: false, canManage: false });
    expect((await refused(vera('PUT', `/suppliers/${acme.id}`, { name: 'x' })))?.status).toBe(403);
    expect((await vera('GET', '/suppliers')).map((x: any) => x.name)).toContain('Acme Hosting GmbH');
    expect((await refused(vera('GET', '/suppliers/sup_nope')))?.status).toBe(404);
  });

  it('keeps contacts, contracts and certificates – the audit log never holds a contact’s e-mail or phone', async () => {
    let d = await olivia('POST', `/suppliers/${acme.id}/contacts`, {
      name: 'Pat Example',
      role: 'accountManager',
      email: 'pat@acme-hosting.example',
      phone: '+49 30 1234567',
    });
    const contact = d.contacts[0];
    expect(contact).toMatchObject({ name: 'Pat Example', email: 'pat@acme-hosting.example', phone: '+49 30 1234567' });
    d = await olivia('PUT', `/suppliers/${acme.id}/contacts/${contact.id}`, { name: 'Pat Example', role: 'security', email: 'pat.sec@acme-hosting.example' });
    expect(d.contacts[0]).toMatchObject({ role: 'security', email: 'pat.sec@acme-hosting.example', phone: '' });
    d = await olivia('POST', `/suppliers/${acme.id}/contracts`, {
      title: 'Managed hosting',
      reference: 'AC-1',
      startsOn: '2025-01-01',
      endsOn: '2027-12-31',
      noticeDays: 90,
      renewal: 'automatic',
      renewalMonths: 12,
      slaAvailability: 99.9,
      rtoHours: 4,
      rpoHours: 1,
    });
    expect(d.contracts[0]).toMatchObject({ title: 'Managed hosting', noticeBy: '2027-10-02', slaAvailability: 99.9, rtoHours: 4, rpoHours: 1 });
    expect((await refused(olivia('POST', `/suppliers/${acme.id}/contracts`, { title: 'x', renewal: 'automatic' })))?.status).toBe(400);
    expect((await refused(olivia('POST', `/suppliers/${acme.id}/contracts`, { title: 'x', startsOn: '2026-02-01', endsOn: '2026-01-01' })))?.status).toBe(400);
    d = await olivia('POST', `/suppliers/${acme.id}/certificates`, { kind: 'soc2type2', issuedOn: '2026-03-31', checked: true });
    expect(d.certificates[0]).toMatchObject({ kind: 'soc2type2', validUntil: '2027-03-31', checkedBy: 'olivia' });
    expect(d.certificateCount).toBe(1);
    d = await olivia('DELETE', `/suppliers/${acme.id}/contacts/${contact.id}`);
    expect(d.contacts).toEqual([]);
    const audit = await auditOf(acme.id);
    const actions = audit.map((a: any) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'supplier.created',
        'supplier.changed',
        'supplier.contact_added',
        'supplier.contact_changed',
        'supplier.contact_removed',
        'supplier.contract_added',
        'supplier.certificate_added',
      ]),
    );
    const text = JSON.stringify(audit);
    expect(text).toContain('Pat Example');
    expect(text).not.toContain('acme-hosting.example"');
    expect(text).not.toContain('pat@');
    expect(text).not.toContain('pat.sec@');
    expect(text).not.toContain('1234567');
    // the contact is gone for good
    const { db } = await import('../src/db.js');
    expect(db().get('SELECT 1 FROM supplier_contacts WHERE id = ?', contact.id)).toBeUndefined();
  });

  it('enforces the limits per supplier', async () => {
    const sup = await dana('POST', '/suppliers', { name: 'Limit Supplier' });
    for (let i = 0; i < SUPPLIER_LIMITS.contacts; i++) await dana('POST', `/suppliers/${sup.id}/contacts`, { name: `Contact ${i}` });
    expect(await refused(dana('POST', `/suppliers/${sup.id}/contacts`, { name: 'one more' }))).toEqual({ status: 409, code: 'SUPPLIER_CONTACT_LIMIT' });
    for (let i = 0; i < SUPPLIER_LIMITS.certificates; i++) await dana('POST', `/suppliers/${sup.id}/certificates`, { kind: 'other', name: `Cert ${i}` });
    expect(await refused(dana('POST', `/suppliers/${sup.id}/certificates`, { kind: 'iso27001' }))).toEqual({ status: 409, code: 'SUPPLIER_CERTIFICATE_LIMIT' });
    expect((await refused(dana('POST', '/suppliers', { name: 'x'.repeat(SUPPLIER_LIMITS.name + 1) })))?.status).toBe(400);
    // the number of suppliers: counted without the archived ones
    const { db } = await import('../src/db.js');
    const n = Number(db().get<{ n: number }>("SELECT COUNT(*) AS n FROM suppliers WHERE status <> 'archived'")!.n);
    const now = new Date().toISOString();
    db().tx(() => {
      for (let i = n; i < SUPPLIER_LIMITS.suppliers; i++)
        db().run(
          `INSERT INTO suppliers (id, name, norm_name, status, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, 'active', ?, 'admin', ?, 'admin')`,
          `sup_limit_${i}`,
          `Filler ${i}`,
          `filler${i}`,
          now,
          now,
        );
    });
    expect(await refused(dana('POST', '/suppliers', { name: 'One too many' }))).toEqual({ status: 409, code: 'SUPPLIER_LIMIT' });
    db().run("DELETE FROM suppliers WHERE id LIKE 'sup_limit_%'");
  });

  it('archives a supplier: kept where it is linked, not offered for new links', async () => {
    const old = await dana('POST', '/suppliers', { name: 'Old Supplier' });
    const app = await dana('POST', '/applications', { name: 'Uses old supplier', supplierId: old.id });
    expect(app.supplier).toMatchObject({ id: old.id, name: 'Old Supplier' });
    expect(await dana('POST', `/suppliers/${old.id}/archive`, { archived: true })).toMatchObject({ status: 'archived', canEdit: false });
    expect((await dana('GET', '/suppliers/options')).map((x: any) => x.id)).not.toContain(old.id);
    // still linked, and kept when the application is saved; a new link is refused
    const again = await dana('PUT', `/applications/${app.id}`, { name: 'Uses old supplier', supplierId: old.id });
    expect(again.supplier.id).toBe(old.id);
    expect(await refused(dana('POST', '/applications', { name: 'New link to old', supplierId: old.id }))).toEqual({ status: 409, code: 'SUPPLIER_ARCHIVED' });
    expect(await refused(dana('POST', `/suppliers/${old.id}/contacts`, { name: 'x' }))).toEqual({ status: 409, code: 'SUPPLIER_ARCHIVED' });
    expect(await dana('POST', `/suppliers/${old.id}/archive`, { archived: false })).toMatchObject({ status: 'active' });
    expect((await auditOf(old.id)).map((a: any) => a.action)).toEqual(expect.arrayContaining(['supplier.archived', 'supplier.unarchived']));
  });
});

describe('links from the former free-text vendors', () => {
  let sup: any;
  let contractId = '';
  beforeAll(async () => {
    sup = await dana('POST', '/suppliers', { name: 'Linked Supplier', type: 'saas', owners: ['user:olivia'] });
    contractId = (await dana('POST', `/suppliers/${sup.id}/contracts`, { title: 'Subscription', reference: 'LS-9' })).contracts[0].id;
  });

  it('links applications, systems, ticket references, cost plan lines and duties, keeping the text', async () => {
    const app = await dana('POST', '/applications', { name: 'Linked app', vendor: 'Linked Supplier Ltd', supplierId: sup.id });
    expect(app).toMatchObject({ vendor: 'Linked Supplier Ltd', supplier: { id: sup.id, name: 'Linked Supplier', status: 'active' } });
    // missing keeps it, null clears it
    expect((await dana('PUT', `/applications/${app.id}`, { name: 'Linked app', vendor: 'Linked Supplier Ltd' })).supplier.id).toBe(sup.id);
    expect((await dana('PUT', `/applications/${app.id}`, { name: 'Linked app', vendor: 'Linked Supplier Ltd', supplierId: null })).supplier).toBeNull();
    await dana('PUT', `/applications/${app.id}`, { name: 'Linked app', supplierId: sup.id });
    expect(await refused(dana('POST', '/applications', { name: 'Bad link', supplierId: 'sup_nope' }))).toEqual({ status: 404, code: 'SUPPLIER_NOT_FOUND' });
    const sys = await dana('POST', '/systems', { name: 'linked-host', kind: 'vm', vendor: 'text', supplierId: sup.id });
    expect(sys.supplier.id).toBe(sup.id);
    const ticket = await dana('POST', '/ticket-references', { source: 'vendor', externalNumber: 'LS-100', title: 'Slow', vendor: 'LS', supplierId: sup.id });
    expect(ticket.supplier.id).toBe(sup.id);
    // cost plan lines: the supplier and the contract that pays for it
    const service = await dana('POST', '/services', { name: 'Linked service', owners: [] });
    const fiscalYear = new Date().getFullYear();
    const base = { title: 'Licence', category: 'licence', amount: '1200', currency: 'EUR', cadence: 'yearly' };
    expect(
      await refused(
        dana('POST', `/costs/plans/${service.id}/lines`, {
          ...base,
          fiscalYear,
          supplierId: sup.id,
          supplierContractId: (await dana('POST', '/suppliers', { name: 'Other' })).id,
        }),
      ),
    ).toEqual({ status: 404, code: 'SUPPLIER_CONTRACT_NOT_FOUND' });
    expect(await refused(dana('POST', `/costs/plans/${service.id}/lines`, { ...base, fiscalYear, supplierContractId: contractId }))).toEqual({
      status: 400,
      code: 'SUPPLIER_CONTRACT_WITHOUT_SUPPLIER',
    });
    const y = await dana('POST', `/costs/plans/${service.id}/lines`, { ...base, fiscalYear, vendor: 'LS', supplierId: sup.id, supplierContractId: contractId });
    const line = y.lines.find((l: any) => l.title === 'Licence');
    expect(line).toMatchObject({ vendor: 'LS', supplier: { id: sup.id }, supplierContract: { id: contractId, title: 'Subscription', reference: 'LS-9' } });
    // a duty can name the supplier it reviews
    const duty = await dana('POST', '/duties', {
      serviceId: service.id,
      processId: 'aws-iam-key-age',
      name: 'Supplier review: Linked Supplier',
      interval: 'yearly',
      level: 'mandatory',
      supplierId: sup.id,
    });
    expect(duty.supplier).toMatchObject({ id: sup.id });
    // the supplier page shows what links it, the contract's line and the duty
    const d = await vera('GET', `/suppliers/${sup.id}`);
    expect(d.usedBy.map((u: any) => u.kind).sort()).toEqual(['application', 'costPlanLine', 'duty', 'system', 'ticket']);
    expect(d.usage).toMatchObject({ application: 1, system: 1, ticket: 1, costPlanLine: 1, duty: 1, watch: 0 });
    expect(d.contracts[0].costPlanLines).toEqual([expect.objectContaining({ id: line.id, serviceName: 'Linked service', title: 'Licence' })]);
    expect(d.duties).toEqual([expect.objectContaining({ id: duty.id, name: 'Supplier review: Linked Supplier' })]);
    // removing the contract keeps the line's supplier
    await dana('DELETE', `/suppliers/${sup.id}/contracts/${contractId}`);
    const y2 = await dana('GET', `/costs/plans/${service.id}?fiscalYear=${fiscalYear}`);
    expect(y2.lines.find((l: any) => l.id === line.id)).toMatchObject({ supplier: { id: sup.id }, supplierContract: null });
  });

  it('derives the criticality from the protection need of the linked applications', async () => {
    const app = await dana('POST', '/applications', { name: 'Rated linked app', supplierId: sup.id });
    await dana('PUT', `/applications/${app.id}/rating`, { confidentiality: { level: 'high', justification: 'x' } });
    const d = await dana('GET', `/suppliers/${sup.id}`);
    expect(d.criticality.confidentiality).toMatchObject({ level: 'high' });
  });
});

describe('team scope', () => {
  it('a supplier owned by a team is unknown to those outside it (auditors read it)', async () => {
    const team = await s.api('POST', '/teams', { name: 'Supplier team', members: ['olivia'] });
    const scoped = await dana('POST', '/suppliers', { name: 'Team Supplier' });
    await s.api('PUT', `/owning-teams/supplier/${scoped.id}`, { teamIds: [team.id] });
    expect((await refused(vera('GET', `/suppliers/${scoped.id}`)))?.status).toBe(404);
    expect((await vera('GET', '/suppliers')).map((x: any) => x.id)).not.toContain(scoped.id);
    expect((await olivia('GET', `/suppliers/${scoped.id}`)).name).toBe('Team Supplier');
    expect((await audrey('GET', `/suppliers/${scoped.id}`)).name).toBe('Team Supplier');
    // a supplier the reader may not see cannot be linked (it reads as missing)
    expect(await refused(dana('POST', '/ticket-references', { source: 'vendor', externalNumber: 'TS-1', title: 'x', supplierId: scoped.id }))).toEqual({
      status: 404,
      code: 'SUPPLIER_NOT_FOUND',
    });
    // its name cannot be taken, but the refusal neither names nor links it (security review 0.17.0)
    const taken = await dana('POST', '/suppliers', { name: 'team supplier' }).then(
      () => null,
      (e: { status: number; body: any }) => ({ status: e.status, body: typeof e.body === 'string' ? JSON.parse(e.body) : e.body }),
    );
    expect(taken).toMatchObject({ status: 409, body: { code: 'SUPPLIER_NAME_TAKEN' } });
    expect(JSON.stringify(taken)).not.toContain(scoped.id);
    expect(JSON.stringify(taken)).not.toContain('Team Supplier');
    const own = await dana('POST', '/suppliers', { name: 'Not the team supplier' });
    expect(await refused(dana('PUT', `/suppliers/${own.id}`, { name: 'Team Supplier' }))).toEqual({ status: 409, code: 'SUPPLIER_NAME_TAKEN' });
    // whoever may see it is told which supplier has the name
    expect(await refused(s.api('POST', '/suppliers', { name: 'Team supplier' }))).toEqual({ status: 409, code: 'SUPPLIER_EXISTS' });
  });
});

describe('reminders', () => {
  it('reminds the owners 90 and 30 days before a certificate runs out and a notice-by date, once each', async () => {
    const { checkSupplierReminders } = await import('../src/suppliers/jobs.js');
    const { supplierToday } = await import('../src/suppliers/service.js');
    const today = supplierToday();
    const sup = await dana('POST', '/suppliers', { name: 'Reminder Supplier', owners: ['user:olivia'] });
    await dana('POST', `/suppliers/${sup.id}/certificates`, { kind: 'iso27001', validUntil: addDays(today, 20) });
    await dana('POST', `/suppliers/${sup.id}/contracts`, { title: 'Reminder contract', endsOn: addDays(today, 120), noticeDays: 60 });
    const first = checkSupplierReminders();
    expect(first).toBeGreaterThanOrEqual(2);
    expect(checkSupplierReminders()).toBe(0);
    const notes = (await olivia('GET', '/notifications')) as any;
    const list = (notes.items ?? notes) as any[];
    const mine = list.filter((n) => String(n.link ?? '').includes(sup.id));
    expect(mine.map((n) => n.event).sort()).toEqual(['supplier.certificate_expiring', 'supplier.notice_due']);
    expect(mine.find((n) => n.event === 'supplier.certificate_expiring').title).toContain('20 days');
    // the reminders of the passed thresholds count as sent: 60 days later nothing comes again for the notice
    const { db } = await import('../src/db.js');
    const keys = db()
      .all<{ reminder_key: string }>(
        'SELECT reminder_key FROM supplier_reminders r JOIN supplier_certificates c ON c.id = r.item_id WHERE c.supplier_id = ?',
        sup.id,
      )
      .map((r) => r.reminder_key)
      .sort();
    expect(keys).toEqual([`${addDays(today, 20)}:30`, `${addDays(today, 20)}:90`]);
    // unconfirmed suppliers do not remind
    const { insertSupplier } = await import('../src/suppliers/service.js');
    const un = insertSupplier({ name: 'Unconfirmed Reminder', status: 'unconfirmed' }, 'system');
    db().run(
      "INSERT INTO supplier_certificates (id, supplier_id, kind, valid_until, created_at, updated_at) VALUES ('scf_unconf', ?, 'iso27001', ?, 'now', 'now')",
      un,
      addDays(today, 10),
    );
    expect(checkSupplierReminders()).toBe(0);
  });
});

describe('the public API, MCP and the dataset', () => {
  it('leave out the e-mail and phone of contacts', async () => {
    const sup = await dana('POST', '/suppliers', { name: 'Public Supplier', type: 'saas' });
    await dana('POST', `/suppliers/${sup.id}/contacts`, {
      name: 'Robin Example',
      role: 'support',
      email: 'robin@public-supplier.example',
      phone: '+1 555 0100',
    });
    await dana('POST', `/suppliers/${sup.id}/certificates`, { kind: 'iso27001', validUntil: addDays(new Date().toISOString().slice(0, 10), 45) });
    const token = (await vera('POST', '/me/tokens', { name: 'suppliers', scope: 'read' })).token;
    const get = async (path: string) => {
      const res = await fetch(`${s.base}/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } });
      return { status: res.status, text: await res.text() };
    };
    const list = await get('/suppliers?limit=200');
    expect(list.status).toBe(200);
    expect(JSON.parse(list.text).items.map((x: any) => x.name)).toContain('Public Supplier');
    const one = await get(`/suppliers/${sup.id}`);
    expect(one.status).toBe(200);
    const body = JSON.parse(one.text);
    expect(body.contacts).toEqual([expect.objectContaining({ name: 'Robin Example', role: 'support' })]);
    expect(body.contacts[0].email).toBeUndefined();
    expect(body.canEdit).toBeUndefined();
    expect(one.text).not.toContain('robin@');
    expect(one.text).not.toContain('0100');
    expect((await get('/suppliers/sup_nope')).status).toBe(404);
    // the app's route gives an API token the same (security review 0.17.0): no e-mail or phone of contacts
    const app = await fetch(`${s.base}/api/suppliers/${sup.id}`, { headers: { authorization: `Bearer ${token}` } });
    expect(app.status).toBe(200);
    const appText = await app.text();
    expect(JSON.parse(appText).contacts).toEqual([expect.objectContaining({ name: 'Robin Example', role: 'support' })]);
    expect(appText).not.toContain('robin@');
    expect(appText).not.toContain('0100');
    expect((await vera('GET', `/suppliers/${sup.id}`)).contacts[0].email).toBe('robin@public-supplier.example');
    // and changes nothing: every change, also marking a certificate as looked at, is a decision in a session
    const write = (await dana('POST', '/me/tokens', { name: 'suppliers-write', scope: 'full' })).token as string;
    const send = (method: string, path: string, body: unknown) =>
      fetch(`${s.base}/api${path}`, { method, headers: { authorization: `Bearer ${write}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const certId = (await dana('GET', `/suppliers/${sup.id}`)).certificates[0].id;
    for (const [method, path, body] of [
      ['POST', '/suppliers', { name: 'By token' }],
      ['PUT', `/suppliers/${sup.id}`, { name: 'Public Supplier', type: 'saas' }],
      ['POST', `/suppliers/${sup.id}/contacts`, { name: 'Token contact', role: 'support' }],
      ['POST', `/suppliers/${sup.id}/contracts`, { title: 'Token contract' }],
      ['PUT', `/suppliers/${sup.id}/certificates/${certId}`, { kind: 'iso27001', checked: true }],
    ] as const) {
      const res = await send(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    expect((await dana('GET', `/suppliers/${sup.id}`)).certificates[0].checkedBy).toBeNull();
    // MCP
    await s.api('PUT', '/mcp-server', { enabled: true });
    const mcpToken = (await vera('POST', '/me/tokens', { name: 'suppliers-mcp', scope: 'mcp' })).token;
    const listed = await mcp(mcpToken, 'list_suppliers', { query: 'public' });
    expect(listed.data.items.map((x: any) => x.name)).toEqual(['Public Supplier']);
    const got = await mcp(mcpToken, 'get_supplier', { supplierId: sup.id });
    expect(got.isError).toBe(false);
    expect(got.data.contacts[0]).toMatchObject({ name: 'Robin Example' });
    expect(got.text).not.toContain('robin@');
    expect((await mcp(mcpToken, 'get_supplier', { supplierId: 'sup_nope' })).isError).toBe(true);
    // the dataset: administrators and auditors
    const { publishSuppliersDataset } = await import('../src/suppliers/jobs.js');
    expect(publishSuppliersDataset()).toBe(true);
    const ds = await audrey('GET', '/datasets/suppliers.expiring');
    expect(ds.rows.find((r: any) => r.Supplier === 'Public Supplier')).toMatchObject({ Kind: 'certificate', Item: 'iso27001' });
    expect(JSON.stringify(ds)).not.toContain('robin@');
    expect((await refused(vera('GET', '/datasets/suppliers.expiring')))?.status).toBe(404);
  });
});

describe('personal data', () => {
  it('lists the suppliers a person made and owns, and keeps the user name after pseudonymisation', async () => {
    const created = await s.api('POST', '/users', {
      username: 'sam.supplier',
      displayName: 'Sam Supplier',
      roles: ['designer'],
      password: 'Sam-password-12345',
    });
    const first = await s.as('sam.supplier', 'Sam-password-12345');
    await first('POST', '/auth/password', { current: 'Sam-password-12345', next: 'Sam-password-12345-2' });
    const sam = await s.as('sam.supplier', 'Sam-password-12345-2');
    const sup = await sam('POST', '/suppliers', { name: 'Sam’s Supplier', owners: ['user:sam.supplier'] });
    const data = await sam('GET', '/me/data-export');
    expect(data.activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: 'suppliers', column: 'created_by', kind: 'history' }),
        expect.objectContaining({ table: 'suppliers', column: 'owners', kind: 'current', rows: [expect.objectContaining({ label: 'Sam’s Supplier' })] }),
      ]),
    );
    await s.api('PUT', `/users/${created.user.id}`, { active: false });
    await s.api('POST', `/users/${created.user.id}/pseudonymise`, { confirm: 'sam.supplier' });
    // who made it is history: the user name stays
    expect(await s.api('GET', `/suppliers/${sup.id}`)).toMatchObject({ createdBy: 'sam.supplier', owners: ['user:sam.supplier'] });
  });
});
