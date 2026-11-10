import type { PlantIhLeader, PlantIhWatcher } from '@sm/shared';
import { db } from '../db.js';
import { currentUser } from '../auth/context.js';
import { plantOnly } from '../auth/policy.js';
import { permissionsOfRow, type MonitorRow } from '../monitors/model.js';
import { parseJson } from '../util.js';

/**
 * Monitors first (0.14, docs/PLANT.md "Insights Hub mapping"): which monitor checks already watch the Insights Hub
 * targets of a sink's items – freshness checks with the Insights Hub source on the same platform, asset and aspect
 * whose variables include the item's variable – and the links of items to monitor checks that are stored (made from the
 * mapping, or found by its last check), so the monitor's page can tell what it covers. Plain reads of the monitors'
 * definitions: nothing here runs a check or calls the tenant.
 */

interface FreshnessDef {
  id: string;
  name: string;
  type: string;
  source?: string;
  platform?: string;
  assetId?: string;
  aspect?: string;
  variables?: string[];
  enabled?: boolean;
  mode?: 'cadence' | 'maxAge';
  expectedIntervalSeconds?: number;
  maxAgeSeconds?: number;
  degradedAgeSeconds?: number;
  allowedDelaySeconds?: number;
  intervalSeconds?: number;
}

/** One Insights Hub freshness check of a monitor. */
export interface IhWatchCheck {
  monitor: Pick<MonitorRow, 'id' | 'key' | 'name' | 'owner' | 'acl' | 'enabled'>;
  check: FreshnessDef;
  platformId: string;
  /** Lower case */
  assetId: string;
  aspect: string;
  variables: Set<string>;
  /** The monitor's interval (the check's own, else the monitor's) */
  intervalSeconds: number;
}

/** A platform reference of a check (monitors store the id; an older definition may name it, or a unique prefix of an Insights Hub platform's name) to an id. */
function platformResolver(): (ref: string) => string | null {
  const rows = db().all<{ id: string; name: string; kind: string }>('SELECT id, name, kind FROM platforms');
  const cache = new Map<string, string | null>();
  return (ref) => {
    if (cache.has(ref)) return cache.get(ref)!;
    const lower = ref.toLowerCase();
    const byId = rows.find((r) => r.id === ref);
    const named = rows.filter((r) => r.name.toLowerCase() === lower);
    const prefixed = rows.filter((r) => r.name.toLowerCase().startsWith(lower) && r.kind === 'insights-hub');
    const id = byId?.id ?? (named.length === 1 ? named[0]!.id : !named.length && prefixed.length === 1 ? prefixed[0]!.id : null);
    cache.set(ref, id);
    return id;
  };
}

/** The Insights Hub freshness checks of every monitor (not templates), read once per answer. */
export function ihWatchIndex(): IhWatchCheck[] {
  const resolve = platformResolver();
  const out: IhWatchCheck[] = [];
  for (const m of db().all<MonitorRow>(
    'SELECT id, key, name, owner, acl, enabled, is_template, definition FROM monitors WHERE is_template = 0 ORDER BY name, id',
  )) {
    const def = parseJson<{ checks?: FreshnessDef[]; intervalSeconds?: number }>(m.definition, {});
    for (const c of def.checks ?? []) {
      if (c.type !== 'freshness' || (c.source ?? 'insightsHub') !== 'insightsHub' || !c.assetId || !c.aspect || !c.platform) continue;
      const platformId = resolve(c.platform);
      if (!platformId) continue;
      out.push({
        monitor: m,
        check: c,
        platformId,
        assetId: c.assetId.toLowerCase(),
        aspect: c.aspect,
        variables: new Set(c.variables ?? []),
        intervalSeconds: c.intervalSeconds ?? def.intervalSeconds ?? 60,
      });
    }
  }
  return out;
}

export interface LinkRow {
  asset_id: string;
  collection_id: string;
  sink_id: string;
  item: string;
  monitor_id: string;
  check_id: string;
  origin: 'created' | 'detected';
  created_at: string;
  created_by: string;
}

