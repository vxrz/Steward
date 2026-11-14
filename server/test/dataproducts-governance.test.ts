import { beforeAll, describe, expect, it } from 'vitest';
import { endorsementState, highOrAbove, matchConsumers, maturityLevel, promotedNames } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Consumers and access of data products (0.24.0, ADR 0036 phase 2): declared against actual consumers (Snowflake
 * ACCESS_HISTORY – metadata only, one read-only statement, "not available" for an edition without it – and Kafka
 * consumer groups); documented access (0.25.1): access requests are read-only history (410 to asking and deciding),
 * pending ones become registrations at the upgrade, the fulfilment of a registration; team scope; endorsement and
 * maturity 5.
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
let snowflake = '';
let kafka = '';
let product = '';
let port = '';
let hidden = '';
const counted = new Map<string, number>();

interface Note {
  event: string;
  title: string;
  body: string;
  link?: string;
}
const notes = async (who: Client, event: string): Promise<Note[]> => {
  const r = (await who('GET', '/notifications?limit=500')) as { items?: Note[] } | Note[];
  return ((Array.isArray(r) ? r : (r.items ?? [])) as Note[]).filter((n) => n.event === event);
};
const fail = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return { status: (e as { status: number }).status, ...((e as { body: Record<string, unknown> }).body ?? {}) };
  }
  throw new Error('expected the call to fail');
};

/** A contact of the directory (0.25.1) and a documented decision naming it. */
const contact = async (who: Client, name: string): Promise<string> => (await who('POST', '/contacts', { name })).id;
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const decision = (contactId: string, role = 'productOwner', more: Record<string, unknown> = {}) => ({
  decidedBy: [{ contactId, role }],
  decidedOn: yesterday(),
  ...more,
});

beforeAll(async () => {
  s = await startTestServer({
    routes: (app) =>
      app.addHook('onSend', async (req, _reply, payload) => {
        const { requestDbTotals } = await import('../src/http-observability.js');
        counted.set(req.url.replace(/^.*\/api/, ''), requestDbTotals(req)?.statements ?? -1);
        return payload;
      }),
  });
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  await s.api('PUT', '/settings/modules/dataProducts', { enabled: true });
  dana = await s.as('dana', PW);
  vera = await s.as('vera', PW);
  olivia = await s.as('olivia', PW);
  adam = await s.as('adam', PW);
  const platforms = (await s.api('GET', '/platforms')) as { id: string; kind: string }[];
  snowflake = platforms.find((p) => p.kind === 'snowflake')!.id;
  kafka = platforms.find((p) => p.kind === 'kafka')!.id;
  product = (await dana('POST', '/data-products', { key: 'gov-orders', name: 'Governed orders', owners: ['user:dana'] })).id;
  port = (await dana('POST', `/data-products/${product}/ports`, { direction: 'output', name: 'orders', type: 'table', version: 'v1' })).id;
  const table = (
    await dana('POST', '/data-elements', { platformId: snowflake, kind: 'snowflake.table', qualifiedName: 'GOV.SALES.ORDERS', environment: 'prod' })
  ).id;
  const topic = (await dana('POST', '/data-elements', { platformId: kafka, kind: 'kafka.topic', qualifiedName: 'gov.orders.v1', environment: 'prod' })).id;
  await dana('PUT', `/data-products/${product}/ports/${port}/bindings/prod`, { elementIds: [table, topic] });
  // a product only its secret team sees
  hidden = (await s.api('POST', '/data-products', { key: 'gov-secret', name: 'Secret governed', owners: ['user:adam'] })).id;
  const team = (await s.api('POST', '/teams', { name: 'Invented governance team', members: ['adam'] })).id;
  const { db } = await import('../src/db.js');
  db().run("INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('data_product', ?, ?, ?)", hidden, team, new Date().toISOString());
}, 180_000);

