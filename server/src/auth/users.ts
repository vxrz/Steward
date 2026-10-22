import crypto from 'node:crypto';
import { ROLES, type Role, type Team, type UserInfo } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { checkPasswordPolicy, hashPassword, temporaryPassword, verifyPassword } from './passwords.js';
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
    emailNotifications: false, // TODO(ops): stored per user
    roles: parseJson<Role[]>(r.roles, []),
    teams: teamsOf(r.id),
    active: !!r.active,
    mustChangePassword: !!r.must_change_password,
    lastLoginAt: r.last_login_at,
    createdAt: r.created_at,
    authSource: r.auth_source ?? 'local',
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

export function createUser(input: {
  username: string;
  displayName?: string;
  email?: string;
  roles: Role[];
  password?: string;
  mustChangePassword?: boolean;
}): { user: UserInfo; temporaryPassword?: string } {
  const username = input.username.trim();
  if (!USERNAME.test(username)) throw new HttpError(400, 'Username: 2–64 characters, letters, digits and . _ @ - only');
  if (findUserByName(username)) throw new HttpError(409, `User "${username}" already exists`);
  let password = input.password;
  let temp: string | undefined;
  if (!password) {
    password = temp = temporaryPassword();
  } else {
    const err = checkPasswordPolicy(password);
    if (err) throw new HttpError(400, err);
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
    audit({ action: 'user.created', entityType: 'user', entityId: id, summary: `User "${username}" created (${roles.join(', ') || 'no roles'})`, details: { roles } });
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

function ensureAnotherAdmin(exceptId: string): void {
  const admins = listUsers().filter((u) => u.active && u.roles.includes('admin') && u.id !== exceptId);
  if (!admins.length) throw new HttpError(409, 'At least one active administrator is required');
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

export function changePassword(id: string, current: string, next: string): void {
  const r = db().get<UserRow>('SELECT * FROM users WHERE id = ?', id);
  if (!r) throw new HttpError(404, 'User not found');
  if (r.auth_source !== 'local') throw new HttpError(400, 'This account signs in with single sign-on and has no password');
  if (!verifyPassword(current, r.password_hash)) throw new HttpError(400, 'Current password is wrong');
  const err = checkPasswordPolicy(next);
  if (err) throw new HttpError(400, err);
  if (current === next) throw new HttpError(400, 'Choose a new password');
  db().tx(() => {
    db().run('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?', hashPassword(next), nowIso(), id);
    audit({ action: 'user.password_changed', entityType: 'user', entityId: id, summary: `"${r.username}" changed their password` });
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

const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

export function login(username: string, password: string, meta: { ip?: string; userAgent?: string }): { token: string; user: UserInfo } {
  const key = `${username.toLowerCase()}|${meta.ip ?? ''}`;
  const f = failures.get(key);
  if (f && f.until > Date.now()) throw new HttpError(429, 'Too many failed attempts – try again in a few minutes');
  const r = db().get<UserRow>('SELECT * FROM users WHERE username = ?', username);
  // always run the hash to keep timing similar for unknown users
  const ok = r ? verifyPassword(password, r.password_hash) : (verifyPassword(password, hashPassword('x-dummy-password-1')), false);
  if (!r || !ok || !r.active) {
    const count = (f?.count ?? 0) + 1;
    failures.set(key, { count, until: count >= 5 ? Date.now() + 5 * 60000 : 0 });
    audit({
      actor: username,
      action: 'auth.login_failed',
      entityType: 'user',
      entityId: r?.id ?? null,
      summary: `Failed sign-in for "${username}"${r && !r.active ? ' (account disabled)' : ''}`,
      details: { ip: meta.ip },
    });
    throw new HttpError(401, 'Wrong user name or password');
  }
  failures.delete(key);
  const roles = parseJson<Role[]>(r.roles, []);
  if (getSettings().passwordLogin === 'adminsOnly' && !roles.includes('admin')) {
    throw new HttpError(403, 'Password sign-in is disabled – please use single sign-on');
  }
  const token = createSession(r.id, r.username, meta, 'password');
  return { token, user: toInfo(r) };
}

/** Create a session for an authenticated user and record the sign-in. Returns the cookie token. */
export function createSession(userId: string, username: string, meta: { ip?: string; userAgent?: string }, method: string): string {
  const token = crypto.randomBytes(32).toString('base64url');
  const ts = nowIso();
  db().tx(() => {
    db().run(
      'INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
      hashToken(token),
      userId,
      ts,
      new Date(Date.now() + SESSION_IDLE_MS).toISOString(),
      ts,
      meta.ip ?? null,
      meta.userAgent?.slice(0, 200) ?? null,
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
  return token;
}

export function sessionUser(token: string | undefined): UserInfo | null {
  if (!token) return null;
  const id = hashToken(token);
  const s = db().get<{ user_id: string; created_at: string; expires_at: string; last_seen_at: string }>('SELECT * FROM sessions WHERE id = ?', id);
  if (!s) return null;
  const now = Date.now();
  if (Date.parse(s.expires_at) < now || Date.parse(s.created_at) + SESSION_MAX_MS < now) {
    db().run('DELETE FROM sessions WHERE id = ?', id);
    return null;
  }
  const r = db().get<UserRow>('SELECT * FROM users WHERE id = ? AND active = 1', s.user_id);
  if (!r) return null;
  if (now - Date.parse(s.last_seen_at) > 60000) {
    db().run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', new Date(now).toISOString(), new Date(now + SESSION_IDLE_MS).toISOString(), id);
  }
  return toInfo(r);
}

export function logout(token: string | undefined): void {
  if (token) db().run('DELETE FROM sessions WHERE id = ?', hashToken(token));
}
