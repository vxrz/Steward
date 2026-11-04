import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import type { TestServer } from './helpers.js';
import { startEntra, type EntraEnv } from './entra-setup.js';

/**
 * Microsoft Graph / Entra ID (v0.5.0, docs/ENTRA.md) against the simulated tenant (mock/mockGraph.ts): the preset and
 * its sign-in with a client secret or a certificate (client assertion), the connection test naming missing
 * permissions, admin consent and licences, and the Graph helper's paging and throttling.
 */

let env: EntraEnv;
let s: TestServer;
let mock: EntraEnv['mock'];
let platformId: string;
// ---------- a self-signed RSA certificate, DER by hand (no openssl) ----------

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let x = n; x > 0; x >>= 8) bytes.unshift(x & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, body: Buffer) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const time = (d: Date) => tlv(0x17, Buffer.from(d.toISOString().slice(2, 19).replace(/[-:T]/g, '') + 'Z', 'ascii'));
function rsaCertificate(): { pem: string; keyPem: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sha256WithRsa = seq(Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]), Buffer.from([0x05, 0x00]));
  const name = seq(tlv(0x31, seq(Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]), tlv(0x0c, Buffer.from('steward-graph-reader')))));
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, Buffer.from([0x42])),
    sha256WithRsa,
    name,
    seq(time(new Date(Date.now() - 86400000)), time(new Date(Date.now() + 365 * 86400000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const der = seq(tbs, sha256WithRsa, tlv(0x03, Buffer.concat([Buffer.from([0]), crypto.sign('sha256', tbs, privateKey)])));
  const b64 = der
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .trim();
  return { pem: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`, keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

beforeAll(async () => {
  env = await startEntra();
  ({ s, mock, platformId } = env);
});
beforeEach(() => mock?.resetGraph());
afterAll(async () => {
  mock?.resetGraph();
  await s?.app.close();
});

const invalidate = (id: string) => env.invalidate(id);

describe('Microsoft Graph platform', () => {
  it('has a read-only preset with client credentials and the Graph read endpoints', async () => {
    expect(env.preset).toMatchObject({
      label: 'Microsoft Graph (Entra ID, read-only)',
      baseUrl: 'https://graph.microsoft.com',
      config: {
        auth: { type: 'oauth2_client_credentials', tokenUrl: '{{ vars.loginUrl }}/{{ vars.tenantId }}/oauth2/v2.0/token', scope: '{{ baseUrl }}/.default' },
        variables: { loginUrl: 'https://login.microsoftonline.com' },
      },
      specCount: 1,
    });
    expect(env.preset.secretFields.map((f: any) => f.key)).toEqual(['clientId', 'clientSecret', 'certificate', 'privateKey', 'privateKeyPassphrase']);
    const specs = await s.api('GET', `/platforms/${platformId}/specs`);
    expect(specs.map((x: any) => x.name)).toEqual(['Microsoft Graph (Entra ID read endpoints)']);
    const { graphSpec } = await import('../src/platforms/graphSpec.js');
    const ops = Object.values((graphSpec() as any).paths).flatMap((x: any) => Object.keys(x));
    expect(new Set(ops)).toEqual(new Set(['get']));
  });

  it('tests the connection: signed in, every permission consented, every part readable', async () => {
    const t = await s.api('POST', `/platforms/${platformId}/test`, {});
    expect(t).toMatchObject({ ok: true, status: 200 });
    expect(t.message).toMatch(/signed in to Contoso \(demo\).*every part is readable/);
    expect(t.checks.every((c: any) => c.ok)).toBe(true);
    expect(t.checks.map((c: any) => c.name)).toContain('Eligible roles, PIM (RoleManagement.Read.Directory, Entra ID P2)');
    // no secret in what the test answers or audits
    expect(JSON.stringify(t)).not.toContain(mock.DEMO_GRAPH.clientSecret);
    const log = await s.api('GET', `/audit?entityId=${platformId}&limit=5`);
    expect(JSON.stringify(log)).not.toContain(mock.DEMO_GRAPH.clientSecret);
  });

  it('names a wrong secret, missing admin consent and missing permissions in plain words', async () => {
    const bad = await env.createGraphPlatform('Entra ID wrong secret', { clientId: mock.DEMO_GRAPH.clientId, clientSecret: 'wrong-secret-value' });
    const t1 = await s.api('POST', `/platforms/${bad}/test`, {});
    expect(t1.ok).toBe(false);
    expect(t1.message).toMatch(/AADSTS7000215.*the client secret is wrong/);
    expect(t1.message).not.toContain('wrong-secret-value');

    const tenant = await env.createGraphPlatform(
      'Entra ID wrong tenant',
      { clientId: mock.DEMO_GRAPH.clientId, clientSecret: mock.DEMO_GRAPH.clientSecret },
      { tenantId: 'nope' },
    );
    expect((await s.api('POST', `/platforms/${tenant}/test`, {})).message).toMatch(/the tenant \(variable tenantId\) does not exist/);

    mock.setGraphConsent(null);
    await invalidate(platformId);
    const t2 = await s.api('POST', `/platforms/${platformId}/test`, {});
    expect(t2.ok).toBe(false);
    expect(t2.message).toMatch(/admin consent is missing/);
    expect(t2.checks[0]).toMatchObject({ name: 'Admin consent', ok: false });

    mock.setGraphConsent(['User.Read.All', 'AuditLog.Read.All', 'Application.Read.All']);
    await invalidate(platformId);
    const t3 = await s.api('POST', `/platforms/${platformId}/test`, {});
    expect(t3.ok).toBe(true);
    const by = Object.fromEntries(t3.checks.map((c: any) => [c.name, c]));
    expect(by['Application permissions'].message).toMatch(
      /missing or without admin consent: Group.Read.All, Directory.Read.All, RoleManagement.Read.Directory/,
    );
    expect(by['Groups (Group.Read.All)']).toMatchObject({ ok: false, message: expect.stringMatching(/lacks the application permission Group.Read.All/) });
    expect(by['Directory roles (RoleManagement.Read.Directory)'].message).toMatch(/RoleManagement.Read.Directory/);
    expect(by['Service health (ServiceHealth.Read.All)'].message).toMatch(/^not available \(licence or permission\), optional/);
    expect(t3.message).toMatch(/Not readable: Application permissions, Groups, Directory roles/);
  });

  it('lists the parts that need Entra ID P1/P2 as not available, without failing', async () => {
    mock.setGraphLicence('free');
    const t = await s.api('POST', `/platforms/${platformId}/test`, {});
    expect(t.ok).toBe(true);
    const by = Object.fromEntries(t.checks.map((c: any) => [c.name, c]));
    expect(by['Last sign-in (AuditLog.Read.All, Entra ID P1)'].message).toMatch(/^not available \(licence or permission\).*P1\/P2 licence/);
    expect(by['MFA registration (AuditLog.Read.All, Entra ID P1)'].ok).toBe(false);
    expect(by['Eligible roles, PIM (RoleManagement.Read.Directory, Entra ID P2)'].ok).toBe(false);
    expect(by['Users (User.Read.All)'].ok).toBe(true);
  });

  it('signs in with a certificate: a client assertion named by the thumbprint, audience the token endpoint', async () => {
    const cert = rsaCertificate();
    const id = await env.createGraphPlatform('Entra ID certificate', { clientId: mock.DEMO_GRAPH.clientId, certificate: cert.pem, privateKey: cert.keyPem });
    // not registered on the app yet
    const t0 = await s.api('POST', `/platforms/${id}/test`, {});
    expect(t0.message).toMatch(/AADSTS700027.*the certificate is not registered/);
    mock.setGraphCertificate(cert.pem);
    const t = await s.api('POST', `/platforms/${id}/test`, {});
    expect(t).toMatchObject({ ok: true });
    expect(JSON.stringify(t)).not.toContain('PRIVATE KEY');

    const { certificateThumbprints, clientAssertion, privateKeyOf } = await import('../src/platforms/jwt.js');
    const tp = certificateThumbprints(cert.pem);
    const der = new crypto.X509Certificate(cert.pem).raw;
    expect(tp).toEqual({
      'x5t#S256': crypto.createHash('sha256').update(der).digest('base64url'),
      x5t: crypto.createHash('sha1').update(der).digest('base64url'),
    });
    // the SHA-1 thumbprint in hex, as the Entra portal shows it, works without the certificate
    expect(certificateThumbprints(undefined, crypto.createHash('sha1').update(der).digest('hex').toUpperCase())).toEqual({ x5t: tp.x5t });
    expect(() => certificateThumbprints(undefined, '')).toThrow(/needs the public certificate/);
    const jwt = clientAssertion(privateKeyOf(cert.keyPem), { clientId: 'c1', tokenUrl: 'https://login.example/t/oauth2/v2.0/token', thumbprints: tp });
    const [h, b] = jwt
      .split('.')
      .slice(0, 2)
      .map((x) => JSON.parse(Buffer.from(x, 'base64url').toString('utf8')));
    expect(h).toMatchObject({ alg: 'RS256', typ: 'JWT', 'x5t#S256': tp['x5t#S256'], x5t: tp.x5t });
    expect(b).toMatchObject({ iss: 'c1', sub: 'c1', aud: 'https://login.example/t/oauth2/v2.0/token', jti: expect.any(String) });
    expect(b.exp - b.iat).toBe(600);
    expect(b.nbf).toBe(b.iat);
  });
});

describe('the Graph helper', () => {
  it('follows @odata.nextLink page by page and waits out a 429 with Retry-After', async () => {
    const { graphList } = await import('../src/entra/graph.js');
    const { getSecrets } = await import('../src/platforms/service.js');
    const p = await s.api('GET', `/platforms/${platformId}`);
    // signed in afresh (the reset tenant forgot its tokens): no 401 and retry in the count below
    await invalidate(platformId);
    const t0 = Date.now();
    const users = await graphList<any>(p, getSecrets(platformId), '/v1.0/users', { $select: 'id,userPrincipalName' });
    expect(users).toHaveLength(9);
    expect(Object.keys(users[0]).sort()).toEqual(['id', 'userPrincipalName']);
    // page 2 was throttled once and asked again after the second Retry-After said
    expect(mock.graphRequests.filter((r) => r === 'GET /v1.0/users?$skiptoken=3')).toHaveLength(2);
    expect(
      mock.graphRequests.filter((r) => r.startsWith('GET /v1.0/users')),
      mock.graphRequests.join('; '),
    ).toHaveLength(4);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  });

  it('turns 403 and licence errors into plain words and does not follow a next page to another host', async () => {
    const { GraphError, graphError, graphList } = await import('../src/entra/graph.js');
    const denied = graphError(
      { status: 403, body: { error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges' } } },
      '/v1.0/groups/x/owners',
    );
    expect(denied).toMatchObject({ status: 403, permission: 'Group.Read.All', unavailable: true });
    expect(denied.message).toMatch(/lacks the application permission Group.Read.All, or an administrator has not granted admin consent/);
    const lic = graphError(
      {
        status: 403,
        body: {
          error: { code: 'Authentication_RequestFromNonPremiumTenantOrB2CTenant', message: "Neither tenant is B2C or tenant doesn't have premium license" },
        },
      },
      '/v1.0/users',
      { $select: 'id,signInActivity' },
    );
    expect(lic).toMatchObject({ licence: true, unavailable: true });
    expect(graphError({ status: 500, body: null }, '/v1.0/users').unavailable).toBe(false);

    // a next link to another host is not followed: the token goes to Graph's origin only
    const { getSecrets } = await import('../src/platforms/service.js');
    const p = await s.api('GET', `/platforms/${platformId}`);
    await expect(graphList(p, getSecrets(platformId), '/v1.0/test/foreignNext')).rejects.toMatchObject({ code: 'ForeignNextLink' });
    await expect(graphList(p, getSecrets(platformId), '/v1.0/test/foreignNext')).rejects.toBeInstanceOf(GraphError);
  });
});
