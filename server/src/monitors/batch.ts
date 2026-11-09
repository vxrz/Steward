import type { Platform } from '@sm/shared';
import { platformRequest } from '../platforms/http.js';
import { platformFor } from './platforms.js';

/**
 * Shared reads for many checks: checks on the same Insights Hub asset/aspect
 * (or the same Gatus instance) that are due in the same cycle share one API
 * call. Requests are collected until the current macrotask ends, then one call
 * is made with the union of what was asked for; answers are kept for a few
 * seconds so checks that start a little later reuse them.
 */
const TTL_MS = 10000;

interface Entry<P, R> {
  plan: P;
  started: boolean;
  promise: Promise<R>;
}

class SharedFetch<P, R> {
  private pending = new Map<string, Entry<P, R>>();
  private cache = new Map<string, { at: number; plan: P; result: R }>();
  calls = 0;

  constructor(
    private merge: (a: P, b: P) => P,
    private covers: (have: P, want: P) => boolean,
    private fetcher: (key: string, plan: P) => Promise<R>,
  ) {}

  /** Registers interest without waiting (lets the cycle collect everything before the call). */
  plan(key: string, want: P): void {
    void this.get(key, want).catch(() => undefined); // the failure reaches the check that waits for it (get)
  }

  get(key: string, want: P, now = Date.now()): Promise<R> {
    const hit = this.cache.get(key);
    if (hit && now - hit.at < TTL_MS && this.covers(hit.plan, want)) return Promise.resolve(hit.result);
    const p = this.pending.get(key);
    if (p && !p.started) {
      p.plan = this.merge(p.plan, want);
      return p.promise;
    }
    if (p && p.started && this.covers(p.plan, want)) return p.promise;
    const entry = { plan: want, started: false } as Entry<P, R>;
    entry.promise = new Promise<R>((resolve, reject) => {
      setImmediate(() => {
        entry.started = true;
        this.calls++;
        this.fetcher(key, entry.plan).then(
          (result) => {
            this.cache.set(key, { at: Date.now(), plan: entry.plan, result });
            if (this.pending.get(key) === entry) this.pending.delete(key);
            resolve(result);
          },
          (err) => {
            if (this.pending.get(key) === entry) this.pending.delete(key);
            reject(err);
          },
        );
      });
    });
    this.pending.set(key, entry);
    return entry.promise;
  }

  clear(): void {
    this.cache.clear();
    this.pending.clear();
    this.calls = 0;
  }
}

export class SourceError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

// ---------- Insights Hub IoT Time Series ----------

export interface IhPlan {
  owner: string;
  vars: string[];
  /** look-back for variables that are not in the newest record */
  windowSeconds: number;
}

/**
 * Newest timestamp (ms) per variable (null = no value in the look-back window), and when the read started and its
 * last answer arrived – the observed delay (delay.ts) is measured against these, not against the check's schedule.
 */
export interface IhLatest {
  values: Map<string, number | null>;
  startedAt: number;
  receivedAt: number;
}

const tsBase = (p: Platform, assetId: string, aspect: string) => {
  const path = String(p.config.variables?.tsPath || '/api/iottimeseries/v3').replace(/\/+$/, '');
  return `${path}/timeseries/${encodeURIComponent(assetId)}/${encodeURIComponent(aspect)}`;
};

function latestPerVariable(records: unknown, vars: string[], into: Map<string, number | null>): void {
  if (!Array.isArray(records)) return;
  for (const rec of records as Record<string, unknown>[]) {
    const t = Date.parse(String(rec?._time ?? ''));
    if (Number.isNaN(t)) continue;
    for (const v of vars) {
      if (rec[v] === undefined || rec[v] === null) continue;
      const prev = into.get(v);
      if (prev === undefined || prev === null || t > prev) into.set(v, t);
    }
  }
}

