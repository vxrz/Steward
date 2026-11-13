import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Lineage from tools (0.24.0, ADR 0036 phase 2, docs/DATA-PRODUCTS.md#lineage-from-tools): lineage sources with their
 * rights (module managers, owning teams, session-only changes), push tokens (hashed, bound to one source, API tokens and
 * sessions refused, addresses, rate limit, sizes checked before the body is read); OpenLineage run events matched to
 * elements by namespace and name, jobs as proposed steps, the last run kept, facets never stored; malformed and oversized
 * pushes; a fixed number of statements per event; dbt manifest.json and run_results.json (proposals, last runs, quality
 * results through recordQualityResult); Snowflake OBJECT_DEPENDENCIES in account usage mode (statement allow-list); the
 * inbox with team scope, accepting (a step is made, or the documented one changed) and rejecting; proposed ways in the
 * lineage picture.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
const SCHEMA = 'https://openlineage.io/spec/2-0-2/OpenLineage.json#/$defs/RunEvent';
const PRODUCER = 'https://github.com/apache/airflow/tree/providers-openlineage/1.0.0';
let s: TestServer;
let dana: Client;
let olivia: Client;
let vera: Client;
let snowflake = '';
const statements = new Map<string, number>();

type DbMod = typeof import('../src/db.js');
let dbm: DbMod;

const fail = async (p: Promise<unknown>): Promise<{ status: number; code: string; params: Record<string, unknown> }> => {
  try {
    await p;
  } catch (e) {
    const err = e as { status: number; body?: { code?: string; params?: Record<string, unknown> } };
    return { status: err.status, code: err.body?.code ?? '', params: err.body?.params ?? {} };
  }
  throw new Error('expected a refusal');
};

interface El {
  id: string;
  qualifiedName: string;
  olNamespace: string;
  olName: string;
}
const els = new Map<string, El>();
/** An element of the demo by qualified name (prod), with its OpenLineage dataset. */
async function el(qn: string): Promise<El> {
  const known = els.get(qn);
  if (known) return known;
  const page = await s.api('GET', `/data-elements?prefix=${encodeURIComponent(qn)}&environment=prod`);
  const hit = (page.items as { id: string; qualifiedName: string }[]).find((x) => x.qualifiedName === qn);
  if (!hit) throw new Error(`no element ${qn}`);
  const e = (await s.api('GET', `/data-elements/${hit.id}`)) as El;
  els.set(qn, e);
  return e;
}

const ds = (e: El) => ({ namespace: e.olNamespace, name: e.olName });

function runEvent(o: {
  type?: string;
  runId?: string;
  job: string;
  inputs?: { namespace: string; name: string; facets?: unknown }[];
  outputs?: { namespace: string; name: string; facets?: unknown }[];
  time?: string;
  extra?: Record<string, unknown>;
}) {
  return {
    eventType: o.type ?? 'COMPLETE',
    eventTime: o.time ?? new Date().toISOString(),
    run: { runId: o.runId ?? '0190c3d4-1111-7000-8000-000000000001', facets: {} },
    job: { namespace: 'airflow-invented', name: o.job, facets: { jobType: { processingType: 'BATCH', integration: 'AIRFLOW', jobType: 'TASK' } } },
    inputs: o.inputs ?? [],
    outputs: o.outputs ?? [],
    producer: PRODUCER,
    schemaURL: SCHEMA,
    ...o.extra,
  };
}

async function push(source: string, token: string | null, body: unknown, more: { path?: string; headers?: Record<string, string>; raw?: string } = {}) {
  const res = await fetch(`${s.base}/api/hooks/data-lineage/${source}${more.path ?? ''}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...more.headers },
    body: more.raw ?? JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: json };
}

beforeAll(async () => {
  s = await startTestServer({
    routes: (app) =>
      app.addHook('onSend', async (req, _reply, payload) => {
        const { requestDbTotals } = await import('../src/http-observability.js');
        statements.set(`${req.method} ${req.url}`, requestDbTotals(req)?.statements ?? -1);
        return payload;
      }),
  });
  await setup(s);
  await s.api('POST', '/demo/setup', { services: true });
  await s.api('PUT', '/settings/modules/dataProducts', { enabled: true });
  dana = await s.as('dana', PW);
  olivia = await s.as('olivia', PW);
  vera = await s.as('vera', PW);
  const platforms = (await s.api('GET', '/platforms')) as { id: string; kind: string; name: string }[];
  snowflake = platforms.find((p) => p.kind === 'snowflake')!.id;
  dbm = await import('../src/db.js');
}, 180_000);

describe('lineage sources and push tokens', () => {
  it('are set up by the module’s managers in a signed-in session, fit their kind and are audited', async () => {
    expect((await fail(olivia('POST', '/data-products/lineage-sources', { name: 'X', kind: 'openlineage' }))).status).toBe(403);
    expect((await fail(vera('POST', '/data-products/lineage-sources', { name: 'X', kind: 'openlineage' }))).status).toBe(403);
    expect(await fail(dana('POST', '/data-products/lineage-sources', { name: 'X', kind: 'dbt' }))).toMatchObject({
      code: 'DATA_LINEAGE_SOURCE_PLATFORM',
      params: { context: 'dbtNeedsPlatform' },
    });
    expect(await fail(dana('POST', '/data-products/lineage-sources', { name: 'X', kind: 'openlineage', platformId: snowflake }))).toMatchObject({
      code: 'DATA_LINEAGE_SOURCE_PLATFORM',
      params: { context: 'openlineage' },
    });
    // an API token cannot set one up (session-only)
    const token = (await dana('POST', '/me/tokens', { name: 'lineage', scope: 'full' })).token as string;
    const viaToken = await fetch(`${s.base}/api/data-products/lineage-sources`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Token', kind: 'openlineage' }),
    });
    expect(viaToken.status).toBe(403);
    const src = await dana('POST', '/data-products/lineage-sources', { name: 'Airflow (invented)', kind: 'openlineage' });
    expect(src).toMatchObject({ kind: 'openlineage', enabled: true, permissions: ['view', 'manage'], pushPath: `/api/hooks/data-lineage/${src.id}` });
    // every user of the module sees it (no owning teams), only managers change it
    expect((await vera('GET', `/data-products/lineage-sources/${src.id}`)).permissions).toEqual(['view']);
    expect((await fail(olivia('PUT', `/data-products/lineage-sources/${src.id}`, { name: 'Y', kind: 'openlineage' }))).status).toBe(403);
    const audit = (await s.api('GET', `/audit?entityId=${src.id}`)) as { items?: { action: string }[] } | { action: string }[];
    const actions = (Array.isArray(audit) ? audit : (audit.items ?? [])).map((a) => a.action);
    expect(actions).toContain('datalineage.source_created');
  });

  it('give push tokens that are shown once, stored hashed, bound to their source and session-only to make', async () => {
    const src = await dana('POST', '/data-products/lineage-sources', { name: 'Token source', kind: 'openlineage' });
    const t = await dana('POST', `/data-products/lineage-sources/${src.id}/tokens`, { name: 'CI' });
    expect(t.token).toMatch(/^sdl_/);
    expect(t.path).toBe(`/api/hooks/data-lineage/${src.id}`);
    const listed = await dana('GET', `/data-products/lineage-sources/${src.id}/tokens`);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(t.token);
    const row = dbm.db().get<{ hash: string }>('SELECT hash FROM dp_lineage_tokens WHERE id = ?', t.id)!;
    expect(row.hash).not.toContain(t.token.slice(4));
    // viewers do not see the tokens
    expect((await fail(vera('GET', `/data-products/lineage-sources/${src.id}/tokens`))).status).toBe(403);
    const rotated = await dana('POST', `/data-products/lineage-sources/${src.id}/tokens/${t.id}/rotate`);
    expect(rotated.token).not.toBe(t.token);
    expect((await push(src.id, t.token, runEvent({ job: 'j' }))).status).toBe(401);
    expect((await push(src.id, rotated.token, runEvent({ job: 'j' }))).status).toBe(200);
    await dana('DELETE', `/data-products/lineage-sources/${src.id}/tokens/${t.id}`);
    expect((await push(src.id, rotated.token, runEvent({ job: 'j' }))).status).toBe(401);
  });
});

describe('the OpenLineage push', () => {
  let src = '';
  let token = '';
  let other = '';
  let otherToken = '';
  beforeAll(async () => {
    src = (await dana('POST', '/data-products/lineage-sources', { name: 'Airflow push', kind: 'openlineage' })).id;
    token = (await dana('POST', `/data-products/lineage-sources/${src}/tokens`, { name: 'CI', rateLimitPerMinute: 1000 })).token;
    other = (await dana('POST', '/data-products/lineage-sources', { name: 'Other push', kind: 'openlineage' })).id;
    otherToken = (await dana('POST', `/data-products/lineage-sources/${other}/tokens`, { name: 'CI', rateLimitPerMinute: 3 })).token;
  });

  it('takes only the source’s push token – not an API token, a session, another source’s token or none', async () => {
    const e = runEvent({ job: 'nothing' });
    expect((await push(src, null, e)).body).toMatchObject({ code: 'DATA_LINEAGE_TOKEN_MISSING' });
    const api = (await dana('POST', '/me/tokens', { name: 'not for pushes', scope: 'full' })).token as string;
    expect(await push(src, api, e)).toMatchObject({ status: 401, body: { code: 'DATA_LINEAGE_API_TOKEN' } });
    expect(await push(src, otherToken, e)).toMatchObject({ status: 401, body: { code: 'DATA_LINEAGE_TOKEN_INVALID' } });
    expect(await push(src, token, e, { headers: { cookie: 'sm_session=abc' } })).toMatchObject({ status: 400, body: { code: 'DATA_LINEAGE_PUSH_SESSION' } });
    expect(await push(src, token, e, { headers: { 'content-type': 'text/plain' } })).toMatchObject({ status: 415 });
    // the rate limit of the token
    for (let i = 0; i < 3; i++) expect((await push(other, otherToken, runEvent({ job: `rate-${i}` }))).status).toBe(200);
    expect(await push(other, otherToken, runEvent({ job: 'rate-4' }))).toMatchObject({ status: 429, body: { code: 'DATA_LINEAGE_RATE' } });
  });

  it('refuses malformed and oversized events, counted on the source, and keeps nothing of them', async () => {
    const before = (await dana('GET', `/data-products/lineage-sources/${src}`)).stats;
    expect(await push(src, token, null, { raw: '{"eventType":' })).toMatchObject({ status: 400, body: { code: 'DATA_LINEAGE_EVENT_INVALID' } });
    expect(await push(src, token, { ...runEvent({ job: 'x' }), schemaURL: 'https://openlineage.io/spec/1-0-5/OpenLineage.json' })).toMatchObject({
      status: 400,
      body: { code: 'DATA_LINEAGE_EVENT_INVALID', params: { where: 'schemaURL' } },
    });
    expect(await push(src, token, { ...runEvent({ job: 'x' }), eventTime: 'yesterday' })).toMatchObject({
      status: 400,
      body: { params: { where: 'eventTime' } },
    });
    expect((await push(src, token, { hello: 'world' })).body).toMatchObject({ code: 'DATA_LINEAGE_EVENT_INVALID' });
    expect((await push(src, token, [])).status).toBe(400);
    expect(
      (
        await push(
          src,
          token,
          Array.from({ length: 101 }, () => runEvent({ job: 'many' })),
        )
      ).status,
    ).toBe(400);
    const tooMany = runEvent({ job: 'wide', inputs: Array.from({ length: 501 }, (_, i) => ({ namespace: 'postgres://db.example:5432', name: `t${i}` })) });
    expect((await push(src, token, tooMany)).status).toBe(400);
    // larger than 1 MB: refused from Content-Length before the body is read
    const big = await push(src, token, null, { raw: JSON.stringify({ ...runEvent({ job: 'big' }), pad: 'x'.repeat(1_100_000) }) });
    expect(big.status).toBe(413);
    const after = (await dana('GET', `/data-products/lineage-sources/${src}`)).stats;
    expect(after.refused - before.refused).toBe(7);
    expect(after.lastErrorCode).toBe('DATA_LINEAGE_EVENT_INVALID');
    expect(Number(dbm.db().get<{ n: number }>("SELECT COUNT(*) AS n FROM dp_lineage_proposals WHERE job_key LIKE '%/x' OR job_key LIKE '%/many'")!.n)).toBe(0);
  });

  it('matches datasets to elements, proposes a step per job, keeps the last run – and never a facet', async () => {
    const staged = await el('SHOP.STAGED.ORDERS');
    const customers = await el('SHOP.SALES.CUSTOMERS');
    const curated = await el('SHOP.CURATED.CUSTOMERS');
    const secret = 'INVENTED-SECRET-VALUE-4711';
    const facets = {
      dataQualityMetrics: { rowCount: 3, columnMetrics: { email: { min: secret, max: secret } } },
      schema: { fields: [{ name: secret }] },
    };
    const start = runEvent({
      type: 'START',
      runId: '0190c3d4-2222-7000-8000-000000000001',
      job: 'build_customer_mart',
      inputs: [{ ...ds(staged), facets }, ds(customers)],
      outputs: [ds(curated)],
      time: '2026-11-13T05:00:00.000Z',
      extra: { run: { runId: '0190c3d4-2222-7000-8000-000000000001', facets: { errorMessage: { message: secret, programmingLanguage: 'python' } } } },
    });
    const r = await push(src, token, start, { path: '/api/v1/lineage' });
    expect(r).toMatchObject({ status: 200, body: { accepted: 1, proposals: { created: 1 } } });
    // a dataset no element matches, in the COMPLETE event
    const complete = runEvent({
      runId: '0190c3d4-2222-7000-8000-000000000001',
      job: 'build_customer_mart',
      inputs: [ds(staged), ds(customers), { namespace: 'postgres://crm-db.example:5432', name: 'crm.public.accounts' }],
      outputs: [ds(curated)],
      time: '2026-11-13T05:10:00.000Z',
    });
    expect((await push(src, token, complete)).status).toBe(200);
    const page = await dana('GET', `/data-products/lineage-proposals?sourceId=${src}`);
    const p = page.items.find((x: { name: string }) => x.name === 'build_customer_mart');
    expect(p).toMatchObject({
      origin: 'openlineage',
      key: 'airflow-invented/build_customer_mart',
      tool: 'Airflow',
      status: 'open',
      unmatchedInputs: ['postgres://crm-db.example:5432/crm.public.accounts'],
      unmatchedInputCount: 1,
      lastRun: { state: 'complete', at: '2026-11-13T05:10:00.000Z', completeAt: '2026-11-13T05:10:00.000Z' },
      canAccept: true,
    });
    expect(p.inputs.map((e: { qualifiedName: string }) => e.qualifiedName).sort()).toEqual(['SHOP.SALES.CUSTOMERS', 'SHOP.STAGED.ORDERS']);
    expect(p.outputs.map((e: { qualifiedName: string }) => e.qualifiedName)).toEqual(['SHOP.CURATED.CUSTOMERS']);
    // an older event does not replace the last run
    await push(src, token, { ...start, eventTime: '2026-11-12T05:00:00.000Z' });
    expect((await dana('GET', `/data-products/lineage-proposals/${p.id}`)).lastRun.state).toBe('complete');
    // nothing of the facets is kept anywhere
    for (const t of ['dp_lineage_proposals', 'dp_lineage_sources', 'dp_lineage_proposal_elements', 'audit_log'])
      expect(JSON.stringify(dbm.db().all(`SELECT * FROM ${t}`))).not.toContain(secret);
  });

  it('costs a fixed number of statements per event, whatever the number of its datasets', async () => {
    const staged = await el('SHOP.STAGED.ORDERS');
    const curated = await el('SHOP.CURATED.CUSTOMERS');
    const key = `POST /api/hooks/data-lineage/${src}`;
    await push(src, token, runEvent({ job: 'narrow', inputs: [ds(staged)], outputs: [ds(curated)] }));
    const narrow = statements.get(key)!;
    const wide = runEvent({
      job: 'wide-job',
      inputs: [ds(staged), ...Array.from({ length: 300 }, (_, i) => ({ namespace: 'postgres://warehouse.example:5432', name: `stage.public.t${i}` }))],
      outputs: [ds(curated)],
    });
    await push(src, token, wide);
    const wideCount = statements.get(key)!;
    expect(narrow).toBeGreaterThan(0);
    expect(wideCount).toBeLessThanOrEqual(narrow + 2);
    // a known job's next run: fewer still
    await push(src, token, { ...wide, eventTime: new Date().toISOString() });
    expect(statements.get(key)!).toBeLessThanOrEqual(wideCount);
  });

  it('answers 404 while the module is off', async () => {
    await s.api('PUT', '/settings/modules/dataProducts', { enabled: false });
    try {
      expect((await push(src, token, runEvent({ job: 'off' }))).status).toBe(404);
    } finally {
      await s.api('PUT', '/settings/modules/dataProducts', { enabled: true });
    }
  });
});

describe('the inbox of proposed steps', () => {
  let src = '';
  let token = '';
  beforeAll(async () => {
    src = (await dana('POST', '/data-products/lineage-sources', { name: 'Spark jobs', kind: 'openlineage' })).id;
    token = (await dana('POST', `/data-products/lineage-sources/${src}/tokens`, { name: 'CI', rateLimitPerMinute: 1000 })).token;
  });

  it('says when the documented steps say the same already', async () => {
    const staged = await el('SHOP.STAGED.ORDERS');
    const curatedOrders = await el('SHOP.CURATED.ORDERS');
    await push(src, token, runEvent({ job: 'curate_orders', inputs: [ds(staged)], outputs: [ds(curatedOrders)] }));
    const documented = await dana('GET', `/data-products/lineage-proposals?sourceId=${src}&status=documented`);
    expect(documented.items.map((p: { name: string }) => p.name)).toContain('curate_orders');
    const p = documented.items.find((x: { name: string }) => x.name === 'curate_orders');
    expect(p.stepId).toBeTruthy();
    expect(p.canAccept).toBe(false);
  });

  it('makes a step on accept, keeps the step’s last run, reopens on new datasets and changes the step on a second accept', async () => {
    const customers = await el('SHOP.SALES.ORDERS');
    const curated = await el('SHOP.CURATED.CUSTOMERS');
    const staged = await el('SHOP.STAGED.ORDERS');
    await push(src, token, runEvent({ job: 'enrich_customers', inputs: [ds(customers)], outputs: [ds(curated)], time: '2026-11-13T06:00:00.000Z' }));
    const p = (await dana('GET', `/data-products/lineage-proposals?sourceId=${src}`)).items.find((x: { name: string }) => x.name === 'enrich_customers');
    // vera may see it, not decide it; an API token cannot decide (session-only)
    expect((await vera('GET', `/data-products/lineage-proposals/${p.id}`)).canAccept).toBe(false);
    expect((await fail(vera('POST', `/data-products/lineage-proposals/${p.id}/accept`))).status).toBe(403);
    const viaToken = await fetch(`${s.base}/api/data-products/lineage-proposals/${p.id}/accept`, {
      method: 'POST',
      headers: { authorization: `Bearer ${(await dana('POST', '/me/tokens', { name: 'decide', scope: 'full' })).token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(viaToken.status).toBe(403);
    const accepted = await dana('POST', `/data-products/lineage-proposals/${p.id}/accept`, { name: 'Enrich customers', kind: 'curate' });
    expect(accepted).toMatchObject({ status: 'accepted', decidedBy: 'dana', canAccept: false });
    expect(accepted.stepId).toBeTruthy();
    expect((await fail(dana('POST', `/data-products/lineage-proposals/${p.id}/accept`))).code).toBe('DATA_LINEAGE_PROPOSAL_DECIDED');
    // the step is documented where its result lives: Customer 360's pipeline, with the job's last run
    const c360 = ((await dana('GET', '/data-products?limit=100')).items as { id: string; key: string }[]).find((x) => x.key === 'customer-360')!.id;
    const stepOf = async () =>
      ((await dana('GET', `/data-products/${c360}/steps`)) as { id: string }[]).find((x) => x.id === accepted.stepId) as Record<string, any>;
    expect(await stepOf()).toMatchObject({
      name: 'Enrich customers',
      kind: 'curate',
      runner: { kind: 'tool', tool: 'Airflow', text: 'airflow-invented/enrich_customers' },
      lastRun: { state: 'complete', at: '2026-11-13T06:00:00.000Z', origin: 'openlineage', sourceId: src },
    });
    // a later run is the step's last run (a failed one keeps the last complete)
    await push(
      src,
      token,
      runEvent({ type: 'FAIL', job: 'enrich_customers', runId: 'r-2', inputs: [ds(customers)], outputs: [ds(curated)], time: '2026-11-13T07:00:00.000Z' }),
    );
    expect((await stepOf()).lastRun).toMatchObject({ state: 'fail', completeAt: '2026-11-13T06:00:00.000Z' });
    expect((await dana('GET', `/data-products/lineage-proposals/${p.id}`)).status).toBe('accepted');
    // a completed run that reads one more element: open again, as a change of the step
    await push(
      src,
      token,
      runEvent({ job: 'enrich_customers', runId: 'r-3', inputs: [ds(customers), ds(staged)], outputs: [ds(curated)], time: '2026-11-13T08:00:00.000Z' }),
    );
    expect(await dana('GET', `/data-products/lineage-proposals/${p.id}`)).toMatchObject({ status: 'open', changed: true, canAccept: true });
    await dana('POST', `/data-products/lineage-proposals/${p.id}/accept`);
    expect(((await stepOf()).inputs as string[]).sort()).toEqual([customers.id, staged.id].sort());
    expect((await dana('GET', `/data-products/lineage-proposals/${p.id}`)).status).toBe('accepted');
    // the step deleted: the proposal waits for a decision again
    await dana('DELETE', `/data-products/${c360}/steps/${accepted.stepId}`);
    expect(await dana('GET', `/data-products/lineage-proposals/${p.id}`)).toMatchObject({ status: 'open', stepId: null, canAccept: true });
  });

  it('rejects for good until the job names other datasets', async () => {
    const customers = await el('SHOP.SALES.ORDERS');
    const curated = await el('SHOP.MART.ORDERS_BY_REGION');
    const staged = await el('SHOP.STAGED.ORDERS');
    await push(src, token, runEvent({ job: 'copy_customers', inputs: [ds(customers)], outputs: [ds(curated)] }));
    const p = (await dana('GET', `/data-products/lineage-proposals?sourceId=${src}`)).items.find((x: { name: string }) => x.name === 'copy_customers');
    expect((await fail(olivia('POST', `/data-products/lineage-proposals/${p.id}/reject`))).status).toBe(403);
    expect(await dana('POST', `/data-products/lineage-proposals/${p.id}/reject`)).toMatchObject({ status: 'rejected', decidedBy: 'dana' });
    await push(src, token, runEvent({ job: 'copy_customers', inputs: [ds(customers)], outputs: [ds(curated)] }));
    expect((await dana('GET', `/data-products/lineage-proposals/${p.id}`)).status).toBe('rejected');
    await push(src, token, runEvent({ job: 'copy_customers', inputs: [ds(customers), ds(staged)], outputs: [ds(curated)] }));
    expect((await dana('GET', `/data-products/lineage-proposals/${p.id}`)).status).toBe('open');
  });

  it('shows proposals only to who sees their source, and elements they may not see only as a count', async () => {
    const team = (await s.api('POST', '/teams', { name: 'Lineage team', members: ['olivia'] })).id;
    const scoped = await s.api('POST', '/data-products/lineage-sources', { name: 'Team jobs', kind: 'openlineage', teamIds: [team] });
    const t = (await s.api('POST', `/data-products/lineage-sources/${scoped.id}/tokens`, { name: 'CI' })).token;
    // an element only another team sees, with an OpenLineage dataset of its own
    const other = (await s.api('POST', '/teams', { name: 'Hidden team', members: ['adam'] })).id;
    const hidden = await s.api('POST', '/data-elements', {
      platformId: snowflake,
      kind: 'snowflake.table',
      qualifiedName: 'SHOP.SALES.HIDDEN_RATES',
      environment: 'prod',
    });
    await s.api('PUT', `/owning-teams/data_element/${hidden.id}`, { teamIds: [other] });
    const customers = await el('SHOP.SALES.CUSTOMERS');
    const curated = await el('SHOP.CURATED.CUSTOMERS');
    dbm.db().run("UPDATE dp_elements SET ol_namespace = ?, ol_name = 'SHOP.SALES.HIDDEN_RATES' WHERE id = ?", customers.olNamespace, hidden.id);
    await push(
      scoped.id,
      t,
      runEvent({ job: 'team_job', inputs: [ds(customers), { namespace: customers.olNamespace, name: 'shop.sales.hidden_rates' }], outputs: [ds(curated)] }),
    );
    // vera and dana (not in the team) see neither the source nor its proposals
    expect(((await vera('GET', '/data-products/lineage-sources')) as { id: string }[]).map((x) => x.id)).not.toContain(scoped.id);
    expect((await fail(vera('GET', `/data-products/lineage-sources/${scoped.id}`))).code).toBe('DATA_LINEAGE_SOURCE_NOT_FOUND');
    expect((await dana('GET', `/data-products/lineage-proposals?sourceId=${scoped.id}`)).items).toEqual([]);
    expect(((await dana('GET', '/data-products/lineage-proposals')).items as { sourceId: string }[]).map((x) => x.sourceId)).not.toContain(scoped.id);
    // olivia (the team) sees it, the hidden element counted, never named
    const p = (await olivia('GET', `/data-products/lineage-proposals?sourceId=${scoped.id}`)).items[0];
    expect(p).toMatchObject({ name: 'team_job', hiddenInputs: 1, cannotAccept: 'hiddenEnds', canAccept: false });
    expect(JSON.stringify(p)).not.toContain('HIDDEN_RATES');
    expect(JSON.stringify(p)).not.toContain(hidden.id);
    // the administrator sees it all
    expect((await s.api('GET', `/data-products/lineage-proposals/${p.id}`)).hiddenInputs).toBe(0);
  });

  it('draws open proposals as proposed ways in the lineage of an element', async () => {
    const customers = await el('SHOP.SALES.CUSTOMERS');
    const curated = await el('SHOP.CURATED.CUSTOMERS');
    const staged = await el('SHOP.STAGED.ORDERS');
    await push(src, token, runEvent({ job: 'score_customers', inputs: [ds(staged)], outputs: [ds(customers)] }));
    const v = await dana('GET', `/data-elements/${customers.id}/lineage?depth=1`);
    const proposed = (v.edges as { from: string; to: string; proposed?: boolean }[]).filter((e) => e.proposed);
    expect(proposed.map((e) => `${e.from}>${e.to}`)).toContain(`${staged.id}>${customers.id}`);
    expect((v.steps as { name: string; proposed?: boolean }[]).find((x) => x.name === 'score_customers')?.proposed).toBe(true);
    // documented ways stay as they are (Build customer 360: CUSTOMERS → CURATED.CUSTOMERS)
    expect((v.edges as { from: string; to: string; proposed?: boolean }[]).some((e) => e.from === customers.id && e.to === curated.id && !e.proposed)).toBe(
      true,
    );
    // a reader who may not see the source sees no proposed way
    const team = (await s.api('POST', '/teams', { name: 'Closed jobs', members: ['olivia'] })).id;
    await s.api('PUT', `/data-products/lineage-sources/${src}`, { name: 'Spark jobs', kind: 'openlineage', teamIds: [team] });
    const seen = await vera('GET', `/data-elements/${customers.id}/lineage?depth=1`);
    expect((seen.steps as { name: string }[]).map((x) => x.name)).not.toContain('score_customers');
    expect((seen.edges as { from: string; to: string; proposed?: boolean }[]).some((e) => e.proposed && e.from === staged.id && e.to === customers.id)).toBe(
      false,
    );
  });
});

