import { db } from '../db.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { parseJson } from '../util.js';
import { fetchSource, isFetching } from './fetch.js';

/**
 * Scheduled fetches: once a minute, every enabled source whose interval has passed since its
 * last fetch is fetched (one at a time per source) – unless its last fetch ran into the Git host's
 * rate limit and the host named a later time. Off by default – a source has no schedule until an
 * administrator sets an interval. Run by the job runner (features/sync.ts, job "git-sync").
 */

export function dueSources(now = Date.now()): string[] {
  return db()
    .all<{ id: string; interval_minutes: number; last_fetch_at: string | null; last_status: string | null; last_error_detail: string | null }>(
      'SELECT id, interval_minutes, last_fetch_at, last_status, last_error_detail FROM sync_sources WHERE enabled = 1 AND interval_minutes > 0',
    )
    .filter((r) => !r.last_fetch_at || now - Date.parse(r.last_fetch_at) >= r.interval_minutes * 60000)
    .filter((r) => !rateLimitedUntil(r, now))
    .map((r) => r.id);
}

/** A source whose last fetch ran into the Git host's rate limit waits until the time the host named (0.20.0). */
function rateLimitedUntil(r: { last_status: string | null; last_error_detail: string | null }, now: number): boolean {
  if (r.last_status !== 'error' || !r.last_error_detail) return false;
  const d = parseJson<{ code?: unknown; params?: { retryAt?: unknown } } | null>(r.last_error_detail, null);
  if (d?.code !== 'GIT_RATE_LIMITED' || typeof d.params?.retryAt !== 'string') return false;
  const at = Date.parse(d.params.retryAt);
  return Number.isFinite(at) && at > now;
}

export async function tick(): Promise<void> {
  if (!vault().unlocked) return;
  for (const id of dueSources()) {
    if (isFetching(id)) continue;
    await fetchSource(id, 'schedule').catch((e) => logger.warn({ sourceId: id, err: (e as Error).message }, 'scheduled git sync failed'));
  }
}
