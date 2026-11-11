import { beforeAll, describe, expect, it } from 'vitest';
import { contractReaders } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Contracts with their own scope (0.18.0, ADR 0031 parts 1–2): owners and covered services; who sees a contract
 * (team-owned: its owners, the readers of its services, administrators and auditors) and who changes it (the rights
 * table); the paying service of a payment schedule must be covered; "a contract you may not see" where a hidden
 * contract is named, the link kept on save; the list over visible contracts; /api/v1, MCP and the dataset without
 * hidden contracts and services; audit; session-only writes; limits.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Demo-password-1';
let dana: Client, olivia: Client, vera: Client, audrey: Client, bert: Client, erik: Client;
const refused = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { status: number; body: any }) => ({ status: e.status, code: (typeof e.body === 'string' ? JSON.parse(e.body) : e.body)?.code }),
  );
const auditOf = (id: string) => s.api('GET', `/audit?entityType=supplier&entityId=${id}&limit=200`);

let supplier: string;
let shopTeam: string, careTeam: string;
let svcShop: string, svcCare: string, svcOps: string;
let hosting: string, licences: string, open: string;

const contractsOf = async (c: Client) => ((await c('GET', `/suppliers/${supplier}`)) as any).contracts.map((x: any) => x.title).sort();

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [dana, olivia, vera, audrey] = await Promise.all(['dana', 'olivia', 'vera', 'audrey'].map((u) => s.as(u, PW)));
  const users = await import('../src/auth/users.js');
  for (const u of ['bert', 'erik'])
    users.createUser({ username: u, roles: ['operator'], password: `${u[0]!.toUpperCase()}${u.slice(1)}-password-123`, mustChangePassword: false });
  bert = await s.as('bert', 'Bert-password-123');
  erik = await s.as('erik', 'Erik-password-123');
  shopTeam = (await s.api('POST', '/teams', { name: 'Shop team', members: ['olivia'] })).id;
  careTeam = (await s.api('POST', '/teams', { name: 'Care team', members: ['bert'] })).id;
  // the online shop (Shop team) and customer care (Care team); an operations service of the whole instance (erik)
  svcShop = (await s.api('POST', '/services', { name: 'Scope online shop', owners: ['user:olivia'] })).id;
  svcCare = (await s.api('POST', '/services', { name: 'Scope customer care', owners: ['user:bert'] })).id;
  svcOps = (await s.api('POST', '/services', { name: 'Scope operations', owners: ['user:erik'] })).id;
  await s.api('PUT', `/owning-teams/service/${svcShop}`, { teamIds: [shopTeam] });
  await s.api('PUT', `/owning-teams/service/${svcCare}`, { teamIds: [careTeam] });
  // a shared supplier: made by a designer without teams, so it belongs to the whole instance
  supplier = (await dana('POST', '/suppliers', { name: 'Invented Shared Platform AG', type: 'managedPlatform' })).id;
}, 240_000);

describe('the visibility rule', () => {
  it('reads a contract without a team owner like its supplier, a team-owned one only for its owners, services, admins and auditors', () => {
    const r = { seesSupplier: true, admin: false, auditor: false, owner: false, seesCoveredService: false };
    expect(contractReaders({ owners: [] }, r)).toBe('supplierReaders');
    expect(contractReaders({ owners: ['user:dana'] }, r)).toBe('supplierReaders');
    expect(contractReaders({ owners: ['team:shop'] }, r)).toBeNull();
    expect(contractReaders({ owners: ['team:shop'] }, { ...r, owner: true })).toBe('owner');
    expect(contractReaders({ owners: ['team:shop'] }, { ...r, seesCoveredService: true })).toBe('service');
    expect(contractReaders({ owners: ['team:shop'] }, { ...r, admin: true })).toBe('admin');
    expect(contractReaders({ owners: ['team:shop'] }, { ...r, auditor: true })).toBe('auditor');
    // never without the supplier
    expect(contractReaders({ owners: [] }, { ...r, seesSupplier: false, admin: true })).toBeNull();
  });
});