describe('dbt', () => {
  let src = '';
  let token = '';
  const manifest = () => ({
    metadata: { dbt_schema_version: 'https://schemas.getdbt.com/dbt/manifest/v12.json', adapter_type: 'snowflake' },
    nodes: {
      'model.shop.stg_orders': {
        resource_type: 'model',
        name: 'stg_orders',
        unique_id: 'model.shop.stg_orders',
        database: 'SHOP',
        schema: 'STAGED',
        alias: 'ORDERS',
        config: { materialized: 'table' },
        depends_on: { nodes: ['source.shop.raw.orders_raw', 'model.shop.int_customers'] },
        raw_code: 'select * from INVENTED-RAW-CODE',
        compiled_code: 'select INVENTED-COMPILED',
      },
      'model.shop.int_customers': {
        resource_type: 'model',
        name: 'int_customers',
        unique_id: 'model.shop.int_customers',
        database: 'SHOP',
        schema: 'STAGED',
        alias: 'INT_CUSTOMERS',
        config: { materialized: 'ephemeral' },
        depends_on: { nodes: ['source.shop.sales.customers'] },
      },
      'model.shop.unknown_model': {
        resource_type: 'model',
        name: 'unknown_model',
        unique_id: 'model.shop.unknown_model',
        database: 'SHOP',
        schema: 'MART',
        alias: 'NOT_THERE',
        config: { materialized: 'view' },
        depends_on: { nodes: ['model.shop.stg_orders'] },
      },
      'test.shop.not_null_stg_orders_id.1a': {
        resource_type: 'test',
        name: 'not_null_stg_orders_id',
        unique_id: 'test.shop.not_null_stg_orders_id.1a',
        attached_node: 'model.shop.stg_orders',
        column_name: 'id',
        test_metadata: { name: 'not_null', kwargs: { column_name: 'id' } },
        depends_on: { nodes: ['model.shop.stg_orders'] },
      },
      'test.shop.accepted_values_stg_orders_status.2b': {
        resource_type: 'test',
        name: 'accepted_values_stg_orders_status',
        unique_id: 'test.shop.accepted_values_stg_orders_status.2b',
        attached_node: 'model.shop.stg_orders',
        test_metadata: { name: 'accepted_values', kwargs: { values: ['INVENTED-ACCEPTED-VALUE'] } },
        depends_on: { nodes: ['model.shop.stg_orders'] },
      },
    },
    sources: {
      'source.shop.raw.orders_raw': {
        resource_type: 'source',
        name: 'orders_raw',
        unique_id: 'source.shop.raw.orders_raw',
        database: 'SHOP',
        schema: 'RAW',
        identifier: 'ORDERS_RAW',
      },
      'source.shop.sales.customers': {
        resource_type: 'source',
        name: 'customers',
        unique_id: 'source.shop.sales.customers',
        database: 'SHOP',
        schema: 'SALES',
        identifier: 'CUSTOMERS',
      },
    },
  });
  const runResults = () => ({
    metadata: { dbt_schema_version: 'https://schemas.getdbt.com/dbt/run-results/v6.json', generated_at: '2026-11-13T04:00:00Z' },
    results: [
      { unique_id: 'model.shop.stg_orders', status: 'success', timing: [{ name: 'execute', completed_at: '2026-11-13T03:58:00Z' }], message: 'SUCCESS 1' },
      { unique_id: 'test.shop.not_null_stg_orders_id.1a', status: 'pass', failures: 0, message: null },
      { unique_id: 'test.shop.accepted_values_stg_orders_status.2b', status: 'fail', failures: 3, message: 'Got 3 results: INVENTED-FAILING-ROW' },
      { unique_id: 'model.shop.not_in_manifest', status: 'error' },
    ],
  });

  beforeAll(async () => {
    src = (await dana('POST', '/data-products/lineage-sources', { name: 'dbt shop', kind: 'dbt', platformId: snowflake })).id;
    token = (await dana('POST', `/data-products/lineage-sources/${src}/tokens`, { name: 'CI' })).token;
  });

  it('reads a manifest: models as proposed steps through ephemeral models, tests with their element – no code', async () => {
    expect(await push(src, token, { ...manifest(), metadata: { dbt_schema_version: 'https://example.com/x.json' } }, { path: '/dbt/manifest' })).toMatchObject({
      status: 400,
      body: { code: 'DATA_LINEAGE_DBT_INVALID' },
    });
    // the OpenLineage address of a dbt source refuses events
    expect((await push(src, token, runEvent({ job: 'x' }))).body).toMatchObject({ code: 'DATA_LINEAGE_SOURCE_KIND' });
    const r = await push(src, token, manifest(), { path: '/dbt/manifest' });
    expect(r).toMatchObject({ status: 200, body: { import: { file: 'manifest', counts: { steps: 2, created: 2, unmatched: 1, tests: 2 } } } });
    const items = [
      ...(await dana('GET', `/data-products/lineage-proposals?sourceId=${src}&status=documented`)).items,
      ...(await dana('GET', `/data-products/lineage-proposals?sourceId=${src}`)).items,
    ] as Record<string, any>[];
    const stg = items.find((x) => x.key === 'model.shop.stg_orders')!;
    // ORDERS_RAW and – through the ephemeral model – CUSTOMERS → STAGED.ORDERS: the demo's "Stage orders" says so already
    expect(stg).toMatchObject({ origin: 'dbt', tool: 'dbt', status: 'documented' });
    expect((stg.inputs as { qualifiedName: string }[]).map((e) => e.qualifiedName).sort()).toEqual(['SHOP.RAW.ORDERS_RAW', 'SHOP.SALES.CUSTOMERS']);
    const unknown = items.find((x) => x.key === 'model.shop.unknown_model');
    expect(unknown).toMatchObject({ status: 'open', outputs: [], unmatchedOutputs: ['SHOP.MART.NOT_THERE'], cannotAccept: 'noOutputs' });
    for (const t of ['dp_lineage_proposals', 'dp_lineage_tests', 'dp_lineage_sources'])
      expect(JSON.stringify(dbm.db().all(`SELECT * FROM ${t}`))).not.toMatch(/INVENTED-(RAW-CODE|COMPILED|ACCEPTED-VALUE)/);
  });

  it('reads run results: the model’s last run, the tests as quality results of their element – never the message', async () => {
    const r = await push(src, token, runResults(), { path: '/dbt/run-results' });
    expect(r).toMatchObject({ status: 200, body: { import: { file: 'runResults', counts: { results: 4, runs: 1, tests: 2, unknown: 1 } } } });
    const staged = await el('SHOP.STAGED.ORDERS');
    const { qualityResultsOf } = await import('../src/dataproducts/quality-results.js');
    const results = qualityResultsOf([staged.id]).get(staged.id) ?? [];
    expect(results.map((x) => [x.name, x.status, x.dimension, x.failures]).sort()).toEqual([
      ['accepted_values_stg_orders_status', 'fail', 'accuracy', 3],
      ['not_null_stg_orders_id', 'pass', 'completeness', 0],
    ]);
    expect(JSON.stringify(dbm.db().all('SELECT * FROM dp_quality_results'))).not.toContain('INVENTED-FAILING-ROW');
    const stg = ((await dana('GET', `/data-products/lineage-proposals?sourceId=${src}&status=documented`)).items as Record<string, any>[]).find(
      (x) => x.key === 'model.shop.stg_orders',
    )!;
    expect(stg.lastRun).toMatchObject({ state: 'complete', at: '2026-11-13T03:58:00.000Z' });
    // the documented step it matches gets the run too
    const stageOrders = dbm.db().get<{ last_run: string }>('SELECT last_run FROM dp_steps WHERE id = ?', stg.stepId)!;
    expect(JSON.parse(stageOrders.last_run)).toMatchObject({ state: 'complete', origin: 'dbt' });
  });

  it('takes uploads in the app from who manages the source, in a signed-in session', async () => {
    const anonymous = await fetch(`${s.base}/api/data-products/lineage-sources/${src}/dbt/run-results`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sm-client': '1' },
      body: JSON.stringify(runResults()),
    });
    expect(anonymous.status).toBe(401);
    expect(await dana('POST', `/data-products/lineage-sources/${src}/dbt/run-results`, runResults())).toMatchObject({ file: 'runResults', by: 'dana' });
    expect((await fail(olivia('POST', `/data-products/lineage-sources/${src}/dbt/run-results`, runResults()))).status).toBe(403);
    expect((await dana('GET', `/data-products/lineage-sources/${src}`)).lastImport).toMatchObject({ file: 'runResults', by: 'dana' });
  });
});

