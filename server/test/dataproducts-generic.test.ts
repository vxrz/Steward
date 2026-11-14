import fs from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Generic parts, bridges and the technology list (0.25.0, ADR 0037 parts 0 and 5, docs/DATA-PRODUCTS.md#generic-parts-and-bridges):
 * the list read by every reader of the module and changed by administrators only (built-in entries stay); generic
 * elements with technology, namespace and properties – identity, filters, the pictures, the scorecard, cost matches –
 * and Convert to … (same id, refused when the target identity is taken, audited); bridge steps with a runner
 * technology; the OpenLineage static export per product and step, validated against the vendored OpenLineage spec and
 * facet schemas and with the push's own check, hidden ends counted in the Steward facet, never named.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
let s: TestServer;
let dana: Client;
let vera: Client;
let olivia: Client;
let kafka = '';
let snowflake = '';
let orders = '';

const fail = async (p: Promise<unknown>): Promise<{ status: number; code: string; params: Record<string, unknown> }> => {
  try {
    await p;
  } catch (e) {
    const err = e as { status: number; body?: { code?: string; params?: Record<string, unknown> } };
    return { status: err.status, code: err.body?.code ?? '', params: err.body?.params ?? {} };
  }
  throw new Error('expected a refusal');
};

let adminToken = '';
let oliviaToken = '';
async function text(url: string, token = adminToken): Promise<{ status: number; type: string; body: string; disposition: string }> {
  const res = await fetch(`${s.base}${url}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text(), disposition: res.headers.get('content-disposition') ?? '' };
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', { services: true });
  await s.api('PUT', '/settings/modules/dataProducts', { enabled: true });
  dana = await s.as('dana', PW);
  vera = await s.as('vera', PW);
  olivia = await s.as('olivia', PW);
  const platforms = (await s.api('GET', '/platforms')) as { id: string; kind: string; name: string }[];
  kafka = platforms.find((p) => p.name === 'Kafka (demo)')!.id;
  snowflake = platforms.find((p) => p.kind === 'snowflake')!.id;
  orders = ((await s.api('GET', '/data-products?q=Orders')).items as { id: string; key: string }[]).find((p) => p.key === 'orders')!.id;
  adminToken = (await s.api('POST', '/me/tokens', { name: 'openlineage admin', scope: 'read' })).token;
  oliviaToken = (await olivia('POST', '/me/tokens', { name: 'openlineage olivia', scope: 'read' })).token;
}, 180_000);

describe('the technology list', () => {
  it('is read by every reader of the module: the built-in parts and bridges with role, icon and namespace pattern', async () => {
    const list = (await vera('GET', '/data-products/technologies')) as {
      key: string;
      role: string;
      icon: string;
      olNamespacePattern: string | null;
      builtIn: boolean;
    }[];
    const keys = list.map((t) => t.key);
    for (const k of [
      'snowflake',
      'kafka',
      'confluent',
      'amazon-s3',
      'debezium',
      'kafka-connect',
      'node-red',
      'apache-camel',
      'industrial-edge',
      'mqtt',
      'rest-api',
      'dbt',
      'spark',
      'airflow',
    ])
      expect(keys).toContain(k);
    expect(list.find((t) => t.key === 'debezium')).toMatchObject({ role: 'bridge', builtIn: true });
    expect(list.find((t) => t.key === 'mqtt')).toMatchObject({ role: 'part', icon: 'topic', olNamespacePattern: 'mqtt://{host}:{port}' });
  });

  it('is changed by administrators only; built-in entries and names stay unique', async () => {
    expect((await fail(dana('PUT', '/data-products/technologies/invented-flow', { name: 'Invented Flow', role: 'bridge' }))).status).toBe(403);
    const t = await s.api('PUT', '/data-products/technologies/invented-flow', { name: 'Invented Flow', role: 'bridge', icon: 'flow' });
    expect(t).toMatchObject({ key: 'invented-flow', name: 'Invented Flow', role: 'bridge', icon: 'flow', builtIn: false, updatedBy: 'admin' });
    expect(((await vera('GET', '/data-products/technologies')) as { key: string }[]).map((x) => x.key)).toContain('invented-flow');
    expect((await fail(s.api('PUT', '/data-products/technologies/kafka', { name: 'Kafka', role: 'part' }))).code).toBe('DATA_TECHNOLOGY_BUILT_IN');
    expect((await fail(s.api('PUT', '/data-products/technologies/flows', { name: 'node-red', role: 'bridge' }))).code).toBe('DATA_TECHNOLOGY_EXISTS');
    expect((await fail(s.api('PUT', '/data-products/technologies/Bad Key', { name: 'Bad', role: 'part' }))).status).toBe(400);
    expect((await fail(dana('DELETE', '/data-products/technologies/invented-flow'))).status).toBe(403);
    expect((await fail(s.api('DELETE', '/data-products/technologies/debezium'))).code).toBe('DATA_TECHNOLOGY_BUILT_IN');
    await s.api('PUT', '/data-products/technologies/invented-bus', { name: 'Invented Bus', role: 'part', icon: 'topic', olNamespacePattern: 'ibus://{host}' });
    await s.api('DELETE', '/data-products/technologies/invented-flow');
    expect((await fail(s.api('DELETE', '/data-products/technologies/invented-flow'))).code).toBe('DATA_TECHNOLOGY_NOT_FOUND');
    const audit = (await s.api('GET', '/audit?q=technolog&limit=20')) as { items?: { action: string }[] } | { action: string }[];
    const actions = (Array.isArray(audit) ? audit : (audit.items ?? [])).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['datatechnology.created', 'datatechnology.deleted']));
  });
});

describe('generic parts', () => {
  let stream = '';
  it('need a technology and a namespace; other kinds have neither', async () => {
    const base = { kind: 'generic.stream', qualifiedName: 'invented/line-1/telemetry', environment: 'prod' };
    expect(await fail(dana('POST', '/data-elements', { ...base, namespace: 'mqtt://broker.invented.example:1883' }))).toMatchObject({
      code: 'DATA_ELEMENT_GENERIC',
      params: { context: 'technology' },
    });
    expect(await fail(dana('POST', '/data-elements', { ...base, technology: 'MQTT' }))).toMatchObject({
      code: 'DATA_ELEMENT_GENERIC',
      params: { context: 'namespace' },
    });
    expect(
      await fail(
        dana('POST', '/data-elements', {
          platformId: snowflake,
          kind: 'snowflake.table',
          qualifiedName: 'SHOP.X.Y',
          environment: 'prod',
          technology: 'snowflake',
        }),
      ),
    ).toMatchObject({ code: 'DATA_ELEMENT_GENERIC', params: { context: 'notGeneric' } });
    // the list entry by its name is stored as its key; the namespace and name are its OpenLineage dataset
    const e = await dana('POST', '/data-elements', {
      ...base,
      technology: 'MQTT',
      namespace: 'mqtt://broker.invented.example:1883',
      properties: [
        { key: 'qos', value: '1' },
        { key: 'retain', value: 'false' },
      ],
    });
    stream = e.id;
    expect(e).toMatchObject({
      kind: 'generic.stream',
      technology: 'mqtt',
      olNamespace: 'mqtt://broker.invented.example:1883',
      olName: 'invented/line-1/telemetry',
      properties: [
        { key: 'qos', value: '1' },
        { key: 'retain', value: 'false' },
      ],
      platformId: null,
    });
    // one dataset is one element (kind, environment, namespace and name)
    expect(
      (
        await fail(
          dana('POST', '/data-elements', {
            ...base,
            qualifiedName: 'INVENTED/line-1/telemetry',
            technology: 'mqtt',
            namespace: 'MQTT://broker.invented.example:1883',
          }),
        )
      ).code,
    ).toBe('DATA_ELEMENT_EXISTS');
    // a free value is kept as typed (not in the list)
    const free = await dana('POST', '/data-elements', {
      kind: 'generic.dataset',
      qualifiedName: 'returns.ledger',
      environment: 'prod',
      technology: 'Invented Ledger DB',
      namespace: 'ledger://ledger.invented.example',
    });
    expect(free.technology).toBe('Invented Ledger DB');
  });

  it('keep their fields on a change and are filtered by technology', async () => {
    const changed = await dana('PUT', `/data-elements/${stream}`, {
      properties: [{ key: 'qos', value: '2' }],
      namespace: 'mqtt://broker.invented.example:8883',
    });
    expect(changed).toMatchObject({ technology: 'mqtt', olNamespace: 'mqtt://broker.invented.example:8883', properties: [{ key: 'qos', value: '2' }] });
    expect((await dana('PUT', `/data-elements/${stream}`, { layer: 'raw' })).properties).toEqual([{ key: 'qos', value: '2' }]);
    expect((await fail(dana('PUT', `/data-elements/${stream}`, { technology: '' }))).params).toMatchObject({ context: 'technology' });
    const byKey = (await vera('GET', '/data-elements?technology=mqtt')).items as { id: string; technology: string }[];
    expect(byKey.map((x) => x.id)).toContain(stream);
    expect((await vera('GET', '/data-elements?technology=MQTT')).items.map((x: { id: string }) => x.id)).toContain(stream);
    expect((await vera('GET', '/data-elements?technology=invented%20ledger%20db')).items.map((x: { qualifiedName: string }) => x.qualifiedName)).toEqual([
      'returns.ledger',
    ]);
    expect((await vera('GET', '/data-elements?kind=generic.stream')).items.map((x: { id: string }) => x.id)).toContain(stream);
  });

  it('take part in products, bridge steps, pictures, cost matches and the scorecard', async () => {
    await dana('POST', `/data-products/${orders}/members`, { elementIds: [stream], role: 'input' });
    const raw = (await vera('GET', '/data-elements?prefix=SHOP.RAW.ORDERS_RAW&environment=prod')).items[0].id as string;
    const step = await dana('POST', `/data-products/${orders}/steps`, {
      name: 'Line telemetry bridge',
      kind: 'bridge',
      runner: { kind: 'tool', tool: 'Node-RED', text: 'flow telemetry (invented)', technology: 'Node-RED' },
      inputs: [stream],
      outputs: [raw],
    });
    expect(step).toMatchObject({ kind: 'bridge', runner: { kind: 'tool', tool: 'Node-RED', technology: 'node-red' } });
    const view = await vera('GET', `/data-products/${orders}/views/pipeline?environment=prod`);
    const node = (view.nodes as { id: string; technology?: unknown }[]).find((n) => n.id === stream);
    expect(node?.technology).toEqual({ name: 'MQTT', icon: 'topic', listed: true });
    const s1 = (view.steps as { name: string; kind: string; runner: string }[]).find((x) => x.name === 'Line telemetry bridge');
    expect(s1).toMatchObject({ kind: 'bridge', runner: 'Node-RED – flow telemetry (invented)' });
    // a cost line matched by tag (the platform named: a generic part has none of its own)
    const confluent = ((await s.api('GET', '/platforms')) as { id: string; name: string }[]).find((p) => p.name === 'Confluent Cloud (demo)')!.id;
    expect((await fail(dana('POST', `/data-elements/${stream}/cost-matches`, { kind: 'tag', tagKey: 'line', value: 'line-1' }))).status).toBe(400);
    const m = await dana('POST', `/data-elements/${stream}/cost-matches`, { platformId: confluent, kind: 'tag', tagKey: 'line', value: 'line-1' });
    expect(m).toMatchObject({ kind: 'tag', value: 'line-1', tagKey: 'line' });
    // the scorecard names the generic parts and those whose technology is not in the list
    const sc = await vera('GET', `/data-products/${orders}/scorecard?environment=prod`);
    const documented = (sc.parts as { id: string; evidence: { key: string; values?: Record<string, unknown> }[] }[]).find((p) => p.id === 'documented')!;
    expect(documented.evidence).toEqual(expect.arrayContaining([{ key: 'evidence.documented.genericParts', values: { count: 2 } }]));
    expect(documented.evidence.map((e) => e.key)).not.toContain('evidence.documented.technologyNotInList');
  });
});

describe('Convert to …', () => {
  it('turns a generic part into the specific kind: same id, members, steps; refused when the identity is taken', async () => {
    const e = await dana('POST', '/data-elements', {
      kind: 'generic.stream',
      qualifiedName: 'orders.v1',
      environment: 'prod',
      technology: 'kafka',
      namespace: 'kafka://invented-broker:9092',
    });
    await dana('POST', `/data-products/${orders}/members`, { elementIds: [e.id], role: 'internal' });
    const known = (await vera('GET', '/data-elements?prefix=orders.v1&kind=kafka.topic')).items as { id: string }[];
    expect(known.length).toBe(1);
    expect(await fail(vera('POST', `/data-elements/${e.id}/convert`, { kind: 'kafka.topic', platformId: kafka }))).toMatchObject({ status: 403 });
    expect(await fail(dana('POST', `/data-elements/${e.id}/convert`, { kind: 'snowflake.table', platformId: snowflake }))).toMatchObject({
      code: 'DATA_ELEMENT_CONVERT',
      params: { context: 'kind' },
    });
    expect(await fail(dana('POST', `/data-elements/${known[0]!.id}/convert`, { kind: 'kafka.topic', platformId: kafka }))).toMatchObject({
      code: 'DATA_ELEMENT_CONVERT',
      params: { context: 'notGeneric' },
    });
    expect(await fail(dana('POST', `/data-elements/${e.id}/convert`, { kind: 'kafka.topic', platformId: snowflake }))).toMatchObject({
      code: 'DATA_ELEMENT_PLATFORM',
    });
    // orders.v1 is a discovered topic of Kafka (demo) in prod already
    expect(await fail(dana('POST', `/data-elements/${e.id}/convert`, { kind: 'kafka.topic', platformId: kafka }))).toMatchObject({
      status: 409,
      code: 'DATA_ELEMENT_CONVERT_TAKEN',
      params: { kind: 'kafka.topic', environment: 'prod' },
    });
    const c = await dana('POST', `/data-elements/${e.id}/convert`, { kind: 'kafka.topic', platformId: kafka, qualifiedName: 'orders.invented-v3' });
    expect(c).toMatchObject({ id: e.id, kind: 'kafka.topic', platformId: kafka, qualifiedName: 'orders.invented-v3', technology: null });
    expect(c.productRefs.map((x: { product: { id: string } }) => x.product.id)).toContain(orders);
    const audit = (await s.api('GET', `/audit?entityType=data_element&entityId=${e.id}`)) as
      { items?: { action: string; details?: unknown }[] } | { action: string }[];
    expect((Array.isArray(audit) ? audit : (audit.items ?? [])).map((a) => a.action)).toContain('dataelement.converted');
    expect(await fail(dana('POST', `/data-elements/${e.id}/convert`, { kind: 'kafka.topic', platformId: kafka }))).toMatchObject({
      params: { context: 'notGeneric' },
    });
  });

  it('a new qualified name takes the OpenLineage dataset of the platform’s address; the same name keeps the one entered', async () => {
    // renamed: the dataset the Kafka platform's bootstrap server gives (as discovery would), never the old name
    const a = await dana('POST', '/data-elements', {
      kind: 'generic.stream',
      qualifiedName: 'invented.ol.rename',
      environment: 'prod',
      technology: 'kafka',
      namespace: 'kafka://invented-broker:9092',
    });
    const ca = await dana('POST', `/data-elements/${a.id}/convert`, { kind: 'kafka.topic', platformId: kafka, qualifiedName: 'invented.ol.renamed' });
    expect(ca).toMatchObject({ qualifiedName: 'invented.ol.renamed', olNamespace: 'kafka://kafka.demo.invalid:9092', olName: 'invented.ol.renamed' });
    // the same name: the dataset entered stays (OpenLineage events keep matching it)
    const b = await dana('POST', '/data-elements', {
      kind: 'generic.stream',
      qualifiedName: 'invented.ol.same',
      environment: 'prod',
      technology: 'kafka',
      namespace: 'kafka://invented-broker:9092',
    });
    const cb = await dana('POST', `/data-elements/${b.id}/convert`, { kind: 'kafka.topic', platformId: kafka });
    expect(cb).toMatchObject({ qualifiedName: 'invented.ol.same', olNamespace: 'kafka://invented-broker:9092', olName: 'invented.ol.same' });
  });
});

describe('the OpenLineage export', () => {
  const dir = path.resolve(__dirname, 'fixtures/openlineage');
  const schema = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Record<string, unknown>;
  const steward = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../docs/data-products/steward-openlineage-facets.json'), 'utf8')) as Record<
    string,
    unknown
  >;

  function validator() {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    ajv.addFormat('uri', { type: 'string', validate: (v: string) => URL.canParse(v) });
    ajv.addFormat('date-time', { type: 'string', validate: (v: string) => !Number.isNaN(Date.parse(v)) });
    ajv.addFormat('uuid', true);
    for (const f of ['OpenLineage-2-0-2.json', 'JobTypeJobFacet-2-0-4.json', 'SchemaDatasetFacet-1-2-0.json']) ajv.addSchema(schema(f));
    ajv.addSchema(steward);
    return ajv;
  }

  /** Every event against the spec and each facet against its own schema (the spec checks only the base facet). */
  function check(events: Record<string, unknown>[]) {
    const ajv = validator();
    const base = 'https://openlineage.io/spec/2-0-2/OpenLineage.json';
    for (const e of events) {
      const def = 'job' in e ? 'JobEvent' : 'DatasetEvent';
      const ok = ajv.validate({ $ref: `${base}#/$defs/${def}` }, e);
      expect(ok, JSON.stringify(ajv.errors)).toBe(true);
      const job = (e.job as { facets?: Record<string, unknown> } | undefined)?.facets ?? {};
      if (job.jobType)
        expect(ajv.validate('https://openlineage.io/spec/facets/2-0-4/JobTypeJobFacet.json', { jobType: job.jobType }), JSON.stringify(ajv.errors)).toBe(true);
      if (job.steward_hiddenEnds)
        expect(ajv.validate(String(steward.$id), { steward_hiddenEnds: job.steward_hiddenEnds }), JSON.stringify(ajv.errors)).toBe(true);
      const ds = (e.dataset as { facets?: Record<string, unknown> } | undefined)?.facets ?? {};
      if (ds.schema)
        expect(ajv.validate('https://openlineage.io/spec/facets/1-2-0/SchemaDatasetFacet.json', { schema: ds.schema }), JSON.stringify(ajv.errors)).toBe(true);
    }
  }

  it('writes JSON Lines of dataset and job events that the spec and the push take', async () => {
    const r = await text(`/api/data-products/${orders}/openlineage?environment=prod`);
    expect(r.status).toBe(200);
    expect(r.type).toContain('application/x-ndjson');
    expect(r.disposition).toContain('orders.openlineage.jsonl');
    const events = r.body
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    check(events);
    const { parseOlEvent } = await import('../src/dataproducts/lineage/openlineage.js');
    for (const e of events) expect(() => parseOlEvent(e)).not.toThrow();
    const jobs = events.filter((e) => 'job' in e) as {
      job: { namespace: string; name: string; facets: Record<string, Record<string, unknown>> };
      inputs: unknown[];
      outputs: unknown[];
    }[];
    const capture = jobs.find((j) => j.job.name === 'Capture shop orders')!;
    expect(capture.job.namespace).toBe('steward://data-products/orders');
    expect(capture.job.facets.jobType).toMatchObject({ processingType: 'STREAMING', integration: 'DEBEZIUM', jobType: 'BRIDGE' });
    expect(capture.outputs).toEqual([{ namespace: expect.stringMatching(/^kafka:\/\//), name: 'shop.public.orders' }]);
    expect(jobs.find((j) => j.job.name === 'Stage orders')!.job.facets.jobType).toMatchObject({
      processingType: 'BATCH',
      integration: 'DBT',
      jobType: 'STAGE',
    });
    // a Node-RED flow of the demo: a tool runner with its technology (kept through the import)
    expect(jobs.find((j) => j.job.name === 'Forward returns')!.job.facets.jobType).toMatchObject({
      processingType: 'STREAMING',
      integration: 'NODE_RED',
      jobType: 'BRIDGE',
    });
    // the curated orders carry the schema of the contract their port is held to
    const curated = events.find((e) => (e.dataset as { name?: string } | undefined)?.name === 'SHOP.CURATED.ORDERS') as {
      dataset: { facets?: { schema?: { fields: { name: string }[] } } };
    };
    expect(curated.dataset.facets?.schema?.fields.length).toBeGreaterThan(0);
    // the generic part: its own namespace and name
    expect(events.map((e) => e.dataset)).toContainEqual({ namespace: 'https://returns.invented.example', name: 'returns-desk/returns' });
  });

  it('exports one step, on /api/v1 too, and counts the ends a reader may not see', async () => {
    const steps = (await dana('GET', `/data-products/${orders}/steps`)) as { id: string; name: string }[];
    const capture = steps.find((x) => x.name === 'Capture shop orders')!;
    const one = await text(`/api/data-products/${orders}/steps/${capture.id}/openlineage`);
    const lines = one.body.trim().split('\n');
    expect(lines.filter((l) => l.includes('"job"'))).toHaveLength(1);
    expect(one.disposition).toContain('orders-Capture-shop-orders.openlineage.jsonl');
    expect((await fail(dana('GET', `/data-products/${orders}/steps/dps_nope/openlineage`))).code).toBe('DATA_STEP_NOT_FOUND');
    // an input only another team sees: counted in the Steward facet, never named
    const other = (await s.api('POST', '/teams', { name: 'Ledger team', members: ['adam'] })).id;
    const team = (await s.api('POST', '/teams', { name: 'Orders readers', members: ['olivia'] })).id;
    await s.api('PUT', `/owning-teams/data_product/${orders}`, { teamIds: [team] });
    const hidden = await s.api('POST', '/data-elements', {
      kind: 'generic.dataset',
      qualifiedName: 'ledger.secret_rates',
      environment: 'prod',
      technology: 'postgresql',
      namespace: 'postgres://ledger.invented.example:5432',
    });
    await s.api('PUT', `/owning-teams/data_element/${hidden.id}`, { teamIds: [other] });
    const raw = (await s.api('GET', '/data-elements?prefix=SHOP.RAW.ORDERS_RAW&environment=prod')).items[0].id as string;
    await s.api('POST', `/data-products/${orders}/steps`, { name: 'Ledger rates', kind: 'transform', inputs: [hidden.id], outputs: [raw] });
    const asOlivia = await olivia('GET', `/data-products/${orders}/steps`);
    const ledger = (asOlivia as { id: string; name: string; hiddenInputs: number }[]).find((x) => x.name === 'Ledger rates')!;
    expect(ledger.hiddenInputs).toBe(1);
    for (const url of [`/api/data-products/${orders}/openlineage?step=${ledger.id}`, `/api/v1/data-products/${orders}/openlineage?step=${ledger.id}`]) {
      const r = await text(url, oliviaToken);
      expect(r.status).toBe(200);
      expect(r.body).not.toContain('secret_rates');
      expect(r.body).not.toContain(hidden.id);
      const job = JSON.parse(
        r.body
          .trim()
          .split('\n')
          .find((l) => l.includes('"job"'))!,
      ) as Record<string, unknown> & { job: { facets: Record<string, unknown> }; inputs: unknown[] };
      expect(job.job.facets.steward_hiddenEnds).toMatchObject({ inputs: 1, outputs: 0 });
      expect(job.inputs).toEqual([]);
      check([job]);
    }
    // the administrator sees it all
    expect((await text(`/api/data-products/${orders}/openlineage?step=${ledger.id}`)).body).toContain('ledger.secret_rates');
    // /api/v1 with a read token, as the internal export
    const v1 = await text(`/api/v1/data-products/${orders}/openlineage?step=${capture.id}`);
    expect(v1.status).toBe(200);
    expect(v1.type).toContain('application/x-ndjson');
    expect(
      v1.body
        .trim()
        .split('\n')
        .some((l) => l.includes('Capture shop orders')),
    ).toBe(true);
    // an unknown step: the step's 404, not the product's (the internal API answers DATA_STEP_NOT_FOUND)
    const noStep = await text(`/api/v1/data-products/${orders}/openlineage?step=dps_nope`);
    expect(noStep.status).toBe(404);
    expect(noStep.type).toContain('application/problem+json');
    expect(JSON.parse(noStep.body)).toMatchObject({ detail: 'Step dps_nope not found' });
    // a product the reader may not see: 404 on both
    expect((await text(`/api/v1/data-products/${orders}/openlineage`, (await vera('POST', '/me/tokens', { name: 'v', scope: 'read' })).token)).status).toBe(
      404,
    );
  });
});
