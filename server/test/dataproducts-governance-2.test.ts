import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Governance of data products (0.24.0, ADR 0036 phase 2): port access reviews (frozen entries, decisions, four eyes,
 * the seal, registrations ended), their due dates and reminders once; promotion between environments by the name rules
 * with a preview, the fingerprint and its audit entry; the GDPR Art. 30 view with team scope, its exports (CSV, PDF)
 * and a fixed number of statements.
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
const counted = new Map<string, number>();

interface Note {
  event: string;
  title: string;
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
const element = (qualifiedName: string, environment: string, kind = 'snowflake.table') =>
  dana('POST', '/data-elements', { platformId: snowflake, kind, qualifiedName, environment }).then((r: { id: string }) => r.id);

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
  snowflake = ((await s.api('GET', '/platforms')) as { id: string; kind: string }[]).find((p) => p.kind === 'snowflake')!.id;
}, 180_000);

describe('port access reviews', () => {
  let product = '';
  let port = '';
  let keep = '';
  let drop = '';
  let review = '';
  it('freeze the registrations and who really reads; the owner decides, a second person approves and the seal holds', async () => {
    const { setMockAccessHistory } = await import('../src/mock/mockDataConsumers.js');
    setMockAccessHistory([{ object: 'GOVR.SALES.ORDERS', user: 'SVC_STRAY', role: 'STRAY', reads: 3, hoursAgo: 4 }]);
    product = (await dana('POST', '/data-products', { key: 'govr-orders', name: 'Reviewed orders', owners: ['user:dana'] })).id;
    port = (await dana('POST', `/data-products/${product}/ports`, { direction: 'output', name: 'orders', type: 'table' })).id;
    await dana('PUT', `/data-products/${product}/ports/${port}/bindings/prod`, { elementIds: [await element('GOVR.SALES.ORDERS', 'prod')] });
    keep = (await dana('POST', `/data-products/${product}/ports/${port}/consumers`, { kind: 'text', text: 'Finance reports', purpose: 'Close' })).id;
    drop = (await dana('POST', `/data-products/${product}/ports/${port}/consumers`, { kind: 'text', text: 'Old export', purpose: 'Gone' })).id;
    await dana('POST', `/data-products/${product}/ports/${port}/actual/read`, { environment: 'prod' });
    // a periodic review: every 6 months – due now (never reviewed)
    await dana('PUT', `/data-products/${product}/access-settings`, { reviewMonths: 6 });
    const before = await dana('GET', `/data-products/${product}/port-reviews`);
    expect(before.due).toEqual([expect.objectContaining({ portId: port, environment: 'prod', lastApprovedAt: null })]);
    const { runGovernanceJob } = await import('../src/dataproducts/governance-job.js');
    await runGovernanceJob(Date.now(), true);
    await runGovernanceJob(Date.now(), true);
    expect(await notes(dana, 'dataproduct.access_review_due')).toHaveLength(1);
    expect(await notes(vera, 'dataproduct.access_review_due')).toHaveLength(0);

    expect(await fail(vera('POST', `/data-products/${product}/ports/${port}/reviews`, { environment: 'prod' }))).toMatchObject({ status: 403 });
    const r = await dana('POST', `/data-products/${product}/ports/${port}/reviews`, { environment: 'prod' });
    review = r.id;
    expect(r.entries.map((e: { kind: string; label: string; finding: string }) => [e.kind, e.label, e.finding])).toEqual([
      ['registered', 'Finance reports', 'unknown'],
      ['registered', 'Old export', 'unknown'],
      ['actual', 'role:STRAY', 'notRegistered'],
      ['actual', 'user:SVC_STRAY', 'notRegistered'],
    ]);
    expect(await fail(dana('POST', `/data-products/${product}/ports/${port}/reviews`, { environment: 'prod' }))).toMatchObject({
      params: { context: 'open' },
    });
    const id = (label: string) => r.entries.find((e: { label: string }) => e.label === label).id;
    expect(await fail(dana('POST', `/data-products/port-reviews/${review}/submit`))).toMatchObject({ params: { context: 'undecided' } });
    expect(
      await fail(dana('PUT', `/data-products/port-reviews/${review}/decisions`, { decisions: [{ itemId: id('Old export'), decision: 'remove' }] })),
    ).toMatchObject({ params: { context: 'comment' } });
    await dana('PUT', `/data-products/port-reviews/${review}/decisions`, {
      decisions: [
        { itemId: id('Finance reports'), decision: 'keep' },
        { itemId: id('Old export'), decision: 'remove', comment: 'No longer used' },
        { itemId: id('user:SVC_STRAY'), decision: 'remove', comment: 'Not registered' },
        { itemId: id('role:STRAY'), decision: 'remove', comment: 'Not registered' },
      ],
    });
    const submitted = await dana('POST', `/data-products/port-reviews/${review}/submit`);
    expect(submitted).toMatchObject({ status: 'submitted', mayApprove: false });
    // never the submitter; a second person approves
    expect(await fail(dana('POST', `/data-products/port-reviews/${review}/approval`, { approve: true }))).toMatchObject({
      params: { context: 'secondPerson' },
    });
    expect(await fail(olivia('POST', `/data-products/port-reviews/${review}/approval`, { approve: true }))).toMatchObject({ status: 403 });
    const approved = await adam('POST', `/data-products/port-reviews/${review}/approval`, { approve: true, comment: 'Agreed' });
    expect(approved).toMatchObject({ status: 'approved', approvedBy: 'adam', removals: 3 });
    expect(approved.sealHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await dana('GET', `/data-products/port-reviews/${review}/verify`)).toMatchObject({ sealed: true, ok: true });
    // the registration decided "remove" ended today; the kept one did not
    const consumers = await dana('GET', `/data-products/${product}/ports/${port}/consumers`);
    expect(consumers.find((c: { id: string }) => c.id === drop).endDate).toBe(new Date().toISOString().slice(0, 10));
    expect(consumers.find((c: { id: string }) => c.id === keep).endDate).toBeNull();
    // a change in the database shows up
    const { db } = await import('../src/db.js');
    db().run("UPDATE dp_port_review_items SET decision = 'keep' WHERE review_id = ? AND label = 'Old export'", review);
    expect(await dana('GET', `/data-products/port-reviews/${review}/verify`)).toMatchObject({ sealed: true, ok: false });
    // the next one is due in 6 months; the confidentiality evidence names the review
    const after = await dana('GET', `/data-products/${product}/port-reviews`);
    expect(after.due[0].overdue).toBe(false);
    const card = await dana('GET', `/data-products/${product}/scorecard`);
    const conf = card.parts.find((x: { id: string }) => x.id === 'confidentiality');
    expect(conf.evidence.map((e: { key: string }) => e.key)).toContain('evidence.confidentiality.accessReviewed');
  });
});

