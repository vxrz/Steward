import crypto from 'node:crypto';
import * as oidc from 'openid-client';
import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import { z } from 'zod';
import {
  ROLES,
  SSO_GROUP_VALUES,
  SSO_LIMITS,
  SSO_LINK_POLICIES,
  SSO_PRESETS,
  SSO_PROFILE_KEY,
  SSO_SYNC_RULES,
  SSO_USERNAME_TRANSFORMS,
  SSO_DOMAIN,
  emailIdentifies,
  stableIdProblem,
  ssoConfigWarnings,
  type ErrorParams,
  type Role,
  type SsoConfigWarning,
  type SsoDiscoveryResult,
  type SsoProvider,
  type SsoProviderInput,
  type SsoProviderPublic,
  type SsoSignInPreview,
  type SsoTestResult,
  type SsoTestStart,
  type StepUpAction,
  type UserInfo,
} from '@sm/shared';
import { db } from '../db.js';
import { vault } from '../vault.js';
import { audit } from '../audit.js';
import { logger } from '../log.js';
import { HttpError, newId, nowIso, parseJson, sha256 } from '../util.js';
import { checkMac, configMac } from '../integrity.js';
import { readSetting, writeSetting } from '../settings.js';
import { createSession, getUser, listTeams, listUsers, type CreatedSession } from './users.js';
import { BRAND, TEAM_ROLES } from '@sm/shared';
import { config as appConfig } from '../config.js';
import { aliasTarget } from './aliases.js';
import {
  claimAt,
  claimList,
  claimText,
  emailVerified,
  SSO_USERNAME,
  groupOverage,
  identityKeys,
  keyClaimNames,
  keyIssuer,
  withIssuer,
  profileValues,
  renderTemplate,
  shownClaims,
  transformUsername,
  withDefaults,
  type ProviderConfig,
} from './sso-claims.js';

/**
 * Single sign-on with OpenID Connect (authorization code flow + PKCE).
 * Works with Microsoft Entra ID and any standard OIDC provider (Okta, Keycloak,
 * Google Workspace, Authentik, ADFS 2019+ …). Tokens are validated by openid-client
 * (issuer, audience, signature via JWKS, expiry, nonce, state, PKCE).
 *
 * How claims become an account (user name, names, profile fields, the stable identifier, which existing account an
 * identity may link) is decided by `decide` without changing anything – the test sign-in shows exactly that – and
 * applied by `provisionUser` at a real sign-in. See docs/SSO.md.
 */

const claimName = z.string().trim().max(SSO_LIMITS.claimName);
const syncRule = z.enum(SSO_SYNC_RULES);

