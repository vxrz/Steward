import YAML from 'yaml';
import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Support channels, support levels and guides (0.26.0, ADR 0039 parts 4–8, docs/SUPPORT.md): the level catalogue
 * (administrators, audited), the channels, level and guides of data products, services and applications (the item's edit
 * right changes them, its view right shows them, team scope as everywhere), a product supported by a service (shown
 * only to who may see the service – otherwise not named), the deprecated `support` and `tier` (derived, and input that
 * sends them still works), the cleanup when a product is deleted, the upgrade's conversion (idempotent, audited), the
 * ODPS mapping checked against the vendored schema in both directions, /api/v1, and the statements of the product page.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
let s: TestServer;
let dana: Client, vera: Client, olivia: Client, bert: Client;
let shopTeam: string;
let svcShop: string;
let svcOpen: string;
let app: string;

const counted = new Map<string, number>();
const refused = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { status: number; body: any }) => {
      const b = typeof e.body === 'string' ? JSON.parse(e.body) : e.body;
      return { status: e.status, code: b?.code as string, details: (b?.params?.details ?? '') as string };
    },
  );
const audits = async (action: string, entityId?: string) =>
  (
    (await s.api('GET', `/audit?action=${action}${entityId ? `&entityId=${entityId}` : ''}&limit=200`)) as {
      action: string;
      summary: string;
      details?: unknown;
    }[]
  )
    .filter((e) => e.action === action)
    .reverse();

const CHANNELS = [
  { purpose: 'questions', tool: 'teams', name: '#orders-data', address: 'https://teams.example/orders', hours: 'Mo–Fr 08–17', note: '' },
  { purpose: 'issues', tool: 'ticket', name: 'Data incidents', address: 'https://tickets.example/new?queue=data', hours: '24×7', note: 'Group DATA-OPS' },
  { purpose: 'announcements', tool: 'email', name: 'Orders news', address: 'mailto:orders-news@shop.example', hours: '', note: '' },
  { purpose: 'access', tool: 'phone', name: 'Access desk', address: 'tel:+49 30 1234567', hours: 'Mo–Fr 09–12', note: 'Have your cost centre ready' },
];

beforeAll(async () => {
  s = await startTestServer({
    routes: (a) =>
      a.addHook('onSend', async (req, _reply, payload) => {
        const { requestDbTotals } = await import('../src/http-observability.js');
        counted.set(req.url.split('?')[0]!, requestDbTotals(req)?.statements ?? -1);
        return payload;
      }),
  });
  await setup(s);
  await s.api('PUT', '/settings/modules/dataProducts', { enabled: true });
  const users = await import('../src/auth/users.js');
  for (const [username, role] of [
    ['dana', 'designer'],
    ['vera', 'viewer'],
    ['olivia', 'operator'],
    ['bert', 'operator'],
  ] as const)
    users.createUser({ username, roles: [role], password: PW, mustChangePassword: false });
  [dana, vera, olivia, bert] = await Promise.all(['dana', 'vera', 'olivia', 'bert'].map((u) => s.as(u, PW)));
  shopTeam = (await s.api('POST', '/teams', { name: 'Support shop team', members: ['olivia'] })).id;
  // a service of the shop team (olivia edits it) and one of the whole instance
  svcShop = (await s.api('POST', '/services', { name: 'Support online shop', owners: ['user:olivia'] })).id;
  await s.api('PUT', `/owning-teams/service/${svcShop}`, { teamIds: [shopTeam] });
  svcOpen = (await s.api('POST', '/services', { name: 'Support operations', owners: ['user:bert'] })).id;
  app = (await s.api('POST', '/applications', { name: 'Support webshop app', owners: ['user:bert'] })).id;
}, 180_000);