/** Records per page of the time series API (its most). */
const IH_PAGE = 2000;
/** Pages read per time slice before the read gives up (then the check is unknown, never down). */
const IH_MAX_PAGES = 10;
/** Time slices of the look-back, newest first: the newest value of a variable is usually in the first one. */
const IH_SLICES_SECONDS = [600, 3600, 6 * 3600, 86400, 7 * 86400];

/**
 * The newest value per variable in [from, to]: the API answers the OLDEST records of a range first, at most
 * IH_PAGE of them, so a full page is followed by the next one (from = the last record's time + 1 ms) until a page
 * is not full. Returns false when the end of the range was not reached within IH_MAX_PAGES pages.
 */
async function newestInRange(
  platform: Platform,
  secrets: Parameters<typeof platformRequest>[1],
  url: string,
  vars: string[],
  from: number,
  to: number,
  into: Map<string, number | null>,
  maxPages = IH_MAX_PAGES,
): Promise<boolean> {
  let start = from;
  for (let page = 0; page < maxPages; page++) {
    const r = await platformRequest(
      platform,
      secrets,
      { method: 'GET', url, query: { from: new Date(start).toISOString(), to: new Date(to).toISOString(), select: vars.join(','), limit: IH_PAGE } },
      AbortSignal.timeout(30000),
    );
    if (!r.ok) throw new SourceError(`Insights Hub time series API answered HTTP ${r.status}`, r.status);
    const recs = Array.isArray(r.body) ? (r.body as Record<string, unknown>[]) : [];
    latestPerVariable(recs, vars, into);
    if (recs.length < IH_PAGE) return true;
    const times = recs.map((x) => Date.parse(String(x?._time ?? ''))).filter((t) => !Number.isNaN(t));
    const last = times.length ? Math.max(...times) : NaN;
    // a full page that does not move forward cannot be paged
    if (!Number.isFinite(last) || last < start) return false;
    start = last + 1;
    if (start > to) return true;
  }
  return false;
}

/**
 * 1. `GET …/timeseries/{asset}/{aspect}?latestRecord=true` – the newest record (raw store; it contains only the
 *    variables written at that moment);
 * 2. for variables missing from it: `?from=<now − window>&to=<now>&select=<vars>`. The API answers the oldest
 *    records first: when that page is full, the newest values are later, so the window is read again in time slices
 *    from now backwards (10 min, 1 h, 6 h, 1 day, 7 days), each paged forward to its end, until every variable has
 *    a value. A slice too dense to page through makes the read fail (the check is unknown, never down).
 * (`latestValue=true` reads aggregates that can lag 1–2 hours behind, so it is not used.)
 */
async function fetchIh(key: string, plan: IhPlan): Promise<IhLatest> {
  const [source, assetId, aspect] = key.split('|') as [string, string, string];
  const { platform, secrets } = platformFor(plan.owner, ...splitSource(source));
  const url = tsBase(platform, assetId, aspect);
  const out = new Map<string, number | null>(plan.vars.map((v) => [v, null]));
  const startedAt = Date.now();
  const first = await platformRequest(platform, secrets, { method: 'GET', url, query: { latestRecord: 'true' } }, AbortSignal.timeout(30000));
  if (!first.ok) throw new SourceError(`Insights Hub time series API answered HTTP ${first.status}`, first.status);
  latestPerVariable(first.body, plan.vars, out);
  const to = Date.now();
  const oldest = to - Math.min(plan.windowSeconds, 7 * 86400) * 1000;
  const firstMissing = plan.vars.filter((v) => out.get(v) === null);
  // sparse data (the usual case): one page holds the whole look-back window
  const done = (): IhLatest => ({ values: out, startedAt, receivedAt: Date.now() });
  if (!firstMissing.length || (await newestInRange(platform, secrets, url, firstMissing, oldest, to, out, 1))) return done();
  // dense data: the first page held only the oldest records – read time slices from now backwards instead
  let sliceEnd = to;
  for (const seconds of IH_SLICES_SECONDS) {
    if (sliceEnd <= oldest) break;
    const sliceStart = Math.max(oldest, to - seconds * 1000);
    if (sliceStart >= sliceEnd) continue;
    const found = new Map<string, number | null>(firstMissing.map((v) => [v, null]));
    if (!(await newestInRange(platform, secrets, url, firstMissing, sliceStart, sliceEnd, found)))
      throw new SourceError(
        `Too much data to find the newest value: more than ${IH_PAGE * IH_MAX_PAGES} records between ${new Date(sliceStart).toISOString()} and ${new Date(sliceEnd).toISOString()}`,
      );
    for (const [v, t] of found) if (t !== null) out.set(v, Math.max(t, out.get(v) ?? t));
    // a variable found in a newer slice has its newest value there: older slices are only read for the others
    firstMissing.splice(0, firstMissing.length, ...firstMissing.filter((v) => found.get(v) === null));
    if (!firstMissing.length) break;
    sliceEnd = sliceStart - 1;
  }
  return done();
}

