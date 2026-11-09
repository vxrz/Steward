import {
  combineLive,
  type LiveReason,
  type LiveState,
  type MonitorStatus,
  type PlantCheckStatus,
  type PlantLiveStatus,
  type PlantStatusCheck,
  type DatasetMeta,
  type DatasetRow,
} from '@sm/shared';
import { db } from '../db.js';
import { currentUser, runAs } from '../auth/context.js';
import { plantOnly } from '../auth/policy.js';
import { permissionsOfRow, checkKey, type MonitorRow } from '../monitors/model.js';
import { activeMaintenance } from '../monitors/engine.js';
import { getDataset, getDatasetMeta } from '../dashboards/datasets.js';
import { builtinDatasetVisible } from '../dashboards/builtin.js';
import { permissionsFor } from '../processes/service.js';
import { parseJson } from '../util.js';
import type { NetProblem } from './network-model.js';

/**
 * Live status of an asset or device (#220): online, offline or unknown, only from the checks linked to it – a
 * monitor (or one of its checks: Gatus endpoints, CheckMk, the MQTT silent-device check, Kafka …) or the freshness of
 * a dataset (the last value of an aspect on an IoT platform). Steward never guesses: what no check says stays
 * unknown, and unknown is never shown as online.
 *
 * The status is a fact about the asset and shown to everyone who may see its site. One rule for the OT network and
 * the visualizations (views.ts): a monitor or dataset the reader may see is named, linked (not for plant viewers) and
 * evaluated as the reader – a dataset over the partitions they may read. One they may not see (or that no longer
 * exists – the two read the same) still counts towards the status, but shows only its state: online, offline or
 * unknown – no name, key, check, reason, time or filter. Linking a monitor or dataset, or changing what a linked one
 * checks, needs the right to see it (network.ts `refProblems`).
 */

/** What one evaluation reads once (a site overview evaluates many checks of the same monitors and datasets). */
export interface LiveContext {
  monitors: Map<string, (MonitorRow & { status: MonitorStatus | null; last_evaluated_at: string | null }) | null>;
  datasets: Map<string, { meta: DatasetMeta; rows: DatasetRow[] | null } | null>;
  visibleDatasets: Map<string, boolean>;
  now: number;
}

export const liveContext = (): LiveContext => ({ monitors: new Map(), datasets: new Map(), visibleDatasets: new Map(), now: Date.now() });

const MONITOR_STATE: Record<MonitorStatus, [LiveState, LiveReason]> = {
  up: ['online', 'up'],
  // reachable, but not well: online (the check says so), the reason tells why
  degraded: ['online', 'degraded'],
  down: ['offline', 'down'],
  unknown: ['unknown', 'unknown'],
  blocked: ['unknown', 'unknown'],
  maintenance: ['unknown', 'maintenance'],
  // off (ADR 0021): offline as planned – drawn grey, not red
  off: ['offline', 'off'],
};

// ---------- who may see what (one rule for the OT network and the visualizations) ----------

/** Whether the reader may see a monitor (a missing one or a template reads like a hidden one). */
export const monitorVisible = (m: Pick<MonitorRow, 'id' | 'owner' | 'acl' | 'is_template'> | null | undefined): boolean =>
  !!m && !m.is_template && permissionsOfRow(m).includes('view');

/**
 * The dataset as the reader may see it, as the dataset API shows it (GET /api/datasets/:key): published, with a
 * partition they may read, of a process they may see. Null when it is missing or hidden – the two read the same.
 */
export function readableDataset(key: string): DatasetMeta | null {
  try {
    const meta = getDatasetMeta(key);
    return (builtinDatasetVisible(meta.processId) ?? permissionsFor(meta.processId).includes('view')) ? meta : null;
  } catch {
    return null; // no data published under this key, or nothing of it for this reader: the same answer
  }
}

/** A whole monitor's state as the OT network reads it: disabled or in maintenance is unknown. */
export function monitorState(m: { id: string; enabled: number | boolean; status: string | null }): LiveState {
  if (!m.enabled || activeMaintenance(m.id)) return 'unknown';
  return (MONITOR_STATE[(m.status ?? 'unknown') as MonitorStatus] ?? MONITOR_STATE.unknown)[0];
}

/** A linked check the reader may not see: its state, nothing else. */
const hiddenStatus = (kind: PlantStatusCheck['kind'], state: LiveState): PlantCheckStatus => ({
  kind,
  ref: '',
  check: '',
  state,
  reason: 'hidden',
  label: '',
  path: null,
  visible: false,
  at: null,
});

// ---------- monitors ----------

