/**
 * OAuth 2.1 sign-in for MCP clients (#12), following the MCP authorization specification. Optional: off by default,
 * an administrator turns it on (Settings → MCP server); personal MCP tokens keep working either way.
 *
 * Steward is the authorization server for its own MCP endpoint. A person signs in to Steward as usual (password or
 * single sign-on), sees which client asks for access and allows it; the client gets a short-lived access token for
 * the MCP endpoint only (audience-bound) and a rotating refresh token.
 *
 * - Discovery: protected resource metadata (RFC 9728) and authorization server metadata (RFC 8414).
 * - Clients: dynamic registration (RFC 7591, can be turned off) or added by administrators. Public clients only
 *   (no secrets): every client proves possession with PKCE (S256, required).
 * - Redirect URIs: https, http on a loopback address (any port, RFC 8252), or a private-use scheme. Exact match.
 * - Scope: "mcp" (the same rights as an MCP token: the person's own, through the MCP tools only).
 * - Audience: the token is bound to the MCP endpoint (RFC 8707 "resource"); it works nowhere else.
 * - Refresh tokens rotate; reusing an old one revokes the grant (a stolen copy and the client both lose access).
 * - Codes are one-time and live 10 minutes; reusing a code revokes the grant it created.
 * - People see and revoke their connected clients in their profile; administrators see all and revoke clients.
 */
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MCP_OAUTH_LIMITS, type McpOAuthClient, type McpOAuthConsent, type McpOAuthGrant, type McpOAuthSettings, type UserInfo } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { config } from '../config.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { readSetting, writeSetting } from '../settings.js';
import { getUser } from '../auth/users.js';
import { currentUser } from '../auth/context.js';
import { ACCESS, me } from '../auth/access.js';
import { requireCapability } from '../auth/permissions.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { MCP_PATH, mcpEnabled, registerOAuthSettings } from './config.js';

// ---------- settings ----------

const SETTING = 'mcp.oauth';
const DEFAULTS: McpOAuthSettings = { enabled: false, dynamicRegistration: true, accessTokenMinutes: 60, refreshTokenDays: 30 };
const clamp = (n: unknown, [lo, hi]: readonly [number, number], fallback: number) =>
  typeof n === 'number' && Number.isInteger(n) ? Math.min(hi, Math.max(lo, n)) : fallback;

export function oauthSettings(): McpOAuthSettings {
  let s: Partial<McpOAuthSettings> = {};
  try {
    s = readSetting<Partial<McpOAuthSettings>>(SETTING, {});
  } catch {
    /* database not ready */
  }
  return {
    enabled: s.enabled === true,
    dynamicRegistration: s.dynamicRegistration !== false,
    accessTokenMinutes: clamp(s.accessTokenMinutes, MCP_OAUTH_LIMITS.accessTokenMinutes, DEFAULTS.accessTokenMinutes),
    refreshTokenDays: clamp(s.refreshTokenDays, MCP_OAUTH_LIMITS.refreshTokenDays, DEFAULTS.refreshTokenDays),
  };
}

registerOAuthSettings(oauthSettings);

/** OAuth works only while the MCP server is on as well. */
export const oauthEnabled = (): boolean => mcpEnabled() && oauthSettings().enabled;
/** Whether the MCP endpoint offers OAuth sign-in: what a client without a token is told, and the WWW-Authenticate hint. */
export const offersSignIn = (): boolean => oauthEnabled();

export const oauthSettingsInput = z
  .object({
    enabled: z.boolean().optional(),
    dynamicRegistration: z.boolean().optional(),
    accessTokenMinutes: z.number().int().min(MCP_OAUTH_LIMITS.accessTokenMinutes[0]).max(MCP_OAUTH_LIMITS.accessTokenMinutes[1]).optional(),
    refreshTokenDays: z.number().int().min(MCP_OAUTH_LIMITS.refreshTokenDays[0]).max(MCP_OAUTH_LIMITS.refreshTokenDays[1]).optional(),
  })
  .strict();