const providerSchema = z.object({
  displayName: z.string().min(1).max(80),
  type: z.enum(['entra', 'oidc']),
  issuer: z.string().url().max(500),
  clientId: z.string().min(1).max(500),
  clientAuth: z.enum(['client_secret_post', 'client_secret_basic', 'none']).default('client_secret_post'),
  scopes: z.string().max(500).default('openid profile email'),
  usernameClaim: claimName.default('preferred_username'),
  displayNameClaim: claimName.default('name'),
  emailClaim: claimName.default('email'),
  groupsClaim: claimName.default('roles'),
  mappings: z
    .array(
      z.object({
        claimValue: z.string().min(1).max(500),
        roles: z.array(z.enum(ROLES)).max(ROLES.length).default([]),
        teams: z.array(z.string().max(64)).max(100).default([]),
        teamRoles: z.array(z.enum(TEAM_ROLES)).max(TEAM_ROLES.length).default([]),
      }),
    )
    .max(500)
    .default([]),
  defaultRoles: z.array(z.enum(ROLES)).max(ROLES.length).default([]),
  autoProvision: z.boolean().default(true),
  syncRoles: z.boolean().default(true),
  requireMapping: z.boolean().default(false),
  enabled: z.boolean().default(true),
  clientSecret: z.string().max(4096).optional(),
  /** Not stored: when the issuer changes, keep the accounts linked (the new issuer issues the same subjects, e.g. a renamed host) */
  keepLinksOnIssuerChange: z.boolean().optional(),
  // added with #77 – optional: a request without them keeps the stored values (new providers: the defaults)
  preset: z.enum(SSO_PRESETS).optional(),
  stableIdClaims: z.array(claimName.min(1)).min(1).max(SSO_LIMITS.stableIdClaims).optional(),
  usernameTransform: z.enum(SSO_USERNAME_TRANSFORMS).optional(),
  stripDomains: z.array(z.string().trim().toLowerCase().max(253).regex(SSO_DOMAIN, 'A domain such as contoso.com')).max(SSO_LIMITS.stripDomains).optional(),
  /** The stable id claims the administrator confirmed as unique per person (must equal stableIdClaims) */
  stableIdConfirmedClaims: z.array(claimName.min(1)).max(SSO_LIMITS.stableIdClaims).optional(),
  /** false: the administrator decided about the email_verified notice of a provider from before #77 */
  emailVerificationNotice: z.boolean().optional(),
  displayNameTemplate: z.string().trim().max(SSO_LIMITS.template).optional(),
  firstNameClaim: claimName.optional(),
  lastNameClaim: claimName.optional(),
  profileFields: z
    .array(
      z.object({
        key: z.string().regex(SSO_PROFILE_KEY, 'Field key: a letter, then letters, digits or _ (at most 40)'),
        label: z.string().trim().min(1).max(80),
        claim: claimName.min(1),
        sync: syncRule.default('always'),
      }),
    )
    .max(SSO_LIMITS.profileFields)
    .optional(),
  sync: z.object({ displayName: syncRule.optional(), firstName: syncRule.optional(), lastName: syncRule.optional(), email: syncRule.optional() }).optional(),
  groupValues: z.enum(SSO_GROUP_VALUES).optional(),
  linkExisting: z.enum(SSO_LINK_POLICIES).optional(),
  emailVerifiedByProvider: z.boolean().optional(),
  useUserinfo: z.boolean().optional(),
  requiredClaims: z
    .array(
      z.object({
        claim: claimName.min(1),
        values: z.array(z.string().trim().min(1).max(200)).min(1, 'Enter at least one accepted value').max(SSO_LIMITS.requiredClaimValues),
      }),
    )
    .max(SSO_LIMITS.requiredClaims)
    .optional(),
  // added with #14 (step-up re-authentication)
  stepUpMfa: z.boolean().optional(),
  stepUpAcrValues: z
    .string()
    .max(200)
    .transform((v) => v.trim().split(/\s+/).filter(Boolean).join(' '))
    .refine((v) => /^[\x21-\x7e ]*$/.test(v), 'Space-separated acr values')
    .optional(),
  stepUpAuthContext: z
    .string()
    .trim()
    .regex(/^(c([1-9]|[1-9][0-9]))?$/, 'An authentication context id from c1 to c99')
    .optional(),
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

/** `warnings`: only for administrators (they read the accounts – never for the sign-in page or a sign-in). */
function toProvider(r: ProviderRow, warnings = false): SsoProvider {
  // settings a provider was saved without (it stays sealed as stored) are read with today's behaviour
  const c = withDefaults(parseJson<ProviderConfig>(r.config, { type: 'oidc' } as ProviderConfig));
  const p = { ...c, id: r.id, enabled: !!r.enabled, hasClientSecret: !!r.secret, createdAt: r.created_at, updatedAt: r.updated_at };
  return { ...p, warnings: warnings ? providerWarnings(p) : [] };
}

/**
 * Providers saved before #77 whose sign-ins now need email_verified (the e-mail claim names or identifies accounts):
 * at a provider that never sends it, everyone is refused until an administrator decides (see the startup log).
 */
function emailNowRequired(p: ProviderConfig): boolean {
  return p.emailVerificationNotice && emailIdentifies(p) && !p.emailVerifiedByProvider;
}

/** Startup: name the providers whose sign-ins need email_verified since this version. */
export function warnEmailVerifiedProviders(): void {
  for (const r of db().all<ProviderRow>('SELECT * FROM identity_providers')) {
    const stored = parseJson<ProviderConfig>(r.config, { type: 'oidc' } as ProviderConfig);
    if (emailNowRequired(withDefaults(stored))) {
      logger.warn(
        { provider: r.id, name: stored.displayName },
        'single sign-on: the e-mail claim names or identifies accounts of this provider – its sign-ins need email_verified=true now; if the provider never sends it but verifies every address, set "This provider verifies e-mail addresses" (docs/SSO.md#e-mail-confirmation)',
      );
    }
  }
}

/**
 * Accounts of this provider whose user names would be the same after the user name rule: a new identity with such a
 * name is refused (the account is linked to another identity) – the editor shows them after saving.
 */
function usernameCollisions(id: string, how: ProviderConfig['usernameTransform'], domains: string[]): string[] {
  if (how !== 'stripDomain') return []; // user names are unique ignoring case already
  const seen = new Map<string, string[]>();
  for (const u of db().all<{ username: string }>('SELECT username FROM users WHERE auth_source = ?', id)) {
    const k = transformUsername(u.username, how, domains);
    if (k !== null) seen.set(k, [...(seen.get(k) ?? []), u.username]);
  }
  return [...seen.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([k, names]) => `${k} ← ${names.slice(0, 5).join(', ')}`)
    .slice(0, 10);
}

function providerWarnings(p: Omit<SsoProvider, 'warnings'>): SsoConfigWarning[] {
  const out = ssoConfigWarnings(p);
  if (emailNowRequired(p)) out.push({ code: 'EMAIL_VERIFIED_NOW_REQUIRED', params: { claim: p.emailClaim } });
  const collisions = usernameCollisions(p.id, p.usernameTransform, p.stripDomains);
  if (collisions.length) out.push({ code: 'USERNAME_COLLISIONS', params: { names: collisions, count: collisions.length } });
  return out;
}

/** For administrators: with the warnings (they look at the accounts of each provider). */
export function listProviders(): SsoProvider[] {
  return db()
    .all<ProviderRow>('SELECT * FROM identity_providers ORDER BY created_at')
    .map((r) => toProvider(r, true));
}

/** The sign-in page's buttons (unauthenticated): no warnings, no account reads. */
export function publicProviders(): SsoProviderPublic[] {
  return db()
    .all<ProviderRow>('SELECT * FROM identity_providers WHERE enabled = 1 ORDER BY created_at')
    .map((r) => toProvider(r))
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

type ParsedInput = z.infer<typeof providerSchema>;

/** Every stored setting (in the order of the stored JSON). */
const CONFIG_KEYS: (keyof ProviderConfig)[] = [
  'displayName',
  'type',
  'preset',
  'issuer',
  'clientId',
  'clientAuth',
  'scopes',
  'usernameClaim',
  'usernameTransform',
  'stripDomains',
  'displayNameClaim',
  'displayNameTemplate',
  'firstNameClaim',
  'lastNameClaim',
  'emailClaim',
  'emailVerifiedByProvider',
  'stableIdClaims',
  'stableIdConfirmedClaims',
  'emailVerificationNotice',
  'profileFields',
  'sync',
  'groupsClaim',
  'groupValues',
  'mappings',
  'defaultRoles',
  'autoProvision',
  'syncRoles',
  'requireMapping',
  'linkExisting',
  'requiredClaims',
  'useUserinfo',
  'stepUpMfa',
  'stepUpAcrValues',
  'stepUpAuthContext',
];

/** Settings named in the audit entry when they change (all but the button label). */
const AUDITED_SETTINGS = CONFIG_KEYS.filter((k) => k !== 'displayName');

/** The stored configuration from a request: settings left out keep the stored values (new providers: the defaults). */
function configFrom(parsed: ParsedInput, before?: ProviderConfig): ProviderConfig {
  const { clientSecret: _s, enabled: _e, keepLinksOnIssuerChange: _k, sync, ...rest } = parsed;
  // new providers link only accounts an administrator bound to them (providers from before keep "by name", see withDefaults)
  const base = before ?? { ...withDefaults({ type: rest.type } as ProviderConfig), linkExisting: 'bound' as const };
  const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as Partial<ProviderConfig>;
  const c: ProviderConfig = { ...base, ...defined, sync: { ...base.sync, ...Object.fromEntries(Object.entries(sync ?? {}).filter(([, v]) => v)) } };
  c.issuer = c.issuer.trim().replace(/\/+$/, '');
  const keys = new Set<string>();
  for (const f of c.profileFields) {
    if (keys.has(f.key.toLowerCase())) throw new HttpError(400, `The profile field "${f.key}" is listed twice`, 'SSO_PROFILE_FIELD_TWICE', { key: f.key });
    keys.add(f.key.toLowerCase());
  }
  // stripping a domain anyone can have would let boss@evil.example claim "boss": only listed domains
  c.stripDomains = [...new Set(c.stripDomains)];
  if (c.usernameTransform === 'stripDomain' && !c.stripDomains.length) {
    throw new HttpError(400, 'Name the domains to strip from user names (e.g. contoso.com)', 'SSO_STRIP_DOMAINS_REQUIRED');
  }
  // the e-mail notice of a provider from before #77 stays until an administrator decides: turns on "verifies e-mail
  // addresses", dismisses it (emailVerificationNotice: false) or changes the settings by which e-mail names accounts
  const emailSettings = (x: ProviderConfig) => JSON.stringify([x.usernameClaim, x.emailClaim, [...x.stableIdClaims].sort()]);
  c.emailVerificationNotice =
    !!before?.emailVerificationNotice && parsed.emailVerificationNotice !== false && !c.emailVerifiedByProvider && emailSettings(before) === emailSettings(c);
  // every person needs an identifier of their own: a claim many people share (tid, groups …) would give them one
  // account; a confirmation counts only for exactly the claims it was given for
  if (stableIdProblem(c.stableIdClaims, c.stableIdConfirmedClaims)) {
    throw new HttpError(
      400,
      `The stable identifier (${c.stableIdClaims.join(', ')}) must name one person: include sub or oid, or confirm that the claims are unique per person`,
      'SSO_STABLE_ID_NOT_UNIQUE',
      { claims: c.stableIdClaims },
    );
  }
  return Object.fromEntries(CONFIG_KEYS.map((k) => [k, c[k]])) as ProviderConfig;
}

export function saveProvider(input: SsoProviderInput, id?: string): SsoProvider {
  const parsed = providerSchema.parse(input);
  const { clientSecret, enabled } = parsed;
  const before = id ? getProvider(id) : undefined;
  const config = configFrom(parsed, before);
  const pid = id ?? newId('idp_');
  const ts = nowIso();
  db().tx(() => {
    if (before) {
      const changed = AUDITED_SETTINGS.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(config[k]));
      db().run('UPDATE identity_providers SET config = ?, enabled = ?, updated_at = ? WHERE id = ?', JSON.stringify(config), enabled ? 1 : 0, ts, pid);
      if (clientSecret !== undefined) {
        db().run('UPDATE identity_providers SET secret = ? WHERE id = ?', clientSecret ? vault().encrypt(clientSecret) : null, pid);
      }
      const moved = before.issuer !== config.issuer;
      const kept = moved && parsed.keepLinksOnIssuerChange ? moveLinksToIssuer(pid, before.issuer, config.issuer) : 0;
      const rescoped = moved && !parsed.keepLinksOnIssuerChange ? rescopeLegacyLinks(pid, before.issuer) : 0;
      sealProvider(pid);
      audit({
        action: 'sso.provider_updated',
        entityType: 'sso',
        entityId: pid,
        summary: `Sign-in provider "${config.displayName}" updated${clientSecret !== undefined ? ' (client secret changed)' : ''}${before.enabled !== enabled ? (enabled ? ', enabled' : ', disabled') : ''}${changed.length ? `; changed: ${changed.join(', ')}` : ''}${rescoped ? `; ${rescoped} link(s) kept to the former issuer` : ''}${kept ? `; ${kept} link(s) moved to the new issuer` : ''}`,
        details: {
          ...config,
          enabled,
          changed,
          before: Object.fromEntries(changed.map((k) => [k, before[k]])),
          ...(rescoped ? { linksKeptToFormerIssuer: rescoped } : {}),
          ...(moved ? { keepLinksOnIssuerChange: !!parsed.keepLinksOnIssuerChange, linksMoved: kept } : {}),
        },
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
  return toProvider(db().get<ProviderRow>('SELECT * FROM identity_providers WHERE id = ?', pid)!, true);
}

/**
 * A new issuer is another namespace of subjects. Links from before the stable identifier setting (`<provider>:<sub>`)
 * name no issuer, so they are tied to the former one here – a person at the new issuer with the same sub cannot take
 * such an account over. (Every newer link names its issuer already.)
 */
function rescopeLegacyLinks(providerId: string, formerIssuer: string): number {
  let n = 0;
  for (const u of db().all<{ id: string; external_id: string | null }>('SELECT id, external_id FROM users WHERE auth_source = ?', providerId)) {
    if (!u.external_id?.startsWith(`${providerId}:`)) continue;
    const sub = u.external_id.slice(providerId.length + 1);
    const { subKey } = identityKeys(providerId, { iss: formerIssuer, sub }, ['sub']);
    // (an identity linked to two accounts cannot be told apart: the link is retired – it matches nobody)
    const taken = !!db().get('SELECT 1 FROM users WHERE external_id = ?', subKey);
    const key = taken ? `${providerId}#retired=${crypto.randomBytes(9).toString('base64url')}` : subKey;
    db().run('UPDATE users SET external_id = ?, external_sub = ? WHERE id = ?', key, taken ? null : subKey, u.id);
    n++;
  }
  return n;
}

/**
 * The administrator says the new issuer issues the same subjects (a renamed host, a new URL of the same realm): the
 * links that name the former issuer name the new one. Links from before the stable identifier setting name no issuer
 * and keep working as they are.
 */
function moveLinksToIssuer(providerId: string, formerIssuer: string, issuer: string): number {
  const former = formerIssuer.replace(/\/+$/, '');
  let n = 0;
  for (const u of db().all<{ id: string; external_id: string | null; external_sub: string | null }>(
    'SELECT id, external_id, external_sub FROM users WHERE auth_source = ?',
    providerId,
  )) {
    const move = (k: string | null) => (k && keyIssuer(k, providerId) === former ? withIssuer(k, providerId, issuer) : k);
    const sub = move(u.external_sub);
    // a hashed link names its issuer only inside the hash: it is re-linked at the next sign-in through the moved issuer +
    // sub (audited as user.sso_relinked) – a marker that matches nothing else
    const hashed = !!u.external_id?.startsWith(`${providerId}#h#`) && sub !== u.external_sub;
    const id = hashed ? `${providerId}#moved=${crypto.randomBytes(9).toString('base64url')}` : move(u.external_id);
    if (id === u.external_id && sub === u.external_sub) continue;
    if (id !== u.external_id && db().get('SELECT 1 FROM users WHERE external_id = ?', id)) continue; // linked there already
    db().run('UPDATE users SET external_id = ?, external_sub = ? WHERE id = ?', id, sub, u.id);
    n++;
  }
  return n;
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

/**
 * Discovery that accepts the issuer with or without a trailing slash (it is stored without one; Authentik's issuer
 * ends with one): openid-client compares the discovered issuer exactly, so a difference of only the slash is retried
 * with the discovered value. Any other difference is refused as before.
 */
async function discovery(issuer: string, clientId: string, auth: oidc.ClientAuth): Promise<oidc.Configuration> {
  const opts = (url: string) => ({
    [oidc.customFetch]: proxiedFetch,
    timeout: 15,
    // plain http is only accepted for an identity provider on this machine (demo / development)
    execute: isLocalHttp(url) ? [oidc.allowInsecureRequests] : [],
  });
  try {
    return await oidc.discovery(new URL(issuer), clientId, undefined, auth, opts(issuer));
  } catch (e) {
    const found = (e as { cause?: { body?: { issuer?: unknown } } }).cause?.body?.issuer;
    if (typeof found === 'string' && found !== issuer && found.replace(/\/+$/, '') === issuer.replace(/\/+$/, '')) {
      return oidc.discovery(new URL(found), clientId, undefined, auth, opts(found));
    }
    throw e;
  }
}

async function clientConfig(p: SsoProvider): Promise<oidc.Configuration> {
  requireIntactProvider(p);
  const hit = configCache.get(p.id);
  if (hit && hit.stamp === p.updatedAt) return hit.config;
  const secret = p.clientAuth === 'none' ? undefined : providerSecret(p.id);
  if (p.clientAuth !== 'none' && !secret) throw new HttpError(400, `No client secret stored for "${p.displayName}"`);
  const auth = p.clientAuth === 'none' ? oidc.None() : p.clientAuth === 'client_secret_basic' ? oidc.ClientSecretBasic(secret) : oidc.ClientSecretPost(secret);
  const config = await discovery(p.issuer, p.clientId, auth);
  configCache.set(p.id, { stamp: p.updatedAt, config });
  return config;
}

export async function discover(issuer: string): Promise<SsoDiscoveryResult> {
  try {
    const config = await discovery(issuer.replace(/\/+$/, ''), 'discovery-test', oidc.None());
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
  /** A test sign-in by an administrator: records the claims, never signs in or changes an account */
  test?: { testId: string };
  /** A step-up of a signed-in session: checks the identity, never signs in or changes an account */
  stepUp?: { sessionId: string; userId: string; popup: boolean; actions: StepUpAction[]; startedAt: number };
}
const pending = new Map<string, Pending>();
const STATE_TTL_MS = 10 * 60 * 1000;
/** Sign-ins in progress are started without signing in: bounded, the oldest is dropped (no memory exhaustion by a flood). */
export const MAX_PENDING_SIGN_INS = 5000;
const MAX_RETURN_TO = 1024;
export const pendingSignIns = (): number => pending.size;

function safeReturnTo(path: unknown): string {
  // only same-site relative paths (no protocol-relative //host)
  return typeof path === 'string' && path.length <= MAX_RETURN_TO && /^\/(?!\/)[\w\-./?=&%#+~]*$/.test(path) && !path.startsWith('/api/') ? path : '/';
}

async function authorizationUrl(p: SsoProvider, config: oidc.Configuration, flow: Omit<Pending, 'verifier' | 'nonce' | 'expires'>): Promise<string> {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
  while (pending.size >= MAX_PENDING_SIGN_INS) pending.delete(pending.keys().next().value!);
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const verifier = oidc.randomPKCECodeVerifier();
  pending.set(state, { ...flow, verifier, nonce, expires: now + STATE_TTL_MS });
  // a test asks for the account again (it may be another one than the administrator's own); a step-up asks for a fresh
  // sign-in (prompt=login, max_age=0) – Google does not take prompt=login and goes by max_age
  const prompt = flow.stepUp ? (p.preset === 'google' ? undefined : 'login') : p.type === 'entra' ? 'select_account' : flow.test ? 'login' : undefined;
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: flow.redirectUri,
    scope: p.scopes || 'openid profile email',
    response_type: 'code',
    state,
    nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    ...(prompt ? { prompt } : {}),
    ...(flow.stepUp ? stepUpParameters(p) : {}),
  });
  return url.href;
}

/** What a step-up asks the provider for: a fresh sign-in, and multi-factor authentication when the provider requires it. */
function stepUpParameters(p: SsoProvider): Record<string, string> {
  const out: Record<string, string> = { max_age: '0' };
  if (!p.stepUpMfa) return out;
  // Entra ID: a Conditional Access authentication context (its policy decides: MFA, a compliant device …)
  if (p.type === 'entra' && p.stepUpAuthContext) out.claims = JSON.stringify({ id_token: { acrs: { essential: true, value: p.stepUpAuthContext } } });
  else if (p.stepUpAcrValues) out.acr_values = p.stepUpAcrValues;
  return out;
}

export async function startSignIn(providerId: string, redirectUri: string, returnTo?: string): Promise<string> {
  const p = getProvider(providerId);
  if (!p.enabled) throw new HttpError(400, 'This sign-in provider is disabled');
  const config = await clientConfig(p);
  return authorizationUrl(p, config, { providerId, redirectUri, returnTo: safeReturnTo(returnTo) });
}

type Claims = Record<string, unknown>;

interface ReceivedClaims {
  idToken: Claims;
  userinfo?: Claims;
  userinfoError?: string;
}

/** The claims of the redirect back from the identity provider (code exchange, ID token validation, optionally userinfo). */
async function receiveClaims(p: SsoProvider, flow: Pending, state: string, currentUrl: URL, wantUserinfo: boolean): Promise<ReceivedClaims> {
  const idpError = currentUrl.searchParams.get('error');
  if (idpError) throw new HttpError(400, `Identity provider: ${(currentUrl.searchParams.get('error_description') ?? idpError).slice(0, 300)}`);
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
  const idToken = tokens.claims() as Claims | undefined;
  if (!idToken?.sub) throw new HttpError(400, 'The identity provider did not return an ID token');
  const out: ReceivedClaims = { idToken: { ...idToken } };
  if (wantUserinfo && config.serverMetadata().userinfo_endpoint && tokens.access_token) {
    try {
      // the userinfo response must name the same subject (checked by openid-client)
      out.userinfo = { ...(await oidc.fetchUserInfo(config, tokens.access_token, String(idToken.sub))) } as Claims;
    } catch (e) {
      out.userinfoError = (e as Error).message.slice(0, 300);
    }
  }
  return out;
}

/** The claims a decision uses: the ID token's, completed by userinfo when the provider is set to read it (the ID token wins). */
function mergedClaims(c: Pick<ProviderConfig, 'useUserinfo' | 'emailClaim'>, r: ReceivedClaims): Claims {
  if (!c.useUserinfo || !r.userinfo) return r.idToken;
  const merged: Claims = { ...r.userinfo, ...r.idToken };
  // the confirmation belongs to the address it was given for: email_verified from the source of the e-mail claim
  const source = claimAt(r.idToken, c.emailClaim) !== undefined ? r.idToken : claimAt(r.userinfo, c.emailClaim) !== undefined ? r.userinfo : r.idToken;
  if (source.email_verified === undefined) delete merged.email_verified;
  else merged.email_verified = source.email_verified;
  return merged;
}

export type CallbackResult =
  ({ kind: 'session'; returnTo: string; username: string } & CreatedSession) | { kind: 'test'; ok: boolean; locale: string | null } | StepUpCallback;

/** A step-up's callback: checked, for the session that started it – the browser holding it redeems the result (step-up.ts). */
export type StepUpCallback = {
  kind: 'stepUp';
  popup: boolean;
  returnTo: string;
  locale: string | null;
  sessionId: string;
  userId: string;
  /** What the person confirms, and when they started (shown on the callback page) */
  actions: StepUpAction[];
  startedAt: number;
} & ({ ok: true; method: 'sso' | 'sso+mfa'; at: number; provider: string } | { ok: false; code: string; message: string });

/** Handle the redirect back from the identity provider. A sign-in returns a session; a test sign-in only records the claims. */
export async function finishSignIn(currentUrl: URL, meta: { ip?: string; userAgent?: string }): Promise<CallbackResult> {
  const state = currentUrl.searchParams.get('state') ?? '';
  const flow = pending.get(state);
  if (!flow || flow.expires < Date.now()) throw new HttpError(400, 'The sign-in attempt expired or is unknown – please try again');
  pending.delete(state);
  if (flow.test) return finishTest(flow, state, currentUrl);
  if (flow.stepUp) return finishStepUp(flow, state, currentUrl);
  const p = getProvider(flow.providerId);
  const received = await receiveClaims(p, flow, state, currentUrl, p.useUserinfo);
  if (p.useUserinfo && received.userinfoError) throw new HttpError(502, `Could not read the userinfo of ${p.displayName}: ${received.userinfoError}`);
  const user = provisionUser(p, mergedClaims(p, received));
  // a sign-in the provider says was fresh (auth_time) confirms the session for sensitive actions right away
  const fresh = freshAuthentication(p, received.idToken);
  const session = createSession(user.id, user.username, meta, p.displayName, 'refusal' in fresh ? {} : { stepUp: fresh });
  return { kind: 'session', ...session, returnTo: flow.returnTo, username: user.username };
}

// ---------- step-up: a fresh sign-in at the provider confirms a signed-in session (step-up.ts) ----------

/** Clock difference between Steward and the identity provider tolerated for auth_time. */
const CLOCK_SKEW_MS = 60_000;

const claimStrings = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string');

/**
 * Whether the ID token shows a fresh sign-in: auth_time within SM_STEP_UP_MINUTES, and – when the provider requires it
 * for step-up – multi-factor authentication: the Entra authentication context in acrs, one of the acr values asked for
 * in acr, or else "mfa" in amr (RFC 8176).
 */
function freshAuthentication(
  p: SsoProvider,
  idToken: Claims,
  now = Date.now(),
): { at: number; method: 'sso' | 'sso+mfa' } | { refusal: { code: string; message: string } } {
  const t = idToken.auth_time;
  if (typeof t !== 'number' || !Number.isFinite(t)) {
    return {
      refusal: {
        code: 'STEP_UP_NO_AUTH_TIME',
        message: `${p.displayName} did not say when you signed in (claim auth_time) – an administrator has to set the provider up to send it (docs/SSO.md#step-up)`,
      },
    };
  }
  const at = t * 1000;
  if (at > now + CLOCK_SKEW_MS || now - at > appConfig.session.stepUpMs) {
    return {
      refusal: {
        code: 'STEP_UP_STALE',
        message: `${p.displayName} did not ask you to sign in again (your last sign-in there was ${Math.round((now - at) / 60_000)} min ago)`,
      },
    };
  }
  const amrMfa = claimStrings(idToken.amr).includes('mfa');
  const asked = p.type === 'entra' && p.stepUpAuthContext ? 'context' : p.stepUpAcrValues ? 'acr' : 'amr';
  const proven =
    asked === 'context'
      ? claimStrings(idToken.acrs).includes(p.stepUpAuthContext)
      : asked === 'acr'
        ? claimStrings(idToken.acr).some((a) => p.stepUpAcrValues.split(' ').includes(a))
        : amrMfa;
  if (p.stepUpMfa && !proven) {
    return {
      refusal: {
        code: 'STEP_UP_MFA_REQUIRED',
        message:
          asked === 'context'
            ? `${p.displayName} did not confirm the authentication context ${p.stepUpAuthContext} (claim acrs)`
            : asked === 'acr'
              ? `${p.displayName} did not confirm the sign-in level ${p.stepUpAcrValues} (claim acr)`
              : `${p.displayName} did not confirm a multi-factor sign-in (claim amr)`,
      },
    };
  }
  return { at: Math.min(at, now), method: amrMfa || (p.stepUpMfa && proven) ? 'sso+mfa' : 'sso' };
}

/** Starts a step-up of a single sign-on session: a fresh sign-in at the provider the account signs in with. */
export async function startStepUp(
  u: { id: string; sessionId: string },
  redirectUri: string,
  opts: { returnTo?: string; popup: boolean; actions?: StepUpAction[] },
): Promise<{ authorizationUrl: string; expiresAt: string }> {
  const account = getUser(u.id);
  const p = db().get<ProviderRow>('SELECT * FROM identity_providers WHERE id = ?', account.authSource);
  if (!p || !p.enabled) throw new HttpError(409, 'Your sign-in provider is not available any more – sign out and sign in again', 'STEP_UP_SSO_UNAVAILABLE');
  const provider = toProvider(p);
  const config = await clientConfig(provider);
  const url = await authorizationUrl(provider, config, {
    providerId: provider.id,
    redirectUri,
    returnTo: safeReturnTo(opts.returnTo),
    stepUp: { sessionId: u.sessionId, userId: u.id, popup: opts.popup, actions: [...new Set(opts.actions ?? [])], startedAt: Date.now() },
  });
  return { authorizationUrl: url, expiresAt: new Date(Date.now() + STATE_TTL_MS).toISOString() };
}

/**
 * The provider's answer to a step-up: only the signed-in person (the same account by the stable identifier – what a
 * sign-in would link, decide()), freshly signed in. Never signs in, creates or changes an account.
 */
async function finishStepUp(flow: Pending, state: string, currentUrl: URL): Promise<StepUpCallback> {
  const su = flow.stepUp!;
  const row = db().get<{ username: string; locale: string | null }>('SELECT username, locale FROM users WHERE id = ?', su.userId);
  const base = {
    kind: 'stepUp' as const,
    popup: su.popup,
    returnTo: flow.returnTo,
    locale: row?.locale ?? null,
    sessionId: su.sessionId,
    userId: su.userId,
    actions: su.actions,
    startedAt: su.startedAt,
  };
  let name = 'single sign-on';
  const refuse = (code: string, message: string, reason?: string): StepUpCallback => {
    audit({
      actor: row?.username ?? 'system',
      action: 'auth.step_up_failed',
      entityType: 'user',
      entityId: su.userId,
      summary: `Confirmation of ${row?.username ?? su.userId} via ${name} refused: ${message}`,
      details: { method: 'sso', reason: code, provider: flow.providerId, ...(reason ? { refusal: reason } : {}) },
    });
    return { ...base, ok: false, code, message };
  };
  try {
    const p = getProvider(flow.providerId);
    name = p.displayName;
    // turned off since the step-up started: nobody confirms with it any more
    if (!p.enabled) return refuse('STEP_UP_SSO_UNAVAILABLE', `${p.displayName} is turned off`);
    const received = await receiveClaims(p, flow, state, currentUrl, p.useUserinfo);
    if (p.useUserinfo && received.userinfoError) return refuse('STEP_UP_SSO_FAILED', `Could not read the userinfo: ${received.userinfoError}`);
    const claims = mergedClaims(p, received);
    const d = decide(p, claims);
    // the same identity: linked to this account by the stable identifier, or found by its earlier link (re-link)
    const key = identityKeys(p.id, claims, p.stableIdClaims).key;
    const linked = key ? db().get<{ id: string }>('SELECT id FROM users WHERE external_id = ?', key) : undefined;
    if (linked?.id !== su.userId && !(d.preview.outcome === 'relink' && d.account?.id === su.userId)) {
      return refuse('STEP_UP_OTHER_IDENTITY', `You signed in at ${p.displayName} as someone else – sign in as yourself`, d.preview.refusal?.code);
    }
    // what a sign-in would refuse now (a required claim, the role mapping, a disabled account) refuses the step-up too;
    // the reason is for administrators (the audit entry)
    if (d.preview.outcome !== 'signIn' && d.preview.outcome !== 'relink') {
      return refuse('STEP_UP_REFUSED', `Your sign-in at ${p.displayName} was refused – ask an administrator`, d.preview.refusal?.code);
    }
    const fresh = freshAuthentication(p, received.idToken);
    if ('refusal' in fresh) return refuse(fresh.refusal.code, fresh.refusal.message);
    return { ...base, ok: true, method: fresh.method, at: fresh.at, provider: p.displayName };
  } catch (e) {
    return refuse('STEP_UP_SSO_FAILED', (e as Error).message.slice(0, 300));
  }
}

// ---------- from claims to an account ----------

interface AccountRow {
  id: string;
  username: string;
  display_name: string;
  active: number;
  auth_source: string | null;
  external_id: string | null;
  external_sub: string | null;
  roles: string;
}
const ACCOUNT_COLUMNS = 'id, username, display_name, active, auth_source, external_id, external_sub, roles';

/** The provider settings a decision uses, with the provider's id and name. */
type DecisionProvider = ProviderConfig & { id: string };

interface Decision {
  preview: SsoSignInPreview;
  key?: string;
  subKey: string;
  account?: AccountRow;
  mappedRoles: Role[];
  managedTeams: Set<string>;
  wantedTeams: Set<string>;
  /** Roles in each wanted team (lower-case team name → roles), from the matched mappings */
  wantedTeamRoles: Map<string, Role[]>;
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
const MAX_USERNAME = 128;

/**
 * What a sign-in with these claims does – read-only (the test sign-in shows this preview). The first reason to refuse
 * wins, in this order: required claims, user name, e-mail confirmation, stable id, role mapping, account.
 */
function decide(p: DecisionProvider, claims: Claims): Decision {
  const ownName = claimText(claimAt(claims, p.usernameClaim), 256);
  const email = claimText(claimAt(claims, p.emailClaim), 254);
  // without the user name claim the e-mail claim names the account, else the subject
  const usernameFrom =
    ownName !== undefined
      ? { claim: p.usernameClaim, value: ownName }
      : email
        ? { claim: p.emailClaim, value: email }
        : { claim: 'sub', value: String(claims.sub) };
  const transformed = transformUsername(usernameFrom.value, p.usernameTransform, p.stripDomains);
  const username = transformed ?? usernameFrom.value.normalize('NFKC').trim().toLowerCase();
  const notes: SsoSignInPreview['notes'] = [];
  if (ownName === undefined) notes.push({ code: 'USERNAME_FALLBACK', params: { claim: p.usernameClaim, from: usernameFrom.claim } });
  if (username !== usernameFrom.value) notes.push({ code: 'USERNAME_TRANSFORMED', params: { from: usernameFrom.value, to: username } });
  const fromTemplate = p.displayNameTemplate ? renderTemplate(p.displayNameTemplate, claims) : '';
  const displayName = fromTemplate || claimText(claimAt(claims, p.displayNameClaim), 100) || username.slice(0, 100);
  const firstName = claimText(claimAt(claims, p.firstNameClaim), 100);
  const lastName = claimText(claimAt(claims, p.lastNameClaim), 100);
  const verified = emailVerified(claims);
  const emailNames = usernameFrom.claim === p.emailClaim || usernameFrom.claim === 'email';
  const verificationRequired = (emailNames || emailIdentifies(p)) && !p.emailVerifiedByProvider;
  const profile = profileValues(p, claims);

  const groupValues = claimList(claimAt(claims, p.groupsClaim));
  const overage = groupOverage(claims, p.groupsClaim);
  if (overage) notes.push({ code: 'GROUPS_OVERAGE', params: { claim: p.groupsClaim } });
  // names are matched ignoring case, ids exactly
  const norm = (v: string) => (p.groupValues === 'ids' ? v.trim() : v.trim().toLowerCase());
  const values = new Set(groupValues.map(norm));
  const matched = p.mappings.filter((m) => values.has(norm(m.claimValue)));
  const mappedRoles = [...new Set([...p.defaultRoles, ...matched.flatMap((m) => m.roles)])] as Role[];
  const managedTeams = new Set(p.mappings.flatMap((m) => m.teams.map((t) => t.toLowerCase())));
  const wantedTeams = new Set(matched.flatMap((m) => m.teams.map((t) => t.toLowerCase())));
  const wantedTeamRoles = new Map<string, Role[]>();
  for (const m of matched)
    for (const t of m.teams) {
      const key = t.toLowerCase();
      wantedTeamRoles.set(key, [...new Set([...(wantedTeamRoles.get(key) ?? []), ...(m.teamRoles ?? [])])].sort() as Role[]);
    }
  const teamNames = listTeams()
    .filter((t) => wantedTeams.has(t.name.toLowerCase()))
    .map((t) => t.name);

  const keys = identityKeys(p.id, claims, p.stableIdClaims);
  const preview: SsoSignInPreview = {
    outcome: 'create',
    username,
    usernameFrom,
    displayName,
    ...(firstName ? { firstName } : {}),
    ...(lastName ? { lastName } : {}),
    ...(email ? { email } : {}),
    emailVerified: verified,
    emailVerificationRequired: verificationRequired,
    profile,
    stableId: { issuer: keys.issuer, claims: keys.parts },
    groups: { claim: p.groupsClaim, values: groupValues.slice(0, 200), matched: matched.map((m) => m.claimValue), overage, valuesAre: p.groupValues },
    roles: mappedRoles,
    teams: teamNames,
    notes,
  };
  const d: Decision = { preview, key: keys.key, subKey: keys.subKey, mappedRoles, managedTeams, wantedTeams, wantedTeamRoles };
  const refuse = (refusal: { code: string; message: string; params?: ErrorParams }): Decision => {
    preview.outcome = 'refuse';
    preview.refusal = refusal;
    return d;
  };

  if (stableIdProblem(p.stableIdClaims, p.stableIdConfirmedClaims)) {
    return refuse({
      code: 'SSO_STABLE_ID_NOT_UNIQUE',
      message: `The stable identifier of ${p.displayName} (${p.stableIdClaims.join(', ')}) does not name one person – an administrator has to fix it`,
      params: { claims: p.stableIdClaims },
    });
  }
  // The user name only matters when it links an existing account by name or names a new one – an identity that is
  // linked already signs in by its stable identifier, whatever its name at the provider is now (no lockout of accounts
  // with names older versions accepted).
  const usernameRefusal = (): Decision | undefined => {
    if (transformed === null) {
      return refuse({
        code: 'SSO_USERNAME_DOMAIN',
        message: `The user name "${usernameFrom.value}" is not of a domain this provider strips (${p.stripDomains.join(', ')})`,
        params: { claim: usernameFrom.claim, domains: p.stripDomains },
      });
    }
    // the same characters as local user names (plus "+"), after NFKC: no look-alikes that the database's case-insensitive
    // comparison would match with another account, no invisible or bidi characters
    if (!SSO_USERNAME.test(username)) {
      return refuse({
        code: 'SSO_USERNAME_INVALID',
        message: `The user name from claim "${usernameFrom.claim}" is not usable: 2–${MAX_USERNAME} characters, letters, digits and . _ @ + - only`,
        params: { claim: usernameFrom.claim, max: MAX_USERNAME },
      });
    }
    return undefined;
  };
  for (const rule of p.requiredClaims) {
    const v = claimAt(claims, rule.claim);
    const got = (Array.isArray(v) ? claimList(v) : [claimText(v, 500)]).filter((x): x is string => !!x).map((x) => x.toLowerCase());
    if (!rule.values.some((x) => got.includes(x.trim().toLowerCase()))) {
      return refuse({
        code: 'SSO_REQUIRED_CLAIM',
        message: `Your account does not belong to the organisation this sign-in is for (claim "${rule.claim}")`,
        params: {
          claim: rule.claim,
        },
      });
    }
  }
  if (verificationRequired && verified !== true) {
    return refuse({
      code: 'SSO_EMAIL_NOT_VERIFIED',
      message: 'The identity provider did not confirm the e-mail address the account is named or identified by (claim "email_verified")',
      params: { claim: p.emailClaim },
    });
  }
  if (!keys.key) {
    const missing = keys.parts.filter((x) => x.value === null).map((x) => x.name);
    return refuse({
      code: 'SSO_STABLE_ID_MISSING',
      message: `The identity provider did not send usable values for the claims that identify you (${missing.join(', ')}): one string of at most 256 characters or a number each`,
      params: { claims: missing },
    });
  }
  if (p.requireMapping && matched.length === 0) {
    return refuse({
      code: 'SSO_NO_ROLE_MAPPING',
      message: `Your account has no role assigned for ${BRAND.name} (claim "${p.groupsClaim}")${overage ? ' – the token left the groups out (too many groups)' : ''}`,
      params: { claim: p.groupsClaim, ...(overage ? { context: 'overage' } : {}) },
    });
  }

  // ----- which account: the stable id, else the identity's earlier link (re-linked), else the user name -----
  let account = db().get<AccountRow>(`SELECT ${ACCOUNT_COLUMNS} FROM users WHERE external_id = ?`, keys.key);
  if (account) {
    preview.outcome = 'signIn';
  } else {
    // An earlier link of this identity: from before the stable id setting (<provider>:<sub>), or by issuer + sub when the
    // stable id claims changed since. Never an account linked by the stable id claims configured now (that is another
    // identity, whose sub only happens to be recorded), and only accounts of this provider.
    const candidates = db()
      .all<AccountRow>(
        `SELECT ${ACCOUNT_COLUMNS} FROM users WHERE auth_source = ? AND (external_id = ? OR external_id = ? OR external_sub = ?)`,
        p.id,
        keys.legacyKey,
        keys.subKey,
        keys.subKey,
      )
      .filter((r) => {
        const names = r.external_id ? keyClaimNames(r.external_id, p.id) : null;
        if (names === 'legacy') return r.external_id === keys.legacyKey;
        // a hashed link whose issuer the administrator moved: only through the issuer + sub recorded at linking
        if (names === 'moved') return r.external_sub === keys.subKey;
        return names !== null && !sameSet(names, p.stableIdClaims);
      });
    if (candidates.length > 1) {
      return refuse({ code: 'SSO_LINK_AMBIGUOUS', message: `More than one ${BRAND.name} account was linked to this identity before – ask an administrator` });
    }
    if (candidates[0]) {
      account = candidates[0];
      preview.outcome = 'relink';
      preview.relinkFrom = keyClaimNames(account.external_id!, p.id) === 'legacy' ? 'legacy' : 'sub';
    }
  }

  if (!account) {
    const invalid = usernameRefusal();
    if (invalid) return invalid;
    const existing = db().get<AccountRow>(`SELECT ${ACCOUNT_COLUMNS} FROM users WHERE username = ?`, username);
    if (existing) {
      const source = existing.auth_source ?? 'local';
      preview.account = { id: existing.id, username: existing.username, displayName: existing.display_name, authSource: source };
      if (source !== 'local' && source !== p.id)
        return refuse({ code: 'SSO_OTHER_PROVIDER', message: `The user name "${username}" belongs to another sign-in provider`, params: { username } });
      // an account of this provider that is linked already belongs to that identity, not to whoever has the name now
      if (source === p.id && existing.external_id)
        return refuse({
          code: 'SSO_LINKED_TO_OTHER_IDENTITY',
          message: `The account "${username}" is linked to another ${p.displayName} identity`,
          params: { username },
        });
      // a local administrator is never taken over by a name: an administrator binds it to this provider first (Users & teams)
      if (source === 'local' && parseJson<Role[]>(existing.roles, []).includes('admin')) {
        return refuse({
          code: 'SSO_LOCAL_ADMIN',
          message: `"${username}" is a local administrator account – an administrator has to bind it to ${p.displayName} first`,
          params: {
            username,
          },
        });
      }
      if (p.linkExisting === 'never') {
        return refuse({
          code: 'SSO_LINK_NEVER',
          message: `An account "${username}" exists already and ${p.displayName} does not link existing accounts – ask an administrator`,
          params: {
            username,
          },
        });
      }
      if (p.linkExisting === 'bound' && source !== p.id) {
        return refuse({
          code: 'SSO_LINK_BOUND_ONLY',
          message: `An account "${username}" exists already – an administrator has to bind it to ${p.displayName} first (Users & teams → Edit user → Signs in with)`,
          params: { username },
        });
      }
      account = existing;
      preview.outcome = 'link';
    }
  }
  if (account) {
    preview.account = { id: account.id, username: account.username, displayName: account.display_name, authSource: account.auth_source ?? 'local' };
    d.account = account;
    if (!account.active) return refuse({ code: 'SSO_ACCOUNT_DISABLED', message: `Your ${BRAND.name} account is disabled` });
    return d;
  }
  if (!p.autoProvision)
    return refuse({ code: 'SSO_NO_ACCOUNT', message: `No ${BRAND.name} account exists for "${username}" – ask an administrator`, params: { username } });
  // a former name of an imported account (aliases.ts) must not become a new account: it would inherit that account's grants
  if (aliasTarget(username))
    return refuse({
      code: 'SSO_USERNAME_IS_ALIAS',
      message: `"${username}" is the former name of an imported account – ask an administrator`,
      params: { username },
    });
  return d;
}

/** The profile after a sign-in: "always" fields from the claims, "create" fields kept (set when the account was created or linked). */
function nextProfile(p: DecisionProvider, current: string | null, values: SsoSignInPreview['profile'], fresh: boolean): SsoSignInPreview['profile'] {
  const stored = new Map(parseJson<{ key: string; label: string; value: string }[]>(current, []).map((x) => [x.key, x]));
  const now = new Map(values.map((x) => [x.key, x]));
  const out: SsoSignInPreview['profile'] = [];
  for (const f of p.profileFields) {
    const v = fresh || f.sync === 'always' ? now.get(f.key) : stored.get(f.key);
    if (v) out.push({ key: f.key, label: f.label, value: v.value });
  }
  return out;
}

function provisionUser(p: SsoProvider, claims: Claims): UserInfo {
  const d = decide(p, claims);
  const v = d.preview;
  const actor = v.username.slice(0, MAX_USERNAME);
  if (v.groups.overage) {
    // the token left the groups out: the person gets no mapped roles from them (fail safe) – the administrator needs to know
    logger.warn({ provider: p.id, username: actor, claim: p.groupsClaim }, 'single sign-on: the token left the groups out (group overage)');
    audit({
      actor,
      action: 'sso.groups_overage',
      entityType: 'sso',
      entityId: p.id,
      summary: `Single sign-on of "${actor}" via ${p.displayName}: the token left the groups out (too many groups) – no mapped roles from claim "${p.groupsClaim}"`,
      details: { claim: p.groupsClaim },
    });
  }
  if (v.outcome === 'refuse') {
    // the person gets a reference, not the reason: the reason would tell whether an account exists, is an administrator,
    // is linked … – administrators find it in the audit log by the reference (and in the test sign-in)
    const ref = crypto.randomBytes(4).toString('hex');
    audit({
      actor,
      action: 'auth.login_failed',
      entityType: 'sso',
      entityId: p.id,
      summary: `Single sign-on of "${actor}" via ${p.displayName} denied (reference ${ref}): ${v.refusal!.message}`,
      details: { code: v.refusal!.code, reference: ref },
    });
    throw new HttpError(403, `Your sign-in was refused – ask an administrator (reference ${ref})`, 'SSO_SIGN_IN_REFUSED', { reference: ref });
  }

  let userId = d.account?.id ?? '';
  const created = v.outcome === 'create';
  const fresh = created || v.outcome === 'link';
  db().tx(() => {
    const ts = nowIso();
    if (v.outcome === 'relink') {
      db().run('UPDATE users SET external_id = ?, external_sub = ?, updated_at = ? WHERE id = ?', d.key, d.subKey, ts, userId);
      audit({
        actor,
        action: 'user.sso_relinked',
        entityType: 'user',
        entityId: userId,
        summary: `Account "${d.account!.username}" re-linked to ${p.displayName} by its stable identifier (${p.stableIdClaims.join(' + ')}), found by its earlier link (${v.relinkFrom === 'legacy' ? 'provider + sub' : 'issuer + sub'})`,

        details: { from: v.relinkFrom, stableIdClaims: p.stableIdClaims },
      });
    } else if (v.outcome === 'link') {
      // pre-created (or local) account with the same user name → link it
      db().run(
        'UPDATE users SET external_id = ?, external_sub = ?, auth_source = ?, password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?',
        d.key,
        d.subKey,
        p.id,
        '!sso',
        ts,
        userId,
      );
      // like binding it: the account's sessions (password sessions of a local account) end; the new one comes after this
      db().run('DELETE FROM sessions WHERE user_id = ?', userId);
      audit({
        action: 'user.linked_sso',
        entityType: 'user',
        entityId: userId,
        actor,
        summary: `Account "${v.username}" linked to ${p.displayName}`,
        details: { linkExisting: p.linkExisting, bound: d.account!.auth_source === p.id },
      });
    } else if (created) {
      userId = newId('usr_');
      db().run(
        `INSERT INTO users (id, username, display_name, email, password_hash, roles, active, must_change_password, created_at, updated_at, auth_source, external_id, external_sub)
         VALUES (?, ?, ?, ?, '!sso', '[]', 1, 0, ?, ?, ?, ?, ?)`,
        userId,
        v.username,
        v.displayName,
        v.email ?? null,
        ts,
        ts,
        p.id,
        d.key,
        d.subKey,
      );
      audit({
        actor,
        action: 'user.created',
        entityType: 'user',
        entityId: userId,
        summary: `User "${v.username}" created on first sign-in via ${p.displayName}`,
        details: { claimValues: v.groups.matched },
      });
    }
    // issuer + sub is recorded when an identity is linked (created, linked, re-linked) – never on a plain sign-in, so a
    // later sign-in cannot move an account's earlier link to whoever signed in last; it belongs to this identity only
    if (v.outcome !== 'signIn') db().run('UPDATE users SET external_sub = NULL WHERE external_sub = ? AND id <> ?', d.subKey, userId);

    const current = db().get<{ profile: string | null }>('SELECT profile FROM users WHERE id = ?', userId);
    const set = (field: keyof ProviderConfig['sync']) => fresh || p.sync[field] === 'always';
    db().run(
      `UPDATE users SET display_name = CASE WHEN ? = 1 THEN ? ELSE display_name END,
         first_name = CASE WHEN ? = 1 THEN ? ELSE first_name END,
         last_name = CASE WHEN ? = 1 THEN ? ELSE last_name END,
         email = CASE WHEN ? = 1 THEN ? ELSE email END,
         profile = ?
       WHERE id = ?`,
      set('displayName') ? 1 : 0,
      v.displayName,
      set('firstName') && v.firstName ? 1 : 0,
      v.firstName ?? null,
      set('lastName') && v.lastName ? 1 : 0,
      v.lastName ?? null,
      set('email') && v.email ? 1 : 0,
      v.email ?? null,
      JSON.stringify(nextProfile(p, current?.profile ?? null, v.profile, fresh)),
      userId,
    );
    if (created || p.syncRoles) {
      const user = getUser(userId);
      syncRolesAndTeams(p, user.id, user.username, user.roles, d.mappedRoles, d.managedTeams, d.wantedTeams, d.wantedTeamRoles);
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
  wantedTeamRoles: Map<string, Role[]>,
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
    // roles in the team: as the mappings say (#131); none stored when they give none
    const roles = wantedTeamRoles.get(key) ?? [];
    const stored = roles.length ? JSON.stringify(roles) : null;
    if (wantedTeams.has(key) && !member) {
      db().run('INSERT INTO team_members (team_id, user_id, roles) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', t.id, userId, stored);
      teamChanges.push(`+${t.name}${roles.length ? ` (${roles.join(',')})` : ''}`);
    } else if (wantedTeams.has(key) && member) {
      const was = db().get<{ roles: string | null }>('SELECT roles FROM team_members WHERE team_id = ? AND user_id = ?', t.id, userId)?.roles ?? null;
      const before = (was ? parseJson<string[]>(was, []) : []).sort().join(',');
      if (before !== roles.join(',')) {
        db().run('UPDATE team_members SET roles = ? WHERE team_id = ? AND user_id = ?', stored, t.id, userId);
        teamChanges.push(`${t.name} roles ${before || '–'} → ${roles.join(',') || '–'}`);
      }
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

// ---------- test sign-in (administrators): the claims and what a sign-in would do, without signing in ----------

interface TestEntry {
  testId: string;
  providerId: string;
  adminId: string;
  adminName: string;
  startedAt: string;
  expires: number;
  status: SsoTestResult['status'];
  error?: string;
  finishedAt?: string;
  received?: ReceivedClaims;
}
const tests = new Map<string, TestEntry>();
const TEST_TTL_MS = 15 * 60 * 1000;
const MAX_TESTS = 100;
/** Larger claim sets are not kept (memory): the test reports it. */
const MAX_TEST_CLAIMS_BYTES = 256 * 1024;

/**
 * Starts a test sign-in through a provider (also a disabled one): the administrator opens the returned URL in a new
 * window and signs in there. The callback records the claims for this administrator only – no session, no account
 * created, linked or changed.
 */
export async function startTestSignIn(providerId: string, admin: { id: string; username: string }, redirectUri: string): Promise<SsoTestStart> {
  const p = getProvider(providerId);
  const config = await clientConfig(p);
  const now = Date.now();
  for (const [k, v] of tests) if (v.expires < now) tests.delete(k);
  while (tests.size >= MAX_TESTS) tests.delete(tests.keys().next().value!);
  const testId = crypto.randomBytes(16).toString('base64url');
  const expires = now + TEST_TTL_MS;
  tests.set(testId, { testId, providerId, adminId: admin.id, adminName: admin.username, startedAt: nowIso(), expires, status: 'pending' });
  const url = await authorizationUrl(p, config, { providerId, redirectUri, returnTo: '/', test: { testId } });
  return { testId, authorizationUrl: url, expiresAt: new Date(expires).toISOString() };
}

const OUTCOME_TEXT: Record<SsoSignInPreview['outcome'], string> = {
  signIn: 'sign in to the linked account',
  relink: 're-link the account by its stable identifier',
  link: 'link an existing account',
  create: 'create a new account',
  refuse: 'be refused',
};

async function finishTest(flow: Pending, state: string, currentUrl: URL): Promise<CallbackResult> {
  const entry = tests.get(flow.test!.testId);
  if (!entry || entry.expires < Date.now()) throw new HttpError(400, 'The test sign-in expired – start it again');
  const locale = db().get<{ locale: string | null }>('SELECT locale FROM users WHERE id = ?', entry.adminId)?.locale ?? null;
  const p = getProvider(flow.providerId);
  try {
    const received = await receiveClaims(p, flow, state, currentUrl, true);
    if (JSON.stringify(received).length > MAX_TEST_CLAIMS_BYTES) throw new HttpError(413, 'The identity provider sent more than 256 KB of claims');
    entry.received = received;
    entry.status = 'done';
    const d = decide(p, mergedClaims(p, received));
    audit({
      actor: entry.adminName,
      action: 'sso.test_sign_in',
      entityType: 'sso',
      entityId: p.id,
      summary: `Test sign-in via ${p.displayName} as "${d.preview.username.slice(0, MAX_USERNAME)}": a sign-in would ${OUTCOME_TEXT[d.preview.outcome]} (no account or session was changed)`,
      details: { outcome: d.preview.outcome, ...(d.preview.refusal ? { refusal: d.preview.refusal.code } : {}), groupsOverage: d.preview.groups.overage },
    });
  } catch (e) {
    entry.status = 'failed';
    entry.error = (e as Error).message.slice(0, 500);
    audit({
      actor: entry.adminName,
      action: 'sso.test_sign_in',
      entityType: 'sso',
      entityId: p.id,
      summary: `Test sign-in via ${p.displayName} failed: ${entry.error}`,
      details: { outcome: 'failed' },
    });
  }
  entry.finishedAt = nowIso();
  return { kind: 'test', ok: entry.status === 'done', locale };
}

/**
 * The result of a test sign-in, for the administrator who started it. `draft`: the editor's unsaved settings (the
 * connection – issuer, client, secret – stays the saved one); the preview is computed with them.
 */
export function testResult(testId: string, adminId: string, draft?: unknown): SsoTestResult {
  const entry = tests.get(testId);
  if (!entry || entry.adminId !== adminId || entry.expires < Date.now()) throw new HttpError(404, 'Test sign-in not found or expired', 'SSO_TEST_NOT_FOUND');
  const saved = getProvider(entry.providerId);
  const out: SsoTestResult = { testId, providerId: entry.providerId, status: entry.status, startedAt: entry.startedAt };
  if (entry.finishedAt) out.finishedAt = entry.finishedAt;
  if (entry.error) out.error = entry.error;
  if (entry.received) {
    const r = entry.received;
    let c: DecisionProvider = saved;
    if (draft !== undefined && draft !== null) {
      const fromDraft = configFrom(providerSchema.parse(draft), saved);
      c = { ...fromDraft, id: saved.id, issuer: saved.issuer, clientId: saved.clientId, displayName: saved.displayName };
    }
    out.idToken = shownClaims(r.idToken);
    if (r.userinfo) out.userinfo = shownClaims(r.userinfo);
    if (r.userinfoError) out.userinfoError = r.userinfoError;
    out.preview = decide(c, mergedClaims(c, r)).preview;
    if (c.useUserinfo && r.userinfo) out.preview.notes.push({ code: 'USERINFO_USED' });
  }
  return out;
}

/** Redirect URI to register at the identity provider. */
export function redirectUriFor(req: { protocol: string; host: string }): string {
  // SM_PUBLIC_URL includes the base path; without it the request's address (X-Forwarded-Proto/-Host only from SM_TRUST_PROXY)
  const base = appConfig.publicUrl ?? `${req.protocol}://${req.host}${appConfig.basePath}`;
  return `${base}/api/auth/oidc/callback`;
}
