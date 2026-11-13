import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Notifications of data products (ADR 0036 part 17, WP4): `dataproduct.deprecated` to registered consumers and the
 * owners of consuming products, with sunset date and successor, once per item and sunset date; `elements_missing` once
 * per product and discovery run; `discovery_failed` once per source until it succeeds – each only to who may see what
 * it names.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
let s: TestServer;
let dana: Client;
let vera: Client;
let olivia: Client;
let adam: Client;
let audrey: Client;
let kafka = '';
let orders = '';
let port = '';
let topic = '';
let mart = '';
let hiddenMart = '';

interface Note {
  event: string;
  title: string;
  body: string;
  link?: string;
}
const notes = async (who: Client, event: string, about?: string): Promise<Note[]> => {
  const r = (await who('GET', '/notifications?limit=500')) as { items?: Note[] } | Note[];
  const list = (Array.isArray(r) ? r : (r.items ?? [])) as Note[];
  return list.filter((n) => n.event === event && (!about || String(n.link ?? '').includes(about)));
};

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  await s.api('PUT', '/settings/modules/dataProducts', { enabled: true });
  dana = await s.as('dana', PW);
  vera = await s.as('vera', PW);
  olivia = await s.as('olivia', PW);
  adam = await s.as('adam', PW);
  audrey = await s.as('audrey', PW);
  kafka = ((await s.api('GET', '/platforms')) as { id: string; kind: string }[]).find((p) => p.kind === 'kafka')!.id;
  await s.api('POST', '/teams', { name: 'Invented consumer team', members: ['olivia'] });
  orders = (await dana('POST', '/data-products', { key: 'notice-orders', name: 'Notice orders', owners: ['user:dana'] })).id;
  port = (await dana('POST', `/data-products/${orders}/ports`, { direction: 'output', name: 'orders', type: 'topic', version: 'v1' })).id;
  topic = (await dana('POST', '/data-elements', { platformId: kafka, kind: 'kafka.topic', qualifiedName: 'notice.orders.v1', environment: 'prod' })).id;
  await dana('PUT', `/data-products/${orders}/ports/${port}/bindings/prod`, { elementIds: [topic] });
  await dana('POST', `/data-products/${orders}/ports/${port}/consumers`, { kind: 'team', subject: 'team:Invented consumer team', purpose: 'Reports' });
  await dana('POST', `/data-products/${orders}/ports/${port}/consumers`, { kind: 'user', subject: 'user:adam', contacts: ['user:audrey'] });
  // consuming products: olivia owns the mart, adam owns another one that olivia may not see
  mart = (await dana('POST', '/data-products', { key: 'notice-mart', name: 'Notice mart', owners: ['user:olivia'] })).id;
  await dana('POST', `/data-products/${mart}/ports`, { direction: 'input', name: 'orders', source: { kind: 'port', portId: port } });
  hiddenMart = (await s.api('POST', '/data-products', { key: 'notice-secret', name: 'Secret mart', owners: ['user:adam'] })).id;
  await s.api('POST', `/data-products/${hiddenMart}/ports`, { direction: 'input', name: 'orders', source: { kind: 'port', portId: port } });
  const secretTeam = (await s.api('POST', '/teams', { name: 'Invented secret team', members: ['adam'] })).id;
  const { db } = await import('../src/db.js');
  db().run(
    "INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('data_product', ?, ?, ?)",
    hiddenMart,
    secretTeam,
    new Date().toISOString(),
  );
}, 180_000);

