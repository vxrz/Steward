import crypto from 'node:crypto';
import {
  DEFAULT_SSO_SYNC,
  ROLES,
  SSO_SYNCED_FIELDS,
  isLocale,
  type Locale,
  type Role,
  type SsoSyncRules,
  type Team,
  type UserInfo,
  type UserProfileValue,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { checkPasswordPolicy, dummyHash, hashPassword, temporaryPassword, verifyPasswordAsync } from './passwords.js';
import { recordFailedLogin } from './login-audit.js';
import type { AuthUser, SessionMeta } from './context.js';
import { passwordLoginMode } from '../settings.js';
import { config } from '../config.js';
import { aliasTarget, invalidateAliases, teamAliasTarget } from './aliases.js';
import { rewriteTeamReferences } from './subjects.js';

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
  first_name?: string | null;
  last_name?: string | null;
  profile?: string | null;
}

const USERNAME = /^[a-zA-Z0-9._@-]{2,64}$/;

function teamsOf(userId: string): string[] {
  return db()
    .all<{ name: string }>('SELECT t.name FROM teams t JOIN team_members m ON m.team_id = t.id WHERE m.user_id = ? ORDER BY t.name', userId)
    .map((r) => r.name);
}

function toInfo(r: UserRow, managed: (authSource: string) => UserInfo['managedFields'] = managedFields): UserInfo {
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
    ...(r.first_name ? { firstName: r.first_name } : {}),
    ...(r.last_name ? { lastName: r.last_name } : {}),
    profile: profileOf(r.profile),
    managedFields: managed(r.auth_source ?? 'local'),
  };
}

function profileOf(json: string | null | undefined): UserProfileValue[] {
  const list = parseJson<unknown>(json ?? null, []);
  if (!Array.isArray(list)) return [];
  return list
    .filter((x): x is UserProfileValue => !!x && typeof x === 'object' && typeof x.key === 'string' && typeof x.value === 'string')
    .slice(0, 50)
    .map((x) => ({ key: x.key, label: typeof x.label === 'string' ? x.label : x.key, value: x.value }));
}

/**
 * Fields the single sign-on provider of an account updates at every sign-in (sync rule "always"): not editable in
 * Steward. An account whose provider was deleted keeps them read-only (as before the sync rules existed).
 */
export function managedFields(authSource: string): UserInfo['managedFields'] {
  if (authSource === 'local') return [];
  const row = db().get<{ config: string }>('SELECT config FROM identity_providers WHERE id = ?', authSource);
  const sync: SsoSyncRules = { ...DEFAULT_SSO_SYNC, ...(row ? parseJson<{ sync?: Partial<SsoSyncRules> }>(row.config, {}).sync : {}) };
  return SSO_SYNCED_FIELDS.filter((f) => sync[f] !== 'create');
}

/** Refuses a change of a field the account's single sign-on provider keeps up to date. */
function requireUnmanaged(before: UserInfo, changed: Partial<Record<UserInfo['managedFields'][number], boolean>>): void {
  const blocked = before.managedFields.filter((f) => changed[f]);
  if (blocked.length) {
    throw new HttpError(400, `${blocked.join(', ')} of this account are managed by single sign-on`, 'SSO_MANAGED_PROFILE', { fields: blocked });
  }
}

const NAME_MAX = 100;
const cleanName = (v: string | undefined): string | null | undefined => {
  if (v === undefined) return undefined;
  const s = v.trim();
  if (s.length > NAME_MAX) throw new HttpError(400, `Names: at most ${NAME_MAX} characters`);
  return s || null;
};

/** A signed-in user as sessionUser returns it: the account plus how the session was opened. */
export type SessionInfo = UserInfo & { emergency?: AuthUser['emergency']; session?: SessionMeta };

export function toAuthUser(u: UserInfo | SessionInfo): AuthUser {
  const out: AuthUser = { id: u.id, username: u.username, displayName: u.displayName, roles: u.roles, teams: u.teams };
  const emergency = (u as SessionInfo).emergency;
  if (emergency) out.emergency = emergency;
  const session = (u as SessionInfo).session;
  if (session) out.session = session;
  return out;
}

