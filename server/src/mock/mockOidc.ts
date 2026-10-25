import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

/**
 * Minimal OpenID Connect provider for demo mode and tests ("simulated Entra ID").
 * Supports discovery, authorization code + PKCE (S256), client_secret_post/basic,
 * RS256-signed ID tokens and JWKS – enough for a real end-to-end sign-in.
 */

export const DEMO_OIDC = { clientId: 'service-manager-demo', clientSecret: 'demo-oidc-secret' };

/** The demo tenant (Entra ID's "tid"). */
export const DEMO_TENANT_ID = '6f1b2c3d-0000-4000-8000-00000000c0de';

interface MockIdentity {
  sub: string;
  name: string;
  preferred_username: string;
  roles: string[];
  given_name?: string;
  family_name?: string;
  /** Entra ID's object id in the tenant */
  oid?: string;
}

export const DEMO_IDENTITIES: MockIdentity[] = [
  {
    sub: 'a1f3',
    name: 'Max Admin',
    given_name: 'Max',
    family_name: 'Admin',
    oid: '0a1f3000-0000-4000-8000-000000000001',
    preferred_username: 'max@contoso.example',
    roles: ['SM.Admins'],
  },
  {
    sub: 'b2e4',
    name: 'Erik Engineer',
    given_name: 'Erik',
    family_name: 'Engineer',
    oid: '0b2e4000-0000-4000-8000-000000000002',
    preferred_username: 'erik@contoso.example',
    roles: ['SM.Designers'],
  },
  {
    sub: 'c3d5',
    name: 'Oskar Operator',
    given_name: 'Oskar',
    family_name: 'Operator',
    oid: '0c3d5000-0000-4000-8000-000000000003',
    preferred_username: 'oskar@contoso.example',
    roles: ['SM.Operators'],
  },
  {
    sub: 'd4c6',
    name: 'Sofia Approver',
    given_name: 'Sofia',
    family_name: 'Approver',
    oid: '0d4c6000-0000-4000-8000-000000000004',
    preferred_username: 'sofia@contoso.example',
    roles: ['SM.Approvers'],
  },
  {
    sub: 'e5b7',
    name: 'Nina Nobody',
    given_name: 'Nina',
    family_name: 'Nobody',
    oid: '0e5b7000-0000-4000-8000-000000000005',
    preferred_username: 'nina@contoso.example',
    roles: [] as string[],
  },
];

/**
 * Claims a test sets for one identity (demo mode only): `idToken` and `userinfo` are merged into what the mock sends
 * (a null value removes a claim), so tests can emit given_name, oid, tid, nested address, email_verified, group overage
 * indicators (_claim_names / _claim_sources, hasgroups) or any custom claim. A sub that is not a demo identity becomes
 * a new account on the sign-in page.
 */
export interface MockIdentitySpec {
  name?: string;
  preferred_username?: string;
  idToken?: Record<string, unknown>;
  userinfo?: Record<string, unknown>;
  /**
   * Sign-in time at the provider (auth_time, step-up): by default every sign-in on the account page is a fresh one
   * (auth_time = now). With authAgeSeconds the identity has an older session at the provider, which a sign-in without
   * prompt=login / max_age=0 reuses (auth_time = now − age); ignorePrompt: the provider does not honour them either.
   * idToken: { auth_time: null } leaves the claim out.
   */
  authAgeSeconds?: number;
  ignorePrompt?: boolean;
  /**
   * Multi-factor authentication: 'whenAsked' (default) – amr gets "mfa", acr the requested acr value and acrs the
   * requested authentication context when acr_values or a claims request for acrs asks for it; 'always'; 'never'.
   */
  mfa?: 'whenAsked' | 'always' | 'never';
}
const custom = new Map<string, MockIdentitySpec>();
const MAX_CUSTOM = 50;
const MAX_SPEC_BYTES = 32 * 1024;

export function setMockIdentity(sub: string, spec: MockIdentitySpec): void {
  if (!/^[\w.-]{1,40}$/.test(sub)) throw new Error('sub: 1–40 letters, digits, . _ -');
  if (JSON.stringify(spec).length > MAX_SPEC_BYTES) throw new Error('identity too large');
  if (!custom.has(sub) && custom.size >= MAX_CUSTOM) throw new Error('too many identities');
  custom.set(sub, spec);
}
export function resetMockIdentities(sub?: string): void {
  if (sub) custom.delete(sub);
  else custom.clear();
}

function identityOf(sub: string): MockIdentity | undefined {
  const known = DEMO_IDENTITIES.find((i) => i.sub === sub);
  const spec = custom.get(sub);
  if (!known && !spec) return undefined;
  const base: MockIdentity = known ?? { sub, name: spec?.name ?? sub, preferred_username: spec?.preferred_username ?? `${sub}@contoso.example`, roles: [] };
  return { ...base, ...(spec?.name ? { name: spec.name } : {}), ...(spec?.preferred_username ? { preferred_username: spec.preferred_username } : {}) };
}

