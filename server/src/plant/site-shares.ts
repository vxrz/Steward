import type { PlantPermission } from '@sm/shared';
import { db } from '../db.js';
import { SITE_SHARE_MODEL } from '../auth/policy.js';
import type { ShareKindDef } from '../auth/shares.js';
import { siteAccess } from './access.js';

/**
 * Plant sites switched to shares (0.23.0, ADR 0033 phase 2, #297): their access lists became shares
 * (migrations/access.ts); a site's buildings, assets, network and collections follow it. Who manages the site
 * (designers by default, Manage shares) changes its shares and switches Restricted (decision 15).
 */
export const SITE_SHARE_KIND: ShareKindDef<PlantPermission> = {
  kind: 'site',
  model: SITE_SHARE_MODEL,
  name: (id) => db().get<{ name: string }>('SELECT name FROM plant_sites WHERE id = ?', id)?.name,
  link: (id) => `/plant/sites/${encodeURIComponent(id)}`,
  rights: (u, id) => siteAccess(u, { id }).permissions,
  restrictBy: 'manage',
};
