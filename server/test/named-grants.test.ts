import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Owners and responsible people from outside the owning teams (#195): naming a user or team who is not in an item's
 * owning teams asks for the step-up (control point access.grant) and is audited as an access change; covered subjects,
 * removals and items of the whole instance need nothing; API tokens are refused; "Why do I have access?" names it.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Own-password-123';
let s: TestServer;
let tara: Client; // designer, member of Orders – confirms by hand (no automatic step-up)
let vic: Client; // viewer, not a member
let orders: string;
let service: string;

/** The error code of a refused request (or "ok"). */
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { body?: { code?: string } }) => e.body?.code ?? 'error',
  );
const confirm = () => tara('POST', '/auth/step-up', { password: PW });
const unconfirm = () => tara('DELETE', '/auth/step-up');
const granted = async (entityId: string) =>
  ((await s.api('GET', '/audit?action=access.named_subjects_granted&limit=50')) as { entityId: string; details?: Record<string, unknown> }[]).filter(
    (e) => e.entityId === entityId,
  );

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup');
  const users = await import('../src/auth/users.js');
  users.createUser({ username: 'tara', roles: ['designer'], password: PW, mustChangePassword: false });
  users.createUser({ username: 'olaf', roles: ['viewer'], password: PW, mustChangePassword: false });
  users.createUser({ username: 'vic', roles: ['viewer'], password: PW, mustChangePassword: false });
  users.createUser({ username: 'dave', roles: ['designer'], password: PW, mustChangePassword: false });
  tara = await s.as('tara', PW, { autoStepUp: false });
  vic = await s.as('vic', PW);
  orders = (await s.api('POST', '/teams', { name: 'Orders', members: ['tara', 'olaf'] })).id;
  await s.api('POST', '/teams', { name: 'Payments', members: ['dave'] });
  // a service of Orders: the team owns something, so its members' new resources are the team's
  service = (await s.api('POST', '/services', { name: 'Order intake', owners: [] })).id;
  await s.api('PUT', `/owning-teams/service/${service}`, { teamIds: [orders] });
});

describe('credentials (ownerSubjects)', () => {
  let id: string;
  const body = (ownerSubjects: string[]) => ({ name: 'Orders API key', type: 'apiClient', ownerSubjects });

  it('ask for the step-up when a new entry names someone outside the owning teams it gets', async () => {
    await unconfirm();
    expect(await code(tara('POST', '/credentials', body(['user:vic'])))).toBe('STEP_UP_REQUIRED');
    // members and the team itself are covered
    const made = await tara('POST', '/credentials', body(['user:olaf', 'team:orders']));
    id = made.id;
    expect((await s.api('GET', `/owning-teams/credential/${id}`)).teams).toEqual([{ id: orders, name: 'Orders' }]);
    expect(await granted(id)).toEqual([]);
  });

  it('ask for the step-up when a change adds an outsider, and audit it as an access change', async () => {
    await unconfirm();
    expect(await code(tara('PUT', `/credentials/${id}`, body(['user:olaf', 'team:orders', 'user:vic'])))).toBe('STEP_UP_REQUIRED');
    expect(await code(tara('PUT', `/credentials/${id}`, body(['user:olaf', 'team:orders', 'team:payments'])))).toBe('STEP_UP_REQUIRED');
    // nothing changed, vic sees nothing
    expect(await code(vic('GET', `/credentials/${id}`))).toBe('CREDENTIAL_NOT_FOUND');
    await confirm();
    await tara('PUT', `/credentials/${id}`, body(['user:olaf', 'team:orders', 'user:vic']));
    const [entry] = await granted(id);
    expect(entry).toMatchObject({ entityId: id, details: { field: 'ownerSubjects', granted: ['user:vic'], owningTeams: ['Orders'] } });
    expect((entry!.details!.assurance as { point: string }[]).map((p) => p.point)).toContain('access.grant');
    // vic sees and changes it now, and is told why
    expect((await vic('GET', `/credentials/${id}`)).permissions).toEqual(['view', 'edit']);
    const why = await vic('GET', `/access/explain?kind=credential&id=${id}`);
    expect(why.reasons).toEqual([expect.objectContaining({ source: 'named', as: 'owner', subject: 'user:vic' })]);
  });

  it('need nothing for removing a subject or keeping one', async () => {
    await unconfirm();
    await tara('PUT', `/credentials/${id}`, body(['user:olaf', 'team:orders', 'user:vic']));
    await tara('PUT', `/credentials/${id}`, body(['team:orders']));
    expect(await code(vic('GET', `/credentials/${id}`))).toBe('CREDENTIAL_NOT_FOUND');
  });

  it('refuse API tokens that add an outsider, as for access lists', async () => {
    await confirm();
    const token = (await tara('POST', '/me/tokens', { name: 'tara full', scope: 'full' })).token as string;
    const res = await fetch(`${s.base}/api/credentials/${id}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body(['team:orders', 'user:vic'])),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('SESSION_REQUIRED');
    // a covered change goes through with a token
    const ok = await fetch(`${s.base}/api/credentials/${id}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body(['team:orders', 'user:olaf'])),
    });
    expect(ok.status).toBe(200);
  });

  it('need nothing on an entry of the whole instance', async () => {
    await unconfirm();
    const dave = await s.as('dave', PW, { autoStepUp: false });
    await dave('DELETE', '/auth/step-up');
    // dave's team owns nothing: his new entries are the whole instance's
    const made = await dave('POST', '/credentials', { name: 'Shared key', type: 'apiClient', ownerSubjects: ['user:vic'] });
    expect((await s.api('GET', `/owning-teams/credential/${made.id}`)).teams).toEqual([]);
    expect(await granted(made.id)).toEqual([]);
  });

  it('are asked again in the service, so paths without the route rule cannot grant unconfirmed', async () => {
    const { runAs } = await import('../src/auth/context.js');
    const { toAuthUser, findUserByName } = await import('../src/auth/users.js');
    const { updateCredential, credentialInputSchema } = await import('../src/credentials/service.js');
    // a signed-in person without a session (an API token, an import, an MCP tool) cannot confirm
    const u = toAuthUser(findUserByName('tara')!);
    expect(() => runAs(u, () => updateCredential(id, credentialInputSchema.parse(body(['team:orders', 'user:dave']))))).toThrow(
      expect.objectContaining({ code: 'SESSION_REQUIRED' }),
    );
  });
});

