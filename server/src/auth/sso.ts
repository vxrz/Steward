import * as oidc from 'openid-client';
import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import { z } from 'zod';
import { ROLES, type Role, type SsoDiscoveryResult, type SsoProvider, type SsoProviderInput, type SsoProviderPublic } from '@sm/shared';
import { db } from '../db.js';
import { vault } from '../vault.js';
import { audit } from '../audit.js';
import { HttpError, newId, nowIso, parseJson, sha256 } from '../util.js';
import { checkMac, configMac } from '../integrity.js';
import { readSetting, writeSetting } from '../settings.js';
import { createSession, findUserByName, getUser, listTeams, listUsers, type CreatedSession } from './users.js';
import { BRAND } from '@sm/shared';
import { config as appConfig } from '../config.js';

/**
 * Single sign-on with OpenID Connect (authorization code flow + PKCE).
 * Works with Microsoft Entra ID and any standard OIDC provider (Okta, Keycloak,
 * Google Workspace, ADFS 2019+ …). Tokens are validated by openid-client
 * (issuer, audience, signature via JWKS, expiry, nonce, state, PKCE).
 */

const providerSchema = z.object({
  displayName: z.string().min(1).max(80),
  type: z.enum(['entra', 'oidc']),
  issuer: z.string().url(),
  clientId: z.string().min(1),
  clientAuth: z.enum(['client_secret_post', 'client_secret_basic', 'none']).default('client_secret_post'),
  scopes: z.string().default('openid profile email'),
  usernameClaim: z.string().default('preferred_username'),
  displayNameClaim: z.string().default('name'),
  emailClaim: z.string().default('email'),
  groupsClaim: z.string().default('roles'),
  mappings: z
    .array(
      z.object({ claimValue: z.string().min(1), roles: z.array(z.enum(ROLES)).max(ROLES.length).default([]), teams: z.array(z.string()).max(100).default([]) }),
    )
    .max(500)
    .default([]),
  defaultRoles: z.array(z.enum(ROLES)).max(ROLES.length).default([]),
  autoProvision: z.boolean().default(true),
  syncRoles: z.boolean().default(true),
  requireMapping: z.boolean().default(false),
  enabled: z.boolean().default(true),
  clientSecret: z.string().optional(),
});

interface ProviderRow {
  id: string;
  config: string;
  secret: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
  config_mac?: string | null;
}

// ---------- configuration integrity (issuer, client id, claims and role mappings decide who gets in) ----------

const secretDigest = (blob: string | null): string | null => {
  if (!blob) return null;
  try {
    return sha256(JSON.stringify(vault().decrypt(blob))); // plaintext: stays valid when the data key is rotated
  } catch {
    return 'undecryptable';
  }
};
const macFields = (r: Pick<ProviderRow, 'config' | 'secret' | 'enabled'>) => ({
  v: 1,
  config: parseJson<unknown>(r.config, null),
  enabled: !!r.enabled,
  secret: secretDigest(r.secret),
});

function sealProvider(id: string): void {
  if (!vault().unlocked) return;
  const r = db().get<ProviderRow>('SELECT * FROM identity_providers WHERE id = ?', id);
  if (r) db().run('UPDATE identity_providers SET config_mac = ? WHERE id = ?', configMac('sso', id, macFields(r)), id);
}

/** One-time sealing of providers created before configuration integrity existed (first unlock after the update). */
export function sealProviderConfigs(): void {
  if (!vault().unlocked || readSetting('security.ssoSealsCreated', false)) return;
  db().tx(() => {
    for (const r of db().all<{ id: string }>('SELECT id FROM identity_providers WHERE config_mac IS NULL')) sealProvider(r.id);
    writeSetting('security.ssoSealsCreated', true);
  });
}