describe('the support level catalogue', () => {
  it('starts a new installation with three example levels, audited as the system', async () => {
    const list = (await s.api('GET', '/support/levels')) as { nameEn: string; nameDe: string; hours: string; firstResponse: string; usage: number }[];
    expect(list.map((l) => l.nameEn)).toEqual(['Business hours', 'Extended', '24×7']);
    expect(list.map((l) => l.nameDe)).toEqual(['Geschäftszeiten', 'Erweitert', '24×7']);
    for (const l of list) expect(l.hours && l.firstResponse).toBeTruthy();
    const made = await audits('support.level_created');
    expect(made).toHaveLength(3);
  });

  it('is read by every signed-in reader, changed by administrators only (audited)', async () => {
    expect(((await vera('GET', '/support/levels')) as unknown[]).length).toBe(3);
    expect(await refused(dana('POST', '/support/levels', { nameEn: 'Gold' }))).toMatchObject({ status: 403 });
    const gold = await s.api('POST', '/support/levels', {
      nameEn: 'Gold',
      nameDe: 'Gold',
      hours: 'Mo–Sa 07–20',
      firstResponse: '2 hours',
      slaUrl: 'https://wiki.example/sla/gold',
    });
    expect(gold).toMatchObject({ nameEn: 'Gold', usage: 0, position: 3 });
    expect(await refused(s.api('POST', '/support/levels', { nameEn: 'gold' }))).toMatchObject({ status: 409, code: 'SUPPORT_LEVEL_EXISTS' });
    expect(await refused(s.api('POST', '/support/levels', { nameEn: 'X', slaUrl: 'ftp://x.example' }))).toMatchObject({ status: 400, code: 'INVALID_INPUT' });
    await s.api('PUT', `/support/levels/${gold.id}`, { nameEn: 'Gold', nameDe: 'Gold', hours: 'Mo–Sa 07–21', firstResponse: '2 hours' });
    expect(await audits('support.level_updated', gold.id)).toHaveLength(1);
    const ids = ((await s.api('GET', '/support/levels')) as { id: string }[]).map((l) => l.id);
    const order = [gold.id, ...ids.filter((x) => x !== gold.id)];
    expect(((await s.api('PUT', '/support/levels/order', { ids: order })) as { id: string }[]).map((l) => l.id)).toEqual(order);
    expect(await refused(s.api('PUT', '/support/levels/order', { ids: order.slice(1) }))).toMatchObject({ status: 400, code: 'SUPPORT_LEVEL_ORDER' });
    expect(await audits('support.level_reordered')).toHaveLength(1);
  });

  it('removes a level in use only when told what its items get – merging moves them', async () => {
    const levels = (await s.api('GET', '/support/levels')) as { id: string; nameEn: string }[];
    const gold = levels.find((l) => l.nameEn === 'Gold')!;
    const extended = levels.find((l) => l.nameEn === 'Extended')!;
    await s.api('PUT', `/services/${svcOpen}/support`, { levelId: gold.id });
    expect(await refused(s.api('DELETE', `/support/levels/${gold.id}`))).toMatchObject({ status: 409, code: 'SUPPORT_LEVEL_IN_USE' });
    await s.api('DELETE', `/support/levels/${gold.id}?replaceWith=${extended.id}`);
    expect(((await s.api('GET', `/services/${svcOpen}`)) as { supportLevel: { id: string } }).supportLevel.id).toBe(extended.id);
    const deleted = await audits('support.level_deleted', gold.id);
    expect(deleted[0]!.summary).toContain('now use "Extended"');
  });
});

let product = '';
const levelId = async (name: string) => ((await s.api('GET', '/support/levels')) as { id: string; nameEn: string }[]).find((l) => l.nameEn === name)!.id;

