import { useEffect } from 'react';

/** Kinds of entries the command palette lists under "Recent" (icon and group). */
export type RecentKind =
  | 'run'
  | 'process'
  | 'monitor'
  | 'dashboard'
  | 'platform'
  | 'service'
  | 'application'
  | 'system'
  | 'record'
  | 'ticket'
  | 'duty'
  | 'personReview'
  | 'statusPage'
  | 'credential';

export interface RecentItem {
  to: string;
  label: string;
  kind: RecentKind;
  at: number;
}

export const RECENT_MAX = 10;
const key = (userId: string) => `sm.recent.${userId}`;
/** Who is signed in: set by the shell, so pages need not pass the user around. */
let currentUser = '';
export const setRecentUser = (userId: string) => {
  currentUser = userId;
};

/** The last {@link RECENT_MAX} entries the user opened in this browser, newest first. */
export function readRecent(userId = currentUser): RecentItem[] {
  if (!userId) return [];
  try {
    const v = JSON.parse(localStorage.getItem(key(userId)) ?? '[]') as unknown;
    return Array.isArray(v)
      ? (v as RecentItem[]).filter((x) => x && typeof x.to === 'string' && typeof x.label === 'string' && typeof x.kind === 'string').slice(0, RECENT_MAX)
      : [];
  } catch {
    return [];
  }
}

export function rememberRecent(item: Omit<RecentItem, 'at'>, userId = currentUser): void {
  if (!userId || !item.label) return;
  const next = [{ ...item, at: Date.now() }, ...readRecent(userId).filter((x) => x.to !== item.to)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(key(userId), JSON.stringify(next));
  } catch {
    /* storage blocked: nothing to remember */
  }
}

/** Remember the entry a detail page shows (once it has loaded and has a name). */
export function useRememberRecent(item: Omit<RecentItem, 'at'> | null | undefined): void {
  const to = item?.to;
  const label = item?.label;
  const kind = item?.kind;
  useEffect(() => {
    if (to && label && kind) rememberRecent({ to, label, kind });
  }, [to, label, kind]);
}