const listed = (): MockIdentity[] => [
  ...DEMO_IDENTITIES.map((i) => identityOf(i.sub)!),
  ...[...custom.keys()].filter((s) => !DEMO_IDENTITIES.some((i) => i.sub === s)).map((s) => identityOf(s)!),
];

/** Standard claims of an identity, with the test's changes (null removes a claim). */
function claimsOf(i: MockIdentity, extra: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: i.name,
    preferred_username: i.preferred_username,
    email: i.preferred_username,
    roles: i.roles,
    ...(i.given_name ? { given_name: i.given_name } : {}),
    ...(i.family_name ? { family_name: i.family_name } : {}),
    oid: i.oid ?? `0000${i.sub}-0000-4000-8000-000000000000`.slice(0, 36),
    tid: DEMO_TENANT_ID,
  };
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** auth_time, amr, acr and acrs of a sign-in (see MockIdentitySpec): honours prompt=login, max_age, acr_values and a claims request for acrs. */
function authClaims(q: Record<string, string>, spec: MockIdentitySpec | undefined): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  // the identity's session at the provider is `age` old: reused unless the request asks for a fresh sign-in
  const age = spec?.authAgeSeconds ?? 0;
  const tooOld = q.max_age !== undefined && Number.isFinite(Number(q.max_age)) && age > Number(q.max_age);
  const authTime = (q.prompt === 'login' || tooOld) && !spec?.ignorePrompt ? now : now - age;
  let contexts: string[] = [];
  try {
    const v = (JSON.parse(q.claims ?? '{}') as { id_token?: { acrs?: { value?: string; values?: string[] } } }).id_token?.acrs;
    contexts = v ? [...(v.value ? [v.value] : []), ...(v.values ?? [])] : [];
  } catch {
    /* no claims request */
  }
  const acrValues = (q.acr_values ?? '').split(' ').filter(Boolean);
  const asked = acrValues.length > 0 || contexts.length > 0;
  const mfa = spec?.mfa === 'always' || (spec?.mfa !== 'never' && asked);
  return {
    auth_time: authTime,
    amr: mfa ? ['pwd', 'mfa'] : ['pwd'],
    ...(acrValues.length ? { acr: mfa ? acrValues[0] : '0' } : {}),
    ...(contexts.length ? { acrs: mfa ? contexts : [] } : {}),
  };
}