export function setOAuthSettings(patch: z.infer<typeof oauthSettingsInput>): McpOAuthSettings {
  const before = oauthSettings();
  const after = { ...before, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as McpOAuthSettings;
  writeSetting(SETTING, after);
  const changed = (Object.keys(after) as (keyof McpOAuthSettings)[]).filter((k) => before[k] !== after[k]);
  if (changed.length)
    audit({
      action: 'mcp.settings_changed',
      entityType: 'settings',
      entityId: 'mcp',
      summary: `OAuth sign-in for MCP clients: ${changed.map((k) => `${k} ${String(before[k])} → ${String(after[k])}`).join(', ')}`,
      details: { oauth: { from: before, to: after } },
    });
  return after;
}

// ---------- addresses ----------

/** The issuer: SM_PUBLIC_URL, or the address of this request (the Host header is allow-listed in app.ts). */
export function issuerOf(req: FastifyRequest): string {
  if (config.publicUrl) return config.publicUrl;
  return `${req.protocol}://${req.host}${config.basePath}`;
}
/** The protected resource: the MCP endpoint. Access tokens are bound to it. */
export const resourceOf = (req: FastifyRequest): string => issuerOf(req) + MCP_PATH;
/** RFC 9728 well-known address of the resource metadata: the path of the resource after the well-known prefix. */
export function resourceMetadataUrl(req: FastifyRequest): string {
  const u = new URL(resourceOf(req));
  return `${u.origin}/.well-known/oauth-protected-resource${u.pathname}`;
}

// ---------- tokens and hashes ----------

export const ACCESS_PREFIX = 'smo_';
const REFRESH_PREFIX = 'smr_';
const CODE_TTL_MS = 10 * 60_000;
const MAX_GRANTS_PER_USER = 50;
const SCOPES = ['mcp'] as const;
const hashOf = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const random = (prefix = '') => prefix + crypto.randomBytes(32).toString('base64url');
const s256 = (verifier: string) => crypto.createHash('sha256').update(verifier).digest('base64url');

class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly description: string,
  ) {
    super(description);
  }
}

// ---------- clients ----------

interface ClientRow {
  id: string;
  name: string;
  redirect_uris: string;
  registered_by: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

const BLOCKED_SCHEMES = ['javascript', 'data', 'file', 'vbscript', 'about', 'blob', 'ftp', 'ws', 'wss'];
const LOOPBACK = ['127.0.0.1', '[::1]', 'localhost'];

/** Why a redirect URI is not allowed (null: it is). */
export function redirectProblem(raw: string): string | null {
  if (raw.length > 500) return 'is longer than 500 characters';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'is not an absolute URI';
  }
  if (u.hash || raw.includes('#')) return 'must not have a fragment';
  const scheme = u.protocol.replace(/:$/, '').toLowerCase();
  if (scheme === 'https') return u.username || u.password ? 'must not contain user information' : null;
  if (scheme === 'http') return LOOPBACK.includes(u.hostname.toLowerCase()) ? null : 'http is only allowed on a loopback address (127.0.0.1, [::1], localhost)';
  if (BLOCKED_SCHEMES.includes(scheme)) return `the scheme "${scheme}" is not allowed`;
  return /^[a-z][a-z0-9+.-]*$/.test(scheme) ? null : 'has an invalid scheme';
}

/** Exact match; a loopback http redirect may use any port (RFC 8252 7.3). */
function redirectMatches(registered: string[], uri: string): boolean {
  if (registered.includes(uri)) return true;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' || !LOOPBACK.includes(u.hostname.toLowerCase())) return false;
  return registered.some((r) => {
    try {
      const v = new URL(r);
      return v.protocol === 'http:' && v.hostname === u.hostname && v.pathname === u.pathname && v.search === u.search;
    } catch {
      return false;
    }
  });
}

/** A display name: trimmed, without control characters, at most 100 characters. */
function clientName(raw: unknown): string {
  if (typeof raw !== 'string') return 'MCP client';
  const clean = [...raw.trim()].filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127).join('');
  return clean.slice(0, 100) || 'MCP client';
}

function createClient(name: string, redirectUris: string[], registeredBy: string): ClientRow {
  if (!redirectUris.length || redirectUris.length > MCP_OAUTH_LIMITS.redirectUris)
    throw new OAuthError(400, 'invalid_redirect_uri', `Register 1 to ${MCP_OAUTH_LIMITS.redirectUris} redirect URIs`);
  for (const r of redirectUris) {
    const p = typeof r === 'string' ? redirectProblem(r) : 'is not a string';
    if (p) throw new OAuthError(400, 'invalid_redirect_uri', `The redirect URI ${JSON.stringify(String(r).slice(0, 100))} ${p}`);
  }
  const count = () => Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM oauth_clients WHERE revoked_at IS NULL')!.n);
  // a full list (e.g. registrations nobody finished): self-registered clients older than a day that were never used go first
  if (count() >= MCP_OAUTH_LIMITS.clients)
    db().run(
      `DELETE FROM oauth_clients WHERE registered_by = 'dynamic' AND last_used_at IS NULL AND created_at < ?
       AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.id)`,
      new Date(Date.now() - 86_400_000).toISOString(),
    );
  if (count() >= MCP_OAUTH_LIMITS.clients)
    throw new OAuthError(400, 'invalid_client_metadata', 'Too many registered clients – an administrator can remove unused ones');
  const row: ClientRow = {
    id: newId('mcpc_'),
    name,
    redirect_uris: JSON.stringify([...new Set(redirectUris)]),
    registered_by: registeredBy,
    created_at: nowIso(),
    last_used_at: null,
    revoked_at: null,
  };
  db().tx(() => {
    db().run(
      'INSERT INTO oauth_clients (id, name, redirect_uris, registered_by, created_at) VALUES (?, ?, ?, ?, ?)',
      row.id,
      row.name,
      row.redirect_uris,
      row.registered_by,
      row.created_at,
    );
    audit({
      actor: registeredBy === 'dynamic' ? 'system' : registeredBy,
      action: 'mcp.oauth_client_registered',
      entityType: 'mcp_client',
      entityId: row.id,
      summary: `MCP client "${row.name}" registered ${registeredBy === 'dynamic' ? 'itself' : `by ${registeredBy}`} (redirect: ${JSON.parse(row.redirect_uris).join(', ')})`,
      details: { name: row.name, redirectUris: JSON.parse(row.redirect_uris), registeredBy },
    });
  });
  return row;
}

