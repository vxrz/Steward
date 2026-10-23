import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Platform } from '@sm/shared';
import { platformRequest, secretValues } from '../src/platforms/http.js';

// One local server reachable under two origins (127.0.0.1 and localhost) – it echoes what it received.
let server: http.Server;
let port = 0;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ authorization: req.headers.authorization ?? null, apiKey: req.headers['x-api-key'] ?? null, url: req.url }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const platform = (config: Partial<Platform['config']> = {}): Platform =>
  ({
    id: `p_${Math.random().toString(36).slice(2)}`,
    name: 'test',
    kind: 'generic',
    description: '',
    baseUrl: `http://127.0.0.1:${port}/api`,
    environment: '',
    config: { auth: { type: 'bearer' }, ...config },
    secretKeys: ['token'],
    acl: [],
    permissions: ['use'],
    createdAt: '',
    updatedAt: '',
  }) as unknown as Platform;

describe('platform credentials only reach the platform', () => {
  it('sends credentials for relative paths and absolute URLs on the same origin', async () => {
    const p = platform();
    const rel = await platformRequest(p, { token: 'secret-token-1' }, { method: 'GET', url: '/x' });
    expect((rel.body as { authorization: string }).authorization).toBe('Bearer secret-token-1');
    const abs = await platformRequest(p, { token: 'secret-token-1' }, { method: 'GET', url: `http://127.0.0.1:${port}/other` });
    expect((abs.body as { authorization: string }).authorization).toBe('Bearer secret-token-1');
  });

  it('withholds credentials, API keys and default headers for other origins', async () => {
    const p = platform({ http: { defaultHeaders: { 'x-api-key': 'default-key' } } } as Partial<Platform['config']>);
    const res = await platformRequest(p, { token: 'secret-token-2' }, { method: 'GET', url: `http://localhost:${port}/steal` });
    expect(res.body).toMatchObject({ authorization: null, apiKey: null });
    const q = platform({ auth: { type: 'apiKey', apiKeyIn: 'query', apiKeyName: 'key' } } as Partial<Platform['config']>);
    const res2 = await platformRequest(q, { apiKey: 'query-key' }, { method: 'GET', url: `http://localhost:${port}/steal` });
    expect((res2.body as { url: string }).url).not.toContain('query-key');
  });

  it('sends credentials to explicitly trusted origins', async () => {
    const p = platform({ http: { trustedOrigins: [`http://localhost:${port}`] } } as Partial<Platform['config']>);
    const res = await platformRequest(p, { token: 'secret-token-3' }, { method: 'GET', url: `http://localhost:${port}/ok` });
    expect((res.body as { authorization: string }).authorization).toBe('Bearer secret-token-3');
  });

  it('does not treat identifiers such as user names as secrets to mask', () => {
    expect(secretValues({ username: 'gatus', clientId: 'my-client', password: 'pw-1234' })).toEqual(['pw-1234']);
  });
});
