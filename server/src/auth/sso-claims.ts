import { DEFAULT_SSO_SYNC, SSO_LIMITS, type SsoClaimEntry, type SsoClaimSettings, type SsoProvider, type SsoUsernameTransform } from '@sm/shared';
import { sha256 } from '../util.js';

/**
 * Pure helpers that turn the claims of an identity provider into account fields (no database access). The decisions
 * that need the database (which account, link or refuse) are in sso.ts.
 */

type Claims = Record<string, unknown>;

/** Deepest nesting of a claim path (address.locality: 2). */
const MAX_PATH_DEPTH = 5;

/**
 * The value of a claim. A name that exists as it is wins (Entra ID and others use URLs and dots in claim names); else
 * dots walk into nested objects (address.locality). Only own properties: "__proto__" or "constructor" never resolve.
 */
export function claimAt(claims: Claims, path: string): unknown {
  if (!path) return undefined;
  if (Object.hasOwn(claims, path)) return claims[path];
  const parts = path.split('.');
  if (parts.length > MAX_PATH_DEPTH || parts.some((p) => !p)) return undefined;
  let cur: unknown = claims;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !Object.hasOwn(cur, part)) return undefined;
    cur = (cur as Claims)[part];
  }
  return cur;
}

// eslint-disable-next-line no-control-regex -- control characters are what this removes
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** A claim value as text: strings, numbers, booleans, lists of them (joined with ", "). Control characters become spaces; bounded. */
export function claimText(v: unknown, max: number): string | undefined {
  let s: string;
  if (typeof v === 'string') s = v;
  else if (typeof v === 'number' || typeof v === 'boolean') s = String(v);
  else if (Array.isArray(v))
    s = v
      .filter((x) => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean')
      .slice(0, 100)
      .map(String)
      .join(', ');
  else return undefined;
  s = s.replace(CONTROL, ' ').trim();
  if (!s) return undefined;
  return s.length > max ? s.slice(0, max) : s;
}

/** Values of a list claim (groups, roles): a JSON list, or a string separated by spaces or commas. Bounded. */
export function claimList(v: unknown): string[] {
  const list = Array.isArray(v) ? v.filter((x) => typeof x === 'string' || typeof x === 'number').map(String) : typeof v === 'string' ? v.split(/[\s,]+/) : [];
  return list
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 2000)
    .map((x) => x.slice(0, 500));
}

/**
 * The user name from the user name claim's value: NFKC-normalised first (a Kelvin sign or full-width letters become
 * the ASCII letters they stand for, before anything compares them). With "stripDomain" only the listed domains are
 * removed – a name of any other domain gives null (refused): otherwise boss@evil.example would claim the account "boss".
 */
export function transformUsername(raw: string, how: SsoUsernameTransform, stripDomains: readonly string[] = []): string | null {
  const s = raw.normalize('NFKC').trim();
  if (how === 'none') return s;
  if (how === 'stripDomain') {
    const at = s.lastIndexOf('@');
    if (at < 0) return s.toLowerCase();
    const domain = s.slice(at + 1).toLowerCase();
    if (at === 0 || !stripDomains.some((d) => d.toLowerCase() === domain)) return null;
    return s.slice(0, at).toLowerCase();
  }
  return s.toLowerCase();
}

/**
 * User names single sign-on may give: ASCII letters, digits and . _ @ + - (e-mail-shaped names such as
 * max@contoso.example), 2–128 characters – after NFKC, so no look-alike, invisible or bidi characters.
 */
export const SSO_USERNAME = /^[A-Za-z0-9._@+-]{2,128}$/;

/** "{given_name} {family_name}" → "Max Admin" (missing claims are left out; spaces collapsed). */
export function renderTemplate(template: string, claims: Claims, max = 100): string {
  const s = template
    .replace(/\{([^{}]{1,200})\}/g, (_, path: string) => claimText(claimAt(claims, path.trim()), max) ?? '')
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.slice(0, max);
}

