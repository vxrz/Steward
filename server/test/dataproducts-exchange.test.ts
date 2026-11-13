import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Exchange of data products, phase 2 (ADR 0036 parts 2, 14, 15, 16): import mode replace (a clear preview of what is
 * removed, never what the importer may not see, the step-up dataproduct.bulkChange above one removal), ODPS import
 * (round trip with the ODPS export), MCP proposals that wait for a person (never applied by the assistant), Git sync of
 * products and data objects, and the Ossie export of data objects (validated against the official schemas).
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
let s: TestServer;
let dana: Client;
let danaStrict: Client;
let vera: Client;

const fail = async (p: Promise<unknown>): Promise<{ status: number; code: string; params: Record<string, unknown> }> => {
  try {
    await p;
  } catch (e) {
    const err = e as { status: number; body?: { code?: string; params?: Record<string, unknown> } };
    return { status: err.status, code: err.body?.code ?? '', params: err.body?.params ?? {} };
  }
  throw new Error('expected a refusal');
};
const file = (content: unknown, name = 'products.yaml') => ({ name, content: typeof content === 'string' ? content : YAML.stringify(content) });
const el = (n: string) => ({ kind: 'other', qualified_name: n, environment: 'prod' });

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  await s.api('PUT', '/settings/modules/dataProducts', { enabled: true });
  dana = await s.as('dana', PW);
  danaStrict = await s.as('dana', PW, { autoStepUp: false });
  vera = await s.as('vera', PW);
}, 180_000);

/** An import of "inventory": a domain, two data objects, elements, two products with lists. */
const FULL = () => ({
  version: 1,
  domains: [{ key: 'inventory', name: 'Inventory' }],
  data_objects: [
    { key: 'stock-item', name: 'Stock item', domain: 'inventory', attributes: [{ name: 'item_id' }, { name: 'warehouse_id' }] },
    { key: 'warehouse', name: 'Warehouse', domain: 'inventory', attributes: [{ name: 'warehouse_id' }] },
  ],
  elements: [
    { ...el('INV.STOCK'), type_label: 'Extract' },
    { ...el('INV.MOVES'), type_label: 'Extract' },
    { ...el('INV.REPORT'), type_label: 'Report' },
  ],
  data_products: [
    {
      key: 'inv-stock',
      name: 'Stock',
      domain: 'inventory',
      members: [
        { element: el('INV.STOCK'), role: 'input' },
        { element: el('INV.MOVES'), role: 'internal' },
      ],
      ports: [
        { direction: 'output', name: 'stock', version: 'v1', type: 'other' },
        { direction: 'output', name: 'moves', version: 'v1', type: 'other' },
      ],
      steps: [
        { name: 'Load stock', kind: 'ingest', inputs: [el('INV.STOCK')], outputs: [el('INV.MOVES')] },
        { name: 'Report', kind: 'publish', inputs: [el('INV.MOVES')], outputs: [el('INV.STOCK')] },
      ],
    },
    { key: 'inv-report', name: 'Stock report', domain: 'inventory', members: [{ element: el('INV.REPORT'), role: 'output' }] },
  ],
});

