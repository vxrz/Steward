import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Discovery of the data products module (ADR 0036 part 5, WP2): discovery sources with their rights (the module's and
 * the platform's managers who may use the platform), session-only changes and audit; Snowflake in both modes (renames by
 * TABLE_ID), Kafka with the Schema Registry, SQL schema snapshots; environment rules, include and exclude prefixes,
 * OpenLineage names; missing elements only after complete runs; truncation; the use right re-checked before every run;
 * the outbound policy; the metadata-only allow-lists of statements and calls; the job.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
let s: TestServer;
let dana: Client;
let olivia: Client;
let vera: Client;
let snowflake = '';
let kafka = '';
let database = '';
let confluent = '';

type Job = typeof import('../src/dataproducts/discovery/job.js');
type MockSf = typeof import('../src/mock/mockSnowflake.js');
type MockKafka = typeof import('../src/mock/mockKafka.js');
let job: Job;
let sf: MockSf;
let mk: MockKafka;

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
  kind: string;
  qualifiedName: string;
  environment: string;
  parentId: string | null;
  missingSince: string | null;
}

/** Every element under a prefix (all pages), as dana sees them. */
async function elements(prefix: string, extra = ''): Promise<El[]> {
  const out: El[] = [];
  let cursor = '';
  for (;;) {
    const page = await dana('GET', `/data-elements?prefix=${encodeURIComponent(prefix)}${extra}${cursor ? `&cursor=${cursor}` : ''}`);
    out.push(...page.items);
    if (!page.next) return out;
    cursor = page.next;
  }
}

const byName = (els: El[]) => new Map(els.map((e) => [`${e.kind} ${e.qualifiedName} ${e.environment}`, e]));

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', { applications: false });
  await s.api('PUT', '/settings/modules/dataProducts', { enabled: true });
  dana = await s.as('dana', PW);
  olivia = await s.as('olivia', PW);
  vera = await s.as('vera', PW);
  const platforms = (await s.api('GET', '/platforms')) as { id: string; kind: string }[];
  snowflake = platforms.find((p) => p.kind === 'snowflake')!.id;
  kafka = platforms.find((p) => p.kind === 'kafka')!.id;
  database = platforms.find((p) => p.kind === 'database')!.id;
  confluent = platforms.find((p) => p.kind === 'confluent-cloud')!.id;
  job = await import('../src/dataproducts/discovery/job.js');
  sf = await import('../src/mock/mockSnowflake.js');
  mk = await import('../src/mock/mockKafka.js');
}, 180_000);