describe('channels, level and guides of a data product', () => {
  it('are changed with the edit right, in their order, and audited as a change of the product', async () => {
    product = (await dana('POST', '/data-products', { key: 'support-orders', name: 'Support orders' })).id;
    const ext = await levelId('Extended');
    const p = await dana('PUT', `/data-products/${product}/support`, {
      channels: CHANNELS,
      levelId: ext,
      guides: [{ title: 'User guide', url: 'https://wiki.example/orders/guide' }],
    });
    expect(p.supportChannels.map((c: { purpose: string }) => c.purpose)).toEqual(['questions', 'issues', 'announcements', 'access']);
    expect(p.supportChannels[1]).toMatchObject({ tool: 'ticket', note: 'Group DATA-OPS', hours: '24×7' });
    expect(p.supportLevel).toMatchObject({ id: ext, nameEn: 'Extended', firstResponse: expect.any(String) });
    expect(p.guides).toEqual([{ id: expect.any(String), title: 'User guide', url: 'https://wiki.example/orders/guide' }]);
    // the deprecated fields are derived: the first channel for questions, the tier of the level (none: it was not made from one)
    expect(p.support).toEqual({ channel: '#orders-data', url: 'https://teams.example/orders', hours: 'Mo–Fr 08–17' });
    expect(p.tier).toBeNull();
    // reordered: the same channels, the other way round
    const back = await dana('PUT', `/data-products/${product}/support`, { channels: [...CHANNELS].reverse() });
    expect(back.supportChannels.map((c: { purpose: string }) => c.purpose)).toEqual(['access', 'announcements', 'issues', 'questions']);
    // the same again changes nothing
    await dana('PUT', `/data-products/${product}/support`, { channels: [...CHANNELS].reverse(), levelId: ext });
    const entries = (await audits('dataproduct.updated', product)).filter((e) => e.summary.includes('support') || e.summary.includes('guides'));
    expect(entries.map((e) => e.summary)).toEqual([
      'Data product "Support orders" changed (supportLevel, supportChannels, guides)',
      'Data product "Support orders" changed (supportChannels)',
    ]);
    // the lists show the level
    const list = (await vera('GET', '/data-products?q=support-orders')) as { items: { supportLevel: { nameEn: string } | null }[] };
    expect(list.items[0]!.supportLevel?.nameEn).toBe('Extended');
  });

  it('validates addresses and links before saving, naming the field', async () => {
    const bad = await refused(
      dana('PUT', `/data-products/${product}/support`, { channels: [CHANNELS[0], { purpose: 'issues', tool: 'web', address: 'javascript:alert(1)' }] }),
    );
    expect(bad).toMatchObject({ status: 400, code: 'INVALID_INPUT' });
    expect(bad!.details).toContain('channels.1.address');
    expect(await refused(dana('PUT', `/data-products/${product}/support`, { channels: [{ purpose: 'questions', tool: 'other' }] }))).toMatchObject({
      status: 400,
      details: expect.stringContaining('channels.0.address'),
    });
    expect(await refused(dana('PUT', `/data-products/${product}/support`, { guides: [{ title: 'x', url: 'file:///etc' }] }))).toMatchObject({
      details: expect.stringContaining('guides.0.url'),
    });
    expect(await refused(dana('PUT', `/data-products/${product}/support`, { levelId: 'spl_missing' }))).toMatchObject({
      status: 404,
      code: 'SUPPORT_LEVEL_NOT_FOUND',
    });
  });

  it('is seen with the view right, refused without the edit right, and unknown to who may not see the product', async () => {
    expect((await vera('GET', `/data-products/${product}`)).supportChannels).toHaveLength(4);
    expect(await refused(vera('PUT', `/data-products/${product}/support`, { channels: [] }))).toMatchObject({ status: 403 });
    const team = (await s.api('POST', '/teams', { name: 'Support secret team', members: ['dana'] })).id;
    const secret = (await dana('POST', '/data-products', { key: 'support-secret', name: 'Support secret' })).id;
    await s.api('PUT', `/owning-teams/data_product/${secret}`, { teamIds: [team] });
    expect(await refused(bert('GET', `/data-products/${secret}`))).toMatchObject({ status: 404 });
    expect(await refused(bert('PUT', `/data-products/${secret}/support`, { channels: [] }))).toMatchObject({ status: 404 });
  });
});