describe('contracts with owners and covered services', () => {
  it('lets the editor of a service add a contract covering it; owners default to the creator and their teams', async () => {
    // olivia is neither a designer nor an owner of the supplier, but edits the online shop and sees the supplier
    const d = await olivia('GET', `/suppliers/${supplier}`);
    expect(d).toMatchObject({ canEdit: false, canAddContract: true });
    await olivia('POST', `/suppliers/${supplier}/contracts`, {
      title: 'Hosting of the shop',
      reference: 'HS-1',
      endsOn: '2031-12-31',
      noticeDays: 90,
      services: [{ serviceId: svcShop, purpose: 'Hosting of the shop’s clusters' }],
    });
    const c = (await olivia('GET', `/suppliers/${supplier}`)).contracts.find((x: any) => x.title === 'Hosting of the shop');
    hosting = c.id;
    expect(c.owners).toEqual(expect.arrayContaining(['user:olivia', 'team:shop team']));
    expect(c).toMatchObject({ teamOwned: true, canEdit: true, readReason: 'owner', hiddenServices: 0 });
    expect(c.services).toEqual([expect.objectContaining({ id: svcShop, purpose: 'Hosting of the shop’s clusters', status: 'confirmed', canChange: true })]);
    // bert adds the licences of customer care
    await bert('POST', `/suppliers/${supplier}/contracts`, { title: 'Agent licences', services: [{ serviceId: svcCare, purpose: 'Licences for 40 agents' }] });
    licences = (await bert('GET', `/suppliers/${supplier}`)).contracts.find((x: any) => x.title === 'Agent licences').id;
    // a contract with only a user owner is seen like its supplier
    await dana('POST', `/suppliers/${supplier}/contracts`, { title: 'Company agreement', owners: ['user:dana'] });
    open = (await dana('GET', `/suppliers/${supplier}`)).contracts.find((x: any) => x.title === 'Company agreement').id;
  });

  it('refuses a contract to who edits no service it covers and does not change the supplier', async () => {
    expect(await refused(vera('POST', `/suppliers/${supplier}/contracts`, { title: 'x' }))).toEqual({ status: 403, code: 'FORBIDDEN' });
    // a service olivia does not edit
    expect(await refused(olivia('POST', `/suppliers/${supplier}/contracts`, { title: 'x', services: [{ serviceId: svcOps }] }))).toEqual({
      status: 403,
      code: 'FORBIDDEN',
    });
    // a service she may not see reads as missing
    expect(await refused(olivia('POST', `/suppliers/${supplier}/contracts`, { title: 'x', services: [{ serviceId: svcCare }] }))).toEqual({
      status: 404,
      code: 'SERVICE_NOT_FOUND',
    });
  });

  it('shows each team its own contracts; others see the supplier but not that the contract exists', async () => {
    expect(await contractsOf(olivia)).toEqual(['Company agreement', 'Hosting of the shop']);
    expect(await contractsOf(bert)).toEqual(['Agent licences', 'Company agreement']);
    expect(await contractsOf(vera)).toEqual(['Company agreement']);
    // a designer who may change the supplier does not see the teams' contracts (decided 14)
    expect(await contractsOf(dana)).toEqual(['Company agreement']);
    expect(await contractsOf(audrey)).toEqual(['Agent licences', 'Company agreement', 'Hosting of the shop']);
    expect(await contractsOf(s.api)).toEqual(['Agent licences', 'Company agreement', 'Hosting of the shop']);
    // the list counts visible contracts only
    const listed = (await vera('GET', '/suppliers')).find((x: any) => x.id === supplier);
    expect(listed.contractCount).toBe(1);
    // the contract page: 404 for who may not see it
    expect(await refused(vera('GET', `/suppliers/${supplier}/contracts/${hosting}`))).toEqual({ status: 404, code: 'SUPPLIER_CONTRACT_NOT_FOUND' });
    const page = await olivia('GET', `/suppliers/${supplier}/contracts/${hosting}`);
    expect(page.visibility).toMatchObject({ open: false, teams: ['shop team'], users: ['olivia'] });
    expect(page.visibility.services.map((x: any) => x.id)).toEqual([svcShop]);
  });

  it('counts the covered services a reader may not see only for who may change the contract, without names', async () => {
    await s.api('PUT', `/suppliers/${supplier}/contracts/${hosting}/services/${svcCare}`, { purpose: 'Chat widget' });
    const c = (await olivia('GET', `/suppliers/${supplier}/contracts/${hosting}`)).contract;
    expect(c.services.map((x: any) => x.id)).toEqual([svcShop]);
    expect(c.hiddenServices).toBe(1);
    expect(JSON.stringify(c)).not.toContain('Chat widget');
    // bert now sees the contract through customer care, but may not change it: he sees no hidden-service count
    const b = (await bert('GET', `/suppliers/${supplier}/contracts/${hosting}`)).contract;
    expect(b).toMatchObject({ readReason: 'service', canEdit: false, hiddenServices: 0 });
    expect(b.services.find((x: any) => x.id === svcCare)).toMatchObject({ canChange: true });
    // he may change his own service's purpose and leave the contract, not its terms
    await bert('PUT', `/suppliers/${supplier}/contracts/${hosting}/services/${svcCare}`, { purpose: 'Chat widget on the shop' });
    expect(await refused(bert('PUT', `/suppliers/${supplier}/contracts/${hosting}`, { title: 'Hosting changed' }))).toEqual({ status: 403, code: 'FORBIDDEN' });
    expect(await refused(bert('PUT', `/suppliers/${supplier}/contracts/${hosting}/services/${svcShop}`, { purpose: 'x' }))).toEqual({
      status: 404,
      code: 'SERVICE_NOT_FOUND',
    });
    const left = await bert('DELETE', `/suppliers/${supplier}/contracts/${hosting}/services/${svcCare}`);
    // he no longer sees the contract
    expect(left).toEqual({ ok: true });
    expect(await refused(bert('GET', `/suppliers/${supplier}/contracts/${hosting}`))).toEqual({ status: 404, code: 'SUPPLIER_CONTRACT_NOT_FOUND' });
    const actions = (await auditOf(supplier)).map((a: any) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(['supplier.contract_service_added', 'supplier.contract_service_changed', 'supplier.contract_service_removed']),
    );
  });

  it('lets an editor of a covered service change the contract only when they see every service it covers', async () => {
    // a contract of the Care team covering the operations service (erik) and customer care
    await bert('POST', `/suppliers/${supplier}/contracts`, {
      title: 'Monitoring',
      owners: ['team:care team'],
      services: [
        { serviceId: svcCare, purpose: 'Monitoring of customer care' },
        { serviceId: svcOps, purpose: 'Monitoring of operations' },
      ],
    });
    const id = (await bert('GET', `/suppliers/${supplier}`)).contracts.find((x: any) => x.title === 'Monitoring').id;
    const e = (await erik('GET', `/suppliers/${supplier}/contracts/${id}`)).contract;
    expect(e).toMatchObject({ readReason: 'service', canEdit: false });
    expect(await refused(erik('PUT', `/suppliers/${supplier}/contracts/${id}`, { title: 'Monitoring', noticeDays: 30 }))).toEqual({
      status: 403,
      code: 'FORBIDDEN',
    });
    // adding a service needs sight of it and the right to change the contract
    expect(await refused(erik('PUT', `/suppliers/${supplier}/contracts/${id}/services/${svcShop}`, {}))).toEqual({ status: 404, code: 'SERVICE_NOT_FOUND' });
    // once customer care leaves, erik sees every service it covers and may change it
    await bert('DELETE', `/suppliers/${supplier}/contracts/${id}/services/${svcCare}`);
    expect((await erik('GET', `/suppliers/${supplier}/contracts/${id}`)).contract.canEdit).toBe(true);
    await erik('PUT', `/suppliers/${supplier}/contracts/${id}`, { title: 'Monitoring', noticeDays: 30 });
  });

  it('asks before the last team leaves the owners, and then opens the contract to the readers of the supplier', async () => {
    expect(await refused(olivia('PUT', `/suppliers/${supplier}/contracts/${hosting}`, { title: 'Hosting of the shop', owners: ['user:olivia'] }))).toEqual({
      status: 409,
      code: 'SUPPLIER_CONTRACT_OPENS',
    });
    await olivia('PUT', `/suppliers/${supplier}/contracts/${hosting}`, { title: 'Hosting of the shop', owners: ['user:olivia'], confirmOpen: true });
    expect(await contractsOf(vera)).toContain('Hosting of the shop');
    const changed = (await auditOf(supplier)).find((a: any) => a.action === 'supplier.contract_changed' && a.details.contractId === hosting);
    expect(changed.details.old.owners).toEqual(expect.arrayContaining(['team:shop team']));
    expect(changed.details.new.owners).toEqual(['user:olivia']);
    // and back to the team
    await olivia('PUT', `/suppliers/${supplier}/contracts/${hosting}`, { title: 'Hosting of the shop', owners: ['user:olivia', 'team:shop team'] });
    expect(await contractsOf(vera)).not.toContain('Hosting of the shop');
    // unknown owners are refused
    expect(await refused(olivia('PUT', `/suppliers/${supplier}/contracts/${hosting}`, { title: 'x', owners: ['team:nobody'] }))).toEqual({
      status: 400,
      code: 'TEAM_UNKNOWN',
    });
  });

  it('counts a proposed covered service for reading, not for changing; a person confirms or dismisses it', async () => {
    const { db } = await import('../src/db.js');
    db().run(
      "INSERT INTO supplier_contract_services (contract_id, service_id, purpose, status, proposed_from, added_by, added_at) VALUES (?, ?, '', 'proposed', '[\"costPlanLine\"]', 'system', ?)",
      licences,
      svcOps,
      new Date().toISOString(),
    );
    const e = (await erik('GET', `/suppliers/${supplier}/contracts/${licences}`)).contract;
    expect(e).toMatchObject({ readReason: 'service', canEdit: false });
    expect(e.services.find((x: any) => x.id === svcOps)).toMatchObject({ status: 'proposed', proposedFrom: ['costPlanLine'], canChange: true });
    // the service's editor confirms it – still no right to change the contract (he does not see customer care)
    await erik('PUT', `/suppliers/${supplier}/contracts/${licences}/services/${svcOps}`, { confirm: true });
    expect((await erik('GET', `/suppliers/${supplier}/contracts/${licences}`)).contract.services.find((x: any) => x.id === svcOps).status).toBe('confirmed');
    // the service page lists it
    const sc = await erik('GET', `/services/${svcOps}/contracts`);
    expect(sc.contracts.map((x: any) => x.contract.title)).toContain('Agent licences');
    // "Not this service" for another proposal
    db().run(
      "INSERT INTO supplier_contract_services (contract_id, service_id, purpose, status, proposed_from, added_by, added_at) VALUES (?, ?, '', 'proposed', '[\"responsibility\"]', 'system', ?)",
      open,
      svcOps,
      new Date().toISOString(),
    );
    await erik('DELETE', `/suppliers/${supplier}/contracts/${open}/services/${svcOps}`);
    const actions = (await auditOf(supplier)).map((a: any) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['supplier.contract_service_confirmed', 'supplier.contract_service_dismissed']));
  });
});

