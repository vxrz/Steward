import type { SupplierRef } from './suppliers.js';
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
  /** The supplier (0.17.0, ADR 0029; null: none, or one the reader may not see); `vendor` is the fallback text */
  supplier: SupplierRef | null;
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
    /** The supplier (0.17.0, ADR 0029): missing keeps it, null clears it; `vendor` stays as text */
    supplierId: z.string().trim().min(1).max(100).nullable().optional(),
  })
  .strict();
export type PageWatchLinkInput = z.infer<typeof pageWatchLinkInput>;

/** Query parameter names that carry a credential: these parts anywhere in the name, or these words of it (lower case). */
const SECRET_QUERY_PARTS = ['token', 'secret', 'password', 'passwd', 'apikey', 'credential'];
const SECRET_QUERY_WORDS = new Set(['key', 'pwd', 'pass', 'sig', 'signature', 'auth', 'session', 'sid', 'code', 'jwt']);

function secretQueryName(k: string): boolean {
  const name = k.toLowerCase();
  return SECRET_QUERY_PARTS.some((p) => name.includes(p)) || name.split(/[^a-z0-9]+/).some((w) => SECRET_QUERY_WORDS.has(w));
}
const RANDOM_CHARS = /^[A-Za-z0-9+/=_.~-]+$/;

/** A query value that looks like a credential: long, random-looking (letters and digits mixed). */
function randomLooking(v: string): boolean {
  return v.length >= 24 && RANDOM_CHARS.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v);
}

/**
 * A watch's URL as Steward keeps and shows it (0.9.0): http(s) only, without user info (user:password@) and fragment,
 * with the values of secret-looking query parameters (token, key, signature, password … or a long random value)
 * replaced by ***. Anything that is not an http(s) URL becomes an empty string. Text, no regular expression on input.
 */
export function watchUrlWithoutCredentials(raw: string): string {
  const text = raw.trim();
  // changedetection.io's "source:" prefix (the page source is watched) – the URL follows it
  const prefix = text.toLowerCase().startsWith('source:') ? text.slice(0, 7) : '';
  let u: URL;
  try {
    u = new URL(text.slice(prefix.length));
  } catch {
    return '';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  u.username = '';
  u.password = '';
  u.hash = '';
  const params = [...u.searchParams.entries()];
  if (params.length) {
    const masked = new URLSearchParams();
    for (const [k, v] of params) {
      masked.append(k, v && (secretQueryName(k) || randomLooking(v)) ? '***' : v);
    }
    u.search = masked.toString();
  }
  return prefix + u.toString();
}
