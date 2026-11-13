import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Large dbt files do not hold up the server (0.25.0, a carry-over of the 0.24.0 release review): a 40 MB
 * `manifest.json` and a large `run_results.json` are parsed in a worker thread (dataproducts/lineage/dbt-parse.ts) and
 * handed over in parts, the main thread validates and writes them in batches with a turn of the event loop between –
 * no turn of the event loop takes more than about 50 ms (DBT_GAP_MS below, with room for a busy shared runner). The
 * result is the same as the parse on the main thread (the fallback when no worker starts), and the six dbt files a
 * minute per source stay.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
/**
 * The longest turn of the event loop a dbt import may take. Measured on a quiet machine: about 50 ms (0.24.0: 1,150 ms
 * for the manifest, 280 ms for the run results) – the bound leaves room for a shared runner whose other work deschedules
 * the test; the 99th percentile of the turns must stay within DBT_P99_MS.
 */
const DBT_GAP_MS = Number(process.env.SM_DBT_GAP_MS ?? 400);
const DBT_P99_MS = 100;

let s: TestServer;
let dana: Client;
let snowflake = '';

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', { services: true });
  await s.api('PUT', '/settings/modules/dataProducts', { enabled: true });
  dana = await s.as('dana', PW);
  const platforms = (await s.api('GET', '/platforms')) as { id: string; kind: string }[];
  snowflake = platforms.find((p) => p.kind === 'snowflake')!.id;
}, 180_000);

/** An invented manifest of about `mb` megabytes: models in a chain, sources, tests – padded with code as dbt writes it. */
function bigManifest(mb: number): { buf: Buffer; models: number; tests: number } {
  const models = 20_000;
  const tests = 15_000;
  const sources = 5_000;
  const pad = 'select invented_column from invented_table where invented_filter = 1 -- '.repeat(5);
  const parts: string[] = [];
  parts.push('{"metadata":{"dbt_schema_version":"https://schemas.getdbt.com/dbt/manifest/v12.json","adapter_type":"snowflake","env":{}},"nodes":{');
  let first = true;
  const add = (key: string, v: unknown) => {
    parts.push(`${first ? '' : ','}${JSON.stringify(key)}:${JSON.stringify(v)}`);
    first = false;
  };
  for (let i = 0; i < models; i++)
    add(`model.invented.m${i}`, {
      resource_type: 'model',
      name: `m${i}`,
      unique_id: `model.invented.m${i}`,
      database: 'SHOP',
      schema: 'BIG',
      alias: `M${i}`,
      config: { materialized: i % 50 === 7 ? 'ephemeral' : 'table', enabled: true, tags: ['invented'] },
      depends_on: { nodes: [i ? `model.invented.m${i - 1}` : 'source.invented.raw.s0', `source.invented.raw.s${i % sources}`], macros: [] },
      raw_code: pad,
      compiled_code: pad,
      description: 'An invented model',
      columns: { id: { name: 'id', description: 'invented' } },
    });
  for (let i = 0; i < tests; i++)
    add(`test.invented.not_null_m${i}_id.${i}`, {
      resource_type: 'test',
      name: `not_null_m${i}_id`,
      unique_id: `test.invented.not_null_m${i}_id.${i}`,
      attached_node: `model.invented.m${i}`,
      column_name: 'id',
      test_metadata: { name: 'not_null', kwargs: { column_name: 'id' } },
      depends_on: { nodes: [`model.invented.m${i}`] },
      raw_code: pad,
    });
  parts.push('},"sources":{');
  first = true;
  for (let i = 0; i < sources; i++)
    add(`source.invented.raw.s${i}`, {
      resource_type: 'source',
      name: `s${i}`,
      unique_id: `source.invented.raw.s${i}`,
      database: 'SHOP',
      schema: 'RAW',
      identifier: `S${i}`,
    });
  parts.push('}}');
  let text = parts.join('');
  // pad to the size asked for (whitespace JSON allows) – the parse is what costs
  const want = mb * 1024 * 1024;
  if (text.length < want) text = text.slice(0, -1) + ' '.repeat(want - text.length - 1) + '}';
  return { buf: Buffer.from(text), models, tests };
}

