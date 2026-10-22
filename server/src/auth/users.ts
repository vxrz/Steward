import crypto from 'node:crypto';
import { ROLES, isLocale, type Locale, type Role, type Team, type UserInfo } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { checkPasswordPolicy, dummyHash, hashPassword, temporaryPassword, verifyPasswordAsync } from './passwords.js';
import { recordFailedLogin } from './login-audit.js';
import type { AuthUser } from './context.js';
import { getSettings } from '../settings.js';

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  password_hash: string;
  roles: string;
  active: number;
  must_change_password: number;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  auth_source: string;
  external_id: string | null;
  email_notifications?: number;
  locale?: string | null;
}

const USERNAME = /^[a-zA-Z0-9._@-]{2,64}$/;

function teamsOf(userId: string): string[] {
  return db()
    .all<{ name: string }>('SELECT t.name FROM teams t JOIN team_members m ON m.team_id = t.id WHERE m.user_id = ? ORDER BY t.name', userId)
    .map((r) => r.name);
}

function toInfo(r: UserRow): UserInfo {
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    email: r.email ?? undefined,
    emailNotifications: !!(r.email_notifications ?? 1),
    roles: parseJson<Role[]>(r.roles, []),
    teams: teamsOf(r.id),
    active: !!r.active,
    mustChangePassword: !!r.must_change_password,
    lastLoginAt: r.last_login_at,
    createdAt: r.created_at,
    authSource: r.auth_source ?? 'local',
    locale: isLocale(r.locale) ? r.locale : null,
  };
}

export function toAuthUser(u: UserInfo): AuthUser {
  return { id: u.id, username: u.username, displayName: u.displayName, roles: u.roles, teams: u.teams };
}

export function countUsers(): number {
  return db().get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n;
}

export function listUsers(): UserInfo[] {
  return db().all<UserRow>('SELECT * FROM users ORDER BY username').map(toInfo);
}

export function getUser(id: string): UserInfo {
  const r = db().get<UserRow>('SELECT * FROM users WHERE id = ?', id);
  if (!r) throw new HttpError(404, 'User not found');
  return toInfo(r);
}

export function findUserByName(username: string): UserInfo | undefined {
  const r = db().get<UserRow>('SELECT * FROM users WHERE username = ?', username);
  return r ? toInfo(r) : undefined;
}

function cleanRoles(roles: unknown): Role[] {
  const list = Array.isArray(roles) ? roles : [];
  return [...new Set(list.filter((r): r is Role => (ROLES as readonly string[]).includes(String(r))))];
}

