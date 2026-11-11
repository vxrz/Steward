import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Shared suppliers (0.18.0, ADR 0031 part 8): new suppliers belong to the whole instance; "Same supplier in several
 * teams" suggests merging what the 0.17 migration split by team (one text in two teams); "Keep separate" until another
 * supplier joins; the preview's lists; the merge protecting contracts and contacts, combining certificates and contacts,
 * writing the DPA onto moved contracts; designers refused for a widening merge; opening a team-scoped supplier;
 * "Replaced by …".
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Demo-password-1';
let dana: Client, olivia: Client, vera: Client, bert: Client;
const refused = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { status: number; body: any }) => ({ status: e.status, code: (typeof e.body === 'string' ? JSON.parse(e.body) : e.body)?.code }),
  );
let shopTeam: string, careTeam: string;
let db: typeof import('../src/db.js').db;

/** A supplier as the 0.17 migration made it from the free text of one team's items. */
async function teamSupplier(name: string, teamId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const { insertSupplier } = await import('../src/suppliers/service.js');
  const { setOwningTeams } = await import('../src/auth/policy.js');
  const id = insertSupplier({ name, status: 'unconfirmed' }, 'system');
  setOwningTeams('supplier', id, [teamId]);
  for (const [k, v] of Object.entries(extra)) db().run(`UPDATE suppliers SET ${k} = ? WHERE id = ?`, v, id);
  return id;
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [dana, olivia, vera] = await Promise.all(['dana', 'olivia', 'vera'].map((u) => s.as(u, PW)));
  const users = await import('../src/auth/users.js');
  users.createUser({ username: 'bert', roles: ['designer'], password: 'Bert-password-123', mustChangePassword: false });
  bert = await s.as('bert', 'Bert-password-123');
  db = (await import('../src/db.js')).db;
  shopTeam = (await s.api('POST', '/teams', { name: 'Shared shop team', members: ['olivia'] })).id;
  careTeam = (await s.api('POST', '/teams', { name: 'Shared care team', members: ['bert'] })).id;
}, 240_000);

describe('new suppliers', () => {
  it('belong to the whole instance, whatever teams their creator has', async () => {
    // bert is a designer in a team that owns something: his other new resources get the team
    const svc = await bert('POST', '/services', { name: 'Shared bert service' });
    await s.api('PUT', `/owning-teams/service/${svc.id}`, { teamIds: [careTeam] });
    const sup = await bert('POST', '/suppliers', { name: 'Invented Open Supplier' });
    expect((await s.api('GET', `/owning-teams/supplier/${sup.id}`)).teams).toEqual([]);
    expect((await vera('GET', '/suppliers')).map((x: any) => x.id)).toContain(sup.id);
  });
});

