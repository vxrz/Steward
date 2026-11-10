import crypto from 'node:crypto';
import { BOT_SCOPE, frameworkEndpoints, frameworkFetch, serviceUrlAllowed } from './framework.js';
import { botConfig, botSecrets } from './settings.js';

/**
 * The bot's way out (ADR 0013): its own token from Entra (client credentials – a certificate as a signed client
 * assertion, preferred, or a secret), and the Bot Connector calls that post and update cards at a conversation's
 * `serviceUrl`. A serviceUrl is used only when its host is on the fixed list of Teams service hosts.
 */

let cached: { token: string; until: number; key: string } | null = null;

/** Tests: forget the cached token. */
export function resetTokenCache(): void {
  cached = null;
}

function clientAssertion(appId: string, tokenUrl: string, certPem: string, keyPem: string): string {
  const cert = new crypto.X509Certificate(certPem);
  // x5t: the SHA-1 thumbprint Entra knows the certificate by (an identifier, not a password hash)
  const x5t = Buffer.from(cert.fingerprint.replace(/:/g, ''), 'hex').toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'RS256', typ: 'JWT', x5t });
  const body = enc({ aud: tokenUrl, iss: appId, sub: appId, jti: crypto.randomUUID(), nbf: now, exp: now + 300 });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), crypto.createPrivateKey(keyPem)).toString('base64url');
  return `${head}.${body}.${sig}`;
}

/** The bot's access token for the Bot Connector (cached until shortly before it expires). */
export async function botToken(): Promise<string> {
  const c = botConfig();
  const s = botSecrets();
  if (!s) throw new Error('The vault is locked');
  const tenant = c.tenantIds[0] ?? 'botframework.com';
  const key = `${c.appId}|${tenant}|${c.credential}`;
  if (cached && cached.key === key && cached.until > Date.now()) return cached.token;
  const tokenUrl = frameworkEndpoints().tokenEndpoint.replace('{tenant}', encodeURIComponent(tenant));
  const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: c.appId, scope: BOT_SCOPE });
  if (c.credential === 'certificate' && s.certificatePem && s.privateKeyPem) {
    form.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    form.set('client_assertion', clientAssertion(c.appId, tokenUrl, s.certificatePem, s.privateKeyPem));
  } else if (s.clientSecret) form.set('client_secret', s.clientSecret);
  else throw new Error('The bot has no credential');
  const r = await frameworkFetch(
    tokenUrl,
    { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() },
    [s.clientSecret ?? ''].filter(Boolean),
  );
  const j = r.json as { access_token?: unknown; expires_in?: unknown } | null;
  if (r.status !== 200 || typeof j?.access_token !== 'string') throw new Error(`The bot's token: HTTP ${r.status}`);
  const ttl = typeof j.expires_in === 'number' ? j.expires_in : 3600;
  cached = { token: j.access_token, until: Date.now() + Math.max(60, ttl - 300) * 1000, key };
  return cached.token;
}

/** A refusal of the Bot Connector: its status, and Retry-After (seconds) when it throttles. */
export class BotConnectorError extends Error {
  readonly status: number;
  readonly retryAfter: number | undefined;
  constructor(status: number, retryAfter?: number) {
    super(`Bot Connector: HTTP ${status}`);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const activitiesUrl = (serviceUrl: string, conversationId: string, activityId?: string) =>
  `${serviceUrl.replace(/\/+$/, '')}/v3/conversations/${encodeURIComponent(conversationId)}/activities${activityId ? `/${encodeURIComponent(activityId)}` : ''}`;

async function call(method: 'POST' | 'PUT', serviceUrl: string, conversationId: string, activity: unknown, activityId?: string): Promise<{ id?: string }> {
  if (!serviceUrlAllowed(serviceUrl)) throw new Error('The conversation names a service host that is not a Teams service host');
  const token = await botToken();
  const r = await frameworkFetch(
    activitiesUrl(serviceUrl, conversationId, activityId),
    { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(activity) },
    [token],
  );
  if (r.status < 200 || r.status > 299) throw new BotConnectorError(r.status, r.retryAfter);
  return { id: typeof (r.json as { id?: unknown } | null)?.id === 'string' ? (r.json as { id: string }).id : undefined };
}

/** Posts an activity (a card or a text) to a conversation; returns the new activity id. */
export const sendActivity = (serviceUrl: string, conversationId: string, activity: unknown) => call('POST', serviceUrl, conversationId, activity);
/** Replaces a card the bot posted. */
export const updateActivity = (serviceUrl: string, conversationId: string, activityId: string, activity: unknown) =>
  call('PUT', serviceUrl, conversationId, activity, activityId);