describe('ticket references (responsible)', () => {
  let id: string;
  const body = (responsible: string[]) => ({ source: 'vendor', externalNumber: 'INC-195', title: 'Orders outage', responsible });

  it('ask for the step-up for a responsible from outside the owning teams', async () => {
    await confirm();
    id = (await tara('POST', '/ticket-references', body(['user:tara']))).id;
    expect((await s.api('GET', `/owning-teams/ticket/${id}`)).teams).toEqual([{ id: orders, name: 'Orders' }]);
    await unconfirm();
    expect(await code(tara('PUT', `/ticket-references/${id}`, body(['user:tara', 'user:vic'])))).toBe('STEP_UP_REQUIRED');
    await confirm();
    await tara('PUT', `/ticket-references/${id}`, body(['user:tara', 'user:vic']));
    expect((await granted(id))[0]).toMatchObject({ details: { field: 'responsible', granted: ['user:vic'] } });
    const why = await vic('GET', `/access/explain?kind=ticket&id=${id}`);
    expect(why.reasons).toEqual([expect.objectContaining({ source: 'named', as: 'responsible', subject: 'user:vic' })]);
  });
});

describe('catalogue owners', () => {
  it('ask for the step-up on services, applications that inherit their teams, and systems', async () => {
    await unconfirm();
    expect(await code(tara('PUT', `/services/${service}`, { name: 'Order intake', owners: ['user:vic'] }))).toBe('STEP_UP_REQUIRED');
    expect(await code(tara('PUT', `/services/${service}`, { name: 'Order intake', owners: ['user:olaf', 'team:orders'] }))).toBe('ok');
    // an application of the service belongs to Orders through it
    const app = (await s.api('POST', '/applications', { name: 'Order API', owners: [] })).id;
    await s.api('PUT', `/services/${service}/applications/${app}`, { role: 'primary' });
    expect(await code(tara('PUT', `/applications/${app}`, { name: 'Order API', owners: ['team:payments'] }))).toBe('STEP_UP_REQUIRED');
    expect(await code(tara('POST', '/systems', { name: 'Order host', kind: 'server', owners: ['user:dave'] }))).toBe('STEP_UP_REQUIRED');
    await confirm();
    await tara('PUT', `/services/${service}`, { name: 'Order intake', owners: ['team:orders', 'user:vic'] });
    expect((await granted(service))[0]).toMatchObject({ entityType: 'service', details: { field: 'owners', granted: ['user:vic'] } });
    const why = await vic('GET', `/access/explain?kind=service&id=${service}`);
    expect(why.reasons).toEqual([expect.objectContaining({ source: 'named', as: 'owner', subject: 'user:vic' })]);
  });

  it('say before saving who is outside (the forms’ hint), to who may change the item', async () => {
    const r = await tara('POST', '/access/named-outside', { kind: 'service', id: service, subjects: ['user:olaf', 'user:dave', 'team:payments'] });
    expect(r).toEqual({ teams: ['Orders'], outside: ['team:payments', 'user:dave'] });
    // a new item: the teams it gets from its creator
    expect((await tara('POST', '/access/named-outside', { kind: 'credential', subjects: ['user:dave'] })).outside).toEqual(['user:dave']);
    // vic sees the service (a named owner may change it), a stranger learns nothing
    const stranger = await s.as('dave', PW);
    expect(await code(stranger('POST', '/access/named-outside', { kind: 'service', id: service, subjects: ['user:olaf'] }))).toBe('SERVICE_NOT_FOUND');
  });
});

