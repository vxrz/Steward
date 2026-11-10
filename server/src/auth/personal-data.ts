import crypto from 'node:crypto';
import { PERSONAL_DATA_LIMITS, type PersonalDataActivity, type PersonalDataExport, type UserInfo } from '@sm/shared';
import { db } from '../db.js';
import { audit, toEntry, VALID_SEQ, type AuditRow } from '../audit.js';
import { config } from '../config.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import { columns } from '../cli/db-copy.js';
import { HISTORY_COLUMNS, USER_REFS } from '../migration/tables.js';
import { mapValue, type NameMaps } from '../migration/refs.js';
import { revokeOAuthGrants } from '../mcp/oauth-grants.js';
import { getUser, NO_PASSWORD } from './users.js';

/**
 * A person's data (GDPR, docs/PRIVACY.md): the export of what Steward holds about one person (Art. 15 and 20), and the
 * pseudonymisation of a deactivated account (Art. 17 as far as the audit log allows).
 *
 * The audit log is an HMAC chain over every entry's fields – the actor's user name and the summaries included (audit.ts
 * computeHash). Entries are never changed, so they keep naming the user name. The account keeps it too: it is how
 * those entries, run protocols, records and other evidence (often sealed) still point at one account, and user names
 * are never given to anyone else. Everything else that describes the person is replaced or deleted.
 */

const lower = (s: string) => s.trim().toLowerCase();

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  locale: string | null;
  email_notifications: number | null;
  roles: string;
  active: number;
  auth_source: string | null;
  external_id: string | null;
  external_sub: string | null;
  profile: string | null;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  pseudonymised_at: string | null;
}

function userRow(id: string): UserRow {
  const r = db().get<UserRow>('SELECT * FROM users WHERE id = ?', id);
  if (!r) throw new HttpError(404, 'User not found');
  return r;
}

/** The stable pseudonym of an account: derived from its id, so the same account always gets the same one. */
export const pseudonymOf = (userId: string): string =>
  `former-user-${crypto.createHash('sha256').update(`steward-pseudonym:${userId}`).digest('hex').slice(0, 6)}`;

// ---------- export ----------

const LABEL_COLUMNS = ['name', 'title', 'number', 'key', 'process_name', 'display_name'];
const TIME_COLUMNS = ['created_at', 'started_at', 'decided_at', 'completed_at', 'ts', 'at', 'updated_at'];

/** Where a column names the person: the plain user name, or the name inside a JSON list or subject ("user:<name>"). */
function namedIn(table: string, column: string, kind: PersonalDataActivity['kind'], username: string, refKind?: (typeof USER_REFS)[number]['kind']) {
  let cols: string[];
  try {
    cols = columns(db(), table);
  } catch {
    return null;
  }
  if (!cols.includes(column)) return null;
  const label = LABEL_COLUMNS.find((c) => cols.includes(c));
  const at = TIME_COLUMNS.find((c) => cols.includes(c));
  const id = cols.includes('id') ? 'id' : null;
  const name = lower(username);
  const pattern = `%${name.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const select = `SELECT ${id ? `${id} AS id` : 'NULL AS id'}, ${label ? `${label} AS label` : 'NULL AS label'}, ${at ? `${at} AS at` : 'NULL AS at'}, ${column} AS v FROM ${table}`;
  // a candidate by LIKE (index-free but bounded by the table), then the exact check: the whole value, or one entry of a list
  const rows = db().all<{ id: unknown; label: unknown; at: unknown; v: unknown }>(
    `${select} WHERE lower(${column}) LIKE ? ESCAPE '\\' ${at ? `ORDER BY ${at} DESC` : ''}`,
    pattern,
  );
  const probe: NameMaps = { users: new Map([[name, '\u0000probe']]), teams: new Map() };
  const none: NameMaps = { users: new Map(), teams: new Map() };
  const hits = rows.filter((r) => {
    const v = String(r.v ?? '');
    if (lower(v) === name) return true;
    if (refKind && refKind !== 'username') return mapValue(refKind, v, probe) !== mapValue(refKind, v, none);
    // history columns holding a JSON list of user names (e.g. the authors of a record edition)
    const list = parseJson<unknown>(v, null);
    return Array.isArray(list) && list.some((x) => typeof x === 'string' && lower(x) === name);
  });
  if (!hits.length) return null;
  const str = (x: unknown) => (x === null || x === undefined ? null : String(x));
  return {
    table,
    column,
    kind,
    total: hits.length,
    rows: hits.slice(0, PERSONAL_DATA_LIMITS.rowsPerColumn).map((r) => ({ id: str(r.id), label: str(r.label)?.slice(0, 200) ?? null, at: str(r.at) })),
  } satisfies PersonalDataActivity;
}

/** Audit entries about the person: those they wrote (actor) and those about their account. Paged by sequence number. */
function auditAbout(u: UserRow, after: number): PersonalDataExport['audit'] {
  const where = `${VALID_SEQ} AND (actor = ? OR (entity_type = 'user' AND entity_id = ?))`;
  const total = Number(db().get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log WHERE ${where}`, u.username, u.id)!.n);
  const limit = PERSONAL_DATA_LIMITS.auditPerPage;
  const rows = db().all<AuditRow>(`SELECT * FROM audit_log WHERE ${where} AND seq > ? ORDER BY seq LIMIT ?`, u.username, u.id, after, limit + 1);
  const more = rows.length > limit;
  const entries = rows.slice(0, limit).map(toEntry);
  return { total, limit, entries, next: more ? `auditAfter=${entries.at(-1)!.seq}` : null };
}