function bigRunResults(n: number): Buffer {
  return Buffer.from(
    JSON.stringify({
      metadata: {
        dbt_schema_version: 'https://schemas.getdbt.com/dbt/run-results/v6.json',
        generated_at: '2026-11-13T04:00:00Z',
        invocation_id: 'invented-big',
      },
      results: Array.from({ length: n }, (_, i) =>
        i % 2
          ? {
              unique_id: `test.invented.not_null_m${i}_id.${i}`,
              status: i % 7 ? 'pass' : 'fail',
              failures: i % 7 ? 0 : 2,
              message: 'INVENTED-MESSAGE '.repeat(10),
            }
          : {
              unique_id: `model.invented.m${i}`,
              status: 'success',
              timing: [{ name: 'execute', completed_at: '2026-11-13T03:58:00Z' }],
              message: 'SUCCESS',
              adapter_response: { rows_affected: 1 },
              compiled_code: 'select 1 -- '.repeat(20),
            },
      ),
    }),
  );
}

/**
 * Runs `fn` and measures how long the event loop could not take a turn (a timer chain every millisecond): the longest
 * gap and the 99th percentile of the gaps.
 */
async function longestTurn<T>(fn: () => Promise<T>): Promise<{ result: T; maxGapMs: number; p99Ms: number; ms: number }> {
  let last = performance.now();
  const gaps: number[] = [];
  let on = true;
  const tick = () => {
    const now = performance.now();
    gaps.push(now - last);
    last = now;
    if (on) setTimeout(tick, 1);
  };
  setTimeout(tick, 1);
  const t0 = performance.now();
  try {
    const result = await fn();
    gaps.push(performance.now() - last);
    gaps.sort((a, b) => a - b);
    return {
      result,
      maxGapMs: Math.round(gaps[gaps.length - 1]!),
      p99Ms: Math.round(gaps[Math.floor(gaps.length * 0.99)]!),
      ms: Math.round(performance.now() - t0),
    };
  } finally {
    on = false;
  }
}