export async function mockOidc(app: FastifyInstance): Promise<void> {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = crypto.randomBytes(6).toString('hex');
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, string>), kid, alg: 'RS256', use: 'sig' };
  const codes = new Map<
    string,
    { identity: MockIdentity; clientId: string; redirectUri: string; nonce?: string; challenge?: string; expires: number; auth: Record<string, unknown> }
  >();
  /** Access tokens for the userinfo endpoint (bounded, short-lived). */
  const accessTokens = new Map<string, { sub: string; expires: number }>();

  const issuerOf = (host: string | undefined) => `http://${host}${config.basePath}/mock/oidc`;

  app.get('/oidc/.well-known/openid-configuration', async (req) => {
    const iss = issuerOf(req.headers.host);
    return {
      issuer: iss,
      authorization_endpoint: `${iss}/authorize`,
      token_endpoint: `${iss}/token`,
      jwks_uri: `${iss}/jwks`,
      userinfo_endpoint: `${iss}/userinfo`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: ['openid', 'profile', 'email'],
      claims_parameter_supported: true,
      acr_values_supported: ['mfa', 'urn:okta:loa:2fa:any', 'gold'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
      code_challenge_methods_supported: ['S256'],
      claims_supported: [
        'sub',
        'name',
        'given_name',
        'family_name',
        'preferred_username',
        'email',
        'email_verified',
        'roles',
        'oid',
        'tid',
        'auth_time',
        'amr',
        'acr',
        'acrs',
      ],
    };
  });

  app.get('/oidc/jwks', async () => ({ keys: [jwk] }));

  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

  app.get('/oidc/authorize', async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q.client_id !== DEMO_OIDC.clientId) return reply.code(400).type('text/plain').send('unknown client_id');
    if (q.response_type !== 'code') return reply.code(400).type('text/plain').send('unsupported response_type');
    const params = new URLSearchParams(q);
    const again = q.prompt === 'login' || q.max_age === '0';
    const rows = listed()
      .map((i) => {
        const p = new URLSearchParams(params);
        p.set('login', i.sub);
        // nosemgrep: javascript.express.security.injection.raw-html-format.raw-html-format -- every value is HTML-escaped with esc(); dev/demo-only mock identity provider
        return `<li><a class="acc" href="${config.basePath}/mock/oidc/authorize/approve?${esc(p.toString())}"><b>${esc(i.name)}</b><br><small>${esc(i.preferred_username)} · roles: ${esc(i.roles.join(', ') || 'none')}</small></a></li>`;
      })
      .join('');
    return reply
      .type('text/html')
      .send(
        `<!doctype html><meta charset="utf-8"><title>Sign in – Demo identity provider</title><style>body{font-family:Segoe UI,sans-serif;background:#f3f2f1;margin:0}main{max-width:420px;margin:60px auto;background:#fff;padding:32px;box-shadow:0 2px 6px #0002}ul{list-style:none;padding:0}a.acc{display:block;padding:10px 12px;margin:6px 0;border:1px solid #ddd;color:#222;text-decoration:none}a.acc:hover{background:#f0f6ff}</style><main><h2>${again ? 'Sign in again' : 'Pick an account'}</h2><p>Simulated Microsoft Entra ID (demo mode). In real use your company sign-in page appears here.</p><ul>${rows}</ul></main>`,
      );
  });

  app.get('/oidc/authorize/approve', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const identity = identityOf(String(q.login ?? ''));
    if (!identity || q.client_id !== DEMO_OIDC.clientId || !q.redirect_uri) return reply.code(400).type('text/plain').send('invalid request');
    const code = crypto.randomBytes(16).toString('base64url');
    codes.set(code, {
      identity,
      clientId: q.client_id,
      redirectUri: q.redirect_uri,
      nonce: q.nonce,
      challenge: q.code_challenge,
      expires: Date.now() + 60000,
      auth: authClaims(q, custom.get(identity.sub)),
    });
    const target = new URL(q.redirect_uri);
    target.searchParams.set('code', code);
    if (q.state) target.searchParams.set('state', q.state);
    target.searchParams.set('iss', issuerOf(req.headers.host));
    return reply.redirect(target.href);
  });

  app.post('/oidc/token', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string>;
    let clientId = b.client_id;
    let secret = b.client_secret;
    const basic = String(req.headers.authorization ?? '').match(/^Basic (.+)$/i);
    if (basic) [clientId, secret] = Buffer.from(basic[1]!, 'base64').toString().split(':').map(decodeURIComponent);
    if (clientId !== DEMO_OIDC.clientId || secret !== DEMO_OIDC.clientSecret) return reply.code(401).send({ error: 'invalid_client' });
    const entry = codes.get(b.code ?? '');
    codes.delete(b.code ?? '');
    if (b.grant_type !== 'authorization_code' || !entry || entry.expires < Date.now() || entry.redirectUri !== b.redirect_uri) {
      return reply.code(400).send({ error: 'invalid_grant' });
    }
    if (entry.challenge) {
      const expected = crypto
        .createHash('sha256')
        .update(b.code_verifier ?? '')
        .digest('base64url');
      if (expected !== entry.challenge) return reply.code(400).send({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    }
    const now = Math.floor(Date.now() / 1000);
    const i = entry.identity;
    const payload = {
      ...claimsOf(i, { ...entry.auth, ...custom.get(i.sub)?.idToken }),
      iss: issuerOf(req.headers.host),
      sub: i.sub,
      aud: clientId,
      iat: now,
      exp: now + 600,
      nonce: entry.nonce,
    };
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
    const body = b64url(JSON.stringify(payload));
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
    const accessToken = crypto.randomBytes(16).toString('hex');
    for (const [k, v] of accessTokens) if (v.expires < Date.now()) accessTokens.delete(k);
    if (accessTokens.size >= 1000) accessTokens.delete(accessTokens.keys().next().value!);
    accessTokens.set(accessToken, { sub: i.sub, expires: Date.now() + 600_000 });
    return { access_token: accessToken, token_type: 'Bearer', expires_in: 600, id_token: `${head}.${body}.${sig}` };
  });

  app.get('/oidc/userinfo', async (req, reply) => {
    const bearer = /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
    const t = bearer ? accessTokens.get(bearer) : undefined;
    const i = t && t.expires > Date.now() ? identityOf(t.sub) : undefined;
    if (!i) return reply.code(401).send({ error: 'invalid_token' });
    const spec = custom.get(i.sub);
    return { ...claimsOf(i, { ...spec?.idToken, ...spec?.userinfo }), sub: i.sub };
  });

  // tests (demo mode only, like the whole mock): claims of an identity, see MockIdentitySpec
  app.put('/oidc/identities/:sub', async (req, reply) => {
    try {
      const b = (req.body ?? {}) as MockIdentitySpec;
      if (typeof b !== 'object' || Array.isArray(b)) throw new Error('JSON object expected');
      setMockIdentity((req.params as { sub: string }).sub, {
        ...(typeof b.authAgeSeconds === 'number' && b.authAgeSeconds >= 0 ? { authAgeSeconds: Math.min(b.authAgeSeconds, 365 * 86400) } : {}),
        ...(b.ignorePrompt === true ? { ignorePrompt: true } : {}),
        ...(b.mfa === 'always' || b.mfa === 'never' || b.mfa === 'whenAsked' ? { mfa: b.mfa } : {}),
        ...(typeof b.name === 'string' ? { name: b.name.slice(0, 100) } : {}),
        ...(typeof b.preferred_username === 'string' ? { preferred_username: b.preferred_username.slice(0, 200) } : {}),
        ...(b.idToken && typeof b.idToken === 'object' ? { idToken: b.idToken } : {}),
        ...(b.userinfo && typeof b.userinfo === 'object' ? { userinfo: b.userinfo } : {}),
      });
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  app.delete('/oidc/identities/:sub', async (req) => {
    resetMockIdentities((req.params as { sub: string }).sub);
    return { ok: true };
  });
}
