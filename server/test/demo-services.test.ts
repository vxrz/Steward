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
    expect((duties.items ?? duties).length).toBe(3);
    const maintenance = await s.api('GET', '/maintenance-windows');
    expect(JSON.stringify(maintenance)).toContain('Shop database upgrade');
    expect((await s.api('GET', '/status-pages')).length).toBe(1);
    expect(JSON.stringify(await s.api('GET', '/report-schedules'))).toContain('Weekly service meeting (demo)');
    const systems = (await s.api('GET', '/systems')) as { name: string }[];
    expect(systems.map((x) => x.name)).toContain('k8s-shop-01 (demo)');

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