describe('pure rules', () => {
  it('match registrations to who really reads', () => {
    const m = matchConsumers(
      [
        { consumerId: 'a', identities: ['role:reporting'], userNames: [] },
        { consumerId: 'b', identities: [], userNames: ['adam', 'adam@invented.example'] },
        { consumerId: 'c', identities: ['user:NOBODY'], userNames: [] },
        { consumerId: 'd', identities: [], userNames: [] },
      ],
      [
        { kind: 'role', name: 'REPORTING' },
        { kind: 'user', name: 'ADAM@INVENTED.EXAMPLE' },
        { kind: 'group', name: 'billing' },
      ],
      true,
    );
    expect(m.declared.get('a')).toEqual({ state: 'seen', seenAs: ['role:REPORTING'] });
    expect(m.declared.get('b')?.state).toBe('seen');
    expect(m.declared.get('c')?.state).toBe('silent');
    expect(m.declared.get('d')?.state).toBe('unknown');
    expect(m.actual.get('group:billing')).toEqual([]);
    // without a successful read nobody is called silent
    expect(matchConsumers([{ consumerId: 'c', identities: ['user:x'], userNames: [] }], [], false).declared.get('c')?.state).toBe('unknown');
  });

  it('name an element in the next environment by the rules', () => {
    const rules = [
      { match: 'suffix' as const, value: '_DEV', environment: 'dev' },
      { match: 'prefix' as const, value: 'SHOP', environment: 'prod' },
      { match: 'prefix' as const, value: 'DEV_', environment: 'dev2' },
      { match: 'prefix' as const, value: 'PROD_', environment: 'prod2' },
    ];
    expect(promotedNames('SHOP_DEV.RAW.ORDERS', 'snowflake.table', 'dev', 'prod', rules)).toEqual(['SHOP.RAW.ORDERS', 'SHOP_DEV.RAW.ORDERS']);
    expect(promotedNames('DEV_DB.SALES.ORDERS', 'snowflake.table', 'dev2', 'prod2', rules)[0]).toBe('PROD_DB.SALES.ORDERS');
    expect(promotedNames('orders.v1', 'kafka.topic', 'test', 'prod', [])).toEqual(['orders.v1']);
  });

  it('rate high or above, endorsements and maturity 5', () => {
    const keys = ['normal', 'high', 'very_high'];
    expect([highOrAbove(keys, 'normal'), highOrAbove(keys, 'high'), highOrAbove(keys, 'very_high'), highOrAbove(keys, null)]).toEqual([
      false,
      true,
      true,
      false,
    ]);
    expect(endorsementState({ reviewDate: '2027-06-30', flagged: null }, '2026-11-13', false)).toEqual({ valid: true, review: null });
    expect(endorsementState({ reviewDate: '2026-12-01', flagged: null }, '2026-11-13', false)).toEqual({ valid: true, review: 'reviewDue' });
    expect(endorsementState({ reviewDate: '2026-11-01', flagged: null }, '2026-11-13', false)).toEqual({ valid: false, review: 'expired' });
    expect(endorsementState({ reviewDate: '2027-06-30', flagged: 'breakingChange' }, '2026-11-13', false).valid).toBe(false);
    expect(endorsementState({ reviewDate: '2027-06-30', flagged: null }, '2026-11-13', true).review).toBe('belowFloor');
    const all = () => 'met' as const;
    expect(maturityLevel(all, true)).toBe(5);
    expect(maturityLevel(all, false)).toBe(4);
    expect(maturityLevel((id) => (id === 'objectivesMet' ? 'notMet' : 'met'), true)).toBe(3);
  });
});

