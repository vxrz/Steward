/**
 * Which backups to keep (#117): grandfather–father–son. The newest backup of each of the last `daily` days that have
 * one, of each of the last `weekly` ISO weeks and of each of the last `monthly` months (UTC) – and always the newest
 * backup. Counted over days that have a backup, so when backups stop, the old ones are not deleted day by day.
 */

export interface RetentionPolicy {
  daily: number;
  weekly: number;
  monthly: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { daily: 7, weekly: 4, monthly: 12 };

const day = (d: Date) => d.toISOString().slice(0, 10);
const month = (d: Date) => d.toISOString().slice(0, 7);

/** ISO 8601 week, e.g. 2026-W44. */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const wd = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - wd); // the Thursday of this week decides the year
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** The items to keep, and why (daily / weekly / monthly / newest). */
export function retained<T>(items: T[], when: (t: T) => Date, policy: RetentionPolicy): Map<T, string[]> {
  const sorted = [...items].filter((i) => !Number.isNaN(when(i).getTime())).sort((a, b) => when(b).getTime() - when(a).getTime());
  const keep = new Map<T, string[]>();
  const mark = (t: T, why: string) => keep.set(t, [...(keep.get(t) ?? []), why]);
  if (sorted[0]) mark(sorted[0], 'newest');
  const rule = (bucket: (d: Date) => string, n: number, why: string) => {
    const seen = new Set<string>();
    for (const t of sorted) {
      if (seen.size >= n) break;
      const b = bucket(when(t));
      if (seen.has(b)) continue;
      seen.add(b);
      mark(t, why);
    }
  };
  rule(day, policy.daily, 'daily');
  rule(isoWeek, policy.weekly, 'weekly');
  rule(month, policy.monthly, 'monthly');
  return keep;
}
