import { beforeAll, describe, expect, it } from 'vitest';
import { endorsementState, highOrAbove, matchConsumers, maturityLevel, promotedNames } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Consumers and access of data products (0.24.0, ADR 0036 phase 2): declared against actual consumers (Snowflake
 * ACCESS_HISTORY – metadata only, one read-only statement, "not available" for an edition without it – and Kafka
 * consumer groups), access requests with four eyes for a product rated high, the step-up and the access change of an
 * approval, the registered consumer it makes, the notifications once, team scope; endorsement and maturity 5.
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

describe('access requests', () => {
  let request = '';
  it('anyone who sees the product asks; the owner decides and the approval registers the consumer (step-up, access change)', async () => {
    const r = await olivia('POST', `/data-products/${product}/ports/${port}/access-requests`, {
      environment: 'prod',
      consumer: { kind: 'user', subject: 'user:olivia' },
      purpose: 'Monthly close',
      until: '2027-12-31',
      identities: ['user:OLIVIA', 'role:FINANCE'],
    });
    request = r.id;
    expect(r).toMatchObject({ status: 'pending', fourEyes: false, mayWithdraw: true, mayDecide: false });
    // asking twice for the same is refused; a port not bound in an environment too
    expect(
      await fail(
        olivia('POST', `/data-products/${product}/ports/${port}/access-requests`, {
          environment: 'prod',
          consumer: { kind: 'user', subject: 'user:olivia' },
          purpose: 'Again',
        }),
      ),
    ).toMatchObject({ code: 'DATA_ACCESS_REQUEST_STATE', params: { context: 'exists' } });
    expect(
      await fail(
        olivia('POST', `/data-products/${product}/ports/${port}/access-requests`, { environment: 'dev', consumer: { kind: 'text', text: 'x' }, purpose: 'x' }),
      ),
    ).toMatchObject({ code: 'DATA_ACCESS_REQUEST_STATE', params: { context: 'notBound' } });
    // the owner is told once; the requester is not
    expect(await notes(dana, 'dataproduct.access_requested')).toHaveLength(1);
    expect(await notes(olivia, 'dataproduct.access_requested')).toHaveLength(0);
    // the owner's list of decisions; nobody else decides
    expect((await dana('GET', '/data-products/access-requests?scope=decide')).items.map((x: { id: string }) => x.id)).toContain(request);
    expect(await fail(vera('POST', `/data-products/access-requests/${request}/decision`, { decision: 'approve' }))).toMatchObject({ status: 403 });
    // the approval asks for the step-up: without it, refused
    const noStepUp = await s.as('dana', PW, { autoStepUp: false });
    await noStepUp('DELETE', '/auth/step-up');
    expect(await fail(noStepUp('POST', `/data-products/access-requests/${request}/decision`, { decision: 'approve' }))).toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
    const done = await dana('POST', `/data-products/access-requests/${request}/decision`, { decision: 'approve', comment: 'Fine' });
    expect(done).toMatchObject({ status: 'approved', decidedBy: 'dana' });
    const consumers = await dana('GET', `/data-products/${product}/ports/${port}/consumers`);
    const c = consumers.find((x: { id: string }) => x.id === done.consumerId);
    expect(c).toMatchObject({ kind: 'user', subject: 'user:olivia', purpose: 'Monthly close', endDate: '2027-12-31' });
    const actual = await dana('GET', `/data-products/${product}/ports/${port}/actual?environment=prod`);
    expect(actual.declared.find((d: { consumerId: string }) => d.consumerId === done.consumerId).identities).toEqual(['role:FINANCE', 'user:OLIVIA']);
    // audited as a decision and as an access change
    const audit = (await s.api('GET', `/audit?entityType=data_product&entityId=${product}&limit=100`)) as { action: string }[];
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['dataproduct.access_requested', 'dataproduct.access_approved', 'access.data_port_consumer_granted']),
    );
    // the requester is told once
    expect(await notes(olivia, 'dataproduct.access_decided')).toHaveLength(1);
    expect(await fail(dana('POST', `/data-products/access-requests/${request}/decision`, { decision: 'refuse', comment: 'x' }))).toMatchObject({
      params: { context: 'notPending' },
    });
  });

  it('needs two people for a product rated high, never the requester, and refusals give a reason', async () => {
    await dana('PUT', `/data-products/${product}/rating`, { confidentiality: { level: 'high', justification: 'Customer orders' } });
    const r = await vera('POST', `/data-products/${product}/ports/${port}/access-requests`, {
      environment: 'prod',
      consumer: { kind: 'text', text: 'Invented dashboard' },
      purpose: 'Dashboard',
    });
    expect(r.fourEyes).toBe(true);
    // a second decider: an administrator
    const first = await dana('POST', `/data-products/access-requests/${r.id}/decision`, { decision: 'approve' });
    expect(first).toMatchObject({ status: 'pending', approvals: [expect.objectContaining({ by: 'dana' })] });
    expect(await fail(dana('POST', `/data-products/access-requests/${r.id}/decision`, { decision: 'approve' }))).toMatchObject({
      params: { context: 'secondPerson' },
    });
    expect(await fail(s.api('POST', `/data-products/access-requests/${r.id}/decision`, { decision: 'refuse' }))).toMatchObject({
      params: { context: 'comment' },
    });
    const second = await s.api('POST', `/data-products/access-requests/${r.id}/decision`, { decision: 'approve' });
    expect(second.status).toBe('approved');
    // nobody decides their own request
    const own = await dana('POST', `/data-products/${product}/ports/${port}/access-requests`, {
      environment: 'prod',
      consumer: { kind: 'text', text: 'Own use' },
      purpose: 'Own',
    });
    expect(await fail(dana('POST', `/data-products/access-requests/${own.id}/decision`, { decision: 'approve' }))).toMatchObject({
      params: { context: 'ownRequest' },
    });
    expect((await dana('POST', `/data-products/access-requests/${own.id}/withdraw`)).status).toBe('withdrawn');
    await dana('PUT', `/data-products/${product}/rating`, { confidentiality: null });
  });

  it('is session-only for decisions and settings, and team-scoped in lists', async () => {
    const r = await olivia('POST', `/data-products/${product}/ports/${port}/access-requests`, {
      environment: 'prod',
      consumer: { kind: 'text', text: 'Token test' },
      purpose: 'x',
    });
    const token = (await dana('POST', '/me/tokens', { name: 'dana full', scope: 'full' })).token as string;
    for (const [method, url, body] of [
      ['POST', `/data-products/access-requests/${r.id}/decision`, { decision: 'refuse', comment: 'x' }],
      ['PUT', `/data-products/${product}/access-settings`, { reviewMonths: 6 }],
    ] as const) {
      const res = await fetch(`${s.base}/api${url}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status, url).toBe(403);
      expect((await res.json()).code).toBe('SESSION_REQUIRED');
    }
    // a request of a product olivia may not see is neither listed nor counted
    await adam('POST', `/data-products/${hidden}/ports`, { direction: 'output', name: 'secret', type: 'table' });
    const all = await olivia('GET', '/data-products/access-requests?scope=all');
    expect(all.items.every((x: { product: { id: string } }) => x.product.id !== hidden)).toBe(true);
  });
});

describe('endorsement', () => {
  it('is given by the owners of the domain, never by the product owner, and flagged for review', async () => {
    const domain = (await s.api('POST', '/data-domains', { key: 'gov-sales', name: 'Governed sales', owners: ['user:adam'] })).id;
    const p = (await dana('POST', '/data-products', { key: 'gov-endorsed', name: 'Endorsed orders', owners: ['user:dana'], domainId: domain })).id;
    const view = await dana('GET', `/data-products/${p}/endorsement`);
    expect(view).toMatchObject({ endorsement: null, endorsers: ['user:adam'], mayEndorse: false, whyNot: 'ownProduct' });
    expect(await fail(dana('PUT', `/data-products/${p}/endorsement`, {}))).toMatchObject({ status: 403 });
    expect(await fail(olivia('PUT', `/data-products/${p}/endorsement`, {}))).toMatchObject({ status: 403 });
    expect(await fail(adam('PUT', `/data-products/${p}/endorsement`, { reviewDate: '2099-01-01' }))).toMatchObject({
      code: 'DATA_ENDORSEMENT_INVALID',
      params: { context: 'reviewDate' },
    });
    const e = await adam('PUT', `/data-products/${p}/endorsement`, { note: 'Good contract and owners' });
    expect(e.endorsement).toMatchObject({ endorsedBy: 'adam', valid: true, review: null });
    // a breaking change of a bound contract flags it (the data contracts' hook), it then no longer counts
    const { flagEndorsementReview } = await import('../src/dataproducts/endorsements.js');
    expect(flagEndorsementReview([p], 'breakingChange')).toEqual([p]);
    expect((await dana('GET', `/data-products/${p}/endorsement`)).endorsement).toMatchObject({ valid: false, review: 'breakingChange' });
    // the owner and the endorser are told once
    expect(await notes(dana, 'dataproduct.endorsement_review')).toHaveLength(1);
    expect(await notes(adam, 'dataproduct.endorsement_review')).toHaveLength(1);
    expect(flagEndorsementReview([p], 'breakingChange')).toEqual([]);
    expect(await notes(dana, 'dataproduct.endorsement_review')).toHaveLength(1);
    // endorsed again: valid; the maturity counts it only on top of level 4
    expect((await adam('PUT', `/data-products/${p}/endorsement`, {})).endorsement.valid).toBe(true);
    const card = await dana('GET', `/data-products/${p}/scorecard`);
    expect(card.maturity).toBeLessThan(4);
    const audit = (await s.api('GET', `/audit?entityType=data_product&entityId=${p}&limit=100`)) as { action: string }[];
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['dataproduct.endorsed', 'dataproduct.endorsement_flagged']));
    expect((await adam('DELETE', `/data-products/${p}/endorsement?reason=Owner%20left`)).endorsement).toBeNull();
  });
});
