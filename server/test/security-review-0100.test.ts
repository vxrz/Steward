/**
 * Regression tests for the security review of 0.10.0: API tokens no longer hand out secrets that outlive them (S2).
 * The proof of concept: a leaked full-access token created a webhook trigger, the token was revoked, and the trigger's
 * secret still started the owner's process.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

let s: TestServer;
let token = '';
let processId = '';

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  processId = (await s.api('POST', '/processes', { definition: { name: 'Persist target', inputs: [], steps: [{ id: 'n', type: 'log', message: 'hello' }] } }))
    .id;
  token = (await s.api('POST', '/me/tokens', { name: 'ci', scope: 'full' })).token;
});
afterAll(async () => {
  await s?.app.close();
});

async function viaToken(method: string, path: string, body?: unknown) {
  const res = await fetch(`${s.base}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, type: res.headers.get('content-type') ?? '', body: text ? JSON.parse(text) : null };
}

const trigger = { name: 'backdoor', processId: '', enabled: true, dryRun: false, inputMapping: {}, bindings: {}, authMode: 'token' };

describe('S2: secrets that outlive an API token need a signed-in session', () => {
  it('refuses to create a webhook trigger with an API token, with the same problem as other session-only routes', async () => {
    const refused = await viaToken('POST', '/triggers', { ...trigger, processId });
    // the reference: a route that was session-only before
    const reference = await viaToken('POST', '/sync-sources/unknown/rotate-webhook-secret', {});
    expect(refused.status).toBe(403);
    expect(refused.type).toContain('application/problem+json');
    expect(refused.body).toMatchObject({ code: 'SESSION_REQUIRED' });
    expect(refused.body.secret).toBeUndefined();
    expect({ ...refused.body, instance: undefined, requestId: undefined }).toEqual({ ...reference.body, instance: undefined, requestId: undefined });
    expect(await s.api('GET', '/triggers')).toEqual([]);
  });

  it('still lets a signed-in session create and rotate a trigger; a token can neither rotate nor read the secret', async () => {
    const created = await s.api('POST', '/triggers', { ...trigger, name: 'CI hook', processId });
    expect(created.secret).toMatch(/\S{20,}/);
    const rotate = await viaToken('POST', `/triggers/${created.trigger.id}/rotate`);
    expect(rotate).toMatchObject({ status: 403, body: { code: 'SESSION_REQUIRED' } });
    expect(JSON.stringify((await viaToken('GET', `/triggers/${created.trigger.id}`)).body)).not.toContain(created.secret);
    expect((await s.api('POST', `/triggers/${created.trigger.id}/rotate`)).secret).not.toBe(created.secret);
    // what a token keeps: changing, pausing and deleting the trigger
    expect((await viaToken('POST', `/triggers/${created.trigger.id}/pause`, { until: null, reason: 'maintenance' })).status).toBe(200);
    expect((await viaToken('DELETE', `/triggers/${created.trigger.id}`)).status).toBe(200);
  });

  it('refuses to switch the MCP server on with an API token', async () => {
    const before = await s.api('GET', '/mcp-server');
    expect(await viaToken('PUT', '/mcp-server', { enabled: true, runRequests: true })).toMatchObject({ status: 403, body: { code: 'SESSION_REQUIRED' } });
    expect(await s.api('GET', '/mcp-server')).toEqual(before);
    expect((await s.api('PUT', '/mcp-server', { enabled: true })).enabled).toBe(true);
  });

  it('gives an API token no heartbeat secret when it saves a monitor, and refuses the rotation', async () => {
    const definition = { name: 'Token heartbeat', checks: [{ id: 'hb', name: 'HB', type: 'heartbeat', key: 'token.hb', mode: 'maxAge', maxAgeSeconds: 60 }] };
    const r = await viaToken('POST', '/monitors', { definition });
    expect(r.status).toBe(200);
    // the check exists, but its secret is not handed out
    expect(r.body.secrets).toEqual([]);
    const id = r.body.monitor.id as string;
    expect(r.body.monitor.checks.find((c: { checkId: string }) => c.checkId === 'hb').heartbeat.secretPrefix).toMatch(/^mhs_/);
    const added = await viaToken('PUT', `/monitors/${id}`, {
      version: r.body.monitor.version,
      definition: { ...definition, checks: [...definition.checks, { ...definition.checks[0], id: 'hb2', key: 'token.hb2' }] },
    });
    expect(added.status).toBe(200);
    expect(added.body.secrets).toEqual([]);
    expect(await viaToken('POST', `/monitors/${id}/checks/hb/rotate`)).toMatchObject({ status: 403, body: { code: 'SESSION_REQUIRED' } });
    // a signed-in session gets the secret with the rotation
    expect((await s.api('POST', `/monitors/${id}/checks/hb/rotate`)).secret).toMatch(/^mhs_/);
    // and with a save of its own
    const own = await s.api('POST', '/monitors', {
      definition: { ...definition, name: 'Session heartbeat', checks: [{ ...definition.checks[0], key: 'session.hb' }] },
    });
    expect(own.secrets).toHaveLength(1);
  });
});
