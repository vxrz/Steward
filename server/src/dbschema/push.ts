import crypto from 'node:crypto';
import {
  DB_SCHEMA_PUSH_LIMITS,
  DB_SCHEMA_PUSH_TOKEN_PREFIX,
  dbSchemaImportInput,
  dbSchemaPushPath,
  dbSchemaPushTokenInput,
  type DbSchemaPushToken,
  type DbSchemaPushTokenCreated,
  type DbSchemaSubjectKind,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { currentUser, runAs } from '../auth/context.js';
import { findUserByName, toAuthUser } from '../auth/users.js';
import { readCookie, SESSION_COOKIE } from '../auth/cookies.js';
import { forbid } from '../auth/access.js';
import { HttpError, newId, nowIso, parseJson, sha256 } from '../util.js';
import { addressAllowed, parseCidr } from '../triggers/service.js';
import { importFromPush, subjectOf } from './service.js';

/**
 * Push tokens of the tbls import from CI (#222, docs/DATABASES.md#tbls-from-ci), modelled on the secrets of heartbeat
 * checks and webhook triggers: a token belongs to one database platform or system and can do nothing but push its
 * schema.json (and the output of tbls lint) to POST /api/hooks/db-schema/<kind>/<id>. Only its SHA-256 is stored; the
 * secret is shown once. Created, rotated and revoked by who may manage the target; every change and every push is
 * audited. The endpoint takes no API token and no session.
 */

interface TokenRow {
  id: string;
  subject_kind: DbSchemaSubjectKind;
  subject_id: string;
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

const toToken = (r: TokenRow): DbSchemaPushToken => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  allowedCidrs: parseJson<string[]>(r.allowed_cidrs, []),
  rateLimitPerMinute: r.rate_limit_per_minute,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
  createdBy: r.created_by,
  rotatedAt: r.rotated_at,
  lastUsedAt: r.last_used_at,
  lastUsedIp: r.last_used_ip,
  expired: expired(r),
  creatorInactive: !creatorMayPush(r),
});

const secret = () => DB_SCHEMA_PUSH_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');

/** Who may manage the target (the platform's manage right, or who may change the system). */
function manageable(kind: DbSchemaSubjectKind, id: string) {
  const s = subjectOf(kind, id);
  if (!s.canImport) forbid('manage the push tokens of this schema', kind === 'platform' ? 'right_manage' : 'changeSystem');
  return s;
}

function tokenRow(kind: DbSchemaSubjectKind, id: string, tokenId: string): TokenRow {
  const r = db().get<TokenRow>(
    'SELECT * FROM db_schema_push_tokens WHERE id = ? AND subject_kind = ? AND subject_id = ? AND revoked_at IS NULL',
    tokenId,
    kind,
    id,
  );
  if (!r) throw new HttpError(404, `Push token ${tokenId} not found`, 'DB_SCHEMA_PUSH_TOKEN_NOT_FOUND', { id: tokenId });
  return r;
}

/** The active push tokens of a platform or system (never their secrets). */
export function listPushTokens(kind: DbSchemaSubjectKind, id: string): DbSchemaPushToken[] {
  manageable(kind, id);
  return db()
    .all<TokenRow>('SELECT * FROM db_schema_push_tokens WHERE subject_kind = ? AND subject_id = ? AND revoked_at IS NULL ORDER BY created_at, id', kind, id)
    .map(toToken);
}

function cidrsOf(list: string[]): string[] {
  const cidrs = [...new Set(list.map((c) => c.trim()).filter(Boolean))];
  for (const c of cidrs) {
    try {
      parseCidr(c);
    } catch {
      throw new HttpError(400, `"${c}" is not an IP address or CIDR range`, 'DB_SCHEMA_PUSH_CIDR', { value: c });
    }
  }
  return cidrs;
}

