import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * PDFs are drawn in a worker thread (#13): one at a time, stopped after the time limit, refused when too many wait,
 * drawn in the main thread when the worker cannot start or is turned off – and meanwhile Steward keeps answering.
 */

let s: TestServer;
let pool: typeof import('../src/reports/pdf/pool.js');
let config: typeof import('../src/config.js').config;
const saved = { timeoutMs: 0, queue: 0 };

/** Random letters with few spaces: slow to break into lines (about 7 s for 200 000 characters on one thread). */
const slowText = (n: number) =>
  Array.from({ length: n }, () => (Math.random() < 0.15 ? ' ' : String.fromCharCode(97 + Math.floor(Math.random() * 26)))).join('');

async function record(body: string): Promise<string> {
  return (await s.api('POST', '/records', { type: 'ADR', title: `PDF worker ${Math.random().toString(36).slice(2, 8)}`, body })).id;
}
const pdfOf = (id: string) => s.api('POST', `/records/${id}/pdf`, {});

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  pool = await import('../src/reports/pdf/pool.js');
  config = (await import('../src/config.js')).config;
  saved.timeoutMs = pool.PDF_LIMITS.timeoutMs;
  saved.queue = pool.PDF_LIMITS.queue;
});
afterEach(async () => {
  pool.PDF_LIMITS.timeoutMs = saved.timeoutMs;
  pool.PDF_LIMITS.queue = saved.queue;
  config.pdfWorker = 'auto';
  await pool.resetPdfWorker();
});
afterAll(async () => {
  await s?.app.close();
});

describe('the PDF worker', () => {
  it('draws the PDF of a record in the worker', async () => {
    const pdf = await pdfOf(await record('## Text\n\nA short decision.'));
    expect(pdf.filename).toMatch(/\.pdf$/);
    expect(pool.pdfWorkerStatus()).toMatchObject({ mode: 'auto', worker: 'running', reason: null });
  });

  it('keeps answering other requests while a large PDF is drawn', async () => {
    const id = await record(slowText(60_000));
    const drawing = pdfOf(id);
    // the PDF takes a few seconds; health checks in the meantime answer at once
    await new Promise((r) => setTimeout(r, 300));
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      const res = await fetch(`${s.base}/api/health`);
      expect(res.status).toBe(200);
      times.push(Date.now() - t0);
    }
    expect(Math.max(...times)).toBeLessThan(500);
    await drawing;
  });

  it('stops a PDF that takes longer than the time limit, and the next one works', async () => {
    pool.PDF_LIMITS.timeoutMs = 300;
    const slow = await record(slowText(200_000));
    await expect(pdfOf(slow)).rejects.toThrow(/PDF_TIMEOUT|took longer than 0.3 s/);
    pool.PDF_LIMITS.timeoutMs = saved.timeoutMs;
    const pdf = await pdfOf(await record('Short.'));
    expect(pdf.filename).toMatch(/\.pdf$/);
  });

  it('refuses a PDF when too many are waiting', async () => {
    pool.PDF_LIMITS.queue = 0;
    const id = await record(slowText(20_000));
    // the first is drawn at once; with nothing allowed to wait, the second one is refused
    const first = pdfOf(id);
    await new Promise((r) => setTimeout(r, 200));
    await expect(pdfOf(id)).rejects.toThrow(/PDF_BUSY|creating other PDFs/);
    await first;
  });

  it('draws in the main thread when the worker cannot start, and says why', async () => {
    await pool.resetPdfWorker({ source: new URL('./no-such-worker.mjs', import.meta.url) });
    const pdf = await pdfOf(await record('Short.'));
    expect(pdf.filename).toMatch(/\.pdf$/);
    expect(pool.pdfWorkerStatus()).toMatchObject({ worker: 'unavailable' });
    expect(pool.pdfWorkerStatus().reason).toBeTruthy();
  });

  it('draws in the main thread with SM_PDF_WORKER=off', async () => {
    config.pdfWorker = 'off';
    const pdf = await pdfOf(await record('Short.'));
    expect(pdf.filename).toMatch(/\.pdf$/);
    expect(pool.pdfWorkerStatus()).toMatchObject({ mode: 'off', worker: 'off' });
  });

  it('an error of the drawing keeps its status and code (a record too large for a PDF)', async () => {
    const { reviveBuffers, toWorkerError } = await import('../src/reports/pdf/pool.js');
    const { HttpError } = await import('../src/util.js');
    expect(toWorkerError(new HttpError(413, 'too large', 'RECORD_TOO_LARGE', { number: 'ADR-1' }))).toMatchObject({
      statusCode: 413,
      code: 'RECORD_TOO_LARGE',
      params: { number: 'ADR-1' },
    });
    // Buffers come back as Buffers, also inside objects and arrays
    const back = reviveBuffers({ a: [new Uint8Array([1, 2])], b: { c: new Uint8Array([3]) } });
    expect(Buffer.isBuffer(back.a[0])).toBe(true);
    expect(Buffer.isBuffer(back.b.c)).toBe(true);
  });
});