describe('declared against actual consumers', () => {
  it('reads ACCESS_HISTORY and the consumer groups, metadata only, and compares them with the registrations', async () => {
    const { setMockAccessHistory, setMockAccessHistoryAvailable } = await import('../src/mock/mockDataConsumers.js');
    const { resetSnowflakeStatements, snowflakeStatements } = await import('../src/mock/mockSnowflake.js');
    const { commitKafka, kafkaCalls, resetKafkaCalls } = await import('../src/mock/mockKafka.js');
    const { ACCESS_HISTORY_STATEMENT } = await import('../src/dataproducts/consumers-actual.js');
    setMockAccessHistoryAvailable(true);
    setMockAccessHistory([
      { object: 'GOV.SALES.ORDERS', user: 'ADAM', role: 'REPORTING', reads: 12, hoursAgo: 2 },
      { object: 'GOV.SALES.ORDERS', user: 'SVC_UNKNOWN', role: 'ETL_ROLE', reads: 40, hoursAgo: 1 },
      { object: 'OTHER.SALES.ORDERS', user: 'NOT_THIS_PORT', role: 'X', reads: 1, hoursAgo: 1 },
    ]);
    commitKafka('gov-billing', 'gov.orders.v1', [5]);
    const reg = (b: Record<string, unknown>) => dana('POST', `/data-products/${product}/ports/${port}/consumers`, b);
    const user = (await reg({ kind: 'user', subject: 'user:adam', purpose: 'Reports' })).id;
    const team = (await reg({ kind: 'team', subject: 'team:Invented governance team', purpose: 'Finance' })).id;
    const silent = (await reg({ kind: 'text', text: 'Old batch job', purpose: 'Nightly' })).id;
    await dana('PUT', `/data-products/${product}/ports/${port}/consumers/${team}/identities`, { identities: ['role:reporting'] });
    await dana('PUT', `/data-products/${product}/ports/${port}/consumers/${silent}/identities`, { identities: ['user:OLD_BATCH'] });
    expect(await fail(dana('PUT', `/data-products/${product}/ports/${port}/consumers/${silent}/identities`, { identities: ['nonsense'] }))).toMatchObject({
      status: 400,
    });

    resetSnowflakeStatements();
    resetKafkaCalls();
    // only who may change the product reads now
    expect(await fail(vera('POST', `/data-products/${product}/ports/${port}/actual/read`, { environment: 'prod' }))).toMatchObject({ status: 403 });
    const v = await dana('POST', `/data-products/${product}/ports/${port}/actual/read`, { environment: 'prod' });
    expect(v.reads.map((r: { platformKind: string; status: string }) => [r.platformKind, r.status]).sort()).toEqual([
      ['kafka', 'ok'],
      ['snowflake', 'ok'],
    ]);
    const state = (id: string) => v.declared.find((d: { consumerId: string }) => d.consumerId === id).state;
    expect([state(user), state(team), state(silent)]).toEqual(['seen', 'seen', 'silent']);
    const notRegistered = v.actual
      .filter((a: { registeredAs: string[] }) => !a.registeredAs.length)
      .map((a: { kind: string; name: string }) => `${a.kind}:${a.name}`);
    expect(notRegistered.sort()).toEqual(['group:gov-billing', 'role:ETL_ROLE', 'user:SVC_UNKNOWN']);
    expect(v.counts).toMatchObject({ seen: 2, silent: 1, notRegistered: 3 });
    expect(v.actual.find((a: { name: string }) => a.name === 'SVC_UNKNOWN')).toMatchObject({ reads: 40, objects: ['GOV.SALES.ORDERS'] });
    // metadata only: one read-only statement against ACCOUNT_USAGE, names as bindings; Kafka: offsets of groups, never a message
    const sent = snowflakeStatements().filter((x) => x.sql.includes('steward:dp-access-history'));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.sql).toBe(ACCESS_HISTORY_STATEMENT);
    expect(sent[0]!.sql).not.toMatch(/GOV\.SALES|INSERT|UPDATE|DELETE|QUERY_TEXT/);
    expect(JSON.parse(sent[0]!.bindings[2]!)).toEqual(['GOV.SALES.ORDERS']);
    expect(kafkaCalls().every((c) => c.startsWith('groups '))).toBe(true);

    // a viewer sees the comparison (who may see the product); a product they may not see answers like a missing one
    const seen = await vera('GET', `/data-products/${product}/ports/${port}/actual?environment=prod`);
    expect(seen.counts).toEqual(v.counts);
    expect(seen.canRead).toBe(false);
    expect(await fail(olivia('GET', `/data-products/${hidden}/ports/${port}/actual?environment=prod`))).toMatchObject({ status: 404 });

    // an edition without ACCESS_HISTORY: not available, nobody silent because of it, Kafka still read
    setMockAccessHistoryAvailable(false);
    const na = await dana('POST', `/data-products/${product}/ports/${port}/actual/read`, { environment: 'prod' });
    expect(na.reads.find((r: { platformKind: string }) => r.platformKind === 'snowflake')).toMatchObject({ status: 'notAvailable' });
    expect(na.actual.map((a: { name: string }) => a.name)).toEqual(['gov-billing']);
    setMockAccessHistoryAvailable(true);
  });

  it('reads now only the platforms the person may use – the others keep their last read, not marked failed', async () => {
    const { db } = await import('../src/db.js');
    const before = db().get<{ status: string; read_at: string; read_by: string }>(
      'SELECT status, read_at, read_by FROM dp_actual_reads WHERE port_id = ? AND environment = ? AND platform_id = ?',
      port,
      'prod',
      kafka,
    )!;
    expect(before.status).toBe('ok');
    // the Kafka platform becomes a team's that dana is not in
    const team = (await s.api('POST', '/teams', { name: 'Invented Kafka team', members: ['adam'] })).id;
    db().run("INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('platform', ?, ?, ?)", kafka, team, new Date().toISOString());
    try {
      const v = await dana('POST', `/data-products/${product}/ports/${port}/actual/read`, { environment: 'prod' });
      const after = db().get<{ status: string; read_at: string; read_by: string }>(
        'SELECT status, read_at, read_by FROM dp_actual_reads WHERE port_id = ? AND environment = ? AND platform_id = ?',
        port,
        'prod',
        kafka,
      )!;
      expect(after).toEqual(before);
      // what the last read found stays (dana sees it counted, not named: the platform is no longer hers to see)
      expect(v.reads.map((r: { platformKind: string }) => r.platformKind)).toContain('snowflake');
      expect(db().get("SELECT 1 FROM dp_actual_consumers WHERE port_id = ? AND platform_id = ? AND name = 'gov-billing'", port, kafka)).toBeTruthy();
    } finally {
      db().run("DELETE FROM resource_teams WHERE kind = 'platform' AND resource_id = ? AND team_id = ?", kafka, team);
    }
  });

  it('reads the comparison with a fixed number of statements, however many registrations there are', async () => {
    const url = `/data-products/${product}/ports/${port}/actual?environment=prod`;
    await dana('GET', url);
    const few = counted.get(url)!;
    for (let i = 0; i < 25; i++)
      await dana('POST', `/data-products/${product}/ports/${port}/consumers`, { kind: 'text', text: `Invented consumer ${i}`, purpose: 'Load' });
    await dana('GET', url);
    expect(few).toBeGreaterThan(0);
    expect(counted.get(url)!).toBeLessThanOrEqual(few + 1);
  });
});

