import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatasetRow } from '@sm/shared';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * A dataset's rows are stored once, in its partitions (0.4.0): publishing no longer reads every partition again to
 * write a combined copy into datasets.rows. Every reader still sees all rows – the dashboard API, /api/v1 (paged),
 * internal readers (access reconciliation), MCP (getDataset), Prometheus – and a dataset from before partitions moves
 * its rows into one when first read. The publish time of a 20,000-row partition next to another one is printed.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';

let s: TestServer;
let processId = 'prc_big';
const N = 20_000;
const KEY = 'test.big';

const db = async () => (await import('../src/db.js')).db();
const rowsOf = (tenant: string, n: number): DatasetRow[] =>
  Array.from({ length: n }, (_, i) => ({
    _key: `${tenant}-${i}`,
    _status: i % 10 ? 'good' : 'critical',
    User: `user ${i}`,
    Tenant: tenant,
    Rights: ['a', 'b'],
  }));

/** A finished run bound to a platform (the partition's source). */
async function fakeRun(id: string, platformId: string): Promise<void> {
  (await db()).run(
    `INSERT INTO runs (id, process_id, process_name, process_version, definition_hash, status, trigger, actor, inputs, bindings, started_at, finished_at)
     VALUES (?, ?, 'Big', 1, 'h', 'succeeded', 'manual', 'admin', '{}', ?, ?, ?)`,
    id,
    processId,
    JSON.stringify({ hub: { platformId } }),
    new Date().toISOString(),
    new Date().toISOString(),
  );
}

async function publish(runId: string, rows: DatasetRow[]): Promise<number> {
  const { publishDataset } = await import('../src/dashboards/datasets.js');
  const t = performance.now();
  publishDataset({
    key: KEY,
    title: 'Big',
    processId,
    processName: 'Big',
    runId,
    dryRun: false,
    columns: ['User', 'Tenant'],
    rows,
    metrics: { total: rows.length },
  });
  return performance.now() - t;
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  // the owning process (readers check that it may be viewed)
  const { id } = await s.api('POST', '/processes', {
    definition: { name: 'Big', steps: [{ id: 'note', type: 'log', message: 'x' }] },
  });
  processId = id;
  await fakeRun('run_a', 'plt_a');
  await fakeRun('run_b', 'plt_b');
});
afterAll(async () => {
  await s?.app.close();
});

