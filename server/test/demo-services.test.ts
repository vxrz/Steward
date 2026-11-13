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
    // volumes (ADR 0032): the data platform's prepaid capacity drawn down by its read costs, and a translation
    // framework billed by use with a committed minimum
    const all = await s.api('GET', '/costs/commitments');
    type Row = {
      title: string;
      payer: { kind: string; name: string };
      volume: { billing: string; committed: string; consumption: string; used: string | null } | null;
    };
    const cap = (all.rows as Row[]).find((r) => r.title === 'Prepaid capacity');
    expect(cap).toMatchObject({ payer: { kind: 'platform', name: 'Snowflake (demo)' }, volume: { billing: 'prepaid', consumption: 'read' } });
    expect(Number(cap!.volume!.used)).toBeGreaterThan(0);
    const fw = (all.rows as Row[]).find((r) => r.title === 'Translation volume');
    expect(fw).toMatchObject({ payer: { kind: 'service', name: 'Customer care (demo)' }, volume: { billing: 'byUse', committed: 'minimum' } });
    expect(Number(fw!.volume!.used)).toBeGreaterThan(0);

    // the Home tiles have figures instead of "not set up yet"
    const home = await s.api('GET', '/dashboard');
    for (const tile of ['credentials', 'reviews', 'duties', 'scorecard']) expect(home.attention[tile], tile).toBeTruthy();
    expect(home.attention.vendorTickets.total).toBeGreaterThanOrEqual(1);

    // idempotent: a second run adds nothing
    const again = await s.api('POST', '/demo/setup', { services: true });
    expect(again.services).toBe(0);
    expect(((await s.api('GET', '/services')) as unknown[]).length).toBe(services.length);
  }, 120_000);

  it('loads the data products of the demo with it – there once the module is switched on', async () => {
    await s.api('PUT', '/settings/modules/dataProducts', { enabled: true });
    try {
      const list = (await s.api('GET', '/data-products')) as { items: { id: string; key: string; lifecycle: string }[]; total: number };
      expect(list.items.map((p) => p.key).sort()).toEqual(['customer-360', 'machine-measurements', 'orders', 'sales-mart']);
      const orders = list.items.find((p) => p.key === 'orders')!;
      const p = await s.api('GET', `/data-products/${orders.id}`);
      expect(p).toMatchObject({ lifecycle: 'active', type: 'sourceAligned' });
      expect(p.environmentDetails.map((e: { environment: string }) => e.environment)).toEqual(['prod', 'dev']);
      // the ports: v2 under the contract Shop orders, v1 deprecated with its sunset date
      const v2 = p.ports.find((x: { version: string }) => x.version === 'v2');
      expect(v2.bindings.find((b: { environment: string }) => b.environment === 'prod').contract).toMatchObject({ key: 'shop-orders' });
      expect(p.ports.find((x: { version: string }) => x.version === 'v1')).toMatchObject({ lifecycle: 'deprecated', sunsetDate: '2027-06-30' });
      // discovered with the name rule (SHOP_DEV → dev), the pipeline, a draft monitor, costs and the missing stage
      const dev = await s.api('GET', '/data-elements?prefix=SHOP_DEV.CURATED.');
      expect(dev.items.every((e: { environment: string }) => e.environment === 'dev')).toBe(true);
      // its pipeline: its own five steps and the two of other products that read its elements
      const steps = ((await s.api('GET', `/data-products/${orders.id}/steps`)) as { name: string }[]).map((x) => x.name);
      expect(steps).toEqual(expect.arrayContaining(['Ingest orders', 'Stage orders', 'Curate orders', 'Region report', 'Build customer 360']));
      expect(p.environmentDetails.find((e: { environment: string }) => e.environment === 'prod').monitorId).toBeTruthy();
      const facts = await s.api('GET', `/data-products/facts?ids=${orders.id}`);
      expect(facts[0].maturity).toBeGreaterThanOrEqual(1);
      expect(facts[0].lastMonth.totals.length).toBeGreaterThan(0);
      expect((await s.api('GET', '/data-elements?prefix=SHOP_DEV.RAW.LANDING')).items[0].missingSince).toBeTruthy();
      // Customer 360 is below the rating of its data object, with a reason
      const c360 = await s.api('GET', `/data-products/${list.items.find((x) => x.key === 'customer-360')!.id}`);
      expect(c360.ratingFloor.findings.some((f: { dimension: string; reason: string | null }) => f.dimension === 'confidentiality' && !!f.reason)).toBe(true);
      // phase 2 (0.24.0): an OpenLineage source with two jobs – one documented by "Region report", one proposed
      const sources = (await s.api('GET', '/data-products/lineage-sources')) as { id: string; name: string; proposals: Record<string, number> }[];
      const airflow = sources.find((x) => x.name === 'Shop Airflow (demo)')!;
      expect(airflow.proposals).toMatchObject({ open: 1, documented: 1 });
      // quality results of the curated orders (dbt) and customers (Data Metric Functions)
      const curated = (await s.api('GET', '/data-elements?prefix=SHOP.CURATED.ORDERS&environment=prod')).items[0];
      const quality = await s.api('GET', `/data-elements/${curated.id}/quality`);
      expect(quality.results.map((r: { source: string }) => r.source)).toEqual(['dbt', 'dbt', 'dbt']);
      // Orders' port: one registration seen (role REPORTING), one silent, a reader not registered
      const actual = await s.api('GET', `/data-products/${orders.id}/ports/${v2.id}/actual?environment=prod`);
      expect(actual.counts).toMatchObject({ seen: 1, silent: 1 });
      expect(actual.counts.notRegistered).toBeGreaterThan(0);
      // an open access request for Customer 360's port
      const requests = await s.api('GET', '/data-products/access-requests?scope=all');
      expect(
        requests.items.some(
          (r: { status: string; consumer: { text: string } }) => r.status === 'pending' && r.consumer.text === 'Invented marketing analytics',
        ),
      ).toBe(true);
      // the Confluent cluster split by measured use, read from the Metrics API
      const allocations = (await s.api('GET', '/data-products/cost-allocations')) as {
        value: string;
        rule: string;
        measured: { readAt: string | null } | null;
      }[];
      expect(allocations.find((a) => a.value === 'lkc-demo1')).toMatchObject({ rule: 'measured', measured: { readAt: expect.any(String) } });
      // 0.25.0 (ADR 0037): the edge – a Databus topic → the bridge application on the edge device → a Confluent topic
      const machines = list.items.find((x) => x.key === 'machine-measurements')!;
      const bridge = ((await s.api('GET', `/data-products/${machines.id}/steps`)) as { name: string; runsOn: { name: string } | null }[]).find(
        (x) => x.name === 'Databus to Confluent',
      );
      expect(bridge?.runsOn).toMatchObject({ name: 'ied-line-01.example', environment: 'prod' });
      const databus = (await s.api('GET', '/data-elements?kind=mqtt.topic')).items[0];
      expect(databus).toMatchObject({ qualifiedName: 'ie/d/line-1/opcua/state' });
      const edge = ((await s.api('GET', '/systems')) as { id: string; name: string; iemDeviceId: string | null }[]).find(
        (x) => x.name === 'ied-line-01.example',
      );
      expect(edge?.iemDeviceId).toBe('dev-001');
      // the plant half once the registry is on: the edge device is an asset whose device is the system
      await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
      const e = await s.api('GET', '/plant/assets/rvs-edge-01/edge');
      expect(e.devices[0]).toMatchObject({ system: { id: edge!.id }, apps: [{ name: 'Edge Stream Bridge' }, { name: 'OPC UA Connector' }] });
      expect(e.collects.groups[0]).toMatchObject({ asset: { id: 'rvs-mill-01' }, collections: [{ id: 'edge-state', via: 'application' }] });
      expect((await s.api('GET', `/data-elements/${databus.id}`)).plantSink).toMatchObject({ assetId: 'rvs-mill-01', collectionId: 'edge-state' });
    } finally {
      await s.api('PUT', '/settings/modules/dataProducts', { enabled: false });
    }
  }, 120_000);
});