describe('other named owners', () => {
  it('duties, measures, documents and corrective actions ask for the step-up too', async () => {
    await confirm();
    const proc = (await s.api('GET', '/processes'))[0].id;
    const duty = await tara('POST', '/duties', { serviceId: service, name: 'Review', processId: proc, interval: 'monthly', level: 'mandatory' });
    const review = await tara('POST', '/records', { type: 'PIR', title: 'Orders outage review' });
    expect((await s.api('GET', `/owning-teams/record/${review.id}`)).teams).toEqual([{ id: orders, name: 'Orders' }]);
    const finding = await tara('POST', '/compliance/corrective-actions', { title: 'Orders finding', source: 'internalAudit', serviceId: service });
    await unconfirm();
    const dutyBody = { name: 'Review', processId: proc, interval: 'monthly', level: 'mandatory' };
    expect(await code(tara('PUT', `/duties/${duty.id}`, { ...dutyBody, owners: ['user:dave'] }))).toBe('STEP_UP_REQUIRED');
    expect(await code(tara('PUT', `/duties/${duty.id}`, { ...dutyBody, owners: ['user:olaf'] }))).toBe('ok');
    expect(await code(tara('POST', `/records/${review.id}/measures`, { title: 'Fix', owners: ['user:dave'], dueDate: '2030-01-01' }))).toBe('STEP_UP_REQUIRED');
    expect(await code(tara('PUT', `/records/${review.id}`, { owner: 'dave' }))).toBe('STEP_UP_REQUIRED');
    expect(await code(tara('PUT', `/records/${review.id}`, { owner: 'olaf' }))).toBe('ok');
    expect(await code(tara('PUT', `/compliance/corrective-actions/${finding.id}`, { owner: 'dave' }))).toBe('STEP_UP_REQUIRED');
    expect(
      await code(tara('POST', `/compliance/corrective-actions/${finding.id}/actions`, { title: 'Act', owners: ['team:payments'], dueDate: '2030-01-01' })),
    ).toBe('STEP_UP_REQUIRED');
    await confirm();
    await tara('PUT', `/duties/${duty.id}`, { ...dutyBody, owners: ['user:olaf', 'user:dave'] });
    expect((await granted(duty.id))[0]).toMatchObject({ entityType: 'duty', details: { granted: ['user:dave'] } });
  });

  it('supplier contracts: owners from outside the contract’s teams', async () => {
    await confirm();
    const supplier = (await s.api('POST', '/suppliers', { name: 'Invented Parcels AG', type: 'saas' })).id;
    const added = await tara('POST', `/suppliers/${supplier}/contracts`, { title: 'Parcel delivery' });
    const contract = added.contracts.find((c: { title: string }) => c.title === 'Parcel delivery');
    // a new contract's owners: its creator and the creator's team
    expect(contract.owners).toEqual(['user:tara', 'team:orders']);
    await unconfirm();
    expect(
      await code(tara('PUT', `/suppliers/${supplier}/contracts/${contract.id}`, { title: 'Parcel delivery', owners: [...contract.owners, 'user:vic'] })),
    ).toBe('STEP_UP_REQUIRED');
    expect(
      await code(tara('PUT', `/suppliers/${supplier}/contracts/${contract.id}`, { title: 'Parcel delivery', owners: [...contract.owners, 'user:olaf'] })),
    ).toBe('ok');
  });
});