describe('promotion between environments', () => {
  let product = '';
  let port = '';
  it('previews the next environment by the name rules and promotes with its evidence', async () => {
    await s.api('POST', '/data-products/discovery-sources', {
      name: 'Governed warehouse',
      platformId: snowflake,
      scope: ['GOVP', 'GOVP_DEV'],
      environmentRules: [
        { match: 'suffix', value: '_DEV', environment: 'dev' },
        { match: 'prefix', value: 'GOVP', environment: 'prod' },
      ],
      enabled: false,
    });
    product = (await dana('POST', '/data-products', { key: 'govp-orders', name: 'Promoted orders', owners: ['user:dana'] })).id;
    port = (await dana('POST', `/data-products/${product}/ports`, { direction: 'output', name: 'orders', type: 'table' })).id;
    const devRaw = await element('GOVP_DEV.RAW.ORDERS', 'dev');
    const devTmp = await element('GOVP_DEV.RAW.SCRATCH', 'dev');
    const devCurated = await element('GOVP_DEV.CURATED.ORDERS', 'dev');
    const prodRaw = await element('GOVP.RAW.ORDERS', 'prod');
    const prodCurated = await element('GOVP.CURATED.ORDERS', 'prod');
    await dana('POST', `/data-products/${product}/members`, { elementIds: [devRaw, devTmp], role: 'internal' });
    await dana('PUT', `/data-products/${product}/ports/${port}/bindings/dev`, { elementIds: [devCurated], objectives: { freshnessMinutes: 60 } });

    expect(await fail(dana('GET', `/data-products/${product}/promotion?from=dev&to=dev`))).toMatchObject({ params: { context: 'sameEnvironment' } });
    const pre = await vera('GET', `/data-products/${product}/promotion?from=dev&to=prod`);
    expect(pre.members.map((m: { sourceName: string; targetName: string | null; state: string }) => [m.sourceName, m.targetName, m.state])).toEqual([
      ['GOVP_DEV.CURATED.ORDERS', 'GOVP.CURATED.ORDERS', 'found'],
      ['GOVP_DEV.RAW.ORDERS', 'GOVP.RAW.ORDERS', 'found'],
      ['GOVP_DEV.RAW.SCRATCH', null, 'missing'],
    ]);
    expect(pre.bindings).toEqual([
      expect.objectContaining({ portId: port, targetBound: false, elements: [expect.objectContaining({ targetId: prodCurated, state: 'found' })] }),
    ]);
    expect(pre.counts).toEqual({ found: 3, missing: 1, already: 0 });
    // only who may change the product promotes – in a session, with the preview's fingerprint
    expect(await fail(vera('POST', `/data-products/${product}/promotion`, { from: 'dev', to: 'prod' }))).toMatchObject({ status: 403 });
    expect(await fail(dana('POST', `/data-products/${product}/promotion`, { from: 'dev', to: 'prod', fingerprint: 'stale' }))).toMatchObject({
      params: { context: 'changed' },
    });
    const done = await dana('POST', `/data-products/${product}/promotion`, {
      from: 'dev',
      to: 'prod',
      fingerprint: pre.fingerprint,
      evidence: { kind: 'record', ref: 'CR-2026-117' },
      note: 'Release 3',
    });
    expect(done.promotion).toMatchObject({ from: 'dev', to: 'prod', members: 2, bindings: 1, missing: 1, evidence: { kind: 'record', ref: 'CR-2026-117' } });
    expect(done.preview.counts).toEqual({ found: 0, missing: 1, already: 3 });
    const members = await dana('GET', `/data-products/${product}/members?environment=prod`);
    const ids = (members.items ?? members).map((m: { elementId: string }) => m.elementId);
    expect(ids).toEqual(expect.arrayContaining([prodRaw, prodCurated]));
    const ports = await dana('GET', `/data-products/${product}/ports`);
    const prod = ports[0].bindings.find((b: { environment: string }) => b.environment === 'prod');
    expect(prod).toMatchObject({ objectives: { freshnessMinutes: 60 } });
    expect(await fail(dana('POST', `/data-products/${product}/promotion`, { from: 'dev', to: 'prod' }))).toMatchObject({ params: { context: 'nothingToDo' } });
    expect((await dana('GET', `/data-products/${product}/promotions`)).map((p: { to: string }) => p.to)).toEqual(['prod']);
    const audit = (await s.api('GET', `/audit?entityType=data_product&entityId=${product}&action=dataproduct.promoted`)) as {
      details: { evidence: unknown };
    }[];
    expect(audit[0]?.details.evidence).toEqual({ kind: 'record', ref: 'CR-2026-117' });
  });
});