function requireIntactProvider(p: SsoProvider): void {
  const r = db().get<ProviderRow>('SELECT * FROM identity_providers WHERE id = ?', p.id);
  const state = r ? checkMac('sso', p.id, macFields(r), r.config_mac) : 'mismatch';
  if (state === 'mismatch' || state === 'unsealed') {
    throw new HttpError(
      409,
      `The settings of the sign-in provider "${p.displayName}" were changed outside ${BRAND.name} – an administrator has to review and save them again`,
      'SSO_CONFIG_UNVERIFIED',
    );
  }
}

function toProvider(r: ProviderRow): SsoProvider {
  const c = parseJson<Omit<SsoProvider, 'id' | 'hasClientSecret' | 'enabled' | 'createdAt' | 'updatedAt'>>(r.config, {} as never);
  return { ...c, id: r.id, enabled: !!r.enabled, hasClientSecret: !!r.secret, createdAt: r.created_at, updatedAt: r.updated_at };
}

export function listProviders(): SsoProvider[] {
  return db().all<ProviderRow>('SELECT * FROM identity_providers ORDER BY created_at').map(toProvider);
}

export function publicProviders(): SsoProviderPublic[] {
  return listProviders()
    .filter((p) => p.enabled)
    .map((p) => ({ id: p.id, displayName: p.displayName, type: p.type }));
}

export function getProvider(id: string): SsoProvider {
  const r = db().get<ProviderRow>('SELECT * FROM identity_providers WHERE id = ?', id);
  if (!r) throw new HttpError(404, 'Sign-in provider not found');
  return toProvider(r);
}

function providerSecret(id: string): string | undefined {
  const r = db().get<{ secret: string | null }>('SELECT secret FROM identity_providers WHERE id = ?', id);
  if (!r?.secret) return undefined;
  if (!vault().unlocked) throw new HttpError(423, 'Single sign-on is not available until an administrator unlocks the vault', 'SSO_VAULT_LOCKED');
  return vault().decrypt<string>(r.secret);
}

export function saveProvider(input: SsoProviderInput, id?: string): SsoProvider {
  const parsed = providerSchema.parse(input);
  const { clientSecret, enabled, ...config } = parsed;
  config.issuer = config.issuer.replace(/\/+$/, '');
  const pid = id ?? newId('idp_');
  const ts = nowIso();
  db().tx(() => {
    if (id) {
      const before = getProvider(id);
      db().run('UPDATE identity_providers SET config = ?, enabled = ?, updated_at = ? WHERE id = ?', JSON.stringify(config), enabled ? 1 : 0, ts, id);
      if (clientSecret !== undefined) {
        db().run('UPDATE identity_providers SET secret = ? WHERE id = ?', clientSecret ? vault().encrypt(clientSecret) : null, id);
      }
      sealProvider(id);
      audit({
        action: 'sso.provider_updated',
        entityType: 'sso',
        entityId: id,
        summary: `Sign-in provider "${config.displayName}" updated${clientSecret !== undefined ? ' (client secret changed)' : ''}${before.enabled !== enabled ? (enabled ? ', enabled' : ', disabled') : ''}`,
        details: { ...config, enabled },
      });
    } else {
      db().run(
        'INSERT INTO identity_providers (id, config, secret, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        pid,
        JSON.stringify(config),
        clientSecret ? vault().encrypt(clientSecret) : null,
        enabled ? 1 : 0,
        ts,
        ts,
      );
      sealProvider(pid);
      audit({
        action: 'sso.provider_created',
        entityType: 'sso',
        entityId: pid,
        summary: `Sign-in provider "${config.displayName}" added (${config.issuer})`,
        details: { ...config, enabled },
      });
    }
  });
  configCache.delete(pid);
  return getProvider(pid);
}

export function deleteProvider(id: string): void {
  const p = getProvider(id);
  db().tx(() => {
    db().run('DELETE FROM identity_providers WHERE id = ?', id);
    audit({ action: 'sso.provider_deleted', entityType: 'sso', entityId: id, summary: `Sign-in provider "${p.displayName}" deleted` });
  });
  configCache.delete(id);
}

