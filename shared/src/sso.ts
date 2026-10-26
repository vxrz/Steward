import type { ErrorParams } from './errors.js';
import type { Role, SsoProvider, SsoProviderInput } from './api.js';

/**
 * Single sign-on (OpenID Connect): how claims become an account. Vendor-neutral – the presets only pre-fill the
 * settings for a few well-known identity providers; every value stays editable. See docs/SSO.md.
 */

export const SSO_PRESETS = ['entra', 'keycloak', 'okta', 'google', 'authentik', 'generic'] as const;
export type SsoPreset = (typeof SSO_PRESETS)[number];

/** Which existing accounts the first sign-in of an identity may link. */
export const SSO_LINK_POLICIES = ['byName', 'bound', 'never'] as const;
export type SsoLinkPolicy = (typeof SSO_LINK_POLICIES)[number];

/** How the user name claim becomes a user name: lower case (default), lower case without "@domain", unchanged. */
export const SSO_USERNAME_TRANSFORMS = ['lowercase', 'stripDomain', 'none'] as const;
export type SsoUsernameTransform = (typeof SSO_USERNAME_TRANSFORMS)[number];

/** 'always': updated at every sign-in, not editable in Steward; 'create': set when the account is created or linked. */
export const SSO_SYNC_RULES = ['always', 'create'] as const;
export type SsoSyncRule = (typeof SSO_SYNC_RULES)[number];

export const SSO_SYNCED_FIELDS = ['displayName', 'firstName', 'lastName', 'email'] as const;
export type SsoSyncedField = (typeof SSO_SYNCED_FIELDS)[number];
export type SsoSyncRules = Record<SsoSyncedField, SsoSyncRule>;

export const SSO_GROUP_VALUES = ['names', 'ids'] as const;
export type SsoGroupValues = (typeof SSO_GROUP_VALUES)[number];

/** Limits of the claim settings (also checked by the server). */
export const SSO_LIMITS = {
  stableIdClaims: 3,
  stripDomains: 20,
  profileFields: 20,
  profileValueLength: 500,
  requiredClaims: 10,
  requiredClaimValues: 50,
  claimName: 200,
  template: 200,
} as const;

/** Key of a profile field: letters, digits and _ (e.g. department, jobTitle). */
export const SSO_PROFILE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

export interface SsoProfileField {
  key: string;
  label: string;
  /** Claim name; nested claims with dots, e.g. address.locality */
  claim: string;
  sync: SsoSyncRule;
}

export interface SsoRequiredClaim {
  claim: string;
  /** Accepted values (compared ignoring case; for a list claim one of its values must match) */
  values: string[];
}

export const DEFAULT_SSO_SYNC: SsoSyncRules = { displayName: 'always', firstName: 'always', lastName: 'always', email: 'always' };

/** Settings of a provider that decide how claims become an account (what the test sign-in preview takes as a draft). */
export type SsoClaimSettings = Pick<
  SsoProvider,
  | 'type'
  | 'issuer'
  | 'usernameClaim'
  | 'displayNameClaim'
  | 'emailClaim'
  | 'groupsClaim'
  | 'mappings'
  | 'defaultRoles'
  | 'autoProvision'
  | 'syncRoles'
  | 'requireMapping'
  | 'preset'
  | 'stableIdClaims'
  | 'usernameTransform'
  | 'stripDomains'
  | 'stableIdConfirmedClaims'
  | 'emailVerificationNotice'
  | 'displayNameTemplate'
  | 'firstNameClaim'
  | 'lastNameClaim'
  | 'profileFields'
  | 'sync'
  | 'groupValues'
  | 'linkExisting'
  | 'emailVerifiedByProvider'
  | 'useUserinfo'
  | 'requiredClaims'
>;

// ---------- presets ----------

export interface SsoPresetInfo {
  id: SsoPreset;
  /** 'entra' adds prompt=select_account; every preset uses standard OpenID Connect */
  type: 'entra' | 'oidc';
  /** Product name (the same in every language) */
  label: string;
  /** Issuer URL with placeholders in braces, shown as the field's placeholder */
  issuerPattern: string;
  /** Section in docs/SSO.md with the steps at the identity provider */
  docsAnchor: string;
  /** Pre-filled settings (always editable) */
  defaults: Omit<SsoProviderInput, 'type' | 'displayName' | 'issuer' | 'clientId' | 'enabled' | 'mappings' | 'defaultRoles'>;
}

