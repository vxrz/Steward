import type { PlantCataloguePermission } from '@sm/shared';
import { db } from '../db.js';
import type { ShareKindDef } from '../auth/shares.js';
import { PLANT_CATALOGUE_SHARES, catalogueEntryAccess } from './catalogue-access.js';

/**
 * The plant catalogues as kinds of the shares core (0.21.0, #293; auth/shares.ts): what the expiry job, its reminders
 * and the Access tab need – the share model, the entry's name and page, and the rights of a user (through the policy
 * module, shares included). Registered by the plant feature's manifest.
 */
const named = (table: string) => (id: string) => db().get<{ name: string }>(`SELECT name FROM ${table} WHERE id = ?`, id)?.name;

export const PLANT_CATALOGUE_SHARE_KINDS: readonly ShareKindDef<PlantCataloguePermission>[] = [
  {
    kind: 'device_profile',
    model: PLANT_CATALOGUE_SHARES,
    name: named('plant_profiles'),
    link: (id) => `/plant/profiles/${encodeURIComponent(id)}`,
    rights: (u, id) => catalogueEntryAccess(u, 'device_profile', id).permissions,
  },
  {
    kind: 'kpi_definition',
    model: PLANT_CATALOGUE_SHARES,
    name: named('plant_kpis'),
    link: (id) => `/plant/kpis/${encodeURIComponent(id)}`,
    rights: (u, id) => catalogueEntryAccess(u, 'kpi_definition', id).permissions,
  },
];