describe('same supplier in several teams', () => {
  let shop: string, care: string, open: string;

  it('suggests one shared supplier for the same text in two teams, proposing the instance-wide one', async () => {
    shop = await teamSupplier('Invented Cloud GmbH', shopTeam, { personal_data: 1, dpa_status: 'inPlace', dpa_since: '2025-01-01' });
    care = await teamSupplier('Invented Cloud', careTeam);
    let groups = await s.api('GET', '/suppliers/shared-suggestions');
    const g = groups.find((x: any) => x.suppliers.some((y: any) => y.id === shop));
    expect(g.suppliers.map((x: any) => x.id).sort()).toEqual([shop, care].sort());
    // neither belongs to the whole instance or is confirmed: the oldest
    expect(g.intoId).toBe(shop);
    // a third, instance-wide spelling joins: it is proposed
    open = (await dana('POST', '/suppliers', { name: 'Invented-Cloud AG' })).id;
    groups = await s.api('GET', '/suppliers/shared-suggestions');
    const g2 = groups.find((x: any) => x.suppliers.some((y: any) => y.id === shop));
    expect(g2.intoId).toBe(open);
    expect(g2.suppliers).toHaveLength(3);
    // only administrators see the section
    expect(await refused(dana('GET', '/suppliers/shared-suggestions'))).toMatchObject({ status: 403 });
  });

  it('keeps a group separate until another supplier joins it', async () => {
    const a = await teamSupplier('Invented Mail Ltd', shopTeam);
    const b = await teamSupplier('Invented Mail', careTeam);
    const key = (await s.api('GET', '/suppliers/shared-suggestions')).find((x: any) => x.suppliers.some((y: any) => y.id === a)).key;
    await s.api('POST', `/suppliers/shared-suggestions/${encodeURIComponent(key)}/keep-separate`);
    expect((await s.api('GET', '/suppliers/shared-suggestions')).some((x: any) => x.suppliers.some((y: any) => y.id === a))).toBe(false);
    const audit = await s.api('GET', '/audit?action=supplier.merge_kept_separate&limit=5');
    expect(audit[0].details.suppliers.map((x: any) => x.id).sort()).toEqual([a, b].sort());
    // a new member revives the group
    await teamSupplier('Invented Mail Limited', careTeam);
    expect((await s.api('GET', '/suppliers/shared-suggestions')).some((x: any) => x.suppliers.some((y: any) => y.id === a))).toBe(true);
  });

  it('previews what each team gains before anything changes', async () => {
    // the shop's supplier: a contract without a team owner, one with; a company-wide contact; a certificate
    await s.api('POST', `/suppliers/${shop}/contracts`, { title: 'Shop hosting', reference: 'IC-1', owners: ['user:olivia'] });
    await s.api('POST', `/suppliers/${shop}/contracts`, { title: 'Shop backup', owners: ['team:shared shop team'] });
    await s.api('POST', `/suppliers/${shop}/contacts`, { name: 'Shop account manager', email: 'am@cloud.example' });
    await s.api('POST', `/suppliers/${shop}/certificates`, { kind: 'iso27001', scope: 'Hosting', validUntil: '2030-01-01' });
    // the shared supplier has the same certificate, the same person and a contract with the same number
    await s.api('POST', `/suppliers/${open}/certificates`, { kind: 'iso27001', scope: 'Hosting', validUntil: '2030-01-01' });
    await s.api('POST', `/suppliers/${open}/contacts`, { name: 'Company desk', email: 'desk@cloud.example' });
    await s.api('POST', `/suppliers/${open}/contracts`, { title: 'Open hosting', reference: 'ic-1', owners: [] });
    // care: a company-wide contact, no contracts, nothing links it – the administrator chooses
    await s.api('POST', `/suppliers/${care}/contacts`, { name: 'Care hotline' });
    const p = await s.api('POST', '/suppliers/merge/preview', { intoId: open, ids: [shop, care] });
    expect(p.widens).toBe(true);
    expect(p.gainers).toContain('vera');
    // administrators and auditors saw every source already
    expect(p.gainers).not.toContain('admin');
    expect(p.gainers).not.toContain('audrey');
    const hosting = p.contracts.find((c: any) => c.title === 'Shop hosting');
    expect(hosting).toMatchObject({ owners: ['user:olivia'], sameReference: true });
    expect(hosting.ownersAfter.sort()).toEqual(['team:shared shop team', 'user:olivia']);
    expect(p.contracts.find((c: any) => c.title === 'Shop backup')).toMatchObject({
      owners: ['team:shared shop team'],
      ownersAfter: ['team:shared shop team'],
    });
    const am = p.contacts.find((c: any) => c.name === 'Shop account manager');
    expect(am.action).toBe('scope');
    expect(am.scope.map((x: any) => x.name).sort()).toEqual(['Shop backup', 'Shop hosting']);
    expect(p.contacts.find((c: any) => c.name === 'Care hotline')).toMatchObject({ action: 'choose', scope: [] });
    expect(p.certificates).toHaveLength(1);
    // the shop's DPA is written onto its contracts: the shared supplier has none
    expect(p.dpa.map((x: any) => x.title).sort()).toEqual(['Shop backup', 'Shop hosting']);
    expect(p.dpa[0]).toMatchObject({ personalData: true, dpaStatus: 'inPlace' });
    // nothing changed
    expect((await s.api('GET', `/suppliers/${shop}`)).contracts).toHaveLength(2);
  });

  it('refuses a widening merge to designers and asks for the choices', async () => {
    // a designer who may not see a source does not learn that it exists
    expect(await refused(dana('POST', '/suppliers/merge', { intoId: open, ids: [shop, care] }))).toMatchObject({ status: 404 });
    // bert (a designer in the care team) sees both, but the merge would widen who sees the care supplier
    expect(await refused(bert('POST', '/suppliers/merge', { intoId: open, ids: [care] }))).toEqual({ status: 403, code: 'FORBIDDEN' });
    expect(await refused(s.api('POST', '/suppliers/merge', { intoId: open, ids: [shop, care] }))).toEqual({
      status: 409,
      code: 'SUPPLIER_MERGE_CONTACT_CHOICE',
    });
  });

  it('merges, protecting every team’s contracts and contacts', async () => {
    const hotline = (await s.api('GET', `/suppliers/${care}`)).contacts[0].id;
    const d = await s.api('POST', '/suppliers/merge', { intoId: open, ids: [shop, care], contacts: { [hotline]: 'remove' } });
    expect(d.id).toBe(open);
    expect(await refused(s.api('GET', `/suppliers/${shop}`))).toMatchObject({ status: 404 });
    // vera sees the shared supplier but not the shop's contracts or its scoped contact
    const v = await vera('GET', `/suppliers/${open}`);
    expect(v.contracts.map((c: any) => c.title)).toEqual(['Open hosting']);
    expect(v.contacts.map((c: any) => c.name)).toEqual(['Company desk']);
    const o = await olivia('GET', `/suppliers/${open}`);
    expect(o.contracts.map((c: any) => c.title).sort()).toEqual(['Open hosting', 'Shop backup', 'Shop hosting']);
    expect(o.contacts.map((c: any) => c.name).sort()).toEqual(['Company desk', 'Shop account manager']);
    // the DPA answer of the shop's contracts did not change
    const hosting = o.contracts.find((c: any) => c.title === 'Shop hosting');
    expect(hosting.dpa).toMatchObject({ personalData: true, status: 'inPlace', inheritedFrom: 'contract' });
    // one certificate of the two that were the same
    expect(o.certificates).toHaveLength(1);
    expect(d.aliases).toEqual(expect.arrayContaining(['Invented Cloud GmbH', 'Invented Cloud']));
    const audit = (await s.api('GET', `/audit?action=supplier.merged&entityId=${open}&limit=5`))[0];
    expect(audit.details).toMatchObject({ widens: true, into: { id: open } });
    expect(audit.details.contacts.find((c: any) => c.action === 'remove')).toBeTruthy();
    expect(audit.details.contracts.length).toBe(1);
    expect(audit.details.certificatesCombined).toHaveLength(1);
  });

  it('lets designers merge suppliers with the same owning teams', async () => {
    const a = (await dana('POST', '/suppliers', { name: 'Invented Same Teams A' })).id;
    const b = (await dana('POST', '/suppliers', { name: 'Invented Same Teams B' })).id;
    await dana('POST', `/suppliers/${b}/contacts`, { name: 'Same person', email: 'Same@example.com' });
    await dana('POST', `/suppliers/${a}/contacts`, { name: 'same person', email: 'same@example.com' });
    const p = await dana('POST', '/suppliers/merge/preview', { intoId: a, ids: [b] });
    expect(p).toMatchObject({ widens: false, gainers: [] });
    expect(p.contacts[0]).toMatchObject({ action: 'combined' });
    const d = await dana('POST', '/suppliers/merge', { intoId: a, ids: [b] });
    expect(d.contacts).toHaveLength(1);
    // the "To confirm" route merges by the same rules
    const c = (await dana('POST', '/suppliers', { name: 'Invented Same Teams C' })).id;
    await dana('POST', `/suppliers/${c}/merge`, { into: a });
  });
});