export function createUser(input: { username: string; displayName?: string; email?: string; roles: Role[]; password?: string; mustChangePassword?: boolean }): {
  user: UserInfo;
  temporaryPassword?: string;
} {
  const username = input.username.trim();
  if (!USERNAME.test(username)) throw new HttpError(400, 'Username: 2–64 characters, letters, digits and . _ @ - only');
  if (findUserByName(username)) throw new HttpError(409, `User "${username}" already exists`);
  let password = input.password;
  let temp: string | undefined;
  if (!password) {
    password = temp = temporaryPassword();
  } else {
    const err = checkPasswordPolicy(password);
    if (err) throw new HttpError(400, err, 'PASSWORD_POLICY');
  }
  const id = newId('usr_');
  const ts = nowIso();
  const roles = cleanRoles(input.roles);
  db().tx(() => {
    db().run(
      `INSERT INTO users (id, username, display_name, email, password_hash, roles, active, must_change_password, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      id,
      username,
      input.displayName?.trim() || username,
      input.email ?? null,
      hashPassword(password),
      JSON.stringify(roles),
      temp || input.mustChangePassword ? 1 : 0,
      ts,
      ts,
    );
    audit({
      action: 'user.created',
      entityType: 'user',
      entityId: id,
      summary: `User "${username}" created (${roles.join(', ') || 'no roles'})`,
      details: { roles },
    });
  });
  return { user: getUser(id), temporaryPassword: temp };
}

export function updateUser(id: string, patch: { displayName?: string; email?: string; roles?: Role[]; active?: boolean }): UserInfo {
  const before = getUser(id);
  const roles = patch.roles ? cleanRoles(patch.roles) : before.roles;
  if (before.roles.includes('admin') && (!roles.includes('admin') || patch.active === false)) ensureAnotherAdmin(id);
  db().tx(() => {
    db().run(
      'UPDATE users SET display_name = ?, email = ?, roles = ?, active = ?, updated_at = ? WHERE id = ?',
      patch.displayName?.trim() || before.displayName,
      patch.email ?? before.email ?? null,
      JSON.stringify(roles),
      patch.active === undefined ? (before.active ? 1 : 0) : patch.active ? 1 : 0,
      nowIso(),
      id,
    );
    if (patch.active === false) db().run('DELETE FROM sessions WHERE user_id = ?', id);
    const changes: string[] = [];
    if (JSON.stringify(roles) !== JSON.stringify(before.roles)) changes.push(`roles ${before.roles.join(',') || '–'} → ${roles.join(',') || '–'}`);
    if (patch.active !== undefined && patch.active !== before.active) changes.push(patch.active ? 'activated' : 'deactivated');
    audit({
      action: 'user.updated',
      entityType: 'user',
      entityId: id,
      summary: `User "${before.username}" updated${changes.length ? `: ${changes.join('; ')}` : ''}`,
      details: { roles, active: patch.active },
    });
  });
  return getUser(id);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Changes a user makes to their own profile. Name and e-mail of single sign-on accounts come from the identity provider. */
export function updateProfile(id: string, patch: { displayName?: string; email?: string; emailNotifications?: boolean; locale?: Locale | null }): UserInfo {
  const before = getUser(id);
  const sso = before.authSource !== 'local';
  const displayName = patch.displayName?.trim();
  const email = patch.email === undefined ? undefined : patch.email.trim();
  if (sso && ((displayName !== undefined && displayName !== before.displayName) || (email !== undefined && email !== (before.email ?? '')))) {
    throw new HttpError(400, 'Name and e-mail of this account are managed by single sign-on', 'SSO_MANAGED_PROFILE');
  }
  if (displayName !== undefined && (!displayName || displayName.length > 100)) throw new HttpError(400, 'Display name: 1–100 characters');
  if (email && !EMAIL.test(email)) throw new HttpError(400, 'Enter a valid e-mail address', 'INVALID_EMAIL');
  if (patch.locale !== undefined && patch.locale !== null && !isLocale(patch.locale))
    throw new HttpError(400, `Unsupported language "${patch.locale}"`, 'UNSUPPORTED_LOCALE');
  const changes: string[] = [];
  if (displayName !== undefined && displayName !== before.displayName) changes.push('name');
  if (email !== undefined && email !== (before.email ?? '')) changes.push('e-mail');
  if (patch.emailNotifications !== undefined && patch.emailNotifications !== before.emailNotifications) {
    changes.push(`e-mail notifications ${patch.emailNotifications ? 'on' : 'off'}`);
  }
  if (patch.locale !== undefined && patch.locale !== before.locale) changes.push(`language ${patch.locale ?? 'default'}`);
  if (!changes.length) return before;
  db().tx(() => {
    db().run(
      'UPDATE users SET display_name = ?, email = ?, email_notifications = ?, locale = ?, updated_at = ? WHERE id = ?',
      displayName ?? before.displayName,
      email === undefined ? (before.email ?? null) : email || null,
      (patch.emailNotifications ?? before.emailNotifications) ? 1 : 0,
      patch.locale === undefined ? before.locale : patch.locale,
      nowIso(),
      id,
    );
    audit({ action: 'user.profile_updated', entityType: 'user', entityId: id, summary: `${before.username} updated their profile: ${changes.join(', ')}` });
  });
  return getUser(id);
}

function ensureAnotherAdmin(exceptId: string): void {
  const admins = listUsers().filter((u) => u.active && u.roles.includes('admin') && u.id !== exceptId);
  if (!admins.length) throw new HttpError(409, 'At least one active administrator is required', 'LAST_ADMIN');
}

export function resetPassword(id: string): string {
  const u = getUser(id);
  if (u.authSource !== 'local') throw new HttpError(400, 'This account signs in with single sign-on and has no password');
  const temp = temporaryPassword();
  db().tx(() => {
    db().run('UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?', hashPassword(temp), nowIso(), id);
    db().run('DELETE FROM sessions WHERE user_id = ?', id);
    audit({ action: 'user.password_reset', entityType: 'user', entityId: id, summary: `Password of "${u.username}" reset by an administrator` });
  });
  return temp;
}

/** Changes the own password and signs out all other sessions of the user (keepSession: the current session cookie). */
export async function changePassword(id: string, current: string, next: string, keepSession?: string): Promise<void> {
  const r = db().get<UserRow>('SELECT * FROM users WHERE id = ?', id);
  if (!r) throw new HttpError(404, 'User not found');
  if (r.auth_source !== 'local') throw new HttpError(400, 'This account signs in with single sign-on and has no password');
  if (!(await verifyPasswordAsync(current, r.password_hash))) throw new HttpError(400, 'Current password is wrong', 'WRONG_CURRENT_PASSWORD');
  const err = checkPasswordPolicy(next);
  if (err) throw new HttpError(400, err, 'PASSWORD_POLICY');
  if (current === next) throw new HttpError(400, 'Choose a new password', 'SAME_PASSWORD');
  db().tx(() => {
    db().run('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?', hashPassword(next), nowIso(), id);
    const signedOut = db().run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', id, keepSession ? hashToken(keepSession) : '').changes;
    audit({
      action: 'user.password_changed',
      entityType: 'user',
      entityId: id,
      summary: `"${r.username}" changed their password${signedOut ? ` – ${signedOut} other session(s) signed out` : ''}`,
    });
  });
}

// ---------- Teams ----------

export function listTeams(): Team[] {
  return db()
    .all<{ id: string; name: string; description: string; created_at: string }>('SELECT * FROM teams ORDER BY name')
    .map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      createdAt: t.created_at,
      members: db()
        .all<{ username: string }>('SELECT u.username FROM users u JOIN team_members m ON m.user_id = u.id WHERE m.team_id = ? ORDER BY u.username', t.id)
        .map((m) => m.username),
    }));
}

export function saveTeam(input: { name: string; description?: string; members?: string[] }, id?: string): Team {
  const name = input.name.trim();
  if (!/^[\w .@-]{2,64}$/.test(name)) throw new HttpError(400, 'Team name: 2–64 characters');
  const tid = id ?? newId('team_');
  const memberIds = (input.members ?? []).map((m) => {
    const u = findUserByName(m);
    if (!u) throw new HttpError(400, `Unknown user "${m}"`);
    return u.id;
  });
  db().tx(() => {
    if (id) {
      const r = db().run('UPDATE teams SET name = ?, description = ? WHERE id = ?', name, input.description ?? '', id);
      if (!r.changes) throw new HttpError(404, 'Team not found');
    } else {
      if (db().get('SELECT 1 FROM teams WHERE name = ?', name)) throw new HttpError(409, `Team "${name}" exists`);
      db().run('INSERT INTO teams (id, name, description, created_at) VALUES (?, ?, ?, ?)', tid, name, input.description ?? '', nowIso());
    }
    if (input.members) {
      db().run('DELETE FROM team_members WHERE team_id = ?', tid);
      for (const uid of memberIds) db().run('INSERT INTO team_members (team_id, user_id) VALUES (?, ?)', tid, uid);
    }
    audit({
      action: id ? 'team.updated' : 'team.created',
      entityType: 'team',
      entityId: tid,
      summary: `Team "${name}" ${id ? 'updated' : 'created'}${input.members ? ` (${input.members.length} members)` : ''}`,
      details: { members: input.members },
    });
  });
  return listTeams().find((t) => t.id === tid)!;
}

export function deleteTeam(id: string): void {
  const t = listTeams().find((x) => x.id === id);
  if (!t) throw new HttpError(404, 'Team not found');
  db().tx(() => {
    db().run('DELETE FROM teams WHERE id = ?', id);
    audit({ action: 'team.deleted', entityType: 'team', entityId: id, summary: `Team "${t.name}" deleted` });
  });
}

// ---------- Login & sessions ----------

const SESSION_IDLE_MS = 12 * 3600 * 1000;
const SESSION_MAX_MS = 7 * 86400 * 1000;
const failures = new Map<string, { count: number; until: number }>();
/** Failed sign-ins per account across all source addresses (sliding 15-minute window). */
const accountFailures = new Map<string, number[]>();
/** Failed sign-ins per source address across all accounts (password spraying). */
const addressFailures = new Map<string, number[]>();
const WINDOW_MS = 15 * 60000;
const ACCOUNT_MAX_FAILURES = 20;
const ADDRESS_MAX_FAILURES = 50;
const MAX_TRACKED = 10000;

const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

function recent(map: Map<string, number[]>, key: string): number[] {
  return (map.get(key) ?? []).filter((t) => t > Date.now() - WINDOW_MS);
}
function remember(map: Map<string, number[]>, key: string, list: number[]): void {
  if (map.size >= MAX_TRACKED && !map.has(key)) map.delete(map.keys().next().value!); // bounded memory
  map.set(key, [...list, Date.now()]);
}

/** What the browser needs besides the cookie (see sessionBinding): the session key and the key for links. */
export interface SessionKeys {
  /** Sent as x-sm-session on every API request */
  sessionKey: string;
  /** Appended as ?_sk= to download links and images (GET only) */
  linkKey: string;
}

export interface CreatedSession extends SessionKeys {
  token: string;
}

export async function login(username: string, password: string, meta: { ip?: string; userAgent?: string }): Promise<CreatedSession & { user: UserInfo }> {
  const key = `${username.toLowerCase()}|${meta.ip ?? ''}`;
  const f = failures.get(key);
  if (f && f.until > Date.now()) throw new HttpError(429, 'Too many failed attempts – try again in a few minutes', 'TOO_MANY_ATTEMPTS');
  const account = username.toLowerCase();
  const byAccount = recent(accountFailures, account);
  if (byAccount.length >= ACCOUNT_MAX_FAILURES)
    throw new HttpError(429, 'Too many failed attempts for this account – try again in a few minutes', 'TOO_MANY_ATTEMPTS');
  const address = meta.ip ?? '';
  const byAddress = recent(addressFailures, address);
  if (byAddress.length >= ADDRESS_MAX_FAILURES)
    throw new HttpError(429, 'Too many failed attempts from this address – try again in a few minutes', 'TOO_MANY_ATTEMPTS');
  const r = db().get<UserRow>('SELECT * FROM users WHERE username = ?', username);
  // One hash per attempt for known and unknown user names alike (same timing; the dummy hash is computed once).
  const ok = await verifyPasswordAsync(password, r?.password_hash && r.password_hash.startsWith('scrypt$') ? r.password_hash : dummyHash());
  if (!r || !ok || !r.active) {
    const count = (f?.count ?? 0) + 1;
    if (failures.size >= MAX_TRACKED && !failures.has(key)) failures.delete(failures.keys().next().value!);
    failures.set(key, { count, until: count >= 5 ? Date.now() + 5 * 60000 : 0 });
    remember(accountFailures, account, byAccount);
    remember(addressFailures, address, byAddress);
    recordFailedLogin({ username, account: r ? { id: r.id, username: r.username, disabled: !r.active } : null, ip: meta.ip });
    throw new HttpError(401, 'Wrong user name or password', 'WRONG_CREDENTIALS');
  }
  failures.delete(key);
  accountFailures.delete(account);
  const roles = parseJson<Role[]>(r.roles, []);
  if (getSettings().passwordLogin === 'adminsOnly' && !roles.includes('admin')) {
    throw new HttpError(403, 'Password sign-in is disabled – please use single sign-on', 'PASSWORD_LOGIN_DISABLED');
  }
  const session = createSession(r.id, r.username, meta, 'password');
  return { ...session, user: toInfo(r) };
}

/** The link key belonging to a binding (derived, so it needs no storage of its own). */
const linkKeyOf = (binding: string) => crypto.createHmac('sha256', Buffer.from(binding, 'hex')).update('steward-link-v1').digest('base64url');

/** Create a session for an authenticated user and record the sign-in. Returns the cookie token and the binding keys. */
export function createSession(userId: string, username: string, meta: { ip?: string; userAgent?: string }, method: string): CreatedSession {
  const token = crypto.randomBytes(32).toString('base64url');
  const sessionKey = crypto.randomBytes(32).toString('base64url');
  const binding = hashToken(sessionKey);
  const ts = nowIso();
  db().tx(() => {
    db().run(
      'INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, ip, user_agent, binding) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      hashToken(token),
      userId,
      ts,
      new Date(Date.now() + SESSION_IDLE_MS).toISOString(),
      ts,
      meta.ip ?? null,
      meta.userAgent?.slice(0, 200) ?? null,
      binding,
    );
    db().run('UPDATE users SET last_login_at = ? WHERE id = ?', ts, userId);
    db().run('DELETE FROM sessions WHERE expires_at < ?', ts);
    audit({
      actor: username,
      action: 'auth.login',
      entityType: 'user',
      entityId: userId,
      summary: `${username} signed in${method === 'password' ? '' : ` via ${method}`}`,
      details: { ip: meta.ip, method },
    });
  });
  return { token, sessionKey, linkKey: linkKeyOf(binding) };
}

/**
 * Proof that the request comes from the web app's origin, not just from someone holding the cookie.
 * Browsers send cookies to every port of a host, so another local program on 127.0.0.1:<other port>
 * can receive the session cookie – but not the session key, which lives in the app origin's
 * localStorage (scheme + host + port). `key` is the x-sm-session header; `link` the ?_sk= parameter
 * of download links and images (accepted for GET/HEAD only). `skip`: only for the API documentation.
 */
export type SessionBinding = { key?: string; link?: string; read: boolean } | 'skip';

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function bindingMatches(stored: string | null, b: SessionBinding): boolean {
  if (b === 'skip') return true;
  if (!stored) return false; // sessions from before session binding: sign in again
  if (b.key) return safeEqual(hashToken(b.key), stored);
  if (b.link && b.read) return safeEqual(b.link, linkKeyOf(stored));
  return false;
}

export function sessionUser(token: string | undefined, binding: SessionBinding): UserInfo | null {
  if (!token) return null;
  const id = hashToken(token);
  const s = db().get<{ user_id: string; created_at: string; expires_at: string; last_seen_at: string; binding: string | null }>(
    'SELECT * FROM sessions WHERE id = ?',
    id,
  );
  if (!s) return null;
  const now = Date.now();
  if (Date.parse(s.expires_at) < now || Date.parse(s.created_at) + SESSION_MAX_MS < now) {
    db().run('DELETE FROM sessions WHERE id = ?', id);
    return null;
  }
  if (!bindingMatches(s.binding, binding)) return null;
  const r = db().get<UserRow>('SELECT * FROM users WHERE id = ? AND active = 1', s.user_id);
  if (!r) return null;
  if (now - Date.parse(s.last_seen_at) > 60000) {
    db().run(
      'UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?',
      new Date(now).toISOString(),
      new Date(now + SESSION_IDLE_MS).toISOString(),
      id,
    );
  }
  return toInfo(r);
}

export function logout(token: string | undefined): void {
  if (token) db().run('DELETE FROM sessions WHERE id = ?', hashToken(token));
}
