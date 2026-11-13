import { beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Data products phase 3, package D (0.25.0, ADR 0037 parts 4 and 6): semantic models as governed records – versions
 * stored as written (who, when, SHA-256), the lint against the official Ossie schema that never blocks saving, drift
 * findings on read, the draft from the bound contracts and data objects (never metrics), the sign-off with four eyes
 * and "which model was valid on a date", the export with an environment rewrite, the ODPS link, /api/v1 and MCP, and
 * proposals; previews – contract examples and linked recorded responses, the Kafka peek on topic elements masking the
 * contract's personal fields (session only, never over MCP); the GDPR Art. 30 details (e) and (g) and the limit that
 * counts only what the reader may see.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
let s: TestServer;
let dana: Client;
let vera: Client;
let adam: Client;
let snowflake = '';
let kafka = '';
let product = '';
let port = '';
let table = '';
let devTable = '';
let topic = '';
let contract = '';
let hidden = '';
let secretTeam = '';

const fail = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return { status: (e as { status: number }).status, ...((e as { body: Record<string, unknown> }).body ?? {}) };
  }
  throw new Error('expected the call to fail');
};
const element = (qualifiedName: string, environment: string, kind = 'snowflake.table', platformId = snowflake) =>
  dana('POST', '/data-elements', { platformId, kind, qualifiedName, environment }).then((r: { id: string }) => r.id);

const CONTRACT = `apiVersion: v3.0.2
kind: DataContract
id: sem-orders
name: Semantic orders
version: 1.0.0
status: active
schema:
  - name: orders
    physicalName: SEM.SALES.ORDERS
    properties:
      - { name: id, logicalType: integer, primaryKey: true, examples: [1001, 1002] }
      - { name: customer_id, logicalType: integer, examples: [7] }
      - name: customer_email
        logicalType: string
        examples: [erika@example.com]
        customProperties: [{ property: personalData, value: true }]
      - { name: total, logicalType: number, examples: [42.5] }
      - { name: ordered_at, logicalType: timestamp }
`;

const MODEL = `version: 0.1.1
semantic_model:
  - name: orders
    datasets:
      - name: orders
        source: SEM.SALES.ORDERS
        fields:
          - { name: id, expression: { dialects: [{ dialect: ANSI_SQL, expression: '"id"' }] } }
          - { name: customer_email, expression: { dialects: [{ dialect: ANSI_SQL, expression: '"customer_email"' }] } }
          - { name: discount, expression: { dialects: [{ dialect: ANSI_SQL, expression: '"discount"' }] } }
      - name: elsewhere
        source: OTHER.SCHEMA.TABLE
    metrics:
      - name: revenue
        expression: { dialects: [{ dialect: ANSI_SQL, expression: SUM(orders.total) }] }
      - name: margin
        expression: { dialects: [{ dialect: ANSI_SQL, expression: SUM(nowhere.amount) }] }
`;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  await s.api('PUT', '/settings/modules/dataProducts', { enabled: true });
  dana = await s.as('dana', PW);
  vera = await s.as('vera', PW);
  adam = await s.as('adam', PW);
  const platforms = (await s.api('GET', '/platforms')) as { id: string; kind: string; name: string }[];
  snowflake = platforms.find((p) => p.kind === 'snowflake')!.id;
  kafka = platforms.find((p) => p.kind === 'kafka')!.id;
  contract = (await dana('POST', '/data-contracts', { yaml: CONTRACT })).id;
  product = (
    await dana('POST', '/data-products', { key: 'sem-orders', name: 'Semantic orders', purpose: 'Orders for the semantic layer', owners: ['user:dana'] })
  ).id;
  port = (await dana('POST', `/data-products/${product}/ports`, { direction: 'output', name: 'orders', type: 'table', version: 'v1' })).id;
  table = await element('SEM.SALES.ORDERS', 'prod');
  devTable = await element('SEM_DEV.SALES.ORDERS', 'dev');
  topic = await element('sem.orders.v1', 'prod', 'kafka.topic', kafka);
  await dana('PUT', `/data-products/${product}/ports/${port}/bindings/prod`, { elementIds: [table, topic], contractId: contract });
  await dana('PUT', `/data-products/${product}/ports/${port}/bindings/dev`, { elementIds: [devTable] });
  // a product only a secret team sees
  hidden = (await s.api('POST', '/data-products', { key: 'sem-secret', name: 'Secret semantic' })).id;
  secretTeam = (await s.api('POST', '/teams', { name: 'Invented semantic team', members: ['adam'] })).id;
  const { db } = await import('../src/db.js');
  db().run(
    "INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('data_product', ?, ?, ?)",
    hidden,
    secretTeam,
    new Date().toISOString(),
  );
}, 180_000);