/**
 * The token says it left out the configured groups claim (too many groups): Entra ID's "_claim_names" /
 * "_claim_sources" naming that claim, or "hasgroups" for the groups claim. Then the claim is missing or incomplete.
 */
export function groupOverage(claims: Claims, groupsClaim: string): boolean {
  if (!groupsClaim) return false;
  const names = claims._claim_names;
  // only the configured claim: Entra's group overage says nothing about app roles in "roles"
  if (names && typeof names === 'object' && !Array.isArray(names) && Object.hasOwn(names, groupsClaim)) return true;
  return groupsClaim === 'groups' && (claims.hasgroups === true || claims.hasgroups === 'true');
}

export const emailVerified = (claims: Claims): boolean | null =>
  claims.email_verified === undefined || claims.email_verified === null ? null : claims.email_verified === true || claims.email_verified === 'true';

// ---------- the stable identifier (users.external_id) ----------

const enc = (s: string) => encodeURIComponent(s);
/** Longest stored link before it is hashed (an index entry stays small on PostgreSQL). */
const MAX_KEY = 1000;
const ID_VALUE_MAX = 256;

/**
 * Links of an identity to an account:
 * - `key`: the provider id, the issuer and the configured stable id claims (`<provider>#iss=…#sub=…` or `…#tid=…#oid=…`);
 * - `subKey`: issuer + sub – recorded for every linked account (users.external_sub), so a change of the stable id
 *   claims is bridged at the next sign-in;
 * - `legacyKey`: `<provider>:<sub>`, the link of versions before the stable id setting.
 * Values are URI-encoded, so no value can produce another key; the "#" after the provider id never occurs in a legacy key.
 */
export function identityKeys(
  providerId: string,
  claims: Claims,
  stableIdClaims: string[],
): { key?: string; subKey: string; legacyKey: string; issuer: string; parts: { name: string; value: string | null }[] } {
  // without trailing slashes: the stored issuer has none, Authentik's tokens name one
  const issuer = String(claims.iss ?? '').replace(/\/+$/, '');
  const sub = String(claims.sub ?? '');
  const parts = stableIdClaims.map((name) => ({ name, value: identityValue(claimAt(claims, name)) }));
  const build = (pairs: { name: string; value: string }[]) => {
    const k = `${providerId}#iss=${enc(issuer)}${pairs.map((p) => `#${enc(p.name)}=${enc(p.value)}`).join('')}`;
    // a long one is hashed, with the claim names kept readable (keyClaimNames)
    return k.length > MAX_KEY ? `${providerId}#h#${enc(pairs.map((p) => p.name).join(','))}#${sha256(k)}` : k;
  };
  const complete = parts.every((p) => p.value !== null);
  return {
    key: complete ? build(parts as { name: string; value: string }[]) : undefined,
    subKey: build([{ name: 'sub', value: sub }]),
    legacyKey: `${providerId}:${sub}`,
    issuer,
    parts,
  };
}

/**
 * A claim value as part of the stable identifier: exactly as sent – a non-empty string of at most 256 characters or a
 * finite number. Nothing is trimmed, cut, joined or replaced (that would make different values the same); anything
 * else (lists, objects, booleans, empty or oversized strings) is no identifier.
 */
