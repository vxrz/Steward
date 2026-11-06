import { z } from 'zod';

/**
 * changedetection.io (#242): an instance that runs separately (its own container, with its own browser for JavaScript
 * pages) watches vendor changelogs, terms and pricing pages, status pages and documentation. Steward only connects to
 * its REST API, read-only, with the API key in the header x-api-key: the watches become components of the platform
 * (optionally linked to an application, a service or a vendor, with their tags), the monitor check "Page watch" judges
 * them, and changedetection.io's notifications start processes through a webhook trigger. Steward never stores page
 * contents – only metadata and the link to the diff in changedetection.io.
 */

export const CHANGEDETECTION_KIND = 'changedetection';

/** A watch's id in changedetection.io (a UUID). */
export const PAGE_WATCH_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PAGE_WATCH_LIMITS = {
  /** The watch list of a platform is read again after this many hours (or on "Read now") */
  refreshHours: 1,
  /** Watches kept per platform (more are left out of the list and counted) */
  watches: 5000,
  title: 300,
  url: 2000,
  tags: 50,
  tag: 100,
  /** Characters of a watch's last error kept */
  error: 500,
  vendor: 120,
  /** Snapshot times shown in a watch's history */
  history: 50,
} as const;

/**
 * ok: checked, no error; failing: the last check ended in an error (fetch error, filter not found …); paused: paused in
 * changedetection.io; unchecked: not checked yet; removed: no longer in changedetection.io (kept while it is linked).
 */
export const PAGE_WATCH_STATES = ['ok', 'failing', 'paused', 'unchecked', 'removed'] as const;
export type PageWatchState = (typeof PAGE_WATCH_STATES)[number];

/** A linked application or service, as the reader may see it (a hidden one has no name and no path). */
export interface PageWatchTarget {
  id: string | null;
  label: string;
  path: string | null;
  visible: boolean;
}

export interface PageWatch {
  uuid: string;
  /** The watch's own title, else the page's title, else its URL */
  title: string;
  /** The page it watches */
  url: string;
  /** Tag names in changedetection.io */
  tags: string[];
  state: PageWatchState;
  paused: boolean;
  lastCheckedAt: string | null;
  /** The newest change (null: no change since the first snapshot) */
  lastChangedAt: string | null;
  /** The last check's error message (metadata, never page content) */
  lastError: string | null;
  /** The diff page of the watch in changedetection.io's own UI */
  diffUrl: string;
  removedAt: string | null;
  application: PageWatchTarget | null;
  service: PageWatchTarget | null;
  vendor: string;
  linkedAt: string | null;
  linkedBy: string | null;
}

export interface PageWatchList {
  platform: { id: string; name: string };
  /** changedetection.io's UI, for links (the variable uiUrl, else the base URL) */
  uiUrl: string;
  readAt: string | null;
  readBy: string | null;
  /** The last read failed: why */
  error: string | null;
  /** Watches changedetection.io reported at the last read (more than PAGE_WATCH_LIMITS.watches are not kept) */
  total: number;
  watches: PageWatch[];
  /** All tag names of the watches */
  tags: string[];
  /** May read the watches now (use right on the platform) */
  canRead: boolean;
  /** May link watches to applications, services and vendors (manage right on the platform) */
  canLink: boolean;
}

/** Snapshot times of a watch – metadata of its history, never a snapshot itself. */
export interface PageWatchHistory {
  uuid: string;
  /** Snapshots changedetection.io keeps (the first one is the initial fetch, every later one a change) */
  count: number;
  /** Times of the newest snapshots, newest first (at most PAGE_WATCH_LIMITS.history) */
  snapshots: string[];
  diffUrl: string;
}

/** Links of a watch: missing fields stay as they are, null (or an empty vendor) removes the link. */
export const pageWatchLinkInput = z
  .object({
    applicationId: z.string().trim().min(1).max(100).nullable().optional(),
    serviceId: z.string().trim().min(1).max(100).nullable().optional(),
    vendor: z.string().trim().max(PAGE_WATCH_LIMITS.vendor).optional(),
  })
  .strict();
export type PageWatchLinkInput = z.infer<typeof pageWatchLinkInput>;
