import {
  DEFAULT_NOTIFICATION_PREFS,
  DIGEST_GROUPS,
  notificationPrefsSchema,
  type DigestGroup,
  type DigestRhythm,
  type NotificationPrefs,
  type NotificationPrefsSource,
  type NotificationPrefsState,
  type QuietHoursAdmin,
  type UserInfo,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { nowIso, parseJson } from '../util.js';
import { readSetting, writeSetting } from '../settings.js';
import { listUsers } from '../auth/users.js';
import { teamDefaults } from '../teams/settings.js';
import { inQuietHours, quietUntil } from './quiet.js';
import { localClock, hhmmOf } from './clock.js';

/**
 * A person's quiet hours and digests (ADR 0012): their own (Profile → Notifications), else the default of the first of
 * their teams (by name) that sets one, else off. Administrators can switch both off for everyone and see who uses them
 * and how – never the content. A person's own settings need no step-up (they only delay their own messages).
 */

const SWITCH_KEY = 'notifications.quietHours';

export const quietHoursAllowed = (): boolean => readSetting<{ allowed?: boolean }>(SWITCH_KEY, {}).allowed !== false;

export function setQuietHoursAllowed(allowed: boolean): QuietHoursAdmin {
  writeSetting(SWITCH_KEY, { allowed });
  audit({
    action: 'notification.quiet_hours_switch',
    entityType: 'settings',
    entityId: 'notifications',
    summary: `Quiet hours and digests ${allowed ? 'allowed' : 'switched off for everyone'}`,
    details: { allowed },
  });
  return quietAdminView();
}

function ownPrefs(userId: string): NotificationPrefs | null {
  const r = db().get<{ prefs: string }>('SELECT prefs FROM notification_prefs WHERE user_id = ?', userId);
  if (!r) return null;
  const p = notificationPrefsSchema.safeParse(parseJson(r.prefs, null));
  return p.success ? p.data : { ...DEFAULT_NOTIFICATION_PREFS };
}

function teamPrefsFor(userId: string): { prefs: NotificationPrefs; team: string } | null {
  const teams = db().all<{ id: string; name: string }>(
    `SELECT t.id, t.name FROM team_members m JOIN teams t ON t.id = m.team_id JOIN team_settings s ON s.team_id = t.id
     WHERE m.user_id = ? AND s.defaults IS NOT NULL ORDER BY t.name`,
    userId,
  );
  for (const t of teams) {
    const d = teamDefaults(t.id);
    if (d.quietHours || d.digests)
      return {
        prefs: { quietHours: d.quietHours ?? DEFAULT_NOTIFICATION_PREFS.quietHours, digests: d.digests ?? DEFAULT_NOTIFICATION_PREFS.digests },
        team: t.name,
      };
  }
  return null;
}

/** The settings that apply to a person and where they come from. */
export function effectiveNotificationPrefs(userId: string): { prefs: NotificationPrefs; source: NotificationPrefsSource } {
  const own = ownPrefs(userId);
  if (own) return { prefs: own, source: { from: 'own' } };
  const team = teamPrefsFor(userId);
  if (team) return { prefs: team.prefs, source: { from: 'team', team: team.team } };
  return { prefs: DEFAULT_NOTIFICATION_PREFS, source: { from: 'instance' } };
}

/** Open held messages of a target. */
export const heldCount = (target: string): number =>
  Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM notification_outbox WHERE target = ? AND released_at IS NULL', target)?.n ?? 0);

/** "Quiet hours until 07:30 · 4 messages held" (the bell and the profile). */
export function quietNow(userId: string, now = Date.now()): NotificationPrefsState['quiet'] {
  const held = heldCount(`email:${userId}`);
  const qh = quietHoursAllowed() ? effectiveNotificationPrefs(userId).prefs.quietHours : null;
  if (!inQuietHours(qh, now)) return { active: false, until: null, held };
  const end = quietUntil(qh, now);
  return { active: true, until: end === null ? null : hhmmOf(localClock(end, qh!.timeZone).minutes), held };
}

export function prefsState(u: UserInfo, now = Date.now()): NotificationPrefsState {
  const { prefs, source } = effectiveNotificationPrefs(u.id);
  return { prefs, source, allowed: quietHoursAllowed(), quiet: quietNow(u.id, now) };
}

const describeQuiet = (p: NotificationPrefs['quietHours']) =>
  p.enabled
    ? `on (${p.timeZone}; ${p.windows.map((w) => `${w.days.join(',')} ${w.from}–${w.to}`).join('; ') || 'no windows'}${p.allDay.length ? `; all day ${p.allDay.join(',')}` : ''}${p.urgentBreaksThrough ? '' : '; urgent messages held too'})`
    : 'off';
const rhythms = (p: NotificationPrefs['digests']): Partial<Record<DigestGroup, DigestRhythm>> =>
  Object.fromEntries(DIGEST_GROUPS.flatMap((g) => (p.groups[g] && p.groups[g]!.rhythm !== 'immediately' ? [[g, p.groups[g]!.rhythm]] : [])));

/** Saves a person's own settings (audited: old and new value). */
export function saveNotificationPrefs(u: UserInfo, input: NotificationPrefs): NotificationPrefsState {
  const before = effectiveNotificationPrefs(u.id);
  db().tx(() => {
    db().run(
      `INSERT INTO notification_prefs (user_id, prefs, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at`,
      u.id,
      JSON.stringify(input),
      nowIso(),
    );
    auditChange(u, before.prefs, input, before.source.from === 'own' ? null : before.source);
  });
  return prefsState(u);
}

function auditChange(u: UserInfo, from: NotificationPrefs, to: NotificationPrefs, was: NotificationPrefsSource | null): void {
  if (JSON.stringify(from.quietHours) !== JSON.stringify(to.quietHours) || was)
    audit({
      action: 'notification.quiet_hours_changed',
      entityType: 'user',
      entityId: u.id,
      summary: `${u.username}'s quiet hours: ${describeQuiet(to.quietHours)}`,
      details: { target: `email:${u.id}`, from: from.quietHours, to: to.quietHours, ...(was ? { previousSource: was } : {}) },
    });
  if (JSON.stringify(from.digests) !== JSON.stringify(to.digests))
    audit({
      action: 'notification.digests_changed',
      entityType: 'user',
      entityId: u.id,
      summary: `${u.username}'s digests: ${
        Object.entries(rhythms(to.digests))
          .map(([g, r]) => `${g} ${r}`)
          .join(', ') || 'everything immediately'
      }`,
      details: { from: from.digests, to: to.digests },
    });
}

/** Back to the default: the own settings are removed. */
export function resetNotificationPrefs(u: UserInfo): NotificationPrefsState {
  const before = effectiveNotificationPrefs(u.id);
  if (before.source.from === 'own') {
    db().tx(() => {
      db().run('DELETE FROM notification_prefs WHERE user_id = ?', u.id);
      const after = effectiveNotificationPrefs(u.id);
      audit({
        action: 'notification.quiet_hours_changed',
        entityType: 'user',
        entityId: u.id,
        summary: `${u.username} uses the ${after.source.from === 'team' ? `quiet hours and digests of team "${after.source.team}"` : 'instance default for quiet hours and digests (off)'} again`,
        details: { target: `email:${u.id}`, from: before.prefs, to: after.prefs, source: after.source },
      });
    });
  }
  return prefsState(u);
}

/** People who use quiet hours or digests: their own settings, or a team default. */
function candidates(): string[] {
  const own = db()
    .all<{ user_id: string }>('SELECT user_id FROM notification_prefs')
    .map((r) => r.user_id);
  const teamIds = db()
    .all<{ team_id: string }>('SELECT team_id FROM team_settings WHERE defaults IS NOT NULL')
    .map((r) => r.team_id)
    .filter((id) => {
      const d = teamDefaults(id);
      return d.quietHours?.enabled || (d.digests && Object.keys(rhythms(d.digests)).length > 0);
    });
  const fromTeams = teamIds.length
    ? db()
        .all<{ user_id: string }>(
          `SELECT DISTINCT m.user_id FROM team_members m WHERE m.team_id IN (${teamIds.map(() => '?').join(', ')})
           AND NOT EXISTS (SELECT 1 FROM notification_prefs p WHERE p.user_id = m.user_id)`,
          ...teamIds,
        )
        .map((r) => r.user_id)
    : [];
  return [...new Set([...own, ...fromTeams])];
}

/** Administrators: the switch, who uses quiet hours and digests and how many messages wait (never the content). */
export function quietAdminView(): QuietHoursAdmin {
  const users = new Map(listUsers().map((u) => [u.id, u]));
  const list = candidates()
    .map((id) => users.get(id))
    .filter((u): u is UserInfo => !!u && u.active)
    .map((u) => ({ u, ...effectiveNotificationPrefs(u.id) }))
    .filter(({ prefs }) => prefs.quietHours.enabled || Object.keys(rhythms(prefs.digests)).length > 0)
    .map(({ u, prefs, source }) => ({
      username: u.username,
      displayName: u.displayName,
      source: source.from,
      quietHours: prefs.quietHours.enabled,
      timeZone: prefs.quietHours.enabled ? prefs.quietHours.timeZone : prefs.digests.timeZone,
      digests: rhythms(prefs.digests),
      held: heldCount(`email:${u.id}`),
    }))
    .sort((a, b) => a.username.localeCompare(b.username));
  const channels = db()
    .all<{ target: string; n: number }>(
      "SELECT target, COUNT(*) AS n FROM notification_outbox WHERE released_at IS NULL AND target NOT LIKE 'email:%' GROUP BY target ORDER BY target",
    )
    .map((r) => ({ target: r.target, label: r.target, held: Number(r.n) }));
  return { allowed: quietHoursAllowed(), users: list, channels };
}
