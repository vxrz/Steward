import crypto from 'node:crypto';
import { BRAND, type UserInfo } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { canonicalJson, HttpError, newId, nowIso, sha256 } from '../util.js';
import { logger } from '../log.js';
import { vault, verifySignature } from '../vault.js';
import { createSession, getUser, listUsers, type CreatedSession } from './users.js';

/**
 * Emergency access (break-glass) when single sign-on fails and password sign-in is turned off.
 *
 * `steward admin emergency-access <admin>` runs on the server. It needs the data folder and the master
 * passphrase, creates a random one-time code and prints a sign-in link with it. Only the SHA-256 of the
 * code is stored, in `emergency_access_grants`, with a time window (default 60 minutes, at most 24 hours).
 * The running server accepts the code once, for that administrator, within the window – also while
 * password sign-in is off – and opens a session that is marked as emergency access: at most one hour,
 * a banner in the web app, every audit entry flagged, the other administrators notified.
 *
 * How the grant reaches the database:
 *   - Steward stopped: the command writes it directly (like `reset-password`).
 *   - Steward running: the command sends it to the server on the loopback interface, signed with the
 *     installation's Ed25519 key from the vault (which needs vault.json and the master passphrase). The
 *     server checks the signature with the public key in vault.json – this works while the vault is locked –
 *     that the request is fresh and bound to this server's instance id, and that it came over loopback
 *     without proxy headers. The code itself never crosses the wire, only its hash.
 */

export const EMERGENCY_DEFAULT_MINUTES = 60;
export const EMERGENCY_MAX_MINUTES = 24 * 60;
/** A signed request from the command line is accepted this long after it was made (clock skew included). */
export const SIGNED_REQUEST_MAX_AGE_MS = 2 * 60_000;
const PURPOSE = 'steward-emergency-access-v1';

export interface GrantRequest {
  username: string;
  minutes: number;
  /** Who ran the command: "cli:<os user>@<host>" */
  actor: string;
  /** SHA-256 (hex) of the one-time code */
  codeHash: string;
  /** How the grant was made (shown in the audit entry) */
  via: 'cli' | 'cli-running-server';
  nonce?: string;
}

export interface GrantInfo {
  id: string;
  username: string;
  expiresAt: string;
  minutes: number;
}

export const hashCode = (code: string): string => sha256(`emergency:${code}`);
export const newCode = (): string => crypto.randomBytes(32).toString('base64url');

function checkMinutes(minutes: number): number {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > EMERGENCY_MAX_MINUTES) {
    throw new HttpError(400, `The window must be 1 to ${EMERGENCY_MAX_MINUTES} minutes`, 'EMERGENCY_WINDOW_INVALID');
  }
  return minutes;
}

/** Opens an emergency access window for an active administrator (an older open window of the account is closed). */
export function createGrant(req: GrantRequest): GrantInfo {
  const minutes = checkMinutes(req.minutes);
  if (!/^[0-9a-f]{64}$/.test(req.codeHash)) throw new HttpError(400, 'Invalid code hash');
  const user = listUsers().find((u) => u.username.toLowerCase() === req.username.trim().toLowerCase());
  if (!user) throw new HttpError(404, `No account '${req.username}'`, 'EMERGENCY_UNKNOWN_ACCOUNT');
  if (!user.roles.includes('admin'))
    throw new HttpError(400, `'${user.username}' is not an administrator – emergency access is for administrators`, 'EMERGENCY_NOT_ADMIN');
  if (!user.active) throw new HttpError(400, `'${user.username}' is deactivated`, 'EMERGENCY_ACCOUNT_DISABLED');
  const id = newId('ega_');
  const created = nowIso();
  const expiresAt = new Date(Date.parse(created) + minutes * 60_000).toISOString();
  db().tx(() => {
    db().run('UPDATE emergency_access_grants SET revoked_at = ? WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL', created, user.id);
    db().run(
      'INSERT INTO emergency_access_grants (id, user_id, code_hash, nonce, issued_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      user.id,
      req.codeHash,
      req.nonce ?? null,
      req.actor.slice(0, 200),
      created,
      expiresAt,
    );
    audit({
      actor: req.actor,
      action: 'auth.emergency_access_granted',
      entityType: 'user',
      entityId: user.id,
      summary: `Emergency access for "${user.username}" granted on the server command line by ${req.actor} for ${minutes} minute(s) (until ${expiresAt})`,
      details: { grantId: id, username: user.username, minutes, expiresAt, via: req.via, authSource: user.authSource },
    });
  });
  return { id, username: user.username, expiresAt, minutes };
}

