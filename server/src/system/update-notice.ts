import type { UpdateNotice } from '@sm/shared';
import type { UpgradeInfo } from '../db.js';
import { audit } from '../audit.js';
import { db } from '../db.js';
import { newId } from '../util.js';
import { readSetting, writeSetting } from '../settings.js';

/**
 * The update notice for administrators: written with the system.upgraded audit entries
 * (upgrades.ts, once the vault is unlocked), shown in the web app until each administrator
 * dismisses it. A newer update replaces it, together with its dismissals.
 */
export const UPDATE_NOTICE_KEY = 'system.updateNotice';
/** Dismissals kept per notice (one per administrator; a bound against a growing settings row). */
const MAX_DISMISSALS = 1000;

interface StoredNotice extends UpdateNotice {
  dismissedBy: string[];
}

/** One notice for the upgrades recorded since the last unlock (usually one; several after restarts before it). */
export function recordUpdateNotice(list: UpgradeInfo[]): void {
  if (!list.length) return;
  const first = list[0]!;
  const last = list[list.length - 1]!;
  const migrations = list.flatMap((u) => u.migrations);
  const backups = list.flatMap((u) => (u.backup ? [u.backup] : []));
  const noBackupReason: UpdateNotice['noBackupReason'] = backups.length
    ? null
    : !migrations.length
      ? 'notNeeded'
      : db().dialect === 'postgres'
        ? 'postgres'
        : 'disabled';
  const notice: StoredNotice = {
    id: newId('upd_'),
    fromVersion: first.fromVersion,
    toVersion: last.toVersion,
    migrations,
    backups,
    noBackupReason,
    at: last.at,
    dismissedBy: [],
  };
  writeSetting(UPDATE_NOTICE_KEY, notice);
}

function stored(): StoredNotice | null {
  const n = readSetting<StoredNotice | null>(UPDATE_NOTICE_KEY, null);
  return n && typeof n === 'object' && typeof n.id === 'string' && typeof n.toVersion === 'string' ? n : null;
}

/** The notice for this administrator, or null (none, or dismissed by them). The caller checks the role. */
export function updateNoticeFor(userId: string): UpdateNotice | null {
  const n = stored();
  if (!n || (Array.isArray(n.dismissedBy) && n.dismissedBy.includes(userId))) return null;
  const { dismissedBy: _dismissed, ...notice } = n;
  return {
    ...notice,
    migrations: Array.isArray(notice.migrations) ? notice.migrations : [],
    backups: Array.isArray(notice.backups) ? notice.backups : [],
  };
}

/** Hides the notice for this administrator. False when `id` is not the current notice (replaced in the meantime). */
export function dismissUpdateNotice(user: { id: string; username: string }, id: string): boolean {
  return db().tx(() => {
    const n = stored();
    if (!n || n.id !== id) return false;
    const dismissedBy = Array.isArray(n.dismissedBy) ? n.dismissedBy : [];
    if (dismissedBy.includes(user.id)) return true;
    writeSetting(UPDATE_NOTICE_KEY, { ...n, dismissedBy: [...dismissedBy, user.id].slice(-MAX_DISMISSALS) });
    audit({
      action: 'system.update_notice_dismissed',
      entityType: 'system',
      entityId: n.id,
      summary: `Update notice for ${n.toVersion} dismissed by ${user.username}`,
    });
    return true;
  });
}
