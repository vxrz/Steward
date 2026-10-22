import { db } from '../db.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { fetchSource, isFetching } from './fetch.js';

/**
 * Scheduled fetches: once a minute, every enabled source whose interval has passed since its
 * last fetch is fetched (one at a time per source). Off by default – a source has no schedule
 * until an administrator sets an interval.
 */

let timer: NodeJS.Timeout | undefined;

export function dueSources(now = Date.now()): string[] {
  return db()
    .all<{ id: string; interval_minutes: number; last_fetch_at: string | null }>(
      'SELECT id, interval_minutes, last_fetch_at FROM sync_sources WHERE enabled = 1 AND interval_minutes > 0',
    )
    .filter((r) => !r.last_fetch_at || now - Date.parse(r.last_fetch_at) >= r.interval_minutes * 60000)
    .map((r) => r.id);
}

export async function tick(): Promise<void> {
  if (!vault().unlocked) return;
  for (const id of dueSources()) {
    if (isFetching(id)) continue;
    await fetchSource(id, 'schedule').catch((e) => logger.warn({ sourceId: id, err: (e as Error).message }, 'scheduled git sync failed'));
  }
}

export function startGitSync(): void {
  if (timer) return;
  timer = setInterval(() => void tick().catch(() => undefined), 60_000);
  timer.unref();
}

export function stopGitSync(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