const activeClient = (id: unknown): ClientRow | undefined =>
  typeof id === 'string' && id.length <= 100 ? db().get<ClientRow>('SELECT * FROM oauth_clients WHERE id = ? AND revoked_at IS NULL', id) : undefined;

export function listClients(): McpOAuthClient[] {
  const counts = new Map(
    db()
      .all<{ client_id: string; n: number }>('SELECT client_id, COUNT(*) AS n FROM oauth_grants WHERE revoked_at IS NULL GROUP BY client_id')
      .map((r) => [r.client_id, Number(r.n)]),
  );
  return db()
    .all<ClientRow>('SELECT * FROM oauth_clients WHERE revoked_at IS NULL ORDER BY created_at DESC')
    .map((r) => ({
      id: r.id,
      name: r.name,
      redirectUris: parseJson<string[]>(r.redirect_uris, []),
      registeredBy: r.registered_by,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      grants: counts.get(r.id) ?? 0,
    }));
}

export function addClient(input: { name: string; redirectUris: string[] }): McpOAuthClient {
  try {
    const row = createClient(clientName(input.name), input.redirectUris, me().username);
    return listClients().find((c) => c.id === row.id)!;
  } catch (e) {
    if (e instanceof OAuthError) throw new HttpError(400, e.description, 'MCP_OAUTH_CLIENT_INVALID', { reason: e.description });
    throw e;
  }
}

/** Removes a client: its grants end at once. */
export function revokeClient(id: string): void {
  const c = activeClient(id);
  if (!c) throw new HttpError(404, 'MCP client not found', 'MCP_OAUTH_CLIENT_NOT_FOUND');
  const ts = nowIso();
  db().tx(() => {
    db().run('UPDATE oauth_clients SET revoked_at = ? WHERE id = ?', ts, id);
    db().run('UPDATE oauth_grants SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL', ts, id);
    db().run('DELETE FROM oauth_codes WHERE client_id = ?', id);
    audit({
      action: 'mcp.oauth_client_revoked',
      entityType: 'mcp_client',
      entityId: id,
      summary: `MCP client "${c.name}" removed – its access ends`,
    });
  });
}

// ---------- grants ----------