export function identityValue(v: unknown): string | null {
  if (typeof v === 'string') return v.length > 0 && v.length <= ID_VALUE_MAX ? v : null;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** The issuer a stored link names (null: a legacy or hashed link). */
export function keyIssuer(stored: string, providerId: string): string | null {
  if (!stored.startsWith(`${providerId}#iss=`)) return null;
  const seg = stored.slice(providerId.length + 5).split('#')[0]!;
  try {
    return decodeURIComponent(seg);
  } catch {
    return null;
  }
}

/** The stored link with another issuer (keeping links when the provider's issuer moves). */
export function withIssuer(stored: string, providerId: string, issuer: string): string {
  const seg = stored.slice(providerId.length + 5).split('#')[0]!;
  return `${providerId}#iss=${enc(issuer.replace(/\/+$/, ''))}${stored.slice(providerId.length + 5 + seg.length)}`;
}

/**
 * The claim names a stored link was built from ('legacy' for `<provider>:<sub>`, 'moved' for a hashed link whose
 * issuer the administrator moved, null when it is not one of this provider or retired).
 */
export function keyClaimNames(stored: string, providerId: string): string[] | 'legacy' | 'moved' | null {
  if (stored.startsWith(`${providerId}:`)) return 'legacy';
  if (!stored.startsWith(`${providerId}#`)) return null;
  const segments = stored.slice(providerId.length + 1).split('#');
  // a hashed link whose issuer was moved: re-linked through its issuer + sub at the next sign-in
  if (segments[0]!.startsWith('moved=')) return 'moved';
  // a retired link matches nobody
  if (segments[0]!.startsWith('retired=')) return null;
  try {
    if (segments[0] === 'h') return decodeURIComponent(segments[1] ?? '').split(',');
    return segments.slice(1).map((s) => decodeURIComponent(s.slice(0, Math.max(0, s.indexOf('=')))));
  } catch {
    return null;
  }
}

// ---------- configuration defaults ----------

export type ProviderConfig = Omit<SsoProvider, 'id' | 'hasClientSecret' | 'enabled' | 'createdAt' | 'updatedAt' | 'warnings'>;

/**
 * A stored configuration with every setting: settings a provider was saved without get today's behaviour – also
 * the linking policy, which stays "by name" for providers from before it existed (new providers: "bound").
 */
export function withDefaults(c: Partial<ProviderConfig> & Pick<ProviderConfig, 'type'>): ProviderConfig {
  return {
    ...(c as ProviderConfig),
    groupsClaim: c.groupsClaim ?? 'roles',
    preset: c.preset ?? (c.type === 'entra' ? 'entra' : 'generic'),
    stableIdClaims: c.stableIdClaims?.length ? c.stableIdClaims : ['sub'],
    usernameTransform: c.usernameTransform ?? 'lowercase',
    displayNameTemplate: c.displayNameTemplate ?? '',
    firstNameClaim: c.firstNameClaim ?? 'given_name',
    lastNameClaim: c.lastNameClaim ?? 'family_name',
    profileFields: c.profileFields ?? [],
    sync: { ...DEFAULT_SSO_SYNC, ...c.sync },
    groupValues: c.groupValues ?? 'names',
    linkExisting: c.linkExisting ?? 'byName',
    stripDomains: c.stripDomains ?? [],
    stableIdConfirmedUnique: c.stableIdConfirmedUnique ?? false,
    emailVerifiedByProvider: c.emailVerifiedByProvider ?? false,
    useUserinfo: c.useUserinfo ?? false,
    requiredClaims: c.requiredClaims ?? [],
  };
}

/** Profile fields (department, job title …) from the claims, bounded. */
export function profileValues(c: Pick<SsoClaimSettings, 'profileFields'>, claims: Claims): { key: string; label: string; value: string }[] {
  const out: { key: string; label: string; value: string }[] = [];
  for (const f of c.profileFields.slice(0, SSO_LIMITS.profileFields)) {
    const value = claimText(claimAt(claims, f.claim), SSO_LIMITS.profileValueLength);
    if (value !== undefined) out.push({ key: f.key, label: f.label, value });
  }
  return out;
}

// ---------- showing received claims (test sign-in) ----------

const MAX_SHOWN_CLAIMS = 150;
const MAX_SHOWN_VALUE = 2000;

/** Claim names and values as JSON text for the test sign-in: bounded, never a token (only decoded claims get here). */
export function shownClaims(claims: Claims): SsoClaimEntry[] {
  return Object.entries(claims)
    .slice(0, MAX_SHOWN_CLAIMS)
    .map(([name, v]) => {
      let value: string;
      try {
        value = JSON.stringify(v) ?? 'null';
      } catch {
        value = '"(not shown)"';
      }
      const truncated = value.length > MAX_SHOWN_VALUE;
      return { name: name.slice(0, SSO_LIMITS.claimName), value: truncated ? value.slice(0, MAX_SHOWN_VALUE) : value, ...(truncated ? { truncated } : {}) };
    });
}
