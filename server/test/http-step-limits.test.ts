import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Process http steps (v0.3.1): an answer larger than the step's limit (maxResponseMb, default 20 MB) fails the step
 * with a clear message instead of being read into memory whole, and a very large output is kept in the run as a
 * shortened copy (marked __truncated) while the run itself works with the full value.
 */

let s: TestServer;
let host: http.Server;
let platformId: string;
const MB = 1024 * 1024;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  host = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const mb = Number(u.searchParams.get('mb') ?? '1');
    // a JSON list of strings of 1 KB each, without content-length (chunked), so the limit is hit while reading
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('[');
    const item = JSON.stringify('x'.repeat(1022));
    for (let i = 0; i < mb * 1024; i++) res.write((i ? ',' : '') + item);
    res.end(']');
  });
  await new Promise<void>((r) => host.listen(0, '127.0.0.1', r));
  const p = await s.api('POST', '/platforms', {
    name: 'Big answers',
    kind: 'generic',
    baseUrl: `http://127.0.0.1:${(host.address() as AddressInfo).port}`,
    config: { auth: { type: 'none' }, variables: {}, http: { proxy: 'none', retry: { maxRetries: 0 } } },
  });
  platformId = p.id;
});
afterAll(async () => {
  host?.close();
  await s?.app.close();
});

const n = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, ...extra });
async function run(step: Record<string, unknown>, after: Record<string, unknown>[] = []) {
  const p = await s.api('POST', '/processes', {
    definition: {
      name: `big-${Math.random().toString(36).slice(2)}`,
      connections: [{ slot: 'api' }],
      inputs: [],
      nodes: [n('start', 'start'), n('call', 'http', { connection: 'api', method: 'GET', saveAs: 'res', ...step }), ...after],
      wires: [{ from: 'start', port: 'out', to: 'call' }, ...after.map((a) => ({ from: 'call', port: 'out', to: a.id }))],
    },
  });
  const { id } = await s.api('POST', '/runs', { processId: p.id, bindings: { api: platformId }, inputs: {} });
  return s.waitRun(id, ['succeeded', 'failed', 'cancelled']);
}

describe('http step answer size', () => {
  it('fails an answer above the default 20 MB with what to do', async () => {
    const r = await run({ path: '/big', query: { mb: 21 } });
    expect(r.status).toBe('failed');
    const call = r.steps.find((x: any) => x.key === 'call');
    expect(call.error).toMatch(/^The answer of GET \/big is larger than 20 MB, the step's limit \(maxResponseMb: default 20, at most 200\)/);
    expect(call.error).not.toContain('mb=21');
  }, 60_000);

  it('maxResponseMb raises the limit; a very large output is stored shortened, the run uses all of it', async () => {
    const r = await run({ path: '/big', query: { mb: 6 }, maxResponseMb: 10 }, [n('count', 'set', { values: { items: '{{ $count(vars.res.body) }}' } })]);
    expect(r.status).toBe('succeeded');
    const call = await s.api('GET', `/runs/${r.id}/steps/${r.steps.find((x: any) => x.key === 'call').id}?full=1`);
    expect(call.output.__truncated).toMatchObject({ chars: expect.any(Number) });
    expect(call.output.__truncated.chars).toBeGreaterThan(6 * MB);
    expect(call.output.status).toBe(200);
    // the next step saw the full list, not the stored copy
    const count = await s.api('GET', `/runs/${r.id}/steps/${r.steps.find((x: any) => x.key === 'count').id}`);
    expect(count.output).toMatchObject({ items: 6 * 1024 });
  }, 60_000);

  it('rejects a limit above 200 MB', async () => {
    await expect(
      s.api('POST', '/processes', {
        definition: {
          name: 'too-big',
          connections: [{ slot: 'api' }],
          inputs: [],
          nodes: [n('start', 'start'), n('call', 'http', { connection: 'api', method: 'GET', path: '/', maxResponseMb: 500 })],
          wires: [{ from: 'start', port: 'out', to: 'call' }],
        },
      }),
    ).rejects.toThrow(/maxResponseMb|200/);
  });
});