describe('discovery sources', () => {
  it('are set up by the module’s managers who may use the platform, checked against its kind, session-only and audited', async () => {
    // an operator may use the platform but manages neither the module nor the platform; a viewer does not see it
    expect((await fail(olivia('POST', '/data-products/discovery-sources', { name: 'X', platformId: snowflake, scope: ['SHOP'] }))).status).toBe(403);
    expect(await fail(vera('POST', '/data-products/discovery-sources', { name: 'X', platformId: snowflake, scope: ['SHOP'] }))).toMatchObject({
      status: 400,
      code: 'PLATFORM_NOT_FOUND',
    });
    // the scope must fit the platform
    expect(await fail(dana('POST', '/data-products/discovery-sources', { name: 'X', platformId: snowflake, scope: [] }))).toMatchObject({
      code: 'DATA_DISCOVERY_SCOPE',
      params: { context: 'snowflakeEmpty' },
    });
    expect(await fail(dana('POST', '/data-products/discovery-sources', { name: 'X', platformId: snowflake, scope: ['SHOP.SALES.ORDERS'] }))).toMatchObject({
      code: 'DATA_DISCOVERY_SCOPE',
      params: { context: 'snowflake' },
    });
    expect(await fail(dana('POST', '/data-products/discovery-sources', { name: 'X', platformId: snowflake, scope: ['"shop"'] }))).toMatchObject({
      code: 'DATA_DISCOVERY_SCOPE',
    });
    expect(await fail(dana('POST', '/data-products/discovery-sources', { name: 'X', platformId: kafka, mode: 'accountUsage' }))).toMatchObject({
      code: 'DATA_DISCOVERY_SCOPE',
      params: { context: 'mode' },
    });
    expect(await fail(dana('POST', '/data-products/discovery-sources', { name: 'X', platformId: kafka, scope: ['bad prefix!'] }))).toMatchObject({
      code: 'DATA_DISCOVERY_SCOPE',
      params: { context: 'kafka' },
    });
    expect(await fail(s.api('POST', '/data-products/discovery-sources', { name: 'X', platformId: confluent }))).toMatchObject({
      code: 'DATA_DISCOVERY_PLATFORM',
      params: { context: 'kind' },
    });
    // at most hourly
    expect((await fail(dana('POST', '/data-products/discovery-sources', { name: 'X', platformId: kafka, intervalMinutes: 5 }))).status).toBe(400);
    // an API token cannot set one up (session-only)
    const token = (await dana('POST', '/me/tokens', { name: 'discovery', scope: 'full' })).token as string;
    const viaToken = await fetch(`${s.base}/api/data-products/discovery-sources`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Token', platformId: kafka }),
    });
    expect(viaToken.status).toBe(403);
    const src = await dana('POST', '/data-products/discovery-sources', {
      name: 'Shop on Snowflake',
      platformId: snowflake,
      scope: ['shop', 'SHOP_DEV'],
      environmentRules: [{ match: 'suffix', value: '_DEV', environment: 'dev' }],
      excludePrefixes: ['SHOP.REPORTING'],
      enabled: false,
    });
    expect(src).toMatchObject({
      runAs: 'dana',
      mode: null,
      intervalMinutes: 1440,
      platformName: 'Snowflake (demo)',
      permissions: ['view', 'manage'],
      running: false,
      lastRun: null,
    });
    // an operator who may use the platform sees it, but does not change it; a viewer does not see it at all
    expect((await olivia('GET', `/data-products/discovery-sources/${src.id}`)).permissions).toEqual(['view']);
    expect((await fail(olivia('PUT', `/data-products/discovery-sources/${src.id}`, { ...src }))).status).toBeGreaterThanOrEqual(400);
    expect(await fail(vera('GET', `/data-products/discovery-sources/${src.id}`))).toMatchObject({ status: 404, code: 'DATA_DISCOVERY_NOT_FOUND' });
    expect(await vera('GET', '/data-products/discovery-sources')).toEqual([]);
    // a source keeps its platform
    expect(await fail(dana('PUT', `/data-products/discovery-sources/${src.id}`, { name: src.name, platformId: kafka, scope: [] }))).toMatchObject({
      code: 'DATA_DISCOVERY_PLATFORM',
      params: { context: 'changed' },
    });
    const audit = await s.api('GET', '/audit?action=datadiscovery.source_created');
    expect(JSON.stringify(audit)).toContain('Shop on Snowflake');
  });
});