describe('documented access (0.25.1, ADR 0038 part 3): no requests, no approvals', () => {
  const legacyRequest = async (status: string, consumer = 'Invented legacy report') => {
    const { db } = await import('../src/db.js');
    const id = `dpx_legacy_${status}_${Math.random().toString(36).slice(2, 8)}`;
    db().run(
      `INSERT INTO dp_access_requests (id, product_id, port_id, environment, requester, consumer_kind, consumer_text, purpose, until_date, identities, status, created_at, updated_at)
       VALUES (?, ?, ?, 'prod', 'olivia', 'text', ?, 'Monthly close', '2027-12-31', '["user:OLIVIA","role:FINANCE"]', ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
      id,
      product,
      port,
      consumer,
      status,
    );
    return id;
  };

  it('answers 410 DATA_ACCESS_DOCUMENTED_ONLY to asking, deciding and withdrawing; requests stay readable', async () => {
    const old = await legacyRequest('refused');
    for (const [url, body] of [
      [`/data-products/${product}/ports/${port}/access-requests`, { environment: 'prod', consumer: { kind: 'text', text: 'x' }, purpose: 'x' }],
      [`/data-products/access-requests/${old}/decision`, { decision: 'approve' }],
      [`/data-products/access-requests/${old}/withdraw`, {}],
    ] as const)
      expect(await fail(olivia('POST', url, body)), url).toMatchObject({ status: 410, code: 'DATA_ACCESS_DOCUMENTED_ONLY' });
    const r = await olivia('GET', `/data-products/access-requests/${old}`);
    expect(r).toMatchObject({ status: 'refused', mayDecide: false, mayWithdraw: false });
    expect((await dana('GET', `/data-products/${product}/access-requests`)).items.map((x: { id: string }) => x.id)).toContain(old);
    // nothing waits for a decision any more
    expect(await dana('GET', '/data-products/access-requests?scope=decide')).toEqual({ items: [], total: 0 });
    // the notices of requests are retired
    const { NOTIFICATION_EVENTS } = await import('@sm/shared');
    expect(NOTIFICATION_EVENTS).not.toContain('dataproduct.access_requested');
    expect(NOTIFICATION_EVENTS).not.toContain('dataproduct.access_decided');
  });

  it('turns pending requests into registrations whose approval is not documented at the upgrade, once and audited', async () => {
    const pending = await legacyRequest('pending', 'Invented pending report');
    const { convertOwnerFields, convertPendingRequests } = await import('../src/dataproducts/governance-upgrade.js');
    expect(convertPendingRequests()).toBe(1);
    expect(convertPendingRequests()).toBe(0);
    // the requester, its contact of before, becomes a contact linked to the account (step 3 of the upgrade)
    expect(convertOwnerFields()).toBeGreaterThan(0);
    const r = await dana('GET', `/data-products/access-requests/${pending}`);
    expect(r.status).toBe('converted');
    const consumers = (await dana('GET', `/data-products/${product}/ports/${port}/consumers`)) as Record<string, unknown>[];
    const c = consumers.find((x) => x.id === r.consumerId)!;
    expect(c).toMatchObject({
      kind: 'text',
      text: 'Invented pending report',
      purpose: 'Monthly close',
      endDate: '2027-12-31',
      approval: 'notDocumented',
      decision: null,
      requestId: pending,
    });
    expect(c.contacts).toEqual([expect.objectContaining({ role: 'consumerContact', contact: expect.objectContaining({ user: 'olivia' }) })]);
    const actual = await dana('GET', `/data-products/${product}/ports/${port}/actual?environment=prod`);
    expect(actual.declared.find((d: { consumerId: string }) => d.consumerId === r.consumerId).identities).toEqual(['role:FINANCE', 'user:OLIVIA']);
    const audit = (await s.api('GET', `/audit?action=dataproduct.access_request_converted&limit=10`)) as { entityId: string; actor: string }[];
    expect(audit).toEqual([expect.objectContaining({ entityId: product, actor: 'system' })]);
  });

  it('documents access on a registration: who decided, when, the evidence – recorded by an IT maintainer, audited', async () => {
    const owner = await contact(dana, 'Invented product owner');
    const url = `/data-products/${product}/ports/${port}/consumers`;
    // a viewer documents nothing
    expect((await fail(olivia('POST', url, { kind: 'text', text: 'x', decision: decision(owner) }))).status).toBe(403);
    // a decision in the future, or naming a contact the recorder may not see, is refused
    expect(await fail(dana('POST', url, { kind: 'text', text: 'Invented BI', decision: { ...decision(owner), decidedOn: '2999-01-01' } }))).toMatchObject({
      code: 'DATA_DECISION_INVALID',
      params: { context: 'decidedOn' },
    });
    expect(await fail(dana('POST', url, { kind: 'text', text: 'Invented BI', decision: decision('ct_nobody') }))).toMatchObject({
      status: 404,
      code: 'CONTACT_NOT_FOUND',
    });
    const c = await dana('POST', url, {
      kind: 'text',
      text: 'Invented BI',
      purpose: 'Dashboards',
      contacts: [{ role: 'consumerContact', contact: { name: 'Invented BI lead', email: 'bi.lead@invented.example' } }],
      decision: decision(owner, 'productOwner', { evidence: [{ kind: 'url', value: 'https://tickets.invented.example/ACC-12' }], note: 'Steering board' }),
    });
    expect(c).toMatchObject({
      approval: 'documented',
      decision: {
        decidedBy: [{ contactId: owner, name: 'Invented product owner', role: 'productOwner' }],
        decidedOn: yesterday(),
        evidence: [{ kind: 'url', value: 'https://tickets.invented.example/ACC-12' }],
        recordedBy: 'dana',
      },
    });
    expect(c.contacts).toEqual([expect.objectContaining({ role: 'consumerContact', contact: expect.objectContaining({ name: 'Invented BI lead' }) })]);
    // the names are frozen: renaming the contact keeps the decision's name
    await dana('PUT', `/contacts/${owner}`, { name: 'Invented renamed owner' });
    const again = ((await dana('GET', url)) as { id: string; decision: { decidedBy: { name: string }[] } }[]).find((x) => x.id === c.id)!;
    expect(again.decision.decidedBy[0]!.name).toBe('Invented product owner');
    // clearing it: not documented
    const cleared = await dana('PUT', `${url}/${c.id}`, { kind: 'text', text: 'Invented BI', decision: null });
    expect(cleared).toMatchObject({ approval: 'notDocumented', decision: null });
    // the contact's page counts the decisions that name it
    expect((await dana('GET', `/contacts/${owner}`)).decisions).toBe(0);
    await dana('PUT', `${url}/${c.id}`, { kind: 'text', text: 'Invented BI', decision: decision(owner) });
    expect((await dana('GET', `/contacts/${owner}`)).decisions).toBe(1);
    const audit = (await s.api('GET', `/audit?action=dataproduct.access_documented&entityId=${product}&limit=10`)) as unknown[];
    expect(audit.length).toBeGreaterThanOrEqual(2);
    // the consumers' contacts: names and roles for readers, e-mail addresses (and the CSV) for the maintainers
    const forReader = await olivia('GET', `/data-products/${product}/consumer-contacts`);
    const entry = forReader.entries.find((e: { consumerId: string }) => e.consumerId === c.id);
    expect(forReader.withEmail).toBe(false);
    expect(entry.contacts).toEqual([{ name: 'Invented BI lead', role: 'consumerContact', status: 'active' }]);
    const forMaintainer = await dana('GET', `/data-products/${product}/consumer-contacts?port=${port}`);
    expect(forMaintainer.entries.find((e: { consumerId: string }) => e.consumerId === c.id).contacts[0].email).toBe('bi.lead@invented.example');
    expect((await fail(olivia('GET', `/data-products/${product}/consumer-contacts.csv`))).status).toBe(403);
    const csv = (await dana('GET', `/data-products/${product}/consumer-contacts.csv?lang=en`)) as string;
    expect(csv).toContain('bi.lead@invented.example');
    expect(csv).toContain('Consumer contact');
    expect(await s.api('GET', `/audit?action=dataproduct.consumer_contacts_exported&entityId=${product}&limit=5`)).toHaveLength(1);
  });

  it('fulfils a registration as the IT maintainer: the platform team’s process, with their run right (session only)', async () => {
    const processId = ((await s.api('GET', '/processes')) as { id: string }[])[0]!.id;
    await s.api('PUT', `/data-products/${product}/access-settings`, { processId });
    try {
      const c = await dana('POST', `/data-products/${product}/ports/${port}/consumers`, { kind: 'text', text: 'Invented fulfilled', purpose: 'Close' });
      expect(c).toMatchObject({ approval: 'notDocumented', ticketId: null, runId: null });
      const url = `/data-products/${product}/ports/${port}/consumers/${c.id}/fulfilment`;
      // who may not change the product does not fulfil
      expect((await fail(olivia('POST', url, { startProcess: true }))).status).toBe(403);
      // no ticket source: a ticket is refused
      expect(await fail(dana('POST', url, { ticket: { externalNumber: 'INC-1' } }))).toMatchObject({
        code: 'DATA_CONSUMER_INVALID',
        params: { context: 'ticketSource' },
      });
      const done = await dana('POST', url, { startProcess: true });
      expect(done.runId ?? done.problems[0]).toBeTruthy();
      const token = (await dana('POST', '/me/tokens', { name: 'dana full', scope: 'full' })).token as string;
      for (const [method, path, body] of [
        ['POST', url, { startProcess: true }],
        ['PUT', `/data-products/${product}/access-settings`, { reviewMonths: 6 }],
      ] as const) {
        const res = await fetch(`${s.base}/api${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(res.status, path).toBe(403);
        expect((await res.json()).code).toBe('SESSION_REQUIRED');
      }
    } finally {
      await s.api('PUT', `/data-products/${product}/access-settings`, { processId: null });
    }
  });

  it('is team-scoped: a request of a product the reader may not see is neither listed nor counted', async () => {
    await s.api('POST', `/data-products/${hidden}/ports`, { direction: 'output', name: 'secret', type: 'table' });
    const { db } = await import('../src/db.js');
    const secretPort = db().get<{ id: string }>("SELECT id FROM dp_ports WHERE product_id = ? AND name = 'secret'", hidden)!.id;
    db().run(
      `INSERT INTO dp_access_requests (id, product_id, port_id, environment, requester, consumer_kind, consumer_text, purpose, status, created_at, updated_at)
       VALUES ('dpx_hidden', ?, ?, 'prod', 'adam', 'text', 'Secret use', 'x', 'refused', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
      hidden,
      secretPort,
    );
    const all = await olivia('GET', '/data-products/access-requests?scope=all');
    expect(all.items.every((x: { product: { id: string } }) => x.product.id !== hidden)).toBe(true);
    expect(all.total).toBe(all.items.length);
    expect(await fail(olivia('GET', '/data-products/access-requests/dpx_hidden'))).toMatchObject({ status: 404 });
  });
});

describe('endorsement', () => {
  it('is recorded by the IT maintainers (never because someone is named an owner) and flagged for review', async () => {
    const domain = (await s.api('POST', '/data-domains', { key: 'gov-sales', name: 'Governed sales', owners: ['user:adam'] })).id;
    const p = (await dana('POST', '/data-products', { key: 'gov-endorsed', name: 'Endorsed orders', owners: ['user:dana'], domainId: domain })).id;
    const view = await dana('GET', `/data-products/${p}/endorsement`);
    expect(view).toMatchObject({ endorsement: null, mayEndorse: true, whyNot: null });
    // the domain owner without a right on the product records nothing, nor does a reader
    expect((await adam('GET', `/data-products/${p}/endorsement`)).whyNot).toBe('notMaintainer');
    const owner = await contact(dana, 'Invented domain owner');
    expect(await fail(adam('PUT', `/data-products/${p}/endorsement`, { decision: decision(owner, 'domainOwner') }))).toMatchObject({ status: 403 });
    expect(await fail(olivia('PUT', `/data-products/${p}/endorsement`, { decision: decision(owner, 'domainOwner') }))).toMatchObject({ status: 403 });
    expect(await fail(dana('PUT', `/data-products/${p}/endorsement`, { reviewDate: '2099-01-01', decision: decision(owner, 'domainOwner') }))).toMatchObject({
      code: 'DATA_ENDORSEMENT_INVALID',
      params: { context: 'reviewDate' },
    });
    // a contact who has left endorses nothing new
    const gone = await contact(dana, 'Invented former owner');
    await dana('PUT', `/contacts/${gone}`, { name: 'Invented former owner', status: 'left' });
    expect(await fail(dana('PUT', `/data-products/${p}/endorsement`, { decision: decision(gone, 'domainOwner') }))).toMatchObject({
      status: 409,
      code: 'CONTACT_LEFT',
    });
    const e = await dana('PUT', `/data-products/${p}/endorsement`, { note: 'Good contract and owners', decision: decision(owner, 'domainOwner') });
    expect(e.endorsement).toMatchObject({
      endorsedBy: 'dana',
      valid: true,
      review: null,
      decision: { decidedBy: [{ name: 'Invented domain owner', role: 'domainOwner' }] },
    });
    // a breaking change of a bound contract flags it (the data contracts' hook), it then no longer counts
    const { flagEndorsementReview } = await import('../src/dataproducts/endorsements.js');
    expect(flagEndorsementReview([p], 'breakingChange')).toEqual([p]);
    expect((await dana('GET', `/data-products/${p}/endorsement`)).endorsement).toMatchObject({ valid: false, review: 'breakingChange' });
    // the IT maintainers are told once – never someone only named (the domain owner)
    expect(await notes(dana, 'dataproduct.endorsement_review')).toHaveLength(1);
    expect(await notes(adam, 'dataproduct.endorsement_review')).toHaveLength(0);
    expect(flagEndorsementReview([p], 'breakingChange')).toEqual([]);
    expect(await notes(dana, 'dataproduct.endorsement_review')).toHaveLength(1);
    // endorsed again: valid; the maturity counts it only on top of level 4
    expect((await dana('PUT', `/data-products/${p}/endorsement`, { decision: decision(owner, 'domainOwner') })).endorsement.valid).toBe(true);
    const card = await dana('GET', `/data-products/${p}/scorecard`);
    expect(card.maturity).toBeLessThan(4);
    const audit = (await s.api('GET', `/audit?entityType=data_product&entityId=${p}&limit=100`)) as { action: string }[];
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['dataproduct.endorsed', 'dataproduct.endorsement_flagged']));
    expect((await dana('DELETE', `/data-products/${p}/endorsement?reason=Owner%20left`)).endorsement).toBeNull();
  });
});
