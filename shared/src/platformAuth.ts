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

/**
 * Credentials that hold the text of a PEM file (0.26.2): the private key of the key-pair JWT and of a client assertion,
 * its certificate, and the client certificate of mutual TLS or an MQTT broker. They are entered in a multi-line field
 * – a single-line field drops the line breaks of pasted text. Presets mark theirs (`multiline` of a secret field).
 */
export const PEM_SECRET_KEYS: readonly string[] = ['privateKey', 'certificate', 'tlsCertificate', 'tlsKey'];

/** Whether a credential is entered as multi-line text: marked so by its preset, a PEM credential, or a value with line breaks or a PEM BEGIN line. */
export function isMultilineSecret(key: string, value = '', fields: readonly { key: string; multiline?: boolean }[] = []): boolean {
  const k = key.trim();
  return fields.some((f) => f.key === k && f.multiline) || PEM_SECRET_KEYS.includes(k) || value.includes('\n') || value.trimStart().startsWith('-----BEGIN ');
}