describe('the preview as the reader may see it', () => {
  it('lists only the contracts and contacts the person may see, without counting the others', async () => {
    const x = (await dana('POST', '/suppliers', { name: 'Invented Preview Source' })).id;
    const y = (await dana('POST', '/suppliers', { name: 'Invented Preview Target' })).id;
    // another team's contract and a contact scoped to it on the instance-wide source; one open contract
    await s.api('POST', `/suppliers/${x}/contracts`, { title: 'Hidden team contract', reference: 'HT-1', owners: ['team:shared shop team'] });
    await s.api('POST', `/suppliers/${x}/contracts`, { title: 'Open preview contract', owners: [] });
    const hidden = (await s.api('GET', `/suppliers/${x}`)).contracts.find((c: any) => c.title === 'Hidden team contract').id;
    await s.api('POST', `/suppliers/${x}/contacts`, { name: 'Hidden scoped person', scope: [{ kind: 'contract', id: hidden }] });
    await s.api('POST', `/suppliers/${x}/contacts`, { name: 'Shared desk', scope: [{ kind: 'contract', id: hidden }], email: 'desk@preview.example' });
    // the target has a contract with the same number, which the designer may not see either
    await s.api('POST', `/suppliers/${y}/contracts`, { title: 'Target team contract', reference: 'ht-1', owners: ['team:shared care team'] });
    const p = await dana('POST', '/suppliers/merge/preview', { intoId: y, ids: [x] });
    expect(p.contracts.map((c: any) => c.title)).toEqual(['Open preview contract']);
    expect(p.contacts).toEqual([]);
    expect(p.dpa.every((d: any) => d.title !== 'Hidden team contract')).toBe(true);
    const text = JSON.stringify(p);
    for (const word of ['Hidden team contract', 'HT-1', 'Hidden scoped person', 'Shared desk', 'shared shop team']) expect(text).not.toContain(word);
    // an administrator sees everything the merge does
    const a = await s.api('POST', '/suppliers/merge/preview', { intoId: y, ids: [x] });
    expect(a.contracts.map((c: any) => c.title).sort()).toEqual(['Hidden team contract', 'Open preview contract']);
    expect(a.contracts.find((c: any) => c.title === 'Hidden team contract').sameReference).toBe(true);
    expect(a.contacts.map((c: any) => c.name).sort()).toEqual(['Hidden scoped person', 'Shared desk']);
  });
});