describe('a product supported by a service', () => {
  let supported = '';
  it('shows the service’s channels and level, marked, unless it names its own', async () => {
    await olivia('PUT', `/services/${svcShop}/support`, {
      channels: [{ purpose: 'issues', tool: 'ticket', name: 'Shop incidents', address: 'https://tickets.example/shop' }],
      levelId: await levelId('24×7'),
    });
    // made by an administrator: a product of the whole instance (dana is in a team now – hers would be the team's)
    supported = (await s.api('POST', '/data-products', { key: 'support-mart', name: 'Support mart' })).id;
    // dana does not see the shop team's service: she cannot name it (it reads as missing)
    expect(await refused(dana('GET', `/services/${svcShop}`))).toMatchObject({ status: 404 });
    expect(await refused(dana('PUT', `/data-products/${supported}/support`, { supportedByServiceId: svcShop }))).toMatchObject({
      status: 404,
      code: 'SERVICE_NOT_FOUND',
    });
    await s.api('PUT', `/data-products/${supported}/support`, { supportedByServiceId: svcShop });
    const seen = await olivia('GET', `/data-products/${supported}`);
    expect(seen.supportChannels).toEqual([]);
    expect(seen.supportedBy).toMatchObject({
      service: { id: svcShop, name: 'Support online shop' },
      channels: [{ name: 'Shop incidents', address: 'https://tickets.example/shop' }],
      level: { nameEn: '24×7' },
    });
  });

  it('is neither shown nor named to who may not see the service', async () => {
    for (const c of [dana, vera]) {
      const p = await c('GET', `/data-products/${supported}`);
      expect(p.supportedBy).toBeNull();
      expect(JSON.stringify(p)).not.toContain(svcShop);
      expect(JSON.stringify(p)).not.toContain('Support online shop');
      const odps = YAML.stringify(YAML.parse((await c('GET', `/data-products/${supported}/odps`)) as string));
      expect(odps).not.toContain('Shop incidents');
    }
    // the file export leaves the hidden service out, and an import of that file keeps it
    const yaml = (await dana('GET', `/data-products/${supported}/export`)) as string;
    expect(yaml).not.toContain('Support online shop');
    // dana keeps it when she changes other things
    await dana('PUT', `/data-products/${supported}/support`, { guides: [{ title: 'Mart guide', url: 'https://bi.example/mart' }] });
    expect((await olivia('GET', `/data-products/${supported}`)).supportedBy?.service.id).toBe(svcShop);
    // the /api/v1 read of a token of hers says nothing either
    const tok = (await vera('POST', '/me/tokens', { name: 'support', scope: 'read' })).token;
    const v1 = await (await fetch(`${s.base}/api/v1/data-products/${supported}`, { headers: { authorization: `Bearer ${tok}` } })).json();
    expect(v1.supportedBy).toBeNull();
    expect(JSON.stringify(v1)).not.toContain(svcShop);
  });
});

describe('services and applications', () => {
  it('carry channels and a level with their own edit right; lists show the level', async () => {
    expect(await refused(vera('PUT', `/services/${svcOpen}/support`, { channels: [] }))).toMatchObject({ status: 403 });
    const svc = await bert('PUT', `/services/${svcOpen}/support`, { channels: [CHANNELS[1]] });
    expect(svc.supportChannels).toHaveLength(1);
    expect(await refused(bert('PUT', `/services/${svcOpen}/support`, { guides: [] }))).toMatchObject({ status: 400, code: 'SUPPORT_INVALID' });
    // the shop team's service is unknown to bert
    expect(await refused(bert('PUT', `/services/${svcShop}/support`, { channels: [] }))).toMatchObject({ status: 404 });
    const a = await bert('PUT', `/applications/${app}/support`, { channels: [CHANNELS[0]], levelId: await levelId('Business hours') });
    expect(a).toMatchObject({ supportChannels: [{ purpose: 'questions' }], supportLevel: { nameEn: 'Business hours' } });
    expect(await refused(vera('PUT', `/applications/${app}/support`, { channels: [] }))).toMatchObject({ status: 403 });
    const apps = (await vera('GET', '/applications')) as { id: string; supportLevel: { nameEn: string } | null }[];
    expect(apps.find((x) => x.id === app)!.supportLevel?.nameEn).toBe('Business hours');
    expect(((await s.api('GET', '/services')) as { id: string; supportLevel: unknown }[]).find((x) => x.id === svcOpen)!.supportLevel).toMatchObject({
      nameEn: 'Extended',
    });
    expect((await audits('service.updated', svcOpen)).map((e) => e.summary)).toContain('Service "Support operations" changed (supportChannels)');
    expect((await audits('application.updated', app)).map((e) => e.summary)).toContain(
      'Application "Support webshop app" changed (supportLevel, supportChannels)',
    );
  });

  it('carry them on /api/v1', async () => {
    const tok = (await s.api('POST', '/me/tokens', { name: 'support-v1', scope: 'read' })).token;
    const get = async (u: string) => (await fetch(`${s.base}/api/v1${u}`, { headers: { authorization: `Bearer ${tok}` } })).json();
    expect(await get(`/services/${svcOpen}`)).toMatchObject({ supportLevel: { name: 'Extended' }, supportChannels: [{ purpose: 'issues', tool: 'ticket' }] });
    expect(await get(`/applications/${app}`)).toMatchObject({ supportLevel: { name: 'Business hours' }, supportChannels: [{ purpose: 'questions' }] });
    expect(await get(`/data-products/${product}`)).toMatchObject({
      supportLevel: { name: 'Extended', hours: expect.any(String), firstResponse: expect.any(String) },
      supportChannels: expect.arrayContaining([expect.objectContaining({ purpose: 'access', address: 'tel:+49 30 1234567' })]),
      guides: [{ title: 'User guide', url: 'https://wiki.example/orders/guide' }],
      support: { channel: '#orders-data' },
      tier: null,
    });
  });
});