describe('semantic models', () => {
  it('stores every save as a version as written; the lint never blocks saving; the same text saves nothing', async () => {
    expect((await dana('GET', `/data-products/${product}/semantic-model`)).current).toBeNull();
    const v1 = await dana('POST', `/data-products/${product}/semantic-model/versions`, { document: MODEL, note: 'First copy' });
    expect(v1).toMatchObject({
      created: true,
      version: { version: 1, format: 'yaml', ossieVersion: '0.1.1', createdBy: 'dana', lintFindings: 0, signOff: null },
    });
    const { createHash } = await import('node:crypto');
    expect(v1.version.sha256).toBe(createHash('sha256').update(MODEL).digest('hex'));
    // the same text again: no new version
    expect(await dana('POST', `/data-products/${product}/semantic-model/versions`, { document: MODEL })).toMatchObject({ created: false });
    // a document against the schema is saved too, with its findings
    const bad = '{"version": "0.1.1", "semantic_model": [{"name": "x", "datasets": [], "colour": "red"}]}';
    const v2 = await dana('POST', `/data-products/${product}/semantic-model/versions`, { document: bad });
    expect(v2.created).toBe(true);
    expect(v2.version).toMatchObject({ version: 2, format: 'json' });
    expect(v2.lint.findings.map((f: { kind: string }) => f.kind)).toEqual(expect.arrayContaining(['schema']));
    const stored = await dana('GET', `/data-products/${product}/semantic-model/versions/2`);
    expect(stored.document).toBe(bad);
    expect(stored.lint.revision).toBe('0.1.1');
    // an unknown revision is linted against 0.1.1 and says so; text that does not parse is kept as written
    const odd = await dana('POST', `/data-products/${product}/semantic-model/versions`, { document: 'version: 9.9\nsemantic_model: []\n' });
    expect(odd.lint.findings[0]).toMatchObject({ kind: 'version', severity: 'warning' });
    const broken = await dana('POST', `/data-products/${product}/semantic-model/versions`, { document: 'a: [unclosed' });
    expect(broken.lint.findings[0]).toMatchObject({ kind: 'parse' });
    // back to the good model: version 5
    expect((await dana('POST', `/data-products/${product}/semantic-model/versions`, { document: MODEL, note: 'Back' })).version.version).toBe(5);
    // viewers read but do not save
    expect(await fail(vera('POST', `/data-products/${product}/semantic-model/versions`, { document: MODEL }))).toMatchObject({ status: 403 });
    const view = await vera('GET', `/data-products/${product}/semantic-model`);
    expect(view).toMatchObject({ mayEdit: false, maySignOff: false, current: { version: 5 } });
    expect(view.versions.map((v: { version: number }) => v.version)).toEqual([5, 4, 3, 2, 1]);
    const audit = (await s.api('GET', `/audit?action=dataproduct.semantic_model_saved&entityId=${product}&limit=10`)) as { details: { sha256: string } }[];
    expect(audit).toHaveLength(5);
  });

  it('finds drift on read: unbound sources, columns not in the contract, personal fields without a note, unknown metric names', async () => {
    const v = await dana('GET', `/data-products/${product}/semantic-model/versions/5`);
    const kinds = v.drift.findings.map((f: { kind: string; params: Record<string, string> }) => `${f.kind}:${f.params.field ?? f.params.dataset ?? ''}`);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'sourceNotBound:elsewhere',
        'columnMissing:discount',
        'personalNoAiContext:customer_email',
        'metricUnknownField:total',
        'metricUnknownDataset:nowhere',
      ]),
    );
    expect(v.drift).toMatchObject({ hiddenContracts: 0, datasetsChecked: 1 });
    // a contract the reader may not see is not used – counted
    const { db } = await import('../src/db.js');
    db().run(
      "INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('contract', ?, ?, ?)",
      contract,
      secretTeam,
      new Date().toISOString(),
    );
    const asVera = await vera('GET', `/data-products/${product}/semantic-model/versions/5`);
    expect(asVera.drift.hiddenContracts).toBe(1);
    expect(asVera.drift.findings.some((f: { kind: string }) => f.kind === 'columnMissing' || f.kind === 'personalNoAiContext')).toBe(false);
    db().run("DELETE FROM resource_teams WHERE kind = 'contract' AND resource_id = ?", contract);
  });

  it('signs off with four eyes the version read; which model was valid on a date, and who approved it', async () => {
    const v5 = (await dana('GET', `/data-products/${product}/semantic-model`)).current;
    // who wrote it does not sign it off; nor does a viewer
    expect(await fail(dana('POST', `/data-products/${product}/semantic-model/versions/5/sign-off`, { sha256: v5.sha256 }))).toMatchObject({
      status: 409,
      code: 'DATA_SEMANTIC_SIGNOFF_INVALID',
      params: { context: 'ownVersion' },
    });
    expect(await fail(vera('POST', `/data-products/${product}/semantic-model/versions/5/sign-off`, { sha256: v5.sha256 }))).toMatchObject({ status: 403 });
    // an approver who sees it signs off – only the text they read
    expect(await fail(adam('POST', `/data-products/${product}/semantic-model/versions/5/sign-off`, { sha256: '0'.repeat(64) }))).toMatchObject({
      params: { context: 'changed' },
    });
    const view = await adam('POST', `/data-products/${product}/semantic-model/versions/5/sign-off`, { sha256: v5.sha256, note: 'Matches the contract' });
    const today = new Date().toISOString().slice(0, 10);
    expect(view.validToday).toMatchObject({ version: 5, signOff: { by: 'adam', validFrom: today, note: 'Matches the contract' } });
    expect(await fail(adam('POST', `/data-products/${product}/semantic-model/versions/5/sign-off`, { sha256: v5.sha256 }))).toMatchObject({
      params: { context: 'alreadySignedOff' },
    });
    // the history: version 1 signed off on 1 March, version 5 from today
    const { db } = await import('../src/db.js');
    const v1 = db().get<{ id: string; sha256: string }>('SELECT id, sha256 FROM dp_semantic_versions WHERE product_id = ? AND version = 1', product)!;
    db().run(
      "INSERT INTO dp_semantic_signoffs (id, product_id, version_id, version, sha256, valid_from, note, signed_by, signed_at) VALUES ('so-old', ?, ?, 1, ?, '2026-03-01', '', 'adam', '2026-03-01T10:00:00.000Z')",
      product,
      v1.id,
      v1.sha256,
    );
    db().run("UPDATE dp_semantic_versions SET created_at = '2026-02-20T09:00:00.000Z' WHERE product_id = ? AND version = 1", product);
    expect(await dana('GET', `/data-products/${product}/semantic-model/valid?date=2026-02-28`)).toMatchObject({ valid: null, latest: { version: 1 } });
    expect(await dana('GET', `/data-products/${product}/semantic-model/valid?date=2026-03-02`)).toMatchObject({
      valid: { version: 1, signOff: { by: 'adam', validFrom: '2026-03-01' } },
    });
    expect(await dana('GET', `/data-products/${product}/semantic-model/valid?date=${today}`)).toMatchObject({ valid: { version: 5 }, latest: { version: 5 } });
    const audit = (await s.api('GET', `/audit?action=dataproduct.semantic_model_signed_off&entityId=${product}&limit=10`)) as unknown[];
    expect(audit).toHaveLength(1);
  });

  it('exports as stored, or with the sources rewritten to another environment', async () => {
    const token = (await dana('POST', '/me/tokens', { name: 'sem-read', scope: 'read' })).token as string;
    const get = (url: string) => fetch(`${s.base}${url}`, { headers: { authorization: `Bearer ${token}` } });
    const r = await get(`/api/data-products/${product}/semantic-model/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/yaml');
    expect(r.headers.get('x-steward-semantic-version')).toBe('5');
    expect(await r.text()).toBe(MODEL);
    // the version valid on a day
    expect((await get(`/api/data-products/${product}/semantic-model/export?date=2026-03-02`)).headers.get('x-steward-semantic-version')).toBe('1');
    // dev: SEM.SALES.ORDERS is bound in prod; the discovery source's rules say SEM_DEV in dev
    const { db } = await import('../src/db.js');
    db().run(
      `INSERT INTO dp_discovery_sources (id, name, platform_id, scope, include_prefixes, exclude_prefixes, environment_rules, element_team_ids, interval_minutes, enabled, run_as, revision, created_at, created_by, updated_at, updated_by)
       VALUES ('sem-src', 'Semantic warehouse', ?, '[]', '[]', '[]', ?, '[]', 1440, 0, 'admin', 1, ?, 'admin', ?, 'admin')`,
      snowflake,
      JSON.stringify([{ match: 'suffix', value: '_DEV', environment: 'dev' }]),
      new Date().toISOString(),
      new Date().toISOString(),
    );
    const dev = await get(`/api/data-products/${product}/semantic-model/export?environment=dev`);
    const doc = YAML.parse(await dev.text());
    expect(doc.semantic_model[0].datasets[0].source).toBe('SEM_DEV.SALES.ORDERS');
    // a source of no element of the product stays and is counted
    expect(doc.semantic_model[0].datasets[1].source).toBe('OTHER.SCHEMA.TABLE');
    expect(dev.headers.get('x-steward-sources-not-rewritten')).toBe('1');
    // /api/v1: the document, the versions and which one was valid on a day
    const v1 = await get(`/api/v1/data-products/${product}/semantic-model`);
    expect(v1.status).toBe(200);
    expect(await v1.text()).toBe(MODEL);
    const versions = await (await get(`/api/v1/data-products/${product}/semantic-model/versions?date=2026-03-02`)).json();
    expect(versions.versions).toHaveLength(5);
    expect(versions.validOn).toMatchObject({ date: '2026-03-02', valid: { version: 1, signOff: { by: 'adam' } } });
    // a product the token owner may not see answers 404
    expect((await get(`/api/v1/data-products/${hidden}/semantic-model`)).status).toBe(404);
    expect(await fail(dana('GET', `/data-products/${hidden}/semantic-model`))).toMatchObject({ status: 404 });
    // the ODPS output port links the model (the version valid today)
    const odps = YAML.parse((await dana('GET', `/data-products/${product}/odps`)) as string);
    const custom = odps.outputPorts[0].customProperties.find((c: { property: string }) => c.property === 'semanticModel');
    expect(custom.value).toMatchObject({ version: 5, signedOffBy: 'adam' });
  });

  it('drafts from the bound contracts and data objects – with notes on personal fields, never with metrics', async () => {
    const object = (
      await dana('POST', '/data-objects', {
        key: 'sem-order',
        name: 'Semantic order',
        definition: 'A confirmed order',
        synonyms: ['purchase'],
        attributes: [{ name: 'id' }],
      })
    ).id;
    await dana('POST', `/data-objects/${object}/elements`, { elementId: table });
    const d = await dana('GET', `/data-products/${product}/semantic-model/draft?environment=prod`);
    expect(d).toMatchObject({ revision: '0.1.1', environment: 'prod', datasets: 2, dataObjects: 1, lint: { findings: [] } });
    const doc = YAML.parse(d.document);
    expect(doc.semantic_model[0].metrics).toBeUndefined();
    const orders = doc.semantic_model[0].datasets.find((x: { source: string }) => x.source === 'SEM.SALES.ORDERS');
    expect(orders).toMatchObject({ primary_key: ['id'], ai_context: { synonyms: ['Semantic order', 'purchase'] } });
    expect(orders.fields.find((f: { name: string }) => f.name === 'customer_email').ai_context.instructions).toContain('Personal data');
    // the dev revision too
    const dev = await dana('GET', `/data-products/${product}/semantic-model/draft?environment=prod&revision=0.2.0.dev0`);
    expect(dev.lint.findings).toEqual([]);
    expect(YAML.parse(dev.document).version).toBe('0.2.0.dev0');
    // nothing bound in an environment: nothing to start from
    expect(await fail(dana('GET', `/data-products/${product}/semantic-model/draft?environment=test`))).toMatchObject({
      status: 400,
      code: 'DATA_SEMANTIC_DRAFT_EMPTY',
    });
    // the draft saved as it is has no drift of its own
    const saved = await dana('POST', `/data-products/${product}/semantic-model/versions`, { document: d.document, origin: 'draft' });
    const v = await dana('GET', `/data-products/${product}/semantic-model/versions/${saved.version.version}`);
    expect(v.origin).toBe('draft');
    expect(v.drift.findings).toEqual([]);
  });
});

describe('semantic models over MCP', () => {
  let token = '';
  let id = 1;
  const call = async (name: string, args: Record<string, unknown>, bearer = token) => {
    const MODERN = '2026-07-28';
    const res = await fetch(`${s.base}/api/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': MODERN,
        'mcp-method': 'tools/call',
        'mcp-name': name,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: id++,
        method: 'tools/call',
        params: {
          name,
          arguments: args,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': MODERN,
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
          },
        },
      }),
    });
    const body = JSON.parse(await res.text());
    if (!body.result) throw new Error(JSON.stringify(body));
    return body.result as { isError?: boolean; structuredContent?: any; content: { text: string }[] };
  };

  it('reads the model with its sign-off; proposes a version a person applies; no peek over MCP', async () => {
    await s.api('PUT', '/mcp-server', { enabled: true });
    token = (await dana('POST', '/me/tokens', { name: 'mcp-sem', scope: 'mcp' })).token as string;
    const r = await call('get_product_semantic_model', { productId: 'sem-orders', version: 5 });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ version: { version: 5, signOff: { by: 'adam' } }, document: MODEL });
    expect(r.structuredContent.drift.findings).toBeGreaterThan(0);
    const hiddenRead = await call('get_product_semantic_model', { productId: 'sem-secret' });
    expect(hiddenRead.isError).toBe(true);
    // the tools offer no peek
    const MODERN = '2026-07-28';
    const list = await fetch(`${s.base}/api/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': MODERN,
        'mcp-method': 'tools/list',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: id++,
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': MODERN,
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
          },
        },
      }),
    });
    const names = (JSON.parse(await list.text()).result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toContain('get_product_semantic_model');
    expect(names.some((n) => /peek|message/i.test(n))).toBe(false);

    // a proposal of a semantic model only
    const next = MODEL.replace('name: discount', 'name: net_total').replaceAll('"discount"', '"total"');
    const unknown = await call('propose_data_product_changes', {
      title: 'Semantic model',
      rationale: 'From the dbt semantic layer',
      semanticModels: [{ product: 'no-such-product', document: next }],
    });
    expect(unknown.isError).toBe(true);
    const secret = await call('propose_data_product_changes', {
      title: 'Semantic model',
      rationale: 'With a password',
      semanticModels: [{ product: 'sem-orders', document: `${next}    custom_extensions: [{ vendor_name: COMMON, data: x }]\n    password: hunter2\n` }],
    });
    expect(secret.isError).toBe(true);
    const p = await call('propose_data_product_changes', {
      title: 'Semantic model',
      rationale: 'From the dbt semantic layer',
      semanticModels: [{ product: 'sem-orders', document: next, note: 'net_total instead of discount' }],
    });
    expect(p.isError).toBeFalsy();
    const rid = p.structuredContent.requestId;
    const detail = await adam('GET', `/mcp-requests/${rid}`);
    expect(detail.proposal.semanticModels).toEqual([
      expect.objectContaining({ product: expect.objectContaining({ key: 'sem-orders' }), unchanged: false, currentVersion: 6, document: next }),
    ]);
    // a viewer cannot apply it (they may not change the product); the approver may see but not change it either
    expect((await fail(vera('POST', `/mcp-requests/${rid}/decision`, { approve: true }))).status).toBeGreaterThanOrEqual(400);
    const { db } = await import('../src/db.js');
    expect(db().get('SELECT 1 FROM dp_semantic_versions WHERE product_id = ? AND version = 7', product)).toBeUndefined();
    const done = await s.api('POST', `/mcp-requests/${rid}/decision`, {
      approve: true,
      selection: { dataProducts: { fingerprint: detail.proposal.now.fingerprint } },
    });
    expect(done).toMatchObject({ status: 'done', resultBody: { semanticVersions: 1 } });
    const v7 = await dana('GET', `/data-products/${product}/semantic-model/versions/7`);
    expect(v7).toMatchObject({ origin: 'proposal', createdBy: 'admin', document: next });
    // whose assistant proposed it does not sign it off
    expect(await fail(dana('POST', `/data-products/${product}/semantic-model/versions/7/sign-off`, { sha256: v7.sha256 }))).toMatchObject({
      params: { context: 'ownVersion' },
    });
  });
});

describe('previews', () => {
  it('shows the bound contract’s examples on the port, with its personal fields marked', async () => {
    const p = await vera('GET', `/data-products/${product}/ports/${port}/preview?environment=prod`);
    expect(p).toMatchObject({ environment: 'prod', hiddenContract: false, recordings: [], hiddenRecordings: 0, mayLink: false });
    const props = p.examples.objects[0].properties;
    expect(props.map((x: { name: string }) => x.name)).toEqual(['id', 'customer_id', 'customer_email', 'total']);
    expect(props.find((x: { name: string }) => x.name === 'customer_email')).toMatchObject({ personal: true, examples: ['erika@example.com'] });
    expect(props[0].examples).toEqual(['1001', '1002']);
    // a contract the reader may not see: said, not shown
    const { db } = await import('../src/db.js');
    db().run(
      "INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('contract', ?, ?, ?)",
      contract,
      secretTeam,
      new Date().toISOString(),
    );
    expect(await vera('GET', `/data-products/${product}/ports/${port}/preview?environment=prod`)).toMatchObject({ examples: null, hiddenContract: true });
    db().run("DELETE FROM resource_teams WHERE kind = 'contract' AND resource_id = ?", contract);
  });

  it('links recorded responses to a port: masked, shown to who may use their platform', async () => {
    const platforms = (await s.api('GET', '/platforms')) as { id: string; kind: string; permissions: string[] }[];
    const http = platforms.find((p) => p.kind !== 'snowflake' && p.kind !== 'kafka')!;
    const rec = await s.api('POST', `/platforms/${http.id}/recordings`, {
      method: 'GET',
      path: '/orders/{id}',
      status: 200,
      body: { id: 1001, customer_email: 'erika@example.com', customer_id: 7, iban: 'DE02120300000000202051', total: 42.5 },
    });
    expect(await fail(vera('POST', `/data-products/${product}/ports/${port}/recordings`, { recordingId: rec.id }))).toMatchObject({ status: 403 });
    const p = await s.api('POST', `/data-products/${product}/ports/${port}/recordings`, { recordingId: rec.id, note: 'A typical answer' });
    expect(p.recordings).toHaveLength(1);
    const body = JSON.parse(p.recordings[0].body);
    expect(body).toMatchObject({ id: 1001, customer_id: 7, total: 42.5, customer_email: '***', iban: '***' });
    expect(await fail(s.api('POST', `/data-products/${product}/ports/${port}/recordings`, { recordingId: rec.id }))).toMatchObject({
      code: 'DATA_PORT_RECORDING_INVALID',
      params: { context: 'linked' },
    });
    // who may not use the platform sees it counted
    const asVera = await vera('GET', `/data-products/${product}/ports/${port}/preview?environment=prod`);
    const veraUses = (await vera('GET', '/platforms')).find((x: { id: string }) => x.id === http.id)?.permissions?.includes('use');
    if (!veraUses) expect(asVera).toMatchObject({ recordings: [], hiddenRecordings: 1 });
    await s.api('DELETE', `/data-products/${product}/ports/${port}/recordings/${rec.id}`);
    expect((await s.api('GET', `/data-products/${product}/ports/${port}/preview?environment=prod`)).recordings).toEqual([]);
    const audit = (await s.api('GET', `/audit?entityId=${product}&limit=50`)) as { action: string }[];
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['dataproduct.port_recording_linked', 'dataproduct.port_recording_unlinked']));
  });

  it('peeks at a topic element: managers of the platform, masked by the bound contract, audited without values', async () => {
    const { addKafkaMessages, addKafkaTopic } = await import('../src/mock/mockKafka.js');
    addKafkaTopic('sem.orders.v1', 1);
    addKafkaMessages('sem.orders.v1', [{ key: 'o-1', value: JSON.stringify({ id: 1001, customer_email: 'erika@example.com', loyalty: 'L-77', total: 42.5 }) }]);
    // the contract also marks a field the peek's own rules would show: loyalty
    const yaml = CONTRACT.replace('version: 1.0.0', 'version: 1.1.0').replace(
      '      - { name: ordered_at, logicalType: timestamp }',
      '      - { name: ordered_at, logicalType: timestamp }\n      - name: loyalty\n        logicalType: string\n        customProperties: [{ property: personalData, value: true }]',
    );
    await dana('POST', `/data-contracts/${contract}/versions`, { yaml });
    const r = await s.api('POST', `/data-elements/${topic}/peek`, { count: 5 });
    expect(r.messages).toHaveLength(1);
    const value = JSON.parse(r.messages[0].value);
    expect(value).toMatchObject({ id: 1001, total: 42.5, loyalty: '***', customer_email: '***' });
    // not a manager of the platform; not a topic
    expect(await fail(dana('POST', `/data-elements/${topic}/peek`, {}))).toMatchObject({ status: 403, code: 'KAFKA_PEEK_FORBIDDEN' });
    expect(await fail(s.api('POST', `/data-elements/${table}/peek`, {}))).toMatchObject({ status: 400, code: 'DATA_ELEMENT_PEEK_INVALID' });
    // session only: an API token is refused
    const token = (await s.api('POST', '/me/tokens', { name: 'sem-peek', scope: 'full' })).token as string;
    const viaToken = await fetch(`${s.base}/api/data-elements/${topic}/peek`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(viaToken.status).toBe(403);
    const audit = (await s.api('GET', `/audit?action=kafka.messages_read&limit=5`)) as { details: Record<string, unknown> }[];
    expect(audit[0].details).toMatchObject({ topic: 'sem.orders.v1', elementId: topic, count: 1 });
    expect(JSON.stringify(audit[0])).not.toContain('erika');
    expect(JSON.stringify(audit[0])).not.toContain('L-77');
  });
});

describe('records of processing: Art. 30(1)(e) and (g)', () => {
  it('keeps transfers and the measures’ reference on data objects and products, and shows them in the view and its exports', async () => {
    const object = (
      await dana('POST', '/data-objects', { key: 'ropa-member', name: 'Ropa member', personalData: 'personal', categories: ['contact'], subjects: ['members'] })
    ).id;
    await dana('POST', `/data-objects/${object}/elements`, { elementId: table });
    expect(await fail(vera('PUT', `/data-objects/${object}/ropa-details`, { transfers: [] }))).toMatchObject({ status: 403 });
    await dana('PUT', `/data-objects/${object}/ropa-details`, {
      transfers: [{ country: 'United States', recipient: 'Invented Cloud Inc.', safeguard: 'scc', note: 'Support tickets' }],
      toms: { kind: 'url', url: 'https://wiki.example/toms', label: 'Our measures' },
    });
    // a document of Steward as the product's measures – one a reader may not see is counted, never named
    const rec = await s.api('POST', '/records', { type: 'DOC', title: 'Invented measures of the orders platform' });
    await dana('PUT', `/data-products/${product}/ropa-details`, {
      transfers: [{ country: 'CH', safeguard: 'adequacy' }],
      toms: { kind: 'record', recordId: rec.number },
    });
    expect(await dana('GET', `/data-products/${product}/ropa-details`)).toMatchObject({
      transfers: [{ country: 'CH', safeguard: 'adequacy', recipient: '' }],
      toms: { kind: 'record', id: rec.id, number: rec.number },
      mayEdit: true,
    });
    expect(await fail(dana('PUT', `/data-products/${product}/ropa-details`, { toms: { kind: 'record', recordId: 'NOPE-1' } }))).toMatchObject({
      code: 'DATA_ROPA_DETAILS_INVALID',
    });
    const r = await dana('GET', '/data-products/records-of-processing?q=ropa member');
    expect(r).toMatchObject({ truncated: false, limit: 5000 });
    expect(r.items[0].transfers).toEqual([
      { country: 'United States', recipient: 'Invented Cloud Inc.', safeguard: 'scc', note: 'Support tickets', via: null },
      { country: 'CH', recipient: '', safeguard: 'adequacy', note: '', via: 'Semantic orders' },
    ]);
    expect(r.items[0].toms).toEqual([
      { label: 'Our measures', url: 'https://wiki.example/toms', via: null },
      { label: `${rec.number} Invented measures of the orders platform`, url: null, via: 'Semantic orders' },
    ]);
    const { db } = await import('../src/db.js');
    db().run("INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('record', ?, ?, ?)", rec.id, secretTeam, new Date().toISOString());
    const hiddenRec = await dana('GET', '/data-products/records-of-processing?q=ropa member');
    expect(hiddenRec.items[0]).toMatchObject({ hiddenToms: 1 });
    expect(JSON.stringify(hiddenRec)).not.toContain('Invented measures');
    expect(await dana('GET', `/data-products/${product}/ropa-details`)).toMatchObject({ toms: { kind: 'record', hidden: true } });
    const csv = (await dana('GET', '/data-products/records-of-processing.csv?q=ropa member&lang=en')) as string;
    expect(csv).toContain('Transfers to third countries (Art. 30(1)(e))');
    expect(csv).toContain('United States (Invented Cloud Inc.): standard contractual clauses (Art. 46(2)(c))');
    expect(csv).toContain('Technical and organisational measures (Art. 30(1)(g))');
    const de = (await dana('GET', '/data-products/records-of-processing.csv?q=ropa member&lang=de')) as string;
    expect(de).toContain('Standardvertragsklauseln');
    const pdf = (await dana('GET', '/data-products/records-of-processing.pdf?q=ropa member')) as string;
    expect(pdf.startsWith('%PDF')).toBe(true);
    const audit = (await s.api('GET', `/audit?action=dataobject.ropa_details_changed&entityId=${object}&limit=5`)) as unknown[];
    expect(audit).toHaveLength(1);
  });

  it('counts the limit among what the reader may see, and says when the list is cut', async () => {
    const { db } = await import('../src/db.js');
    const now = new Date().toISOString();
    const insert = (id: string, key: string) =>
      db().run(
        `INSERT INTO dp_objects (id, key, name, name_norm, personal_data, revision, created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, ?, ?, 'personal', 1, ?, 'admin', ?, 'admin')`,
        id,
        key,
        key,
        key,
        now,
        now,
      );
    // 5,001 objects of a secret team sort before what dana may see: the 0.24 view cut them first and showed her nothing
    db().tx(() => {
      for (let i = 0; i < 5001; i++) {
        const id = `ropa-hidden-${i}`;
        insert(id, `aaa-cut-${String(i).padStart(5, '0')}`);
        db().run("INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('data_object', ?, ?, ?)", id, secretTeam, now);
      }
      insert('ropa-visible', 'aaa-cut-zz-visible');
    });
    const asDana = await dana('GET', '/data-products/records-of-processing?q=aaa-cut');
    expect(asDana).toMatchObject({ truncated: false });
    expect(asDana.items.map((x: { object: { key: string } }) => x.object.key)).toEqual(['aaa-cut-zz-visible']);
    // the team's member sees all of them: cut at 5,000 – and told so, in the view and the CSV
    const asAdam = await adam('GET', '/data-products/records-of-processing?q=aaa-cut');
    expect(asAdam).toMatchObject({ truncated: true, limit: 5000 });
    expect(asAdam.items).toHaveLength(5000);
    const csv = (await adam('GET', '/data-products/records-of-processing.csv?q=aaa-cut&lang=en')) as string;
    expect(csv).toContain('The list is cut at 5,000 data objects');
  }, 120_000);
});
