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
    void this.get(key, want).catch(() => undefined);
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

/** Newest timestamp (ms) per variable; null = no value in the look-back window. */
export type IhLatest = Map<string, number | null>;

const tsBase = (p: Platform, assetId: string, aspect: string) => {
  const path = String(p.config.variables?.tsPath || '/api/iottimeseries/v3').replace(/\/+$/, '');
  return `${path}/timeseries/${encodeURIComponent(assetId)}/${encodeURIComponent(aspect)}`;
};

function latestPerVariable(records: unknown, vars: string[], into: IhLatest): void {
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

/**
 * 1. `GET …/timeseries/{asset}/{aspect}?latestRecord=true` – the newest record (raw store; it contains only the
 *    variables written at that moment);
 * 2. for variables missing from it: `?from=<now − window>&to=<now>&select=<vars>` and the newest value per variable.
 * (`latestValue=true` reads aggregated data that can lag 1–2 hours behind, so it is not used.)
 */
async function fetchIh(key: string, plan: IhPlan): Promise<IhLatest> {
  const [platformId, assetId, aspect] = key.split('|') as [string, string, string];
  const { platform, secrets } = platformFor(plan.owner, platformId);
  const url = tsBase(platform, assetId, aspect);
  const out: IhLatest = new Map(plan.vars.map((v) => [v, null]));
  const first = await platformRequest(platform, secrets, { method: 'GET', url, query: { latestRecord: 'true' } }, AbortSignal.timeout(30000));
  if (!first.ok) throw new SourceError(`Insights Hub time series API answered HTTP ${first.status}`, first.status);
  latestPerVariable(first.body, plan.vars, out);
  const missing = plan.vars.filter((v) => out.get(v) === null);
  if (missing.length) {
    const to = new Date();
    const from = new Date(to.getTime() - Math.min(plan.windowSeconds, 7 * 86400) * 1000);
    const second = await platformRequest(
      platform,
      secrets,
      { method: 'GET', url, query: { from: from.toISOString(), to: to.toISOString(), select: missing.join(','), limit: 2000 } },
      AbortSignal.timeout(30000),
    );
    if (!second.ok) throw new SourceError(`Insights Hub time series API answered HTTP ${second.status}`, second.status);
    latestPerVariable(second.body, missing, out);
  }
  return out;
}

export const ihFetch = new SharedFetch<IhPlan, IhLatest>(
  (a, b) => ({ owner: a.owner, vars: [...new Set([...a.vars, ...b.vars])], windowSeconds: Math.max(a.windowSeconds, b.windowSeconds) }),
  (have, want) => want.vars.every((v) => have.vars.includes(v)) && have.windowSeconds >= want.windowSeconds,
  fetchIh,
);
export const ihKey = (platformId: string, assetId: string, aspect: string) => `${platformId}|${assetId}|${aspect}`;

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

async function fetchGatus(platformId: string, plan: GatusPlan): Promise<Map<string, GatusEndpoint>> {
  const { platform, secrets } = platformFor(plan.owner, platformId);
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
async function fetchCheckmk(platformId: string, plan: CheckmkPlan): Promise<CheckmkData> {
  const { platform, secrets } = platformFor(plan.owner, platformId);
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
