import type { LinkTarget } from '@sm/shared';
import { db } from '../db.js';
import { currentUser } from '../auth/context.js';
import { likeEscape } from '../database/sql.js';
import type { LinkResolver } from '../records/links.js';
import { conduitLinkKind } from './network.js';
import { siteRights, sitePermissions } from './access.js';
import { plantEnabled } from './settings.js';
import type { AssetRow, SiteRow } from './model.js';
import { sinksOf } from './collections-model.js';

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

// ---------- 0.12: device profiles, data collections and their sinks ----------

/**
 * Device profiles belong to no site: everyone who sees the plant registry sees them (plant/access.ts) – every role
 * but "status" (status viewers see no site, so no profile either).
 */
export const seesProfiles = (u = currentUser()): boolean => !!u && u.roles.some((r) => r !== 'status');

type ProfileLinkRow = { id: string; name: string; manufacturer: string; model: string };
const profileDetail = (p: ProfileLinkRow) => [p.manufacturer, p.model].filter(Boolean).join(' ') || undefined;

const profileLinkKind: LinkResolver = {
  resolve(id) {
    if (!plantEnabled() || !seesProfiles()) return null;
    const p = db().get<ProfileLinkRow>('SELECT id, name, manufacturer, model FROM plant_profiles WHERE id = ?', id);
    return p ? { label: p.name, path: `/plant/profiles/${encodeURIComponent(p.id)}`, detail: profileDetail(p) } : null;
  },
  search(q, limit): LinkTarget[] {
    if (!plantEnabled() || !seesProfiles()) return [];
    const text = q.trim().toLowerCase();
    // filtered here, not by a pattern (it matches case differently on SQLite and PostgreSQL)
    return db()
      .all<ProfileLinkRow>('SELECT id, name, manufacturer, model FROM plant_profiles ORDER BY name, id')
      .filter((p) => !text || [p.name, p.id].some((x) => x.toLowerCase().includes(text)))
      .slice(0, limit)
      .map((p) => ({ kind: 'device-profile' as const, id: p.id, label: p.name, detail: profileDetail(p) }));
  },
};

/** `<asset>/<collection>[/<sink>]` split; null when it is not one. */
export function collectionLinkId(id: string): { assetId: string; collectionId: string; sinkId: string | null } | null {
  const parts = id.split('/');
  if (parts.length < 2 || parts.length > 3 || parts.some((x) => !x)) return null;
  return { assetId: parts[0]!, collectionId: parts[1]!, sinkId: parts[2] ?? null };
}

type CollectionLinkRow = { asset_id: string; id: string; name: string; sinks: string; destination: string | null; asset_name: string; site_id: string };
const COLLECTION_SELECT =
  'SELECT c.asset_id, c.id, c.name, c.sinks, c.destination, a.name AS asset_name, a.site_id FROM plant_collections c JOIN plant_assets a ON a.id = c.asset_id';
const collectionPath = (assetId: string, id: string) => `/plant/assets/${encodeURIComponent(assetId)}/collections?collection=${encodeURIComponent(id)}`;

/** A collection the reader may see (its asset's site), or undefined. */
function visibleCollection(assetId: string, collectionId: string): CollectionLinkRow | undefined {
  const c = db().get<CollectionLinkRow>(`${COLLECTION_SELECT} WHERE c.asset_id = ? AND c.id = ?`, assetId, collectionId);
  const s = c ? db().get<SiteRow>('SELECT id, acl FROM plant_sites WHERE id = ?', c.site_id) : undefined;
  return c && s && sitePermissions(s).includes('view') ? c : undefined;
}

/** The sinks of a collection row (the 0.11 destination as the first one). */
const sinkNames = (c: Pick<CollectionLinkRow, 'sinks' | 'destination'>): { id: string; name: string }[] => sinksOf(c);

const collectionLinkKind: LinkResolver = {
  resolve(id) {
    if (!plantEnabled()) return null;
    const k = collectionLinkId(id);
    if (!k || k.sinkId) return null;
    const c = visibleCollection(k.assetId, k.collectionId);
    return c ? { label: c.name, path: collectionPath(c.asset_id, c.id), detail: c.asset_name } : null;
  },
  search(q, limit): LinkTarget[] {
    if (!plantEnabled()) return [];
    const rights = siteRights(db().all<SiteRow>('SELECT id, acl FROM plant_sites'));
    const text = q.trim().toLowerCase();
    return db()
      .all<CollectionLinkRow>(`${COLLECTION_SELECT} ORDER BY c.name, c.asset_id, c.id`)
      .filter((c) => !text || [c.name, c.id, c.asset_name].some((x) => x.toLowerCase().includes(text)))
      .filter((c) => rights.get(c.site_id)?.includes('view'))
      .slice(0, limit)
      .map((c) => ({ kind: 'data-collection' as const, id: `${c.asset_id}/${c.id}`, label: c.name, detail: c.asset_name }));
  },
};

const sinkLinkKind: LinkResolver = {
  resolve(id) {
    if (!plantEnabled()) return null;
    const k = collectionLinkId(id);
    if (!k?.sinkId) return null;
    const c = visibleCollection(k.assetId, k.collectionId);
    const sink = c ? sinkNames(c).find((x) => x.id === k.sinkId) : undefined;
    return c && sink ? { label: sink.name || sink.id, path: collectionPath(c.asset_id, c.id), detail: `${c.name} · ${c.asset_name}` } : null;
  },
  search(q, limit): LinkTarget[] {
    if (!plantEnabled()) return [];
    const rights = siteRights(db().all<SiteRow>('SELECT id, acl FROM plant_sites'));
    const text = q.trim().toLowerCase();
    const out: LinkTarget[] = [];
    // sinks live in the collections' JSON: the collections of visible sites, filtered here
    for (const c of db().all<CollectionLinkRow>(`${COLLECTION_SELECT} ORDER BY c.name, c.asset_id, c.id`)) {
      if (!rights.get(c.site_id)?.includes('view')) continue;
      for (const sk of sinkNames(c)) {
        if (text && ![sk.name, sk.id, c.name, c.asset_name].some((x) => (x ?? '').toLowerCase().includes(text))) continue;
        out.push({ kind: 'data-sink', id: `${c.asset_id}/${c.id}/${sk.id}`, label: sk.name || sk.id, detail: `${c.name} · ${c.asset_name}` });
        if (out.length >= limit) return out;
      }
    }
    return out;
  },
};

/** The link kinds of the plant registry (features/plant.ts registers them). */
export const PLANT_LINK_KINDS: readonly { kind: string; resolver: LinkResolver }[] = [
  { kind: 'site', resolver: siteLinkKind },
  { kind: 'asset', resolver: assetLinkKind },
  { kind: 'conduit', resolver: conduitLinkKind },
  { kind: 'device-profile', resolver: profileLinkKind },
  { kind: 'data-collection', resolver: collectionLinkKind },
  { kind: 'data-sink', resolver: sinkLinkKind },
];
