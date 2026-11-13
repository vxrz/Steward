import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * The reads of the data products module at volume (ADR 0036 _Performance_, WP8): the product list, the element
 * catalogue, a product page, its members, pipeline and picture, the product map, the lineage of an element four steps
 * deep, the costs and the scorecard of a product, and the list's facts of a page.
 *
 * - **Statements:** a fixed number per request – the same for a product before and after it grew by 300 members and
 *   150 steps, about the same for a page of 50 and of 100 rows and for the map with 50 more products (one statement per
 *   kind of fact and chunk of 500 ids, one per depth level for lineage – never one per row); bounded as the ADR says
 *   (the product page at most 25 beyond what every request costs).
 * - **Time:** with SM_PERF=1 the volumes of the ADR – 250,000 elements, 2,000 products, 30,000 memberships, 10,000
 *   steps, 5,000 check links – and 300 ms per read, the map of all 2,000 products 1 s (run alone:
 *   `SM_PERF=1 npx vitest run test/dataproducts-perf.test.ts`).
 *   Without it a tenth of the catalogue and bounds that only catch a read that scans or loops: on a busy shared runner
 *   the time measures the machine.
 *
 * The volume is written straight into the tables in multi-row statements (what discovery writes in batches); the reads
 * go through the HTTP routes as a designer, with every right check.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PERF = !!process.env.SM_PERF;
const V = PERF
  ? { elements: 250_000, products: 2_000, membersPerProduct: 15, chain: 5, checkLinks: 5_000 }
  : { elements: 25_000, products: 400, membersPerProduct: 15, chain: 5, checkLinks: 1_000 };
/** One read (the median of three, after a warm-up) */
const READ_MS = PERF ? 300 : 3_000;
/** The map reads every product the reader may see and their health (2,000 at SM_PERF; the ADR names no bound for it) */
const MAP_MS = PERF ? 1_000 : 5_000;
/**
 * The map's health reads the elements of every product's members in chunks of 500 ids: about 150 statements for the
 * 28,000 members of 2,000 products (phase 2: one grouped read), 45 for the everyday volume – never one per product.
 */
const MAP_STATEMENTS = PERF ? 200 : 50;
const PW = 'Demo-password-1';

let s: TestServer;
let dana: Client;
const counted = new Map<string, number>();
const ids = { products: [] as string[], chainEnd: [] as string[], domains: [] as string[] };

beforeAll(async () => {
  s = await startTestServer({
    routes: (app) =>
      app.addHook('onSend', async (req, _reply, payload) => {
        const { requestDbTotals } = await import('../src/http-observability.js');
        counted.set(req.url, requestDbTotals(req)?.statements ?? -1);
        return payload;
      }),
  });
  await setup(s);
  await s.api('POST', '/demo/setup', { applications: false });
  await s.api('PUT', '/settings/modules/dataProducts', { enabled: true });
  dana = await s.as('dana', PW);
  const platforms = (await s.api('GET', '/platforms')) as { id: string; kind: string }[];
  await seed(platforms.find((p) => p.kind === 'snowflake')!.id);
}, 600_000);

