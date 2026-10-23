import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

let s: TestServer;
let adam: Client;
const P: Record<string, string> = {};

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const demo = await s.api('POST', '/demo/setup', {});
  adam = await s.as('adam', demo.password);
  for (const p of await s.api('GET', '/platforms')) P[p.name] = p.id;
});
afterAll(async () => {
  await s?.app.close();
});

async function run(processId: string, bindings: Record<string, string>, inputs: Record<string, unknown> = {}, dryRun = false) {
  const { id } = await s.api('POST', '/runs', { processId, bindings, inputs, dryRun });
  return s.waitRun(id);
}
const step = (r: any, stepId: string) => r.steps.find((x: any) => x.stepId === stepId);

/** The body Gatus' custom alerting provider sends with the configuration from docs/GATUS.md. */
function gatusAlert(state: 'TRIGGERED' | 'RESOLVED', url: string) {
  // Gatus replaces the placeholders verbatim; in [RESULT_ERRORS] it escapes double quotes only
  return `{
  "event": "${state}",
  "name": "Historian API",
  "group": "plant",
  "url": "${url}",
  "description": "historian health check failed",
  "errors": "[STATUS] (503) == 200,[BODY].status (DOWN) == UP"
}`;
}

describe('Gatus package', () => {
  it('offers a Gatus connector preset with its API spec', async () => {
    const presets = await s.api('GET', '/platform-presets');
    const gatus = presets.find((p: any) => p.kind === 'gatus');
    expect(gatus).toMatchObject({ specCount: 1, config: { auth: { type: 'none' } } });
    expect(gatus.secretFields.map((f: any) => f.key)).toEqual(['username', 'password', 'token', 'externalToken']);
    const created = await s.api('POST', '/platforms', { name: 'Gatus (prod)', kind: 'gatus', baseUrl: 'https://status.example.com', config: gatus.config });
    const ops = await s.api('GET', `/platforms/${created.id}/operations`);
    expect(ops.map((o: any) => `${o.method} ${o.path}`)).toEqual(
      expect.arrayContaining(['GET /api/v1/endpoints/statuses', 'POST /api/v1/endpoints/{key}/external', 'GET /api/v1/endpoints/{key}/uptimes/{duration}']),
    );
    await s.api('DELETE', `/platforms/${created.id}`);
  });

  it('the demo Gatus requires basic auth on the status API, like security.basic', async () => {
    const res = await fetch(`${s.base}/mock/gatus/api/v1/endpoints/statuses`);
    expect(res.status).toBe(401);
    const test = await s.api('POST', `/platforms/${P['Gatus (demo)']}/test`);
    expect(test.ok).toBe(true);
  });

  it('uptime overview: computes uptime from the returned results when asked to', async () => {
    const r = await run('gatus-uptime-overview', { gatus: P['Gatus (demo)']! }, { uptimeWindow: 'results', resultsPerEndpoint: 30 });
    expect(r.status).toBe('succeeded');
    expect(step(r, 'uptimes')).toBeUndefined(); // no uptime API calls
    const ds = await s.api('GET', '/datasets/gatus-uptime');
    const mes = ds.rows.find((x: any) => x.Endpoint === 'MES frontend');
    expect(mes['Uptime (%)']).toBe(93.33); // 28 of 30 results
    expect(mes['Avg response (ms)']).toBeGreaterThan(300);
    const check = r.steps.find((x: any) => x.stepId === 'allHealthy');
    expect(check.status).toBe('failed'); // a warning check, the run still succeeds
    expect(check.output.message).toContain('plant/Historian API');
  });

  it('reports a Steward check to a Gatus external endpoint with the endpoint token', async () => {
    const r = await run('gatus-report-check', { target: P['Web probe (demo)']!, gatus: P['Gatus (demo)']! }, { path: '/gatus-apps/mes' });
    expect([r.status, r.error]).toEqual(['succeeded', null]);
    expect(step(r, 'push').output.status).toBe(200);
    const status = await s.api('POST', `/platforms/${P['Gatus (demo)']}/request`, { method: 'GET', path: '/api/v1/endpoints/steward_steward-checks/statuses' });
    const last = status.body.results.at(-1);
    expect(last.success).toBe(true);
    expect(Date.now() - Date.parse(last.timestamp)).toBeLessThan(60000);
    // a failing check is pushed with its error
    const bad = await run('gatus-report-check', { target: P['Web probe (demo)']!, gatus: P['Gatus (demo)']! }, { path: '/gatus-apps/historian/health' });
    expect(bad.status).toBe('succeeded');
    const after = await s.api('POST', `/platforms/${P['Gatus (demo)']}/request`, { method: 'GET', path: '/api/v1/endpoints/steward_steward-checks/statuses' });
    expect(after.body.results.at(-1)).toMatchObject({ success: false, errors: [expect.stringContaining('HTTP 503')] });
    // the external endpoint token never shows up in the run
    const detail = JSON.stringify(await s.api('GET', `/runs/${r.id}`)) + JSON.stringify(await s.api('GET', `/runs/${r.id}/steps/${step(r, 'push').id}`));
    expect(detail).not.toContain('demo-external-token');
    expect(detail).not.toContain('demo-gatus-password');
  });

  describe('Gatus alert → webhook trigger → diagnosis runbook', () => {
    let trigger: { trigger: any; secret: string };
    const fire = async (body: string) => {
      const res = await fetch(`${s.base}/api/hooks/${trigger.trigger.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${trigger.secret}` },
        body,
      });
      return { status: res.status, body: await res.json() };
    };

    beforeAll(async () => {
      trigger = await s.api('POST', '/triggers', {
        name: 'Gatus alerts',
        processId: 'gatus-diagnose-outage',
        bindings: { gatus: P['Gatus (demo)'], probe: P['Web probe (demo)'] },
        inputMapping: {
          endpointName: 'body.name',
          endpointGroup: 'body.group',
          endpointUrl: 'body.url',
          alertState: 'body.event',
          errors: 'body.errors',
          description: 'body.description',
        },
        dedupeSeconds: 0,
        skipIfRunning: false,
      });
    });

    it('collects evidence and waits for an approver other than the trigger owner', async () => {
      const res = await fire(gatusAlert('TRIGGERED', `${s.base}/mock/gatus-apps/historian/health`));
      expect(res.status).toBe(202);
      const r = await s.waitRun(res.body.runId, ['waiting', 'failed', 'succeeded']);
      expect(r).toMatchObject({ status: 'waiting', trigger: 'webhook', triggerName: 'Gatus alerts', actor: 'admin' });
      expect(r.inputs).toMatchObject({ endpointName: 'Historian API', alertState: 'TRIGGERED', errors: '[STATUS] (503) == 200,[BODY].status (DOWN) == UP' });
      expect(step(r, 'probe').output.status).toBe(503);
      expect(step(r, 'reachable').status).toBe('failed');
      expect(step(r, 'knownToGatus').status).toBe('succeeded');
      const evidence = r.reports.find((x: any) => x.title.includes('Historian API'));
      expect(evidence.text).toContain('HTTP 503');
      expect(evidence.text).toContain('Failed checks:** 4 of the last 20');
      const task = r.tasks.find((t: any) => t.status === 'open');
      expect(task.title).toBe('Run remediation for plant/Historian API?');
      expect(task.canDecide).toBe(false); // four-eyes: the trigger owner started the run
      await adam('POST', `/tasks/${task.id}/complete`, { approved: true, comment: 'go' });
      const done = await s.waitRun(r.id, ['succeeded', 'failed']);
      expect(done.status).toBe('succeeded');
      expect(done.logs.map((l: any) => l.message).join('\n')).toContain('EXAMPLE ONLY');
    });

    it('never probes URLs outside the probe platform', async () => {
      for (const url of ['http://evil.example.com/health', `${s.base}.evil.example.com/x`, `${s.base}@evil.example.com/x`]) {
        const res = await fire(gatusAlert('TRIGGERED', url));
        const r = await s.waitRun(res.body.runId, ['waiting', 'failed', 'succeeded']);
        expect(step(r, 'probe'), url).toBeUndefined();
        expect(step(r, 'notProbed').status).toBe('succeeded');
        await s.api('POST', `/runs/${r.id}/cancel`);
      }
    });

    it('only logs resolved alerts', async () => {
      const res = await fire(gatusAlert('RESOLVED', `${s.base}/mock/gatus-apps/historian/health`));
      const r = await s.waitRun(res.body.runId, ['waiting', 'failed', 'succeeded']);
      expect(r.status).toBe('succeeded');
      expect(r.tasks).toHaveLength(0);
      expect(step(r, 'history')).toBeUndefined();
      expect(step(r, 'resolvedLog').status).toBe('succeeded');
    });
  });
});