describe('Snowflake OBJECT_DEPENDENCIES', () => {
  it('are read in account usage mode after a complete run with an allowed statement, and proposed as steps', async () => {
    const sfMock = await import('../src/mock/mockSnowflake.js');
    const { SNOWFLAKE_DISCOVERY_STATEMENTS } = await import('../src/dataproducts/discovery/snowflake.js');
    const job = await import('../src/dataproducts/discovery/job.js');
    const source = await dana('POST', '/data-products/discovery-sources', {
      name: 'Shop (account usage)',
      platformId: snowflake,
      scope: ['SHOP'],
      mode: 'accountUsage',
      environmentRules: [{ match: 'prefix', value: 'SHOP', environment: 'prod' }],
      enabled: false,
    });
    sfMock.resetSnowflakeStatements();
    const run = await job.runSource(source.id, { trigger: 'manual', actor: 'dana' });
    expect(run.status).toBe('succeeded');
    const sent = sfMock.snowflakeStatements().map((x) => x.sql);
    for (const sql of sent)
      expect(
        SNOWFLAKE_DISCOVERY_STATEMENTS.some((re) => re.test(sql)),
        sql,
      ).toBe(true);
    expect(sent.filter((x) => x.includes('OBJECT_DEPENDENCIES'))).toHaveLength(1);
    const open = (await dana('GET', `/data-products/lineage-proposals?sourceId=${source.id}`)).items as Record<string, any>[];
    const documented = (await dana('GET', `/data-products/lineage-proposals?sourceId=${source.id}&status=documented`)).items as { key: string }[];
    // the demo's steps document the pipeline already; the report view is new, with a referenced table outside the catalogue
    expect(documented.map((p) => p.key).sort()).toEqual(['SHOP.CURATED.ORDERS', 'SHOP.MART.DAILY_SALES', 'SHOP.MART.ORDERS_BY_REGION']);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      origin: 'snowflake',
      key: 'SHOP.REPORTING.DAILY_REVENUE',
      tool: 'Snowflake view',
      unmatchedInputs: ['FINANCE.PUBLIC.FX_RATES'],
      sourceName: 'Shop (account usage)',
    });
    expect((open[0]!.inputs as { qualifiedName: string }[]).map((e) => e.qualifiedName)).toEqual(['SHOP.SALES.ORDERS']);
    // the information schema mode does not read them
    const info = await dana('POST', '/data-products/discovery-sources', {
      name: 'Shop (information schema)',
      platformId: snowflake,
      scope: ['SHOP'],
      enabled: false,
    });
    sfMock.resetSnowflakeStatements();
    await job.runSource(info.id, { trigger: 'manual', actor: 'dana' });
    expect(sfMock.snowflakeStatements().some((x) => x.sql.includes('OBJECT_DEPENDENCIES'))).toBe(false);
    // vera sees no discovery source of a platform she may not see – nor its proposals
    expect(((await vera('GET', '/data-products/lineage-proposals')).items as { sourceId: string }[]).map((x) => x.sourceId)).not.toContain(source.id);
  });
});