function monitorOf(ctx: LiveContext, ref: string) {
  if (!ctx.monitors.has(ref))
    ctx.monitors.set(
      ref,
      db().get<MonitorRow & { status: MonitorStatus | null; last_evaluated_at: string | null }>(
        'SELECT m.*, s.status, s.last_evaluated_at FROM monitors m LEFT JOIN monitor_state s ON s.monitor_id = m.id WHERE m.id = ? OR m.key = ?',
        ref,
        ref.toLowerCase(),
      ) ?? null,
    );
  return ctx.monitors.get(ref)!;
}

function monitorCheck(c: PlantStatusCheck, ctx: LiveContext): PlantCheckStatus {
  const m = monitorOf(ctx, c.ref);
  if (!m || m.is_template) return hiddenStatus('monitor', 'unknown');
  const visible = monitorVisible(m);
  const path = visible && !plantOnly(currentUser()) ? `/monitors/${m.id}` : null;
  const out = (state: LiveState, reason: LiveReason, at: string | null = null): PlantCheckStatus =>
    visible ? { kind: 'monitor', ref: c.ref, check: c.check, state, reason, label: m.name, path, visible, at } : hiddenStatus('monitor', state);
  if (!m.enabled) return out('unknown', 'disabled');
  if (activeMaintenance(m.id)) return out('unknown', 'maintenance');
  if (!c.check) {
    const [state, reason] = MONITOR_STATE[m.status ?? 'unknown'];
    return out(state, reason, m.last_evaluated_at);
  }
  // one check of the monitor, by its id or its key (a Gatus endpoint, a CheckMk service …)
  const def = parseJson<{ checks?: { id: string; key?: string; enabled?: boolean }[] }>(m.definition, {});
  const chk = def.checks?.find((x) => x.id === c.check || checkKey(m, x as never) === c.check);
  if (!chk) return out('unknown', 'not_found');
  if (chk.enabled === false) return out('unknown', 'disabled');
  const row = db().get<{ status: MonitorStatus; last_checked_at: string | null }>(
    'SELECT status, last_checked_at FROM monitor_checks WHERE monitor_id = ? AND check_id = ?',
    m.id,
    chk.id,
  );
  const [state, reason] = MONITOR_STATE[row?.status ?? 'unknown'];
  return out(state, reason, row?.last_checked_at ?? null);
}

// ---------- datasets ----------

function datasetVisible(ctx: LiveContext, key: string): boolean {
  if (!ctx.visibleDatasets.has(key)) ctx.visibleDatasets.set(key, readableDataset(key) !== null);
  return ctx.visibleDatasets.get(key)!;
}

/**
 * The dataset a check reads: as the reader when they may see it (only the partitions they may read), else as the
 * system – then only the state leaves this module.
 */
function datasetOf(ctx: LiveContext, key: string, rows: boolean, visible: boolean) {
  const cur = ctx.datasets.get(key);
  if (cur !== undefined && (!rows || cur === null || cur.rows)) return cur;
  let v: { meta: DatasetMeta; rows: DatasetRow[] | null } | null;
  const read = () => (rows ? (({ rows: r, ...meta }) => ({ meta, rows: r }))(getDataset(key)) : { meta: getDatasetMeta(key), rows: null });
  try {
    v = visible ? read() : runAs(null, read);
  } catch {
    v = null; // no data published (yet) under this key
  }
  ctx.datasets.set(key, v);
  return v;
}

/** Times before 2000 or more than a year ahead are no times of a last value (a count or an amount in the column). */
const EARLIEST = Date.UTC(2000, 0, 1);
const timeOf = (v: unknown, now: number): number | null => {
  let t: number | null = null;
  if (typeof v === 'number' && Number.isFinite(v)) t = v > 1e12 ? v : v * 1000;
  else if (typeof v === 'string' && v) t = Date.parse(v);
  return t !== null && Number.isFinite(t) && t >= EARLIEST && t <= now + 366 * 86_400_000 ? t : null;
};