// ---------- OIDC client configuration ----------

const proxyAgent = new EnvHttpProxyAgent();
const proxiedFetch = ((url: string, options: Record<string, unknown>) =>
  undiciFetch(url, { ...(options as object), dispatcher: proxyAgent } as never)) as unknown as oidc.CustomFetch;

const isLocalHttp = (issuer: string) => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(issuer + '/');

const configCache = new Map<string, { stamp: string; config: oidc.Configuration }>();

async function clientConfig(p: SsoProvider): Promise<oidc.Configuration> {
  requireIntactProvider(p);
  const hit = configCache.get(p.id);
  if (hit && hit.stamp === p.updatedAt) return hit.config;
  const secret = p.clientAuth === 'none' ? undefined : providerSecret(p.id);
  if (p.clientAuth !== 'none' && !secret) throw new HttpError(400, `No client secret stored for "${p.displayName}"`);
  const auth = p.clientAuth === 'none' ? oidc.None() : p.clientAuth === 'client_secret_basic' ? oidc.ClientSecretBasic(secret) : oidc.ClientSecretPost(secret);
  const config = await oidc.discovery(new URL(p.issuer), p.clientId, undefined, auth, {
    [oidc.customFetch]: proxiedFetch,
    timeout: 15,
    // plain http is only accepted for an identity provider on this machine (demo / development)
    execute: isLocalHttp(p.issuer) ? [oidc.allowInsecureRequests] : [],
  });
  configCache.set(p.id, { stamp: p.updatedAt, config });
  return config;
}

export async function discover(issuer: string): Promise<SsoDiscoveryResult> {
  try {
    const config = await oidc.discovery(new URL(issuer.replace(/\/+$/, '')), 'discovery-test', undefined, oidc.None(), {
      [oidc.customFetch]: proxiedFetch,
      timeout: 15,
      execute: isLocalHttp(issuer) ? [oidc.allowInsecureRequests] : [],
    });
    const m = config.serverMetadata();
    return {
      ok: true,
      message: 'Discovery document found',
      issuer: m.issuer,
      authorizationEndpoint: m.authorization_endpoint,
      tokenEndpoint: m.token_endpoint,
      scopesSupported: m.scopes_supported,
      claimsSupported: m.claims_supported,
    };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

// ---------- Sign-in flow ----------

interface Pending {
  providerId: string;
  verifier: string;
  nonce: string;
  redirectUri: string;
  returnTo: string;
  expires: number;
}
const pending = new Map<string, Pending>();
const STATE_TTL_MS = 10 * 60 * 1000;
/** Sign-ins in progress are started without signing in: bounded, the oldest is dropped (no memory exhaustion by a flood). */
export const MAX_PENDING_SIGN_INS = 5000;
const MAX_RETURN_TO = 1024;
export const pendingSignIns = (): number => pending.size;

function safeReturnTo(path: unknown): string {
  // only same-site relative paths (no protocol-relative //host)
  return typeof path === 'string' && path.length <= MAX_RETURN_TO && /^\/(?!\/)[\w\-./?=&%#]*$/.test(path) && !path.startsWith('/api/') ? path : '/';
}

export async function startSignIn(providerId: string, redirectUri: string, returnTo?: string): Promise<string> {
  const p = getProvider(providerId);
  if (!p.enabled) throw new HttpError(400, 'This sign-in provider is disabled');
  const config = await clientConfig(p);
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
  while (pending.size >= MAX_PENDING_SIGN_INS) pending.delete(pending.keys().next().value!);
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const verifier = oidc.randomPKCECodeVerifier();
  pending.set(state, { providerId, verifier, nonce, redirectUri, returnTo: safeReturnTo(returnTo), expires: now + STATE_TTL_MS });
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: p.scopes || 'openid profile email',
    response_type: 'code',
    state,
    nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    ...(p.type === 'entra' ? { prompt: 'select_account' } : {}),
  });
  return url.href;
}

function claimList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') return v.split(/[\s,]+/).filter(Boolean);
  return [];
}