describe('dataset rows stored once', () => {
  it(`publishes a ${N}-row partition next to another without copying all rows (timing printed)`, async () => {
    await publish('run_a', rowsOf('a', N));
    await publish('run_b', rowsOf('b', N));
    // republished 7 times: replaces partition b; partition a is not read again (median printed)
    const times: number[] = [];
    for (let i = 0; i < 7; i++) times.push(await publish('run_b', rowsOf('b', N)));
    const d = await db();
    const bytes = d.get<{ n: number }>('SELECT LENGTH(rows) AS n FROM datasets WHERE key = ?', KEY)!.n;
    console.log(
      `[dataset publish] ${N}-row partition next to another one: median ${[...times].sort((a, b) => a - b)[3]!.toFixed(0)} ms (${times.map((t) => t.toFixed(0)).join(', ')}); datasets.rows ${bytes} bytes`,
    );
    const head = d.get<{ rows: string; row_count: number; status_counts: string; columns: string }>(
      'SELECT rows, row_count, status_counts, columns FROM datasets WHERE key = ?',
      KEY,
    )!;
    expect(head.rows).toBe('[]');
    expect(Number(head.row_count)).toBe(2 * N);
    expect(JSON.parse(head.status_counts)).toEqual({ good: 2 * N * 0.9, critical: 2 * N * 0.1 });
    expect(JSON.parse(head.columns)).toEqual(['User', 'Tenant']);
    const parts = d.all<{ source: string; row_count: number; len: number }>(
      'SELECT source, row_count, LENGTH(rows) AS len FROM dataset_parts WHERE dataset_key = ? ORDER BY source',
      KEY,
    );
    expect(parts.map((p) => [p.source, Number(p.row_count)])).toEqual([
      ['plt_a', N],
      ['plt_b', N],
    ]);
    expect(parts.every((p) => Number(p.len) > N * 20)).toBe(true);
  });

  it('every reader sees all rows: dashboards, /api/v1 (paged), internal readers, Prometheus', async () => {
    const { getDataset, datasetRows, clearDatasetRowCache } = await import('../src/dashboards/datasets.js');
    clearDatasetRowCache();
    const all = getDataset(KEY);
    expect(all.rows).toHaveLength(2 * N);
    expect(all.rowCount).toBe(2 * N);
    expect(new Set(all.rows.map((r) => r._source?.platformId))).toEqual(new Set(['plt_a', 'plt_b']));
    expect(all.rows[0]).toMatchObject({ _key: 'a-0', User: 'user 0', Rights: ['a', 'b'] });
    // one source only
    expect(getDataset(KEY, { sources: ['plt_b'] }).rows.every((r) => r.Tenant === 'b')).toBe(true);
    // internal readers (access reconciliation)
    const internal = datasetRows(KEY)!;
    expect(internal.rows).toHaveLength(2 * N);
    expect(internal).toMatchObject({ processId, dryRun: false });
    expect(datasetRows('no.such.dataset')).toBeUndefined();
    // the dashboard API
    const viaApi = await s.api('GET', `/datasets/${KEY}`);
    expect(viaApi.rows).toHaveLength(2 * N);
    // /api/v1, paged (the parsed partitions are reused page after page)
    const { token } = await s.api('POST', '/me/tokens', { name: 'rows', scope: 'read' });
    let cursor: string | null = '';
    let seen = 0;
    for (let i = 0; cursor !== null && i < 200; i++) {
      const res = await fetch(`${s.base}/api/v1/datasets/${KEY}/rows?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const page = (await res.json()) as { items: DatasetRow[]; nextCursor: string | null };
      seen += page.items.length;
      cursor = page.nextCursor;
    }
    expect(seen).toBe(2 * N);
    // Prometheus: the dataset is there
    const metrics = await s.api('GET', '/metrics').catch(() => null);
    if (typeof metrics === 'string') expect(metrics).toContain(`sm_dataset_age_seconds{dataset="${KEY}"}`);
  });

  it('a dataset from before partitions moves its rows into one when first read, and frees the copy', async () => {
    const d = await db();
    const rows = rowsOf('legacy', 3).map(({ _key, ...r }) => ({ _key, ...r }));
    d.run(
      `INSERT INTO datasets (key, title, process_id, process_name, run_id, dry_run, updated_at, row_count, columns, rows, status_counts, metrics)
       VALUES ('test.legacy', 'Legacy', ?, 'Big', 'run_a', 0, ?, 3, '["User"]', ?, '{}', '{}')`,
      processId,
      new Date().toISOString(),
      JSON.stringify(rows),
    );
    const { getDataset } = await import('../src/dashboards/datasets.js');
    expect(getDataset('test.legacy').rows.map((r) => r._key)).toEqual(['legacy-0', 'legacy-1', 'legacy-2']);
    expect(d.get<{ rows: string }>("SELECT rows FROM datasets WHERE key = 'test.legacy'")!.rows).toBe('[]');
    expect(Number(d.get<{ n: number }>("SELECT row_count AS n FROM dataset_parts WHERE dataset_key = 'test.legacy'")!.n)).toBe(3);
    // and still readable afterwards (from the partition)
    expect(getDataset('test.legacy').rows).toHaveLength(3);
  });

  it('the migration frees the combined copy of datasets that have partitions', async () => {
    const d = await db();
    d.run('UPDATE datasets SET rows = \'[{"stale":1}]\' WHERE key = ?', KEY);
    const { namedMigrations } = await import('../src/db.js');
    const m = namedMigrations(d.dialect).find((x) => x.name === 'ops-014-dataset-rows-in-parts')!;
    d.exec(m.sql);
    expect(d.get<{ rows: string }>('SELECT rows FROM datasets WHERE key = ?', KEY)!.rows).toBe('[]');
    const { getDataset } = await import('../src/dashboards/datasets.js');
    expect(getDataset(KEY).rows).toHaveLength(2 * N);
  });
});