/** Open (unused, unexpired, not revoked) windows, per user id. */
export function openGrants(): Map<string, string> {
  const rows = db().all<{ user_id: string; expires_at: string }>(
    'SELECT user_id, expires_at FROM emergency_access_grants WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY expires_at',
    nowIso(),
  );
  return new Map(rows.map((r) => [r.user_id, r.expires_at]));
}

// ---------- sign-in with the code ----------

const failures: number[] = [];
const FAIL_WINDOW_MS = 15 * 60_000;
const FAIL_MAX = 20;

/**
 * Signs in with a one-time code. Wrong, used, expired or revoked codes all get the same answer. A valid code always
 * works (256 random bits cannot be guessed); refusals are audited up to FAIL_MAX per 15 minutes, so a flood of made-up
 * codes neither fills the audit log nor locks out the administrator who holds a real one.
 */
export function signInWithCode(code: string, meta: { ip?: string; userAgent?: string }): CreatedSession & { user: UserInfo } {
  const now = Date.now();
  while (failures.length && failures[0]! < now - FAIL_WINDOW_MS) failures.shift();
  const refuse = (reason: string, grant?: { id: string; user_id: string }): never => {
    if (failures.length < FAIL_MAX) {
      audit({
        actor: 'anonymous',
        action: 'auth.emergency_sign_in_failed',
        entityType: grant ? 'user' : 'auth',
        entityId: grant?.user_id ?? null,
        summary: `Emergency access sign-in refused: ${reason}`,
        details: { ip: meta.ip, grantId: grant?.id, reason },
      });
    } else {
      logger.warn({ security: true, ip: meta.ip, reason }, 'emergency access sign-in refused (not audited: too many in 15 minutes)');
    }
    if (failures.length < FAIL_MAX) failures.push(now); // bounded: only the count up to FAIL_MAX matters
    throw new HttpError(401, 'This emergency access link is invalid, used or expired – run the command on the server again', 'EMERGENCY_CODE_INVALID');
  };
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(code)) return refuse('malformed code');
  const g = db().get<{ id: string; user_id: string; expires_at: string; used_at: string | null; revoked_at: string | null; issued_by: string }>(
    'SELECT * FROM emergency_access_grants WHERE code_hash = ?',
    hashCode(code),
  );
  if (!g) return refuse('unknown code');
  if (g.used_at) return refuse('the code was used already', g);
  if (g.revoked_at) return refuse('the code was replaced by a newer one', g);
  if (Date.parse(g.expires_at) <= now) return refuse('the window has ended', g);
  const user = getUser(g.user_id);
  if (!user.active || !user.roles.includes('admin')) return refuse(`"${user.username}" is no longer an active administrator`, g);
  const ts = nowIso();
  const session = db().tx(() => {
    // single use, also against two requests at the same time
    const claimed = db().run(
      'UPDATE emergency_access_grants SET used_at = ?, used_ip = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL',
      ts,
      meta.ip ?? null,
      g.id,
    );
    if (claimed.changes !== 1) return null;
    const created = createSession(user.id, user.username, meta, 'emergency', { emergencyGrantId: g.id });
    audit({
      actor: user.username,
      action: 'auth.emergency_sign_in',
      entityType: 'user',
      entityId: user.id,
      summary: `${user.username} signed in with emergency access (granted by ${g.issued_by}); the session ends after one hour at the latest`,
      details: { grantId: g.id, ip: meta.ip, grantedBy: g.issued_by },
    });
    return created;
  });
  if (!session) return refuse('the code was used already', g);
  notifyAdmins(user, g.issued_by, meta.ip);
  return { ...session, user };
}

