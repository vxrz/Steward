import crypto from 'node:crypto';
import { vault } from './vault.js';
import { canonicalJson } from './util.js';

/**
 * Integrity of non-secret settings that decide where credentials are sent (platform base URL,
 * token URL, trusted origins, headers; sign-in provider issuer …). They are stored in clear –
 * an HMAC with the vault's integrity key over them detects changes made directly in the
 * database (e.g. by a database administrator) that would otherwise redirect credentials.
 */
export type IntegrityState = 'ok' | 'unsealed' | 'mismatch' | 'locked';

export function configMac(kind: string, id: string, fields: unknown): string {
  return crypto
    .createHmac('sha256', vault().integrityKey())
    .update(`${kind}\n${id}\n${canonicalJson(fields)}`)
    .digest('hex');
}

export function checkMac(kind: string, id: string, fields: unknown, stored: string | null | undefined): IntegrityState {
  if (!vault().unlocked) return 'locked';
  if (!stored) return 'unsealed';
  const expected = Buffer.from(configMac(kind, id, fields));
  const actual = Buffer.from(stored);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual) ? 'ok' : 'mismatch';
}