describe('dataproduct.deprecated', () => {
  it('tells registered consumers and the owners of consuming products once, naming only what they may see', async () => {
    const successor = (await dana('POST', '/data-products', { key: 'notice-orders-2', name: 'Notice orders 2' })).id;
    await dana('POST', `/data-products/${orders}/lifecycle`, { lifecycle: 'deprecated', sunsetDate: '2027-06-30', successorId: successor });
    // the team's member, the registered user, the contact – and olivia also owns the consuming mart
    const o = await notes(olivia, 'dataproduct.deprecated', orders);
    expect(o).toHaveLength(1);
    expect(o[0]!.title).toBe('Data product deprecated: Notice orders');
    expect(o[0]!.body).toContain('2027-06-30');
    expect(o[0]!.body).toContain('Successor: Notice orders 2');
    expect(o[0]!.body).toContain('registered as a consumer of: orders v1');
    expect(o[0]!.body).toContain('Your data products that use it: Notice mart');
    // the hidden consuming product is named only to its owner
    expect(o[0]!.body).not.toContain('Secret mart');
    const a = await notes(adam, 'dataproduct.deprecated', orders);
    expect(a).toHaveLength(1);
    expect(a[0]!.body).toContain('Secret mart');
    expect(a[0]!.body).not.toContain('Notice mart');
    expect(await notes(audrey, 'dataproduct.deprecated', orders)).toHaveLength(1);
    // who neither consumes nor owns a consuming product is not told
    expect(await notes(vera, 'dataproduct.deprecated', orders)).toHaveLength(0);
    expect(await notes(dana, 'dataproduct.deprecated', orders)).toHaveLength(0);
    const { noticesOf } = await import('../src/dataproducts/notices.js');
    expect(noticesOf('product', [orders]).map((n) => n.notice_key)).toEqual(['deprecated:2027-06-30']);
  });

  it('is sent again only for a new sunset date or a new deprecation', async () => {
    const { noticesOf, onLifecycleChanged } = await import('../src/dataproducts/notices.js');
    // the same state again: nothing new
    await dana('POST', `/data-products/${orders}/lifecycle`, { lifecycle: 'deprecated', sunsetDate: '2027-06-30' });
    expect(onLifecycleChanged('product', orders, { from: 'active', to: 'deprecated', sunsetDate: '2027-06-30' })).toBe(0);
    expect(await notes(olivia, 'dataproduct.deprecated', orders)).toHaveLength(1);
    // a new sunset date
    await dana('POST', `/data-products/${orders}/lifecycle`, { lifecycle: 'deprecated', sunsetDate: '2027-09-30' });
    const o = await notes(olivia, 'dataproduct.deprecated', orders);
    expect(o).toHaveLength(2);
    expect(o.some((n) => n.body.includes('2027-09-30'))).toBe(true);
    // back to active forgets it; deprecating again tells again
    await dana('PUT', `/data-products/${orders}`, { key: 'notice-orders', name: 'Notice orders', owners: ['user:dana'] });
    await dana('POST', `/data-products/${orders}/lifecycle`, { lifecycle: 'active' });
    expect(noticesOf('product', [orders])).toEqual([]);
    const { db } = await import('../src/db.js');
    db().run("DELETE FROM notifications WHERE event = 'dataproduct.deprecated'");
    await dana('POST', `/data-products/${orders}/lifecycle`, { lifecycle: 'deprecated', sunsetDate: '2027-09-30' });
    expect(await notes(olivia, 'dataproduct.deprecated', orders)).toHaveLength(1);
  });

  it('tells nobody who may not see the deprecated product', async () => {
    const team = (await s.api('POST', '/teams', { name: 'Invented owner team', members: ['dana'] })).id;
    const secret = (await dana('POST', '/data-products', { key: 'notice-team-owned', name: 'Team owned product', owners: ['user:dana'] })).id;
    const { db } = await import('../src/db.js');
    db().run(
      "INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('data_product', ?, ?, ?) ON CONFLICT DO NOTHING",
      secret,
      team,
      new Date().toISOString(),
    );
    const p = (await dana('POST', `/data-products/${secret}/ports`, { direction: 'output', name: 'feed', type: 'topic' })).id;
    await dana('POST', `/data-products/${secret}/ports/${p}/consumers`, { kind: 'user', subject: 'user:vera' });
    await dana('POST', `/data-products/${secret}/lifecycle`, { lifecycle: 'deprecated', sunsetDate: '2027-01-31' });
    expect(await notes(vera, 'dataproduct.deprecated', secret)).toHaveLength(0);
    expect(JSON.stringify(await vera('GET', '/notifications?limit=500'))).not.toContain('Team owned product');
  });

  it('tells the consumers of a deprecated port, and forgets a removed port', async () => {
    const events = (await dana('POST', `/data-products/${mart}/ports`, { direction: 'output', name: 'events', type: 'topic', version: 'v3' })).id;
    await dana('POST', `/data-products/${mart}/ports/${events}/consumers`, { kind: 'user', subject: 'user:audrey' });
    await dana('PUT', `/data-products/${mart}/ports/${events}`, {
      direction: 'output',
      name: 'events',
      type: 'topic',
      version: 'v3',
      lifecycle: 'deprecated',
      sunsetDate: '2027-02-28',
    });
    const a = await notes(audrey, 'dataproduct.deprecated', mart);
    expect(a).toHaveLength(1);
    expect(a[0]!.title).toBe('Port events v3 of Notice mart deprecated');
    expect(a[0]!.body).toContain('2027-02-28');
    const { noticesOf } = await import('../src/dataproducts/notices.js');
    expect(noticesOf('port', [events])).toHaveLength(1);
    await dana('DELETE', `/data-products/${mart}/ports/${events}`);
    expect(noticesOf('port', [events])).toEqual([]);
  });
});

