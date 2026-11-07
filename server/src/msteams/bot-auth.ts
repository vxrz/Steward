import crypto from 'node:crypto';
import { logger } from '../log.js';
import { ISSUER, frameworkEndpoints, frameworkFetch, serviceUrlAllowed } from './framework.js';

/**
 * The one small module that decides whether an inbound call comes from Microsoft's Bot Connector (ADR 0013). A call
 * is accepted only when all of this holds, checked before anything else of the activity is used:
 *
 *  - an `Authorization: Bearer` JWT signed with RS256 by a current Bot Framework key (from its OpenID metadata,
 *    cached; refreshed at most every 5 minutes on an unknown key id, and once a day);
 *  - the key's endorsements name the activity's channel (`msteams`);
 *  - issuer https://api.botframework.com, audience = the bot's app id, `exp` / `nbf` within 5 minutes of clock skew;
 *  - the token's `serviceUrl` claim equals the activity's `serviceUrl`, and that host is on the fixed list of Teams
 *    service hosts – Steward sends its own token there when it answers.
 *
 * Every failure is the same 401 to the caller; the reason is only for the (rate-limited) audit entry.
 */

const SKEW_S = 5 * 60;
const REFRESH_UNKNOWN_MS = 5 * 60_000;
const REFRESH_ALWAYS_MS = 24 * 3_600_000;

interface Jwk {
  kid: string;
  kty: string;
  n?: string;
  e?: string;
  endorsements?: string[];
}

let keys: Map<string, Jwk> = new Map();
let fetchedAt = 0;
let fetching: Promise<void> | null = null;

async function loadKeys(): Promise<void> {
  const meta = await frameworkFetch(frameworkEndpoints().openIdMetadata, { method: 'GET' });
  const jwksUri = (meta.json as { jwks_uri?: unknown } | null)?.jwks_uri;
  if (meta.status !== 200 || typeof jwksUri !== 'string') throw new Error(`Bot Framework metadata: HTTP ${meta.status}`);
  const jwks = await frameworkFetch(jwksUri, { method: 'GET' });
  const list = (jwks.json as { keys?: Jwk[] } | null)?.keys;
  if (jwks.status !== 200 || !Array.isArray(list)) throw new Error(`Bot Framework keys: HTTP ${jwks.status}`);
  keys = new Map(list.filter((k) => k && typeof k.kid === 'string' && k.kty === 'RSA').map((k) => [k.kid, k]));
  fetchedAt = Date.now();
}

/** While the metadata cannot be read: no new attempt before the backoff ends (1 minute, doubling up to 15). */
let failedAt = 0;
let backoffMs = 0;
let warnedAt = 0;

async function keyFor(kid: string): Promise<Jwk | undefined> {
  const now = Date.now();
  const stale = now - fetchedAt > REFRESH_ALWAYS_MS;
  const wanted = stale || (!keys.has(kid) && now - fetchedAt > REFRESH_UNKNOWN_MS);
  if (wanted && now - failedAt >= backoffMs) {
    fetching ??= loadKeys()
      .then(() => {
        failedAt = 0;
        backoffMs = 0;
      })
      .catch((err) => {
        failedAt = Date.now();
        backoffMs = Math.min(Math.max(backoffMs * 2, 60_000), 15 * 60_000);
        // one warning per backoff interval, not one per request
        if (Date.now() - warnedAt >= backoffMs) {
          warnedAt = Date.now();
          logger.warn(
            { err: { message: (err as Error).message }, retryInSeconds: Math.round(backoffMs / 1000) },
            'Teams bot: the Bot Framework keys could not be read',
          );
        }
      })
      .finally(() => (fetching = null));
    await fetching;
  }
  return keys.get(kid);
}

/** Tests: forget the cached keys. */
export function resetKeyCache(): void {
  keys = new Map();
  fetchedAt = 0;
  failedAt = 0;
  backoffMs = 0;
  warnedAt = 0;
}

/** Tests: how often the metadata was asked for. */
export const keyFetchState = () => ({ failedAt, backoffMs });

const b64json = (s: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

export type AuthFailure =
  'noToken' | 'malformed' | 'unknownKey' | 'signature' | 'issuer' | 'audience' | 'expired' | 'notYetValid' | 'endorsement' | 'serviceUrl';

export interface VerifiedCall {
  claims: Record<string, unknown>;
}

/** Checks the token of an inbound call against the activity it carries. */
export async function verifyBotToken(
  authorization: string | undefined,
  activity: { serviceUrl?: unknown; channelId?: unknown },
  appId: string,
  now = Date.now(),
): Promise<{ ok: true; call: VerifiedCall } | { ok: false; reason: AuthFailure }> {
  const m = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(authorization ?? '');
  if (!m) return { ok: false, reason: authorization ? 'malformed' : 'noToken' };
  const [, h, p, sig] = m as unknown as [string, string, string, string];
  const header = b64json(h);
  const claims = b64json(p);
  if (!header || !claims || header.alg !== 'RS256' || typeof header.kid !== 'string') return { ok: false, reason: 'malformed' };
  const jwk = await keyFor(header.kid);
  if (!jwk) return { ok: false, reason: 'unknownKey' };
  const verified = (): boolean => {
    try {
      const key = crypto.createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
      return crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(sig, 'base64url'));
    } catch {
      return false; // a key Node cannot read: no signature can match
    }
  };
  const valid = verified();
  if (!valid) return { ok: false, reason: 'signature' };
  if (claims.iss !== ISSUER) return { ok: false, reason: 'issuer' };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!appId || !aud.includes(appId)) return { ok: false, reason: 'audience' };
  const nowS = Math.floor(now / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + SKEW_S < nowS) return { ok: false, reason: 'expired' };
  if (typeof claims.nbf === 'number' && claims.nbf - SKEW_S > nowS) return { ok: false, reason: 'notYetValid' };
  if (!Array.isArray(jwk.endorsements) || typeof activity.channelId !== 'string' || !jwk.endorsements.includes(activity.channelId))
    return { ok: false, reason: 'endorsement' };
  // a forged or foreign serviceUrl would receive Steward's own token when it answers
  if (typeof claims.serviceUrl !== 'string' || claims.serviceUrl !== activity.serviceUrl || !serviceUrlAllowed(claims.serviceUrl))
    return { ok: false, reason: 'serviceUrl' };
  return { ok: true, call: { claims } };
}
