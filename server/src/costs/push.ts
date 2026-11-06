import crypto from 'node:crypto';
import {
  COST_IMPORT_MODES,
  COST_PUSH_LIMITS,
  COST_PUSH_TOKEN_PREFIX,
  costPushPath,
  costPushTokenInput,
  type CostImportMode,
  type CostPushToken,
  type CostPushTokenCreated,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { currentUser, runAs } from '../auth/context.js';
import { findUserByName, toAuthUser } from '../auth/users.js';
import { readCookie, SESSION_COOKIE } from '../auth/cookies.js';
import { HttpError, newId, nowIso, parseJson, sha256 } from '../util.js';
import { addressAllowed, parseCidr } from '../triggers/service.js';
import { requireScope, scopeInfo } from './access.js';
import { importFile } from './service.js';

/**
 * Push tokens of the FOCUS import from CI (#226, docs/COSTS.md#push-from-ci), following the push tokens of database
 * schemas (0.8.0): a token belongs to one platform and can do nothing but push a FOCUS CSV file for it to
 * POST /api/hooks/costs/<platformId>. Only its SHA-256 is stored; the secret is shown once. Created, rotated and revoked
 * by who may manage the platform; it stops working when its creator is deactivated or may no longer manage the
 * platform. Checked from the headers before the body is read. Every change and every push is audited.
 */

interface TokenRow {
  id: string;
  platform_id: string;
  name: string;
  prefix: string;
  hash: string;
  allowed_cidrs: string;
  rate_limit_per_minute: number;
  expires_at: string | null;
  created_at: string;
  created_by: string;
  rotated_at: string | null;
  last_used_at: string | null;
  last_used_ip: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
}

const expired = (r: Pick<TokenRow, 'expires_at'>) => !!r.expires_at && r.expires_at <= nowIso();

/** The creator is active and may still manage the platform. */
function creatorMayPush(r: Pick<TokenRow, 'created_by' | 'platform_id'>): boolean {
  const u = findUserByName(r.created_by);
  if (!u || !u.active) return false;
  try {
    return runAs(toAuthUser(u), () => scopeInfo('platform', r.platform_id)?.canManageSource === true);
  } catch {
    return false; // the platform is gone, or the creator may no longer see it
  }
}

const toToken = (r: TokenRow): CostPushToken => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  allowedCidrs: parseJson<string[]>(r.allowed_cidrs, []),
  rateLimitPerMinute: Number(r.rate_limit_per_minute),
  expiresAt: r.expires_at,
  createdAt: r.created_at,
  createdBy: r.created_by,
  rotatedAt: r.rotated_at,
  lastUsedAt: r.last_used_at,
  lastUsedIp: r.last_used_ip,
  expired: expired(r),
  creatorInactive: !creatorMayPush(r),
});

const secret = () => COST_PUSH_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
const prefixOf = (token: string) => token.slice(0, COST_PUSH_TOKEN_PREFIX.length + 6);

function manageable(platformId: string) {
  const s = requireScope('platform', platformId);
  if (!s.canManageSource)
    throw new HttpError(403, 'You are not allowed to manage the cost push tokens of this platform', 'PLATFORM_MANAGE_FORBIDDEN', { name: s.name });
  return s;
}

function tokenRow(platformId: string, tokenId: string): TokenRow {
  const r = db().get<TokenRow>('SELECT * FROM cost_push_tokens WHERE id = ? AND platform_id = ? AND revoked_at IS NULL', tokenId, platformId);
  if (!r) throw new HttpError(404, `Push token ${tokenId} not found`, 'COST_PUSH_TOKEN_NOT_FOUND', { id: tokenId });
  return r;
}

export function listPushTokens(platformId: string): CostPushToken[] {
  manageable(platformId);
  return db().all<TokenRow>('SELECT * FROM cost_push_tokens WHERE platform_id = ? AND revoked_at IS NULL ORDER BY created_at, id', platformId).map(toToken);
}

