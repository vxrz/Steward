import { worstStatus, type CauseRef, type CheckDef, type MonitorDefinition, type MonitorStatus } from '@sm/shared';

/**
 * Pure status logic of the monitor engine (no I/O): flapping control,
 * freshness thresholds, root-cause inference and the aggregated status.
 */

// ---------- flapping control ----------

export interface Counters {
  status: MonitorStatus;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
}

/**
 * Applies one raw result:
 * - `down` needs N consecutive failing results (failuresBeforeDown) unless the check is already down;
 * - leaving `down` needs M consecutive non-failing results (successesBeforeUp);
 * - up ↔ degraded switch immediately; `unknown` (the check could not run) keeps a confirmed `down`;
 * - `blocked` (hard dependency down) is taken over directly and resets the counters.
 */
export function applyResult(prev: Counters, raw: MonitorStatus, t: { failuresBeforeDown: number; successesBeforeUp: number }): Counters {
  let { consecutiveFailures: cf, consecutiveSuccesses: cs } = prev;
  let status = prev.status;
  switch (raw) {
    case 'down':
      cf++;
      cs = 0;
      if (prev.status === 'down' || cf >= t.failuresBeforeDown) status = 'down';
      break;
    case 'up':
    case 'degraded':
      cs++;
      cf = 0;
      if (prev.status !== 'down' || cs >= t.successesBeforeUp) status = raw;
      break;
    case 'blocked':
      cf = 0;
      cs = 0;
      status = 'blocked';
      break;
    default:
      if (prev.status !== 'down') status = raw === 'maintenance' ? prev.status : 'unknown';
  }
  return { status, consecutiveFailures: cf, consecutiveSuccesses: cs };
}

// ---------- freshness ----------

export interface FreshnessConfig {
  mode: 'cadence' | 'maxAge';
  expectedIntervalSeconds?: number;
  degradedAfterMissed?: number;
  downAfterMissed?: number;
  maxAgeSeconds?: number;
  degradedAgeSeconds?: number;
}