/** A new push token; its secret is in the answer only. */
export function createPushToken(kind: DbSchemaSubjectKind, id: string, body: unknown): DbSchemaPushTokenCreated {
  const s = manageable(kind, id);
  const input = dbSchemaPushTokenInput.parse(body);
  const n = db().get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM db_schema_push_tokens WHERE subject_kind = ? AND subject_id = ? AND revoked_at IS NULL',
    kind,
    id,
  )!.n;
  if (Number(n) >= DB_SCHEMA_PUSH_LIMITS.tokensPerTarget)
    throw new HttpError(409, `At most ${DB_SCHEMA_PUSH_LIMITS.tokensPerTarget} push tokens per database`, 'DB_SCHEMA_PUSH_TOKENS_FULL', {
      max: DB_SCHEMA_PUSH_LIMITS.tokensPerTarget,
    });
  const cidrs = cidrsOf(input.allowedCidrs);
  const token = secret();
  const tokenId = newId('dbpt_');
  const now = nowIso();
  const actor = currentUser()?.username ?? 'system';
  const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString() : null;
  db().tx(() => {
    db().run(
      `INSERT INTO db_schema_push_tokens (id, subject_kind, subject_id, name, prefix, hash, allowed_cidrs, rate_limit_per_minute, expires_at, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      tokenId,
      kind,
      id,
      input.name,
      token.slice(0, DB_SCHEMA_PUSH_TOKEN_PREFIX.length + 6),
      sha256(token),
      JSON.stringify(cidrs),
      input.rateLimitPerMinute,
      expiresAt,
      now,
      actor,
    );
    audit({
      action: 'dbschema.push_token_created',
      entityType: kind,
      entityId: id,
      summary: `Push token "${input.name}" created for the schema of "${s.name}"${expiresAt ? ` (expires ${expiresAt.slice(0, 10)})` : ''}`,
      details: { tokenId, name: input.name, expiresAt, allowedCidrs: cidrs, rateLimitPerMinute: input.rateLimitPerMinute },
    });
  });
  return { ...toToken(tokenRow(kind, id, tokenId)), token, path: dbSchemaPushPath(kind, id) };
}

/** A new secret for a token; the old one stops working at once. */
export function rotatePushToken(kind: DbSchemaSubjectKind, id: string, tokenId: string): DbSchemaPushTokenCreated {
  const s = manageable(kind, id);
  const r = tokenRow(kind, id, tokenId);
  const token = secret();
  db().tx(() => {
    db().run(
      'UPDATE db_schema_push_tokens SET hash = ?, prefix = ?, rotated_at = ? WHERE id = ?',
      sha256(token),
      token.slice(0, DB_SCHEMA_PUSH_TOKEN_PREFIX.length + 6),
      nowIso(),
      r.id,
    );
    audit({
      action: 'dbschema.push_token_rotated',
      entityType: kind,
      entityId: id,
      summary: `Push token "${r.name}" of the schema of "${s.name}" rotated (${r.prefix}… is no longer accepted)`,
      details: { tokenId: r.id, name: r.name, previousPrefix: r.prefix },
    });
  });
  return { ...toToken(tokenRow(kind, id, tokenId)), token, path: dbSchemaPushPath(kind, id) };
}

export function revokePushToken(kind: DbSchemaSubjectKind, id: string, tokenId: string): void {
  const s = manageable(kind, id);
  const r = tokenRow(kind, id, tokenId);
  db().tx(() => {
    db().run('UPDATE db_schema_push_tokens SET revoked_at = ?, revoked_by = ? WHERE id = ?', nowIso(), currentUser()?.username ?? 'system', r.id);
    audit({
      action: 'dbschema.push_token_revoked',
      entityType: kind,
      entityId: id,
      summary: `Push token "${r.name}" of the schema of "${s.name}" revoked`,
      details: { tokenId: r.id, name: r.name, prefix: r.prefix },
    });
  });
}

// ---------- the push endpoint ----------

export interface PushRequest {
  kind: string;
  id: string;
  raw: Buffer | undefined;
  contentType: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  ip: string;
}
export interface PushResponse {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

const header = (h: PushRequest['headers'], name: string): string | undefined => {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
};

/** One answer for every token that does not open this target: unknown, revoked, expired, of another target, another address. */
export const REFUSED: PushResponse = {
  status: 401,
  body: { error: 'Invalid push token for this database', code: 'DB_SCHEMA_PUSH_TOKEN_INVALID' },
  headers: { 'www-authenticate': 'Bearer realm="Steward schema push"' },
};

/** Accepted pushes per token (sliding minute). */
const calls = new Map<string, number[]>();
export function resetPushState(): void {
  calls.clear();
}

/** What is known of a push before its body is read: the target, the headers and the caller's address. */
export type PushHead = Omit<PushRequest, 'raw'>;
/** A push token that opens its target, as authorizePush found it. */
export type VerifiedPushToken = Pick<TokenRow, 'id' | 'name' | 'subject_kind' | 'subject_id'>;

/**
 * A push token works only while the person who created it is active and may still manage its target (the platform's
 * manage right, or the right to change the system) – like an API token, which stops with its owner.
 */
function creatorMayPush(r: Pick<TokenRow, 'created_by' | 'subject_kind' | 'subject_id'>): boolean {
  const u = findUserByName(r.created_by);
  if (!u || !u.active) return false;
  try {
    return runAs(toAuthUser(u), () => subjectOf(r.subject_kind, r.subject_id).canImport);
  } catch {
    return false; // the target is gone, or the creator may no longer see it
  }
}

/**
 * The part of a push that needs only its headers: no session, a push token of this target (not revoked, not expired,
 * its creator still active and allowed), an allowed address, the token's rate limit and a JSON content type. Runs in
 * the route's onRequest hook, before the body is read – a request without a valid token is refused without reading
 * up to 10 MB first. Every token that does not open the target gets the same 401.
 */
export function authorizePush(req: PushHead): { ok: true; token: VerifiedPushToken } | { ok: false; res: PushResponse } {
  const no = (res: PushResponse) => ({ ok: false as const, res });
  // a sign-in session goes nowhere here (other cookies, of a proxy for example, do not matter)
  if (readCookie(header(req.headers, 'cookie'), SESSION_COOKIE) !== undefined)
    return no({
      status: 400,
      body: {
        error: 'Sign-in sessions are not accepted here – send a push token (Authorization: Bearer sdbp_…) without the session cookie',
        code: 'DB_SCHEMA_PUSH_SESSION',
      },
    });
  const presented = /^Bearer\s+(\S+)\s*$/i.exec(header(req.headers, 'authorization') ?? '')?.[1];
  if (!presented) return no({ ...REFUSED, body: { error: 'Send the push token as "Authorization: Bearer sdbp_…"', code: 'DB_SCHEMA_PUSH_TOKEN_MISSING' } });
  if (!presented.startsWith(DB_SCHEMA_PUSH_TOKEN_PREFIX))
    return no({
      status: 401,
      body: {
        error: 'This endpoint takes a schema push token (sdbp_…), not an API token – create one under Schema → Push from CI',
        code: 'DB_SCHEMA_PUSH_API_TOKEN',
      },
      headers: REFUSED.headers,
    });
  if (presented.length > 200) return no(REFUSED);
  if (!vault().unlocked)
    return no({ status: 503, body: { error: 'The vault is locked – an administrator has to unlock it' }, headers: { 'retry-after': '60' } });
  const r = db().get<TokenRow>('SELECT * FROM db_schema_push_tokens WHERE hash = ?', sha256(presented));
  // a token of another target answers exactly like a wrong one
  if (!r || r.revoked_at || expired(r) || r.subject_kind !== req.kind || r.subject_id !== req.id) return no(REFUSED);
  if (!creatorMayPush(r)) {
    logger.warn({ tokenId: r.id, createdBy: r.created_by }, 'schema push refused: the creator of the token is inactive or may no longer manage the target');
    return no(REFUSED);
  }
  if (!addressAllowed(parseJson<string[]>(r.allowed_cidrs, []), req.ip)) {
    logger.warn({ tokenId: r.id, ip: req.ip }, 'schema push refused: address not allowed');
    return no(REFUSED);
  }
  const now = Date.now();
  const recent = (calls.get(r.id) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= r.rate_limit_per_minute) {
    calls.set(r.id, recent);
    const retry = Math.max(1, Math.ceil((60_000 - (now - recent[0]!)) / 1000));
    return no({
      status: 429,
      body: { error: `More than ${r.rate_limit_per_minute} pushes a minute`, code: 'DB_SCHEMA_PUSH_RATE' },
      headers: { 'retry-after': String(retry) },
    });
  }
  recent.push(now);
  calls.set(r.id, recent);
  const ct = req.contentType ?? '';
  if (!/^(application\/([a-z0-9.+-]*\+)?json|text\/plain)\s*(;|$)/i.test(ct.trim()))
    return no({ status: 415, body: { error: 'Send the schema as application/json', code: 'DB_SCHEMA_PUSH_TYPE' } });
  return { ok: true, token: { id: r.id, name: r.name, subject_kind: r.subject_kind, subject_id: r.subject_id } };
}

/** The import of a push whose token authorizePush accepted: the body read, the snapshot stored. */
export function importPush(token: VerifiedPushToken, req: Pick<PushRequest, 'raw' | 'ip'>): PushResponse {
  const raw = (req.raw ?? Buffer.alloc(0)).toString('utf8');
  if (!raw.trim()) return { status: 400, body: { error: 'The body is empty – send the tbls schema.json', code: 'DB_SCHEMA_TBLS_INVALID' } };
  db().run('UPDATE db_schema_push_tokens SET last_used_at = ?, last_used_ip = ? WHERE id = ?', nowIso(), req.ip, token.id);
  try {
    const out = importFromPush(token.subject_kind, token.subject_id, envelope(raw), { id: token.id, name: token.name, ip: req.ip });
    return { status: 200, body: { snapshot: out.snapshot, created: out.created, diff: out.diff, warnings: out.warnings } };
  } catch (e) {
    if (e instanceof HttpError) return { status: e.statusCode, body: { error: e.message, ...(e.code ? { code: e.code } : {}) } };
    if ((e as { name?: string }).name === 'ZodError') return { status: 400, body: { error: 'Not an import of a tbls schema', code: 'DB_SCHEMA_TBLS_INVALID' } };
    throw e;
  }
}

/**
 * POST /api/hooks/db-schema/<kind>/<id>: the push token of that target as "Authorization: Bearer sdbp_…" (nothing
 * else: an API token or a session is refused), the schema.json as it is or { schema, lint, fileName } as JSON. The
 * route runs authorizePush before the body is read and importPush after; this is both in one.
 */
export function handlePush(req: PushRequest): PushResponse {
  const a = authorizePush(req);
  return a.ok ? importPush(a.token, req) : a.res;
}

/** `{ "schema": "<text>", "lint": … }` around the file, or the file itself. */
export function envelope(raw: string): { schema: string; lint?: string; fileName?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    // not JSON: the tbls parser says so with its own message
    return { schema: raw };
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'schema' in parsed && !('tables' in parsed)) {
    const o = parsed as Record<string, unknown>;
    // the schema as a JSON object instead of its text: hashed as sent in this body
    const schema = o.schema && typeof o.schema === 'object' ? JSON.stringify(o.schema) : o.schema;
    const x = dbSchemaImportInput.safeParse({ schema, lint: o.lint, fileName: o.fileName });
    if (!x.success)
      throw new HttpError(400, `Not an import of a tbls schema: ${x.error.issues[0]!.path.join('.')} ${x.error.issues[0]!.message}`, 'DB_SCHEMA_TBLS_INVALID');
    return x.data;
  }
  return { schema: raw };
}