describe('the deprecated support and tier', () => {
  it('map input the way the upgrade does, and what was read back changes nothing', async () => {
    const id = (
      await dana('POST', '/data-products', {
        key: 'support-legacy',
        name: 'Support legacy',
        support: { channel: 'Shop data desk', url: 'mailto:shop-data@shop.example', hours: '8–17' },
        tier: 2,
      })
    ).id;
    const p = await dana('GET', `/data-products/${id}`);
    expect(p.supportChannels).toEqual([
      {
        id: expect.any(String),
        purpose: 'questions',
        tool: 'email',
        name: 'Shop data desk',
        address: 'mailto:shop-data@shop.example',
        hours: '8–17',
        note: '',
      },
    ]);
    expect(p.supportLevel.nameEn).toBe('Tier 2');
    expect(p.tier).toBe(2);
    expect(p.support).toEqual({ channel: 'Shop data desk', url: 'mailto:shop-data@shop.example', hours: '8–17' });
    // an old client sends back what it read: nothing changes
    const before = await audits('dataproduct.updated', id);
    const { key, name, support, tier } = p;
    await dana('PUT', `/data-products/${id}`, { key, name, support, tier });
    const same = await dana('GET', `/data-products/${id}`);
    expect(same.supportChannels).toEqual(p.supportChannels);
    expect(same.supportLevel).toEqual(p.supportLevel);
    expect(((await audits('dataproduct.updated', id)).length - before.length) as number).toBe(1);
    expect(JSON.stringify((await audits('dataproduct.updated', id)).at(-1)!.details ?? {})).not.toContain('supportChannels');
    // a client that leaves them out keeps the channels and the level
    await dana('PUT', `/data-products/${id}`, { key, name });
    expect((await dana('GET', `/data-products/${id}`)).supportChannels).toHaveLength(1);
    // tier 2 again is the same level, made once
    await dana('POST', '/data-products', { key: 'support-legacy-2', name: 'Support legacy 2', tier: 2 });
    expect(((await s.api('GET', '/support/levels')) as { nameEn: string }[]).filter((l) => l.nameEn === 'Tier 2')).toHaveLength(1);
    // a new support replaces the first channel for questions; an empty one removes it; tier null removes the level
    await dana('PUT', `/data-products/${id}`, { key, name, support: { channel: '', url: '', hours: '' }, tier: null });
    const gone = await dana('GET', `/data-products/${id}`);
    expect(gone.supportChannels).toEqual([]);
    expect(gone.supportLevel).toBeNull();
  });
});

describe('deleting a product', () => {
  it('removes its channels and guides', async () => {
    const id = (await dana('POST', '/data-products', { key: 'support-gone', name: 'Support gone' })).id;
    await dana('PUT', `/data-products/${id}/support`, { channels: [CHANNELS[0]], guides: [{ title: 'g', url: 'https://wiki.example/g' }] });
    await dana('DELETE', `/data-products/${id}`);
    const { db } = await import('../src/db.js');
    expect(db().get('SELECT COUNT(*) AS n FROM support_channels WHERE item_id = ?', id)).toEqual({ n: 0 });
    expect(db().get('SELECT COUNT(*) AS n FROM guides WHERE item_id = ?', id)).toEqual({ n: 0 });
  });
});