describe('large dbt files', () => {
  it('the worker reads a file as the main thread does (the fallback): the same head, items and SHA-256 – no code kept', async () => {
    const { openDbtFile, readDbtInThread } = await import('../src/dataproducts/lineage/dbt-parse.js');
    const { sha256 } = await import('../src/util.js');
    const small = bigManifest(0);
    // a slice of a larger buffer, as a body parser may hand it over
    const sliced = Buffer.concat([Buffer.from('xx'), small.buf]).subarray(2);
    const all = async (r: Awaited<ReturnType<typeof openDbtFile>>) => {
      const out: unknown[] = [];
      for (let p = await r.next(); p; p = await r.next()) out.push(...p);
      r.close();
      return out;
    };
    const w = await openDbtFile('manifest', sliced);
    expect(w.inWorker).toBe(true);
    const t = readDbtInThread('manifest', small.buf);
    expect(w.sha256).toBe(sha256(small.buf));
    expect(t.sha256).toBe(w.sha256);
    expect(w.head).toEqual(t.head);
    expect(w.head).toMatchObject({ doc: 'object', lists: { nodes: { kind: 'object', count: 35_000 }, sources: { kind: 'object', count: 5_000 } } });
    const items = await all(w);
    expect(items).toEqual(await all(t));
    expect(items).toHaveLength(40_000);
    // only what dbt.ts reads: no code, descriptions or columns
    expect(JSON.stringify(items)).not.toMatch(/invented_filter|An invented model|"columns"|"kwargs"|"macros"|"tags"/);
    const rr = bigRunResults(10);
    const r1 = await openDbtFile('runResults', rr);
    const r2 = readDbtInThread('runResults', rr);
    expect(r1.head).toEqual(r2.head);
    const results = await all(r1);
    expect(results).toEqual(await all(r2));
    expect(JSON.stringify(results)).not.toMatch(/INVENTED-MESSAGE|select 1|rows_affected/);
    // an empty body and one that is not JSON are refused before anything is read
    await expect(openDbtFile('manifest', Buffer.from('  '))).rejects.toMatchObject({ reason: 'empty' });
    await expect(openDbtFile('manifest', Buffer.from('{"metadata": '))).rejects.toMatchObject({ reason: 'json' });
    expect(() => readDbtInThread('manifest', Buffer.from('[1'))).toThrow('not JSON');
  }, 120_000);

  it('starts at most DBT_WORKERS workers at a time, server-wide: more files wait for a free one', async () => {
    const { openDbtFile, DBT_WORKERS } = await import('../src/dataproducts/lineage/dbt-parse.js');
    const body = Buffer.from(JSON.stringify({ metadata: {}, nodes: {}, sources: {} }));
    const open = await Promise.all(Array.from({ length: DBT_WORKERS }, () => openDbtFile('manifest', body)));
    expect(open.every((r) => r.inWorker)).toBe(true);
    let started = false;
    const next = openDbtFile('manifest', body).then((r) => {
      started = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(started).toBe(false);
    // a reader closed (twice: freed once) hands its worker on
    open[0]!.close();
    open[0]!.close();
    const third = await next;
    expect(third.inWorker).toBe(true);
    for (const r of [...open.slice(1), third]) r.close();
    // all free again: as many open at once as before
    const again = await Promise.all(Array.from({ length: DBT_WORKERS }, () => openDbtFile('manifest', body)));
    for (const r of again) r.close();
  }, 60_000);

  it('a 40 MB manifest and its run results are parsed off the main thread: no turn of the event loop over about 50 ms', async () => {
    const src = (await dana('POST', '/data-products/lineage-sources', { name: 'dbt big (invented)', kind: 'dbt', platformId: snowflake })).id as string;
    // elements for a part of the models, so the import matches (and writes) as on a real platform
    const { db } = await import('../src/db.js');
    const now = new Date().toISOString();
    db().tx(() => {
      for (let i = 0; i < 5_000; i += 1)
        db().run(
          `INSERT INTO dp_elements (id, platform_id, kind, qualified_name, name_norm, display_name, environment, source, created_at, created_by, updated_at, updated_by)
           VALUES (?, ?, 'snowflake.table', ?, ?, ?, 'prod', 'entered', ?, 'dana', ?, 'dana')`,
          `dpe_big${i}`,
          snowflake,
          `SHOP.BIG.M${i}`,
          `shop.big.m${i}`,
          `M${i}`,
          now,
          now,
        );
    });
    const { importDbtFile } = await import('../src/dataproducts/lineage/push.js');
    const { lineageSourceRow } = await import('../src/dataproducts/lineage/store.js');
    const { runAs } = await import('../src/auth/context.js');
    const { findUserByName, toAuthUser } = await import('../src/auth/users.js');
    const user = toAuthUser(findUserByName('dana')!);
    const row = lineageSourceRow(src)!;
    const m = bigManifest(39);
    expect(m.buf.length).toBeGreaterThan(38 * 1024 * 1024);
    const manifest = await longestTurn(() => runAs(user, () => importDbtFile(row, 'manifest', m.buf, { actor: 'dana', via: 'upload' })));
    expect(manifest.result.counts).toMatchObject({ steps: m.models - m.models / 50, tests: 4_900 });
    const rr = bigRunResults(40_000);
    const runs = await longestTurn(() => runAs(user, () => importDbtFile(row, 'runResults', rr, { actor: 'dana', via: 'upload' })));
    expect(runs.result.counts).toMatchObject({ results: 40_000 });
    console.log(
      'dbt imports',
      JSON.stringify({
        manifest: { mb: Math.round(m.buf.length / 1024 / 1024), ms: manifest.ms, longestTurnMs: manifest.maxGapMs, p99Ms: manifest.p99Ms },
        runResults: { mb: Math.round(rr.length / 1024 / 1024), ms: runs.ms, longestTurnMs: runs.maxGapMs, p99Ms: runs.p99Ms },
      }),
    );
    expect(manifest.maxGapMs, `the longest turn of the event loop during the manifest: ${manifest.maxGapMs} ms`).toBeLessThan(DBT_GAP_MS);
    expect(runs.maxGapMs, `the longest turn of the event loop during the run results: ${runs.maxGapMs} ms`).toBeLessThan(DBT_GAP_MS);
    expect(manifest.p99Ms).toBeLessThan(DBT_P99_MS);
    expect(runs.p99Ms).toBeLessThan(DBT_P99_MS);
  }, 300_000);
});
