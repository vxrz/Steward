import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Platform sign-in types (#114): key-pair JWT (sent as the token, or exchanged for an access token) and AWS SigV4
 * (signed per request, optionally as an assumed role) – checked against AWS's documented examples and end to end
 * through the platform request layer against the mock.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';

let s: TestServer;
let mockBase: string;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  mockBase = `${s.base.replace(/\/$/, '')}/mock`;
});
afterAll(async () => {
  await s?.app.close();
});

/** A request through the platform layer, in-process – the API's request explorer masks credentials in what it returns (checked below). */
async function request(id: string, path: string, method = 'GET', body?: unknown): Promise<{ status: number; body: any }> {
  const { platformRequest } = await import('../src/platforms/http.js');
  const { getSecrets } = await import('../src/platforms/service.js');
  const platform = await s.api('GET', `/platforms/${id}`);
  const r = await platformRequest(platform, getSecrets(id), { method, url: path, ...(body ? { body } : {}) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r;
}

describe('AWS Signature Version 4', () => {
  it('matches the examples of the AWS documentation', async () => {
    const { signRequest, signingKey } = await import('../src/platforms/sigv4.js');
    const secret = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
    expect(signingKey(secret, '20150830', 'us-east-1', 'iam').toString('hex')).toBe('c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9');
    const now = new Date('2015-08-30T12:36:00Z');
    const creds = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: secret };
    const iam = {
      method: 'GET',
      url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' } as Record<string, string>,
    };
    signRequest(iam, { region: 'us-east-1', service: 'iam', credentials: creds, now });
    expect(iam.headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
    );
    // the "get-vanilla" case of the SigV4 test suite
    const vanilla = { method: 'GET', url: 'https://example.amazonaws.com/', headers: {} as Record<string, string> };
    signRequest(vanilla, { region: 'us-east-1', service: 'service', credentials: creds, now });
    expect(vanilla.headers.authorization).toMatch(/Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31$/);
    // S3: the payload hash is a header, temporary credentials carry their token
    const s3 = { method: 'PUT', url: 'https://bucket.s3.eu-central-1.amazonaws.com/a%20b.txt', headers: {} as Record<string, string>, body: 'hello' };
    signRequest(s3, { region: 'eu-central-1', service: 's3', credentials: { ...creds, sessionToken: 'tok' }, now });
    expect(s3.headers['x-amz-content-sha256']).toBe(crypto.createHash('sha256').update('hello').digest('hex'));
    expect(s3.headers['x-amz-security-token']).toBe('tok');
    expect(s3.headers.authorization).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token');
  });

  it('signs every request to the platform, also as an assumed role, and renews the role on demand', async () => {
    const p = await s.api('POST', '/platforms', {
      name: 'AWS test',
      kind: 'generic',
      baseUrl: `${mockBase}/test`,
      config: { auth: { type: 'aws_sigv4', aws: { region: 'eu-central-1', service: 'execute-api' } }, variables: {}, http: { proxy: 'none' } },
      secrets: { accessKeyId: 'AKIADEMOEXAMPLE', secretAccessKey: 'demoSecretKey' },
    });
    // the request explorer masks the credentials in what it shows
    const shown = await s.api('POST', `/platforms/${p.id}/request`, { method: 'GET', path: '/echo-signed' });
    expect(shown.body.headers.authorization).toContain('Credential=***/');
    const r = await request(p.id, '/echo-signed?b=2&a=1', 'POST', { hello: 'world' });
    const h = r.body.headers;
    expect(h.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIADEMOEXAMPLE\/\d{8}\/eu-central-1\/execute-api\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    // the signature is over what was sent: recomputed from the request as the server got it
    const { signRequest } = await import('../src/platforms/sigv4.js');
    const again = {
      method: 'POST',
      url: `${mockBase}/test/echo-signed?b=2&a=1`,
      headers: { 'content-type': h['content-type'] } as Record<string, string>,
      body: r.body.body,
    };
    const when = h['x-amz-date'] as string;
    signRequest(again, {
      region: 'eu-central-1',
      service: 'execute-api',
      credentials: { accessKeyId: 'AKIADEMOEXAMPLE', secretAccessKey: 'demoSecretKey' },
      now: new Date(`${when.slice(0, 4)}-${when.slice(4, 6)}-${when.slice(6, 8)}T${when.slice(9, 11)}:${when.slice(11, 13)}:${when.slice(13, 15)}Z`),
    });
    expect(again.headers.authorization).toBe(h.authorization);
    // as a role: the platform's key only assumes it, requests are signed with the temporary credentials
    await s.api('PUT', `/platforms/${p.id}`, {
      config: {
        ...p.config,
        auth: {
          type: 'aws_sigv4',
          aws: { region: 'eu-central-1', service: 'execute-api', roleArn: 'arn:aws:iam::123456789012:role/steward-read', stsEndpoint: `${mockBase}/aws/sts` },
        },
      },
    });
    const r2 = await request(p.id, '/echo-signed');
    expect(r2.body.headers.authorization).toContain('Credential=ASIATEMPDEMO/');
    expect(r2.body.headers['x-amz-security-token']).toBe('session-steward-read');
    const renewed = await s.api('POST', `/platforms/${p.id}/token/renew`, {});
    expect(renewed.ok).toBe(true);
    expect(Date.parse(renewed.token.expiresAt)).toBeGreaterThan(Date.now() + 50 * 60_000);
    await s.api('PUT', `/platforms/${p.id}`, {
      config: { ...p.config, auth: { type: 'aws_sigv4', aws: { region: 'eu-central-1', service: 'x', roleArn: 'not-an-arn' } } },
    });
    await expect(request(p.id, '/echo-signed')).rejects.toThrow(/not an IAM role/);
  });
});

describe('key-pair JWT', () => {
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = (k: crypto.KeyObject) => k.export({ type: 'pkcs8', format: 'pem' }) as string;
  const decode = (jwt: string) => jwt.split('.').map((x, i) => (i < 2 ? JSON.parse(Buffer.from(x, 'base64url').toString('utf8')) : x));

  it('sends a JWT signed with the private key as the token (Snowflake style), with the public key fingerprint', async () => {
    const p = await s.api('POST', '/platforms', {
      name: 'JWT test',
      kind: 'generic',
      baseUrl: `${mockBase}/test`,
      config: {
        auth: {
          type: 'jwt',
          jwt: {
            alg: 'RS256',
            lifetimeSeconds: 3600,
            claims: {
              iss: "{{ $uppercase(vars.account) & '.' & $uppercase(vars.user) & '.' & publicKeyFingerprint }}",
              sub: "{{ $uppercase(vars.account) & '.' & $uppercase(vars.user) }}",
            },
          },
        },
        variables: { account: 'xy12345', user: 'steward_reader' },
        http: { proxy: 'none', defaultHeaders: { 'X-Snowflake-Authorization-Token-Type': 'KEYPAIR_JWT' } },
      },
      secrets: { privateKey: pem(rsa.privateKey) },
    });
    const r = await request(p.id, '/echo-headers');
    expect(r.body.headers['x-snowflake-authorization-token-type']).toBe('KEYPAIR_JWT');
    const jwt = String(r.body.headers.authorization).replace(/^Bearer /, '');
    const [header, payload] = decode(jwt);
    const fp = `SHA256:${crypto
      .createHash('sha256')
      .update(rsa.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('base64')}`;
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(payload).toMatchObject({ iss: `XY12345.STEWARD_READER.${fp}`, sub: 'XY12345.STEWARD_READER' });
    expect(payload.exp - payload.iat).toBe(3600);
    const [h, b, sig] = jwt.split('.');
    expect(crypto.verify('sha256', Buffer.from(`${h}.${b}`), rsa.publicKey, Buffer.from(sig!, 'base64url'))).toBe(true);
    // the same JWT is used until shortly before it ends, a new one on demand
    expect((await request(p.id, '/echo-headers')).body.headers.authorization).toBe(r.body.headers.authorization);
    await s.api('POST', `/platforms/${p.id}/token/renew`, {});
    expect((await request(p.id, '/echo-headers')).body.headers.authorization).not.toBe(r.body.headers.authorization);
    // a key of the wrong type, or none, is refused with a readable error
    await s.api('PUT', `/platforms/${p.id}/secrets`, { privateKey: pem(ec.privateKey) });
    await s.api('POST', `/platforms/${p.id}/token/renew`, {}).catch(() => undefined);
    await expect(request(p.id, '/echo-headers')).rejects.toThrow(/does not fit the algorithm RS256/);
    await s.api('PUT', `/platforms/${p.id}/secrets`, { privateKey: 'not a key' });
    await expect(request(p.id, '/echo-headers')).rejects.toThrow(/private key cannot be read/);
  });

  it('signs with ES256 and exchanges the JWT for an access token (RFC 7523)', async () => {
    const p = await s.api('POST', '/platforms', {
      name: 'JWT exchange test',
      kind: 'generic',
      baseUrl: `${mockBase}/test`,
      config: {
        auth: {
          type: 'jwt',
          tokenUrl: `${mockBase}/test/jwt-exchange`,
          jwt: {
            alg: 'ES256',
            mode: 'exchange',
            lifetimeSeconds: 600,
            claims: { iss: 'svc@example.com', sub: 'svc@example.com', aud: 'https://oauth2.example.com/token' },
          },
        },
        variables: {},
        http: { proxy: 'none' },
      },
      secrets: { privateKey: pem(ec.privateKey) },
    });
    const r = await request(p.id, '/echo-headers');
    expect(r.body.headers.authorization).toBe('Bearer exchanged-svc@example.com');
    const t = await s.api('POST', `/platforms/${p.id}/test`, {});
    expect(t.token).toMatchObject({ expiresAt: expect.any(String) });
  });
});
