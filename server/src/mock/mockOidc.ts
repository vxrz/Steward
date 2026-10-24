import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

/**
 * Minimal OpenID Connect provider for demo mode and tests ("simulated Entra ID").
 * Supports discovery, authorization code + PKCE (S256), client_secret_post/basic,
 * RS256-signed ID tokens and JWKS – enough for a real end-to-end sign-in.
 */

export const DEMO_OIDC = { clientId: 'service-manager-demo', clientSecret: 'demo-oidc-secret' };

export const DEMO_IDENTITIES = [
  { sub: 'a1f3', name: 'Max Admin', preferred_username: 'max@contoso.example', roles: ['SM.Admins'] },
  { sub: 'b2e4', name: 'Erik Engineer', preferred_username: 'erik@contoso.example', roles: ['SM.Designers'] },
  { sub: 'c3d5', name: 'Oskar Operator', preferred_username: 'oskar@contoso.example', roles: ['SM.Operators'] },
  { sub: 'd4c6', name: 'Sofia Approver', preferred_username: 'sofia@contoso.example', roles: ['SM.Approvers'] },
  { sub: 'e5b7', name: 'Nina Nobody', preferred_username: 'nina@contoso.example', roles: [] as string[] },
];

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export async function mockOidc(app: FastifyInstance): Promise<void> {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = crypto.randomBytes(6).toString('hex');
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, string>), kid, alg: 'RS256', use: 'sig' };
  const codes = new Map<
    string,
    { identity: (typeof DEMO_IDENTITIES)[number]; clientId: string; redirectUri: string; nonce?: string; challenge?: string; expires: number }
  >();

  const issuerOf = (host: string | undefined) => `http://${host}${config.basePath}/mock/oidc`;

  app.get('/oidc/.well-known/openid-configuration', async (req) => {
    const iss = issuerOf(req.headers.host);
    return {
      issuer: iss,
      authorization_endpoint: `${iss}/authorize`,
      token_endpoint: `${iss}/token`,
      jwks_uri: `${iss}/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: ['openid', 'profile', 'email'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
      code_challenge_methods_supported: ['S256'],
      claims_supported: ['sub', 'name', 'preferred_username', 'email', 'roles'],
    };
  });

  app.get('/oidc/jwks', async () => ({ keys: [jwk] }));

  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

  app.get('/oidc/authorize', async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q.client_id !== DEMO_OIDC.clientId) return reply.code(400).type('text/plain').send('unknown client_id');
    if (q.response_type !== 'code') return reply.code(400).type('text/plain').send('unsupported response_type');
    const params = new URLSearchParams(q);
    const rows = DEMO_IDENTITIES.map((i) => {
      const p = new URLSearchParams(params);
      p.set('login', i.sub);
      // nosemgrep: javascript.express.security.injection.raw-html-format.raw-html-format -- every value is HTML-escaped with esc(); dev/demo-only mock identity provider
      return `<li><a class="acc" href="/mock/oidc/authorize/approve?${esc(p.toString())}"><b>${esc(i.name)}</b><br><small>${esc(i.preferred_username)} · roles: ${esc(i.roles.join(', ') || 'none')}</small></a></li>`;
    }).join('');
    return reply
      .type('text/html')
      .send(
        `<!doctype html><meta charset="utf-8"><title>Sign in – Demo identity provider</title><style>body{font-family:Segoe UI,sans-serif;background:#f3f2f1;margin:0}main{max-width:420px;margin:60px auto;background:#fff;padding:32px;box-shadow:0 2px 6px #0002}ul{list-style:none;padding:0}a.acc{display:block;padding:10px 12px;margin:6px 0;border:1px solid #ddd;color:#222;text-decoration:none}a.acc:hover{background:#f0f6ff}</style><main><h2>Pick an account</h2><p>Simulated Microsoft Entra ID (demo mode). In real use your company sign-in page appears here.</p><ul>${rows}</ul></main>`,
      );
  });

  app.get('/oidc/authorize/approve', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const identity = DEMO_IDENTITIES.find((i) => i.sub === q.login);
    if (!identity || q.client_id !== DEMO_OIDC.clientId || !q.redirect_uri) return reply.code(400).type('text/plain').send('invalid request');
    const code = crypto.randomBytes(16).toString('base64url');
    codes.set(code, { identity, clientId: q.client_id, redirectUri: q.redirect_uri, nonce: q.nonce, challenge: q.code_challenge, expires: Date.now() + 60000 });
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
      iss: issuerOf(req.headers.host),
      sub: i.sub,
      aud: clientId,
      iat: now,
      exp: now + 600,
      nonce: entry.nonce,
      name: i.name,
      preferred_username: i.preferred_username,
      email: i.preferred_username,
      roles: i.roles,
    };
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
    const body = b64url(JSON.stringify(payload));
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
    return { access_token: crypto.randomBytes(16).toString('hex'), token_type: 'Bearer', expires_in: 600, id_token: `${head}.${body}.${sig}` };
  });
}