export const sinkLinks = (assetId: string, collectionId: string, sinkId: string) =>
  db().all<LinkRow>('SELECT * FROM plant_ih_monitor_links WHERE asset_id = ? AND collection_id = ? AND sink_id = ?', assetId, collectionId, sinkId);

/** A watcher as the reader may see it: named and linked, or (a monitor they may not see) only counted. */
export function watcherOf(w: Pick<IhWatchCheck, 'monitor' | 'check'>, linked: boolean): PlantIhWatcher | null {
  if (!permissionsOfRow(w.monitor).includes('view')) return null;
  return {
    monitorId: w.monitor.id,
    monitorKey: w.monitor.key,
    monitorName: w.monitor.name,
    checkId: w.check.id,
    checkName: w.check.name,
    enabled: !!Number(w.monitor.enabled) && w.check.enabled !== false,
    linked,
    path: plantOnly(currentUser()) ? null : `/monitors/${w.monitor.id}`,
  };
}

/** The checks that watch a target: same platform, asset (case ignored) and aspect, with the variable. */
export const watching = (index: IhWatchCheck[], platformId: string, assetId: string, aspect: string, variable: string): IhWatchCheck[] =>
  index.filter((w) => w.platformId === platformId && w.assetId === assetId.toLowerCase() && w.aspect === aspect && w.variables.has(variable));

/**
 * Stores the links the last check of the mapping found (origin `detected`, replaced by each check); links made from
 * the mapping (origin `created`) stay until their monitor or sink goes.
 */
export function storeDetectedLinks(
  assetId: string,
  collectionId: string,
  sinkId: string,
  found: { item: string; monitorId: string; checkId: string }[],
  by: string,
  at: string,
): void {
  db().run(
    "DELETE FROM plant_ih_monitor_links WHERE asset_id = ? AND collection_id = ? AND sink_id = ? AND origin = 'detected'",
    assetId,
    collectionId,
    sinkId,
  );
  storeLinks(assetId, collectionId, sinkId, found, 'detected', by, at);
}

export function storeLinks(
  assetId: string,
  collectionId: string,
  sinkId: string,
  links: { item: string; monitorId: string; checkId: string }[],
  origin: LinkRow['origin'],
  by: string,
  at: string,
): void {
  for (const l of links)
    db().run(
      `INSERT INTO plant_ih_monitor_links (asset_id, collection_id, sink_id, item, monitor_id, check_id, origin, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (asset_id, collection_id, sink_id, item, monitor_id, check_id) DO NOTHING`,
      assetId,
      collectionId,
      sinkId,
      l.item,
      l.monitorId,
      l.checkId,
      origin,
      at,
      by,
    );
}

/**
 * The leader for a new monitor's states: a monitor with states of its own (a condition, not following another one)
 * that the asset links to and the reader may see – the first by name. Its off states keep the new checks quiet while
 * the machine is off as planned.
 */
export function leaderOf(assetId: string): PlantIhLeader | null {
  const rows = db().all<MonitorRow>(
    `SELECT m.id, m.key, m.name, m.owner, m.acl, m.enabled, m.is_template, m.definition FROM item_links l JOIN monitors m ON (m.id = l.to_id OR m.key = l.to_id)
     WHERE l.from_kind = 'asset' AND l.from_id = ? AND l.to_kind = 'monitor' AND m.is_template = 0 ORDER BY m.name, m.id`,
    assetId,
  );
  for (const m of rows) {
    if (!permissionsOfRow(m).includes('view')) continue;
    const st = parseJson<{ states?: { from?: string; cases?: { id: string; name?: string; status?: string }[] } }>(m.definition, {}).states;
    if (!st?.cases?.length || st.from) continue;
    return { monitorId: m.id, key: m.key, name: m.name, states: st.cases.map((c) => ({ id: c.id, name: c.name || c.id, off: c.status === 'off' })) };
  }
  return null;
}