describe('opening a team-scoped supplier', () => {
  it('previews and protects, through the owning-teams panel too', async () => {
    const id = await teamSupplier('Invented Team Hosting', shopTeam);
    await s.api('POST', `/suppliers/${id}/contracts`, { title: 'Team hosting', owners: [] });
    await s.api('POST', `/suppliers/${id}/contacts`, { name: 'Team hosting desk' });
    const p = await s.api('POST', `/suppliers/${id}/open/preview`, { teamIds: [] });
    expect(p.widens).toBe(true);
    expect(p.contracts[0].ownersAfter).toEqual(['team:shared shop team']);
    expect(p.contacts[0]).toMatchObject({ action: 'scope', scope: [expect.objectContaining({ kind: 'contract', name: 'Team hosting' })] });
    await s.api('PUT', `/owning-teams/supplier/${id}`, { teamIds: [] });
    const v = await vera('GET', `/suppliers/${id}`);
    expect(v.contracts).toEqual([]);
    expect(v.contacts).toEqual([]);
    expect((await olivia('GET', `/suppliers/${id}`)).contracts.map((c: any) => c.title)).toEqual(['Team hosting']);
    const audit = (await s.api('GET', `/audit?action=access.owning_teams_changed&entityId=${id}&limit=5`))[0];
    expect(audit.details.protected.contracts).toHaveLength(1);
    expect(await refused(dana('POST', `/suppliers/${id}/open/preview`, { teamIds: [] }))).toMatchObject({ status: 403 });
  });
});

describe('Replaced by …', () => {
  it('moves what named a contract to another contract of the supplier', async () => {
    const sup = (await dana('POST', '/suppliers', { name: 'Invented Replacement Hosting' })).id;
    const svc = (await s.api('POST', '/services', { name: 'Replacement service', owners: ['user:olivia'] })).id;
    await s.api('POST', `/suppliers/${sup}/contracts`, { title: 'Old hosting', services: [{ serviceId: svc, purpose: 'Hosting' }] });
    await s.api('POST', `/suppliers/${sup}/contracts`, { title: 'New hosting' });
    const list = (await s.api('GET', `/suppliers/${sup}`)).contracts;
    const oldId = list.find((c: any) => c.title === 'Old hosting').id;
    const newId = list.find((c: any) => c.title === 'New hosting').id;
    await s.api('POST', '/costs/schedules', {
      title: 'Fee',
      category: 'support',
      amount: '10',
      currency: 'EUR',
      billing: 'monthly',
      yearAmounts: [],
      contractId: oldId,
      serviceId: svc,
    });
    await s.api('POST', `/costs/plans/${svc}/lines`, {
      fiscalYear: 2031,
      title: 'Hosting line',
      category: 'support',
      currency: 'EUR',
      amount: '1',
      cadence: 'monthly',
      supplierId: sup,
      supplierContractId: oldId,
    });
    await s.api('POST', `/suppliers/${sup}/contacts`, { name: 'Old hosting desk', scope: [{ kind: 'contract', id: oldId }] });
    expect(await refused(s.api('DELETE', `/suppliers/${sup}/contracts/${oldId}?replacedBy=${oldId}`))).toEqual({
      status: 400,
      code: 'SUPPLIER_CONTRACT_REPLACE_SELF',
    });
    await s.api('DELETE', `/suppliers/${sup}/contracts/${oldId}?replacedBy=${newId}`);
    const page = await s.api('GET', `/suppliers/${sup}/contracts/${newId}`);
    expect(page.contract.services).toEqual([expect.objectContaining({ id: svc, purpose: 'Hosting' })]);
    expect(page.contacts.map((c: any) => c.name)).toEqual(['Old hosting desk']);
    expect((await s.api('GET', `/costs/schedules?contractId=${newId}`)).schedules).toHaveLength(1);
    const y = await s.api('GET', `/costs/plans/${svc}?fiscalYear=2031`);
    expect(y.lines.find((l: any) => l.title === 'Hosting line').supplierContract.id).toBe(newId);
    const removed = (await s.api('GET', `/audit?action=supplier.contract_removed&entityId=${sup}&limit=5`))[0];
    expect(removed.details.replacedBy).toMatchObject({ id: newId, moved: { schedules: 1, costPlanLines: 1, contacts: 1 } });
  });
});
