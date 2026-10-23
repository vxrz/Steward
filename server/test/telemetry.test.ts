import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { setup, startTestServer, type TestServer } from './helpers.js';

const exporter = new InMemorySpanExporter();
let s: TestServer;

beforeAll(async () => {
  s = await startTestServer(); // sets demo env before config is loaded
  const { initTelemetry } = await import('../src/telemetry.js');
  initTelemetry({ exporter, simple: true });
  await setup(s);
  await s.api('POST', '/demo/setup', {});
});
afterAll(async () => {
  await s?.app.close();
});

describe('OpenTelemetry tracing', () => {
  it('emits run, node and HTTP client spans in one trace', async () => {
    exporter.reset();
    const hub = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'insights-hub').id;
    const { id } = await s.api('POST', '/runs', { processId: 'ih-health-check', bindings: { hub } });
    await s.waitRun(id, ['succeeded', 'failed']);
    await new Promise((r) => setTimeout(r, 100));
    const spans = exporter.getFinishedSpans();
    const run = spans.find((sp) => sp.name.startsWith('run ') && sp.attributes['sm.run.id'] === id)!;
    expect(run).toBeTruthy();
    const nodes = spans.filter((sp) => sp.name.startsWith('node ') && sp.attributes['sm.run.id'] === id);
    expect(nodes.length).toBeGreaterThanOrEqual(5);
    for (const n of nodes) expect(n.spanContext().traceId).toBe(run.spanContext().traceId);
    const http = spans.filter((sp) => sp.name.startsWith('HTTP ') && sp.spanContext().traceId === run.spanContext().traceId);
    expect(http.length).toBeGreaterThanOrEqual(2);
    expect(http.some((h) => h.attributes['http.response.status_code'] === 200)).toBe(true);
    expect(String(http[0]!.attributes['url.full'])).not.toContain('?');
  });
});