describe('import mode replace', () => {
  it('keeps what an import brought in under its origin', async () => {
    const r = await dana('POST', '/data-products/import', { files: [file(FULL())], mode: 'update', origin: 'inventory-files' });
    expect(r.counts.add).toBeGreaterThan(0);
    const { db } = await import('../src/db.js');
    const kinds = db().all<{ kind: string; n: number }>(
      "SELECT kind, COUNT(*) AS n FROM dp_import_origins WHERE origin = 'inventory-files' GROUP BY kind ORDER BY kind",
    );
    expect(kinds).toEqual([
      { kind: 'dataObject', n: 2 },
      { kind: 'dataProduct', n: 2 },
      { kind: 'domain', n: 1 },
      { kind: 'element', n: 3 },
    ]);
    expect(await fail(dana('POST', '/data-products/import/preview', { files: [file(FULL())], mode: 'replace' }))).toMatchObject({ status: 400 });
  });

  it('previews what it removes – entries, list items – and never what the importer may not see', async () => {
    const { db } = await import('../src/db.js');
    // a product of the same origin that dana may not see: kept, counted, never named
    const team = (await s.api('POST', '/teams', { name: 'Inventory secret team' })).id;
    const hidden = await s.api('POST', '/data-products', { key: 'inv-secret', name: 'Secret stock' });
    db().run("INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('data_product', ?, ?, ?)", hidden.id, team, new Date().toISOString());
    db().run(
      "INSERT INTO dp_import_origins (origin, kind, item_id, recorded_at) VALUES ('inventory-files', 'dataProduct', ?, ?)",
      hidden.id,
      new Date().toISOString(),
    );
    const next = FULL();
    next.data_objects = next.data_objects.filter((o) => o.key !== 'warehouse');
    next.data_products = [{ ...next.data_products[0]!, members: [next.data_products[0]!.members[0]!], ports: [next.data_products[0]!.ports![0]!], steps: [] }];
    next.elements = next.elements.filter((e) => e.qualified_name !== 'INV.REPORT');
    const p = await dana('POST', '/data-products/import/preview', { files: [file(next)], mode: 'replace', origin: 'inventory-files' });
    expect(p.problems).toEqual([]);
    const removed = p.changes.filter((c: any) => c.action === 'remove').map((c: any) => `${c.kind}:${c.key}`);
    expect(removed).toEqual(expect.arrayContaining(['dataProduct:inv-report', 'dataObject:warehouse']));
    expect(removed.some((x: string) => x.includes('INV.REPORT'))).toBe(true);
    expect(JSON.stringify(p)).not.toContain('inv-secret');
    expect(p.counts).toMatchObject({ remove: 3, keptHidden: 1 });
    const stock = p.changes.find((c: any) => c.key === 'inv-stock');
    expect(stock.fields.filter((f: any) => f.after === 'removed').map((f: any) => f.field)).toEqual(
      expect.arrayContaining(['members[other inv.moves prod]', 'ports[output moves v1]', 'steps[load stock]', 'steps[report]']),
    );
    expect(p.counts.removedItems).toBe(4);
    expect(p.stepUp).toBe(true);
    expect(p.origin).toBe('inventory-files');
  });

  it('asks for the step-up above one removal, then removes in one transaction – the hidden product stays', async () => {
    const next = FULL();
    next.data_objects = next.data_objects.filter((o) => o.key !== 'warehouse');
    next.data_products = [{ ...next.data_products[0]!, members: [next.data_products[0]!.members[0]!], ports: [next.data_products[0]!.ports![0]!], steps: [] }];
    next.elements = next.elements.filter((e) => e.qualified_name !== 'INV.REPORT');
    const body = { files: [file(next)], mode: 'replace', origin: 'inventory-files' };
    await danaStrict('DELETE', '/auth/step-up').catch(() => undefined);
    expect(await fail(danaStrict('POST', '/data-products/import', body))).toMatchObject({ status: 403, code: 'STEP_UP_REQUIRED' });
    const r = await dana('POST', '/data-products/import', body);
    expect(r.counts).toMatchObject({ remove: 3, removedItems: 4, keptHidden: 1 });
    const { db } = await import('../src/db.js');
    expect(db().get("SELECT 1 FROM dp_products WHERE key = 'inv-report'")).toBeUndefined();
    expect(db().get("SELECT 1 FROM dp_objects WHERE key = 'warehouse'")).toBeUndefined();
    expect(db().get("SELECT 1 FROM dp_products WHERE key = 'inv-secret'")).toBeTruthy();
    const stock = db().get<{ id: string }>("SELECT id FROM dp_products WHERE key = 'inv-stock'")!;
    expect(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM dp_members WHERE product_id = ?', stock.id)!.n).toBe(1);
    expect(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM dp_ports WHERE product_id = ?', stock.id)!.n).toBe(1);
    const { productSteps } = await import('../src/dataproducts/steps.js');
    const { runAs } = await import('../src/auth/context.js');
    const { findUserByName, toAuthUser } = await import('../src/auth/users.js');
    expect(runAs(toAuthUser(findUserByName('dana')!), () => productSteps(stock.id))).toEqual([]);
    const audit = db().get<{ details: string }>("SELECT details FROM audit_log WHERE action = 'dataproduct.imported' ORDER BY seq DESC LIMIT 1")!;
    expect(JSON.parse(audit.details)).toMatchObject({ mode: 'replace', origin: 'inventory-files' });
    // imported again: nothing changes
    const again = await dana('POST', '/data-products/import/preview', body);
    expect(again.counts).toMatchObject({ add: 0, change: 0, remove: 0 });
  });
});

describe('ODPS import', () => {
  it('reads an ODPS export back unchanged (round trip)', async () => {
    const p = await dana('POST', '/data-products', {
      key: 'odps-round',
      name: 'ODPS round trip',
      description: 'Usage text',
      purpose: 'Purpose text',
      type: 'aggregate',
      criticality: 'high',
      tier: 2,
      version: '1.4',
      tags: ['odps'],
      owners: ['user:dana'],
      externalRefs: [{ label: 'Wiki', url: 'https://wiki.example/odps' }],
    });
    await dana('PUT', `/data-products/${p.id}/environments/prod`, { state: 'available' });
    await dana('POST', `/data-products/${p.id}/ports`, { direction: 'output', name: 'facts', version: 'v3', type: 'table', description: 'The facts' });
    const odps = (await dana('GET', `/data-products/${p.id}/odps`)) as string;
    expect(odps).toContain('kind: DataProduct');
    const pre = await dana('POST', '/data-products/import/preview', { files: [file(odps, 'round.odps.yaml')], mode: 'update' });
    expect(pre.problems).toEqual([]);
    expect(pre.odps).toBe(1);
    expect(pre.counts).toMatchObject({ add: 0, change: 0, unchanged: 1 });
  });

  it('creates a product with its ports from an ODPS document; refuses an invalid one', async () => {
    const doc = {
      apiVersion: 'v1.0.0',
      kind: 'DataProduct',
      id: 'odps-new',
      name: 'From ODPS',
      status: 'draft',
      description: { purpose: 'Shared stock figures', usage: 'Daily', limitations: 'No history' },
      tags: ['inventory'],
      outputPorts: [{ name: 'figures', version: 'v1', type: 'table', description: 'Figures' }],
      inputPorts: [{ name: 'raw', version: 'v1', contractId: 'no-such-contract' }],
    };
    const pre = await dana('POST', '/data-products/import/preview', { files: [file(doc, 'new.odps.yaml')], mode: 'add' });
    expect(pre.problems).toEqual([]);
    expect(pre.counts.add).toBe(1);
    await dana('POST', '/data-products/import', { files: [file(doc, 'new.odps.yaml')], mode: 'add', fingerprint: pre.fingerprint });
    const list = await dana('GET', '/data-products?q=odps-new');
    const got = await dana('GET', `/data-products/${list.items[0].id}`);
    expect(got).toMatchObject({ key: 'odps-new', name: 'From ODPS', lifecycle: 'draft', purpose: 'Shared stock figures' });
    expect(got.description).toContain('Limitations: No history');
    const ports = await dana('GET', `/data-products/${got.id}/ports`);
    expect(ports.map((x: any) => `${x.direction} ${x.name}`).sort()).toEqual(['input raw', 'output figures']);
    const bad = await dana('POST', '/data-products/import/preview', {
      files: [file({ apiVersion: 'v1.0.0', kind: 'DataProduct', id: 'x' }, 'bad.yaml')],
      mode: 'add',
    });
    expect(bad.problems.length).toBeGreaterThan(0);
    expect(bad.problems[0].path).toBe('(ODPS)');
  });
});

describe('MCP proposals', () => {
  let token = '';
  let id = 1;
  const call = async (name: string, args: Record<string, unknown>) => {
    const MODERN = '2026-07-28';
    const res = await fetch(`${s.base}/api/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
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
  const proposal = {
    version: 1,
    elements: [{ ...el('PROP.SOURCE'), type_label: 'Extract' }],
    data_products: [
      {
        key: 'proposed-product',
        name: 'Proposed product',
        members: [{ element: el('PROP.SOURCE'), role: 'input' }],
        ports: [{ direction: 'output', name: 'out', version: 'v1', type: 'other' }],
        steps: [],
      },
    ],
  };

  it('the format and the proposal tool; nothing is written when it is proposed', async () => {
    await s.api('PUT', '/mcp-server', { enabled: true });
    token = (await dana('POST', '/me/tokens', { name: 'mcp-dp-prop', scope: 'mcp' })).token as string;
    const f = await call('get_data_products_format', {});
    expect(f.structuredContent.schema).toBeTruthy();
    const r = await call('propose_data_product_changes', { title: 'A proposed product', rationale: 'From the warehouse schema', document: proposal });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ status: 'pending' });
    const { db } = await import('../src/db.js');
    expect(db().get("SELECT 1 FROM dp_products WHERE key = 'proposed-product'")).toBeUndefined();
    expect(db().get("SELECT 1 FROM dp_elements WHERE qualified_name = 'PROP.SOURCE'")).toBeUndefined();
  });

  it('refuses credentials and retiring, and a document that would not apply', async () => {
    const secret = await call('propose_data_product_changes', {
      title: 'Secret',
      rationale: 'With a password',
      document: { ...proposal, data_products: [{ ...proposal.data_products[0], key: 'p-secret', support: { url: 'https://user:pw@wiki.example/x' } }] },
    });
    expect(secret.isError).toBe(true);
    expect(secret.content[0]!.text).toContain('credential');
    const retire = await call('propose_data_product_changes', {
      title: 'Retire',
      rationale: 'Retire a product',
      document: { version: 1, data_products: [{ key: 'inv-stock', name: 'Stock', lifecycle: 'retired' }] },
    });
    expect(retire.isError).toBe(true);
    const unknown = await call('propose_data_product_changes', {
      title: 'Unknown element',
      rationale: 'Names an unknown element',
      document: { version: 1, data_products: [{ key: 'p-unknown', name: 'Unknown', members: [{ element: el('NOT.THERE') }] }] },
    });
    expect(unknown.isError).toBe(true);
  });

  it('waits in the AI requests for a person, who applies it as themselves', async () => {
    const list = (await dana('GET', '/mcp-requests?scope=mine')) as any[];
    const req = list.find((x) => x.kind === 'dataProducts' && x.proposalSummary?.title === 'A proposed product');
    expect(req).toMatchObject({ status: 'pending', mode: 'review', proposalSummary: { type: 'dataProducts', added: 2, changed: 0 } });
    const detail = await dana('GET', `/mcp-requests/${req.id}`);
    expect(detail.proposal).toMatchObject({ type: 'dataProducts', changedSince: false, hidden: 0 });
    expect(detail.proposal.proposed.changes.map((c: any) => c.key)).toEqual(expect.arrayContaining(['proposed-product']));
    expect(detail.proposal.now.ok).toBe(true);
    // a viewer may read the module but not create products: the preview as them refuses it, nothing is applied
    const asViewer = await fail(vera('POST', `/mcp-requests/${req.id}/decision`, { approve: true }));
    expect(asViewer.status).toBeGreaterThanOrEqual(400);
    const { db } = await import('../src/db.js');
    expect(db().get("SELECT 1 FROM dp_products WHERE key = 'proposed-product'")).toBeUndefined();
    const done = await dana('POST', `/mcp-requests/${req.id}/decision`, { approve: true, comment: 'Looks right' });
    expect(done).toMatchObject({ status: 'done', resultBody: { add: 2, change: 0 } });
    expect(db().get("SELECT 1 FROM dp_products WHERE key = 'proposed-product'")).toBeTruthy();
    const actions = db()
      .all<{ action: string }>("SELECT action FROM audit_log WHERE action LIKE 'dataproduct.proposal_%' ORDER BY seq")
      .map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['dataproduct.proposal_created', 'dataproduct.proposal_applied']));
  });

  it('comes in parts, nobody accepts it before the last one', async () => {
    const first = await call('propose_data_product_changes', {
      title: 'In parts',
      rationale: 'A dbt manifest',
      more: true,
      document: { version: 1, elements: [{ ...el('PARTS.A'), type_label: 'Model' }] },
    });
    expect(first.isError).toBeFalsy();
    const rid = first.structuredContent.requestId;
    const mid = await dana('GET', `/mcp-requests/${rid}`);
    expect(mid.canApprove).toBe(false);
    const last = await call('propose_data_product_changes', {
      proposalId: rid,
      document: { version: 1, data_products: [{ key: 'parts-product', name: 'Parts', members: [{ element: el('PARTS.A'), role: 'output' }] }] },
    });
    expect(last.isError).toBeFalsy();
    const ready = await dana('GET', `/mcp-requests/${rid}`);
    expect(ready.canApprove).toBe(true);
    expect(ready.proposal.parts).toBe(2);
    await dana('POST', `/mcp-requests/${rid}/decision`, { approve: false, comment: 'Not now' });
    const { db } = await import('../src/db.js');
    expect(db().get("SELECT 1 FROM dp_products WHERE key = 'parts-product'")).toBeUndefined();
  });
});

describe('Git sync of products and data objects', () => {
  it('classifies and checks files of the module’s format, one entry per file', async () => {
    const { parseFile } = await import('../src/sync/items.js');
    const { SYNC_KINDS } = await import('@sm/shared');
    const product = YAML.stringify({
      version: 1,
      data_product: { key: 'git-product', name: 'From Git', members: [{ element: el('INV.STOCK'), role: 'input' }] },
    });
    const r = await parseFile('products/git-product.yaml', product, [...SYNC_KINDS]);
    expect(r).toMatchObject({ ok: true, item: { kind: 'dataProduct', identity: 'git-product', name: 'From Git' } });
    const obj = await parseFile('objects/supplier.yaml', `kind: dataObject\nversion: 1\ndata_object:\n  key: supplier\n  name: Supplier\n`, [...SYNC_KINDS]);
    expect(obj).toMatchObject({ ok: true, item: { kind: 'dataObject', identity: 'supplier' } });
    const bad = await parseFile('products/bad.yaml', YAML.stringify({ version: 1, data_product: { key: 'Bad Key', name: 'x' } }), [...SYNC_KINDS]);
    expect(bad.ok).toBe(false);
    const notSynced = await parseFile('products/x.yaml', product, ['process']);
    expect(notSynced.ok).toBe(false);
  });

  it('applies an accepted file as the reviewer: the definition from the repository, lists included', async () => {
    const { applyItem, canDecide, findLocal, localHash } = await import('../src/sync/items.js');
    const { runAs } = await import('../src/auth/context.js');
    const { findUserByName, toAuthUser } = await import('../src/auth/users.js');
    const u = toAuthUser(findUserByName('dana')!);
    const v1 = {
      text: JSON.stringify({
        version: 1,
        data_product: {
          key: 'git-product',
          name: 'From Git',
          members: [{ element: el('INV.STOCK'), role: 'input' }],
          ports: [
            { direction: 'output', name: 'a', version: 'v1' },
            { direction: 'output', name: 'b', version: 'v1' },
          ],
        },
      }),
    };
    const created = await runAs(u, () => {
      expect(canDecide('dataProduct', null)).toBe(true);
      return applyItem('dataProduct', v1, null, { identity: 'git-product', comment: 'From Git', sourceId: 'gsr_test' });
    });
    const { db } = await import('../src/db.js');
    expect(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM dp_ports WHERE product_id = ?', created.entityId)!.n).toBe(2);
    expect(db().get("SELECT 1 FROM dp_import_origins WHERE origin = 'git:gsr_test' AND item_id = ?", created.entityId)).toBeTruthy();
    const before = localHash('dataProduct', created.entityId);
    // the repository drops port b: accepting the update removes it
    const v2 = {
      text: JSON.stringify({
        version: 1,
        data_product: {
          key: 'git-product',
          name: 'From Git',
          members: [{ element: el('INV.STOCK'), role: 'input' }],
          ports: [{ direction: 'output', name: 'a', version: 'v1' }],
        },
      }),
    };
    await runAs(u, () => applyItem('dataProduct', v2, created.entityId, { identity: 'git-product', comment: 'From Git', sourceId: 'gsr_test' }));
    expect(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM dp_ports WHERE product_id = ?', created.entityId)!.n).toBe(1);
    expect(localHash('dataProduct', created.entityId)).not.toBe(before);
    expect(findLocal('dataProduct', 'git-product')).toMatchObject({ id: created.entityId });
    // who may not change products decides nothing
    const viewer = toAuthUser(findUserByName('vera')!);
    expect(runAs(viewer, () => canDecide('dataProduct', created.entityId))).toBe(false);
  });
});

describe('the Ossie export of data objects', () => {
  const schema = (v: string) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'ossie', `ossie-${v}.schema.json`), 'utf8'));
  it('validates against both Ossie revisions, with key attributes as fields and relationships between objects', async () => {
    await dana('POST', '/data-products/import', {
      files: [
        file({
          version: 1,
          data_objects: [
            {
              key: 'warehouse',
              name: 'Warehouse',
              synonyms: ['depot'],
              definition: 'A place that keeps stock.',
              attributes: [{ name: 'warehouse_id', description: 'Key' }],
            },
            { key: 'ossie-hidden', name: 'Hidden object', attributes: [{ name: 'id' }] },
          ],
        }),
      ],
      mode: 'update',
    });
    const { db } = await import('../src/db.js');
    const team = (await s.api('POST', '/teams', { name: 'Ossie secret team' })).id;
    const hidden = db().get<{ id: string }>("SELECT id FROM dp_objects WHERE key = 'ossie-hidden'")!;
    db().run("INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('data_object', ?, ?, ?)", hidden.id, team, new Date().toISOString());
    const token = (await dana('POST', '/me/tokens', { name: 'ossie-dp', scope: 'read' })).token as string;
    for (const version of ['0.1.1', '0.2.0.dev0']) {
      const res = await fetch(`${s.base}/api/v1/data-objects/semantic-model?version=${version}`, { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      const doc = await res.json();
      const ajv = new Ajv2020({ allErrors: true, strict: false });
      const validate = ajv.compile(schema(version));
      expect(validate(doc), ajv.errorsText(validate.errors)).toBe(true);
      const model = doc.semantic_model ? doc.semantic_model[0] : doc;
      const names = model.datasets.map((d: any) => d.name);
      expect(names).toEqual(expect.arrayContaining(['stock_item', 'warehouse']));
      expect(names).not.toContain('ossie_hidden');
      expect(JSON.stringify(doc)).not.toContain('Hidden object');
      const wh = model.datasets.find((d: any) => d.name === 'warehouse');
      expect(wh.primary_key).toEqual(['warehouse_id']);
      expect(wh.ai_context.synonyms).toEqual(expect.arrayContaining(['Warehouse', 'depot']));
      expect(model.relationships).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ from: 'stock_item', to: 'warehouse', from_columns: ['warehouse_id'], to_columns: ['warehouse_id'] }),
        ]),
      );
    }
    // the download of the app
    const y = (await dana('GET', '/data-objects/semantic-model?format=yaml')) as string;
    expect(YAML.parse(y).version).toBe('0.1.1');
  });
});