interface GrantRow {
  id: string;
  client_id: string;
  user_id: string;
  scope: string;
  resource: string;
  access_hash: string;
  access_expires_at: string;
  refresh_hash: string;
  previous_refresh_hash: string | null;
  refresh_expires_at: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

function toGrant(r: GrantRow & { client_name: string; username: string }): McpOAuthGrant {
  return {
    id: r.id,
    clientId: r.client_id,
    clientName: r.client_name,
    owner: r.username,
    scope: r.scope,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    expiresAt: r.refresh_expires_at,
  };
}

const GRANTS = `SELECT g.*, c.name AS client_name, u.username FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id
  JOIN users u ON u.id = g.user_id WHERE g.revoked_at IS NULL AND g.refresh_expires_at > ?`;

export function listGrants(userId?: string): McpOAuthGrant[] {
  const rows = userId
    ? db().all<GrantRow & { client_name: string; username: string }>(`${GRANTS} AND g.user_id = ? ORDER BY g.created_at DESC`, nowIso(), userId)
    : db().all<GrantRow & { client_name: string; username: string }>(`${GRANTS} ORDER BY g.created_at DESC`, nowIso());
  return rows.map(toGrant);
}

/** Ends a grant: its access and refresh token stop working. Only its owner or an administrator. */
export function revokeGrant(id: string, opts: { asAdmin: boolean }): void {
  const g = db().get<GrantRow & { client_name: string; username: string }>(`${GRANTS} AND g.id = ?`, nowIso(), id);
  if (!g || (!opts.asAdmin && g.user_id !== me().id)) throw new HttpError(404, 'Connected MCP client not found', 'MCP_OAUTH_GRANT_NOT_FOUND');
  db().tx(() => {
    db().run('UPDATE oauth_grants SET revoked_at = ? WHERE id = ?', nowIso(), id);
    audit({
      action: 'mcp.oauth_grant_revoked',
      entityType: 'mcp_client',
      entityId: g.client_id,
      summary: `Access of MCP client "${g.client_name}" for ${g.username} revoked`,
      details: { grantId: id, owner: g.username },
    });
  });
}

function newTokens(): { access: string; refresh: string; accessExpires: string; refreshExpires: string; expiresIn: number } {
  const s = oauthSettings();
  const expiresIn = s.accessTokenMinutes * 60;
  return {
    access: random(ACCESS_PREFIX),
    refresh: random(REFRESH_PREFIX),
    accessExpires: new Date(Date.now() + expiresIn * 1000).toISOString(),
    refreshExpires: new Date(Date.now() + s.refreshTokenDays * 86_400_000).toISOString(),
    expiresIn,
  };
}

const tokenResponse = (t: ReturnType<typeof newTokens>, scope: string) => ({
  access_token: t.access,
  token_type: 'Bearer',
  expires_in: t.expiresIn,
  refresh_token: t.refresh,
  scope,
});

/** The bearer token of an MCP request, if it is an OAuth access token (see mcp/http.ts). */
export type OAuthAccess =
  { ok: true; user: UserInfo; grantId: string; clientName: string } | { ok: false; reason: 'invalid' | 'disabled' | 'audience' | 'owner_disabled' };

const lastTouched = new Map<string, number>();
export function resolveAccessGrant(token: string, resource: string): OAuthAccess {
  if (!token.startsWith(ACCESS_PREFIX)) return { ok: false, reason: 'invalid' };
  if (!oauthEnabled()) return { ok: false, reason: 'disabled' };
  const g = db().get<GrantRow & { client_name: string; client_revoked: string | null }>(
    `SELECT g.*, c.name AS client_name, c.revoked_at AS client_revoked FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id
     WHERE g.access_hash = ?`,
    hashOf(token),
  );
  if (!g || g.revoked_at || g.client_revoked || g.access_expires_at <= nowIso()) return { ok: false, reason: 'invalid' };
  if (g.resource !== resource) return { ok: false, reason: 'audience' };
  let user: UserInfo;
  try {
    user = getUser(g.user_id);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!user.active) return { ok: false, reason: 'owner_disabled' };
  // last use, at most once a minute per grant
  const now = Date.now();
  if ((lastTouched.get(g.id) ?? 0) < now - 60_000) {
    lastTouched.set(g.id, now);
    const ts = nowIso();
    db().run('UPDATE oauth_grants SET last_used_at = ? WHERE id = ?', ts, g.id);
    db().run('UPDATE oauth_clients SET last_used_at = ? WHERE id = ?', ts, g.client_id);
  }
  return { ok: true, user, grantId: g.id, clientName: g.client_name };
}

// ---------- authorization (the consent page) ----------

export const authorizeQuery = z
  .object({
    response_type: z.string().max(20),
    client_id: z.string().max(100),
    redirect_uri: z.string().max(500),
    code_challenge: z.string().max(200).optional(),
    code_challenge_method: z.string().max(20).optional(),
    scope: z.string().max(200).optional(),
    state: z.string().max(1000).optional(),
    resource: z.string().max(500).optional(),
  })
  .strip();
type AuthorizeQuery = z.infer<typeof authorizeQuery>;

/**
 * The checks of an authorization request. A bad client or redirect URI is shown on the page (never redirected to: it
 * could be anyone's); every other problem goes back to the client's redirect URI as an OAuth error.
 */
function checkAuthorize(q: AuthorizeQuery, req: FastifyRequest): { client: ClientRow; scope: string; resource: string } {
  if (!oauthEnabled()) throw new HttpError(404, 'OAuth sign-in for MCP clients is turned off on this Steward', 'MCP_OAUTH_OFF');
  const client = activeClient(q.client_id);
  if (!client) throw new HttpError(400, 'Unknown MCP client', 'MCP_OAUTH_CLIENT_UNKNOWN');
  if (!redirectMatches(parseJson<string[]>(client.redirect_uris, []), q.redirect_uri))
    throw new HttpError(400, 'The redirect URI is not registered for this client', 'MCP_OAUTH_REDIRECT_UNKNOWN');
  const back = (error: string, description: string) => {
    throw new HttpError(400, description, 'MCP_OAUTH_REQUEST_INVALID', { redirectTo: errorRedirect(q, error, description, req) });
  };
  if (q.response_type !== 'code') back('unsupported_response_type', 'Only response_type=code is supported');
  if (!q.code_challenge || q.code_challenge_method !== 'S256') back('invalid_request', 'PKCE with code_challenge_method=S256 is required');
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge!)) back('invalid_request', 'Invalid code_challenge');
  const scopes = (q.scope ?? 'mcp').split(' ').filter(Boolean);
  if (!scopes.length || scopes.some((s) => !(SCOPES as readonly string[]).includes(s))) back('invalid_scope', 'The only scope is "mcp"');
  const resource = resourceOf(req);
  if (q.resource && q.resource.replace(/\/$/, '') !== resource) back('invalid_target', `The resource must be ${resource}`);
  return { client, scope: 'mcp', resource };
}

