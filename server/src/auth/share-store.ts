import { SHARE_ACTION_RIGHTS, SHARE_LEVELS, type OwnedKind, type ResourceShare, type ShareAction, type ShareLevel } from '@sm/shared';
import { db } from '../db.js';
import { parseJson } from '../util.js';
import { currentStore, type ShareIndex } from './context.js';

/**
 * The stored shares and Restricted resources (ADR 0033), read for deciding (auth/policy.ts) – the low half of
 * auth/shares.ts, without anything that writes, so the policy module can read it without an import cycle.
 *
 * Reads in bulk per request (ADR 0033 "Performance", security review 0.19.0 H2): the shares of one user's subjects
 * on one kind are one statement (index on `subject`), the Restricted resources of one kind another; every decision
 * after that is a lookup. Questions about one resource (its Access tab, previews, reminders) read it by its key.
 * Outside a request or job run (no store) each question reads what it needs.
 */

export interface ShareRow {
  kind: string;
  resource_id: string;
  subject: string;
  level: string;
  actions: string;
  expires_at: string | null;
  /** Custom (0.23.0): the exact rights of a migrated access-list entry, JSON; NULL for a share of a level */
  rights?: string | null;
  reminded_at?: string | null;
  created_by: string;
  created_at: string;
}

const LEVELS = new Set<string>(SHARE_LEVELS);
const ACTIONS = new Set<string>(SHARE_ACTION_RIGHTS);

/** A stored row as a share (an unknown level reads as View, unknown action rights are dropped – never more). */
export function toShare(r: ShareRow): ResourceShare {
  return {
    subject: r.subject,
    level: (LEVELS.has(r.level) ? r.level : 'view') as ShareLevel,
    actions: parseJson<unknown[]>(r.actions, []).filter((a): a is ShareAction => typeof a === 'string' && ACTIONS.has(a)),
    expiresAt: r.expires_at,
    ...(r.rights ? { rights: parseJson<unknown[]>(r.rights, []).filter((x): x is string => typeof x === 'string') } : {}),
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

/** Whether a share still counts at `now`: an end date in the past ends it at once, before the job removes it. */
export const shareActive = (s: Pick<ResourceShare, 'expiresAt'>, now: number = Date.now()): boolean => !s.expiresAt || Date.parse(s.expiresAt) > now;

const SELECT = 'SELECT kind, resource_id, subject, level, actions, expires_at, rights, created_by, created_at FROM resource_shares';

function index(): ShareIndex | undefined {
  const store = currentStore();
  if (!store) return undefined;
  store.shareIndex ??= { mine: new Map(), restricted: new Map() };
  return store.shareIndex;
}

const overlayOf = (kind: OwnedKind, id: string) => currentStore()?.shareIndex?.overlay?.get(`${kind}:${id}`);

/** Every share of one resource, ordered by subject (expired ones only with `expired`). */
export function sharesOf(kind: OwnedKind, id: string, opts: { expired?: boolean } = {}): ResourceShare[] {
  const over = overlayOf(kind, id)?.shares;
  const all = over ?? db().all<ShareRow>(`${SELECT} WHERE kind = ? AND resource_id = ? ORDER BY subject`, kind, id).map(toShare);
  return opts.expired ? all : all.filter((s) => shareActive(s));
}

/**
 * The active shares of one user's subjects on a resource. `subjects`: the user's subjects (permissions.ts subjectsOf –
 * user, teams, instance roles, former names); `userId` keys the request's index.
 */
export function sharesFor(userId: string, subjects: ReadonlySet<string>, kind: OwnedKind, id: string): ResourceShare[] {
  const over = overlayOf(kind, id)?.shares;
  if (over) return over.filter((s) => subjects.has(s.subject) && shareActive(s));
  const list = [...subjects];
  if (!list.length) return [];
  const idx = index();
  if (!idx) {
    return db()
      .all<ShareRow>(`${SELECT} WHERE kind = ? AND resource_id = ? AND subject IN (${list.map(() => '?').join(', ')})`, kind, id, ...list)
      .map(toShare)
      .filter((s) => shareActive(s));
  }
  const key = `${userId}|${kind}`;
  let mine = idx.mine.get(key);
  if (!mine) {
    mine = new Map();
    for (const r of db().all<ShareRow>(`${SELECT} WHERE kind = ? AND subject IN (${list.map(() => '?').join(', ')})`, kind, ...list)) {
      const l = mine.get(r.resource_id) ?? [];
      l.push(toShare(r));
      mine.set(r.resource_id, l);
    }
    idx.mine.set(key, mine);
  }
  return (mine.get(id) ?? []).filter((s) => shareActive(s));
}

/** Whether a resource's scope is Restricted: instance roles give nothing there (ADR 0033 part 1). */
export function isRestricted(kind: OwnedKind, id: string): boolean {
  const over = overlayOf(kind, id)?.restricted;
  if (over !== undefined) return over;
  const idx = index();
  if (!idx) return !!db().get('SELECT 1 FROM resource_restrictions WHERE kind = ? AND resource_id = ?', kind, id);
  let set = idx.restricted.get(kind);
  if (!set) {
    set = new Set(
      db()
        .all<{ resource_id: string }>('SELECT resource_id FROM resource_restrictions WHERE kind = ?', kind)
        .map((r) => r.resource_id),
    );
    idx.restricted.set(kind, set);
  }
  return set.has(id);
}

/** Forget what this request read (after changing shares or a scope). */
export function sharesChanged(): void {
  const idx = currentStore()?.shareIndex;
  if (!idx) return;
  idx.mine.clear();
  idx.restricted.clear();
}

/**
 * Runs `fn` as if a resource had these shares and this scope (a preview of a change: who gains, who loses). Only
 * this request sees it; nothing is stored. Left-out parts keep the stored state.
 */
export function withShareState<T>(kind: OwnedKind, id: string, state: { shares?: ResourceShare[]; restricted?: boolean }, fn: () => T): T {
  const idx = index();
  if (!idx) throw new Error('withShareState needs a request');
  const saved = idx.overlay;
  idx.overlay = new Map(saved ?? []);
  idx.overlay.set(`${kind}:${id}`, { ...saved?.get(`${kind}:${id}`), ...state });
  try {
    return fn();
  } finally {
    idx.overlay = saved;
  }
}