/** Multi-row inserts of `rows` (columns in order), 200 rows a statement, in one transaction per table. */
async function insert(table: string, columns: string[], rows: unknown[][]): Promise<void> {
  const { db } = await import('../src/db.js');
  const one = `(${columns.map(() => '?').join(', ')})`;
  db().tx(() => {
    for (let i = 0; i < rows.length; i += 200) {
      const part = rows.slice(i, i + 200);
      db().run(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${part.map(() => one).join(', ')}`, ...part.flat());
    }
  });
}

/**
 * The volume: domains; products of `membersPerProduct` elements each – a chain of `chain` steps from its first element
 * to its output (E0 → E1 → … → E5), the first element read from the previous product's output (a step across products,
 * so lineage reaches four steps in both directions), an output port bound to the last element in prod and an input port
 * on the previous product's output port; the rest of the catalogue elements in no product; check links on output
 * elements to a check of a demo monitor.
 */
async function seed(platform: string): Promise<void> {
  const { db } = await import('../src/db.js');
  const now = new Date().toISOString();
  const by = 'perf';
  const domains = Array.from({ length: 20 }, (_, i) => [`dpd_perf${i}`, `perf-domain-${i}`, `Perf domain ${i}`, now, by, now, by]);
  await insert('dp_domains', ['id', 'key', 'name', 'created_at', 'created_by', 'updated_at', 'updated_by'], domains);
  ids.domains = domains.map((d) => d[0] as string);

  const elements: unknown[][] = [];
  const el = (n: number) => `dpe_perf${n}`;
  for (let n = 0; n < V.elements; n++) {
    const name = `PERF.S${Math.floor(n / 5_000)}.T${String(n).padStart(6, '0')}`;
    elements.push([el(n), platform, 'snowflake.table', name, name.toLowerCase(), 'prod', 'discovered', now, by, now, by]);
  }
  await insert(
    'dp_elements',
    ['id', 'platform_id', 'kind', 'qualified_name', 'name_norm', 'environment', 'source', 'created_at', 'created_by', 'updated_at', 'updated_by'],
    elements,
  );

  await seedProducts(0, V.products, now);
  // check links: output elements first, then internal ones, to a check of a demo monitor
  const monitor = db().get<{ id: string; definition: string }>('SELECT id, definition FROM monitors ORDER BY id LIMIT 1')!;
  const check = (JSON.parse(monitor.definition) as { checks: { id: string }[] }).checks[0]!.id;
  const links: unknown[][] = [];
  for (let i = 0; i < V.checkLinks; i++) {
    const p = i % V.products;
    const m = Math.floor(i / V.products);
    links.push([
      `dpl_perf${i}`,
      el(p * V.membersPerProduct + ((V.chain + V.membersPerProduct - m) % V.membersPerProduct)),
      monitor.id,
      check,
      'freshness',
      now,
      by,
    ]);
  }
  await insert('dp_check_links', ['id', 'element_id', 'monitor_id', 'check_id', 'purpose', 'created_at', 'created_by'], links);
}

/** `count` products from number `from` on, of the shape described at seed(); their elements are the catalogue's from from × 15 on. */
async function seedProducts(from: number, count: number, now: string): Promise<void> {
  const { db } = await import('../src/db.js');
  const by = 'perf';
  const el = (n: number) => `dpe_perf${n}`;
  const products: unknown[][] = [];
  const members: unknown[][] = [];
  const envs: unknown[][] = [];
  const ports: unknown[][] = [];
  const bindings: unknown[][] = [];
  const portElements: unknown[][] = [];
  const steps: unknown[][] = [];
  const stepEnds: unknown[][] = [];
  for (let p = from; p < from + count; p++) {
    const id = `dpr_perf${p}`;
    ids.products.push(id);
    const key = `perf-${String(p).padStart(5, '0')}`;
    products.push([
      id,
      key,
      `Perf product ${p}`,
      `perf product ${String(p).padStart(5, '0')}`,
      ids.domains[p % 20],
      'active',
      'Measured.',
      '["user:dana"]',
      now,
      by,
      now,
      by,
    ]);
    envs.push([id, 'prod', 'available', now, by]);
    const first = p * V.membersPerProduct;
    for (let m = 0; m < V.membersPerProduct; m++) members.push([id, el(first + m), m === V.chain ? 'output' : m === 0 ? 'input' : 'internal', by, now]);
    ids.chainEnd.push(el(first + V.chain));
    // the chain within the product, and the step from the previous product's output
    for (let c = 0; c < V.chain; c++) {
      const sid = `dps_perf${p}_${c}`;
      steps.push([sid, `Step ${c}`, 'transform', now, by, now, by]);
      stepEnds.push([sid, el(first + c), 'in'], [sid, el(first + c + 1), 'out']);
    }
    if (p > 0) {
      const sid = `dps_perf${p}_in`;
      steps.push([sid, 'Ingest', 'ingest', now, by, now, by]);
      stepEnds.push([sid, el((p - 1) * V.membersPerProduct + V.chain), 'in'], [sid, el(first), 'out']);
    }
    ports.push([`dpp_perf${p}_out`, id, 'output', 'out', 'v1', 'active', null, now, by, now, by]);
    bindings.push([`dpb_perf${p}`, `dpp_perf${p}_out`, 'prod', now, by]);
    portElements.push([`dpb_perf${p}`, el(first + V.chain)]);
    if (p > 0) ports.push([`dpp_perf${p}_in`, id, 'input', 'in', '', 'active', `dpp_perf${p - 1}_out`, now, by, now, by]);
  }
  await insert(
    'dp_products',
    ['id', 'key', 'name', 'name_norm', 'domain_id', 'lifecycle', 'description', 'owners', 'created_at', 'created_by', 'updated_at', 'updated_by'],
    products,
  );
  await insert('dp_product_environments', ['product_id', 'environment', 'state', 'updated_at', 'updated_by'], envs);
  await insert('dp_members', ['product_id', 'element_id', 'role', 'added_by', 'added_at'], members);
  await insert(
    'dp_ports',
    ['id', 'product_id', 'direction', 'name', 'version', 'lifecycle', 'source_port_id', 'created_at', 'created_by', 'updated_at', 'updated_by'],
    ports.map((r) => r),
  );
  db().run("UPDATE dp_ports SET source_kind = 'port' WHERE source_port_id IS NOT NULL AND id LIKE 'dpp_perf%'");
  await insert('dp_port_bindings', ['id', 'port_id', 'environment', 'updated_at', 'updated_by'], bindings);
  await insert('dp_port_elements', ['binding_id', 'element_id'], portElements);
  await insert('dp_steps', ['id', 'name', 'step_kind', 'created_at', 'created_by', 'updated_at', 'updated_by'], steps);
  await insert('dp_step_elements', ['step_id', 'element_id', 'direction'], stepEnds);
}

/** Statements and time of one GET as dana: a warm-up, then the median of three. */
async function measure(url: string): Promise<{ statements: number; ms: number }> {
  await dana('GET', url);
  const times: number[] = [];
  let statements = -1;
  for (let i = 0; i < 3; i++) {
    counted.delete(`/api${url}`);
    const t0 = performance.now();
    await dana('GET', url);
    times.push(performance.now() - t0);
    statements = counted.get(`/api${url}`) ?? -1;
  }
  times.sort((a, b) => a - b);
  return { statements, ms: Math.round(times[1]!) };
}

/** What every request costs (sign-in, settings): a product that is not found. */
async function overhead(): Promise<number> {
  await dana('GET', '/data-products/dpr_none').catch(() => undefined);
  counted.delete('/api/data-products/dpr_none');
  await dana('GET', '/data-products/dpr_none').catch(() => undefined);
  return (counted.get('/api/data-products/dpr_none') ?? 99) - 1;
}

describe(`reads at volume (${V.elements.toLocaleString('en')} elements, ${V.products.toLocaleString('en')} products)`, () => {
  const report: Record<string, { statements: number; ms: number }> = {};
  const record = (name: string, r: { statements: number; ms: number }) => {
    report[name] = r;
    expect(r.ms, `${name}: ${r.ms} ms`).toBeLessThan(name.startsWith('product map') ? MAP_MS : READ_MS);
    return r;
  };

  it('a product costs a fixed number of statements, however many members and steps it has', async () => {
    const p = ids.products[Math.floor(V.products / 2)]!;
    const reads: [string, string][] = [
      ['product page', `/data-products/${p}`],
      ['members', `/data-products/${p}/members`],
      ['ports', `/data-products/${p}/ports`],
      ['steps (pipeline tab)', `/data-products/${p}/steps`],
      ['pipeline picture', `/data-products/${p}/views/pipeline`],
      ['scorecard', `/data-products/${p}/scorecard`],
      ['costs', `/data-products/${p}/costs`],
    ];
    const before: number[] = [];
    for (const [name, url] of reads) before.push(record(name, await measure(url)).statements);
    // the product grows: 300 more members of the catalogue and a step for each pair of them
    const now = new Date().toISOString();
    const extra = Array.from({ length: 300 }, (_, i) => `dpe_perf${V.elements - 1 - i}`);
    await insert(
      'dp_members',
      ['product_id', 'element_id', 'role', 'added_by', 'added_at'],
      extra.map((e) => [p, e, 'internal', 'perf', now]),
    );
    const steps = Array.from({ length: 150 }, (_, i) => [`dps_grow${i}`, `Grown ${i}`, 'transform', now, 'perf', now, 'perf']);
    await insert('dp_steps', ['id', 'name', 'step_kind', 'created_at', 'created_by', 'updated_at', 'updated_by'], steps);
    await insert(
      'dp_step_elements',
      ['step_id', 'element_id', 'direction'],
      steps.flatMap((x, i) => [
        [x[0], extra[2 * i], 'in'],
        [x[0], extra[2 * i + 1], 'out'],
      ]),
    );
    const after: number[] = [];
    for (const [name, url] of reads) after.push(record(`${name} (grown)`, await measure(url)).statements);
    expect(after).toEqual(before);
    // the product page: at most 25 beyond what every request costs (ADR 0036)
    // (0.24.0: one more – the Restricted scopes, read once per request by the shares of 0.23.0, ADR 0033)
    expect(report['product page (grown)']!.statements - (await overhead())).toBeLessThanOrEqual(26);
  }, 300_000);

  it('a page of the list costs about the same for 50 and 100 rows: one statement per kind of fact, never per row', async () => {
    const page = ((await dana('GET', '/data-products?limit=100')) as { items: { id: string }[] }).items.map((x) => x.id);
    expect(page).toHaveLength(100);
    const pairs: [string, (n: number) => string][] = [
      ['product list', (n) => `/data-products?limit=${n}`],
      ['product list by domain', (n) => `/data-products?limit=${n}&domain=${ids.domains[3]}`],
      ['list health', (n) => `/data-products/health?ids=${page.slice(0, n).join(',')}`],
      ['list facts', (n) => `/data-products/facts?ids=${page.slice(0, n).join(',')}`],
      ['element catalogue', (n) => `/data-elements?limit=${n}`],
      ['element prefix search', (n) => `/data-elements?limit=${n}&prefix=perf.s3.t01`],
      ['element text search', (n) => `/data-elements?limit=${n}&q=T0123`],
    ];
    for (const [name, url] of pairs) {
      const half = await measure(url(50));
      const full = record(name, await measure(url(100)));
      // a statement may be left out when a page holds nothing of a kind, lineage reads one per level it reaches; a
      // per-row read would add 50
      expect(full.statements, `${name}: ${full.statements} statements for 100 rows, ${half.statements} for 50`).toBeLessThanOrEqual(half.statements + 10);
      // the facts are the page's scorecards and costs: every part's evidence, read once for the page
      expect(full.statements, `${name}`).toBeLessThanOrEqual(name === 'list facts' ? 75 : 40);
    }
  }, 300_000);

  it('the map and lineage four steps deep stay within their statements and time; the map does not grow with the products', async () => {
    const lineage = record('lineage, 4 steps', await measure(`/data-elements/${ids.chainEnd[Math.floor(V.products / 2)]}/lineage?depth=4`));
    // one statement per depth level and direction, beside the reads of what the levels found (0.24.0: and the open
    // proposals of the lineage sources around them – three statements, whatever the depth)
    expect(lineage.statements).toBeLessThanOrEqual(42);
    const map = record('product map', await measure('/data-products/map'));
    expect(map.statements).toBeLessThanOrEqual(MAP_STATEMENTS);
    await seedProducts(V.products, 50, new Date().toISOString());
    // 50 more products (750 more members): IN lists are chunked by 500 ids (a statement more per chunk), never a
    // statement per product
    expect((await measure('/data-products/map')).statements).toBeLessThanOrEqual(map.statements + 10);
    console.log(`data products reads (${PERF ? 'SM_PERF' : 'everyday'} volume)`, JSON.stringify(report));
  }, 300_000);
});
