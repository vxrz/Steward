import type { LinkTarget } from '@sm/shared';
import { db } from '../db.js';
import { likeEscape } from '../database/sql.js';
import type { LinkResolver } from '../records/links.js';
import { conduitLinkKind } from './network.js';
import { siteRights, sitePermissions } from './access.js';
import { plantEnabled } from './settings.js';
import type { AssetRow, SiteRow } from './model.js';

/**
 * Sites and assets as link kinds (#218): documents, records, tickets, services and applications can name them, and
 * they hold links themselves (an asset to the systems, applications and platforms it uses). A link shows its target
 * only to readers who may see the target's site; while the module is off nothing resolves (links stay, hidden).
 * The plant manifest (features/plant.ts) registers them, with the conduits of the network.
 */

const like = (q: string) => `%${likeEscape(q.trim().toLowerCase())}%`;

const siteLinkKind: LinkResolver = {
  resolve(id) {
    if (!plantEnabled()) return null;
    const s = db().get<SiteRow>('SELECT id, code, name, names, acl FROM plant_sites WHERE id = ?', id);
    if (!s || !sitePermissions(s).includes('view')) return null;
    return { label: s.name, path: `/plant/sites/${encodeURIComponent(s.id)}`, detail: s.code || undefined };
  },
  search(q, limit): LinkTarget[] {
    if (!plantEnabled()) return [];
    return db()
      .all<SiteRow>(
        "SELECT id, code, name, names, acl FROM plant_sites WHERE lower(name) LIKE ? ESCAPE '\\' OR lower(id) LIKE ? ESCAPE '\\' OR lower(code) LIKE ? ESCAPE '\\' ORDER BY name",
        like(q),
        like(q),
        like(q),
      )
      .filter((s) => sitePermissions(s).includes('view'))
      .slice(0, limit)
      .map((s) => ({ kind: 'site' as const, id: s.id, label: s.name, detail: s.code || undefined }));
  },
};

const assetDetail = (a: Pick<AssetRow, 'manufacturer' | 'model' | 'site_id'>) =>
  [[a.manufacturer, a.model].filter(Boolean).join(' '), a.site_id].filter(Boolean).join(' · ');

const assetLinkKind: LinkResolver = {
  resolve(id) {
    if (!plantEnabled()) return null;
    const a = db().get<AssetRow>('SELECT id, name, manufacturer, model, site_id FROM plant_assets WHERE id = ?', id);
    const s = a ? db().get<SiteRow>('SELECT id, acl FROM plant_sites WHERE id = ?', a.site_id) : undefined;
    if (!a || !s || !sitePermissions(s).includes('view')) return null;
    return { label: a.name, path: `/plant/assets/${encodeURIComponent(a.id)}`, detail: assetDetail(a) };
  },
  search(q, limit): LinkTarget[] {
    if (!plantEnabled()) return [];
    const rights = siteRights(db().all<SiteRow>('SELECT id, acl FROM plant_sites'));
    return db()
      .all<AssetRow>(
        "SELECT id, name, manufacturer, model, site_id FROM plant_assets WHERE lower(name) LIKE ? ESCAPE '\\' OR lower(id) LIKE ? ESCAPE '\\' ORDER BY name LIMIT 2000",
        like(q),
        like(q),
      )
      .filter((a) => rights.get(a.site_id)?.includes('view'))
      .slice(0, limit)
      .map((a) => ({ kind: 'asset' as const, id: a.id, label: a.name, detail: assetDetail(a) }));
  },
};

/** The link kinds of the plant registry (features/plant.ts registers them). */
export const PLANT_LINK_KINDS: readonly { kind: string; resolver: LinkResolver }[] = [
  { kind: 'site', resolver: siteLinkKind },
  { kind: 'asset', resolver: assetLinkKind },
  { kind: 'conduit', resolver: conduitLinkKind },
];