describe('payment schedules and the covered services', () => {
  const base = { title: 'Licence fee', category: 'licence', amount: '100', currency: 'EUR', billing: 'monthly', yearAmounts: [] };

  it('needs the paying service covered: a schedule for another service adds it only for who may change the contract', async () => {
    // erik edits operations and sees the licences contract (confirmed above): his service pays
    await erik('POST', '/costs/schedules', { ...base, contractId: licences, serviceId: svcOps });
    // the online shop is not covered by the company agreement: olivia may not change it (dana's)
    expect(await refused(olivia('POST', '/costs/schedules', { ...base, contractId: open, serviceId: svcShop }))).toEqual({
      status: 409,
      code: 'COST_SCHEDULE_SERVICE_NOT_COVERED',
    });
    // dana may change it: the schedule adds the service
    await s.api('POST', '/costs/schedules', { ...base, contractId: open, serviceId: svcShop });
    const page = await olivia('GET', `/suppliers/${supplier}/contracts/${open}`);
    expect(page.contract.services.map((x: any) => x.id)).toContain(svcShop);
  });

  it('refuses to take off a service that pays a schedule of the contract', async () => {
    expect(await refused(erik('DELETE', `/suppliers/${supplier}/contracts/${licences}/services/${svcOps}`))).toEqual({
      status: 409,
      code: 'SUPPLIER_CONTRACT_SERVICE_HAS_SCHEDULES',
    });
  });

  it('shows on the contract only the schedules of services the reader sees', async () => {
    const asErik = await erik('GET', `/costs/schedules?contractId=${licences}`);
    expect(asErik.schedules.map((x: any) => x.serviceId)).toEqual([svcOps]);
    // bert (owner of the contract) does not see operations? he does: it belongs to the whole instance
    const asBert = await bert('GET', `/costs/schedules?contractId=${licences}`);
    expect(asBert.schedules.map((x: any) => x.serviceId)).toEqual([svcOps]);
    // commitments grouped by supplier: a schedule of a contract the reader may not see is neither named nor counted
    await olivia('POST', '/costs/schedules', { ...base, title: 'Hosting fee', contractId: hosting, serviceId: svcShop });
    const asOlivia = await olivia('GET', `/costs/commitments?supplierId=${supplier}`);
    expect(asOlivia.rows.map((r: any) => r.title)).toContain('Hosting fee');
    const c = await vera('GET', `/costs/commitments?supplierId=${supplier}`);
    expect(c.rows.map((r: any) => r.title)).not.toContain('Hosting fee');
    expect(c.rows.every((r: any) => r.contract && r.contract.id !== hosting)).toBe(true);
  });
});

