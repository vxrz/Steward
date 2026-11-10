import type { PlantMaintenanceTargetKind } from '@sm/shared';
import type { AuthUser } from '../auth/context.js';
import { db } from '../db.js';
import { siteAccess } from './access.js';
import { plantEnabled } from './settings.js';

/**
 * Plant entries as targets of maintenance windows (0.14, docs/APPLICATIONS.md "Maintenance windows"): a site, an asset,
 * a device (`<asset>/<device>`) or a data collection (`<asset>/<collection>`). Kept small – the maintenance module asks
 * here for names and rights, without loading the registry's services. While the module is off, plant targets resolve to
 * nothing (a window keeps them; they read like a deleted item).
 */

export interface PlantTargetInfo {
  name: string;
  siteId: string;
  /** The asset of a device or collection, or the asset itself */
  assetId: string | null;
  path: string;
}

const enc = encodeURIComponent;
/** `<asset>/<id>`: the asset part and the entry's id (null: not that form). */
export function splitAssetId(id: string): { assetId: string; id: string } | null {
  const i = id.indexOf('/');
  if (i <= 0 || i === id.length - 1 || id.indexOf('/', i + 1) >= 0) return null;
  return { assetId: id.slice(0, i), id: id.slice(i + 1) };
}

/** The entry as stored, whoever asks (null: none, or the module is off). */
export function plantTarget(kind: PlantMaintenanceTargetKind, id: string): PlantTargetInfo | null {
  if (!plantEnabled()) return null;
  if (kind === 'site') {
    const s = db().get<{ name: string }>('SELECT name FROM plant_sites WHERE id = ?', id);
    return s ? { name: s.name, siteId: id, assetId: null, path: `/plant/sites/${enc(id)}` } : null;
  }
  if (kind === 'asset') {
    const a = db().get<{ name: string; site_id: string }>('SELECT name, site_id FROM plant_assets WHERE id = ?', id);
    return a ? { name: a.name, siteId: a.site_id, assetId: id, path: `/plant/assets/${enc(id)}` } : null;
  }
  const k = splitAssetId(id);
  if (!k) return null;
  const a = db().get<{ name: string; site_id: string }>('SELECT name, site_id FROM plant_assets WHERE id = ?', k.assetId);
  if (!a) return null;
  if (kind === 'device') {
    const d = db().get<{ hostname: string }>('SELECT hostname FROM plant_devices WHERE asset_id = ? AND id = ?', k.assetId, k.id);
    return d
      ? { name: `${d.hostname || k.id} (${a.name})`, siteId: a.site_id, assetId: k.assetId, path: `/plant/assets/${enc(k.assetId)}#device-${enc(k.id)}` }
      : null;
  }
  const c = db().get<{ name: string }>('SELECT name FROM plant_collections WHERE asset_id = ? AND id = ?', k.assetId, k.id);
  return c
    ? {
        name: `${c.name} (${a.name})`,
        siteId: a.site_id,
        assetId: k.assetId,
        path: `/plant/assets/${enc(k.assetId)}/collections?collection=${enc(k.id)}`,
      }
    : null;
}

function rights(u: AuthUser | null, siteId: string) {
  const s = db().get<{ id: string; acl: string }>('SELECT id, acl FROM plant_sites WHERE id = ?', siteId);
  return s ? siteAccess(u, s).permissions : [];
}

/** The entry's name for this reader (null: it does not exist, the module is off, or the reader may not see its site); jobs see all. */
export function plantTargetName(kind: PlantMaintenanceTargetKind, id: string, u: AuthUser | null): string | null {
  const t = plantTarget(kind, id);
  if (!t) return null;
  return !u || rights(u, t.siteId).includes('view') ? t.name : null;
}

/** May the user plan maintenance for it: who manages its site. */
export function mayPlanPlantTarget(kind: PlantMaintenanceTargetKind, id: string, u: AuthUser): boolean {
  const t = plantTarget(kind, id);
  return !!t && rights(u, t.siteId).includes('manage');
}

/** The site (and with it the rights) an entry belongs to – null when it does not exist. */
export const plantTargetSite = (kind: PlantMaintenanceTargetKind, id: string): string | null => plantTarget(kind, id)?.siteId ?? null;
