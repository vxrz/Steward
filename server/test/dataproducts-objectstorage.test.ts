import { beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Object storage for data products (0.25.0, ADR 0037 part 2, docs/DATA-PRODUCTS.md#object-storage): `files.path`
 * elements discovered on S3 through the AWS account platform – ListObjectsV2 only, only on the prefixes a source or a
 * product names, metadata only (count, size, newest change, format by suffix, Hive partitions, Iceberg), with limits
 * per run that say so; freshness and volume of a file element; external stages linked to their S3 prefix and pipes to
 * their stage and table as proposals; file ports with format, partitioning and an ODCS server of type s3; the demo's
 * file-based product.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
let s: TestServer;
let dana: Client;
let aws = '';

const fail = async (p: Promise<unknown>): Promise<{ status: number; code: string; params: Record<string, unknown> }> => {
  try {
    await p;
  } catch (e) {
    const err = e as { status: number; body?: { code?: string; params?: Record<string, unknown> } };
    return { status: err.status, code: err.body?.code ?? '', params: err.body?.params ?? {} };
  }
  throw new Error('expected a refusal');
};

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', { services: true });
  await s.api('PUT', '/settings/modules/dataProducts', { enabled: true });
  dana = await s.as('dana', PW);
  const platforms = (await s.api('GET', '/platforms')) as { id: string; kind: string; name: string }[];
  aws = platforms.find((p) => p.name === 'AWS (demo)')!.id;
}, 180_000);

interface El {
  id: string;
  qualifiedName: string;
  displayName: string;
  environment: string;
  source: string;
  olNamespace: string | null;
  olName: string | null;
  readout: Record<string, unknown> | null;
}

async function element(qn: string): Promise<El> {
  const page = await s.api('GET', `/data-elements?prefix=${encodeURIComponent(qn)}&kind=files.path`);
  const hit = (page.items as { id: string; qualifiedName: string }[]).find((x) => x.qualifiedName === qn);
  if (!hit) throw new Error(`no element ${qn}`);
  return (await s.api('GET', `/data-elements/${hit.id}`)) as El;
}

