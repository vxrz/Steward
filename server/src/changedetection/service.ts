import {
  CHANGEDETECTION_KIND,
  PAGE_WATCH_LIMITS,
  PAGE_WATCH_UUID_RE,
  type PageWatch,
  type PageWatchHistory,
  type PageWatchLinkInput,
  type PageWatchList,
  type PageWatchState,
  type PageWatchTarget,
  type Platform,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { getPlatform } from '../platforms/service.js';
import { platformFor } from '../monitors/platforms.js';
import { resolveTarget } from '../records/links.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import { CdClient, diffUrlOf, uiUrlOf, type CdWatch } from './client.js';

/**
 * The watches of a changedetection.io platform as its components (#242): read from the API (metadata only), kept per
 * platform with their links to an application, a service or a vendor, read again in the background every hour with the
 * rights of the person who read them last. A watch that disappears from changedetection.io is deleted – unless it is
 * linked: then it is kept as "removed", so the link is not lost silently.
 */

interface Row {
  platform_id: string;
  uuid: string;
  title: string;
  url: string;
  tags: string;
  paused: number;
  last_checked_at: string | null;
  last_changed_at: string | null;
  last_error: string | null;
  seen_at: string;
  removed_at: string | null;
  application_id: string | null;
  service_id: string | null;
  vendor: string;
  linked_at: string | null;
  linked_by: string | null;
}

interface ReadRow {
  platform_id: string;
  read_at: string | null;
  read_by: string;
  attempted_at: string;
  error: string | null;
  total: number;
}

const notFound = (id: string) => new HttpError(404, `Platform ${id} not found`, 'PLATFORM_NOT_FOUND', { id });

/** A changedetection.io platform the current user has a right on (404 otherwise, so ids cannot be probed). */
export function cdPlatform(id: string, need?: 'use' | 'manage'): Platform {
  let p: Platform;
  try {
    p = getPlatform(id);
  } catch {
    throw notFound(id);
  }
  if (!p.permissions.length) throw notFound(id);
  if (p.kind !== CHANGEDETECTION_KIND)
    throw new HttpError(400, 'Page watches are only available for changedetection.io platforms', 'CHANGEDETECTION_PLATFORM_REQUIRED');
  if (need && !p.permissions.includes(need))
    throw new HttpError(403, `You are not allowed to ${need === 'manage' ? 'configure' : 'use'} this platform`, 'FORBIDDEN', {
      context: need === 'manage' ? 'managePlatform' : 'usePlatform',
    });
  return p;
}

const stateOf = (r: Row): PageWatchState =>
  r.removed_at ? 'removed' : r.paused ? 'paused' : r.last_error ? 'failing' : r.last_checked_at ? 'ok' : 'unchecked';

/** A linked application or service as the reader may see it: a hidden one has neither name nor path. */
function target(kind: 'application' | 'service', id: string | null): PageWatchTarget | null {
  if (!id) return null;
  const t = resolveTarget(kind, id);
  return t ? { id, label: t.label, path: t.path, visible: true } : { id: null, label: '', path: null, visible: false };
}

function toWatch(r: Row, ui: string): PageWatch {
  return {
    uuid: r.uuid,
    title: r.title,
    url: r.url,
    tags: parseJson<string[]>(r.tags, []),
    state: stateOf(r),
    paused: !!r.paused,
    lastCheckedAt: r.last_checked_at,
    lastChangedAt: r.last_changed_at,
    lastError: r.last_error,
    diffUrl: diffUrlOf(ui, r.uuid),
    removedAt: r.removed_at,
    application: target('application', r.application_id),
    service: target('service', r.service_id),
    vendor: r.vendor,
    linkedAt: r.linked_at,
    linkedBy: r.linked_by,
  };
}

const linked = (r: Pick<Row, 'application_id' | 'service_id' | 'vendor'>) => !!(r.application_id || r.service_id || r.vendor);

export function listWatches(platformId: string): PageWatchList {
  const p = cdPlatform(platformId);
  const ui = uiUrlOf(p);
  const read = db().get<ReadRow>('SELECT * FROM cd_reads WHERE platform_id = ?', p.id);
  const watches = db()
    .all<Row>('SELECT * FROM cd_watches WHERE platform_id = ? ORDER BY lower(title), uuid', p.id)
    .map((r) => toWatch(r, ui));
  return {
    platform: { id: p.id, name: p.name },
    uiUrl: ui,
    readAt: read?.read_at ?? null,
    readBy: read?.read_by ?? null,
    error: read?.error ?? null,
    total: read?.total ?? 0,
    watches,
    tags: [...new Set(watches.flatMap((w) => w.tags))].sort((a, b) => a.localeCompare(b)),
    canRead: p.permissions.includes('use'),
    canLink: p.permissions.includes('manage'),
  };
}

const sameAs = (r: Row, w: CdWatch, tags: string) =>
  !r.removed_at &&
  r.title === w.title &&
  r.url === w.url &&
  r.tags === tags &&
  !!r.paused === w.paused &&
  r.last_checked_at === w.lastCheckedAt &&
  r.last_changed_at === w.lastChangedAt &&
  r.last_error === w.lastError;

/** Stores a read: changed watches are written, vanished ones deleted (linked ones kept as removed). */
function store(platformId: string, read: { total: number; watches: CdWatch[] }, actor: string, at: string): void {
  db().tx(() => {
    const existing = new Map(
      db()
        .all<Row>('SELECT * FROM cd_watches WHERE platform_id = ?', platformId)
        .map((r) => [r.uuid, r]),
    );
    for (const w of read.watches) {
      const old = existing.get(w.uuid);
      existing.delete(w.uuid);
      const tags = JSON.stringify(w.tags);
      if (old && sameAs(old, w, tags)) continue;
      if (old)
        db().run(
          `UPDATE cd_watches SET title = ?, url = ?, tags = ?, paused = ?, last_checked_at = ?, last_changed_at = ?, last_error = ?, removed_at = NULL
           WHERE platform_id = ? AND uuid = ?`,
          w.title,
          w.url,
          tags,
          w.paused ? 1 : 0,
          w.lastCheckedAt,
          w.lastChangedAt,
          w.lastError,
          platformId,
          w.uuid,
        );
      else
        db().run(
          `INSERT INTO cd_watches (platform_id, uuid, title, url, tags, paused, last_checked_at, last_changed_at, last_error, seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          platformId,
          w.uuid,
          w.title,
          w.url,
          tags,
          w.paused ? 1 : 0,
          w.lastCheckedAt,
          w.lastChangedAt,
          w.lastError,
          at,
        );
    }
    for (const old of existing.values()) {
      if (!linked(old)) db().run('DELETE FROM cd_watches WHERE platform_id = ? AND uuid = ?', platformId, old.uuid);
      else if (!old.removed_at) db().run('UPDATE cd_watches SET removed_at = ? WHERE platform_id = ? AND uuid = ?', at, platformId, old.uuid);
    }
    db().run(
      `INSERT INTO cd_reads (platform_id, read_at, read_by, attempted_at, error, total) VALUES (?, ?, ?, ?, NULL, ?)
       ON CONFLICT(platform_id) DO UPDATE SET read_at = excluded.read_at, read_by = excluded.read_by, attempted_at = excluded.attempted_at,
         error = NULL, total = excluded.total`,
      platformId,
      at,
      actor,
      at,
      read.total,
    );
  });
}

function storeError(platformId: string, actor: string, at: string, error: string): void {
  db().run(
    `INSERT INTO cd_reads (platform_id, read_at, read_by, attempted_at, error, total) VALUES (?, NULL, ?, ?, ?, 0)
     ON CONFLICT(platform_id) DO UPDATE SET read_by = excluded.read_by, attempted_at = excluded.attempted_at, error = excluded.error`,
    platformId,
    actor,
    at,
    error.slice(0, 1000),
  );
}

/**
 * Reads the watches of a platform now, with the rights of `actor` (who must be allowed to use the platform; the
 * background job reads again as the same person). Failures are stored on the platform and thrown.
 */
export async function refreshWatches(platformId: string, actor: string, now = Date.now()): Promise<{ total: number; kept: number; failing: number }> {
  const at = new Date(now).toISOString();
  let access;
  try {
    access = platformFor(actor, platformId);
  } catch (e) {
    // e.g. the person who read it last may no longer use the platform: shown on the platform until someone reads it
    if (db().get('SELECT 1 FROM platforms WHERE id = ?', platformId)) storeError(platformId, actor, at, (e as Error).message);
    throw e;
  }
  const { platform, secrets } = access;
  if (platform.kind !== CHANGEDETECTION_KIND)
    throw new HttpError(400, 'Page watches are only available for changedetection.io platforms', 'CHANGEDETECTION_PLATFORM_REQUIRED');
  let read;
  try {
    read = await new CdClient(platform, secrets, AbortSignal.timeout(60_000)).watches();
  } catch (e) {
    storeError(platformId, actor, at, (e as Error).message);
    throw e;
  }
  store(platformId, read, actor, at);
  return { total: read.total, kept: read.watches.length, failing: read.watches.filter((w) => w.lastError && !w.paused).length };
}

/** Snapshot times of a watch (read now; use right on the platform). */
export async function watchHistory(platformId: string, uuid: string, actor: string): Promise<PageWatchHistory> {
  const p = cdPlatform(platformId, 'use');
  if (!PAGE_WATCH_UUID_RE.test(uuid)) throw new HttpError(404, 'No such watch', 'PAGE_WATCH_NOT_FOUND');
  const { platform, secrets } = platformFor(actor, p.id);
  const h = await new CdClient(platform, secrets, AbortSignal.timeout(30_000)).history(uuid);
  if (!h) throw new HttpError(404, 'No such watch', 'PAGE_WATCH_NOT_FOUND');
  return { uuid: uuid.toLowerCase(), count: h.count, snapshots: h.snapshots, diffUrl: diffUrlOf(uiUrlOf(p), uuid.toLowerCase()) };
}

/** Links a watch to an application, a service or a vendor (manage right on the platform; the targets must be visible). */
export function setWatchLink(platformId: string, uuid: string, input: PageWatchLinkInput, actor: string): PageWatch {
  const p = cdPlatform(platformId, 'manage');
  const row = PAGE_WATCH_UUID_RE.test(uuid)
    ? db().get<Row>('SELECT * FROM cd_watches WHERE platform_id = ? AND uuid = ?', p.id, uuid.toLowerCase())
    : undefined;
  if (!row) throw new HttpError(404, 'No such watch', 'PAGE_WATCH_NOT_FOUND');
  // a hidden application or service reads like a missing one
  if (input.applicationId && !resolveTarget('application', input.applicationId))
    throw new HttpError(404, `Application ${input.applicationId} not found`, 'APPLICATION_NOT_FOUND', { id: input.applicationId });
  if (input.serviceId && !resolveTarget('service', input.serviceId))
    throw new HttpError(404, `Service ${input.serviceId} not found`, 'SERVICE_NOT_FOUND', { id: input.serviceId });
  const next = {
    application_id: input.applicationId === undefined ? row.application_id : input.applicationId,
    service_id: input.serviceId === undefined ? row.service_id : input.serviceId,
    vendor: input.vendor === undefined ? row.vendor : input.vendor.slice(0, PAGE_WATCH_LIMITS.vendor),
  };
  if (next.application_id === row.application_id && next.service_id === row.service_id && next.vendor === row.vendor) return toWatch(row, uiUrlOf(p));
  const at = nowIso();
  db().tx(() => {
    if (row.removed_at && !linked(next)) db().run('DELETE FROM cd_watches WHERE platform_id = ? AND uuid = ?', p.id, row.uuid);
    else
      db().run(
        'UPDATE cd_watches SET application_id = ?, service_id = ?, vendor = ?, linked_at = ?, linked_by = ? WHERE platform_id = ? AND uuid = ?',
        next.application_id,
        next.service_id,
        next.vendor,
        at,
        actor,
        p.id,
        row.uuid,
      );
    const parts = [
      next.application_id ? `application "${resolveTarget('application', next.application_id)?.label ?? next.application_id}"` : null,
      next.service_id ? `service "${resolveTarget('service', next.service_id)?.label ?? next.service_id}"` : null,
      next.vendor ? `vendor "${next.vendor}"` : null,
    ].filter(Boolean);
    audit({
      action: 'changedetection.watch_linked',
      entityType: 'platform',
      entityId: p.id,
      summary: `Page watch "${row.title}" of "${p.name}" ${parts.length ? `linked to ${parts.join(', ')}` : 'no longer linked'}`,
      details: {
        uuid: row.uuid,
        applicationId: next.application_id,
        serviceId: next.service_id,
        vendor: next.vendor,
        previous: { applicationId: row.application_id, serviceId: row.service_id, vendor: row.vendor },
      },
    });
  });
  const after = db().get<Row>('SELECT * FROM cd_watches WHERE platform_id = ? AND uuid = ?', p.id, row.uuid);
  return toWatch(after ?? { ...row, ...next, linked_at: at, linked_by: actor }, uiUrlOf(p));
}

/** Background job: platforms read before are read again every PAGE_WATCH_LIMITS.refreshHours, as the person who read them last. */
export async function runChangedetectionJob(now = Date.now()): Promise<number> {
  if (!vault().unlocked) return 0;
  const rows = db().all<ReadRow>(
    'SELECT r.* FROM cd_reads r JOIN platforms p ON p.id = r.platform_id WHERE p.kind = ? ORDER BY r.attempted_at',
    CHANGEDETECTION_KIND,
  );
  let n = 0;
  for (const r of rows) {
    const age = now - Date.parse(r.attempted_at);
    if (age >= 0 && age < PAGE_WATCH_LIMITS.refreshHours * 3_600_000) continue;
    try {
      await refreshWatches(r.platform_id, r.read_by, now);
      n++;
    } catch (err) {
      logger.warn({ err: (err as Error).message, platform: r.platform_id }, 'reading the watches of changedetection.io failed');
    }
  }
  return n;
}
