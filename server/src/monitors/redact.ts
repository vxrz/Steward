import { HIDDEN_MONITOR_REF, type CauseRef, type MonitorStatus } from '@sm/shared';
import { db } from '../db.js';
import { parseJson } from '../util.js';
import { currentUser, type AuthUser } from '../auth/context.js';
import { monitorPermissions } from './model.js';

/**
 * Sub-monitors the viewer may not view. A monitor A that includes B shows B's status, but a viewer of A
 * without the right to view B must not learn B's id, key, name or check names – not through root causes,
 * "caused by", the sub-monitor check, messages, history, exports, datasets, the APIs or notifications.
 *
 * The engine stores the references structured (CauseRef, the check definition) and the sub-monitor
 * check's message without names; everything is redacted for the viewer when it is read.
 */

export type MonitorVisibility = (monitorId: string) => boolean;

/** "May this user view the monitor?", memoised for one request (or one notification). */
export function monitorVisibility(u: AuthUser | null = currentUser()): MonitorVisibility {
  const cache = new Map<string, boolean>();
  return (id) => {
    let v = cache.get(id);
    if (v === undefined) {
      const r = db().get<{ owner: string; acl: string }>('SELECT owner, acl FROM monitors WHERE id = ?', id);
      v = !!r && monitorPermissions(u, { owner: r.owner, acl: parseJson(r.acl, []) }).includes('view');
      cache.set(id, v);
    }
    return v;
  };
}

export const hiddenCause = (): CauseRef => ({ monitorId: '', monitorKey: '', monitorName: '', checkId: '', checkName: '', hidden: true });

/** Causes in monitors the viewer may not view become one "a monitor you cannot view" entry (no count either). */
export function redactCauses(list: CauseRef[], canView: MonitorVisibility): CauseRef[] {
  const out = list.filter((c) => !c.hidden && canView(c.monitorId));
  return out.length === list.length ? list : [...out, hiddenCause()];
}

/** English, like the other engine messages; the web UI shows hidden causes in the user's language. */
export const HIDDEN_MONITOR_TEXT = 'a monitor you cannot view';

export const causeLine = (c: CauseRef, selfId: string): string =>
  c.hidden ? HIDDEN_MONITOR_TEXT : c.monitorId === selfId ? c.checkName : `${c.monitorName} › ${c.checkName}`;

/** History message of a monitor-level status change. */
export const rootCauseMessage = (causes: CauseRef[], selfId: string): string =>
  causes.length ? `Root cause: ${causes.map((c) => causeLine(c, selfId)).join(', ')}` : '';

/** Result message of a sub-monitor check (no names: the referenced monitor is shown structured, per viewer). */
export function subMonitorMessage(state: MonitorStatus | 'missing' | 'disabled'): string {
  if (state === 'missing') return 'The referenced monitor no longer exists';
  if (state === 'disabled') return 'The sub-monitor is disabled';
  if (state === 'maintenance') return 'The sub-monitor is in maintenance';
  return `The sub-monitor is ${state}`;
}

/** What a viewer who may not view the sub-monitor reads instead of the check's message. */
export const hiddenSubMonitorMessage = (status: MonitorStatus): string => `The sub-monitor (${HIDDEN_MONITOR_TEXT}) is ${status}`;

/** Messages stored before sub-monitor messages became generic: "<name>" is down – root cause: <check names>. */
const LEGACY_SUB_MESSAGE = /^"[\s\S]*" is (?:up|down|degraded|unknown|blocked|maintenance|in maintenance|disabled)\b/;

/**
 * The message of a check result or status change as the viewer may read it. `subMonitor`: the id the
 * check refers to when it is a sub-monitor check now (undefined for other checks and removed ones).
 */
export function checkMessage(message: string, status: MonitorStatus, subMonitor: string | undefined, canView: MonitorVisibility): string {
  if (subMonitor !== undefined) return canView(subMonitor) ? message : hiddenSubMonitorMessage(status);
  return LEGACY_SUB_MESSAGE.test(message) ? hiddenSubMonitorMessage(status) : message;
}

/** Sub-monitor references in a definition (or its export) that the viewer may not view → HIDDEN_MONITOR_REF. */
export function redactDefinition<T>(def: T, canView: MonitorVisibility, idOf: (ref: string) => string | undefined = (r) => r): T {
  const checks = (def as { checks?: unknown }).checks;
  if (!Array.isArray(checks)) return def;
  let changed = false;
  const out = checks.map((c: Record<string, unknown>) => {
    if (c?.type !== 'monitor' || typeof c.monitor !== 'string' || c.monitor === HIDDEN_MONITOR_REF) return c;
    const id = idOf(c.monitor);
    if (id && canView(id)) return c;
    changed = true;
    return { ...c, monitor: HIDDEN_MONITOR_REF };
  });
  return changed ? ({ ...def, checks: out } as T) : def;
}