describe('the upgrade', () => {
  it('turns a product’s support and tier into a channel and a level, once, audited as the system', async () => {
    const { db } = await import('../src/db.js');
    const { runAs } = await import('../src/auth/context.js');
    const { convertSupport } = await import('../src/support/upgrade.js');
    const { forgetLevels } = await import('../src/support/levels.js');
    const now = new Date().toISOString();
    const row = (id: string, key: string, support: string, tier: number | null) =>
      db().run(
        `INSERT INTO dp_products (id, key, name, name_norm, support, tier, lifecycle, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 'admin', ?, 'admin')`,
        id,
        key,
        key,
        key,
        support,
        tier,
        now,
        now,
      );
    row('dp_upg1', 'upg-mail', JSON.stringify({ channel: 'Data desk', url: 'mailto:desk@shop.example', hours: '8–17' }), 1);
    row('dp_upg2', 'upg-wiki', JSON.stringify({ channel: '#data', url: 'https://wiki.example/data', hours: '' }), 3);
    row('dp_upg3', 'upg-none', '{}', null);
    runAs(null, () => convertSupport());
    forgetLevels();
    const read = async (id: string) => s.api('GET', `/data-products/${id}`);
    const one = await read('dp_upg1');
    expect(one.supportChannels).toEqual([
      expect.objectContaining({ purpose: 'questions', tool: 'email', name: 'Data desk', address: 'mailto:desk@shop.example', hours: '8–17' }),
    ]);
    expect(one).toMatchObject({
      tier: 1,
      supportLevel: { nameEn: 'Tier 1' },
      support: { channel: 'Data desk', url: 'mailto:desk@shop.example', hours: '8–17' },
    });
    const two = await read('dp_upg2');
    expect(two.supportChannels[0]).toMatchObject({ tool: 'other', address: 'https://wiki.example/data' });
    expect(two).toMatchObject({ tier: 3, supportLevel: { nameEn: 'Tier 3' } });
    expect((await read('dp_upg3')).supportChannels).toEqual([]);
    const converted = await audits('dataproduct.support_converted');
    expect(converted).toHaveLength(2);
    expect(db().get<{ support: string; tier: null }>("SELECT support, tier FROM dp_products WHERE id = 'dp_upg1'")).toEqual({ support: '{}', tier: null });
    // a second run changes nothing; the example levels are not made again
    const levels = (await s.api('GET', '/support/levels')).length;
    runAs(null, () => convertSupport());
    expect(await audits('dataproduct.support_converted')).toHaveLength(2);
    expect((await s.api('GET', '/support/levels')).length).toBe(levels);
    expect((await read('dp_upg1')).supportChannels).toHaveLength(1);
  });
});