function datasetCheck(c: PlantStatusCheck, ctx: LiveContext): PlantCheckStatus {
  const visible = datasetVisible(ctx, c.ref);
  const d = datasetOf(ctx, c.ref, !!(c.column || c.timeColumn), visible);
  const base = { kind: 'dataset' as const, ref: c.ref, check: '', visible: true, path: plantOnly(currentUser()) ? null : '/dashboards' };
  const out = (state: LiveState, reason: LiveReason, at: string | null = null): PlantCheckStatus =>
    visible && d ? { ...base, label: d.meta.title || c.ref, state, reason, at } : hiddenStatus('dataset', state);
  if (!d) return out('unknown', 'no_data');
  const rows = d.rows ? (c.column ? d.rows.filter((r) => String(r[c.column] ?? '') === c.value) : d.rows) : null;
  if (rows && !rows.length) return out('unknown', 'no_row');
  const maxAge = c.maxAgeMinutes ?? d.meta.staleAfterMinutes ?? 24 * 60;
  let at: number | null;
  if (c.timeColumn) {
    const times = rows!.map((r) => timeOf(r[c.timeColumn], ctx.now)).filter((x): x is number => x !== null);
    if (!times.length) return out('unknown', 'no_time');
    at = Math.max(...times);
  } else {
    at = timeOf(d.meta.updatedAt, ctx.now);
    // the dataset's own freshness, when no limit is given
    if (c.maxAgeMinutes === null) return out(d.meta.stale ? 'offline' : 'online', d.meta.stale ? 'stale' : 'fresh', d.meta.updatedAt);
  }
  if (at === null) return out('unknown', 'no_time');
  const fresh = ctx.now - at <= maxAge * 60_000;
  return out(fresh ? 'online' : 'offline', fresh ? 'fresh' : 'stale', new Date(at).toISOString());
}

// ---------- the stored checks as the reader may see them ----------

/** Whether the reader may see what a linked check names. */
export function checkVisible(c: PlantStatusCheck, ctx: LiveContext): boolean {
  return c.kind === 'monitor' ? monitorVisible(monitorOf(ctx, c.ref)) : datasetVisible(ctx, c.ref);
}

/** The stored checks for a view: one the reader may not see keeps only its kind and its place (`hiddenSlot`). */
export const checksForReader = (list: PlantStatusCheck[], ctx: LiveContext): PlantStatusCheck[] =>
  list.map((c, i) =>
    checkVisible(c, ctx) ? c : { kind: c.kind, ref: '', check: '', column: '', value: '', timeColumn: '', maxAgeMinutes: null, note: '', hiddenSlot: i },
  );

/**
 * The checks a save sends, with the ones the caller may not see put back as they are stored (by their slot); a
 * slot that holds no such check (the list changed meanwhile) is a problem. Leaving a hidden check out removes it.
 */
export function withHiddenChecks(
  input: PlantStatusCheck[],
  before: PlantStatusCheck[] | null,
  at = 'checks',
): { checks: PlantStatusCheck[]; problems: NetProblem[] } {
  const ctx = liveContext();
  const used = new Set<number>();
  const problems: NetProblem[] = [];
  const checks = input.map((c, i) => {
    const { hiddenSlot, ...rest } = c;
    if (hiddenSlot === undefined) return rest;
    const b = before?.[hiddenSlot];
    if (!b || used.has(hiddenSlot) || checkVisible(b, ctx)) {
      problems.push({ path: `${at}[${i}]`, message: 'The checks were changed meanwhile: reload them and try again' });
      return rest;
    }
    used.add(hiddenSlot);
    return b;
  });
  return { checks, problems };
}

/**
 * The checks of an import, with the stored ones the importer may not see kept in their place: a file cannot name
 * them (its export leaves them out), so it cannot remove them either.
 */
export function withStoredHiddenChecks(input: PlantStatusCheck[], before: PlantStatusCheck[] | null | undefined): PlantStatusCheck[] {
  const ctx = liveContext();
  const out = [...input];
  const has = new Set(input.map((c) => JSON.stringify(c)));
  (before ?? []).forEach((c, i) => {
    if (checkVisible(c, ctx) || has.has(JSON.stringify(c))) return;
    out.splice(Math.min(i, out.length), 0, c);
  });
  return out;
}

export const checkStatus = (c: PlantStatusCheck, ctx: LiveContext): PlantCheckStatus => (c.kind === 'monitor' ? monitorCheck(c, ctx) : datasetCheck(c, ctx));

/** The live status from a list of checks (a device's, an asset's own). */
export function liveOf(checks: PlantStatusCheck[], ctx: LiveContext): PlantLiveStatus {
  const list = checks.map((c) => checkStatus(c, ctx));
  return { state: combineLive(list.map((x) => x.state)), watched: list.length > 0, checks: list };
}

/** An asset's live status: its own checks and those of its watched devices (a device without checks says nothing). */
export function assetLive(own: PlantLiveStatus, devices: PlantLiveStatus[]): PlantLiveStatus {
  const watched = [own, ...devices].filter((x) => x.watched);
  return { state: combineLive(watched.map((x) => x.state)), watched: watched.length > 0, checks: own.checks };
}
