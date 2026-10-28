import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Components and tech stack of applications (#103): components on the application (permissions follow it), the
 * stack per component from the endoflife.date list, SBOM imports (CycloneDX and SPDX, by upload or URL) that keep
 * only known products and never overwrite entries entered by hand, the process input type application, the audit
 * trail and the public API.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Demo-password-1';
let dana: Client, olivia: Client, vera: Client;
const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status: number }) => e.status,
  );
const code = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { body: unknown }) => ((typeof e.body === 'string' ? JSON.parse(e.body) : e.body) as { code?: string }).code,
  );
const audit = (id: string) => s.api('GET', `/audit?entityType=application&entityId=${id}&limit=50`);

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [dana, olivia, vera] = await Promise.all(['dana', 'olivia', 'vera'].map((u) => s.as(u, PW)));
});
afterAll(async () => {
  await s?.app.close();
});

const CYCLONEDX = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  metadata: { component: { type: 'container', name: 'ghcr.io/acme/orders', version: '1.4.0' } },
  components: [
    { type: 'operating-system', name: 'alpine', version: '3.20.3' },
    { type: 'application', name: 'node', version: '24.11.0', purl: 'pkg:generic/node@24.11.0' },
    // a library: endoflife.date does not know it, it stays out
    { type: 'library', name: 'left-pad', version: '1.3.0', purl: 'pkg:npm/left-pad@1.3.0' },
    // a library named like a database: matched by its package URL only, never by name
    { type: 'library', name: 'redis', version: '4.7.0', purl: 'pkg:npm/redis@4.7.0' },
    {
      type: 'framework',
      name: 'react',
      version: '18.3.1',
      purl: 'pkg:npm/react@18.3.1',
      components: [{ type: 'library', name: 'pg', version: '16.4', cpe: 'cpe:2.3:a:postgresql:postgresql:16.4:*:*:*:*:*:*:*' }],
    },
  ],
};

const SPDX = {
  spdxVersion: 'SPDX-2.3',
  name: 'orders-image',
  packages: [
    { name: 'debian', versionInfo: '12', primaryPackagePurpose: 'OPERATING-SYSTEM' },
    {
      name: 'python3.11',
      versionInfo: '3.11.2',
      externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: 'pkg:generic/python@3.11.2' }],
    },
    {
      name: 'requests',
      versionInfo: '2.32.3',
      externalRefs: [{ referenceCategory: 'PACKAGE_MANAGER', referenceType: 'purl', referenceLocator: 'pkg:pypi/requests@2.32.3' }],
    },
  ],
};