describe('ODPS', () => {
  it('maps channels, the level and guides as ADR 0039 part 7 says – valid against the vendored schema – and reads them back', async () => {
    const { odpsProblems } = await import('../src/dataproducts/odps.js');
    const doc = YAML.parse((await dana('GET', `/data-products/${product}/odps`)) as string);
    expect(odpsProblems(doc)).toEqual([]);
    const byName = (n: string) => doc.support.find((x: { channel: string }) => x.channel === n);
    expect(byName('#orders-data')).toEqual({
      channel: '#orders-data',
      url: 'https://teams.example/orders',
      tool: 'teams',
      scope: 'interactive',
      description: 'Hours: Mo–Fr 08–17',
    });
    expect(byName('Data incidents')).toEqual({
      channel: 'Data incidents',
      url: 'https://tickets.example/new?queue=data',
      tool: 'ticket',
      scope: 'issues',
      description: 'Hours: 24×7\nGroup DATA-OPS',
    });
    expect(byName('Orders news')).toMatchObject({ tool: 'email', scope: 'announcements' });
    expect(byName('Access desk')).toMatchObject({ tool: 'phone', customProperties: [{ property: 'purpose', value: 'access' }] });
    expect(byName('Access desk').scope).toBeUndefined();
    expect(doc.customProperties.find((c: { property: string }) => c.property === 'supportLevel').value).toEqual({
      name: 'Extended',
      hours: expect.any(String),
      firstResponse: expect.any(String),
    });
    expect(doc.customProperties.find((c: { property: string }) => c.property === 'supportTier')).toBeUndefined();
    expect(doc.authoritativeDefinitions).toEqual([{ type: 'userGuide', url: 'https://wiki.example/orders/guide', description: 'User guide' }]);

    // the round trip: the document imported as another product gives the same channels, level and guides
    const copy = { ...doc, id: 'support-odps-copy', name: 'Support ODPS copy' };
    const files = [{ name: 'copy.odps.yaml', content: YAML.stringify(copy) }];
    const pv = await dana('POST', '/data-products/import/preview', { files, mode: 'update' });
    expect(pv.problems).toEqual([]);
    await dana('POST', '/data-products/import', { files, mode: 'update', fingerprint: pv.fingerprint });
    const list = (await dana('GET', '/data-products?q=support-odps-copy')) as { items: { id: string }[] };
    const back = await dana('GET', `/data-products/${list.items[0]!.id}`);
    const strip = (cs: { id?: string }[]) => cs.map(({ id: _i, ...c }) => c);
    const orig = await dana('GET', `/data-products/${product}`);
    expect(strip(back.supportChannels)).toEqual(strip(orig.supportChannels));
    expect(back.supportLevel).toEqual(orig.supportLevel);
    expect(strip(back.guides)).toEqual(strip(orig.guides));
    // and its export is the same document again (but for the id and name)
    const again = YAML.parse((await dana('GET', `/data-products/${back.id}/odps`)) as string);
    expect(odpsProblems(again)).toEqual([]);
    expect(again.support).toEqual(doc.support);
  });
});

describe('the file format', () => {
  it('carries channels, the level by name, guides and the supporting service – a round trip changes nothing', async () => {
    const yaml = (await dana('GET', `/data-products/${product}/export`)) as string;
    const f = YAML.parse(yaml);
    const entry = f.data_product ?? f.data_products?.[0];
    expect(entry.support_level).toMatchObject({ name: 'Extended' });
    expect(entry.support_channels).toHaveLength(4);
    expect(entry.guides).toEqual([{ title: 'User guide', url: 'https://wiki.example/orders/guide' }]);
    expect(entry.support).toBeUndefined();
    expect(entry.tier).toBeUndefined();
    const pv = await dana('POST', '/data-products/import/preview', { files: [{ name: 'x.yaml', content: yaml }], mode: 'update' });
    expect(pv.problems).toEqual([]);
    expect(pv.counts?.update ?? 0).toBe(0);
    // a level the instance does not have is a problem of the preview, named
    const unknown = YAML.stringify({ version: 1, data_product: { ...entry, support_level: { name: 'Platinum' } } });
    const p2 = await dana('POST', '/data-products/import/preview', { files: [{ name: 'y.yaml', content: unknown }], mode: 'update' });
    expect(JSON.stringify(p2.problems)).toContain('Platinum');
  });
});

describe('statements', () => {
  it('reads a product’s support in bulk: a supporting service costs a fixed few statements, not one per channel', async () => {
    const id = (await dana('POST', '/data-products', { key: 'support-count', name: 'Support count' })).id;
    await dana('GET', `/data-products/${id}`);
    const bare = counted.get(`/api/data-products/${id}`)!;
    await s.api('PUT', `/data-products/${id}/support`, {
      channels: CHANNELS,
      guides: [1, 2, 3].map((i) => ({ title: `g${i}`, url: `https://wiki.example/${i}` })),
      supportedByServiceId: svcOpen,
    });
    await dana('GET', `/data-products/${id}`);
    const full = counted.get(`/api/data-products/${id}`)!;
    // the supporting service's row and its visibility – the channels of both and the guides are one statement each anyway
    expect(full - bare).toBeLessThanOrEqual(2);
  });
});