/** Handle the redirect back from the identity provider. Returns a session token and where to go next. */
export async function finishSignIn(
  currentUrl: URL,
  meta: { ip?: string; userAgent?: string },
): Promise<CreatedSession & { returnTo: string; username: string }> {
  const state = currentUrl.searchParams.get('state') ?? '';
  const flow = pending.get(state);
  if (!flow || flow.expires < Date.now()) throw new HttpError(400, 'The sign-in attempt expired or is unknown – please try again');
  pending.delete(state);
  const idpError = currentUrl.searchParams.get('error');
  if (idpError) throw new HttpError(400, `Identity provider: ${currentUrl.searchParams.get('error_description') ?? idpError}`);
  const p = getProvider(flow.providerId);
  const config = await clientConfig(p);
  // openid-client compares the callback URL with the registered redirect URI
  const callback = new URL(flow.redirectUri);
  callback.search = currentUrl.search;
  const tokens = await oidc.authorizationCodeGrant(config, callback, {
    pkceCodeVerifier: flow.verifier,
    expectedState: state,
    expectedNonce: flow.nonce,
    idTokenExpected: true,
  });
  const claims = tokens.claims() as Record<string, unknown> | undefined;
  if (!claims?.sub) throw new HttpError(400, 'The identity provider did not return an ID token');
  const user = provisionUser(p, claims);
  const session = createSession(user.id, user.username, meta, p.displayName);
  return { ...session, returnTo: flow.returnTo, username: user.username };
}

function provisionUser(p: SsoProvider, claims: Record<string, unknown>) {
  const externalId = `${p.id}:${String(claims.sub)}`;
  const username = String(claims[p.usernameClaim] ?? claims[p.emailClaim] ?? claims.sub)
    .trim()
    .toLowerCase();
  const displayName = String(claims[p.displayNameClaim] ?? username);
  const email = claims[p.emailClaim] ? String(claims[p.emailClaim]) : undefined;
  const values = claimList(claims[p.groupsClaim]).map((v) => v.toLowerCase());
  const matched = p.mappings.filter((m) => values.includes(m.claimValue.trim().toLowerCase()));
  const deny = (reason: string): never => {
    audit({
      actor: username,
      action: 'auth.login_failed',
      entityType: 'sso',
      entityId: p.id,
      summary: `Single sign-on of "${username}" via ${p.displayName} denied: ${reason}`,
    });
    throw new HttpError(403, reason);
  };
  if (p.requireMapping && matched.length === 0) {
    deny(`Your account has no role assigned for ${BRAND.name} (claim "${p.groupsClaim}")`);
  }
  const mappedRoles = [...new Set([...p.defaultRoles, ...matched.flatMap((m) => m.roles)])] as Role[];
  const managedTeams = new Set(p.mappings.flatMap((m) => m.teams.map((t) => t.toLowerCase())));
  const wantedTeams = new Set(matched.flatMap((m) => m.teams.map((t) => t.toLowerCase())));

  // ----- decide (read-only) – denials are audited outside any transaction -----
  const linked = db().get<{ id: string; active: number }>('SELECT id, active FROM users WHERE external_id = ?', externalId);
  const existing = linked ? undefined : findUserByName(username);
  if (existing && existing.authSource !== 'local' && existing.authSource !== p.id) deny(`The user name "${username}" belongs to another sign-in provider`);
  if (!linked && !existing && !p.autoProvision) deny(`No ${BRAND.name} account exists for "${username}" – ask an administrator`);
  if ((linked && !linked.active) || (existing && !existing.active)) deny(`Your ${BRAND.name} account is disabled`);

  // ----- apply -----
  let userId = linked?.id ?? existing?.id ?? '';
  const created = !linked && !existing;
  db().tx(() => {
    if (existing) {
      // pre-created (or local) account with the same user name → link it
      db().run(
        'UPDATE users SET external_id = ?, auth_source = ?, password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?',
        externalId,
        p.id,
        '!sso',
        nowIso(),
        existing.id,
      );
      audit({
        action: 'user.linked_sso',
        entityType: 'user',
        entityId: existing.id,
        actor: username,
        summary: `Account "${username}" linked to ${p.displayName}`,
      });
    } else if (created) {
      userId = newId('usr_');
      const ts = nowIso();
      db().run(
        `INSERT INTO users (id, username, display_name, email, password_hash, roles, active, must_change_password, created_at, updated_at, auth_source, external_id)
         VALUES (?, ?, ?, ?, '!sso', '[]', 1, 0, ?, ?, ?, ?)`,
        userId,
        username,
        displayName,
        email ?? null,
        ts,
        ts,
        p.id,
        externalId,
      );
      audit({
        actor: username,
        action: 'user.created',
        entityType: 'user',
        entityId: userId,
        summary: `User "${username}" created on first sign-in via ${p.displayName}`,
        details: { claimValues: matched.map((m) => m.claimValue) },
      });
    }
    db().run('UPDATE users SET display_name = ?, email = COALESCE(?, email) WHERE id = ?', displayName, email ?? null, userId);
    if (created || p.syncRoles) {
      const user = getUser(userId);
      syncRolesAndTeams(p, user.id, user.username, user.roles, mappedRoles, managedTeams, wantedTeams);
    }
  });
  return getUser(userId);
}