function notifyAdmins(user: UserInfo, grantedBy: string, ip: string | undefined): void {
  // loaded lazily: the notification service pulls in a lot (and the CLI never needs it)
  void import('../notifications/service.js')
    .then(({ notify }) => {
      const recipients = listUsers().filter((u) => u.active && u.roles.includes('admin') && u.id !== user.id);
      notify({
        event: 'security.emergency',
        recipients,
        text: () => ({
          title: `${BRAND.name}: emergency access used by ${user.username}`,
          body: `${user.displayName} (${user.username}) signed in with emergency access${ip ? ` from ${ip}` : ''}. The access was granted on the server command line by ${grantedBy}. If you did not expect this, check the audit log and the server.`,
        }),
        link: '/audit',
        inAppKey: `${user.id}:${Date.now()}`,
        externalKey: `${user.id}:${Date.now()}`,
        data: { username: user.username, grantedBy },
      });
    })
    .catch((err) => logger.warn({ err }, 'could not notify the administrators of an emergency sign-in'));
}

// ---------- signed requests from the command line while Steward is running ----------

export interface SignedGrant {
  v: 1;
  purpose: typeof PURPOSE;
  instanceId: string;
  username: string;
  minutes: number;
  codeHash: string;
  actor: string;
  issuedAt: string;
  nonce: string;
}

/** The exact bytes the command line signs. */
export const signedGrantPayload = (g: SignedGrant): string => `${PURPOSE}\n${canonicalJson(g)}`;

export function makeSignedGrant(input: Omit<SignedGrant, 'v' | 'purpose' | 'issuedAt' | 'nonce'>): { grant: SignedGrant; signature: string } {
  const grant: SignedGrant = { v: 1, purpose: PURPOSE, ...input, issuedAt: nowIso(), nonce: crypto.randomBytes(16).toString('hex') };
  return { grant, signature: vault().sign(signedGrantPayload(grant)) };
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * The running server's side: checks a grant signed on the command line. `remote`: the TCP peer address
 * (not req.ip, which may come from X-Forwarded-For); `forwarded`: the request carried proxy headers.
 */
export function acceptSignedGrant(
  body: { grant: SignedGrant; signature: string },
  ctx: { remote: string | undefined; forwarded: boolean; instanceId: string | undefined },
): GrantInfo {
  const deny = (why: string): never => {
    logger.warn({ security: true, reason: why, remote: ctx.remote }, 'emergency access request refused');
    throw new HttpError(403, 'Emergency access can only be granted on the server itself, with the master passphrase', 'EMERGENCY_REQUEST_REFUSED');
  };
  if (!ctx.remote || !LOOPBACK.has(ctx.remote) || ctx.forwarded) return deny('not a direct loopback request');
  const pub = vault().signingPublicKey();
  const g = body.grant;
  if (!pub || !g || g.v !== 1 || g.purpose !== PURPOSE) return deny('malformed request');
  if (!verifySignature(pub, signedGrantPayload(g), String(body.signature ?? ''))) return deny('bad signature');
  if (!ctx.instanceId || g.instanceId !== ctx.instanceId) return deny('made for another server instance');
  const age = Date.now() - Date.parse(g.issuedAt);
  if (!Number.isFinite(age) || Math.abs(age) > SIGNED_REQUEST_MAX_AGE_MS) return deny('too old (or the clocks differ)');
  if (!/^[0-9a-f]{32}$/.test(g.nonce) || db().get('SELECT 1 FROM emergency_access_grants WHERE nonce = ?', g.nonce)) return deny('replayed');
  if (!/^cli:[^\s]{1,190}$/.test(g.actor)) return deny('malformed actor');
  return createGrant({ username: g.username, minutes: g.minutes, actor: g.actor, codeHash: g.codeHash, via: 'cli-running-server', nonce: g.nonce });
}