describe('components', () => {
  let app: any;
  let image: any;
  it('owners and designers add components; everyone reads them; others may not change them', async () => {
    app = await dana('POST', '/applications', { name: 'Orders', owners: ['user:olivia'] });
    expect(app).toMatchObject({ components: [], stack: [], componentCount: 0 });
    expect(await status(vera('POST', `/applications/${app.id}/components`, { type: 'kafka-topic', name: 'orders.v1' }))).toBe(403);
    await olivia('POST', `/applications/${app.id}/components`, { type: 'kafka-topic', name: 'orders.v1' });
    await olivia('POST', `/applications/${app.id}/components`, { type: 'kafka-topic', name: 'orders.dlq', note: 'dead letters' });
    const a = await dana('POST', `/applications/${app.id}/components`, {
      type: 'container-image',
      name: 'ghcr.io/acme/orders',
      url: 'https://github.com/acme/orders/pkgs/container/orders',
      stack: [{ product: 'nodejs', version: '22' }],
    });
    expect(a.componentCount).toBe(3);
    // by type (as listed), then name
    expect(a.components.map((c: any) => `${c.type}:${c.name}`)).toEqual([
      'container-image:ghcr.io/acme/orders',
      'kafka-topic:orders.dlq',
      'kafka-topic:orders.v1',
    ]);
    image = a.components[0];
    expect(image.stack).toEqual([expect.objectContaining({ product: 'nodejs', label: 'Node.js', version: '22', source: 'manual', setBy: 'dana' })]);
    expect(a.stack).toEqual([
      // no end-of-life data before the first refresh (#104)
      {
        product: 'nodejs',
        label: 'Node.js',
        version: '22',
        lifecycle: null,
        components: [{ id: image.id, name: 'ghcr.io/acme/orders', type: 'container-image' }],
      },
    ]);
    // readers see them, without the right to edit
    const seen = await vera('GET', `/applications/${app.id}`);
    expect(seen.components).toHaveLength(3);
    expect((await vera('GET', '/applications')).find((x: any) => x.id === app.id).componentCount).toBe(3);
    expect(await status(vera('DELETE', `/applications/${app.id}/components/${image.id}`))).toBe(403);
  });

  it('checks names, types, products and limits', async () => {
    expect(await code(olivia('POST', `/applications/${app.id}/components`, { type: 'kafka-topic', name: 'ORDERS.V1' }))).toBe('COMPONENT_EXISTS');
    // the same name as another type is fine
    await olivia('POST', `/applications/${app.id}/components`, { type: 'repository', name: 'orders.v1' });
    expect(await status(olivia('POST', `/applications/${app.id}/components`, { type: 'database', name: 'x' }))).toBe(400);
    expect(await status(olivia('POST', `/applications/${app.id}/components`, { type: 'other', name: '' }))).toBe(400);
    expect(await status(olivia('POST', `/applications/${app.id}/components`, { type: 'other', name: 'x', url: 'javascript:alert(1)' }))).toBe(400);
    expect(await code(olivia('POST', `/applications/${app.id}/components`, { type: 'other', name: 'x', stack: [{ product: 'left-pad', version: '1' }] }))).toBe(
      'STACK_PRODUCT_UNKNOWN',
    );
    expect(
      await code(
        olivia('POST', `/applications/${app.id}/components`, {
          type: 'other',
          name: 'x',
          stack: [
            { product: 'python', version: '3.12' },
            { product: 'python', version: '3.13' },
          ],
        }),
      ),
    ).toBe('STACK_PRODUCT_TWICE');
    expect(await code(olivia('PUT', `/applications/${app.id}/components/cmp_nope`, { type: 'other', name: 'x' }))).toBe('COMPONENT_NOT_FOUND');
  });

  it('lists the endoflife.date products with their release cycles', async () => {
    const r = await vera('GET', '/catalogue/stack-products');
    expect(r.source).toContain('endoflife');
    expect(r.products.length).toBeGreaterThan(300);
    const node = r.products.find((p: any) => p.id === 'nodejs');
    expect(node).toMatchObject({ label: 'Node.js' });
    expect(node.cycles).toContain('22');
    // only what the UI needs
    expect(Object.keys(node).sort()).toEqual(['category', 'cycles', 'id', 'label']);
  });

  it('imports a CycloneDX SBOM: known products only, a preview first, entries entered by hand win', async () => {
    const url = `/applications/${app.id}/components/${image.id}/sbom`;
    const before = (await s.api('GET', `/applications/${app.id}`)).components.find((c: any) => c.id === image.id);
    const preview = await olivia('POST', `${url}/preview`, { sbom: JSON.stringify(CYCLONEDX) });
    expect(preview).toMatchObject({ format: 'cyclonedx', name: 'ghcr.io/acme/orders 1.4.0', total: 7, matched: 4 });
    const byProduct = Object.fromEntries(preview.changes.map((c: any) => [c.product, c]));
    expect(Object.keys(byProduct).sort()).toEqual(['alpine-linux', 'nodejs', 'postgresql', 'react']);
    expect(byProduct['alpine-linux']).toMatchObject({ action: 'add', version: '3.20.3', sbomRef: 'alpine' });
    expect(byProduct.react).toMatchObject({ action: 'add', version: '18.3.1', sbomRef: 'pkg:npm/react' });
    expect(byProduct.postgresql).toMatchObject({ action: 'add', version: '16.4', sbomRef: 'cpe:a:postgresql:postgresql' });
    // entered by hand: stays, the SBOM's version is shown
    expect(byProduct.nodejs).toMatchObject({ action: 'manual', version: '22', other: '24.11.0' });
    // the preview stores nothing
    expect((await s.api('GET', `/applications/${app.id}`)).components.find((c: any) => c.id === image.id)).toEqual(before);

    const r = await olivia('POST', url, { sbom: CYCLONEDX });
    const c = r.application.components.find((x: any) => x.id === image.id);
    expect(Object.fromEntries(c.stack.map((x: any) => [x.product, `${x.version} ${x.source}`]))).toEqual({
      'alpine-linux': '3.20.3 sbom',
      nodejs: '22 manual',
      postgresql: '16.4 sbom',
      react: '18.3.1 sbom',
    });
    expect(c.sbom).toMatchObject({ format: 'cyclonedx', name: 'ghcr.io/acme/orders 1.4.0', importedBy: 'olivia' });
    expect(r.application.stack.map((x: any) => x.label)).toEqual(['Alpine Linux', 'Node.js', 'PostgreSQL', 'React']);

    const e = (await audit(app.id)).find((x: any) => x.action === 'application.sbom_imported');
    expect(e.actor).toBe('olivia');
    expect(e.summary).toContain('3 added, 0 changed, 0 removed, 1 kept as entered by hand');
    expect(e.details).toMatchObject({ format: 'cyclonedx', total: 7, matched: 4 });
  });

  it('a newer SBOM changes and removes SBOM entries; a changed SBOM entry becomes one entered by hand', async () => {
    const url = `/applications/${app.id}/components/${image.id}/sbom`;
    const next = {
      ...CYCLONEDX,
      components: [
        { type: 'operating-system', name: 'alpine', version: '3.21.0' },
        { type: 'framework', name: 'react', version: '18.3.1', purl: 'pkg:npm/react@18.3.1' },
      ],
    };
    const p = await olivia('POST', `${url}/preview`, { sbom: next });
    expect(p.changes.map((c: any) => `${c.action} ${c.product}`)).toEqual(['update alpine-linux', 'remove postgresql', 'keep react']);
    expect(p.changes[0]).toMatchObject({ version: '3.21.0', other: '3.20.3' });
    const r = await olivia('POST', url, { sbom: next });
    let c = r.application.components.find((x: any) => x.id === image.id);
    expect(c.stack.map((x: any) => `${x.product} ${x.version} ${x.source}`)).toEqual(['alpine-linux 3.21.0 sbom', 'nodejs 22 manual', 'react 18.3.1 sbom']);

    // editing the component: entries kept as they are keep their source; a changed version counts as entered by hand
    const a = await olivia('PUT', `/applications/${app.id}/components/${image.id}`, {
      type: 'container-image',
      name: image.name,
      url: image.url,
      stack: [
        { product: 'alpine-linux', version: '3.21.0' },
        { product: 'nodejs', version: '24' },
        { product: 'react', version: '19' },
      ],
    });
    c = a.components.find((x: any) => x.id === image.id);
    expect(c.stack.map((x: any) => `${x.product} ${x.version} ${x.source}`)).toEqual(['alpine-linux 3.21.0 sbom', 'nodejs 24 manual', 'react 19 manual']);
    const e = (await audit(app.id)).find((x: any) => x.action === 'application.component_changed');
    expect(e.details.stack).toEqual({
      added: [],
      changed: [
        { product: 'nodejs', from: '22', to: '24' },
        { product: 'react', from: '18.3.1', to: '19' },
      ],
      removed: [],
    });
    // … so the next SBOM keeps it
    const p2 = await olivia('POST', `${url}/preview`, { sbom: next });
    expect(p2.changes.find((x: any) => x.product === 'react')).toMatchObject({ action: 'manual', version: '19', other: '18.3.1' });
  });

  it('reads SPDX too', async () => {
    const a = await olivia('POST', `/applications/${app.id}/components`, { type: 'container-image', name: 'ghcr.io/acme/orders-worker' });
    const c = a.components.find((x: any) => x.name === 'ghcr.io/acme/orders-worker');
    const r = await olivia('POST', `/applications/${app.id}/components/${c.id}/sbom`, { sbom: JSON.stringify(SPDX) });
    expect(r.preview).toMatchObject({ format: 'spdx', name: 'orders-image', total: 3, matched: 2 });
    expect(r.application.components.find((x: any) => x.id === c.id).stack.map((x: any) => `${x.product} ${x.version}`)).toEqual(['debian 12', 'python 3.11.2']);
  });

  it('refuses what is not an SBOM', async () => {
    const url = `/applications/${app.id}/components/${image.id}/sbom/preview`;
    expect(await code(olivia('POST', url, { sbom: '{not json' }))).toBe('SBOM_INVALID');
    expect(await code(olivia('POST', url, { sbom: { hello: 'world' } }))).toBe('SBOM_INVALID');
    expect(await status(olivia('POST', url, {}))).toBe(400);
    expect(await status(olivia('POST', url, { sbom: CYCLONEDX, url: 'https://example.com/sbom.json' }))).toBe(400);
    expect(await status(vera('POST', url, { sbom: CYCLONEDX }))).toBe(403);
  });

  it('fetches an SBOM from a URL under the outbound policy, without following redirects', async () => {
    let hits = 0;
    const srv = http.createServer((req, res) => {
      hits++;
      if (req.url === '/sbom.json') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(SPDX));
      } else if (req.url === '/moved') {
        res.statusCode = 302;
        res.setHeader('location', '/sbom.json');
        res.end();
      } else res.writeHead(404).end();
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const settings = await s.api('GET', '/settings');
    try {
      const url = `/applications/${app.id}/components/${image.id}/sbom/preview`;
      await s.api('PUT', '/settings', { outboundPolicy: 'allowList', outboundAllowList: [] });
      expect(await status(olivia('POST', url, { url: `${base}/sbom.json` }))).toBe(403);
      await s.api('PUT', '/settings', { outboundPolicy: 'allowList', outboundAllowList: [base] });
      expect((await olivia('POST', url, { url: `${base}/sbom.json` })).format).toBe('spdx');
      // readers cannot make the server fetch anything, neither in the preview nor in the import
      const before = hits;
      expect(await status(vera('POST', url, { url: `${base}/sbom.json` }))).toBe(403);
      expect(await status(vera('POST', url.replace(/\/preview$/, ''), { url: `${base}/sbom.json` }))).toBe(403);
      expect(hits).toBe(before);
      expect(await code(olivia('POST', url, { url: `${base}/moved` }))).toBe('SBOM_FETCH_FAILED');
      expect(await code(olivia('POST', url, { url: `${base}/missing` }))).toBe('SBOM_FETCH_FAILED');
    } finally {
      await s.api('PUT', '/settings', { outboundPolicy: settings.outboundPolicy, outboundAllowList: settings.outboundAllowList });
      srv.close();
    }
  });

  it('gives processes the application with its components and stack', async () => {
    const p = await s.api('POST', '/processes', {
      definition: {
        name: 'Topics of an application',
        connections: [],
        inputs: [{ name: 'app', type: 'application', required: true }],
        outputs: { topics: 'inputs.app.components[type="kafka-topic"].name', node: 'inputs.app.stack[product="nodejs"].version' },
        nodes: [
          { id: 'start', type: 'start', x: 0, y: 0 },
          { id: 'show', type: 'log', x: 0, y: 0, message: '{{ inputs.app.name }}: {{ $join(inputs.app.components[type="kafka-topic"].name, ", ") }}' },
        ],
        wires: [{ from: 'start', port: 'out', to: 'show' }],
      },
    });
    const run = async (inputs: Record<string, unknown>) => {
      const { id } = await s.api('POST', '/runs', { processId: p.id, bindings: {}, inputs });
      return s.waitRun(id, ['succeeded', 'failed', 'cancelled']);
    };
    // by id …
    let r = await run({ app: app.id });
    expect(r.status).toBe('succeeded');
    expect(r.steps.find((x: any) => x.key === 'show').summary).toBe('Orders: orders.dlq, orders.v1');
    expect(r.outputs).toEqual({ topics: ['orders.dlq', 'orders.v1'], node: '24' });
    expect(r.inputs.app).toMatchObject({ id: app.id, name: 'Orders', owners: ['user:olivia'] });
    expect(r.inputs.app.components.find((c: any) => c.name === 'ghcr.io/acme/orders').stack).toContainEqual({
      product: 'nodejs',
      label: 'Node.js',
      version: '24',
      lifecycle: null,
    });
    // … by name (portable, e.g. a default in Git), and the value of an earlier run
    r = await run({ app: 'orders' });
    expect(r.inputs.app.id).toBe(app.id);
    r = await run({ app: { id: app.id, name: 'whatever' } });
    expect(r.inputs.app.id).toBe(app.id);
    expect(await code(s.api('POST', '/runs', { processId: p.id, bindings: {}, inputs: { app: 'No such app' } }))).toBe('INPUT_APPLICATION_NOT_FOUND');
    expect(await status(s.api('POST', '/runs', { processId: p.id, bindings: {}, inputs: {} }))).toBe(400);
  });

  it('shows components and stack in the public API', async () => {
    const token = (await vera('POST', '/me/tokens', { name: 'stack', scope: 'read' })).token;
    const get = async (path: string) => (await fetch(`${s.base}/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } })).json();
    const list = await get('/applications');
    expect(list.items.find((x: any) => x.id === app.id).componentCount).toBe(5);
    const one = await get(`/applications/${app.id}`);
    expect(one.components.map((c: any) => c.name)).toContain('orders.v1');
    expect(one.stack.find((x: any) => x.product === 'nodejs')).toMatchObject({ label: 'Node.js', version: '24' });
  });

  it('removes a component with its stack, audited; archived applications stay as they are', async () => {
    const a = await olivia('DELETE', `/applications/${app.id}/components/${image.id}`);
    expect(a.components.find((c: any) => c.id === image.id)).toBeUndefined();
    expect(a.stack.find((x: any) => x.product === 'nodejs')).toBeUndefined();
    const e = (await audit(app.id)).find((x: any) => x.action === 'application.component_removed');
    expect(e.details.stack.map((x: any) => x.product).sort()).toEqual(['alpine-linux', 'nodejs', 'react']);
    const actions = new Set((await audit(app.id)).map((x: any) => x.action));
    for (const x of ['application.component_added', 'application.component_changed', 'application.component_removed', 'application.sbom_imported'])
      expect(actions).toContain(x);

    await olivia('POST', `/applications/${app.id}/archive`, { archived: true });
    expect(await code(olivia('POST', `/applications/${app.id}/components`, { type: 'other', name: 'late' }))).toBe('APPLICATION_ARCHIVED');
    expect((await vera('GET', `/applications/${app.id}`)).components).toHaveLength(4);
  });
});
