import crypto from 'node:crypto';

/**
 * Key-pair JWT sign-in (#114): Steward signs a short-lived JWT with the platform's private key (credential privateKey,
 * optionally encrypted with privateKeyPassphrase) and either sends it as the token (Snowflake: Authorization: Bearer
 * <jwt> with X-Snowflake-Authorization-Token-Type: KEYPAIR_JWT) or exchanges it for an access token at a token URL
 * (RFC 7523: Google service accounts, Salesforce, …).
 */

export const JWT_ALGS = ['RS256', 'RS384', 'RS512', 'PS256', 'ES256', 'ES384'] as const;
export type JwtAlg = (typeof JWT_ALGS)[number];

/** At most an hour (Snowflake's limit, and short enough that a leaked token is not worth much). */
export const JWT_MAX_LIFETIME = 3600;

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function privateKeyOf(pem: string | undefined, passphrase?: string): crypto.KeyObject {
  if (!pem?.trim()) throw new Error('Secret "privateKey" (PEM) is not set');
  try {
    return crypto.createPrivateKey({ key: pem, format: 'pem', ...(passphrase ? { passphrase } : {}) });
  } catch (e) {
    throw new Error(`The private key cannot be read${passphrase ? '' : ' (encrypted keys need the secret privateKeyPassphrase)'}: ${(e as Error).message}`);
  }
}

/** SHA256:<base64 of the SHA-256 of the DER public key> – what Snowflake calls the public key fingerprint. */
export function publicKeyFingerprint(key: crypto.KeyObject): string {
  const der = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  return `SHA256:${crypto.createHash('sha256').update(der).digest('base64')}`;
}

function algFor(key: crypto.KeyObject, alg: JwtAlg): void {
  const t = key.asymmetricKeyType;
  if (alg.startsWith('ES') ? t !== 'ec' : t !== 'rsa' && t !== 'rsa-pss') throw new Error(`The private key (${t}) does not fit the algorithm ${alg}`);
}

/** A signed JWT with the given claims; iat and exp are set here (lifetime capped at an hour), jti is random. */
export function signJwt(
  key: crypto.KeyObject,
  o: { alg: JwtAlg; claims: Record<string, unknown>; lifetimeSeconds?: number; kid?: string; now?: number },
): { jwt: string; exp: number } {
  algFor(key, o.alg);
  const iat = Math.floor((o.now ?? Date.now()) / 1000);
  const exp = iat + Math.max(30, Math.min(JWT_MAX_LIFETIME, Math.floor(o.lifetimeSeconds ?? JWT_MAX_LIFETIME)));
  const header = { alg: o.alg, typ: 'JWT', ...(o.kid ? { kid: o.kid } : {}) };
  const payload = { ...o.claims, iat, exp, jti: crypto.randomUUID() };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const hash = `sha${o.alg.slice(2)}`;
  const sig = o.alg.startsWith('ES')
    ? crypto.sign(hash, Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' })
    : o.alg.startsWith('PS')
      ? crypto.sign(hash, Buffer.from(input), { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST })
      : crypto.sign(hash, Buffer.from(input), key);
  return { jwt: `${input}.${b64url(sig)}`, exp };
}
