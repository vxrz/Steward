import { PAGE_WATCH_LIMITS, PAGE_WATCH_UUID_RE, type Platform } from '@sm/shared';
import { buildUrl, platformRequest } from '../platforms/http.js';
import { assertOutboundAllowed } from '../platforms/outbound.js';
import { outboundContext } from '../platforms/policyContext.js';

/**
 * The changedetection.io REST API (#242), read-only, with the API key in the header x-api-key (Settings → API in
 * changedetection.io). The platform's base URL is the instance's root (https://changes.example.com); the API is below
 * /api/v1. Checked against docs/api-spec.yaml (API 0.1.9) and changedetectionio/api/Watch.py on master:
 *
 *   GET /api/v1/watch                  all watches: uuid → { title, url, link, page_title, tags (tag UUIDs), paused,
 *                                      last_checked, last_changed (unix seconds, 0: never), last_error (false or text) }
 *   GET /api/v1/tags                   tag UUID → { title, … }
 *   GET /api/v1/watch/{uuid}/history   snapshot time (unix seconds) → path of the snapshot file (only the times are kept)
 *   GET /api/v1/systeminfo             version, watch_count, queue_size (the connection test)
 *
 * Never called: the snapshot and diff endpoints (page contents), the state-changing parameters (recheck, paused,
 * muted) and every write – the platform kind refuses them (platforms/deniedPaths.ts). Every answer is untrusted:
 * only known fields are read, strings are cut to their limits, ids must be UUIDs.
 */

export interface CdWatch {
  uuid: string;
  title: string;
  url: string;
  tags: string[];
  paused: boolean;
  lastCheckedAt: string | null;
  lastChangedAt: string | null;
  lastError: string | null;
}

/** Unix seconds (as changedetection.io sends them; 0, false or null: never) → ISO time. */
export function unixToIso(v: unknown): string | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  // after 2000-01-01 and before 2200 – anything else is not a real time
  if (!Number.isFinite(n) || n < 946_684_800 || n > 7_258_118_400) return null;
  return new Date(Math.round(n * 1000)).toISOString();
}

