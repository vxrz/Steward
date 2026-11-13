import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Large data product imports run in the background (0.25.0, a carry-over of the 0.24.0 release review): an import of
 * 20,000 elements held the server for several seconds in one transaction. Now an import of more than
 * DATA_PRODUCT_IMPORT_JOB_ELEMENTS elements answers 202 with a job, writes its elements in short transactions with a
 * turn of the event loop between and everything else in one transaction; progress is read from the job. A failure
 * takes back what it wrote – all or nothing for the person importing; so does the next run of the job `data-products`
 * for an import a stopped server left running. Another import waits (409).
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
/** The longest turn of the event loop while a job runs (the plan and the last transaction are the longest; a shared runner deschedules the test now and then) */
const IMPORT_GAP_MS = Number(process.env.SM_IMPORT_GAP_MS ?? 3_000);
let s: TestServer;
let dana: Client;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', { services: true });
  await s.api('PUT', '/settings/modules/dataProducts', { enabled: true });
  dana = await s.as('dana', PW);
}, 180_000);

const fail = async (p: Promise<unknown>): Promise<{ status: number; code: string; params: Record<string, unknown> }> => {
  try {
    await p;
  } catch (e) {
    const err = e as { status: number; body?: { code?: string; params?: Record<string, unknown> } };
    return { status: err.status, code: err.body?.code ?? '', params: err.body?.params ?? {} };
  }
  throw new Error('expected a refusal');
};

/** `n` invented elements and products with members among them (`extra`: more fields of the first product). */
function bigFile(tag: string, n: number, products: number, members: number, extra: Record<string, unknown> = {}): string {
  const el = (i: number) => ({ kind: 'other', qualified_name: `INVENTED.${tag}.T${i}`, environment: 'prod', layer: 'raw', type_label: 'Invented extract' });
  return JSON.stringify({
    version: 1,
    elements: Array.from({ length: n }, (_, i) => el(i)),
    data_products: Array.from({ length: products }, (_, p) => ({
      key: `invented-${tag.toLowerCase()}-${p}`,
      name: `Invented ${tag} ${p}`,
      ...(p === 0 ? extra : {}),
      members: Array.from({ length: members }, (_, i) => ({
        element: { kind: 'other', qualified_name: `INVENTED.${tag}.T${p * members + i}`, environment: 'prod' },
        role: 'internal',
      })),
    })),
  });
}

/** The longest gap between turns of the event loop while `fn` runs (a timer chain every millisecond). */
async function longestTurn<T>(fn: () => Promise<T>): Promise<{ result: T; maxGapMs: number; ms: number }> {
  let last = performance.now();
  let max = 0;
  let on = true;
  const tick = () => {
    const now = performance.now();
    max = Math.max(max, now - last);
    last = now;
    if (on) setTimeout(tick, 1);
  };
  setTimeout(tick, 1);
  const t0 = performance.now();
  try {
    const result = await fn();
    return { result, maxGapMs: Math.round(Math.max(max, performance.now() - last)), ms: Math.round(performance.now() - t0) };
  } finally {
    on = false;
  }
}

async function until(id: string): Promise<Record<string, any>> {
  const { importJobDone } = await import('../src/dataproducts/import-jobs.js');
  await importJobDone(id);
  return dana('GET', `/data-products/import/jobs/${id}`);
}

const elementCount = async (tag: string) => {
  const { db } = await import('../src/db.js');
  return Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM dp_elements WHERE name_norm LIKE ?', `invented.${tag.toLowerCase()}.%`)!.n);
};