export function createPushToken(platformId: string, body: unknown): CostPushTokenCreated {
  const s = manageable(platformId);
  const input = costPushTokenInput.parse(body);
  const n = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM cost_push_tokens WHERE platform_id = ? AND revoked_at IS NULL', platformId)!.n);
  if (n >= COST_PUSH_LIMITS.tokensPerTarget)
    throw new HttpError(409, `At most ${COST_PUSH_LIMITS.tokensPerTarget} push tokens per platform`, 'COST_PUSH_TOKENS_FULL', {
      max: COST_PUSH_LIMITS.tokensPerTarget,
    });
  const cidrs = [...new Set(input.allowedCidrs.map((c) => c.trim()).filter(Boolean))];
  for (const c of cidrs) {
    try {
      parseCidr(c);
    } catch {
      throw new HttpError(400, `"${c}" is not an IP address or CIDR range`, 'COST_PUSH_CIDR', { value: c });
    }
  }
  const token = secret();
  const id = newId('cpt_');
  const actor = currentUser()?.username ?? 'system';
  const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString() : null;
  db().tx(() => {
    db().run(
      `INSERT INTO cost_push_tokens (id, platform_id, name, prefix, hash, allowed_cidrs, rate_limit_per_minute, expires_at, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      platformId,
      input.name,
      prefixOf(token),
      sha256(token),
      JSON.stringify(cidrs),
      input.rateLimitPerMinute,
      expiresAt,
      nowIso(),
      actor,
    );
    audit({
      action: 'cost.push_token_created',
      entityType: 'platform',
      entityId: platformId,
      summary: `Cost push token "${input.name}" created for "${s.name}"${expiresAt ? ` (expires ${expiresAt.slice(0, 10)})` : ''}`,
      details: { tokenId: id, name: input.name, expiresAt, allowedCidrs: cidrs, rateLimitPerMinute: input.rateLimitPerMinute },
    });
  });
  return { ...toToken(tokenRow(platformId, id)), token, path: costPushPath(platformId) };
}

export function rotatePushToken(platformId: string, tokenId: string): CostPushTokenCreated {
  const s = manageable(platformId);
  const r = tokenRow(platformId, tokenId);
  const token = secret();
  db().tx(() => {
    db().run('UPDATE cost_push_tokens SET hash = ?, prefix = ?, rotated_at = ? WHERE id = ?', sha256(token), prefixOf(token), nowIso(), r.id);
    audit({
      action: 'cost.push_token_rotated',
      entityType: 'platform',
      entityId: platformId,
      summary: `Cost push token "${r.name}" of "${s.name}" rotated (${r.prefix}… is no longer accepted)`,
      details: { tokenId: r.id, name: r.name, previousPrefix: r.prefix },
    });
  });
  return { ...toToken(tokenRow(platformId, tokenId)), token, path: costPushPath(platformId) };
}

export function revokePushToken(platformId: string, tokenId: string): void {
  const s = manageable(platformId);
  const r = tokenRow(platformId, tokenId);
  db().tx(() => {
    db().run('UPDATE cost_push_tokens SET revoked_at = ?, revoked_by = ? WHERE id = ?', nowIso(), currentUser()?.username ?? 'system', r.id);
    audit({
      action: 'cost.push_token_revoked',
      entityType: 'platform',
      entityId: platformId,
      summary: `Cost push token "${r.name}" of "${s.name}" revoked`,
      details: { tokenId: r.id, name: r.name, prefix: r.prefix },
    });
  });
}

// ---------- the push endpoint ----------

export interface PushHead {
  platformId: string;
  contentType: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  ip: string;
}
export interface PushResponse {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}
export type VerifiedPushToken = Pick<TokenRow, 'id' | 'name' | 'platform_id' | 'created_by'>;

const header = (h: PushHead['headers'], name: string): string | undefined => {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
};

/** One answer for every token that does not open this platform: unknown, revoked, expired, of another platform, another address. */
export const REFUSED: PushResponse = {
  status: 401,
  body: { error: 'Invalid push token for this platform', code: 'COST_PUSH_TOKEN_INVALID' },
  headers: { 'www-authenticate': 'Bearer realm="Steward cost push"' },
};

const calls = new Map<string, number[]>();
export function resetCostPushState(): void {
  calls.clear();
}

/**
 * Everything that needs only the headers: no session, a push token of this platform (not revoked, not expired, its
 * creator still active and allowed), an allowed address, the rate limit and a CSV (or text) content type. Runs before
 * the body is read.
 */
export function authorizePush(req: PushHead): { ok: true; token: VerifiedPushToken } | { ok: false; res: PushResponse } {
  const no = (res: PushResponse) => ({ ok: false as const, res });
  if (readCookie(header(req.headers, 'cookie'), SESSION_COOKIE) !== undefined)
    return no({
      status: 400,
      body: {
        error: 'Sign-in sessions are not accepted here – send a push token (Authorization: Bearer scp_…) without the session cookie',
        code: 'COST_PUSH_SESSION',
      },
    });
  const auth = (header(req.headers, 'authorization') ?? '').trim();
  const presented = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!presented || presented.includes(' '))
    return no({ ...REFUSED, body: { error: 'Send the push token as "Authorization: Bearer scp_…"', code: 'COST_PUSH_TOKEN_MISSING' } });
  if (!presented.startsWith(COST_PUSH_TOKEN_PREFIX))
    return no({
      status: 401,
      body: {
        error: 'This endpoint takes a cost push token (scp_…), not an API token – create one under Costs → the platform → Push from CI',
        code: 'COST_PUSH_API_TOKEN',
      },
      headers: REFUSED.headers,
    });
  if (presented.length > 200) return no(REFUSED);
  if (!vault().unlocked)
    return no({ status: 503, body: { error: 'The vault is locked – an administrator has to unlock it' }, headers: { 'retry-after': '60' } });
  const r = db().get<TokenRow>('SELECT * FROM cost_push_tokens WHERE hash = ?', sha256(presented));
  if (!r || r.revoked_at || expired(r) || r.platform_id !== req.platformId) return no(REFUSED);
  if (!creatorMayPush(r)) {
    logger.warn({ tokenId: r.id, createdBy: r.created_by }, 'cost push refused: the creator of the token is inactive or may no longer manage the platform');
    return no(REFUSED);
  }
  if (!addressAllowed(parseJson<string[]>(r.allowed_cidrs, []), req.ip)) {
    logger.warn({ tokenId: r.id, ip: req.ip }, 'cost push refused: address not allowed');
    return no(REFUSED);
  }
  const now = Date.now();
  const recent = (calls.get(r.id) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= Number(r.rate_limit_per_minute)) {
    calls.set(r.id, recent);
    return no({
      status: 429,
      body: { error: `More than ${r.rate_limit_per_minute} pushes a minute`, code: 'COST_PUSH_RATE' },
      headers: { 'retry-after': String(Math.max(1, Math.ceil((60_000 - (now - recent[0]!)) / 1000))) },
    });
  }
  recent.push(now);
  calls.set(r.id, recent);
  const ct = (req.contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (!['text/csv', 'text/plain', 'application/csv', 'application/octet-stream'].includes(ct))
    return no({ status: 415, body: { error: 'Send the FOCUS file as text/csv', code: 'COST_PUSH_TYPE' } });
  return { ok: true, token: { id: r.id, name: r.name, platform_id: r.platform_id, created_by: r.created_by } };
}

/** The import of a push whose token authorizePush accepted. `mode` and `fileName` come from the query string. */
export async function importPush(
  token: VerifiedPushToken,
  req: { raw: Buffer | undefined; ip: string; query: Record<string, unknown> },
): Promise<PushResponse> {
  const csv = (req.raw ?? Buffer.alloc(0)).toString('utf8');
  if (!csv.trim()) return { status: 400, body: { error: 'The body is empty – send the FOCUS CSV file', code: 'COST_IMPORT_EMPTY' } };
  const modeRaw = typeof req.query.mode === 'string' ? req.query.mode : 'replace';
  if (!(COST_IMPORT_MODES as readonly string[]).includes(modeRaw)) return { status: 400, body: { error: 'mode is replace or add', code: 'COST_IMPORT_MODE' } };
  const fileName = typeof req.query.fileName === 'string' ? req.query.fileName.slice(0, 200) : '';
  db().run('UPDATE cost_push_tokens SET last_used_at = ?, last_used_ip = ? WHERE id = ?', nowIso(), req.ip, token.id);
  try {
    // the token was checked above (its creator is active and may still manage the platform); no user is signed in –
    // the lines link with the creator's rights
    const creator = findUserByName(token.created_by);
    const out = await importFile(
      token.platform_id,
      { csv, fileName, mode: modeRaw as CostImportMode },
      { kind: 'push', tokenId: token.id, tokenName: token.name, ip: req.ip },
      `push token "${token.name}"`.slice(0, 120),
      creator ? toAuthUser(creator) : null,
    );
    return {
      status: 200,
      body: {
        import: out.import,
        inserted: out.result.inserted,
        replaced: out.result.removed,
        corrections: out.result.corrections,
        warnings: out.warnings,
      },
    };
  } catch (e) {
    if (e instanceof HttpError) return { status: e.statusCode, body: { error: e.message, ...(e.code ? { code: e.code } : {}) } };
    throw e;
  }
}