/** Printable text of at most `max` characters (control characters become spaces). */
export function clip(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  let out = '';
  for (const ch of v) {
    const c = ch.codePointAt(0)!;
    out += c < 32 || c === 127 ? ' ' : ch;
    if (out.length >= max) break;
  }
  return out.trim().slice(0, max);
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** One entry of GET /api/v1/watch, or null when it is not a watch. */
export function parseWatch(uuid: string, raw: unknown, tagNames: Map<string, string>): CdWatch | null {
  if (!PAGE_WATCH_UUID_RE.test(uuid) || !isObject(raw)) return null;
  const link = clip(raw.link, PAGE_WATCH_LIMITS.url) || clip(raw.url, PAGE_WATCH_LIMITS.url);
  const title = clip(raw.title, PAGE_WATCH_LIMITS.title) || clip(raw.page_title, PAGE_WATCH_LIMITS.title) || link.slice(0, PAGE_WATCH_LIMITS.title);
  const tags: string[] = [];
  for (const id of Array.isArray(raw.tags) ? raw.tags.slice(0, 200) : []) {
    const name = typeof id === 'string' ? tagNames.get(id.toLowerCase()) : undefined;
    if (name && !tags.includes(name) && tags.length < PAGE_WATCH_LIMITS.tags) tags.push(name);
  }
  // last_error: false (no error), a text, or null (not checked yet)
  const err = typeof raw.last_error === 'string' ? clip(raw.last_error, PAGE_WATCH_LIMITS.error) : '';
  return {
    uuid: uuid.toLowerCase(),
    title: title || uuid,
    url: link,
    tags: tags.sort((a, b) => a.localeCompare(b)),
    paused: raw.paused === true,
    lastCheckedAt: unixToIso(raw.last_checked),
    lastChangedAt: unixToIso(raw.last_changed),
    lastError: err || null,
  };
}

export class CdClient {
  constructor(
    readonly p: Platform,
    private readonly secrets: Record<string, string>,
    private readonly signal?: AbortSignal,
  ) {}

  private async get<T>(path: string, optional = false): Promise<T | null> {
    // the instance's host goes through the outbound policy like process steps (docs/CHANGEDETECTION.md)
    await assertOutboundAllowed(await buildUrl(this.p, this.secrets, path, {}), outboundContext());
    const r = await platformRequest(this.p, this.secrets, { method: 'GET', url: path, maxResponseBytes: 32 * 1024 * 1024 }, this.signal);
    if (optional && r.status === 404) return null;
    if (!r.ok) {
      const hint = r.status === 403 || r.status === 401 ? ' – check the API key (Settings → API in changedetection.io)' : '';
      throw Object.assign(new Error(`changedetection.io answered HTTP ${r.status} for ${path}${hint}`), { status: r.status });
    }
    if (typeof r.body === 'string') throw new Error(`changedetection.io did not answer JSON for ${path}`);
    return r.body as T;
  }

  /** Version and number of watches (GET /api/v1/systeminfo). */
  async systemInfo(): Promise<{ version: string; watchCount: number | null }> {
    const b = await this.get<Record<string, unknown>>('/api/v1/systeminfo');
    return { version: clip(b?.version, 40) || '?', watchCount: typeof b?.watch_count === 'number' ? b.watch_count : null };
  }

  /** Tag UUID (lower case) → name. Older versions without /api/v1/tags: none. */
  async tagNames(): Promise<Map<string, string>> {
    const b = await this.get<unknown>('/api/v1/tags', true);
    const out = new Map<string, string>();
    if (!isObject(b)) return out;
    for (const [id, t] of Object.entries(b)) {
      if (!PAGE_WATCH_UUID_RE.test(id) || !isObject(t)) continue;
      const name = clip(t.title, PAGE_WATCH_LIMITS.tag);
      if (name) out.set(id.toLowerCase(), name);
    }
    return out;
  }

  /** Every watch, metadata only, in the order changedetection.io lists them; at most PAGE_WATCH_LIMITS.watches. */
  async watches(): Promise<{ total: number; watches: CdWatch[] }> {
    const tags = await this.tagNames();
    const b = await this.get<unknown>('/api/v1/watch');
    if (!isObject(b)) throw new Error('changedetection.io answered an unexpected watch list');
    const watches: CdWatch[] = [];
    let total = 0;
    for (const [uuid, raw] of Object.entries(b)) {
      const w = parseWatch(uuid, raw, tags);
      if (!w) continue;
      total++;
      if (watches.length < PAGE_WATCH_LIMITS.watches) watches.push(w);
    }
    return { total, watches };
  }

  /** Snapshot times of a watch, newest first (null: no such watch). The paths of the snapshot files are not kept. */
  async history(uuid: string): Promise<{ count: number; snapshots: string[] } | null> {
    if (!PAGE_WATCH_UUID_RE.test(uuid)) return null;
    const b = await this.get<unknown>(`/api/v1/watch/${uuid.toLowerCase()}/history`, true);
    if (b === null) return null;
    if (!isObject(b)) throw new Error('changedetection.io answered an unexpected history');
    const times = Object.keys(b)
      .map(unixToIso)
      .filter((x): x is string => !!x)
      .sort()
      .reverse();
    return { count: times.length, snapshots: times.slice(0, PAGE_WATCH_LIMITS.history) };
  }
}

/** changedetection.io's own UI (the variable uiUrl when the API is reached by another address, else the base URL). */
export function uiUrlOf(p: Pick<Platform, 'baseUrl' | 'config'>): string {
  const v = String(p.config?.variables?.uiUrl ?? '').trim();
  const base = /^https?:\/\//i.test(v) ? v : p.baseUrl;
  return base.replace(/\/+$/, '');
}

/** The diff page of a watch in changedetection.io's UI. */
export const diffUrlOf = (ui: string, uuid: string): string => `${ui}/diff/${encodeURIComponent(uuid)}`;