describe('a contract you may not see, named elsewhere', () => {
  let careTools = '';
  it('shows plan lines without the contract, keeps the link on save, and says so under Used by', async () => {
    // a contract of the Care team only: olivia may not see it
    await bert('POST', `/suppliers/${supplier}/contracts`, { title: 'Care tools', services: [{ serviceId: svcCare }] });
    careTools = (await bert('GET', `/suppliers/${supplier}`)).contracts.find((x: any) => x.title === 'Care tools').id;
    const licences = careTools;
    // an administrator names it on a plan line of the online shop (adds the shop to it) …
    const y = await s.api('POST', `/costs/plans/${svcShop}/lines`, {
      fiscalYear: 2031,
      title: 'Shared licences',
      category: 'licence',
      currency: 'EUR',
      amount: '10',
      cadence: 'monthly',
      supplierId: supplier,
      supplierContractId: licences,
    });
    const line = y.lines.find((l: any) => l.title === 'Shared licences');
    // … and takes the shop off the contract again
    await s.api('DELETE', `/suppliers/${supplier}/contracts/${licences}/services/${svcShop}`);
    const asOlivia = await olivia('GET', `/costs/plans/${svcShop}?fiscalYear=2031`);
    const l = asOlivia.lines.find((x: any) => x.id === line.id);
    expect(l).toMatchObject({ supplier: { id: supplier }, supplierContract: null, supplierContractHidden: true });
    // saving the line keeps the link she may not see
    await olivia('PUT', `/costs/plans/${svcShop}/lines/${line.id}`, {
      title: 'Shared licences',
      category: 'licence',
      currency: 'EUR',
      amount: '12',
      cadence: 'monthly',
      supplierId: supplier,
    });
    const { db } = await import('../src/db.js');
    expect(db().get<{ c: string }>('SELECT supplier_contract_id AS c FROM cost_plan_lines WHERE id = ?', line.id)!.c).toBe(licences);
    // but she cannot choose it anew
    expect(
      await refused(
        olivia('POST', `/costs/plans/${svcShop}/lines`, {
          fiscalYear: 2031,
          title: 'Another line',
          category: 'licence',
          currency: 'EUR',
          amount: '1',
          cadence: 'monthly',
          supplierId: supplier,
          supplierContractId: licences,
        }),
      ),
    ).toEqual({ status: 404, code: 'SUPPLIER_CONTRACT_NOT_FOUND' });
    // the administrator sees the contract, and that it no longer covers the shop
    const asAdmin = await s.api('GET', `/costs/plans/${svcShop}?fiscalYear=2031`);
    expect(asAdmin.lines.find((x: any) => x.id === line.id)).toMatchObject({
      supplierContract: { id: careTools },
      supplierContractHidden: false,
      supplierContractUncovered: true,
    });
  });

  it('adds the service to a newly chosen contract when the person may, else refuses', async () => {
    // olivia owns the hosting contract: choosing it for an operations line? she does not edit operations – use the shop
    const y = await olivia('POST', `/costs/plans/${svcShop}/lines`, {
      fiscalYear: 2031,
      title: 'Company agreement share',
      category: 'support',
      currency: 'EUR',
      amount: '5',
      cadence: 'monthly',
      supplierId: supplier,
      supplierContractId: hosting,
    });
    expect(y.lines.find((l: any) => l.title === 'Company agreement share').supplierContract.id).toBe(hosting);
    // erik may not add operations to the hosting contract (he does not see it)
    expect(
      await refused(
        erik('POST', `/costs/plans/${svcOps}/lines`, {
          fiscalYear: 2031,
          title: 'x',
          category: 'support',
          currency: 'EUR',
          amount: '5',
          cadence: 'monthly',
          supplierId: supplier,
          supplierContractId: hosting,
        }),
      ),
    ).toEqual({ status: 404, code: 'SUPPLIER_CONTRACT_NOT_FOUND' });
    // a contract he sees but may not change, not covering his service: refused
    await s.api('POST', `/suppliers/${supplier}/contracts`, { title: 'Care add-on', owners: ['team:care team'], services: [{ serviceId: svcOps }] });
    const addOn = (await s.api('GET', `/suppliers/${supplier}`)).contracts.find((x: any) => x.title === 'Care add-on').id;
    await s.api('PUT', `/suppliers/${supplier}/contracts/${addOn}/services/${svcCare}`, {});
    const svcOps2 = (await s.api('POST', '/services', { name: 'Scope operations two', owners: ['user:erik'] })).id;
    expect(
      await refused(
        erik('POST', `/costs/plans/${svcOps2}/lines`, {
          fiscalYear: 2031,
          title: 'x',
          category: 'support',
          currency: 'EUR',
          amount: '5',
          cadence: 'monthly',
          supplierId: supplier,
          supplierContractId: addOn,
        }),
      ),
    ).toEqual({ status: 409, code: 'SUPPLIER_CONTRACT_NOT_COVERING' });
  });

  it('lists items naming a hidden contract under Used by with the neutral note', async () => {
    const used = (await olivia('GET', `/suppliers/${supplier}`)).usedBy.find((u: any) => u.kind === 'costPlanLine' && u.name === 'Shared licences');
    expect(used).toMatchObject({ contract: null, contractHidden: true });
  });
});

