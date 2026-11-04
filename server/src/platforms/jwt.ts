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
  o: { alg: JwtAlg; claims: Record<string, unknown>; lifetimeSeconds?: number; kid?: string; now?: number; header?: Record<string, string> },
): { jwt: string; exp: number } {
  algFor(key, o.alg);
  const iat = Math.floor((o.now ?? Date.now()) / 1000);
  const exp = iat + Math.max(30, Math.min(JWT_MAX_LIFETIME, Math.floor(o.lifetimeSeconds ?? JWT_MAX_LIFETIME)));
  const header = { ...(o.header ?? {}), alg: o.alg, typ: 'JWT', ...(o.kid ? { kid: o.kid } : {}) };
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

/**
 * The certificate thumbprints a client assertion names its key by (Entra ID, v0.5.0): `x5t#S256` (SHA-256) and `x5t`
 * (SHA-1, what the Entra portal shows as the thumbprint), base64url of the DER certificate's hash. From the public
 * certificate (PEM, credential certificate) or – without one – from a SHA-1 thumbprint in hex (variable
 * certificateThumbprint), which gives only `x5t`.
 */
export function certificateThumbprints(certPem: string | undefined, sha1Hex?: string): Record<string, string> {
  if (certPem?.trim()) {
    let der: Buffer;
    try {
      der = new crypto.X509Certificate(certPem).raw;
    } catch (e) {
      throw new Error(`The certificate cannot be read (PEM of the public certificate expected): ${(e as Error).message}`);
    }
    return {
      'x5t#S256': crypto.createHash('sha256').update(der).digest('base64url'),
      x5t: crypto.createHash('sha1').update(der).digest('base64url'),
    };
  }
  const hex = (sha1Hex ?? '').replace(/[\s:]/g, '');
  if (/^[0-9a-f]{40}$/i.test(hex)) return { x5t: Buffer.from(hex, 'hex').toString('base64url') };
  throw new Error('A client assertion needs the public certificate (credential certificate, PEM) or its SHA-1 thumbprint (variable certificateThumbprint)');
}

/**
 * A client assertion (RFC 7523 private_key_jwt, as Entra ID expects it): iss and sub the client id, aud the token
 * endpoint, nbf now, signed with RS256 (or PS256 for an RSA-PSS key) and named by the certificate's thumbprints.
 */
export function clientAssertion(key: crypto.KeyObject, o: { clientId: string; tokenUrl: string; thumbprints: Record<string, string>; now?: number }): string {
  const now = o.now ?? Date.now();
  const alg: JwtAlg = key.asymmetricKeyType === 'rsa-pss' ? 'PS256' : key.asymmetricKeyType === 'ec' ? 'ES256' : 'RS256';
  return signJwt(key, {
    alg,
    claims: { iss: o.clientId, sub: o.clientId, aud: o.tokenUrl, nbf: Math.floor(now / 1000) },
    lifetimeSeconds: 600,
    header: o.thumbprints,
    now,
  }).jwt;
}

/**
 * Snowflake refuses a key-pair JWT with `390144 JWT token is invalid` and says no more (v0.3.1). The usual causes, in
 * the order they happen: the account identifier in iss/sub (variable account) is not what Snowflake expects – the
 * account locator without the region and cloud (XY12345, not xy12345.eu-central-1.aws) or ORGNAME-ACCOUNTNAME with a
 * hyphen (not a dot), upper case –, the user name differs, or the user's RSA_PUBLIC_KEY is not the platform's key.
 * Returns the message with that hint, or the message unchanged for other errors.
 */
export function snowflakeJwtHint(message: string, variables: Record<string, unknown> | undefined): string {
  if (!/390144|JWT token is invalid/i.test(message)) return message;
  const account = String(variables?.account ?? '').trim();
  const user = String(variables?.user ?? '').trim();
  const wrong = /[.]/.test(account)
    ? ` The variable account is "${account}": in the JWT it must be ${/^[a-z]{2}\d{4,6}\./i.test(account) ? `the account locator without region and cloud ("${account.split('.')[0]!.toUpperCase()}")` : `ORGNAME-ACCOUNTNAME with a hyphen ("${account.replace('.', '-').toUpperCase()}")`}.`
    : '';
  return (
    `${message} – Snowflake did not accept the key-pair JWT.${wrong} Check: the variable account is the account identifier as the JWT needs it ` +
    `(the account locator without region and cloud suffix, e.g. XY12345, or ORGNAME-ACCOUNTNAME – not the host name), the variable user` +
    `${user ? ` ("${user}")` : ''} is the Snowflake user's login name, and that user's RSA_PUBLIC_KEY (DESC USER) belongs to the platform's private key (docs/SNOWFLAKE.md).`
  );
}