const base = {
  scopes: 'openid profile email',
  usernameClaim: 'preferred_username',
  displayNameClaim: 'name',
  emailClaim: 'email',
  firstNameClaim: 'given_name',
  lastNameClaim: 'family_name',
  displayNameTemplate: '',
  usernameTransform: 'lowercase' as const,
  stripDomains: [] as string[],
  stableIdClaims: ['sub'],
  stableIdConfirmedClaims: [] as string[],
  emailVerificationNotice: false,
  profileFields: [] as SsoProfileField[],
  sync: { ...DEFAULT_SSO_SYNC },
  groupValues: 'names' as const,
  linkExisting: 'bound' as const,
  emailVerifiedByProvider: false,
  useUserinfo: false,
  requiredClaims: [] as SsoRequiredClaim[],
  autoProvision: true,
  stepUpMfa: false,
  stepUpAcrValues: '',
  stepUpAuthContext: '',
};

export const SSO_PRESET_INFO: Record<SsoPreset, SsoPresetInfo> = {
  entra: {
    id: 'entra',
    type: 'entra',
    label: 'Microsoft Entra ID',
    issuerPattern: 'https://login.microsoftonline.com/{tenant-id}/v2.0',
    docsAnchor: 'microsoft-entra-id',
    defaults: {
      ...base,
      preset: 'entra',
      clientAuth: 'client_secret_post',
      groupsClaim: 'roles',
      // the object id in the tenant: the same for every app registration (sub is per app)
      stableIdClaims: ['tid', 'oid'],
      syncRoles: true,
      requireMapping: true,
    },
  },
  keycloak: {
    id: 'keycloak',
    type: 'oidc',
    label: 'Keycloak',
    issuerPattern: 'https://{host}/realms/{realm}',
    docsAnchor: 'keycloak',
    defaults: { ...base, preset: 'keycloak', clientAuth: 'client_secret_basic', groupsClaim: 'groups', syncRoles: true, requireMapping: false },
  },
  okta: {
    id: 'okta',
    type: 'oidc',
    label: 'Okta',
    issuerPattern: 'https://{your-org}.okta.com/oauth2/default',
    docsAnchor: 'okta',
    defaults: {
      ...base,
      preset: 'okta',
      scopes: 'openid profile email groups',
      clientAuth: 'client_secret_basic',
      groupsClaim: 'groups',
      syncRoles: true,
      requireMapping: false,
    },
  },
  google: {
    id: 'google',
    type: 'oidc',
    label: 'Google Workspace',
    issuerPattern: 'https://accounts.google.com',
    docsAnchor: 'google-workspace',
    defaults: {
      ...base,
      preset: 'google',
      clientAuth: 'client_secret_post',
      // Google sends no preferred_username and no groups; the address is verified (email_verified)
      usernameClaim: 'email',
      groupsClaim: '',
      // only accounts of your Workspace domain (hd); enter the domain before saving
      requiredClaims: [{ claim: 'hd', values: [] }],
      syncRoles: false,
      requireMapping: false,
    },
  },
  authentik: {
    id: 'authentik',
    type: 'oidc',
    label: 'Authentik',
    issuerPattern: 'https://{host}/application/o/{application-slug}/',
    docsAnchor: 'authentik',
    defaults: { ...base, preset: 'authentik', clientAuth: 'client_secret_basic', groupsClaim: 'groups', syncRoles: true, requireMapping: false },
  },
  generic: {
    id: 'generic',
    type: 'oidc',
    label: 'OpenID Connect',
    issuerPattern: 'https://idp.example.com/realms/company',
    docsAnchor: 'generic-openid-connect',
    defaults: { ...base, preset: 'generic', clientAuth: 'client_secret_basic', groupsClaim: 'groups', syncRoles: false, requireMapping: false },
  },
};

// ---------- the stable identifier must name one person ----------

/** Claims that name one person (per issuer). */
export const SSO_SUBJECT_CLAIMS = ['sub', 'oid'] as const;

/**
 * Claims many people share (tenant, audience, groups, authentication details, names …): never an identifier on their
 * own – only together with a subject claim.
 */
