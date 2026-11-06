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
import { parseJson } from '../util.js';

/**
 * Live status of an asset or device (#220): online, offline or unknown, only from the checks linked to it – a
 * monitor (or one of its checks: Gatus endpoints, CheckMk, the MQTT silent-device check, Kafka …) or the freshness of
 * a dataset (the last value of an aspect on an IoT platform). Steward never guesses: what no check says stays
 * unknown, and unknown is never shown as online.
 *
 * The status is a fact about the asset and shown to everyone who may see its site; the monitor or dataset behind it
 * is named and linked only for readers who may see it (a plant viewer sees names only, never a link).
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
};

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
  const out = (state: LiveState, reason: LiveReason, at: string | null = null, label = '', path: string | null = null, visible = false): PlantCheckStatus => ({
    kind: 'monitor',
    ref: c.ref,
    check: c.check,
    state,
    reason,
    label,
    path,
    visible,
    at,
  });
  const m = monitorOf(ctx, c.ref);
  if (!m || m.is_template) return out('unknown', 'not_found');
  const visible = permissionsOfRow(m).includes('view');
  const label = visible ? m.name : '';
  const path = visible && !plantOnly(currentUser()) ? `/monitors/${m.id}` : null;
  if (!m.enabled) return out('unknown', 'disabled', null, label, path, visible);
  if (activeMaintenance(m.id)) return out('unknown', 'maintenance', null, label, path, visible);
  if (!c.check) {
    const [state, reason] = MONITOR_STATE[m.status ?? 'unknown'];
    return out(state, reason, m.last_evaluated_at, label, path, visible);
  }
  // one check of the monitor, by its id or its key (a Gatus endpoint, a CheckMk service …)
  const def = parseJson<{ checks?: { id: string; key?: string; enabled?: boolean }[] }>(m.definition, {});
  const chk = def.checks?.find((x) => x.id === c.check || checkKey(m, x as never) === c.check);
  if (!chk) return out('unknown', 'not_found', null, label, path, visible);
  if (chk.enabled === false) return out('unknown', 'disabled', null, label, path, visible);
  const row = db().get<{ status: MonitorStatus; last_checked_at: string | null }>(
    'SELECT status, last_checked_at FROM monitor_checks WHERE monitor_id = ? AND check_id = ?',
    m.id,
    chk.id,
  );
  const [state, reason] = MONITOR_STATE[row?.status ?? 'unknown'];
  return out(state, reason, row?.last_checked_at ?? null, label, path, visible);
}

function datasetOf(ctx: LiveContext, key: string, rows: boolean) {
  const cur = ctx.datasets.get(key);
  if (cur !== undefined && (!rows || cur === null || cur.rows)) return cur;
  let v: { meta: DatasetMeta; rows: DatasetRow[] | null } | null;
  try {
    // read as the system: the freshness is a fact about the asset, whoever looks at it
    v = runAs(null, () => (rows ? (({ rows: r, ...meta }) => ({ meta, rows: r }))(getDataset(key)) : { meta: getDatasetMeta(key), rows: null }));
  } catch {
    v = null; // no data published (yet) under this key
  }
  ctx.datasets.set(key, v);
  return v;
}

function datasetVisible(ctx: LiveContext, key: string): boolean {
  if (!ctx.visibleDatasets.has(key)) {
    let ok: boolean;
    try {
      getDatasetMeta(key);
      ok = true;
    } catch {
      ok = false; // the reader may not see it (or it does not exist): it is not named
    }
    ctx.visibleDatasets.set(key, ok);
  }
  return ctx.visibleDatasets.get(key)!;
}

const timeOf = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

function datasetCheck(c: PlantStatusCheck, ctx: LiveContext): PlantCheckStatus {
  const visible = datasetVisible(ctx, c.ref);
  const base = { kind: 'dataset' as const, ref: c.ref, check: '', visible, path: visible && !plantOnly(currentUser()) ? '/dashboards' : null };
  const d = datasetOf(ctx, c.ref, !!(c.column || c.timeColumn));
  const label = visible && d ? d.meta.title || c.ref : '';
  if (!d) return { ...base, label, state: 'unknown', reason: 'no_data', at: null };
  const rows = d.rows ? (c.column ? d.rows.filter((r) => String(r[c.column] ?? '') === c.value) : d.rows) : null;
  if (rows && !rows.length) return { ...base, label, state: 'unknown', reason: 'no_row', at: null };
  const maxAge = c.maxAgeMinutes ?? d.meta.staleAfterMinutes ?? 24 * 60;
  let at: number | null;
  if (c.timeColumn) {
    const times = rows!.map((r) => timeOf(r[c.timeColumn])).filter((x): x is number => x !== null);
    if (!times.length) return { ...base, label, state: 'unknown', reason: 'no_time', at: null };
    at = Math.max(...times);
  } else {
    at = timeOf(d.meta.updatedAt);
    // the dataset's own freshness, when no limit is given
    if (c.maxAgeMinutes === null)
      return { ...base, label, state: d.meta.stale ? 'offline' : 'online', reason: d.meta.stale ? 'stale' : 'fresh', at: d.meta.updatedAt };
  }
  if (at === null) return { ...base, label, state: 'unknown', reason: 'no_time', at: null };
  const fresh = ctx.now - at <= maxAge * 60_000;
  return { ...base, label, state: fresh ? 'online' : 'offline', reason: fresh ? 'fresh' : 'stale', at: new Date(at).toISOString() };
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