describe('S3 discovery', () => {
  it('reads the named prefixes of the demo: counts, size, newest change, formats, partitions and Iceberg – metadata only', async () => {
    const orders = await element('s3://invented-landing.example/orders/');
    expect(orders).toMatchObject({
      displayName: 'orders',
      environment: 'prod',
      source: 'discovered',
      olNamespace: 's3://invented-landing.example',
      olName: 'orders',
      readout: { objects: 11, format: 'parquet', partitionKeys: 'dt', partitions: 5, prefixes: 5 },
    });
    expect(Date.now() - Date.parse(String(orders.readout!.lastAltered))).toBeLessThan(60 * 60_000);
    // the datasets one level below a prefix of the scope are elements of their own; partitions are not
    expect((await element('s3://invented-shop-lake.example/exports/daily-sales/')).readout).toMatchObject({
      objects: 7,
      format: 'csv',
      partitionKeys: 'dt',
      partitions: 7,
    });
    expect((await element('s3://invented-shop-lake.example/exports/customers/')).readout).toMatchObject({ objects: 2, format: 'json', bytes: 1_635_000 });
    expect((await element('s3://invented-shop-lake.example/exports/')).readout).toMatchObject({ objects: 9, format: 'mixed', prefixes: 2 });
    // an Iceberg table on S3 is a files.path with the format Iceberg
    expect((await element('s3://invented-shop-lake.example/iceberg/order_items/')).readout).toMatchObject({ format: 'iceberg', partitionKeys: 'dt' });
    const page = await s.api('GET', `/data-elements?prefix=${encodeURIComponent('s3://invented-shop-lake.example/raw')}&kind=files.path`);
    expect(page.items).toEqual([]);
  });

  it('lists only the named prefixes with ListObjectsV2 – never an object, never a bucket’s root that no one named', async () => {
    const { s3Requests } = await import('../src/mock/mockAws.js');
    const { S3_DISCOVERY_CALLS } = await import('../src/dataproducts/discovery/s3.js');
    const src = (await dana('GET', '/data-products/discovery-sources')).find((x: { name: string }) => x.name === 'Shop files (demo)');
    s3Requests.length = 0;
    expect((await dana('POST', `/data-products/discovery-sources/${src.id}/run`)).status).toBe('running');
    const { runningSources } = { runningSources: await import('../src/dataproducts/discovery/job.js') };
    for (let i = 0; i < 100 && runningSources.isRunning(src.id); i++) await new Promise((r) => setTimeout(r, 50));
    const run = (await dana('GET', `/data-products/discovery-sources/${src.id}/runs`))[0];
    expect(run).toMatchObject({ status: 'succeeded', missing: 0 });
    expect(s3Requests.length).toBeGreaterThan(0);
    const named = ['orders/', 'exports/', 'iceberg/'];
    for (const r of s3Requests) {
      const path = r.url.replace(/^\/[^?]*/, (p) => p);
      expect(`${r.method} ${path}`).toSatisfy((x: string) => S3_DISCOVERY_CALLS.some((re) => re.test(x)));
      const prefix = decodeURIComponent(new URL(`http://x${r.url}`).searchParams.get('prefix') ?? '');
      expect(
        named.some((n) => prefix.startsWith(n)),
        prefix,
      ).toBe(true);
    }
  });

  it('refuses a scope that is no S3 prefix; a run a limit cuts says so and marks nothing missing', async () => {
    expect(await fail(dana('POST', '/data-products/discovery-sources', { name: 'Bad', platformId: aws, scope: ['s3://Invented_Bad/x/'] }))).toMatchObject({
      status: 400,
      code: 'DATA_DISCOVERY_SCOPE',
      params: { context: 's3' },
    });
    expect(
      await fail(dana('POST', '/data-products/discovery-sources', { name: 'Bad', platformId: aws, scope: ['invented-shop-lake.example/raw/'] })),
    ).toMatchObject({ status: 400, code: 'DATA_DISCOVERY_SCOPE' });
    const src = await dana('POST', '/data-products/discovery-sources', {
      name: 'Lake (invented)',
      platformId: aws,
      scope: ['s3://invented-shop-lake.example/exports/'],
      environmentRules: [{ match: 'prefix', value: 'invented-', environment: 'prod' }],
    });
    const { S3_RUN_LIMITS } = await import('../src/dataproducts/discovery/s3.js');
    const { runSource } = await import('../src/dataproducts/discovery/job.js');
    const before = { ...S3_RUN_LIMITS };
    S3_RUN_LIMITS.keys = 4;
    try {
      const run = await runSource(src.id, { trigger: 'manual', actor: 'dana' });
      expect(run).toMatchObject({
        status: 'truncated',
        truncated: true,
        missing: 0,
        errorCode: 'DATA_DISCOVERY_TOO_LARGE',
        errorParams: { context: 's3Keys', max: 4 },
      });
    } finally {
      Object.assign(S3_RUN_LIMITS, before);
    }
    expect((await element('s3://invented-shop-lake.example/exports/')).readout).toMatchObject({ truncated: true });
    // a bucket in another region: the listing follows the region S3 names, once
    const { setMockS3BucketRegion, s3Requests } = await import('../src/mock/mockAws.js');
    setMockS3BucketRegion('invented-shop-lake.example', 'eu-west-1');
    s3Requests.length = 0;
    try {
      expect(await runSource(src.id, { trigger: 'manual', actor: 'dana' })).toMatchObject({ status: 'succeeded' });
      expect(s3Requests.map((r) => r.region)).toContain('eu-west-1');
    } finally {
      setMockS3BucketRegion('invented-shop-lake.example', null);
    }
    expect((await element('s3://invented-shop-lake.example/exports/')).readout).not.toHaveProperty('truncated');
    await dana('DELETE', `/data-products/discovery-sources/${src.id}`);
  });

  it('reads the files.path elements of products on the platform too – with an empty scope', async () => {
    const el = await dana('POST', '/data-elements', {
      platformId: aws,
      kind: 'files.path',
      qualifiedName: 's3://invented-shop-lake.example/raw/',
      environment: 'test',
    });
    const p = await dana('POST', '/data-products', { key: 'raw-files', name: 'Raw files (invented)' });
    await dana('POST', `/data-products/${p.id}/members`, { elementIds: [el.id], role: 'input' });
    const src = await dana('POST', '/data-products/discovery-sources', { name: 'Product prefixes (invented)', platformId: aws, scope: [] });
    const { runSource } = await import('../src/dataproducts/discovery/job.js');
    expect(await runSource(src.id, { trigger: 'manual', actor: 'dana' })).toMatchObject({ status: 'succeeded', added: 0 });
    // the entered element keeps its environment; discovery looks after it from now on
    expect(await s.api('GET', `/data-elements/${el.id}`)).toMatchObject({
      environment: 'test',
      discoverySourceId: src.id,
      readout: { objects: 1, format: 'csv' },
    });
    await dana('DELETE', `/data-products/discovery-sources/${src.id}`);
  });
});