export const ihFetch = new SharedFetch<IhPlan, IhLatest>(
  (a, b) => ({ owner: a.owner, vars: [...new Set([...a.vars, ...b.vars])], windowSeconds: Math.max(a.windowSeconds, b.windowSeconds) }),
  (have, want) => want.vars.every((v) => have.vars.includes(v)) && have.windowSeconds >= want.windowSeconds,
  fetchIh,
);
export const ihKey = (platformId: string, assetId: string, aspect: string, identity?: string) => `${sourceKey(platformId, identity)}|${assetId}|${aspect}`;

/**
 * The key of a shared read: the platform, and the identity the check names (0.13.0, ADR 0009) – checks that read with
 * different identities never share an answer.
 */
export const sourceKey = (platformId: string, identity?: string | null): string => (identity ? `${platformId}#${identity}` : platformId);
function splitSource(key: string): [string, string | undefined] {
  const i = key.indexOf('#');
  return i < 0 ? [key, undefined] : [key.slice(0, i), key.slice(i + 1)];
}

// ---------- Gatus ----------

export interface GatusPlan {
  owner: string;
  pageSize: number;
}
export interface GatusEndpoint {
  key: string;
  name: string;
  group: string;
  results: { success: boolean; timestamp: string; duration?: number; errors?: string[]; status?: number }[];
}

async function fetchGatus(source: string, plan: GatusPlan): Promise<Map<string, GatusEndpoint>> {
  const { platform, secrets } = platformFor(plan.owner, ...splitSource(source));
  const r = await platformRequest(
    platform,
    secrets,
    { method: 'GET', url: '/api/v1/endpoints/statuses', query: { page: 1, pageSize: Math.max(1, plan.pageSize) } },
    AbortSignal.timeout(30000),
  );
  if (!r.ok || !Array.isArray(r.body)) throw new SourceError(`Gatus answered HTTP ${r.status}`, r.status);
  return new Map((r.body as GatusEndpoint[]).map((e) => [e.key, e]));
}

export const gatusFetch = new SharedFetch<GatusPlan, Map<string, GatusEndpoint>>(
  (a, b) => ({ owner: a.owner, pageSize: Math.max(a.pageSize, b.pageSize) }),
  (have, want) => have.pageSize >= want.pageSize,
  fetchGatus,
);

// ---------- CheckMk ----------

export interface CheckmkPlan {
  owner: string;
  /** Hosts whose own state is needed */
  hosts: string[];
  /** Hosts whose services are needed */
  serviceHosts: string[];
}
export interface CheckmkState {
  /** host: 0 UP, 1 DOWN, 2 UNREACHABLE; service: 0 OK, 1 WARN, 2 CRIT, 3 UNKNOWN */
  state: number;
  output: string;
  /** ms, null when never checked */
  lastCheck: number | null;
  checked: boolean;
  downtime: boolean;
  acknowledged: boolean;
}
export interface CheckmkData {
  hosts: Map<string, CheckmkState>;
  /** key: host + "\u0000" + service description */
  services: Map<string, CheckmkState>;
}
export const checkmkServiceKey = (host: string, service: string) => `${host}\u0000${service}`;