export const SSO_NON_UNIQUE_CLAIMS = new Set([
  'tid',
  'iss',
  'aud',
  'azp',
  'appid',
  'appidacr',
  'idp',
  'amr',
  'acr',
  'ver',
  'hd',
  'groups',
  'roles',
  'wids',
  'scp',
  'scope',
  'email_verified',
  'phone_number_verified',
  'nonce',
  'auth_time',
  'iat',
  'exp',
  'nbf',
  'at_hash',
  'c_hash',
  'sid',
  'jti',
  'ipaddr',
  'ctry',
  'tenant_ctry',
  'tenant_region_scope',
  'xms_tpl',
  'realm_access',
  'resource_access',
  'name',
  'given_name',
  'family_name',
  'middle_name',
  'nickname',
  'locale',
  'zoneinfo',
  'gender',
  'birthdate',
  'picture',
  'website',
  'profile',
  'updated_at',
  'department',
  'jobTitle',
  'company',
  'country',
]);

/** A domain to strip from user names (lower case, e.g. contoso.com). */
export const SSO_DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

const NON_UNIQUE_LOWER = new Set([...SSO_NON_UNIQUE_CLAIMS].map((c) => c.toLowerCase()));

/** A claim many people share: its name, or the first or last segment of a nested path (realm_access.roles), ignoring case. */
export function isSharedClaim(claim: string): boolean {
  const parts = claim.toLowerCase().split('.');
  return NON_UNIQUE_LOWER.has(claim.toLowerCase()) || NON_UNIQUE_LOWER.has(parts[0]!) || NON_UNIQUE_LOWER.has(parts[parts.length - 1]!);
}

const sameClaims = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x)) && b.every((x) => a.includes(x));

/**
 * Why these stable id claims cannot identify one person, or null. They must include a subject claim (sub, oid) – or
 * the administrator confirmed exactly these claims as unique per person (`confirmed`; a confirmation of other claims
 * does not carry over) and at least one of them is not a claim many people share.
 */
export function stableIdProblem(claims: readonly string[], confirmed: readonly string[]): 'NONE' | 'NOT_UNIQUE' | null {
  if (!claims.length) return 'NONE';
  if (claims.some((c) => (SSO_SUBJECT_CLAIMS as readonly string[]).includes(c))) return null;
  const custom = claims.filter((c) => !isSharedClaim(c));
  return custom.length && sameClaims(claims, confirmed) ? null : 'NOT_UNIQUE';
}

// ---------- warnings about a configuration ----------

export type SsoConfigWarningCode =
  | 'LINK_BY_NAME'
  | 'MULTI_TENANT_ISSUER'
  | 'TENANT_INFLUENCED_CLAIM'
  | 'USER_INFLUENCED_CLAIM'
  | 'MUTABLE_STABLE_ID'
  | 'STRIP_DOMAIN'
  | 'NO_DOMAIN_RESTRICTION'
  | 'EMAIL_TRUSTED'
  | 'USERNAME_COLLISIONS'
  | 'EMAIL_VERIFIED_NOW_REQUIRED';

export interface SsoConfigWarning {
  code: SsoConfigWarningCode;
  params?: ErrorParams;
}

/** Claims a person (or another tenant's administrator) can set or change: never a stable identifier. */
const MUTABLE_CLAIMS = new Set(['email', 'upn', 'unique_name', 'preferred_username', 'name', 'nickname', 'given_name', 'family_name']);
/** Claims the person can change themselves at many providers. */
const SELF_SERVICE_CLAIMS = new Set(['name', 'nickname', 'given_name', 'family_name']);
/** Claims that name accounts and that another tenant controls when any tenant may sign in. */
const TENANT_CLAIMS = new Set(['email', 'upn', 'unique_name', 'preferred_username']);

/** An issuer any organisation's accounts can use (Entra ID common/organizations/consumers, or a {tenantid} template). */
export function isMultiTenantIssuer(issuer: string): boolean {
  return /^https:\/\/login\.microsoftonline\.com\/(common|organizations|consumers|\{tenantid\})(\/|$)/i.test(issuer.trim());
}

const isEmailClaim = (claim: string, c: Pick<SsoProvider, 'emailClaim'>) => !!claim && (claim === c.emailClaim || claim === 'email');

