import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * OAuth 2.1 sign-in for MCP clients (#12): optional and off by default. Discovery (RFC 9728, RFC 8414), dynamic
 * registration (RFC 7591), the consent of the person, PKCE, code exchange, audience binding, refresh token rotation with
 * reuse detection, revocation by the person, the administrator and RFC 7009 – and personal MCP tokens keep working.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Own-password-123';
const MODERN = '2026-07-28';
let s: TestServer;
let dana: Client; // designer
let stella: Client; // status viewer
let mcpToken: string;
const REDIRECT = 'http://127.0.0.1:33418/callback';

const b64url = (b: Buffer) => b.toString('base64url');
function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
}

async function raw(method: string, path: string, init: { form?: Record<string, string>; json?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${s.base}${path}`, {
    method,
    headers: {
      ...(init.form ? { 'content-type': 'application/x-www-form-urlencoded' } : init.json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
    body: init.form ? new URLSearchParams(init.form).toString() : init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  const text = await res.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* text */
  }
  return { status: res.status, headers: res.headers, body };
}

let nextId = 1;
function mcp(token: string | null, method = 'tools/call', params: Record<string, unknown> = { name: 'get_system_status', arguments: {} }) {
  return raw('POST', '/api/mcp', {
    json: {
      jsonrpc: '2.0',
      id: nextId++,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN,
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'oauth-test', version: '1' },
        },
      },
    },
    headers: {
      accept: 'application/json',
      'mcp-protocol-version': MODERN,
      'mcp-method': method,
      ...(method === 'tools/call' ? { 'mcp-name': String(params.name) } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status?: number }) => e.status ?? 0,
  );

/** The consent page's request (as the web UI sends it). */
const request = (clientId: string, challenge: string, over: Record<string, string> = {}) => ({
  response_type: 'code',
  client_id: clientId,
  redirect_uri: REDIRECT,
  code_challenge: challenge,
  code_challenge_method: 'S256',
  scope: 'mcp',
  state: 'xyz-state',
  resource: `${s.base}/api/mcp`,
  ...over,
});
const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();

/** Register, consent and exchange: a client signed in as `who`. */
async function signIn(who: Client, clientId: string) {
  const p = pkce();
  const { redirectTo } = await who('POST', '/oauth/authorize', { request: request(clientId, p.challenge), approve: true });
  const code = new URL(redirectTo).searchParams.get('code')!;
  const t = await raw('POST', '/oauth/token', {
    form: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: p.verifier, resource: `${s.base}/api/mcp` },
  });
  expect(t.status, JSON.stringify(t.body)).toBe(200);
  return { ...t.body, code, verifier: p.verifier } as { access_token: string; refresh_token: string; expires_in: number; code: string; verifier: string };
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const users = await import('../src/auth/users.js');
  users.createUser({ username: 'dana', roles: ['designer'], password: PW, mustChangePassword: false });
  users.createUser({ username: 'stella', roles: ['status'], password: PW, mustChangePassword: false });
  [dana, stella] = await Promise.all(['dana', 'stella'].map((u) => s.as(u, PW)));
  await s.api('PUT', '/mcp-server', { enabled: true });
  mcpToken = (await dana('POST', '/me/tokens', { name: 'desktop', scope: 'mcp' })).token;
});
afterAll(async () => {
  await s?.app.close();
});

describe('OAuth sign-in for MCP clients', () => {
  let clientId: string;

  it('is off by default: no metadata, no registration, MCP tokens as before', async () => {
    expect((await s.api('GET', '/mcp-server')).oauth).toMatchObject({ enabled: false, dynamicRegistration: true, accessTokenMinutes: 60 });
    expect((await raw('GET', '/.well-known/oauth-protected-resource/api/mcp')).status).toBe(404);
    expect((await raw('GET', '/.well-known/oauth-authorization-server')).status).toBe(404);
    expect((await raw('POST', '/oauth/register', { json: { redirect_uris: [REDIRECT] } })).status).toBe(404);
    const unauth = await mcp(null);
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get('www-authenticate')).not.toContain('resource_metadata');
    expect((await mcp(mcpToken)).status).toBe(200);
  });

  it('publishes resource and authorization server metadata once turned on', async () => {
    const st = await s.api('PUT', '/settings/mcp-oauth', { enabled: true });
    expect(st.settings.enabled).toBe(true);
    const unauth = await mcp(null);
    expect(unauth.headers.get('www-authenticate')).toBe(
      `Bearer realm="Steward MCP", resource_metadata="${s.base}/.well-known/oauth-protected-resource/api/mcp", scope="mcp"`,
    );
    const pr = await raw('GET', '/.well-known/oauth-protected-resource/api/mcp');
    expect(pr.body).toMatchObject({
      resource: `${s.base}/api/mcp`,
      authorization_servers: [s.base],
      scopes_supported: ['mcp'],
      bearer_methods_supported: ['header'],
    });
    const as = await raw('GET', '/.well-known/oauth-authorization-server');
    expect(as.body).toMatchObject({
      issuer: s.base,
      authorization_endpoint: `${s.base}/oauth/authorize`,
      token_endpoint: `${s.base}/oauth/token`,
      registration_endpoint: `${s.base}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
    expect((await raw('GET', '/.well-known/openid-configuration')).body.issuer).toBe(s.base);
  });

  it('registers public clients with safe redirect URIs only', async () => {
    for (const bad of ['javascript:alert(1)', 'http://evil.example/cb', 'https://x.example/cb#frag', 'relative/path'])
      expect((await raw('POST', '/oauth/register', { json: { client_name: 'Bad', redirect_uris: [bad] } })).body.error).toBe('invalid_redirect_uri');
    expect((await raw('POST', '/oauth/register', { json: { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' } })).body.error).toBe(
      'invalid_client_metadata',
    );
    const r = await raw('POST', '/oauth/register', {
      json: { client_name: 'Claude <b>Desktop</b>', redirect_uris: [REDIRECT, 'https://claude.ai/api/mcp/auth_callback', 'cursor://anysphere.cursor/oauth'] },
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      client_name: 'Claude <b>Desktop</b>',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
    });
    expect(r.body.client_secret).toBeUndefined();
    clientId = r.body.client_id;
    expect((await s.api('GET', '/audit?action=mcp.oauth_client_registered&limit=1'))[0].summary).toContain('registered itself');
  });

  it('shows the person who asks and where the browser returns; refuses unknown clients, redirects and missing PKCE', async () => {
    const { challenge } = pkce();
    const c = await dana('GET', `/oauth/authorize?${qs(request(clientId, challenge))}`);
    expect(c).toMatchObject({
      clientName: 'Claude <b>Desktop</b>',
      redirectHost: '127.0.0.1:33418',
      registeredBy: 'dynamic',
      scope: 'mcp',
      alreadyGranted: false,
    });
    // another loopback port is fine (RFC 8252), another path or host is not
    expect((await dana('GET', `/oauth/authorize?${qs(request(clientId, challenge, { redirect_uri: 'http://127.0.0.1:50000/callback' }))}`)).clientId).toBe(
      clientId,
    );
    const err = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: { body?: any }) => e.body,
      );
    expect((await err(dana('GET', `/oauth/authorize?${qs(request('mcpc_nope', challenge))}`)))?.code).toBe('MCP_OAUTH_CLIENT_UNKNOWN');
    expect((await err(dana('GET', `/oauth/authorize?${qs(request(clientId, challenge, { redirect_uri: 'http://127.0.0.1:33418/other' }))}`)))?.code).toBe(
      'MCP_OAUTH_REDIRECT_UNKNOWN',
    );
    // errors after a valid redirect go back to the client
    const noPkce = await err(dana('GET', `/oauth/authorize?${qs(request(clientId, challenge, { code_challenge_method: 'plain' }))}`));
    expect(noPkce?.code).toBe('MCP_OAUTH_REQUEST_INVALID');
    expect(new URL(noPkce.params.redirectTo).searchParams.get('error')).toBe('invalid_request');
    const badScope = await err(dana('GET', `/oauth/authorize?${qs(request(clientId, challenge, { scope: 'admin' }))}`));
    expect(new URL(badScope.params.redirectTo).searchParams.get('error')).toBe('invalid_scope');
    const otherResource = await err(dana('GET', `/oauth/authorize?${qs(request(clientId, challenge, { resource: 'https://elsewhere.example/api/mcp' }))}`));
    expect(new URL(otherResource.params.redirectTo).searchParams.get('error')).toBe('invalid_target');
    // status viewers do not use MCP
    expect(await status(stella('GET', `/oauth/authorize?${qs(request(clientId, challenge))}`))).toBe(403);
  });

  it('a denial goes back as access_denied', async () => {
    const { challenge } = pkce();
    const { redirectTo } = await dana('POST', '/oauth/authorize', { request: request(clientId, challenge), approve: false });
    const u = new URL(redirectTo);
    expect([u.searchParams.get('error'), u.searchParams.get('state'), u.searchParams.get('iss')]).toEqual(['access_denied', 'xyz-state', s.base]);
  });

  it('exchanges the code with PKCE for an access token that works on the MCP endpoint as the person', async () => {
    const p = pkce();
    const { redirectTo } = await dana('POST', '/oauth/authorize', { request: request(clientId, p.challenge), approve: true });
    const back = new URL(redirectTo);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect([back.searchParams.get('state'), back.searchParams.get('iss')]).toEqual(['xyz-state', s.base]);
    const code = back.searchParams.get('code')!;
    const form = { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: pkce().verifier };
    expect((await raw('POST', '/oauth/token', { form })).body.error).toBe('invalid_grant'); // wrong verifier
    const t = await raw('POST', '/oauth/token', { form: { ...form, code_verifier: p.verifier } });
    expect(t.status).toBe(200);
    expect(t.headers.get('cache-control')).toBe('no-store');
    expect(t.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mcp' });
    expect(t.body.access_token).toMatch(/^smo_/);
    expect(t.body.refresh_token).toMatch(/^smr_/);
    const r = await mcp(t.body.access_token);
    expect(r.status).toBe(200);
    expect(r.body.result.structuredContent).toMatchObject({ you: { username: 'dana' }, mcp: { token: { name: 'Claude <b>Desktop</b> (OAuth)' } } });
    // the access token is for the MCP endpoint only
    const rest = await raw('GET', '/api/v1/processes', { headers: { authorization: `Bearer ${t.body.access_token}` } });
    expect(rest.status).toBe(401);
    const web = await raw('GET', '/api/processes', { headers: { authorization: `Bearer ${t.body.access_token}` } });
    expect(web.status).toBe(401);
    // the same code twice: refused, and the access it gave ends
    expect((await raw('POST', '/oauth/token', { form: { ...form, code_verifier: p.verifier } })).body.error).toBe('invalid_grant');
    expect((await mcp(t.body.access_token)).status).toBe(401);
    expect((await s.api('GET', '/audit?action=mcp.oauth_code_reused')).length).toBe(1);
  });

  it('binds the token to the MCP endpoint (audience)', async () => {
    const t = await signIn(dana, clientId);
    const { db } = await import('../src/db.js');
    db().run("UPDATE oauth_grants SET resource = 'https://other.example/api/mcp' WHERE revoked_at IS NULL");
    const r = await mcp(t.access_token);
    expect(r.status).toBe(401);
    expect(r.body.error.message).toContain('another resource');
    db().run('UPDATE oauth_grants SET resource = ? WHERE revoked_at IS NULL', `${s.base}/api/mcp`);
    expect((await mcp(t.access_token)).status).toBe(200);
  });

  it('rotates refresh tokens; an old one used again revokes the access', async () => {
    const t = await signIn(dana, clientId);
    const r1 = await raw('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId } });
    expect(r1.status).toBe(200);
    expect(r1.body.refresh_token).not.toBe(t.refresh_token);
    expect((await mcp(t.access_token)).status).toBe(401); // replaced
    expect((await mcp(r1.body.access_token)).status).toBe(200);
    // the old refresh token again (stolen copy, or a client that kept it)
    expect((await raw('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId } })).body.error).toBe(
      'invalid_grant',
    );
    expect((await mcp(r1.body.access_token)).status).toBe(401);
    expect(
      (await raw('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: r1.body.refresh_token, client_id: clientId } })).body.error,
    ).toBe('invalid_grant');
    expect((await s.api('GET', '/audit?action=mcp.oauth_refresh_reused')).length).toBe(1);
    expect((await raw('POST', '/oauth/token', { form: { grant_type: 'password', client_id: clientId } })).body.error).toBe('unsupported_grant_type');
  });

  it('the person sees their connected clients and revokes them; RFC 7009 revocation works as well', async () => {
    const t = await signIn(dana, clientId);
    const list = await dana('GET', '/me/mcp-clients');
    expect(list).toEqual([expect.objectContaining({ clientName: 'Claude <b>Desktop</b>', owner: 'dana', scope: 'mcp' })]);
    expect(await s.api('GET', '/me/mcp-clients')).toEqual([]); // administrators' own list
    expect(await status(stella('DELETE', `/me/mcp-clients/${list[0].id}`))).toBe(403);
    await dana('DELETE', `/me/mcp-clients/${list[0].id}`);
    expect((await mcp(t.access_token)).status).toBe(401);
    const t2 = await signIn(dana, clientId);
    expect((await raw('POST', '/oauth/revoke', { form: { token: t2.refresh_token } })).status).toBe(200);
    expect((await mcp(t2.access_token)).status).toBe(401);
    expect((await raw('POST', '/oauth/revoke', { form: { token: 'smr_unknown' } })).status).toBe(200);
  });

  it('administrators add clients, turn self-registration off, revoke clients and grants', async () => {
    const added = await s.api('POST', '/settings/mcp-oauth/clients', {
      name: 'Company assistant',
      redirectUris: ['https://assistant.example.com/oauth/callback'],
    });
    expect(added).toMatchObject({ name: 'Company assistant', registeredBy: 'admin', grants: 0 });
    expect(await status(s.api('POST', '/settings/mcp-oauth/clients', { name: 'x', redirectUris: ['http://insecure.example/cb'] }))).toBe(400);
    expect(await status(dana('GET', '/settings/mcp-oauth'))).toBe(403);
    await s.api('PUT', '/settings/mcp-oauth', { dynamicRegistration: false });
    expect((await raw('POST', '/oauth/register', { json: { redirect_uris: [REDIRECT] } })).status).toBe(403);
    expect((await raw('GET', '/.well-known/oauth-authorization-server')).body.registration_endpoint).toBeUndefined();
    const t = await signIn(dana, clientId);
    const view = await s.api('GET', '/settings/mcp-oauth');
    expect(view.grants.map((g: any) => g.owner)).toEqual(['dana']);
    expect(view.clients.find((c: any) => c.id === clientId).grants).toBe(1);
    await s.api('DELETE', `/settings/mcp-oauth/clients/${clientId}`);
    expect((await mcp(t.access_token)).status).toBe(401);
    expect((await raw('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId } })).body.error).toBe(
      'invalid_client',
    );
    await s.api('PUT', '/settings/mcp-oauth', { dynamicRegistration: true });
  });

  it('stops working when OAuth or MCP is turned off, or the person is deactivated – MCP tokens keep working', async () => {
    const c = (await raw('POST', '/oauth/register', { json: { client_name: 'Again', redirect_uris: [REDIRECT] } })).body.client_id;
    const t = await signIn(dana, c);
    await s.api('PUT', '/settings/mcp-oauth', { enabled: false });
    const off = await mcp(t.access_token);
    expect(off.status).toBe(401);
    expect(off.body.error.message).toContain('turned off');
    expect((await mcp(mcpToken)).status).toBe(200);
    await s.api('PUT', '/settings/mcp-oauth', { enabled: true });
    expect((await mcp(t.access_token)).status).toBe(200);
    const users = await import('../src/auth/users.js');
    const id = users.findUserByName('dana')!.id;
    users.updateUser(id, { active: false });
    expect((await mcp(t.access_token)).status).toBe(403);
    expect((await raw('POST', '/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: c } })).body.error).toBe(
      'invalid_grant',
    );
    users.updateUser(id, { active: true });
    const audits = await s.api('GET', '/audit?action=mcp.oauth_authorized');
    expect(audits[0].summary).toContain('dana allowed MCP client');
    expect(JSON.stringify(audits)).not.toMatch(/smo_|smr_/);
  });
});

describe('discovery below a base path', () => {
  it('lets in exactly the two well-known addresses that put the base path at the end (RFC 8414, RFC 9728)', async () => {
    const { stripBasePath, OUTSIDE_BASE_URL } = await import('../src/basePath.js');
    const strip = (url: string) => stripBasePath({ url }, '/steward');
    expect(strip('/.well-known/oauth-authorization-server/steward')).toBe('/.well-known/oauth-authorization-server');
    expect(strip('/.well-known/oauth-protected-resource/steward/api/mcp')).toBe('/.well-known/oauth-protected-resource/api/mcp');
    expect(strip('/steward/.well-known/oauth-authorization-server')).toBe('/.well-known/oauth-authorization-server');
    for (const other of [
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-authorization-server/other',
      '/.well-known/oauth-protected-resource/steward/api/x',
    ])
      expect(strip(other)).toBe(OUTSIDE_BASE_URL);
  });
});
