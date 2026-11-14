import type { PlantAssetEdge, PlantCollectsFrom, PlantCollectsFromEntry, PlantEdgeDevice, PlantSystemEdge } from '@sm/shared';
import { db } from '../db.js';
import { currentUser } from '../auth/context.js';
import { plantOnly } from '../auth/policy.js';
import { catalogueVisibleNow } from '../records/access.js';
import { HttpError } from '../util.js';
import { iemDeviceStatus } from '../catalogue/edge.js';
import { requirePlant } from './settings.js';
import { visibleAsset } from './service.js';
import { visibleAssets } from './catalogue.js';
import { brief } from './collections.js';
import { collectionValuesOf, type CollectionRow } from './collections-model.js';
import { deviceRows, deviceValuesOf } from './network-model.js';

/**
 * Edge devices in the plant registry (0.25.0, ADR 0037 part 3, docs/PLANT.md#edge-devices): a device of an asset may
 * be the Steward system it is. Derived on read, nothing stored:
 *
 * - **Apps on this device** – the applications that run on that system (the catalogue's "runs on"), on the asset;
 * - **Collects data from** – the collections whose collector runs there: the collector names the system as its host,
 *   or the collector is an application that runs on the system – grouped by the asset they read, on the edge asset and
 *   on the system's page;
 * - the system's page names the plant devices that are it.
 *
 * Team scope: a system or application the reader may not see is counted, never named; collections and devices follow
 * their sites (one on a site the reader may not see is counted).
 */

interface SystemLite {
  id: string;
  name: string;
  owners: string;
  iem_device_id: string | null;
}

const systemRow = (id: string) => db().get<SystemLite>('SELECT id, name, owners, iem_device_id FROM systems WHERE id = ?', id);
const systemSeen = (s: SystemLite | undefined): s is SystemLite => !!s && catalogueVisibleNow('system', s);

/** The applications that run on these systems (every environment), with whether the reader may see each. */
function appsOn(systemIds: string[]): { systemId: string; id: string; name: string; environment: string; archived: boolean; visible: boolean }[] {
  if (!systemIds.length) return [];
  return db()
    .all<{ system_id: string; id: string; name: string; environment: string; archived: number; owners: string }>(
      `SELECT l.system_id, a.id, a.name, l.environment, a.archived, a.owners FROM application_systems l JOIN applications a ON a.id = l.application_id
        WHERE l.system_id IN (${systemIds.map(() => '?').join(',')}) ORDER BY a.name, a.id, l.environment`,
      ...systemIds,
    )
    .map((r) => ({
      systemId: r.system_id,
      id: r.id,
      name: r.name,
      environment: r.environment,
      archived: !!r.archived,
      visible: catalogueVisibleNow('application', { id: r.id, owners: r.owners }),
    }));
}

/**
 * The collections whose collector runs on one of these systems: named as its host, or an application that runs there.
 * Grouped by the asset they read; collections of assets the reader may not see are counted.
 */
export function collectsFrom(systemIds: string[]): PlantCollectsFrom {
  if (!systemIds.length) return { groups: [], hidden: 0 };
  const systems = new Set(systemIds);
  const apps = new Set(appsOn(systemIds).map((a) => a.id));
  const v = visibleAssets();
  const groups = new Map<string, PlantCollectsFrom['groups'][number]>();
  let hidden = 0;
  for (const r of db().all<CollectionRow>('SELECT * FROM plant_collections ORDER BY asset_id, position, id')) {
    const c = collectionValuesOf(r).collector;
    const via: PlantCollectsFromEntry['via'] | null =
      c.host && systems.has(c.host) ? 'host' : c.kind === 'application' && apps.has(c.ref) ? 'application' : null;
    if (!via) continue;
    const asset = v.assets.get(r.asset_id);
    if (!asset) {
      hidden++;
      continue;
    }
    const site = v.sites.get(asset.site_id)!;
    const g = groups.get(asset.id) ?? { asset: { id: asset.id, name: asset.name, siteId: site.id, siteName: site.name }, collections: [] };
    g.collections.push({ ...brief(r, asset), via });
    groups.set(asset.id, g);
  }
  return { groups: [...groups.values()].sort((a, b) => a.asset.name.localeCompare(b.asset.name) || a.asset.id.localeCompare(b.asset.id)), hidden };
}

/** GET /api/plant/assets/:assetId/edge: the asset's devices that are systems, their applications and status. */
export function assetEdge(assetId: string): PlantAssetEdge {
  visibleAsset(assetId); // 404 for who may not see it
  const linked = deviceRows(assetId)
    .map(deviceValuesOf)
    .filter((d) => d.system);
  const seen = new Map<string, SystemLite>();
  for (const d of linked) {
    const s = systemRow(d.system!);
    if (systemSeen(s)) seen.set(s.id, s);
  }
  const apps = appsOn([...seen.keys()]);
  const linkable = !plantOnly(currentUser());
  const devices: PlantEdgeDevice[] = linked.map((d) => {
    const s = seen.get(d.system!);
    const on = s ? apps.filter((a) => a.systemId === s.id) : [];
    return {
      deviceId: d.id,
      hostname: d.hostname,
      domain: d.domain,
      address: d.address,
      system: s ? { id: s.id, name: s.name, path: linkable ? `/systems/${encodeURIComponent(s.id)}` : null } : null,
      // a link to a system that no longer exists reads like one the reader may not see
      systemHidden: !s,
      apps: on.filter((a) => a.visible).map(({ id, name, environment, archived }) => ({ id, name, environment, archived })),
      hiddenApps: on.filter((a) => !a.visible).length,
      iem: s?.iem_device_id ? iemDeviceStatus(s.iem_device_id) : null,
    };
  });
  return { devices, collects: collectsFrom([...seen.keys()]) };
}

/** GET /api/plant/systems/:systemId/edge: the plant devices that are this system, and what collects data on it. */
export function systemEdge(systemId: string): PlantSystemEdge {
  requirePlant();
  const s = systemRow(systemId);
  if (!systemSeen(s)) throw new HttpError(404, `System ${systemId} not found`, 'SYSTEM_NOT_FOUND', { id: systemId });
  const v = visibleAssets();
  let hiddenDevices = 0;
  const devices: PlantSystemEdge['devices'] = [];
  for (const r of db().all<{ asset_id: string; id: string; hostname: string; domain: string; address: string }>(
    'SELECT asset_id, id, hostname, domain, address FROM plant_devices WHERE system_id = ? ORDER BY asset_id, position, id',
    systemId,
  )) {
    const asset = v.assets.get(r.asset_id);
    if (!asset) {
      hiddenDevices++;
      continue;
    }
    const site = v.sites.get(asset.site_id)!;
    devices.push({
      siteId: site.id,
      siteName: site.name,
      assetId: asset.id,
      assetName: asset.name,
      deviceId: r.id,
      hostname: r.hostname,
      domain: r.domain,
      address: r.address,
    });
  }
  return { devices, hiddenDevices, collects: collectsFrom([systemId]) };
}