describe('checks, links and file ports', () => {
  it('a files.path element’s freshness and volume come from its prefix’s listing', async () => {
    const el = await element('s3://invented-shop-lake.example/exports/daily-sales/');
    const { dataElementCheck } = await import('../src/dataproducts/checks/element.js');
    const check = (mode: 'freshness' | 'volume', extra: Record<string, unknown> = {}) =>
      dataElementCheck({ element: el.id, mode, maxAgeMinutes: 1440, failAs: 'down', warningAs: 'degraded', ...extra } as never, {
        owner: 'admin',
        now: () => Date.now(),
      });
    expect(await check('freshness')).toMatchObject({ status: 'up', message: expect.stringContaining('changed') });
    expect(await check('freshness', { maxAgeMinutes: 10 })).toMatchObject({ status: 'down' });
    expect(await check('volume', { minRows: 5 })).toMatchObject({ status: 'up', value: { value: 7 } });
    expect(await check('volume', { measure: 'bytes', minRows: 1_000_000 })).toMatchObject({ status: 'down' });
    // a stopped export: nothing new for two days
    const { setMockS3Bucket } = await import('../src/mock/mockAws.js');
    const old = new Date(Date.now() - 2 * 86_400_000).toISOString();
    setMockS3Bucket('invented-shop-lake.example', [{ key: 'exports/daily-sales/dt=2026-11-01/daily-sales.csv', size: 10, lastModified: old }]);
    try {
      expect(await check('freshness')).toMatchObject({ status: 'down', message: expect.stringContaining('days ago') });
    } finally {
      setMockS3Bucket('invented-shop-lake.example', null);
    }
  });

  it('proposes S3 prefix → stage and stage → table through the pipe after the Snowflake run', async () => {
    const items = [
      ...(await dana('GET', '/data-products/lineage-proposals?origin=snowflake&status=open')).items,
      ...(await dana('GET', '/data-products/lineage-proposals?origin=snowflake&status=documented')).items,
    ] as Record<string, any>[];
    const stage = items.find((x) => x.key === 'stage:SHOP.RAW.LANDING')!;
    expect(stage).toMatchObject({ tool: 'Snowflake stage', kind: 'ingest', unmatchedInputs: [] });
    expect(stage.inputs.map((e: { qualifiedName: string }) => e.qualifiedName)).toEqual(['s3://invented-landing.example/orders/']);
    expect(stage.outputs.map((e: { qualifiedName: string }) => e.qualifiedName)).toEqual(['SHOP.RAW.LANDING']);
    const pipe = items.find((x) => x.key === 'pipe:SHOP.RAW.ORDERS_PIPE')!;
    expect(pipe).toMatchObject({ tool: 'Snowpipe' });
    expect(pipe.inputs.map((e: { qualifiedName: string }) => e.qualifiedName)).toEqual(['SHOP.RAW.LANDING']);
    expect(pipe.outputs.map((e: { qualifiedName: string }) => e.qualifiedName)).toEqual(['SHOP.RAW.ORDERS_RAW']);
    // the stage keeps its URL, the pipe the names of its COPY statement – never the statement
    const sf = await s.api('GET', `/data-elements?prefix=SHOP.RAW.ORDERS_PIPE&kind=snowflake.pipe&environment=prod`);
    const pipeEl = await s.api('GET', `/data-elements/${sf.items[0].id}`);
    expect(pipeEl.readout).toMatchObject({ stage: 'SHOP.RAW.LANDING', target: 'SHOP.RAW.ORDERS_RAW' });
    expect(JSON.stringify(pipeEl.readout)).not.toMatch(/copy into/i);
  });

  it('the demo’s file-based product: a file port with format, partitioning and an ODCS server of type s3', async () => {
    const list = await dana('GET', '/data-products?q=Sales%20files');
    const p = await dana('GET', `/data-products/${list.items[0].id}`);
    const port = p.ports.find((x: { name: string }) => x.name === 'daily sales files');
    expect(port).toMatchObject({ type: 'file', fileFormat: 'csv', partitioning: ['dt'] });
    // in the file format and in /api/v1
    const doc = YAML.parse((await dana('GET', `/data-products/${p.id}/export`)) as string);
    expect((doc.data_product ?? doc.data_products[0]).ports.find((x: { name: string }) => x.name === 'daily sales files')).toMatchObject({
      file_format: 'csv',
      partitioning: ['dt'],
    });
    const token = (await dana('POST', '/me/tokens', { name: 'api dana', scope: 'read' })).token as string;
    const v1 = (await (await fetch(`${s.base}/api/v1/data-products/${p.id}`, { headers: { authorization: `Bearer ${token}` } })).json()) as {
      ports: { name: string }[];
    };
    expect(v1.ports.find((x: { name: string }) => x.name === 'daily sales files')).toMatchObject({ fileFormat: 'csv', partitioning: ['dt'] });
    // a change of the port keeps them when it leaves them out, and takes new ones
    await dana('PUT', `/data-products/${p.id}/ports/${port.id}`, {
      direction: 'output',
      name: port.name,
      version: 'v1',
      type: 'file',
      lifecycle: port.lifecycle,
    });
    expect((await dana('GET', `/data-products/${p.id}`)).ports.find((x: { id: string }) => x.id === port.id)).toMatchObject({ fileFormat: 'csv' });
    await dana('PUT', `/data-products/${p.id}/ports/${port.id}`, {
      direction: 'output',
      name: port.name,
      version: 'v1',
      type: 'file',
      lifecycle: port.lifecycle,
      fileFormat: 'parquet',
      partitioning: ['dt', 'region'],
    });
    expect((await dana('GET', `/data-products/${p.id}`)).ports.find((x: { id: string }) => x.id === port.id)).toMatchObject({
      fileFormat: 'parquet',
      partitioning: ['dt', 'region'],
    });
    // a contract drafted from the bound element has the s3 server
    const el = await element('s3://invented-shop-lake.example/exports/daily-sales/');
    const draft = await s.api('POST', '/data-contracts/draft', { source: 'element', elementId: el.id });
    const odcs = YAML.parse(draft.yaml);
    expect(odcs.servers[0]).toMatchObject({ type: 's3', format: 'csv', location: 's3://invented-shop-lake.example/exports/daily-sales/**/*.csv' });
  });
});
