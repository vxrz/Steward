/** Optional daily summary per user (server/src/notifications/summary.ts, docs/NOTIFICATIONS.md). */

export const DAILY_SUMMARY_SECTIONS = ['runs', 'tasks', 'monitors', 'credentials', 'tickets', 'records', 'reviews', 'duties', 'reports'] as const;
export type DailySummarySection = (typeof DAILY_SUMMARY_SECTIONS)[number];

export interface DailySummaryPrefs {
  enabled: boolean;
  /** Local time of day, HH:MM */
  time: string;
  /** IANA time zone, e.g. Europe/Berlin */
  timeZone: string;
  days: 'weekdays' | 'everyday';
  channel: 'inApp' | 'inAppEmail';
  sections: DailySummarySection[];
  /** Send nothing on days without anything to report */
  skipEmpty: boolean;
}

export const DEFAULT_DAILY_SUMMARY: DailySummaryPrefs = {
  enabled: false,
  time: '07:30',
  timeZone: 'UTC',
  days: 'weekdays',
  channel: 'inApp',
  sections: [...DAILY_SUMMARY_SECTIONS],
  skipEmpty: true,
};

export interface DailySummaryState {
  prefs: DailySummaryPrefs;
  /** Administrators allow daily summaries (Settings → Notifications) */
  allowed: boolean;
  /** E-mail can be delivered to this user: SMTP on, the event routed to e-mail, an allowed address, e-mail notifications on */
  emailAvailable: boolean;
  /** Why e-mail is not available (a short code), or null */
  emailBlockedReason: 'smtpOff' | 'routeOff' | 'noAddress' | 'optedOut' | 'domainNotAllowed' | null;
  lastSentAt: string | null;
}

export interface DailySummarySubscriber {
  username: string;
  displayName: string;
  time: string;
  timeZone: string;
  days: DailySummaryPrefs['days'];
  channel: DailySummaryPrefs['channel'];
  lastSentAt: string | null;
}

export interface DailySummaryAdmin {
  allowed: boolean;
  subscribers: DailySummarySubscriber[];
}

/** One item of a summary section, already filtered for the recipient. */
export interface DailySummaryItem {
  title: string;
  detail?: string;
  /** In-app path */
  link?: string;
  tone?: 'bad' | 'attention' | 'ok' | 'info';
}

export interface DailySummaryContent {
  since: string;
  until: string;
  sections: { id: DailySummarySection; count: number; items: DailySummaryItem[]; more: number }[];
  empty: boolean;
}
