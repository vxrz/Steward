import http from 'node:http';
import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/** Errors of the internal API (/api) are problem details (RFC 9457) with the old members as extensions. */
let s: TestServer;

beforeAll(async () => {
  s = await startTestServer({
    routes: (app) => {
      app.get('/api/test/explode', { config: { access: { auth: 'public' } } } as never, async () => {
        throw new TypeError('secret internals at /var/lib/x');
      });
    },
  });
  await setup(s);
});

const raw = (path: string, init: RequestInit = {}) => fetch(`${s.base}/api${path}`, { ...init, headers: { 'x-sm-client': '1', ...(init.headers ?? {}) } });

describe('internal API errors', () => {
  it('a coded error: application/problem+json with type, title, status, detail and the old members', async () => {
    const r = await raw('/runs');
    expect(r.status).toBe(401);
    expect(r.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
    const body = await r.json();
    expect(body).toEqual({
      type: 'urn:steward:error:NOT_SIGNED_IN',
      title: 'Unauthorized',
      status: 401,
      detail: 'Please sign in',
      instance: '/api/runs',
      error: 'Please sign in',
      code: 'NOT_SIGNED_IN',
      requestId: r.headers.get('x-request-id'),
    });
  });

  it('the caller can pass its own request id', async () => {
    const r = await raw('/runs', { headers: { 'x-request-id': 'my-trace-1' } });
    expect((await r.json()).requestId).toBe('my-trace-1');
  });

  it('validation errors keep code and params; params and issues stay extension members', async () => {
    const r = await fetch(`${s.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'x-sm-client': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ username: 42 }),
    });
    expect(r.status).toBe(400);
    expect(r.headers.get('content-type')).toContain('application/problem+json');
    const body = await r.json();
    expect(body).toMatchObject({ type: 'urn:steward:error:INVALID_INPUT', title: 'Bad Request', status: 400, code: 'INVALID_INPUT' });
    expect(body.detail).toBe(body.error);
    expect(typeof body.params.details).toBe('string');
  });

  it('an unexpected error tells nothing about its cause, only the request id', async () => {
    const r = await raw('/test/explode');
    expect(r.status).toBe(500);
    const body = await r.json();
    expect(body).toMatchObject({ type: 'urn:steward:error:INTERNAL_ERROR', title: 'Internal Server Error', status: 500, code: 'INTERNAL_ERROR' });
    expect(body.params.requestId).toBe(body.requestId);
    expect(JSON.stringify(body)).not.toContain('secret internals');
  });

  it('answers of the request guards (host check, CSRF header) are problems too', async () => {
    // fetch() does not let a caller choose the Host header: plain http
    const host = await new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
      const u = new URL(`${s.base}/api/auth/me`);
      http
        .get(u, { headers: { host: 'evil.example.com', 'x-sm-client': '1' } }, (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => resolve({ status: res.statusCode!, type: String(res.headers['content-type']), body }));
        })
        .on('error', reject);
    });
    expect(host.status).toBe(403);
    expect(host.type).toContain('application/problem+json');
    expect(JSON.parse(host.body).detail).toBe('Host not allowed');
    const csrf = await fetch(`${s.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(csrf.status).toBe(403);
    expect(await csrf.json()).toMatchObject({ status: 403, error: 'Missing x-sm-client header', type: 'about:blank' });
  });

  it('successful answers, the public API and the MCP endpoint keep their formats', async () => {
    const ok = await raw('/health');
    expect(ok.headers.get('content-type')).toContain('application/json');
    const v1 = await fetch(`${s.base}/api/v1/me`);
    expect(v1.status).toBe(401);
    const p = await v1.json();
    expect(p.type).toMatch(/docs\/API\.md#/); // the public API's own problem types
    expect(p.error).toBeUndefined();
    const mcp = await fetch(`${s.base}/api/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(mcp.headers.get('content-type') ?? '').not.toContain('problem+json');
  });

  it('the web client still reads error, code and params', async () => {
    const e = await s
      .client()('GET', '/runs')
      .catch((x) => x);
    expect(e).toMatchObject({ status: 401 });
  });
});