describe('discovery notices', () => {
  let source = '';
  it('tells the owners of a product once per run that elements are missing', async () => {
    const { db } = await import('../src/db.js');
    const now = new Date().toISOString();
    source = 'dpq_notice_1';
    db().run(
      `INSERT INTO dp_discovery_sources (id, name, platform_id, run_as, created_at, created_by, updated_at, updated_by) VALUES (?, 'Invented Kafka read', ?, 'dana', ?, 'dana', ?, 'dana')`,
      source,
      kafka,
      now,
      now,
    );
    const { noticeDiscoveryRun } = await import('../src/dataproducts/notices.js');
    expect(noticeDiscoveryRun({ sourceId: source, runId: 'dpn_n1', status: 'succeeded', missingElementIds: [topic] })).toEqual({ failed: 0, missing: 1 });
    expect(noticeDiscoveryRun({ sourceId: source, runId: 'dpn_n1', status: 'succeeded', missingElementIds: [topic] })).toEqual({ failed: 0, missing: 0 });
    const d = await notes(dana, 'dataproduct.elements_missing', orders);
    expect(d).toHaveLength(1);
    expect(d[0]!.title).toBe('Data product Notice orders: 1 element missing');
    expect(d[0]!.body).toContain('notice.orders.v1 (prod)');
    expect(d[0]!.body).toContain('Invented Kafka read');
    // the owners only
    expect(await notes(olivia, 'dataproduct.elements_missing', orders)).toHaveLength(0);
    // a later run tells again
    expect(noticeDiscoveryRun({ sourceId: source, runId: 'dpn_n2', status: 'truncated', missingElementIds: [topic] }).missing).toBe(1);
  });

  it('tells the source owner and the platform managers once until the source succeeds again', async () => {
    const { noticeDiscoveryRun } = await import('../src/dataproducts/notices.js');
    const r = noticeDiscoveryRun({ sourceId: source, runId: 'dpn_f1', status: 'failed', error: 'HTTP 401 – the key was refused' });
    expect(r.failed).toBeGreaterThanOrEqual(1);
    expect(noticeDiscoveryRun({ sourceId: source, runId: 'dpn_f2', status: 'failed', error: 'again' }).failed).toBe(0);
    const d = await notes(dana, 'dataproduct.discovery_failed');
    expect(d).toHaveLength(1);
    expect(d[0]!.title).toBe('Discovery failing: Invented Kafka read');
    expect(d[0]!.body).toContain('HTTP 401');
    // viewers see no platforms and are not told
    expect(await notes(vera, 'dataproduct.discovery_failed')).toHaveLength(0);
    noticeDiscoveryRun({ sourceId: source, runId: 'dpn_ok', status: 'succeeded' });
    const { db } = await import('../src/db.js');
    db().run("DELETE FROM notifications WHERE event = 'dataproduct.discovery_failed'");
    expect(
      noticeDiscoveryRun({ sourceId: source, runId: 'dpn_f3', status: 'failed', error: 'down', failingSince: '2026-11-13T10:00:00Z' }).failed,
    ).toBeGreaterThanOrEqual(1);
    expect(await notes(dana, 'dataproduct.discovery_failed')).toHaveLength(1);
  });

  it('are in the app and by e-mail by default, in the quiet-hours group Data products', async () => {
    const { EVENT_DIGEST_GROUP, notificationCategory } = await import('@sm/shared');
    const { getNotificationSettings } = await import('../src/notifications/settings.js');
    const routes = getNotificationSettings().routes;
    for (const e of ['dataproduct.deprecated', 'dataproduct.elements_missing', 'dataproduct.discovery_failed'] as const) {
      expect(routes[e]).toEqual(['inApp', 'email']);
      expect(EVENT_DIGEST_GROUP[e]).toBe('dataProducts');
    }
    expect(notificationCategory('dataproduct.discovery_failed')).toBe('alert');
  });
});
