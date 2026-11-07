import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FrameworkEndpoints } from '../msteams/framework.js';

/**
 * A mock of Microsoft's Bot Framework for tests of the Teams bot (ADR 0013): its OpenID metadata and signing keys
 * (a test key set of its own, endorsed for `msteams`), the Entra token endpoint for the bot's own token, and the Bot
 * Connector at a `serviceUrl` that records the activities Steward posts and updates. It never talks to Microsoft.
 * It proves Steward's side only – how real Teams clients behave is a matter for a pilot (the feature is a preview).
 */

export interface MockBotConnector {
  url: string;
  endpoints: FrameworkEndpoints;
  /** A token as the Bot Connector would send it with an activity (claims override the defaults) */
  sign: (claims: Record<string, unknown>, opts?: { kid?: string; key?: crypto.KeyObject; alg?: string }) => string;
  /** Keys that are not in the published set (for "unknown key" and "wrong signature") */
  foreignKey: crypto.KeyObject;
  kid: string;
  /** What Steward sent: posts, updates and token requests */
  sent: { method: string; path: string; auth: string; body: unknown }[];
  tokenRequests: URLSearchParams[];
  close: () => Promise<void>;
}

export async function startMockBotConnector(opts: { appId: string; endorsements?: string[] }): Promise<MockBotConnector> {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const foreign = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const kid = `mock-${crypto.randomBytes(4).toString('hex')}`;
  const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  const sent: MockBotConnector['sent'] = [];
  const tokenRequests: URLSearchParams[] = [];
  let seq = 0;
  let base = '';
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0]!;
      const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (req.method === 'GET' && path === '/v1/.well-known/openidconfiguration')
        return json(200, { issuer: 'https://api.botframework.com', jwks_uri: `${base}/v1/keys` });
      if (req.method === 'GET' && path === '/v1/keys')
        return json(200, { keys: [{ kty: 'RSA', use: 'sig', kid, n: jwk.n, e: jwk.e, endorsements: opts.endorsements ?? ['msteams'] }] });
      if (req.method === 'POST' && /^\/[^/]+\/oauth2\/v2\.0\/token$/.test(path)) {
        tokenRequests.push(new URLSearchParams(data));
        return json(200, { token_type: 'Bearer', expires_in: 3600, access_token: 'mock-bot-access-token' });
      }
      if (path.startsWith('/v3/conversations/')) {
        const body = ((): unknown => {
          try {
            return JSON.parse(data || 'null') as unknown;
          } catch {
            return null; // recorded as null
          }
        })();
        sent.push({ method: req.method ?? '', path, auth: String(req.headers.authorization ?? ''), body });
        return json(200, { id: `act-${++seq}` });
      }
      return json(404, { error: 'not found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const sign: MockBotConnector['sign'] = (claims, o = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const enc = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const head = enc({ alg: o.alg ?? 'RS256', typ: 'JWT', kid: o.kid ?? kid });
    const body = enc({ iss: 'https://api.botframework.com', aud: opts.appId, nbf: now - 10, exp: now + 3600, serviceUrl: base, ...claims });
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), o.key ?? privateKey).toString('base64url');
    return `${head}.${body}.${sig}`;
  };
  return {
    url: base,
    endpoints: {
      openIdMetadata: `${base}/v1/.well-known/openidconfiguration`,
      tokenEndpoint: `${base}/{tenant}/oauth2/v2.0/token`,
      serviceHosts: ['127.0.0.1'],
      allowHttp: true,
    },
    sign,
    foreignKey: foreign,
    kid,
    sent,
    tokenRequests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