/** Password sign-in, password resets and new passwords are refused while it is turned off (Settings → Sign-in, SM_PASSWORD_LOGIN). */
export function requirePasswordLogin(what: string): void {
  if (passwordLoginMode() === 'none') {
    throw new HttpError(409, `Password sign-in is turned off (single sign-on only) – ${what} is not possible`, 'PASSWORD_LOGIN_OFF', { what });
  }
}

/** Password hash of accounts without a password (never matches: verifyPassword needs "scrypt$…"); linked on the first single sign-on. */
export const NO_PASSWORD = '!none';

export function countUsers(): number {
  return db().get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n;
}

export function listUsers(): UserInfo[] {
  // the sync rules once per provider, not once per account
  const perProvider = new Map<string, UserInfo['managedFields']>();
  const managed = (source: string) => {
    if (!perProvider.has(source)) perProvider.set(source, managedFields(source));
    return perProvider.get(source)!;
  };
  return db()
    .all<UserRow>('SELECT * FROM users ORDER BY username')
    .map((r) => toInfo(r, managed));
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
  firstName?: string;
  lastName?: string;
  email?: string;
  roles: Role[];
  password?: string;
  mustChangePassword?: boolean;
  /** No password at all: the account signs in with single sign-on (linked by its user name at the first sign-in) */
  noPassword?: boolean;
  /** With noPassword: the single sign-on provider (id) that may claim the account – no other provider can */
  provider?: string;
}): {
  user: UserInfo;
  temporaryPassword?: string;
} {
  const username = input.username.trim();
  if (!USERNAME.test(username)) throw new HttpError(400, 'Username: 2–64 characters, letters, digits and . _ @ - only');
  if (findUserByName(username)) throw new HttpError(409, `User "${username}" already exists`);
  // a former name of an imported account still stands for that account in imported content (aliases.ts)
  if (aliasTarget(username)) throw new HttpError(409, `"${username}" is the former name of an imported account`, 'USERNAME_IS_ALIAS', { username });
  let password = input.password;
  let temp: string | undefined;
  if (input.noPassword) {
    if (password) throw new HttpError(400, 'An account without a password cannot have a password', 'PASSWORD_LOGIN_OFF');
  } else if (!password) {
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
      `INSERT INTO users (id, username, display_name, first_name, last_name, email, password_hash, roles, active, must_change_password, created_at, updated_at, auth_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      id,
      username,
      input.displayName?.trim() || username,
      cleanName(input.firstName) ?? null,
      cleanName(input.lastName) ?? null,
      input.email ?? null,
      input.noPassword ? NO_PASSWORD : hashPassword(password!),
      JSON.stringify(roles),
      !input.noPassword && (temp || input.mustChangePassword) ? 1 : 0,
      ts,
      ts,
      input.noPassword && input.provider ? input.provider : 'local',
    );
    audit({
      action: 'user.created',
      entityType: 'user',
      entityId: id,
      summary: `User "${username}" created (${roles.join(', ') || 'no roles'})${input.noPassword ? ` without a password (single sign-on${input.provider ? ` via ${input.provider}` : ''})` : ''}`,
      details: { roles, ...(input.noPassword ? { password: false, provider: input.provider ?? null } : {}) },
    });
  });
  return { user: getUser(id), temporaryPassword: temp };
}

export function updateUser(
  id: string,
  patch: { displayName?: string; firstName?: string; lastName?: string; email?: string; roles?: Role[]; active?: boolean },
): UserInfo {
  const before = getUser(id);
  const roles = patch.roles ? cleanRoles(patch.roles) : before.roles;
  if (before.roles.includes('admin') && (!roles.includes('admin') || patch.active === false)) ensureAnotherAdmin(id);
  const firstName = cleanName(patch.firstName);
  const lastName = cleanName(patch.lastName);
  const displayName = patch.displayName?.trim() || before.displayName;
  const email = patch.email ?? before.email ?? null;
  requireUnmanaged(before, {
    displayName: displayName !== before.displayName,
    firstName: firstName !== undefined && firstName !== (before.firstName ?? null),
    lastName: lastName !== undefined && lastName !== (before.lastName ?? null),
    email: (email ?? '') !== (before.email ?? ''),
  });
  db().tx(() => {
    db().run(
      'UPDATE users SET display_name = ?, first_name = ?, last_name = ?, email = ?, roles = ?, active = ?, updated_at = ? WHERE id = ?',
      displayName,
      firstName === undefined ? (before.firstName ?? null) : firstName,
      lastName === undefined ? (before.lastName ?? null) : lastName,
      email,
      JSON.stringify(roles),
      patch.active === undefined ? (before.active ? 1 : 0) : patch.active ? 1 : 0,
      nowIso(),
      id,
    );
    if (patch.active === false) db().run('DELETE FROM sessions WHERE user_id = ?', id);
    const changes: string[] = [];
    if (JSON.stringify(roles) !== JSON.stringify(before.roles)) changes.push(`roles ${before.roles.join(',') || '–'} → ${roles.join(',') || '–'}`);
    if (patch.active !== undefined && patch.active !== before.active) changes.push(patch.active ? 'activated' : 'deactivated');
    if (displayName !== before.displayName) changes.push('display name');
    if (firstName !== undefined && firstName !== (before.firstName ?? null)) changes.push('first name');
    if (lastName !== undefined && lastName !== (before.lastName ?? null)) changes.push('last name');
    if ((email ?? '') !== (before.email ?? '')) changes.push('e-mail');
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

/**
 * Changes a user makes to their own profile. Name and e-mail of single sign-on accounts come from the identity provider
 * unless its sync rule for the field is "only when the account is created".
 */
export function updateProfile(
  id: string,
  patch: { displayName?: string; firstName?: string; lastName?: string; email?: string; emailNotifications?: boolean; locale?: Locale | null },
): UserInfo {
  const before = getUser(id);
  const displayName = patch.displayName?.trim();
  const email = patch.email === undefined ? undefined : patch.email.trim();
  const firstName = cleanName(patch.firstName);
  const lastName = cleanName(patch.lastName);
  requireUnmanaged(before, {
    displayName: displayName !== undefined && displayName !== before.displayName,
    email: email !== undefined && email !== (before.email ?? ''),
    firstName: firstName !== undefined && firstName !== (before.firstName ?? null),
    lastName: lastName !== undefined && lastName !== (before.lastName ?? null),
  });
  if (displayName !== undefined && (!displayName || displayName.length > 100)) throw new HttpError(400, 'Display name: 1–100 characters');
  if (email && !EMAIL.test(email)) throw new HttpError(400, 'Enter a valid e-mail address', 'INVALID_EMAIL');
  if (patch.locale !== undefined && patch.locale !== null && !isLocale(patch.locale))
    throw new HttpError(400, `Unsupported language "${patch.locale}"`, 'UNSUPPORTED_LOCALE');
  const changes: string[] = [];
  if (displayName !== undefined && displayName !== before.displayName) changes.push('name');
  if (firstName !== undefined && firstName !== (before.firstName ?? null)) changes.push('first name');
  if (lastName !== undefined && lastName !== (before.lastName ?? null)) changes.push('last name');
  if (email !== undefined && email !== (before.email ?? '')) changes.push('e-mail');
  if (patch.emailNotifications !== undefined && patch.emailNotifications !== before.emailNotifications) {
    changes.push(`e-mail notifications ${patch.emailNotifications ? 'on' : 'off'}`);
  }
  if (patch.locale !== undefined && patch.locale !== before.locale) changes.push(`language ${patch.locale ?? 'default'}`);
  if (!changes.length) return before;
  db().tx(() => {
    db().run(
      'UPDATE users SET display_name = ?, first_name = ?, last_name = ?, email = ?, email_notifications = ?, locale = ?, updated_at = ? WHERE id = ?',
      displayName ?? before.displayName,
      firstName === undefined ? (before.firstName ?? null) : firstName,
      lastName === undefined ? (before.lastName ?? null) : lastName,
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

/**
 * Binds a local account to a single sign-on provider (an administrator's decision): the password is removed, its
 * sessions end, and only that provider can claim the account at the next sign-in (by its user name).
 */
export function bindToProvider(id: string, providerId: string, providerName: string): UserInfo {
  const u = getUser(id);
  if (u.authSource !== 'local') throw new HttpError(409, 'This account signs in with single sign-on already', 'SSO_ALREADY_BOUND');
  db().tx(() => {
    db().run(
      'UPDATE users SET auth_source = ?, external_id = NULL, password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?',
      providerId,
      NO_PASSWORD,
      nowIso(),
      id,
    );
    db().run('DELETE FROM sessions WHERE user_id = ?', id);
    audit({
      action: 'user.sso_bound',
      entityType: 'user',
      entityId: id,
      summary: `"${u.username}" now signs in with ${providerName} (password removed, sessions ended)`,
      details: { provider: providerId },
    });
  });
  return getUser(id);
}

export function resetPassword(id: string): string {
  const u = getUser(id);
  if (u.authSource !== 'local') throw new HttpError(400, 'This account signs in with single sign-on and has no password');
  requirePasswordLogin('resetting a password');
  const temp = temporaryPassword();
  db().tx(() => {
    db().run('UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?', hashPassword(temp), nowIso(), id);
    db().run('DELETE FROM sessions WHERE user_id = ?', id);
    audit({ action: 'user.password_reset', entityType: 'user', entityId: id, summary: `Password of "${u.username}" reset by an administrator` });
  });
  return temp;
}

/**
 * Recovery on the server (`steward admin reset-password`): a one-time password for a local account,
 * optionally reactivating it. The caller has unlocked the vault with the master passphrase.
 */
export function recoverAccount(id: string, opts: { actor: string; activate?: boolean }): string {
  const u = getUser(id);
  if (u.authSource !== 'local') throw new HttpError(400, 'This account signs in with single sign-on and has no password');
  const temp = temporaryPassword();
  const reactivate = !u.active && !!opts.activate;
  db().tx(() => {
    db().run(
      `UPDATE users SET password_hash = ?, must_change_password = 1${reactivate ? ', active = 1' : ''}, updated_at = ? WHERE id = ?`,
      hashPassword(temp),
      nowIso(),
      id,
    );
    db().run('DELETE FROM sessions WHERE user_id = ?', id);
    audit({
      actor: opts.actor,
      action: 'user.password_reset',
      entityType: 'user',
      entityId: id,
      summary: `Password of "${u.username}" reset with the recovery command on the server${reactivate ? ' and the account reactivated' : ''}`,
      details: { via: 'cli', reactivated: reactivate },
    });
  });
  return temp;
}

/** Changes the own password and signs out all other sessions of the user (keepSession: the current session cookie). */
export async function changePassword(id: string, current: string, next: string, keepSession?: string): Promise<void> {
  const r = db().get<UserRow>('SELECT * FROM users WHERE id = ?', id);
  if (!r) throw new HttpError(404, 'User not found');
  if (r.auth_source !== 'local') throw new HttpError(400, 'This account signs in with single sign-on and has no password');
  requirePasswordLogin('changing a password');
  // Someone holding a session must not be able to guess the password behind it (same limits as sign-in).
  const tries = recent(passwordChangeFailures, id);
  if (tries.length >= PASSWORD_CHANGE_MAX_FAILURES) {
    throw new HttpError(429, 'Too many wrong passwords – try again in a few minutes', 'TOO_MANY_ATTEMPTS');
  }
  if (!(await verifyPasswordAsync(current, r.password_hash))) {
    remember(passwordChangeFailures, id, tries);
    audit({
      action: 'user.password_change_failed',
      entityType: 'user',
      entityId: id,
      summary: `Password change by "${r.username}" refused: wrong current password (attempt ${tries.length + 1})`,
    });
    throw new HttpError(400, 'Current password is wrong', 'WRONG_CURRENT_PASSWORD');
  }
  passwordChangeFailures.delete(id);
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
  // a former team name of an imported team still stands for that team in imported content (aliases.ts)
  const former = teamAliasTarget(name);
  if (former && former !== tid) throw new HttpError(409, `"${name}" is the former name of an imported team`, 'TEAM_NAME_IS_ALIAS', { name });
  const memberIds = (input.members ?? []).map((m) => {
    const u = findUserByName(m);
    if (!u) throw new HttpError(400, `Unknown user "${m}"`);
    return u.id;
  });
  const before = id ? db().get<{ name: string }>('SELECT name FROM teams WHERE id = ?', id) : undefined;
  let moved = 0;
  db().tx(() => {
    if (id) {
      const r = db().run('UPDATE teams SET name = ?, description = ? WHERE id = ?', name, input.description ?? '', id);
      if (!r.changes) throw new HttpError(404, 'Team not found');
      // renamed: owners, responsibles, access lists, recipients and subscribers follow (#143)
      if (before && before.name.toLowerCase() !== name.toLowerCase()) moved = rewriteTeamReferences(before.name, name);
    } else {
      if (db().get('SELECT 1 FROM teams WHERE name = ?', name)) throw new HttpError(409, `Team "${name}" exists`);
      db().run('INSERT INTO teams (id, name, description, created_at) VALUES (?, ?, ?, ?)', tid, name, input.description ?? '', nowIso());
    }
    if (input.members) {
      db().run('DELETE FROM team_members WHERE team_id = ?', tid);
      for (const uid of memberIds) db().run('INSERT INTO team_members (team_id, user_id) VALUES (?, ?)', tid, uid);
    }
    invalidateAliases();
    audit({
      action: id ? 'team.updated' : 'team.created',
      entityType: 'team',
      entityId: tid,
      summary: `Team "${name}" ${id ? 'updated' : 'created'}${input.members ? ` (${input.members.length} members)` : ''}${before && before.name !== name ? ` – renamed from "${before.name}"${moved ? `, ${moved} references updated` : ''}` : ''}`,
      details: { members: input.members, ...(before && before.name !== name ? { renamedFrom: before.name, referencesUpdated: moved } : {}) },
    });
  });
  return listTeams().find((t) => t.id === tid)!;
}

export function deleteTeam(id: string): void {
  const t = listTeams().find((x) => x.id === id);
  if (!t) throw new HttpError(404, 'Team not found');
  db().tx(() => {
    // the team leaves owners, responsibles, access lists, recipients and subscribers (#143)
    const removed = rewriteTeamReferences(t.name, null);
    db().run('DELETE FROM teams WHERE id = ?', id);
    invalidateAliases();
    audit({
      action: 'team.deleted',
      entityType: 'team',
      entityId: id,
      summary: `Team "${t.name}" deleted${removed ? ` (removed from ${removed} entries)` : ''}`,
      details: { referencesRemoved: removed },
    });
  });
}

// ---------- Login & sessions ----------

const failures = new Map<string, { count: number; until: number }>();
/** Failed sign-ins per account across all source addresses (sliding 15-minute window). */
const accountFailures = new Map<string, number[]>();
/** Failed sign-ins per source address across all accounts (password spraying). */
const addressFailures = new Map<string, number[]>();
const WINDOW_MS = 15 * 60000;
const ACCOUNT_MAX_FAILURES = 20;
const ADDRESS_MAX_FAILURES = 50;
/** Wrong current passwords when changing the own password, per account (sliding 15-minute window). */
const passwordChangeFailures = new Map<string, number[]>();
const PASSWORD_CHANGE_MAX_FAILURES = 5;
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
  const mode = passwordLoginMode();
  if (mode === 'none') {
    // Single sign-on only: every attempt gets the usual answer, without checking the password (no oracle, no hashing
    // cost). It still counts against the limits and is audited like a wrong password.
    remember(accountFailures, account, byAccount);
    remember(addressFailures, address, byAddress);
    recordFailedLogin({ username, account: r ? { id: r.id, username: r.username, disabled: !r.active } : null, ip: meta.ip });
    throw new HttpError(401, 'Wrong user name or password', 'WRONG_CREDENTIALS');
  }
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
  if (mode === 'adminsOnly' && !roles.includes('admin')) {
    throw new HttpError(403, 'Password sign-in is disabled – please use single sign-on', 'PASSWORD_LOGIN_DISABLED');
  }
  const session = createSession(r.id, r.username, meta, 'password');
  return { ...session, user: toInfo(r) };
}

/**
 * Step-up with the password (a password session confirms a sensitive action): the same limits as a sign-in – the
 * lockout per account and address, the counters per account and per address – and one hash per attempt whatever the
 * account (constant time). Failures count against sign-in too: someone holding a stolen session cannot guess the
 * password behind it faster than at the sign-in page. Audited by the caller (step-up.ts), which also marks the session.
 */
export async function verifyStepUpPassword(userId: string, password: string, meta: { ip?: string }): Promise<{ username: string }> {
  const r = db().get<UserRow>('SELECT * FROM users WHERE id = ?', userId);
  const username = r?.username ?? '';
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
  const ok = await verifyPasswordAsync(password, r?.password_hash && r.password_hash.startsWith('scrypt$') ? r.password_hash : dummyHash());
  if (!r || !ok || !r.active) {
    const count = (f?.count ?? 0) + 1;
    if (failures.size >= MAX_TRACKED && !failures.has(key)) failures.delete(failures.keys().next().value!);
    failures.set(key, { count, until: count >= 5 ? Date.now() + 5 * 60000 : 0 });
    remember(accountFailures, account, byAccount);
    remember(addressFailures, address, byAddress);
    throw Object.assign(new HttpError(403, 'The password is wrong', 'STEP_UP_WRONG_PASSWORD'), { attempt: count });
  }
  failures.delete(key);
  accountFailures.delete(account);
  return { username };
}

/** The link key belonging to a binding (derived, so it needs no storage of its own). */
const linkKeyOf = (binding: string) => crypto.createHmac('sha256', Buffer.from(binding, 'hex')).update('steward-link-v1').digest('base64url');

/** Longest life of a session opened with emergency access (whatever SM_SESSION_MAX_HOURS says). */
export const EMERGENCY_SESSION_MS = 60 * 60_000;

/** How long a session may live at most. */
const sessionMaxMs = (emergency: boolean) => (emergency ? Math.min(EMERGENCY_SESSION_MS, config.session.maxMs) : config.session.maxMs);

/**
 * Create a session for an authenticated user and record the sign-in. Returns the cookie token and the binding keys.
 * `method`: 'password', 'emergency' or the single sign-on provider's name. `emergencyGrantId`: the emergency
 * access grant that opened it (no auth.login entry then: the caller writes auth.emergency_sign_in).
 */
export function createSession(
  userId: string,
  username: string,
  meta: { ip?: string; userAgent?: string },
  method: string,
  opts: { emergencyGrantId?: string; stepUp?: { at: number; method: string } } = {},
): CreatedSession {
  const token = crypto.randomBytes(32).toString('base64url');
  const sessionKey = crypto.randomBytes(32).toString('base64url');
  const binding = hashToken(sessionKey);
  const ts = nowIso();
  const emergency = !!opts.emergencyGrantId;
  db().tx(() => {
    db().run(
      'INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, ip, user_agent, binding, method, emergency_grant_id, step_up_at, step_up_method) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      hashToken(token),
      userId,
      ts,
      new Date(Date.now() + Math.min(config.session.idleMs, sessionMaxMs(emergency))).toISOString(),
      ts,
      meta.ip ?? null,
      meta.userAgent?.slice(0, 200) ?? null,
      binding,
      // how the session was opened decides what the sign-in mode allows (sessionUser): password, sso or emergency
      emergency ? 'emergency' : method === 'password' ? 'password' : 'sso',
      opts.emergencyGrantId ?? null,
      // a sign-in is a confirmation too: the password just entered, or a fresh sign-in at the provider (auth_time, see sso.ts)
      opts.stepUp ? new Date(opts.stepUp.at).toISOString() : method === 'password' && !emergency ? ts : null,
      opts.stepUp ? opts.stepUp.method : method === 'password' && !emergency ? 'password' : null,
    );
    db().run('UPDATE users SET last_login_at = ? WHERE id = ?', ts, userId);
    db().run('DELETE FROM sessions WHERE expires_at < ?', ts);
    if (!emergency) {
      audit({
        actor: username,
        action: 'auth.login',
        entityType: 'user',
        entityId: userId,
        summary: `${username} signed in${method === 'password' ? '' : ` via ${method}`}`,
        details: { ip: meta.ip, method },
      });
    }
  });
  return { token, sessionKey, linkKey: linkKeyOf(binding) };
}

/**
 * Signs out the sessions the new password sign-in setting no longer allows (they would be refused at their next
 * request anyway, see sessionUser): 'none' – every password session; 'adminsOnly' – password sessions of other
 * accounts than administrators. Emergency sessions and `keep` (the session of the person changing it) stay.
 */
export function endPasswordSessions(mode: 'all' | 'adminsOnly' | 'none', keepToken?: string): number {
  if (mode === 'all') return 0;
  const keep = keepToken ? hashToken(keepToken) : '';
  // by how the session was opened (an account linked to single sign-on later may still hold a password session);
  // sessions from before the method was recorded count as password sessions
  const rows = db().all<{ id: string; roles: string }>(
    `SELECT s.id, u.roles FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE (s.method IS NULL OR s.method = 'password') AND s.emergency_grant_id IS NULL AND s.id <> ?`,
    keep,
  );
  let n = 0;
  for (const r of rows) {
    if (mode === 'adminsOnly' && parseJson<Role[]>(r.roles, []).includes('admin')) continue;
    n += db().run('DELETE FROM sessions WHERE id = ?', r.id).changes;
  }
  return n;
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

export function sessionUser(token: string | undefined, binding: SessionBinding): SessionInfo | null {
  if (!token) return null;
  const id = hashToken(token);
  const s = db().get<{
    user_id: string;
    created_at: string;
    expires_at: string;
    last_seen_at: string;
    binding: string | null;
    emergency_grant_id: string | null;
    method: string | null;
    step_up_at: string | null;
    step_up_method: string | null;
  }>('SELECT * FROM sessions WHERE id = ?', id);
  if (!s) return null;
  const now = Date.now();
  const emergency = !!s.emergency_grant_id;
  const maxMs = sessionMaxMs(emergency);
  if (Date.parse(s.expires_at) < now || Date.parse(s.created_at) + maxMs < now) {
    db().run('DELETE FROM sessions WHERE id = ?', id);
    return null;
  }
  if (!bindingMatches(s.binding, binding)) return null;
  const r = db().get<UserRow>('SELECT * FROM users WHERE id = ? AND active = 1', s.user_id);
  if (!r) return null;
  // The sign-in policy applies to open sessions too: password sessions end when password sign-in is turned off. It goes
  // by how the session was opened, not by the account (which may have been linked to single sign-on since); sessions
  // from before the method was recorded count as password sessions.
  if (!emergency && (s.method === null || s.method === 'password')) {
    const mode = passwordLoginMode();
    if (mode === 'none' || (mode === 'adminsOnly' && !parseJson<Role[]>(r.roles, []).includes('admin'))) {
      db().run('DELETE FROM sessions WHERE id = ?', id);
      return null;
    }
  }
  if (now - Date.parse(s.last_seen_at) > 60000) {
    db().run(
      'UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?',
      new Date(now).toISOString(),
      new Date(Math.min(now + config.session.idleMs, Date.parse(s.created_at) + maxMs)).toISOString(),
      id,
    );
  }
  const info: SessionInfo = toInfo(r);
  info.session = {
    id,
    // sessions from before the method was recorded count as password sessions (like the sign-in policy above)
    method: emergency ? 'emergency' : s.method === 'sso' ? 'sso' : 'password',
    stepUpAt: s.step_up_at ? Date.parse(s.step_up_at) : null,
    stepUpMethod: s.step_up_method,
  };
  if (emergency) {
    // An emergency session is for fixing sign-in: no forced password change in between.
    info.mustChangePassword = false;
    info.emergency = { grantId: s.emergency_grant_id!, expiresAt: new Date(Date.parse(s.created_at) + maxMs).toISOString() };
  }
  return info;
}

export function logout(token: string | undefined): void {
  if (token) db().run('DELETE FROM sessions WHERE id = ?', hashToken(token));
}