/**
 * Everything Steward holds about one person. `auditAfter`: the next page of audit entries only (the `next` of the page
 * before); the rest of the export is the same as in the first file.
 */
export function exportPersonalData(userId: string, opts: { auditAfter?: number } = {}): PersonalDataExport {
  const u = userRow(userId);
  const info = getUser(userId);
  const all = <T>(sql: string, ...params: unknown[]) => db().all<T>(sql, ...params);
  const activity: PersonalDataActivity[] = [];
  if (!opts.auditAfter) {
    for (const ref of HISTORY_COLUMNS) {
      const [table, column] = ref.split('.') as [string, string];
      const a = namedIn(table, column, 'history', u.username);
      if (a) activity.push(a);
    }
    for (const ref of USER_REFS) {
      const a = namedIn(ref.table, ref.column, 'current', u.username, ref.kind);
      if (a) activity.push(a);
    }
  }
  const notifications = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?', userId)!.n);
  const pref = (table: string) => {
    const r = db().get<{ prefs: string; enabled?: number }>(`SELECT * FROM ${table} WHERE user_id = ?`, userId);
    return r ? { ...(r.enabled !== undefined ? { enabled: !!r.enabled } : {}), prefs: parseJson<unknown>(r.prefs, null) } : null;
  };
  return {
    format: 'steward-personal-data-v1',
    generatedAt: nowIso(),
    version: config.version,
    account: {
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      firstName: u.first_name,
      lastName: u.last_name,
      email: u.email,
      locale: u.locale,
      emailNotifications: !!(u.email_notifications ?? 1),
      roles: info.roles,
      active: !!u.active,
      authSource: u.auth_source ?? 'local',
      linkedIdentity: !!(u.external_id || u.external_sub),
      profile: info.profile,
      createdAt: u.created_at,
      updatedAt: u.updated_at,
      lastLoginAt: u.last_login_at,
      pseudonymisedAt: u.pseudonymised_at ?? null,
    },
    teams: all<{ name: string; roles: string | null }>(
      'SELECT t.name, m.roles FROM teams t JOIN team_members m ON m.team_id = t.id WHERE m.user_id = ? ORDER BY t.name',
      userId,
    ).map((t) => ({ name: t.name, roles: parseJson<string[]>(t.roles, []) })),
    // metadata only: never the token, its hash or the session key
    apiTokens: all<{
      name: string;
      scope: string;
      prefix: string;
      created_at: string;
      last_used_at: string | null;
      expires_at: string | null;
      revoked_at: string | null;
    }>('SELECT name, scope, prefix, created_at, last_used_at, expires_at, revoked_at FROM api_tokens WHERE user_id = ? ORDER BY created_at', userId).map(
      (t) => ({
        name: t.name,
        scope: t.scope,
        prefix: t.prefix,
        createdAt: t.created_at,
        lastUsedAt: t.last_used_at,
        expiresAt: t.expires_at,
        revokedAt: t.revoked_at,
      }),
    ),
    sessions: all<{ created_at: string; last_seen_at: string; expires_at: string; ip: string | null; user_agent: string | null; method: string | null }>(
      'SELECT created_at, last_seen_at, expires_at, ip, user_agent, method FROM sessions WHERE user_id = ? ORDER BY created_at',
      userId,
    ).map((s) => ({ createdAt: s.created_at, lastSeenAt: s.last_seen_at, expiresAt: s.expires_at, ip: s.ip, userAgent: s.user_agent, method: s.method })),
    mcpClients: all<{ name: string; created_at: string; last_used_at: string | null; revoked_at: string | null }>(
      'SELECT c.name, g.created_at, g.last_used_at, g.revoked_at FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id WHERE g.user_id = ? ORDER BY g.created_at',
      userId,
    ).map((g) => ({ client: g.name, createdAt: g.created_at, lastUsedAt: g.last_used_at, revokedAt: g.revoked_at })),
    emergencyAccess: all<{
      issued_by: string;
      created_at: string;
      expires_at: string;
      used_at: string | null;
      used_ip: string | null;
      revoked_at: string | null;
    }>('SELECT issued_by, created_at, expires_at, used_at, used_ip, revoked_at FROM emergency_access_grants WHERE user_id = ? ORDER BY created_at', userId).map(
      (g) => ({ issuedBy: g.issued_by, createdAt: g.created_at, expiresAt: g.expires_at, usedAt: g.used_at, usedIp: g.used_ip, revokedAt: g.revoked_at }),
    ),
    settings: {
      notificationPrefs: pref('notification_prefs'),
      dailySummary: pref('daily_summary_prefs'),
      // 0.15.0 (ADR 0025): the events chosen for the chat with the Teams bot
      personalChannels: ((r) => (r ? { teams: parseJson<unknown>(r.teams, []), updatedAt: r.updated_at } : null))(
        db().get<{ teams: string; updated_at: string }>('SELECT teams, updated_at FROM notification_personal_channels WHERE user_id = ?', userId),
      ),
    },
    notifications: {
      total: notifications,
      items: all<{ ts: string; event: string; title: string; read: number }>(
        'SELECT ts, event, title, read FROM notifications WHERE user_id = ? ORDER BY ts DESC LIMIT ?',
        userId,
        PERSONAL_DATA_LIMITS.notifications,
      ).map((n) => ({ ts: n.ts, event: n.event, title: n.title, read: !!n.read })),
    },
    teamsChats: all<{ installed_at: string; removed_at: string | null }>(
      'SELECT installed_at, removed_at FROM teams_conversations WHERE user_id = ? ORDER BY installed_at',
      userId,
    ).map((c) => ({ installedAt: c.installed_at, removedAt: c.removed_at })),
    activity,
    audit: auditAbout(u, opts.auditAfter ?? 0),
  };
}

