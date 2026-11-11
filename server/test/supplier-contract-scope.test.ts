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
    // the supplier picker names only the covered services she may see, not even the id of the other
    const option = (await olivia('GET', '/suppliers/options')).find((x: any) => x.id === supplier).contracts.find((x: any) => x.id === hosting);
    expect(option.services).toEqual([svcShop]);
    expect(
      (await s.api('GET', '/suppliers/options'))
        .find((x: any) => x.id === supplier)
        .contracts.find((x: any) => x.id === hosting)
        .services.sort(),
    ).toEqual([svcShop, svcCare].sort());
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
    // an API token never adds a covered service (it widens who sees the contract): only a person in a session does
    const { token } = await s.api('POST', '/me/tokens', { name: 'cover by token', scope: 'full' });
    const send = (url: string, body: unknown) =>
      fetch(s.base + url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const line = { fiscalYear: 2031, title: 'Token line', category: 'support', currency: 'EUR', amount: '5', cadence: 'monthly', supplierId: supplier };
    const res = await send(`/api/costs/plans/${svcOps2}/lines`, { ...line, supplierContractId: hosting });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('SUPPLIER_CONTRACT_COVER_SESSION');
    const entry = await send(`/api/costs/plans/${svcOps2}/entries`, {
      date: '2031-03-01',
      amount: '5',
      currency: 'EUR',
      supplierId: supplier,
      supplierContractId: hosting,
    });
    expect(((await entry.json()) as { code: string }).code).toBe('SUPPLIER_CONTRACT_COVER_SESSION');
    expect((await s.api('GET', `/suppliers/${supplier}/contracts/${hosting}`)).contract.services.map((x: any) => x.id)).not.toContain(svcOps2);
    // a contract covering the service is linked as before
    await s.api('PUT', `/suppliers/${supplier}/contracts/${addOn}/services/${svcOps2}`, {});
    expect((await send(`/api/costs/plans/${svcOps2}/lines`, { ...line, supplierContractId: addOn })).status).toBe(200);
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

describe('master agreements and data protection per contract', () => {
  let sup: string;
  let master: string, orderForm: string;
  const ids = async (title: string) => (await s.api('GET', `/suppliers/${sup}`)).contracts.find((x: any) => x.title === title).id as string;
  const masterTerms = {
    title: 'Framework agreement',
    endsOn: '2030-12-31',
    slaAvailability: 99.9,
    slaSupportHours: '24/7',
    rtoHours: 4,
    rpoHours: 1,
    link: 'https://contracts.example/framework',
  };

  it('lets an order form inherit SLA, RTO/RPO, personal data and the agreement – not dates or the document', async () => {
    sup = (await dana('POST', '/suppliers', { name: 'Invented Framework GmbH', personalData: true, dpaStatus: 'missing' })).id;
    await s.api('POST', `/suppliers/${sup}/contracts`, {
      title: 'Framework agreement',
      endsOn: '2030-12-31',
      slaAvailability: 99.9,
      slaSupportHours: '24/7',
      rtoHours: 4,
      rpoHours: 1,
      personalData: true,
      dpaStatus: 'inPlace',
      dpaSince: '2025-01-01',
      dpaLink: 'https://contracts.example/dpa-framework',
      link: 'https://contracts.example/framework',
    });
    master = await ids('Framework agreement');
    await s.api('POST', `/suppliers/${sup}/contracts`, { title: 'Order form 1', parentId: master, endsOn: '2031-06-30', rtoHours: 8 });
    orderForm = await ids('Order form 1');
    const c = (await s.api('GET', `/suppliers/${sup}/contracts/${orderForm}`)).contract;
    expect(c).toMatchObject({
      parentId: master,
      parent: { id: master, title: 'Framework agreement' },
      slaAvailability: 99.9,
      slaSupportHours: '24/7',
      rtoHours: 8,
      rpoHours: 1,
      link: '',
      endsOn: '2031-06-30',
      endsAfterMaster: true,
      personalData: null,
      dpa: { personalData: true, personalDataFrom: 'master', status: 'inPlace', since: '2025-01-01', inheritedFrom: 'master', missing: false },
    });
    expect(c.inherited.sort()).toEqual(['rpoHours', 'slaAvailability', 'slaSupportHours']);
    // the supplier page lists masters with their order forms
    const page = await s.api('GET', `/suppliers/${sup}`);
    expect(page.contracts.map((x: any) => x.title)).toEqual(['Framework agreement', 'Order form 1']);
    expect(page.contracts[0].orderForms).toEqual([orderForm]);
  });

  it('keeps one level and the same supplier', async () => {
    expect(await refused(s.api('POST', `/suppliers/${sup}/contracts`, { title: 'Deeper', parentId: orderForm }))).toEqual({
      status: 409,
      code: 'SUPPLIER_CONTRACT_MASTER_LEVEL',
    });
    expect(await refused(s.api('PUT', `/suppliers/${sup}/contracts/${master}`, { title: 'Framework agreement', parentId: master }))).toEqual({
      status: 400,
      code: 'SUPPLIER_CONTRACT_MASTER_SELF',
    });
    // a master with order forms cannot become an order form itself
    await s.api('POST', `/suppliers/${sup}/contracts`, { title: 'Another master' });
    const other = await ids('Another master');
    expect(await refused(s.api('PUT', `/suppliers/${sup}/contracts/${master}`, { title: 'Framework agreement', parentId: other }))).toEqual({
      status: 409,
      code: 'SUPPLIER_CONTRACT_MASTER_LEVEL',
    });
    // a contract of another supplier reads as missing
    expect(await refused(s.api('POST', `/suppliers/${supplier}/contracts`, { title: 'x', parentId: master }))).toEqual({
      status: 404,
      code: 'SUPPLIER_CONTRACT_NOT_FOUND',
    });
  });

  it('shows the inherited values of a master the reader may not see, without its title', async () => {
    await s.api('PUT', `/suppliers/${sup}/contracts/${master}`, { ...masterTerms, owners: ['team:care team'] });
    await s.api('PUT', `/suppliers/${sup}/contracts/${orderForm}`, { title: 'Order form 1', parentId: master, endsOn: '2031-06-30', rtoHours: 8 });
    const c = (await vera('GET', `/suppliers/${sup}/contracts/${orderForm}`)).contract;
    expect(c).toMatchObject({ parentId: null, parent: null, parentHidden: true, slaAvailability: 99.9, dpa: { status: 'inPlace' } });
    expect(JSON.stringify(c)).not.toContain('Framework agreement');
    // saving the order form keeps the master she may not see
    expect((await vera('GET', `/suppliers/${sup}`)).canAddContract).toBe(false);
    await s.api('PUT', `/suppliers/${sup}/contracts/${master}`, { ...masterTerms, owners: [], confirmOpen: true });
  });

  it('flags DPA missing only where the contract processes personal data without an agreement', async () => {
    await s.api('POST', `/suppliers/${sup}/contracts`, { title: 'No personal data', personalData: false });
    await s.api('POST', `/suppliers/${sup}/contracts`, { title: 'As the supplier' });
    const page = await s.api('GET', `/suppliers/${sup}`);
    const by = (t: string) => page.contracts.find((x: any) => x.title === t);
    expect(by('No personal data').dpa).toMatchObject({ personalData: false, personalDataFrom: 'contract', missing: false });
    // the supplier's company-wide default: personal data, agreement missing
    expect(by('As the supplier').dpa).toMatchObject({
      personalData: true,
      personalDataFrom: 'supplier',
      status: 'missing',
      inheritedFrom: 'supplier',
      missing: true,
    });
    expect(by('Another master').dpa.missing).toBe(true);
    expect(page).toMatchObject({ dpaMissingContracts: 2, dpaMissing: true });
    // a supplier without contracts keeps the 0.17 flag of its own fields
    const bare = await dana('POST', '/suppliers', { name: 'Invented Bare Processor', personalData: true });
    expect((await dana('GET', `/suppliers/${bare.id}`)).dpaMissing).toBe(true);
    const list = (await s.api('GET', '/suppliers')).find((x: any) => x.id === sup);
    expect(list.dpaMissingContracts).toBe(2);
  });

  it('asks before removing a master, then copies the inherited values into its order forms', async () => {
    expect(await refused(s.api('DELETE', `/suppliers/${sup}/contracts/${master}`))).toEqual({ status: 409, code: 'SUPPLIER_CONTRACT_HAS_ORDER_FORMS' });
    await s.api('DELETE', `/suppliers/${sup}/contracts/${master}?orderForms=standalone`);
    const c = (await s.api('GET', `/suppliers/${sup}/contracts/${orderForm}`)).contract;
    expect(c).toMatchObject({
      parentId: null,
      parentHidden: false,
      inherited: [],
      slaAvailability: 99.9,
      slaSupportHours: '24/7',
      rtoHours: 8,
      rpoHours: 1,
      personalData: true,
      dpaStatus: 'inPlace',
      dpa: { inheritedFrom: 'contract', since: '2025-01-01', link: 'https://contracts.example/dpa-framework' },
    });
    const removed = (await auditOf(sup)).find((a: any) => a.action === 'supplier.contract_removed');
    expect(removed.details.orderFormsStandalone[0]).toMatchObject({ id: orderForm });
    expect(removed.details.orderFormsStandalone[0].copied).toEqual(
      expect.arrayContaining(['sla_availability', 'sla_support_hours', 'rpo_hours', 'personal_data', 'dpa_status']),
    );
  });

  it('gives the public API the effective values and where they come from', async () => {
    const { token } = await audrey('POST', '/me/tokens', { name: 'dpa read', scope: 'read' });
    const res = await fetch(`${s.base}/api/v1/suppliers/${sup}`, { headers: { authorization: `Bearer ${token}` } });
    const body = (await res.json()) as any;
    const c = body.contracts.find((x: any) => x.title === 'As the supplier');
    expect(c).toMatchObject({ parentId: null, inherited: [], personalData: null, dpa: { personalData: true, inheritedFrom: 'supplier', missing: true } });
    expect(c).not.toHaveProperty('parent');
    expect(body.dpaMissingContracts).toBe(2);
  });
});

describe('reviews, findings and reminders', () => {
  let sup: string, reviewed: string, svcReview: string;
  const soon = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

  beforeAll(async () => {
    svcReview = (await s.api('POST', '/services', { name: 'Scope review service', owners: ['user:bert'] })).id;
    await s.api('PUT', `/owning-teams/service/${svcReview}`, { teamIds: [careTeam] });
    sup = (await dana('POST', '/suppliers', { name: 'Invented Review Hosting AG', owners: ['user:dana'] })).id;
    // a contract of the Care team whose notice-by date is in 50 days
    await bert('POST', `/suppliers/${sup}/contracts`, { title: 'Reviewed hosting', endsOn: soon(80), noticeDays: 30, services: [{ serviceId: svcReview }] });
    reviewed = (await bert('GET', `/suppliers/${sup}`)).contracts.find((x: any) => x.title === 'Reviewed hosting').id;
  });

  it('lets a duty name a contract of its supplier covering the service, hidden from who may not see it', async () => {
    const processId = (await s.api('GET', '/processes'))[0].id;
    const d = await s.api('POST', '/duties', {
      serviceId: svcReview,
      name: 'Yearly review of the hosting contract',
      processId,
      interval: 'yearly',
      level: 'mandatory',
      supplierId: sup,
      supplierContractId: reviewed,
    });
    expect(d.supplierContract).toEqual({ id: reviewed, title: 'Reviewed hosting' });
    const page = await bert('GET', `/suppliers/${sup}/contracts/${reviewed}`);
    expect(page.reviews.map((x: any) => x.kind)).toContain('duty');
    // Used by: a designer sees the supplier and the duty? the service is the Care team's – the auditor does
    const used = (await audrey('GET', `/suppliers/${sup}`)).usedBy.find((u: any) => u.kind === 'duty');
    expect(used).toMatchObject({ contract: { id: reviewed }, contractHidden: false });
  });

  it('lets the contract’s owners read the findings that name it', async () => {
    const svcOther = (await s.api('POST', '/services', { name: 'Scope finding service' })).id;
    const team = (await s.api('POST', '/teams', { name: 'Finding team', members: [] })).id;
    await s.api('PUT', `/owning-teams/service/${svcOther}`, { teamIds: [team] });
    const f = await s.api('POST', '/compliance/corrective-actions', {
      title: 'Hosting provider missed its SLA report',
      source: 'supplierReview',
      serviceId: svcOther,
      supplierId: sup,
      supplierContractId: reviewed,
    });
    expect(f.supplierContract).toEqual({ id: reviewed, title: 'Reviewed hosting' });
    // bert owns the contract (not the service): he reads it
    const asBert = await bert('GET', `/compliance/corrective-actions/${f.id}`);
    expect(asBert.number).toBe(f.number);
    // the contract's owners, proposed as owners of the first action (ADR 0031 part 7)
    expect(asBert.supplierContractOwners.sort()).toEqual(['team:care team', 'user:bert']);
    expect(await refused(olivia('GET', `/compliance/corrective-actions/${f.id}`))).toMatchObject({ status: 404 });
    // a contract of another supplier is refused
    expect(
      await refused(
        s.api('POST', '/compliance/corrective-actions', { title: 'x', source: 'supplierReview', supplierId: supplier, supplierContractId: reviewed }),
      ),
    ).toEqual({ status: 404, code: 'SUPPLIER_CONTRACT_NOT_FOUND' });
  });

  it('reminds the contract’s owners of its notice-by date, with fallbacks; certificates also the owners of active contracts', async () => {
    const { expiringItems } = await import('../src/suppliers/service.js');
    const { recipientsOf } = await import('../src/suppliers/jobs.js');
    const { runAs } = await import('../src/auth/context.js');
    const { listUsers } = await import('../src/auth/users.js');
    await dana('POST', `/suppliers/${sup}/certificates`, { kind: 'iso27001', validUntil: soon(20) });
    // a contract without owners: its notice reminder falls back to the supplier's owners
    await dana('POST', `/suppliers/${sup}/contracts`, { title: 'Ownerless', owners: [], endsOn: soon(80), noticeDays: 30 });
    const all = listUsers().filter((u) => u.active);
    const items = runAs(null, () => expiringItems({ days: 90, pastDays: 0 })).filter((x) => x.supplierId === sup);
    const to = (title: string) =>
      recipientsOf(
        items.find((x) => x.title === title)!,
        all,
      )
        .map((u) => u.username)
        .sort();
    // the notice: bert (user owner) and the Care team's members – once each, only who may see it
    expect(to('Reviewed hosting')).toEqual(['bert']);
    expect(to('Ownerless')).toEqual(['dana']);
    // the certificate: the supplier's owner and the owners of active contracts
    expect(to('iso27001')).toEqual(['bert', 'dana']);
    // without any owners: the administrators
    const bare = (await s.api('POST', '/suppliers', { name: 'Invented Ownerless Ltd' })).id;
    await s.api('POST', `/suppliers/${bare}/contracts`, { title: 'Bare contract', owners: [], endsOn: soon(80), noticeDays: 30 });
    const bareItems = runAs(null, () => expiringItems({ days: 90, pastDays: 0 })).filter((x) => x.supplierId === bare);
    expect(recipientsOf(bareItems[0]!, all).map((u) => u.username)).toEqual(['admin']);
  });

  it('lists notice-by dates of contracts the recipient owns in the daily summary, certificates of suppliers they hold a contract with', async () => {
    const sum = await import('../src/notifications/summary.js');
    const { listUsers } = await import('../src/auth/users.js');
    const prefs = {
      enabled: true,
      time: '08:00',
      timeZone: 'Europe/Berlin',
      days: 'weekdays',
      channel: 'inApp',
      sections: ['suppliers'],
      skipEmpty: true,
    } as any;
    const build = (name: string) =>
      JSON.stringify(
        sum.buildSummary(
          listUsers().find((u) => u.username === name)!,
          prefs,
          Date.now() - 3600000,
          Date.now() + 1000,
        ),
      );
    expect(build('bert')).toContain('Reviewed hosting');
    expect(build('bert')).toContain('iso27001');
    expect(build('olivia')).not.toContain('Reviewed hosting');
    expect(build('dana')).toContain('Ownerless');
    expect(build('dana')).not.toContain('Reviewed hosting');
  });
});