function syncRolesAndTeams(
  p: SsoProvider,
  userId: string,
  username: string,
  current: Role[],
  wanted: Role[],
  managedTeams: Set<string>,
  wantedTeams: Set<string>,
) {
  const roles = [...wanted];
  if (current.includes('admin') && !roles.includes('admin')) {
    const otherAdmins = listUsers().filter((u) => u.active && u.roles.includes('admin') && u.id !== userId);
    if (!otherAdmins.length) roles.push('admin'); // never remove the last administrator
  }
  const changed = JSON.stringify([...roles].sort()) !== JSON.stringify([...current].sort());
  if (changed) {
    db().run('UPDATE users SET roles = ?, updated_at = ? WHERE id = ?', JSON.stringify(roles), nowIso(), userId);
  }
  const teamChanges: string[] = [];
  for (const t of listTeams()) {
    const key = t.name.toLowerCase();
    if (!managedTeams.has(key)) continue;
    const member = t.members.some((m) => m.toLowerCase() === username.toLowerCase());
    if (wantedTeams.has(key) && !member) {
      db().run('INSERT INTO team_members (team_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING', t.id, userId);
      teamChanges.push(`+${t.name}`);
    } else if (!wantedTeams.has(key) && member) {
      db().run('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', t.id, userId);
      teamChanges.push(`-${t.name}`);
    }
  }
  if (changed || teamChanges.length) {
    audit({
      actor: username,
      action: 'user.roles_synced',
      entityType: 'user',
      entityId: userId,
      summary: `Roles of "${username}" synchronised from ${p.displayName}: ${current.join(',') || '–'} → ${roles.join(',') || '–'}${teamChanges.length ? `; teams ${teamChanges.join(' ')}` : ''}`,
      details: { roles, teams: teamChanges },
    });
  }
}

/** Redirect URI to register at the identity provider. */
export function redirectUriFor(req: { protocol: string; host: string }): string {
  // SM_PUBLIC_URL includes the base path; without it the request's address (X-Forwarded-Proto/-Host only from SM_TRUST_PROXY)
  const base = appConfig.publicUrl ?? `${req.protocol}://${req.host}${appConfig.basePath}`;
  return `${base}/api/auth/oidc/callback`;
}