function errorRedirect(q: AuthorizeQuery, error: string, description: string, req: FastifyRequest): string {
  const u = new URL(q.redirect_uri);
  u.searchParams.set('error', error);
  u.searchParams.set('error_description', description);
  if (q.state) u.searchParams.set('state', q.state);
  u.searchParams.set('iss', issuerOf(req));
  return u.toString();
}

function hostOf(uri: string): string {
  try {
    const u = new URL(uri);
    return u.host || `${u.protocol}//`;
  } catch {
    return uri;
  }
}

export function consent(q: AuthorizeQuery, req: FastifyRequest): McpOAuthConsent {
  const { client, scope, resource } = checkAuthorize(q, req);
  const already = !!db().get(
    'SELECT 1 AS x FROM oauth_grants WHERE client_id = ? AND user_id = ? AND revoked_at IS NULL AND refresh_expires_at > ?',
    client.id,
    me().id,
    nowIso(),
  );
  return {
    clientId: client.id,
    clientName: client.name,
    redirectUri: q.redirect_uri,
    redirectHost: hostOf(q.redirect_uri),
    registeredBy: client.registered_by,
    scope,
    resource,
    alreadyGranted: already,
  };
}

/** The person's answer: a one-time code for the client, or access_denied. */
export function decideAuthorize(q: AuthorizeQuery, approve: boolean, req: FastifyRequest): { redirectTo: string } {
  const { client, scope, resource } = checkAuthorize(q, req);
  const u = me();
  if (!approve) return { redirectTo: errorRedirect(q, 'access_denied', 'The person did not allow access', req) };
  if (u.emergency) throw new HttpError(403, 'MCP clients cannot be connected in an emergency access session', 'EMERGENCY_NO_TOKENS');
  const code = random();
  const ts = nowIso();
  db().tx(() => {
    // codes nobody exchanged
    db().run('DELETE FROM oauth_codes WHERE expires_at < ?', new Date(Date.now() - 86_400_000).toISOString());
    db().run(
      `INSERT INTO oauth_codes (hash, client_id, user_id, redirect_uri, code_challenge, scope, resource, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      hashOf(code),
      client.id,
      u.id,
      q.redirect_uri,
      q.code_challenge!,
      scope,
      resource,
      new Date(Date.now() + CODE_TTL_MS).toISOString(),
    );
    audit({
      action: 'mcp.oauth_authorized',
      entityType: 'mcp_client',
      entityId: client.id,
      summary: `${u.username} allowed MCP client "${client.name}" to act as them through MCP (returns to ${hostOf(q.redirect_uri)})`,
      details: { client: client.name, redirectUri: q.redirect_uri, scope, at: ts },
    });
  });
  const back = new URL(q.redirect_uri);
  back.searchParams.set('code', code);
  if (q.state) back.searchParams.set('state', q.state);
  back.searchParams.set('iss', issuerOf(req));
  return { redirectTo: back.toString() };
}

// ---------- the token endpoint ----------

const str = (v: unknown, max = 2000): string | undefined => (typeof v === 'string' && v.length <= max ? v : undefined);

function exchangeCode(b: Record<string, unknown>, req: FastifyRequest) {
  const code = str(b.code, 200);
  const verifier = str(b.code_verifier, 200);
  const client = activeClient(b.client_id);
  if (!client) throw new OAuthError(401, 'invalid_client', 'Unknown client');
  if (!code || !verifier) throw new OAuthError(400, 'invalid_request', 'code and code_verifier are required');
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new OAuthError(400, 'invalid_grant', 'Invalid code_verifier');
  const row = db().get<{
    hash: string;
    client_id: string;
    user_id: string;
    redirect_uri: string;
    code_challenge: string;
    scope: string;
    resource: string;
    expires_at: string;
    used_at: string | null;
    grant_id: string | null;
  }>('SELECT * FROM oauth_codes WHERE hash = ?', hashOf(code));
  if (!row || row.client_id !== client.id) throw new OAuthError(400, 'invalid_grant', 'Invalid or expired code');
  if (row.used_at) {
    // a code used twice: whoever has it now must not keep the access it gave
    if (row.grant_id) db().run('UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', nowIso(), row.grant_id);
    audit({
      actor: 'system',
      action: 'mcp.oauth_code_reused',
      entityType: 'mcp_client',
      entityId: client.id,
      summary: `An authorization code of MCP client "${client.name}" was used twice – the access it gave was revoked`,
    });
    throw new OAuthError(400, 'invalid_grant', 'Invalid or expired code');
  }
  if (row.expires_at <= nowIso()) throw new OAuthError(400, 'invalid_grant', 'Invalid or expired code');
  if (str(b.redirect_uri, 500) !== row.redirect_uri) throw new OAuthError(400, 'invalid_grant', 'redirect_uri does not match the authorization request');
  if (s256(verifier) !== row.code_challenge) throw new OAuthError(400, 'invalid_grant', 'The code_verifier does not match the code_challenge');
  const resource = str(b.resource, 500);
  if (resource && resource.replace(/\/$/, '') !== row.resource) throw new OAuthError(400, 'invalid_target', `The resource must be ${row.resource}`);
  if (row.resource !== resourceOf(req)) throw new OAuthError(400, 'invalid_target', 'The code was issued for another resource');
  const user = getUser(row.user_id);
  if (!user.active) throw new OAuthError(400, 'invalid_grant', 'The account is deactivated');
  const t = newTokens();
  const grantId = newId('mcpg_');
  const ts = nowIso();
  db().tx(() => {
    const claimed = db().run('UPDATE oauth_codes SET used_at = ?, grant_id = ? WHERE hash = ? AND used_at IS NULL', ts, grantId, row.hash).changes;
    if (claimed !== 1) throw new OAuthError(400, 'invalid_grant', 'Invalid or expired code');
    // one grant per person and client: a new one replaces the old
    db().run('UPDATE oauth_grants SET revoked_at = ? WHERE client_id = ? AND user_id = ? AND revoked_at IS NULL', ts, client.id, user.id);
    const n = db().get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM oauth_grants WHERE user_id = ? AND revoked_at IS NULL AND refresh_expires_at > ?',
      user.id,
      ts,
    )!;
    if (Number(n.n) >= MAX_GRANTS_PER_USER)
      throw new OAuthError(400, 'invalid_grant', `At most ${MAX_GRANTS_PER_USER} connected MCP clients per person – revoke unused ones in your profile`);
    db().run(
      `INSERT INTO oauth_grants (id, client_id, user_id, scope, resource, access_hash, access_expires_at, refresh_hash, refresh_expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      grantId,
      client.id,
      user.id,
      row.scope,
      row.resource,
      hashOf(t.access),
      t.accessExpires,
      hashOf(t.refresh),
      t.refreshExpires,
      ts,
    );
    db().run('UPDATE oauth_clients SET last_used_at = ? WHERE id = ?', ts, client.id);
  });
  return tokenResponse(t, row.scope);
}

function refresh(b: Record<string, unknown>, req: FastifyRequest) {
  const token = str(b.refresh_token, 200);
  const client = activeClient(b.client_id);
  if (!client) throw new OAuthError(401, 'invalid_client', 'Unknown client');
  if (!token) throw new OAuthError(400, 'invalid_request', 'refresh_token is required');
  const h = hashOf(token);
  const g = db().get<GrantRow>('SELECT * FROM oauth_grants WHERE refresh_hash = ?', h);
  if (!g) {
    // an old refresh token again: the client and a thief share it – end the grant
    const reused = db().get<GrantRow>('SELECT * FROM oauth_grants WHERE previous_refresh_hash = ? AND revoked_at IS NULL', h);
    if (reused) {
      db().run('UPDATE oauth_grants SET revoked_at = ? WHERE id = ?', nowIso(), reused.id);
      audit({
        actor: 'system',
        action: 'mcp.oauth_refresh_reused',
        entityType: 'mcp_client',
        entityId: reused.client_id,
        summary: `An old refresh token of MCP client "${client.name}" was used again – its access was revoked`,
        details: { grantId: reused.id },
      });
    }
    throw new OAuthError(400, 'invalid_grant', 'Invalid, expired or revoked refresh token');
  }
  if (g.client_id !== client.id || g.revoked_at || g.refresh_expires_at <= nowIso())
    throw new OAuthError(400, 'invalid_grant', 'Invalid, expired or revoked refresh token');
  if (g.resource !== resourceOf(req)) throw new OAuthError(400, 'invalid_target', 'The grant is for another resource');
  const resource = str(b.resource, 500);
  if (resource && resource.replace(/\/$/, '') !== g.resource) throw new OAuthError(400, 'invalid_target', `The resource must be ${g.resource}`);
  const user = getUser(g.user_id);
  if (!user.active) throw new OAuthError(400, 'invalid_grant', 'The account is deactivated');
  const t = newTokens();
  const changed = db().run(
    `UPDATE oauth_grants SET access_hash = ?, access_expires_at = ?, refresh_hash = ?, previous_refresh_hash = ?, refresh_expires_at = ?
     WHERE id = ? AND refresh_hash = ? AND revoked_at IS NULL`,
    hashOf(t.access),
    t.accessExpires,
    hashOf(t.refresh),
    h,
    t.refreshExpires,
    g.id,
    h,
  ).changes;
  if (changed !== 1) throw new OAuthError(400, 'invalid_grant', 'Invalid, expired or revoked refresh token');
  return tokenResponse(t, g.scope);
}

// ---------- routes ----------

function oauthError(reply: FastifyReply, e: OAuthError): FastifyReply {
  reply.header('cache-control', 'no-store').header('pragma', 'no-cache');
  if (e.status === 401) reply.header('www-authenticate', 'Basic realm="Steward MCP"');
  return reply.code(e.status).send({ error: e.error, error_description: e.description });
}

const notOffered = (reply: FastifyReply) => reply.code(404).header('cache-control', 'no-store').send({ error: 'Not found' });

function resourceMetadata(req: FastifyRequest) {
  return {
    resource: resourceOf(req),
    authorization_servers: [issuerOf(req)],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Steward MCP server',
    resource_documentation: 'https://github.com/vxrz/Steward/blob/main/docs/MCP.md',
  };
}

function serverMetadata(req: FastifyRequest) {
  const iss = issuerOf(req);
  return {
    issuer: iss,
    authorization_endpoint: `${iss}/oauth/authorize`,
    token_endpoint: `${iss}/oauth/token`,
    revocation_endpoint: `${iss}/oauth/revoke`,
    ...(oauthSettings().dynamicRegistration ? { registration_endpoint: `${iss}/oauth/register` } : {}),
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...SCOPES],
    authorization_response_iss_parameter_supported: true,
  };
}