/** Audited by the route: who exported whose data. */
export function auditExport(subject: UserInfo, by: { username: string; id: string }, page: { auditAfter?: number }): void {
  const self = subject.id === by.id;
  audit({
    action: 'user.data_exported',
    entityType: 'user',
    entityId: subject.id,
    summary: self
      ? `${by.username} exported their own data${page.auditAfter ? ' (further audit entries)' : ''}`
      : `${by.username} exported the data of "${subject.username}"${page.auditAfter ? ' (further audit entries)' : ''}`,
    details: { self, ...(page.auditAfter ? { auditAfter: page.auditAfter } : {}) },
  });
}

// ---------- pseudonymisation ----------

/**
 * Replaces the personal data of a deactivated account by a pseudonym, for good: display, first and last name, e-mail,
 * the single sign-on profile fields and identity link, language and e-mail setting; deletes its settings, notifications,
 * held messages, Teams chats and the events chosen for them, team memberships, sessions, API tokens, emergency access and MCP client connections.
 * Keeps the account id and the user name (the audit chain and the evidence name it), its roles (what it could do) and
 * its dates. Cannot be undone; the account cannot be activated again.
 */
export function pseudonymiseUser(userId: string, opts: { actor?: string } = {}): UserInfo {
  const u = userRow(userId);
  if (u.pseudonymised_at)
    throw new HttpError(409, `The data of "${u.username}" was already replaced by a pseudonym`, 'USER_PSEUDONYMISED', { username: u.username });
  if (u.active) throw new HttpError(409, `Deactivate "${u.username}" first`, 'USER_ACTIVE', { username: u.username });
  const pseudonym = pseudonymOf(userId);
  const ts = nowIso();
  db().tx(() => {
    const removed: Record<string, number> = {};
    const del = (key: string, sql: string) => {
      const n = db().run(sql, userId).changes;
      if (n) removed[key] = n;
    };
    db().run(
      `UPDATE users SET display_name = ?, first_name = NULL, last_name = NULL, email = NULL, profile = NULL, external_id = NULL,
         external_sub = NULL, locale = NULL, email_notifications = 0, password_hash = ?, must_change_password = 0, active = 0,
         pseudonymised_at = ?, updated_at = ? WHERE id = ?`,
      pseudonym,
      NO_PASSWORD,
      ts,
      ts,
      userId,
    );
    del('sessions', 'DELETE FROM sessions WHERE user_id = ?');
    del('apiTokens', 'DELETE FROM api_tokens WHERE user_id = ?');
    del('emergencyAccess', 'DELETE FROM emergency_access_grants WHERE user_id = ?');
    del('teams', 'DELETE FROM team_members WHERE user_id = ?');
    del('notificationPrefs', 'DELETE FROM notification_prefs WHERE user_id = ?');
    del('dailySummary', 'DELETE FROM daily_summary_prefs WHERE user_id = ?');
    del('notifications', 'DELETE FROM notifications WHERE user_id = ?');
    del('heldMessages', 'DELETE FROM notification_outbox WHERE user_id = ?');
    // the person's chat with the Teams bot (its cards and activities go with it)
    del('teamsChats', 'DELETE FROM teams_conversations WHERE user_id = ?');
    del('personalChannels', 'DELETE FROM notification_personal_channels WHERE user_id = ?');
    del('oauthCodes', 'DELETE FROM oauth_codes WHERE user_id = ?');
    const grants = revokeOAuthGrants({ userId, username: u.username }, 'personal data replaced by a pseudonym');
    if (grants) removed.mcpClients = grants;
    audit({
      ...(opts.actor ? { actor: opts.actor } : {}),
      action: 'user.pseudonymised',
      entityType: 'user',
      entityId: userId,
      // never the former name or e-mail: the entry is kept for good
      summary: `The personal data of "${u.username}" was replaced by the pseudonym "${pseudonym}" (cannot be undone; the user name stays for the audit log)`,
      details: { pseudonym, removed },
    });
  });
  return getUser(userId);
}