describe('large imports', () => {
  it('20,000 elements run as a background job with progress – the event loop keeps turning', async () => {
    const files = [{ name: 'big.json', content: bigFile('BIG', 20_000, 4, 1_000) }];
    const preview = await dana('POST', '/data-products/import/preview', { files, mode: 'update' });
    expect(preview.counts).toMatchObject({ add: 20_004, change: 0 });
    const run = await longestTurn(async () => {
      const r = await dana('POST', '/data-products/import', { files, mode: 'update', fingerprint: preview.fingerprint });
      return { r, job: await until(r.job.id) };
    });
    const { r, job } = run.result;
    expect(r.job).toMatchObject({ state: 'running', phase: 'elements', total: 20_000, mode: 'update', createdBy: 'dana' });
    expect(job).toMatchObject({ state: 'succeeded', phase: 'done', done: 20_000, total: 20_000, error: null, result: { counts: { add: 20_004 } } });
    const { lastJobTimes } = await import('../src/dataproducts/import-jobs.js');
    console.log('import job', JSON.stringify({ elements: 20_000, members: 4_000, ms: run.ms, longestTurnMs: run.maxGapMs, ...lastJobTimes }));
    // the element batches are short (25 ms each on a quiet machine, the bound leaves room for a busy runner); the plan and the last
    // transaction are the longest turns – together far below the one transaction of 0.24.0 (about 9 s)
    expect(lastJobTimes.longestBatchMs).toBeLessThan(500);
    expect(run.maxGapMs, `the longest turn of the event loop: ${run.maxGapMs} ms`).toBeLessThan(IMPORT_GAP_MS);
    expect(await elementCount('BIG')).toBe(20_000);
    const { db } = await import('../src/db.js');
    const p = db().get<{ id: string }>("SELECT id FROM dp_products WHERE key = 'invented-big-3'")!;
    expect((await dana('GET', `/data-products/${p.id}`)).memberCounts).toMatchObject({ internal: 1_000 });
    // only the person who started it reads the job; the journal is gone once it succeeded
    const vera = await s.as('vera', PW);
    expect(await fail(vera('GET', `/data-products/import/jobs/${r.job.id}`))).toMatchObject({ status: 404, code: 'DATA_PRODUCT_IMPORT_JOB_NOT_FOUND' });
    expect(Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM dp_import_job_elements')!.n)).toBe(0);
    // the same file again writes nothing (no job: no element to write)
    expect(await dana('POST', '/data-products/import', { files, mode: 'update' })).toMatchObject({ counts: { add: 0, unchanged: 20_004 } });
  }, 600_000);

  it('a job that fails takes back what it wrote: all or nothing; another import waits meanwhile', async () => {
    // an element the import changes gets its fields back
    await dana('POST', '/data-products/import', {
      files: [
        {
          name: 'one.json',
          content: JSON.stringify({ version: 1, elements: [{ kind: 'other', qualified_name: 'INVENTED.UNDO.T5', environment: 'prod', layer: 'mart' }] }),
        },
      ],
      mode: 'add',
    });
    // an active product needs an owner and an output port: the services refuse it in the last transaction
    const files = [{ name: 'undo.json', content: bigFile('UNDO', 3_000, 1, 10, { lifecycle: 'active' }) }];
    const r = await dana('POST', '/data-products/import', { files, mode: 'update' });
    expect(r.job.state).toBe('running');
    // while it runs, another import is refused
    expect(await fail(dana('POST', '/data-products/import', { files: [{ name: 'x.json', content: '{"version":1}' }], mode: 'add' }))).toMatchObject({
      status: 409,
      code: 'DATA_PRODUCT_IMPORT_RUNNING',
    });
    const job = await until(r.job.id);
    expect(job).toMatchObject({ state: 'failed', phase: 'done', undone: { removed: 2_999, restored: 1, kept: 0 } });
    expect(job.error.message).toMatch(/owner|output port/i);
    expect(await elementCount('UNDO')).toBe(1);
    const { db } = await import('../src/db.js');
    expect(db().get<{ layer: string }>("SELECT layer FROM dp_elements WHERE name_norm = 'invented.undo.t5'")!.layer).toBe('mart');
    expect(db().get("SELECT 1 FROM dp_products WHERE key = 'invented-undo-0'")).toBeUndefined();
    expect(db().get("SELECT summary FROM audit_log WHERE action = 'dataproduct.import_rolled_back' ORDER BY seq DESC LIMIT 1")).toMatchObject({
      summary: expect.stringContaining('2999 element(s) removed, 1 restored'),
    });
  }, 600_000);

  it('a failed job gives a generic part back its technology, namespace and properties (0.25.0, packages A and C)', async () => {
    const generic = (technology: string, namespace: string, value: string) => ({
      kind: 'generic.dataset',
      qualified_name: 'INVENTED.UNDOG.FEED',
      environment: 'prod',
      technology,
      namespace,
      properties: [{ key: 'flow', value }],
    });
    await dana('POST', '/data-products/import', {
      files: [{ name: 'g.json', content: JSON.stringify({ version: 1, elements: [generic('postgresql', 'postgres://db-a.invented.example:5432', 'a')] }) }],
      mode: 'add',
    });
    const others = Array.from({ length: 1_200 }, (_, i) => ({ kind: 'other', qualified_name: `INVENTED.UNDOG.T${i}`, environment: 'prod' }));
    const content = JSON.stringify({
      version: 1,
      elements: [generic('mysql', 'mysql://db-b.invented.example:3306', 'b'), ...others],
      // an active product without an owner and an output port: refused in the last transaction
      data_products: [{ key: 'invented-undog', name: 'Invented undo generic', lifecycle: 'active' }],
    });
    const r = await dana('POST', '/data-products/import', { files: [{ name: 'undog.json', content }], mode: 'update' });
    expect(r.job.state).toBe('running');
    const job = await until(r.job.id);
    expect(job).toMatchObject({ state: 'failed', undone: { removed: 1_200, restored: 1, kept: 0 } });
    const { db } = await import('../src/db.js');
    expect(
      db().get("SELECT technology, properties, ol_namespace, ol_name FROM dp_elements WHERE kind = 'generic.dataset' AND name_norm = 'invented.undog.feed'"),
    ).toEqual({
      technology: 'postgresql',
      properties: JSON.stringify([{ key: 'flow', value: 'a' }]),
      ol_namespace: 'postgres://db-a.invented.example:5432',
      ol_name: 'INVENTED.UNDOG.FEED',
    });
  }, 600_000);

  it('a job a stopped server left running is taken back by the next run of the job', async () => {
    const { db } = await import('../src/db.js');
    const now = new Date().toISOString();
    db().tx(() => {
      db().run(
        "INSERT INTO dp_import_jobs (id, state, phase, done, total, mode, created_by, created_at) VALUES ('dpj_stale', 'running', 'elements', 2, 1200, 'add', 'dana', ?)",
        now,
      );
      for (const i of [1, 2]) {
        db().run(
          `INSERT INTO dp_elements (id, platform_id, kind, qualified_name, name_norm, display_name, environment, source, created_at, created_by, updated_at, updated_by)
           VALUES (?, '', 'other', ?, ?, 'x', 'prod', 'imported', ?, 'dana', ?, 'dana')`,
          `dpe_stale${i}`,
          `INVENTED.STALE.T${i}`,
          `invented.stale.t${i}`,
          now,
          now,
        );
        db().run('INSERT INTO dp_import_job_elements (job_id, element_id, before) VALUES (?, ?, NULL)', 'dpj_stale', `dpe_stale${i}`);
      }
    });
    // an import refuses while it is there – and starts taking it back
    expect(await fail(dana('POST', '/data-products/import', { files: [{ name: 'x.json', content: '{"version":1}' }], mode: 'add' }))).toMatchObject({
      status: 409,
    });
    const { runDataProductsJob } = await import('../src/dataproducts/discovery/job.js');
    await runDataProductsJob();
    expect(await dana('GET', '/data-products/import/jobs/dpj_stale')).toMatchObject({
      state: 'failed',
      error: { params: { context: 'interrupted' } },
      undone: { removed: 2 },
    });
    expect(await elementCount('STALE')).toBe(0);
  }, 120_000);
});