/** Discovery, registration, token and revocation endpoints (outside /api: OAuth clients call them, not the web UI). */
export async function oauthRoutes(app: FastifyInstance): Promise<void> {
  const publicRead = { config: { access: ACCESS.public } };
  for (const url of ['/.well-known/oauth-protected-resource', `/.well-known/oauth-protected-resource${MCP_PATH}`])
    app.get(url, publicRead, async (req, reply) =>
      oauthEnabled() ? reply.header('cache-control', 'max-age=300').send(resourceMetadata(req)) : notOffered(reply),
    );
  for (const url of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'])
    app.get(url, publicRead, async (req, reply) =>
      oauthEnabled() ? reply.header('cache-control', 'max-age=300').send(serverMetadata(req)) : notOffered(reply),
    );

  await app.register(async (scoped) => {
    scoped.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 16 * 1024 }, (_req, body, done) =>
      done(null, Object.fromEntries(new URLSearchParams(String(body)))),
    );
    scoped.setErrorHandler((err, _req, reply) => {
      if (err instanceof OAuthError) return oauthError(reply, err);
      const status = (err as { statusCode?: number }).statusCode;
      if (status && status < 500) return oauthError(reply, new OAuthError(400, 'invalid_request', 'The request could not be read'));
      throw err;
    });

    scoped.post('/oauth/register', { bodyLimit: 16 * 1024, config: { rateLimit: ROUTE_LIMITS.heavy } }, async (req, reply) => {
      if (!oauthEnabled()) return notOffered(reply);
      if (!oauthSettings().dynamicRegistration)
        throw new OAuthError(403, 'access_denied', 'Clients cannot register themselves here – ask an administrator to add the client');
      const b = (req.body ?? {}) as Record<string, unknown>;
      const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String) : [];
      const method = b.token_endpoint_auth_method;
      if (method !== undefined && method !== 'none')
        throw new OAuthError(400, 'invalid_client_metadata', 'Only public clients (token_endpoint_auth_method "none", with PKCE) are supported');
      const grantTypes = Array.isArray(b.grant_types) ? b.grant_types.map(String) : ['authorization_code'];
      if (grantTypes.some((g) => !['authorization_code', 'refresh_token'].includes(g)))
        throw new OAuthError(400, 'invalid_client_metadata', 'Supported grant types: authorization_code, refresh_token');
      const row = createClient(clientName(b.client_name), uris, 'dynamic');
      return reply
        .code(201)
        .header('cache-control', 'no-store')
        .send({
          client_id: row.id,
          client_id_issued_at: Math.floor(Date.parse(row.created_at) / 1000),
          client_name: row.name,
          redirect_uris: parseJson<string[]>(row.redirect_uris, []),
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          scope: SCOPES.join(' '),
        });
    });

    scoped.post('/oauth/token', { bodyLimit: 16 * 1024, config: { rateLimit: ROUTE_LIMITS.action } }, async (req, reply) => {
      if (!oauthEnabled()) return notOffered(reply);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const out =
        b.grant_type === 'authorization_code'
          ? exchangeCode(b, req)
          : b.grant_type === 'refresh_token'
            ? refresh(b, req)
            : (() => {
                throw new OAuthError(400, 'unsupported_grant_type', 'Supported: authorization_code, refresh_token');
              })();
      return reply.header('cache-control', 'no-store').header('pragma', 'no-cache').send(out);
    });

    // RFC 7009: always 200, whether the token was known or not
    scoped.post('/oauth/revoke', { bodyLimit: 16 * 1024, config: { rateLimit: ROUTE_LIMITS.action } }, async (req, reply) => {
      if (!oauthEnabled()) return notOffered(reply);
      const token = str(((req.body ?? {}) as Record<string, unknown>).token, 200);
      if (token) {
        const h = hashOf(token);
        db().run('UPDATE oauth_grants SET revoked_at = ? WHERE (access_hash = ? OR refresh_hash = ?) AND revoked_at IS NULL', nowIso(), h, h);
      }
      return reply.code(200).header('cache-control', 'no-store').send({});
    });
  });
}