describe('the GDPR Art. 30 view', () => {
  it('lists data objects with personal data, their products, recipients and processors – team-scoped', async () => {
    const supplier = (await s.api('POST', '/suppliers', { name: 'Invented Cloud Data AG', type: 'serviceProvider' })).id;
    await s.api('POST', `/suppliers/${supplier}/contracts`, {
      title: 'Warehouse hosting',
      platforms: [{ platformId: snowflake, purpose: 'Data warehouse' }],
      personalData: true,
      dpaStatus: 'inPlace',
    });
    const object = (
      await s.api('POST', '/data-objects', {
        key: 'gov-customer',
        name: 'Governed customer',
        personalData: 'personal',
        categories: ['identification', 'contact'],
        subjects: ['customers'],
        legalBasis: 'contract',
        purposes: ['Order handling'],
        retention: 'P10Y',
      })
    ).id;
    await s.api('POST', '/data-objects', { key: 'gov-plain', name: 'Governed plain', personalData: 'none' });
    const el = await element('GOVA.SALES.CUSTOMERS', 'prod');
    await s.api('POST', `/data-objects/${object}/elements`, { elementId: el });
    const product = (await dana('POST', '/data-products', { key: 'gova-customers', name: 'Customer records', purpose: 'Billing' })).id;
    const port = (await dana('POST', `/data-products/${product}/ports`, { direction: 'output', name: 'customers', type: 'table' })).id;
    await dana('PUT', `/data-products/${product}/ports/${port}/bindings/prod`, { elementIds: [el] });
    await dana('POST', `/data-products/${product}/ports/${port}/consumers`, { kind: 'team', subject: 'team:Invented billing', purpose: 'Invoices' });
    // a product a secret team owns that processes it too
    const secret = (await s.api('POST', '/data-products', { key: 'gova-secret', name: 'Secret customers' })).id;
    await s.api('POST', `/data-products/${secret}/members`, { elementIds: [el], role: 'input' });
    const team = (await s.api('POST', '/teams', { name: 'Invented secret ropa team', members: ['adam'] })).id;
    const { db } = await import('../src/db.js');
    db().run("INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('data_product', ?, ?, ?)", secret, team, new Date().toISOString());

    const r = await dana('GET', '/data-products/records-of-processing?q=governed');
    expect(r.items.map((x: { object: { key: string } }) => x.object.key)).toEqual(['gov-customer']);
    const e = r.items[0];
    expect(e).toMatchObject({ personalData: 'personal', legalBasis: 'contract', categories: ['identification', 'contact'], hiddenProducts: 1 });
    expect(e.products).toEqual([expect.objectContaining({ product: expect.objectContaining({ name: 'Customer records' }), how: ['implements'] })]);
    expect(e.recipients).toEqual([{ kind: 'team', label: 'team:invented billing', via: 'Customer records / customers' }]);
    expect(e.processors).toEqual([
      { platform: expect.any(String), supplier: 'Invented Cloud Data AG', contract: 'Warehouse hosting', personalData: true, dpa: 'inPlace' },
    ]);
    // the secret team's member sees both products
    const a = await adam('GET', '/data-products/records-of-processing?q=governed');
    expect(a.items[0].hiddenProducts).toBe(0);
    expect(a.items[0].products).toHaveLength(2);

    // exports: CSV (formulas defused, in the reader's language) and PDF – audited
    const text = (await dana('GET', '/data-products/records-of-processing.csv?q=governed&lang=de')) as string;
    expect(text).toContain('Datenobjekt');
    expect(text).toContain('Governed customer');
    expect(text).toContain('Invented Cloud Data AG');
    expect(text).toContain('weiteres, das Sie nicht sehen dürfen');
    const pdf = (await dana('GET', '/data-products/records-of-processing.pdf?q=governed')) as string;
    expect(pdf.startsWith('%PDF')).toBe(true);
    const audit = (await s.api('GET', '/audit?action=dataproduct.ropa_exported&limit=10')) as unknown[];
    expect(audit).toHaveLength(2);
  });

  it('reads a fixed number of statements, however many data objects there are', async () => {
    await dana('GET', '/data-products/records-of-processing');
    const few = counted.get('/data-products/records-of-processing')!;
    for (let i = 0; i < 30; i++) {
      const o = (await s.api('POST', '/data-objects', { key: `gov-bulk-${i}`, name: `Bulk ${i}`, personalData: 'personal' })).id;
      const el = await element(`GOVB.S.T${i}`, 'prod');
      await s.api('POST', `/data-objects/${o}/elements`, { elementId: el });
    }
    await dana('GET', '/data-products/records-of-processing');
    expect(few).toBeGreaterThan(0);
    expect(counted.get('/data-products/records-of-processing')!).toBeLessThanOrEqual(few + 2);
  });
});
