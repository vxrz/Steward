import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Platform } from '@sm/shared';
import { platformRequest } from '../src/platforms/http.js';

// F3: custom-named credential headers must be dropped on a cross-origin redirect
// (undici only strips `Authorization`).
let origin: http.Server;
let sink: http.Server;
let originPort = 0;
let sinkPort = 0;
let sinkHeaders: http.IncomingHttpHeaders | null = null;

beforeAll(async () => {
  sink = http.createServer((req, res) => {
    sinkHeaders = req.headers;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, got: req.headers }));
  });
  await new Promise<void>((r) => sink.listen(0, '127.0.0.1', r));
  sinkPort = (sink.address() as AddressInfo).port;

  origin = http.createServer((req, res) => {
    if (req.url?.startsWith('/redirect')) {
      res.writeHead(302, { location: `http://127.0.0.1:${sinkPort}/stolen` });
      return res.end();
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, got: req.headers }));
  });
  await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
  originPort = (origin.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((r) => sink.close(() => r()));
  await new Promise<void>((r) => origin.close(() => r()));
});

const platform = (config: Partial<Platform['config']>): Platform =>
  ({
    id: `p_${Math.random().toString(36).slice(2)}`,
    name: 'redir-test',
    kind: 'generic',
    description: '',
    baseUrl: `http://127.0.0.1:${originPort}`,
    environment: '',
    config: { auth: { type: 'none' }, variables: {}, http: { proxy: 'none' }, ...config },
    secretKeys: [],
    acl: [],
    permissions: ['use'],
    createdAt: '',
    updatedAt: new Date().toISOString(),
  }) as unknown as Platform;

describe('F3 – credentials do not survive a cross-origin redirect', () => {
  it('drops a custom API-key header on the redirect hop', async () => {
    sinkHeaders = null;
    const p = platform({ auth: { type: 'apiKey', apiKeyIn: 'header', apiKeyName: 'x-api-key' } } as Partial<Platform['config']>);
    await platformRequest(p, { apiKey: 'SUPER-SECRET-APIKEY' }, { method: 'GET', url: '/redirect' });
    expect(sinkHeaders).not.toBeNull();
    expect(sinkHeaders!['x-api-key']).toBeUndefined();
  });

  it('drops the Authorization bearer on the redirect hop', async () => {
    sinkHeaders = null;
    const p = platform({ auth: { type: 'bearer' } });
    await platformRequest(p, { token: 'BEARER-SECRET-TOKEN' }, { method: 'GET', url: '/redirect' });
    expect(sinkHeaders!['authorization']).toBeUndefined();
  });

  it('drops a secret-bearing default header on the redirect hop', async () => {
    sinkHeaders = null;
    const p = platform({ http: { proxy: 'none', defaultHeaders: { 'x-space-auth-key': 'SPACE-SECRET-VALUE' } } } as Partial<Platform['config']>);
    await platformRequest(p, {}, { method: 'GET', url: '/redirect' });
    expect(sinkHeaders!['x-space-auth-key']).toBeUndefined();
  });

  it('still sends credentials to a trusted (same) origin and on the first hop', async () => {
    const p = platform({ auth: { type: 'apiKey', apiKeyIn: 'header', apiKeyName: 'x-api-key' } } as Partial<Platform['config']>);
    const res = await platformRequest(p, { apiKey: 'SUPER-SECRET-APIKEY' }, { method: 'GET', url: '/plain' });
    expect((res.body as { got: Record<string, string> }).got['x-api-key']).toBe('SUPER-SECRET-APIKEY');
  });
});