describe('the public API, MCP and the dataset', () => {
  it('lists only the contracts and covered services the token owner may see, without counts of others', async () => {
    const { token } = await vera('POST', '/me/tokens', { name: 'scope read', scope: 'read' });
    const res = await fetch(`${s.base}/api/v1/suppliers/${supplier}`, { headers: { authorization: `Bearer ${token}` } });
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.contracts.map((c: any) => c.title)).not.toContain('Hosting of the shop');
    expect(body.contracts.map((c: any) => c.title)).not.toContain('Care tools');
    // the licences contract covers operations (whole instance): she sees it, but not customer care
    const lic = body.contracts.find((c: any) => c.title === 'Agent licences');
    expect(lic.services.map((x: any) => x.id)).toEqual([svcOps]);
    for (const c of body.contracts) {
      expect(c).not.toHaveProperty('hiddenServices');
      expect(c).not.toHaveProperty('canEdit');
      for (const x of c.services) expect(Object.keys(x).sort()).toEqual(['id', 'name', 'purpose', 'status']);
    }
    const sc = await fetch(`${s.base}/api/v1/services/${svcOps}/contracts`, { headers: { authorization: `Bearer ${token}` } });
    expect(sc.status).toBe(200);
    const list = (await sc.json()) as any;
    // operations is covered by the team-owned licences contract: vera reads operations, so she sees it
    expect(list.contracts.map((x: any) => x.contract.title)).toContain('Agent licences');
    const hidden = await fetch(`${s.base}/api/v1/services/${svcShop}/contracts`, { headers: { authorization: `Bearer ${token}` } });
    expect(hidden.status).toBe(404);
  });

  it('writes the contract owners and services into the dataset', async () => {
    await s.api('PUT', `/suppliers/${supplier}/contracts/${hosting}`, {
      title: 'Hosting of the shop',
      endsOn: new Date(Date.now() + 100 * 86400000).toISOString().slice(0, 10),
      noticeDays: 30,
    });
    const { publishSuppliersDataset } = await import('../src/suppliers/jobs.js');
    publishSuppliersDataset();
    const ds = await s.api('GET', '/datasets/suppliers.expiring');
    const row = (ds.rows ?? ds.data?.rows ?? []).find((r: any) => r.Item === 'Hosting of the shop');
    expect(row).toMatchObject({ 'Contract owners': expect.stringContaining('team:shop team') });
    expect(row.Services).toContain('Scope online shop');
  });
});

describe('writes', () => {
  it('need a signed-in session', async () => {
    const { token } = await s.api('POST', '/me/tokens', { name: 'scope full', scope: 'full' });
    const res = await fetch(`${s.base}/api/suppliers/${supplier}/contracts/${hosting}/services/${svcShop}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'x' }),
    });
    expect(res.status).toBe(403);
  });

  it('keep the limits', async () => {
    expect(
      await refused(s.api('POST', `/suppliers/${supplier}/contracts`, { title: 'x', owners: Array.from({ length: 21 }, (_, i) => `user:u${i}`) })),
    ).toMatchObject({ status: 400 });
    expect(await refused(s.api('PUT', `/suppliers/${supplier}/contracts/${open}/services/${svcOps}`, { purpose: 'x'.repeat(201) }))).toMatchObject({
      status: 400,
    });
  });
});
