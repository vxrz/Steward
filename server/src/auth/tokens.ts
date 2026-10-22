import crypto from 'node:crypto';
import type { ApiToken, ApiTokenCreated, ApiTokenScope, UserInfo } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { HttpError, newId, nowIso } from '../util.js';
import { getUser } from './users.js';

/**
 * Personal API tokens for scripts and integrations: `Authorization: Bearer smt_…`.
 * Only a SHA-256 hash and a short prefix are stored. A token acts as its owner.
 */
interface TokenRow {
  id: string;
  user_id: string;
  name: string;
  scope: ApiTokenScope;
  prefix: string;
  hash: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  username?: string;
}

export const TOKEN_PREFIX = 'smt_';
const hashOf = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

const toToken = (r: TokenRow): ApiToken => ({
  id: r.id,
  name: r.name,
  scope: r.scope,
  prefix: r.prefix,
  owner: r.username ?? '',
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  expiresAt: r.expires_at,
  revoked: !!r.revoked_at,
});

const SELECT = 'SELECT t.*, u.username FROM api_tokens t JOIN users u ON u.id = t.user_id';

export function listTokens(userId?: string): ApiToken[] {
  return (
    userId ? db().all<TokenRow>(`${SELECT} WHERE t.user_id = ? ORDER BY t.created_at DESC`, userId) : db().all<TokenRow>(`${SELECT} ORDER BY t.created_at DESC`)
  ).map(toToken);
}

export function createToken(userId: string, input: { name: string; scope: ApiTokenScope; expiresInDays?: number }): ApiTokenCreated {
  const name = input.name.trim();
  if (!name || name.length > 100) throw new HttpError(400, 'Token name: 1–100 characters');
  const owner = getUser(userId);
  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  const id = newId('tok_');
  const ts = nowIso();
  const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86400000).toISOString() : null;
  db().tx(() => {
    db().run(
      'INSERT INTO api_tokens (id, user_id, name, scope, prefix, hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      userId,
      name,
      input.scope,
      token.slice(0, TOKEN_PREFIX.length + 6),
      hashOf(token),
      ts,
      expiresAt,
    );
    audit({
      action: 'token.created',
      entityType: 'token',
      entityId: id,
      summary: `API token "${name}" (${input.scope === 'read' ? 'read-only' : 'full access'}${expiresAt ? `, expires ${expiresAt.slice(0, 10)}` : ''}) created for ${owner.username}`,
      details: { name, scope: input.scope, expiresAt, owner: owner.username },
    });
  });
  const created = db().get<TokenRow>(`${SELECT} WHERE t.id = ?`, id)!;
  return { ...toToken(created), token };
}

/** Revokes a token; `ownerId` restricts it to that user's tokens. */
export function revokeToken(id: string, ownerId?: string): void {
  const r = db().get<TokenRow>(`${SELECT} WHERE t.id = ?`, id);
  if (!r || (ownerId && r.user_id !== ownerId)) throw new HttpError(404, 'Token not found');
  if (r.revoked_at) return;
  db().tx(() => {
    db().run('UPDATE api_tokens SET revoked_at = ? WHERE id = ?', nowIso(), id);
    audit({ action: 'token.revoked', entityType: 'token', entityId: id, summary: `API token "${r.name}" of ${r.username} revoked`, details: { owner: r.username } });
  });
}

/** Outcome of looking up a bearer token (used by the public API to tell the caller why a token was refused). */
export type TokenResolution =
  | {
      ok: true;
      user: UserInfo;
      tokenId: string;
      name: string;
      scope: ApiTokenScope;
      createdAt: string;
      expiresAt: string | null;
      lastUsedAt: string | null;
    }
  | { ok: false; reason: 'unknown' | 'revoked' | 'expired' | 'owner_disabled' };

/** Looks a bearer token up and records its use (lastUsedAt, at most once a minute). */
export function resolveToken(token: string): TokenResolution {
  if (!token.startsWith(TOKEN_PREFIX)) return { ok: false, reason: 'unknown' };
  const r = db().get<TokenRow>('SELECT * FROM api_tokens WHERE hash = ?', hashOf(token));
  if (!r) return { ok: false, reason: 'unknown' };
  if (r.revoked_at) return { ok: false, reason: 'revoked' };
  const now = Date.now();
  if (r.expires_at && Date.parse(r.expires_at) < now) return { ok: false, reason: 'expired' };
  let user: UserInfo;
  try {
    user = getUser(r.user_id);
  } catch {
    return { ok: false, reason: 'unknown' };
  }
  if (!user.active) return { ok: false, reason: 'owner_disabled' };
  if (!r.last_used_at || now - Date.parse(r.last_used_at) > 60000) {
    db().run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', new Date(now).toISOString(), r.id);
  }
  return { ok: true, user, tokenId: r.id, name: r.name, scope: r.scope, createdAt: r.created_at, expiresAt: r.expires_at, lastUsedAt: r.last_used_at };
}

/** Resolves a bearer token to its (active) owner; null when unknown, revoked, expired or the owner is disabled. */
export function tokenUser(token: string): { user: UserInfo; tokenId: string; scope: ApiTokenScope } | null {
  const r = resolveToken(token);
  return r.ok ? { user: r.user, tokenId: r.tokenId, scope: r.scope } : null;
}

/** `Authorization: Bearer <token>` → token, else undefined. */
export function bearerToken(header: string | undefined): string | undefined {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return m?.[1];
}