describe('Snowflake (information schema)', () => {
  let id = '';

  it('discovers databases, schemas, tables, views, dynamic tables, streams, tasks, stages and pipes – metadata only', async () => {
    id = (await dana('GET', '/data-products/discovery-sources')).find((x: { name: string }) => x.name === 'Shop on Snowflake').id;
    sf.resetSnowflakeStatements();
    const run = await job.runSource(id, { trigger: 'manual', actor: 'dana' });
    expect(run).toMatchObject({ status: 'succeeded', truncated: false, missing: 0, error: null, actor: 'dana' });
    const all = await elements('shop');
    const m = byName(all);
    // the scope's databases, with the environment by the rule (SHOP_DEV → dev), else the platform's (demo)
    expect(m.get('snowflake.database SHOP demo')).toBeTruthy();
    expect(m.get('snowflake.database SHOP_DEV dev')).toBeTruthy();
    expect(m.get('snowflake.schema SHOP_DEV.RAW dev')?.parentId).toBe(m.get('snowflake.database SHOP_DEV dev')!.id);
    expect(m.get('snowflake.table SHOP.SALES.ORDERS demo')?.parentId).toBe(m.get('snowflake.schema SHOP.SALES demo')!.id);
    for (const k of [
      'snowflake.view SHOP.MART.DAILY_SALES demo',
      'snowflake.view SHOP.MART.ORDERS_BY_REGION demo',
      'snowflake.dynamicTable SHOP.CURATED.ORDERS demo',
      'snowflake.stream SHOP.RAW.ORDERS_RAW_CHANGES demo',
      'snowflake.task SHOP_DEV.STAGED.LOAD_ORDERS dev',
      'snowflake.stage SHOP.RAW.LANDING demo',
      'snowflake.pipe SHOP.RAW.ORDERS_PIPE demo',
    ])
      expect(m.get(k), k).toBeTruthy();
    // the exclude prefix: no REPORTING schema, nor its view
    expect(all.some((e) => e.qualifiedName.startsWith('SHOP.REPORTING'))).toBe(false);
    // the dynamic table is not also a table
    expect(m.get('snowflake.table SHOP.CURATED.ORDERS demo')).toBeUndefined();
    const orders = await dana('GET', `/data-elements/${m.get('snowflake.table SHOP.SALES.ORDERS demo')!.id}`);
    expect(orders).toMatchObject({
      source: 'discovered',
      discoverySourceId: id,
      olNamespace: 'snowflake://demo12345',
      olName: 'SHOP.SALES.ORDERS',
      readout: { rowCount: 1_250_000, bytes: 412_000_000 },
    });
    const secure = await dana('GET', `/data-elements/${m.get('snowflake.view SHOP.MART.DAILY_SALES demo')!.id}`);
    expect(secure.flags).toMatchObject({ secure: true });
    const task = await dana('GET', `/data-elements/${m.get('snowflake.task SHOP.STAGED.LOAD_ORDERS demo')!.id}`);
    expect(task.externalId).toMatch(/^01b2c3d4-/);
    expect(task.readout).toMatchObject({ state: 'started', schedule: 'USING CRON 0 * * * * UTC' });
    // definitions from SHOW are never kept
    const dyn = await dana('GET', `/data-elements/${m.get('snowflake.dynamicTable SHOP.CURATED.ORDERS demo')!.id}`);
    expect(dyn.readout).toMatchObject({ targetLag: '1 hour', refreshMode: 'INCREMENTAL' });
    for (const e of [dyn, task]) expect(JSON.stringify(e)).not.toMatch(/secret_source|insert into|copy into/);
    // the statements: catalogue views and SHOW only, each on the allow-list; nothing reads a table of the account
    const { SNOWFLAKE_DISCOVERY_STATEMENTS } = await import('../src/dataproducts/discovery/snowflake.js');
    const sent = sf.snowflakeStatements();
    expect(sent.length).toBeGreaterThan(5);
    for (const st of sent) {
      const flat = st.sql.replace(/\s+/g, ' ').trim();
      expect(
        SNOWFLAKE_DISCOVERY_STATEMENTS.some((re) => re.test(flat)),
        flat,
      ).toBe(true);
      expect(flat).not.toMatch(/SAMPLE|SELECT \*|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bCALL\b/i);
      // information schema statements name their view as a binding, never in the text
      if (flat.includes('IDENTIFIER(?)')) expect(st.bindings[0]).toMatch(/^SHOP(_DEV)?\.INFORMATION_SCHEMA\.(SCHEMATA|VIEWS|TABLES)$/);
    }
    expect((await dana('GET', `/data-products/discovery-sources/${id}`)).lastRun).toMatchObject({ status: 'succeeded' });
  });

  it('writes only readouts when nothing changed, marks what is gone missing and finds it again', async () => {
    const before = await elements('shop');
    const again = await job.runSource(id, { trigger: 'schedule' });
    expect(again).toMatchObject({ status: 'succeeded', added: 0, changed: 0, renamed: 0, missing: 0, unchanged: before.length });
    sf.dropSnowflakeObject('SHOP.CURATED.CUSTOMERS');
    const gone = await job.runSource(id, { trigger: 'schedule' });
    expect(gone).toMatchObject({ status: 'succeeded', missing: 1 });
    expect((await elements('shop.curated.customers', '&missing=true')).map((e) => e.qualifiedName)).toEqual(['SHOP.CURATED.CUSTOMERS']);
    // without TABLE_ID (information schema) a rename is a new element and the old one missing
    sf.renameSnowflakeObject('SHOP.SALES.CUSTOMERS', 'CLIENTS');
    const renamed = await job.runSource(id, { trigger: 'schedule' });
    expect(renamed).toMatchObject({ added: 1, renamed: 0, missing: 1 });
    sf.renameSnowflakeObject('SHOP.SALES.CLIENTS', 'CUSTOMERS');
    const back = await job.runSource(id, { trigger: 'schedule' });
    expect(back).toMatchObject({ added: 0, missing: 1 });
    expect((await elements('shop.sales.customers'))[0]!.missingSince).toBeNull();
  });

  it('marks nothing missing after a truncated run, and says why', async () => {
    sf.dropSnowflakeObject('SHOP.SALES.ORDERS');
    const cut = await job.runSource(id, { trigger: 'schedule', limits: { elementsPerRun: 5 } });
    expect(cut).toMatchObject({
      status: 'truncated',
      truncated: true,
      missing: 0,
      errorCode: 'DATA_DISCOVERY_TOO_LARGE',
      errorParams: { context: 'run', max: 5 },
    });
    expect((await elements('shop.sales.orders'))[0]!.missingSince).toBeNull();
    sf.resetSnowflakeCatalogue();
  });

  it('runs as the person who saved it, with the use right checked again before every run', async () => {
    const { db } = await import('../src/db.js');
    const { clearPlatformAccessCache } = await import('../src/monitors/platforms.js');
    db().run("UPDATE dp_discovery_sources SET run_as = 'vera' WHERE id = ?", id);
    clearPlatformAccessCache();
    const r = await job.runSource(id, { trigger: 'schedule' });
    expect(r).toMatchObject({ status: 'failed', errorCode: 'DATA_DISCOVERY_OWNER', errorParams: { owner: 'vera' } });
    expect(r.error).toContain('may not use platform');
    const src = await dana('GET', `/data-products/discovery-sources/${id}`);
    expect(src).toMatchObject({ lastStatus: 'failed', failingSince: expect.any(String) });
    // saving it again makes it the saver's: it runs with their right
    const input = (({
      name,
      platformId,
      scope,
      includePrefixes,
      excludePrefixes,
      environmentRules,
      mode,
      identityId,
      elementTeamIds,
      intervalMinutes,
      enabled,
    }) => ({
      name,
      platformId,
      scope,
      includePrefixes,
      excludePrefixes,
      environmentRules,
      mode,
      identityId,
      elementTeamIds,
      intervalMinutes,
      enabled,
    }))(src);
    const saved = await dana('PUT', `/data-products/discovery-sources/${id}`, input);
    expect(saved.runAs).toBe('dana');
    clearPlatformAccessCache();
    expect((await job.runSource(id, { trigger: 'schedule' })).status).toBe('succeeded');
    expect((await dana('GET', `/data-products/discovery-sources/${id}`)).failingSince).toBeNull();
    expect(JSON.stringify(await s.api('GET', '/audit?action=datadiscovery.run_failed'))).toContain('runs as vera');
  });

  it('Read now runs in the background; a second start while it runs is refused', async () => {
    const started = await dana('POST', `/data-products/discovery-sources/${id}/run`);
    expect(started).toMatchObject({ status: 'running', actor: 'dana' });
    expect(() => job.startRun(id, { trigger: 'manual' })).toThrow(/reading already/);
    for (let i = 0; i < 100; i++) {
      const runs = await dana('GET', `/data-products/discovery-sources/${id}/runs`);
      if (runs[0].status !== 'running') {
        expect(runs[0]).toMatchObject({ id: started.id, status: 'succeeded' });
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect((await dana('GET', `/data-products/discovery-sources/${id}/runs`))[0].status).toBe('succeeded');
  });

  it('fails a run the outbound policy blocks, and keeps what it found', async () => {
    const settings = await s.api('GET', '/settings');
    try {
      await s.api('PUT', '/settings', { outboundPolicy: 'allowList', outboundAllowList: [] });
      const r = await job.runSource(id, { trigger: 'schedule' });
      expect(r).toMatchObject({ status: 'failed', missing: 0, errorCode: 'DATA_DISCOVERY_FAILED' });
      expect(r.error).toMatch(/Blocked by the outbound policy/);
      expect((await elements('shop.sales.orders'))[0]!.missingSince).toBeNull();
      // Kafka: the demo cluster is no host; its Schema Registry is, and is blocked – the topics stand, the run says so
      const topics = await dana('POST', '/data-products/discovery-sources', { name: 'Blocked registry', platformId: kafka, scope: ['orders'], enabled: false });
      const k = await job.runSource(topics.id, { trigger: 'schedule' });
      expect(k).toMatchObject({ status: 'succeeded', errorCode: 'DATA_DISCOVERY_PARTIAL', errorParams: { context: 'registry' } });
      expect(k.error).toMatch(/Blocked by the outbound policy/);
      await dana('DELETE', `/data-products/discovery-sources/${topics.id}`);
    } finally {
      await s.api('PUT', '/settings', { outboundPolicy: settings.outboundPolicy, outboundAllowList: settings.outboundAllowList });
    }
  });
});

describe('Snowflake (account usage)', () => {
  it('reads the scope in one statement per view and keeps an element renamed by its TABLE_ID', async () => {
    const src = await dana('POST', '/data-products/discovery-sources', {
      name: 'CRM by account usage',
      platformId: snowflake,
      scope: ['CRM', 'PRD_SDC_OPQ_PBI_DEV'],
      mode: 'accountUsage',
      enabled: false,
    });
    sf.resetSnowflakeStatements();
    const r = await job.runSource(src.id, { trigger: 'schedule' });
    expect(r).toMatchObject({ status: 'succeeded', added: 4 }); // two databases, CRM.CORE, CRM.CORE.CONTACTS
    const tags = sf.snowflakeStatements().map((x) => /steward:([a-z-]+)/.exec(x.sql)?.[1]);
    expect(tags.filter((t) => t === 'dp-au-tables')).toHaveLength(1);
    expect(tags.some((t) => t === 'dp-tables')).toBe(false);
    const contacts = (await elements('crm.core.contacts'))[0]!;
    expect((await dana('GET', `/data-elements/${contacts.id}`)).externalId).toMatch(/^\d+$/);
    await dana('PUT', `/data-elements/${contacts.id}`, { description: 'Written by people', layer: 'curated' });
    sf.renameSnowflakeObject('CRM.CORE.CONTACTS', 'PEOPLE');
    const renamed = await job.runSource(src.id, { trigger: 'schedule' });
    expect(renamed).toMatchObject({ renamed: 1, added: 0, missing: 0 });
    expect(await dana('GET', `/data-elements/${contacts.id}`)).toMatchObject({
      qualifiedName: 'CRM.CORE.PEOPLE',
      description: 'Written by people',
      layer: 'curated',
      olName: 'CRM.CORE.PEOPLE',
    });
    const audit = await s.api('GET', '/audit?action=datadiscovery.run');
    expect(JSON.stringify(audit)).toContain('CRM.CORE.PEOPLE');
    sf.resetSnowflakeCatalogue();
  });
});

describe('Kafka and the Schema Registry', () => {
  let id = '';

  it('discovers topics with ids, partitions, settings and the latest value schema – no messages, no groups', async () => {
    mk.resetKafka();
    mk.addKafkaTopic('__consumer_offsets', 50);
    const src = await dana('POST', '/data-products/discovery-sources', {
      name: 'Kafka topics',
      platformId: kafka,
      environmentRules: [{ match: 'prefix', value: 'shop.', environment: 'prod' }],
      enabled: false,
    });
    id = src.id;
    mk.resetKafkaCalls();
    mk.resetRegistryCalls();
    const r = await job.runSource(id, { trigger: 'schedule' });
    // orders was found by a source deleted since (the outbound policy test): this source looks after it now
    expect(r).toMatchObject({ status: 'succeeded', added: 4, unchanged: 1, error: null });
    const topics = await elements('', `&platformId=${kafka}&kind=kafka.topic`);
    expect(topics.map((t) => `${t.qualifiedName} ${t.environment}`).sort()).toEqual([
      'orders demo',
      'payments demo',
      'shop-events demo',
      'shop.public.customers prod',
      'shop.public.orders prod',
    ]);
    const orders = await dana('GET', `/data-elements/${topics.find((t) => t.qualifiedName === 'orders')!.id}`);
    expect(orders).toMatchObject({
      externalId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      olNamespace: 'kafka://kafka.demo.invalid:9092',
      olName: 'orders',
      readout: { partitions: 3, replicationFactor: 3, cleanupPolicy: 'delete', schemaSubject: 'orders-value', schemaVersion: 2, schemaType: 'AVRO' },
    });
    const events = await dana('GET', `/data-elements/${topics.find((t) => t.qualifiedName === 'shop-events')!.id}`);
    expect(events.flags).toMatchObject({ compacted: true });
    const { KAFKA_DISCOVERY_CALLS } = await import('../src/dataproducts/discovery/kafka.js');
    for (const c of mk.kafkaCalls())
      expect(
        KAFKA_DISCOVERY_CALLS.some((re) => re.test(c)),
        c,
      ).toBe(true);
    for (const p of mk.registryCalls()) expect(p).toMatch(/^GET \/mock\/schema-registry\/subjects(\/[^/]+\/versions\/latest)?$/);
  });

  it('a deleted topic goes missing; a topic created again keeps its element with the new topic id', async () => {
    const before = (await dana('GET', `/data-elements/${(await elements('payments', `&platformId=${kafka}`))[0]!.id}`)).externalId;
    mk.recreateKafkaTopic('payments');
    mk.removeKafkaTopic('shop-events');
    const r = await job.runSource(id, { trigger: 'schedule' });
    expect(r).toMatchObject({ status: 'succeeded', changed: 1, missing: 1 });
    const payments = await dana('GET', `/data-elements/${(await elements('payments', `&platformId=${kafka}`))[0]!.id}`);
    expect(payments.externalId).not.toBe(before);
    expect((await elements('shop-events', `&platformId=${kafka}&missing=true`)).length).toBe(1);
  });

  it('keeps the topics when the Schema Registry cannot be read, and says so', async () => {
    await s.api('PUT', `/platforms/${kafka}/secrets`, { registrySecret: 'wrong' });
    try {
      const r = await job.runSource(id, { trigger: 'schedule' });
      expect(r).toMatchObject({ status: 'succeeded', missing: 0, errorCode: 'DATA_DISCOVERY_PARTIAL', errorParams: { context: 'registry' } });
      expect(r.error).toContain('HTTP 401');
    } finally {
      await s.api('PUT', `/platforms/${kafka}/secrets`, { registrySecret: mk.DEMO_KAFKA.registrySecret });
      mk.resetKafka();
    }
  });
});

describe('SQL schema snapshots', () => {
  it('name their OpenLineage datasets by the naming conventions of each dialect', async () => {
    const { sqlOpenLineage } = await import('../src/dataproducts/discovery/dbschema.js');
    const { openLineageDataset } = await import('@sm/shared');
    const of = (dialect: string, port?: number) => {
      const ol = sqlOpenLineage({ config: { database: { dialect, host: 'DB.example', port, database: 'shop' } } } as never)!;
      return openLineageDataset('sql.table', ol.address, `${ol.prefix}sales.orders`);
    };
    expect(of('postgresql')).toEqual({ namespace: 'postgres://db.example:5432', name: 'shop.sales.orders' });
    expect(of('mysql', 3307)).toEqual({ namespace: 'mysql://db.example:3307', name: 'sales.orders' });
    expect(of('sqlserver')).toEqual({ namespace: 'mssql://db.example:1433', name: 'shop.sales.orders' });
  });

  it('reads the latest snapshot of a database platform – no connection of its own', async () => {
    const src = await dana('POST', '/data-products/discovery-sources', { name: 'Shop database', platformId: database, enabled: false });
    const none = await job.runSource(src.id, { trigger: 'schedule' });
    expect(none).toMatchObject({ status: 'failed', errorCode: 'DATA_DISCOVERY_NO_SNAPSHOT' });
    await s.api('POST', `/db-schemas/platform/${database}/read`);
    const r = await job.runSource(src.id, { trigger: 'schedule' });
    expect(r).toMatchObject({ status: 'succeeded', added: 7 }); // the schema public and its 6 tables
    const m = byName(await elements('public', `&platformId=${database}`));
    const orders = m.get('sql.table public.orders demo')!;
    expect(orders.parentId).toBe(m.get('sql.schema public demo')!.id);
    expect(await dana('GET', `/data-elements/${orders.id}`)).toMatchObject({
      olNamespace: 'postgres://postgres.demo.invalid:5432',
      olName: 'shop.public.orders',
      readout: { columns: expect.any(Number) },
    });
    // a scope that names no schema of the snapshot: nothing there, so the earlier ones go missing
    await dana('PUT', `/data-products/discovery-sources/${src.id}`, { name: 'Shop database', platformId: database, scope: ['sales'], enabled: false });
    expect(await job.runSource(src.id, { trigger: 'schedule' })).toMatchObject({ status: 'succeeded', added: 0, missing: 7 });
  });
});

describe('owning teams of what a source finds', () => {
  it('asks for the access.grant step-up when they reach other people, and keep the elements in the team', async () => {
    const team = (await s.api('POST', '/teams', { name: 'Discovery team', members: ['dana'] })).id;
    const strict = await s.as('dana', PW, { autoStepUp: false });
    await strict('DELETE', '/auth/step-up');
    const body = { name: 'Team topics', platformId: kafka, scope: ['orders'], elementTeamIds: [team], enabled: false };
    expect(await fail(strict('POST', '/data-products/discovery-sources', body))).toMatchObject({ status: 403, code: 'STEP_UP_REQUIRED' });
    const src = await dana('POST', '/data-products/discovery-sources', body);
    const audit = await s.api('GET', '/audit?action=access.owning_teams_changed');
    expect(JSON.stringify(audit)).toContain('Team topics');
    // the topics already in the catalogue stay as they are; a new one gets the team
    mk.addKafkaTopic('orders.v1', 3);
    expect(await job.runSource(src.id, { trigger: 'schedule' })).toMatchObject({ status: 'succeeded', added: 1 });
    expect((await elements('orders.v1', `&platformId=${kafka}`)).length).toBe(1);
    const asOlivia = await olivia('GET', `/data-elements?prefix=orders.v1&platformId=${kafka}`);
    expect(asOlivia.total).toBe(0);
    // olivia may use the platform, but is not in the team: she does not see the source either
    expect((await olivia('GET', '/data-products/discovery-sources')).some((x: { id: string }) => x.id === src.id)).toBe(false);
    expect((await fail(olivia('GET', `/data-products/discovery-sources/${src.id}`))).status).toBe(404);
    await dana('DELETE', `/data-products/discovery-sources/${src.id}`);
    expect((await fail(dana('GET', `/data-products/discovery-sources/${src.id}`))).code).toBe('DATA_DISCOVERY_NOT_FOUND');
    // its elements stay in the catalogue
    expect((await elements('orders.v1', `&platformId=${kafka}`)).length).toBe(1);
  });
});

describe('the job', () => {
  it('reads the enabled sources that are due, one at a time', async () => {
    const { db } = await import('../src/db.js');
    const src = await dana('POST', '/data-products/discovery-sources', { name: 'Due topics', platformId: kafka, scope: ['payments'] });
    db().run("UPDATE dp_discovery_sources SET next_run_at = '2000-01-01T00:00:00.000Z' WHERE enabled = 0");
    const r = await job.runDataProductsJob(Date.now() + 1000);
    expect(r).toMatchObject({ read: 1, failed: 0 });
    const after = await dana('GET', `/data-products/discovery-sources/${src.id}`);
    expect(after).toMatchObject({ lastStatus: 'succeeded', lastRun: { status: 'succeeded', actor: 'system' } });
    expect(Date.parse(after.nextRunAt) - Date.now()).toBeGreaterThan(23 * 3_600_000);
    // not due again
    expect(await job.runDataProductsJob()).toMatchObject({ read: 0 });
    const { featureJobs } = await import('../src/features/index.js');
    expect(featureJobs().some((j) => j.name === 'data-products')).toBe(true);
  });

  it('keeps the newest runs of a source only', async () => {
    const { db } = await import('../src/db.js');
    const id = (await dana('GET', '/data-products/discovery-sources')).find((x: { name: string }) => x.name === 'Due topics').id;
    for (let i = 0; i < 32; i++)
      db().run(
        "INSERT INTO dp_discovery_runs (id, source_id, status, started_at, actor) VALUES (?, ?, 'succeeded', ?, 'system')",
        `dpn_old${i}`,
        id,
        `2001-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
      );
    await job.runSource(id, { trigger: 'schedule' });
    expect(Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM dp_discovery_runs WHERE source_id = ?', id)!.n)).toBe(30);
    expect((await dana('GET', `/data-products/discovery-sources/${id}/runs`))[0].startedAt.startsWith('20')).toBe(true);
  });
});
