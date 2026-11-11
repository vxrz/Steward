import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * The service half of the demo (U5 of the 0.10 review): services built from the sample applications, with monitors,
 * an objective, a system, documents, credential register entries, a ticket, duties, a maintenance window, a status
 * page and a report schedule – so the scorecard, the costs per service, the service hub and the Home tiles have content.
 */
let s: TestServer;
beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
});
afterAll(async () => s?.app.close());

describe('demo services', () => {
  it('seeds the service half on request, once', async () => {
    // the plain demo (what the server tests load) leaves the catalogue and the registers empty
    const plain = await s.api('POST', '/demo/setup', {});
    expect(plain.services).toBe(0);
    expect(await s.api('GET', '/services')).toEqual([]);
    const first = await s.api('POST', '/demo/setup', { services: true });
    expect(first.services).toBe(3);

    const services = (await s.api('GET', '/services')) as { id: string; name: string; applicationCount: number; linkCount: number; documentCount: number }[];
    const shop = services.find((x) => x.name === 'Online shop (demo)')!;
    expect(shop).toBeTruthy();
    expect(shop.applicationCount).toBe(2);
    expect(shop.linkCount).toBeGreaterThanOrEqual(5);
    expect(shop.documentCount).toBe(1);
    expect(services.map((x) => x.name)).toEqual(expect.arrayContaining(['Customer care (demo)', 'Plant monitoring (demo)']));

    // the scorecard judges every part of the shop
    const card = await s.api('GET', `/scorecard/services/${shop.id}`);
    expect(JSON.stringify(card)).toContain('Shop instances up');
    const overview = await s.api('GET', '/scorecard');
    expect(overview.services.length).toBeGreaterThanOrEqual(3);

    // costs reach the services through their applications
    const costs = await s.api('GET', '/costs?scope=service');
    expect(JSON.stringify(costs)).toContain('Online shop (demo)');

    // the registers and plans
    const records = (await s.api('GET', '/records')) as { title: string; status: string; number: string }[];
    expect(records.find((r) => r.number.startsWith('ADR-'))?.status).toBe('accepted');
    expect(records.find((r) => r.number.startsWith('CR-'))?.status).toBe('approved');
    expect(records.find((r) => r.number.startsWith('DOC-'))?.status).toBe('published');
    const creds = await s.api('GET', '/credentials');
    expect((creds.items ?? creds).length).toBe(3);
    expect(JSON.stringify(await s.api('GET', '/ticket-references'))).toContain('PL-48213');
    const duties = await s.api('GET', '/duties');
    // three duties of the services and the yearly supplier review (0.17)
    expect((duties.items ?? duties).length).toBe(4);
    const maintenance = await s.api('GET', '/maintenance-windows');
    expect(JSON.stringify(maintenance)).toContain('Shop database upgrade');
    expect((await s.api('GET', '/status-pages')).length).toBe(1);
    const schedules = await s.api('GET', '/report-schedules');
    expect(JSON.stringify(schedules)).toContain('Weekly service meeting (demo)');
    // the monthly management review with the ISMS summary (ADR 0029 part 4)
    const review = schedules.items.find((x: { name: string }) => x.name === 'Monthly management review (demo)');
    expect(review?.sections).toMatchObject({ isms: { catalogue: null, days: 90 } });
    const systems = (await s.api('GET', '/systems')) as { name: string }[];
    expect(systems.map((x) => x.name)).toContain('k8s-shop-01 (demo)');

    // suppliers (0.17, ADR 0029): two invented ones linked to the ticket, the cluster and the review duty; the vendor texts
    // left (page watches, cost plan lines) wait under "To confirm"
    const suppliers = (await s.api('GET', '/suppliers?status=active')) as { id: string; name: string; certificateState: string }[];
    expect(suppliers.map((x) => x.name)).toEqual(expect.arrayContaining(['Example Cloud GmbH', 'Paylumen']));
    const paylumen = await s.api('GET', `/suppliers/${suppliers.find((x) => x.name === 'Paylumen')!.id}`);
    expect(paylumen.certificateState).toBe('dueSoon');
    expect(paylumen.usage).toMatchObject({ ticket: 1, duty: 1, watch: 1 });
    expect((await s.api('GET', `/suppliers/${suppliers.find((x) => x.name === 'Example Cloud GmbH')!.id}`)).usage.system).toBe(1);
    // the responsibility matrix of two services and a draft statement of applicability (ADR 0029 part 2)
    const cloud = suppliers.find((x) => x.name === 'Example Cloud GmbH')!;
    const matrix = await s.api('GET', `/services/${shop.id}/responsibilities`);
    expect(matrix.undecided).toBe(0);
    expect(matrix.rows.find((r: { area: string }) => r.area === 'backup')).toMatchObject({
      party: 'supplier',
      supplier: { name: 'Example Cloud GmbH' },
      contract: { rtoHours: 8, rpoHours: 24 },
    });
    expect(matrix.rows.find((r: { area: string }) => r.area === 'recovery').recoveryTest).toBe('missing');
    expect((await s.api('GET', `/suppliers/${cloud.id}`)).usage).toMatchObject({ responsibility: 1, soaEntry: 1 });
    const soa = await s.api('GET', '/compliance/soa/ISO27001');
    expect(soa.versions).toEqual([]);
    expect(soa.counts).toMatchObject({ applicable: 5, notApplicable: 1 });
    expect(soa.entries.find((e: { ref: string }) => e.ref === '8.13').suggestion).toMatchObject({ counts: { supplier: 1, team: 1 }, party: 'shared' });
    // shared by two services (ADR 0031): the hosting held by the service desk team, an order form of a framework
    // agreement for customer care, a contact scoped to the hosting contract, and a pair split by team
    const shared = await s.api('GET', `/suppliers/${cloud.id}`);
    const hosting = shared.contracts.find((c: { title: string }) => c.title === 'Managed Kubernetes');
    expect(hosting).toMatchObject({ teamOwned: true, services: [expect.objectContaining({ id: shop.id, purpose: 'Hosting of the shop’s clusters' })] });
    const orderForm = shared.contracts.find((c: { title: string }) => c.title === 'Order form: agent workspace licences');
    expect(orderForm).toMatchObject({
      parent: { title: 'Platform framework agreement' },
      slaAvailability: 99.5,
      dpa: { personalData: true, inheritedFrom: 'master' },
    });
    expect(orderForm.inherited).toContain('slaAvailability');
    expect(shared.contacts.find((c: { name: string }) => c.name === 'Example Cloud hosting account manager').scope[0]).toMatchObject({
      kind: 'contract',
      id: hosting.id,
    });
    expect((await s.api('GET', '/suppliers/shared-suggestions')).some((g: { name: string }) => g.name.startsWith('Invented Relay Mail'))).toBe(true);
    // the team-scoped one belongs to a team that takes no new resources: the demo teams' members keep their defaults
    const { newResourceTeams } = await import('../src/auth/policy.js');
    const { findUserByName, toAuthUser } = await import('../src/auth/users.js');
    for (const name of ['olivia', 'adam']) {
      const teams = newResourceTeams(toAuthUser(findUserByName(name)!)).teams.map((t) => t.name);
      expect(teams, name).not.toContain('Service Desk');
      expect(teams, name).not.toContain('Mail relay team');
    }
    const toConfirm = (await s.api('GET', '/suppliers?status=unconfirmed')) as { name: string }[];
    expect(toConfirm.map((x) => x.name)).toEqual(expect.arrayContaining(['Zentrova Cloud', 'Mailbrook']));

    // cost plans of the shop and the plant (ADR 0026): the demo's fiscal year starts in October
    expect((await s.api('GET', '/costs/settings')).fiscalYearStartMonth).toBe(10);
    const shopPlan = await s.api('GET', `/costs/plans/${shop.id}`);
    expect(shopPlan.label).toMatch(/^FY \d{4}\/\d{2}$/);
    expect(shopPlan.lines.map((l: { title: string }) => l.title)).toEqual(
      expect.arrayContaining(['Cloud hosting of the webshop', 'Payment gateway licence – Licence fee', 'Cluster support subscription']),
    );
    // contract payments (ADR 0030): the licence's lines made from its schedule, an imported ERP export with a duplicate
    expect(shopPlan.lines.filter((l: { schedule: unknown }) => l.schedule).length).toBeGreaterThan(0);
    const imports = await s.api('GET', `/costs/plans/${shop.id}/imports`);
    expect(imports.imports[0]).toMatchObject({ fileName: 'erp-export-demo.csv' });
    expect(imports.imports[0].skipped).toMatchObject({ duplicate: 1 });
    const owed = await s.api('GET', `/costs/commitments?serviceId=${shop.id}`);
    expect(owed.rows.map((r: { title: string }) => r.title)).toContain('Licence fee');
    expect(shopPlan.lines.find((l: { title: string }) => l.title === 'Cluster support subscription').target).toMatchObject({
      kind: 'system',
      name: 'k8s-shop-01 (demo)',
    });
    expect(shopPlan.entries.some((e: { unplanned: boolean }) => e.unplanned)).toBe(true);
    const plantId = services.find((x) => x.name === 'Plant monitoring (demo)')!.id;
    const plantPlan = await s.api('GET', `/costs/plans/${plantId}`);
    expect(plantPlan.lines.map((l: { title: string }) => l.title)).toContain('Historian licences');
    expect(plantPlan.renewals.map((r: { title: string }) => r.title)).toContain('Historian licences');
    // the add-on prepaid in the last fiscal year: a quiet row in this one
    expect(plantPlan.prepaid.map((p: { title: string }) => p.title)).toContain('Historian analytics add-on – Three years prepaid');

    // the Home tiles have figures instead of "not set up yet"
    const home = await s.api('GET', '/dashboard');
    for (const tile of ['credentials', 'reviews', 'duties', 'scorecard']) expect(home.attention[tile], tile).toBeTruthy();
    expect(home.attention.vendorTickets.total).toBeGreaterThanOrEqual(1);

    // idempotent: a second run adds nothing
    const again = await s.api('POST', '/demo/setup', { services: true });
    expect(again.services).toBe(0);
    expect(((await s.api('GET', '/services')) as unknown[]).length).toBe(services.length);
  }, 120_000);
});