describe('supplier contracts covering a platform (security review 0.19.0 M1, L1)', () => {
  let supplier: string;
  let contract: string;
  let other: string;
  let platform: string;
  let paul: Client; // operator in Cloud, the platform's owning team: sees the platform, does not manage it
  let vince: Client; // viewer in Cloud: the platform is answered like a missing one
  const contractPath = () => `/suppliers/${supplier}/contracts/${contract}`;

  beforeAll(async () => {
    const users = await import('../src/auth/users.js');
    users.createUser({ username: 'paul', roles: ['operator'], password: PW, mustChangePassword: false });
    users.createUser({ username: 'vince', roles: ['viewer'], password: PW, mustChangePassword: false });
    paul = await s.as('paul', PW);
    vince = await s.as('vince', PW);
    const cloud = (await s.api('POST', '/teams', { name: 'Cloud', members: ['paul', 'vince'] })).id;
    platform = (await s.api('POST', '/platforms', { name: 'Cloud platform', kind: 'rest', baseUrl: 'https://cloud.invented.example' })).id;
    await s.api('PUT', `/owning-teams/platform/${platform}`, { teamIds: [cloud] });
    // tara uses the platform (she may pick it), she does not manage it
    await s.api('PUT', `/platforms/${platform}/access`, { acl: [{ subject: 'user:tara', permissions: ['use'] }] });
    supplier = (await s.api('POST', '/suppliers', { name: 'Invented Hosting AG', type: 'serviceProvider' })).id;
    await confirm();
    const terms = { startsOn: '2026-01-01', endsOn: '2028-12-31', renewal: 'fixedEnd' };
    let d = await tara('POST', `/suppliers/${supplier}/contracts`, { title: 'Orders hosting', ...terms });
    contract = d.contracts.find((c: { title: string }) => c.title === 'Orders hosting').id;
    d = await tara('POST', `/suppliers/${supplier}/contracts`, { title: 'Orders hosting 2', ...terms });
    other = d.contracts.find((c: { title: string }) => c.title === 'Orders hosting 2').id;
    expect(d.contracts.find((c: { id: string }) => c.id === contract).owners).toEqual(['user:tara', 'team:orders']);
  });

  it('asks for the step-up when a platform of another team is added to a team-owned contract', async () => {
    await unconfirm();
    expect(await code(vince('GET', `/platforms/${platform}`))).not.toBe('ok');
    // the review's path: adding the owner team:cloud asks, adding Cloud's platform did not
    expect(await code(tara('PUT', contractPath(), { title: 'Orders hosting', owners: ['user:tara', 'team:orders', 'team:cloud'] }))).toBe('STEP_UP_REQUIRED');
    expect(await code(tara('PUT', `${contractPath()}/platforms/${platform}`, { purpose: 'Hosting' }))).toBe('STEP_UP_REQUIRED');
    // a new contract covering it from the start asks too
    expect(
      await code(tara('POST', `/suppliers/${supplier}/contracts`, { title: 'Orders hosting 3', platforms: [{ platformId: platform, purpose: '' }] })),
    ).toBe('STEP_UP_REQUIRED');
    // nothing was given away
    expect(await code(paul('GET', contractPath()))).toBe('SUPPLIER_CONTRACT_NOT_FOUND');
    // the forms say so before adding
    expect(
      await tara('POST', '/access/named-outside', { kind: 'supplierContract', supplierId: supplier, id: contract, subjects: [], platformId: platform }),
    ).toEqual({
      teams: ['Orders'],
      outside: ['team:cloud'],
    });
  });

  it('refuses the paths that add a covered platform on the side when that would grant it', async () => {
    await confirm();
    // a payment schedule the platform pays
    expect(
      await code(
        tara('POST', '/costs/schedules', {
          contractId: contract,
          platformId: platform,
          title: 'Hosting',
          category: 'cloud',
          amount: '1000',
          currency: 'USD',
          billing: 'volume',
          volume: { per: 'term', billing: 'prepaid', committed: 'full' },
        }),
      ),
    ).toBe('SUPPLIER_CONTRACT_PLATFORM_GRANT');
    expect(await code(paul('GET', contractPath()))).toBe('SUPPLIER_CONTRACT_NOT_FOUND');
  });

  it('gives the platform the contract once confirmed, audited as an access change; its owning teams read it, they do not change it', async () => {
    // (confirmed in the test before)
    await tara('PUT', `${contractPath()}/platforms/${platform}`, { purpose: 'Hosting' });
    const [entry] = (await granted(supplier)).filter((e) => e.details?.field === 'platforms');
    expect(entry).toMatchObject({
      details: { field: 'platforms', granted: ['team:cloud'], owningTeams: ['Orders'], contractId: contract, platformId: platform },
    });
    expect((entry!.details!.assurance as { point: string }[]).map((p) => p.point)).toContain('access.grant');
    // a member of Cloud who sees the platform reads it – the right to change it comes from `manage` only
    const read = await paul('GET', contractPath());
    expect(read.contract).toMatchObject({ readReason: 'platform', canEdit: false });
    expect(await code(paul('PUT', contractPath(), { title: 'Orders hosting', owners: ['team:cloud'] }))).toBe('FORBIDDEN');
    // L1: a viewer of Cloud, who may not see the platform, does not read the contract through it
    expect(await code(vince('GET', contractPath()))).toBe('SUPPLIER_CONTRACT_NOT_FOUND');
  });

  it('refuses "Replaced by …" when the platform would join another team’s contract on the side', async () => {
    // the replacement belongs to Payments: Cloud's platform would give it to Cloud
    await s.api('PUT', `/suppliers/${supplier}/contracts/${other}`, { title: 'Orders hosting 2', owners: ['user:tara', 'team:payments'] });
    expect(await code(tara('DELETE', `${contractPath()}?replacedBy=${other}`))).toBe('SUPPLIER_CONTRACT_PLATFORM_GRANT');
    expect(await code(tara('GET', contractPath()))).toBe('ok');
  });
});