const CMK_COLUMNS = ['state', 'plugin_output', 'last_check', 'has_been_checked', 'scheduled_downtime_depth', 'acknowledged'];

/** Livestatus filter: one of these values (CheckMk REST API `query`). */
const anyOf = (column: string, values: string[]) =>
  values.length === 1 ? { op: '=', left: column, right: values[0] } : { op: 'or', expr: values.map((v) => ({ op: '=', left: column, right: v })) };

function cmkState(e: Record<string, unknown>): CheckmkState {
  const last = Number(e.last_check);
  return {
    state: Number(e.state ?? 3),
    output: String(e.plugin_output ?? '').slice(0, 500),
    lastCheck: Number.isFinite(last) && last > 0 ? last * 1000 : null,
    checked: e.has_been_checked === undefined ? true : Number(e.has_been_checked) === 1 || e.has_been_checked === true,
    downtime: Number(e.scheduled_downtime_depth ?? 0) > 0,
    acknowledged: Number(e.acknowledged ?? 0) === 1 || e.acknowledged === true,
  };
}

const rowsOf = (body: unknown): Record<string, unknown>[] =>
  Array.isArray((body as { value?: unknown })?.value)
    ? ((body as { value: { extensions?: Record<string, unknown> }[] }).value.map((v) => v?.extensions ?? {}) as Record<string, unknown>[])
    : [];

/**
 * At most two calls per CheckMk site and cycle (REST API 1.0, CheckMk 2.2+):
 * `GET /domain-types/host/collections/all` for the host states and `GET /domain-types/service/collections/all` for the
 * services of the hosts asked for, both filtered with a Livestatus query.
 */
async function fetchCheckmk(source: string, plan: CheckmkPlan): Promise<CheckmkData> {
  const { platform, secrets } = platformFor(plan.owner, ...splitSource(source));
  const out: CheckmkData = { hosts: new Map(), services: new Map() };
  const call = async (path: string, column: string, values: string[], extra: string[]) => {
    const r = await platformRequest(
      platform,
      secrets,
      { method: 'GET', url: path, query: { query: anyOf(column, values), columns: [...extra, ...CMK_COLUMNS] }, headers: { accept: 'application/json' } },
      AbortSignal.timeout(30000),
    );
    if (!r.ok) throw new SourceError(`CheckMk answered HTTP ${r.status}${r.status === 401 ? ' (check the automation user and its secret)' : ''}`, r.status);
    return rowsOf(r.body);
  };
  if (plan.hosts.length)
    for (const e of await call('/domain-types/host/collections/all', 'name', plan.hosts, ['name'])) out.hosts.set(String(e.name), cmkState(e));
  if (plan.serviceHosts.length)
    for (const e of await call('/domain-types/service/collections/all', 'host_name', plan.serviceHosts, ['host_name', 'description']))
      out.services.set(checkmkServiceKey(String(e.host_name), String(e.description)), cmkState(e));
  return out;
}

const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];
export const checkmkFetch = new SharedFetch<CheckmkPlan, CheckmkData>(
  (a, b) => ({ owner: a.owner, hosts: union(a.hosts, b.hosts), serviceHosts: union(a.serviceHosts, b.serviceHosts) }),
  (have, want) => want.hosts.every((h) => have.hosts.includes(h)) && want.serviceHosts.every((h) => have.serviceHosts.includes(h)),
  fetchCheckmk,
);

export function clearBatchCaches(): void {
  ihFetch.clear();
  gatusFetch.clear();
  checkmkFetch.clear();
}