export function fmtAge(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 120) return `${s} s`;
  if (s < 7200) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} h`;
  return `${Math.round(s / 86400)} days`;
}

/** Window (seconds) after which data is certainly "down" – used to size look-back queries. */
export function freshnessWindowSeconds(c: FreshnessConfig): number {
  if (c.mode === 'maxAge') return c.maxAgeSeconds ?? 3600;
  return (c.expectedIntervalSeconds ?? 60) * (c.downAfterMissed ?? 4);
}

/** Status for the newest timestamp of a source (null = no data at all). */
export function freshnessStatus(latestMs: number | null, now: number, c: FreshnessConfig, what = 'data'): { status: MonitorStatus; message: string; ageSeconds: number | null } {
  if (latestMs === null) return { status: 'down', message: `No ${what} within the last ${fmtAge(freshnessWindowSeconds(c))}`, ageSeconds: null };
  const age = Math.max(0, (now - latestMs) / 1000);
  if (c.mode === 'maxAge') {
    const max = c.maxAgeSeconds ?? 3600;
    if (age > max) return { status: 'down', message: `Newest ${what} is ${fmtAge(age)} old (maximum ${fmtAge(max)})`, ageSeconds: age };
    if (c.degradedAgeSeconds && age > c.degradedAgeSeconds) return { status: 'degraded', message: `Newest ${what} is ${fmtAge(age)} old (warning after ${fmtAge(c.degradedAgeSeconds)})`, ageSeconds: age };
    return { status: 'up', message: `Newest ${what} is ${fmtAge(age)} old`, ageSeconds: age };
  }
  const every = c.expectedIntervalSeconds ?? 60;
  const missed = Math.floor(age / every);
  const degradedAfter = c.degradedAfterMissed ?? 2;
  const downAfter = c.downAfterMissed ?? 4;
  const base = `Newest ${what} is ${fmtAge(age)} old, expected every ${fmtAge(every)}`;
  if (missed >= downAfter) return { status: 'down', message: `${base} (${missed} intervals missed)`, ageSeconds: age };
  if (missed >= degradedAfter) return { status: 'degraded', message: `${base} (${missed} intervals missed)`, ageSeconds: age };
  return { status: 'up', message: base, ageSeconds: age };
}

// ---------- root causes and aggregation ----------

export interface CheckView {
  status: MonitorStatus;
  causedBy: CauseRef[];
  note: string | null;
}

export interface Analysis {
  checks: Map<string, CheckView>;
  status: MonitorStatus;
  rootCauses: CauseRef[];
}

const failing = (s: MonitorStatus | undefined) => s === 'down' || s === 'blocked';
const affected = (s: MonitorStatus | undefined) => s === 'down' || s === 'blocked' || s === 'degraded' || s === 'unknown';

/**
 * Root causes: a failing check whose (soft or hard) parent fails too is
 * "likely caused by" the topmost failing ancestors; a failing check without a
 * failing parent is a root cause itself. A root that is a sub-monitor node is
 * expanded to that monitor's own root causes.
 */
export function analyze(
  monitor: { id: string; key: string; name: string; def: MonitorDefinition },
  statuses: Map<string, MonitorStatus>,
  opts: { maintenance?: boolean; subRoots?: (check: CheckDef) => CauseRef[] } = {},
): Analysis {
  const checks = monitor.def.checks.filter((c) => c.enabled !== false);
  const byId = new Map(checks.map((c) => [c.id, c]));
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const l of monitor.def.links) {
    if (!byId.has(l.from) || !byId.has(l.to)) continue;
    parents.set(l.to, [...(parents.get(l.to) ?? []), l.from]);
    children.set(l.from, [...(children.get(l.from) ?? []), l.to]);
  }
  const ref = (c: CheckDef): CauseRef[] => {
    const sub = c.type === 'monitor' ? (opts.subRoots?.(c) ?? []) : [];
    return sub.length ? sub : [{ monitorId: monitor.id, monitorKey: monitor.key, monitorName: monitor.name, checkId: c.id, checkName: c.name }];
  };
  const memo = new Map<string, CauseRef[]>();
  /** The topmost failing ancestors of a failing check (itself when none of its parents fail). */
  const roots = (id: string, path: Set<string>): CauseRef[] => {
    const hit = memo.get(id);
    if (hit) return hit;
    const fp = (parents.get(id) ?? []).filter((p) => failing(statuses.get(p)) && !path.has(p));
    let out: CauseRef[];
    if (!fp.length) out = statuses.get(id) === 'down' ? ref(byId.get(id)!) : [];
    else {
      const next = new Set(path).add(id);
      out = dedupe(fp.flatMap((p) => roots(p, next)));
    }
    memo.set(id, out);
    return out;
  };

  const views = new Map<string, CheckView>();
  for (const c of checks) {
    const s = statuses.get(c.id) ?? 'unknown';
    let causedBy: CauseRef[] = [];
    if (affected(s)) {
      const fp = (parents.get(c.id) ?? []).filter((p) => failing(statuses.get(p)));
      if (fp.length) causedBy = dedupe(fp.flatMap((p) => roots(p, new Set([c.id]))));
    }
    let note: string | null = null;
    const kids = children.get(c.id) ?? [];
    if (s === 'down' && kids.length) {
      const healthy = kids.filter((k) => statuses.get(k) === 'up').length;
      if (healthy === kids.length) {
        note = `Down while ${healthy === 1 ? 'the dependent check is' : `all ${healthy} dependent checks are`} healthy – the check itself or its data path may be broken`;
      } else if (healthy > 0) note = `Down while ${healthy} of ${kids.length} dependent checks are healthy`;
    }
    views.set(c.id, { status: s, causedBy, note });
  }

  // aggregated status
  const rule = monitor.def.aggregate.rule;
  const effective = (c: CheckDef): MonitorStatus => {
    const s = views.get(c.id)!.status;
    if (rule === 'critical' && c.critical === false && (s === 'down' || s === 'blocked')) return 'degraded';
    return s;
  };
  let status: MonitorStatus;
  if (!checks.length) status = 'unknown';
  else if (rule === 'quorum') {
    const critical = checks.filter((c) => c.critical !== false);
    const healthy = critical.filter((c) => ['up', 'degraded'].includes(views.get(c.id)!.status));
    const k = Math.min(monitor.def.aggregate.quorum ?? critical.length, critical.length);
    if (healthy.length >= k && k > 0) {
      status = worstStatus(healthy.map((c) => views.get(c.id)!.status));
      if (healthy.length < critical.length && status === 'up') status = 'degraded';
    } else if (critical.some((c) => views.get(c.id)!.status === 'down' || views.get(c.id)!.status === 'blocked')) status = 'down';
    else status = 'unknown';
  } else {
    status = worstStatus(checks.map(effective).map((s) => (s === 'blocked' ? 'down' : s)));
  }
  const rootCauses = dedupe(
    checks
      .filter((c) => views.get(c.id)!.status === 'down' && !views.get(c.id)!.causedBy.length)
      .flatMap(ref),
  );
  if (opts.maintenance) status = 'maintenance';
  return { checks: views, status, rootCauses };
}

function dedupe(list: CauseRef[]): CauseRef[] {
  const seen = new Set<string>();
  return list.filter((c) => {
    const k = `${c.monitorId}/${c.checkId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** "200", "200-299", "200,204,301-308" → predicate. */
export function statusMatcher(spec: string | undefined): (status: number) => boolean {
  const parts = (spec?.trim() || '200-399').split(',').map((p) => p.trim()).filter(Boolean);
  const ranges = parts.map((p) => {
    const m = /^(\d{3})(?:\s*-\s*(\d{3}))?$/.exec(p);
    if (!m) throw new Error(`Invalid expected status "${p}" – use e.g. 200, 200-299 or 200,204`);
    return [Number(m[1]), Number(m[2] ?? m[1])] as const;
  });
  return (s) => ranges.some(([a, b]) => s >= a && s <= b);
}

/** Phase offset (ms) within an interval, stable per key: checks sharing a key run in the same cycle. */
export function phaseOffset(key: string, interval: number): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619) >>> 0;
  return h % Math.max(1, interval);
}

/** Next due time on the check's grid: phase + k × interval, strictly after `after`. */
export function nextDue(after: number, interval: number, phase: number): number {
  const k = Math.floor((after - phase) / interval) + 1;
  return phase + k * interval;
}