/** The consent page's API, the profile list and the administrators' settings (registered with prefix /api). */
export async function oauthApiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/oauth/authorize', async (req) => consent(authorizeQuery.parse(req.query ?? {}), req));
  app.post(
    '/oauth/authorize',
    {
      config: {
        access: ACCESS.session,
        stepUp: { action: 'allowMcpClient', when: (req: FastifyRequest) => ((req.body ?? {}) as { approve?: boolean }).approve === true },
      },
    },
    async (req) => {
      const b = z
        .object({ request: authorizeQuery, approve: z.boolean() })
        .strict()
        .parse(req.body ?? {});
      return decideAuthorize(b.request, b.approve, req);
    },
  );

  app.get('/me/mcp-clients', async () => listGrants(me().id));
  app.delete('/me/mcp-clients/:grantId', async (req) => {
    revokeGrant((req.params as { grantId: string }).grantId, { asAdmin: false });
    return listGrants(me().id);
  });

  const admin = (what: string) => requireCapability(currentUser(), 'manageSettings', what);
  app.get('/settings/mcp-oauth', { config: { access: ACCESS.admin } }, async () => {
    admin('see the MCP clients');
    return { settings: oauthSettings(), clients: listClients(), grants: listGrants() };
  });
  app.put('/settings/mcp-oauth', { config: { access: ACCESS.adminSession } }, async (req) => {
    admin('change the OAuth sign-in for MCP clients');
    setOAuthSettings(oauthSettingsInput.parse(req.body ?? {}));
    return { settings: oauthSettings(), clients: listClients(), grants: listGrants() };
  });
  app.post('/settings/mcp-oauth/clients', { config: { access: ACCESS.adminSession } }, async (req) => {
    admin('add MCP clients');
    const b = z
      .object({
        name: z.string().trim().min(1).max(100),
        redirectUris: z.array(z.string().trim().min(1).max(500)).min(1).max(MCP_OAUTH_LIMITS.redirectUris),
      })
      .strict()
      .parse(req.body ?? {});
    return addClient(b);
  });
  app.delete('/settings/mcp-oauth/clients/:clientId', { config: { access: ACCESS.adminSession } }, async (req) => {
    admin('remove MCP clients');
    revokeClient((req.params as { clientId: string }).clientId);
    return { settings: oauthSettings(), clients: listClients(), grants: listGrants() };
  });
  app.delete('/settings/mcp-oauth/grants/:grantId', { config: { access: ACCESS.adminSession } }, async (req) => {
    admin('revoke access of MCP clients');
    revokeGrant((req.params as { grantId: string }).grantId, { asAdmin: true });
    return { settings: oauthSettings(), clients: listClients(), grants: listGrants() };
  });
}
