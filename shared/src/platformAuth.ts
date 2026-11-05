import type { AuthType } from './api.js';

/**
 * Credentials that are stored but never sent (v0.3.1): a platform whose authentication is "none" sends no
 * username/password or token, however they are filled in – the API then answers 401 and nothing says why.
 * One check for the server's connection test and the platform pages, which warn and offer to switch.
 */

/** Kinds whose username/password or token are not the HTTP sign-in of the base URL (broker login, SASL, webhooks …). */
const OWN_LOGIN_KINDS = new Set(['mqtt', 'kafka', 'aws', 'snowflake', 'teams', 'database']);

export interface UnsentCredentials {
  /** The stored credential names that are not sent */
  keys: string[];
  /** The authentication they are meant for */
  suggest: Extract<AuthType, 'basic' | 'bearer'>;
}

/** Credentials for basic or bearer sign-in that a platform with authentication "none" stores but does not send, else null. */
export function unsentCredentials(p: { kind: string; config?: { auth?: { type?: AuthType } } }, secretKeys: readonly string[]): UnsentCredentials | null {
  if ((p.config?.auth?.type ?? 'none') !== 'none' || OWN_LOGIN_KINDS.has(p.kind)) return null;
  const has = (k: string) => secretKeys.includes(k);
  if (has('token')) return { keys: ['token'], suggest: 'bearer' };
  const basic = ['username', 'password'].filter(has);
  return basic.length ? { keys: basic, suggest: 'basic' } : null;
}

/**
 * The authentication a new platform gets from the credential fields filled in: the preset's own type, unless that is
 * "none" and filled-in fields declare the type they are for (`auth` of a secret field) – a token means bearer,
 * username/password basic. With fields for several types filled in, bearer wins over basic.
 */
export function impliedAuthType(
  presetType: AuthType | undefined,
  fields: readonly { key: string; auth?: AuthType }[],
  filled: Record<string, string | undefined>,
): AuthType {
  const base = presetType ?? 'none';
  if (base !== 'none') return base;
  const types = fields.filter((f) => f.auth && (filled[f.key] ?? '').trim()).map((f) => f.auth!);
  if (types.includes('bearer')) return 'bearer';
  return types[0] ?? 'none';
}