/** Whether the e-mail claim names or identifies accounts (then sign-in needs email_verified, or the provider is trusted to verify). */
export function emailIdentifies(c: Pick<SsoProvider, 'usernameClaim' | 'emailClaim' | 'stableIdClaims'>): boolean {
  return isEmailClaim(c.usernameClaim, c) || c.stableIdClaims.some((x) => isEmailClaim(x, c));
}

/** Warnings about a provider's settings that can be checked without the database (the editor shows them while typing). */
export function ssoConfigWarnings(c: Omit<SsoClaimSettings, 'mappings' | 'defaultRoles'>): SsoConfigWarning[] {
  const out: SsoConfigWarning[] = [];
  const multiTenant = isMultiTenantIssuer(c.issuer);
  const restricted = (claim: string) => c.requiredClaims.some((r) => r.claim === claim && r.values.length > 0);
  if (c.linkExisting === 'byName') out.push({ code: 'LINK_BY_NAME' });
  if (multiTenant && !restricted('tid')) out.push({ code: 'MULTI_TENANT_ISSUER' });
  const naming = [c.usernameClaim, ...c.stableIdClaims].filter(Boolean);
  for (const claim of new Set(naming)) {
    if (multiTenant && TENANT_CLAIMS.has(claim)) out.push({ code: 'TENANT_INFLUENCED_CLAIM', params: { claim } });
    else if (SELF_SERVICE_CLAIMS.has(claim)) out.push({ code: 'USER_INFLUENCED_CLAIM', params: { claim } });
  }
  const mutable = c.stableIdClaims.filter((x) => MUTABLE_CLAIMS.has(x));
  if (mutable.length) out.push({ code: 'MUTABLE_STABLE_ID', params: { claims: mutable } });
  if (c.usernameTransform === 'stripDomain') out.push({ code: 'STRIP_DOMAIN' });
  if ((c.preset === 'google' || /^https:\/\/accounts\.google\.com\/?$/i.test(c.issuer.trim())) && !restricted('hd'))
    out.push({ code: 'NO_DOMAIN_RESTRICTION' });
  if (c.emailVerifiedByProvider && emailIdentifies(c)) out.push({ code: 'EMAIL_TRUSTED' });
  return out;
}

// ---------- test sign-in ----------

export interface SsoTestStart {
  testId: string;
  /** Open this in a new window: the provider's sign-in page */
  authorizationUrl: string;
  expiresAt: string;
}

/** One received claim: the name and its value as JSON text (bounded; never a token). */
export interface SsoClaimEntry {
  name: string;
  value: string;
  truncated?: boolean;
}

export type SsoPreviewOutcome = 'signIn' | 'relink' | 'link' | 'create' | 'refuse';

/** What a sign-in with these claims would do – computed without changing anything. */
export interface SsoSignInPreview {
  outcome: SsoPreviewOutcome;
  /** Why it would be refused: a code the web app translates (errors:codes.<code>) and the English message */
  refusal?: { code: string; message: string; params?: ErrorParams };
  /** The existing account it signs in to, re-links or links */
  account?: { id: string; username: string; displayName: string; authSource: string };
  /** relink: the account was found by its earlier link (legacy provider id + sub, or issuer + sub) */
  relinkFrom?: 'legacy' | 'sub';
  username: string;
  /** Claim the user name came from (or "sub") and its value before the transformation */
  usernameFrom: { claim: string; value: string };
  displayName: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  /** email_verified as received (null: not sent) */
  emailVerified: boolean | null;
  /** Whether this configuration needs a confirmed e-mail address */
  emailVerificationRequired: boolean;
  profile: { key: string; label: string; value: string }[];
  stableId: { issuer: string; claims: { name: string; value: string | null }[] };
  groups: { claim: string; values: string[]; matched: string[]; overage: boolean; valuesAre: SsoGroupValues };
  roles: Role[];
  teams: string[];
  /** Things to know (code + params, translated by the web app: users:provider.test.notes.<code>) */
  notes: { code: string; params?: ErrorParams }[];
}

export interface SsoTestResult {
  testId: string;
  providerId: string;
  status: 'pending' | 'done' | 'failed';
  error?: string;
  startedAt: string;
  finishedAt?: string;
  idToken?: SsoClaimEntry[];
  userinfo?: SsoClaimEntry[];
  userinfoError?: string;
  preview?: SsoSignInPreview;
}
