import { useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { AppNotification } from '@sm/shared';
import { getOptional, post } from '../../api';
import { browserNotifyActive, showBrowserNotification } from './browserNotify';

export interface NotificationList {
  items: AppNotification[];
  unread: number;
  /** The server has no notification endpoints (yet) */
  unavailable?: boolean;
}

const KEY = ['notifications'];
const EMPTY: NotificationList = { items: [], unread: 0, unavailable: true };

/** Polls the notification list every 30 s while the tab is visible. */
export function useNotifications() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => getOptional<NotificationList>('/notifications?limit=50', EMPTY),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 10_000,
  });
}

export function useNotificationActions() {
  const qc = useQueryClient();
  return useMemo(() => {
    const patchCache = (fn: (l: NotificationList) => NotificationList) => qc.setQueryData<NotificationList>(KEY, (old) => (old ? fn(old) : old));
    return {
      markRead: async (id: string) => {
        patchCache((l) => {
          const was = l.items.find((n) => n.id === id && !n.read);
          return { ...l, unread: Math.max(0, l.unread - (was ? 1 : 0)), items: l.items.map((n) => (n.id === id ? { ...n, read: true } : n)) };
        });
        try {
          await post(`/notifications/${encodeURIComponent(id)}/read`);
        } catch {
          /* next poll corrects the state */
        }
      },
      markAllRead: async () => {
        patchCache((l) => ({ ...l, unread: 0, items: l.items.map((n) => ({ ...n, read: true })) }));
        try {
          await post('/notifications/read-all');
        } finally {
          qc.invalidateQueries({ queryKey: KEY });
        }
      },
    };
  }, [qc]);
}

/** Shows a browser notification once for every unread item that arrives after the app was opened. */
export function useBrowserNotificationBridge(list: NotificationList | undefined) {
  const seen = useRef<Set<string> | null>(null);
  const navigate = useNavigate();
  const { markRead } = useNotificationActions();
  useEffect(() => {
    if (!list || list.unavailable) return;
    if (!seen.current) {
      // First load: everything already there counts as seen.
      seen.current = new Set(list.items.map((n) => n.id));
      return;
    }
    const fresh = list.items.filter((n) => !n.read && !seen.current!.has(n.id));
    for (const n of list.items) seen.current.add(n.id);
    if (!fresh.length || !browserNotifyActive()) return;
    // Oldest first, at most 3 at once – the bell shows the rest.
    for (const n of fresh.slice(0, 3).reverse()) {
      showBrowserNotification(n.title, n.body, `sm-${n.id}`, () => {
        markRead(n.id);
        if (n.link) navigate(n.link);
      });
    }
  }, [list, navigate, markRead]);
}
