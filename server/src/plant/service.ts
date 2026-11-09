import type { z } from 'zod';
import { cleanAcl } from '../auth/permissions.js';
import {
  PLANT_LIMITS,
  PLANT_PERMISSIONS,
  type AclEntry,
  type AssetStatus,
  type PlantAssetDetail,
  type PlantAssetSummary,
  type PlantConfig,
  type PlantHierarchySite,
  type PlantPermission,
  type PlantSiteDetail,
  type PlantSiteSummary,
} from '@sm/shared';
import { db } from '../db.js';
import { refuseAliasId } from './ids.js';
import { audit } from '../audit.js';
import { me } from '../auth/access.js';
import { assignCreatorTeams } from '../auth/policy.js';
import { listBacklinks, listLinks } from '../records/links.js';
import { imageInfo, looksLikeSvg } from '../theme/service.js';
import { HttpError, nowIso, parseJson, sha256 } from '../util.js';
import { canCreateSites, canManageCatalogue, plantManagesSome, requireManage, siteRights, sitePermissions } from './access.js';
import { cleanFields, plantSettings, requirePlant } from './settings.js';
import { mapClient } from './map.js';
import { allProfiles, assignmentValuesOf, type AssignmentRow } from './data-model.js';
import { deliveries } from './checks.js';
import {
  assetInput,
  assetRowOf,
  assetUpdate,
  assetValuesOf,
  buildingInput,
  buildingList,
  buildingProblem,
  buildingUpdate,
  buildingValuesOf,
  changedKeys,
  cleanRefs,
  cleanTags,
  equipmentCycle,
  loadAllIndexes,
  loadIndex,
  locationOf,
  nodeInput,
  nodeProblem,
  nodeTree,
  nodeUpdate,
  nodeValuesOf,
  notFound,
  refsOf,
  refsOfOne,
  removeAssetRow,
  removeSiteRows,
  resolveLocation,
  ruleError,
  siteInput,
  siteRowOf,
  siteUpdate,
  siteValuesOf,
  upsertAsset,
  upsertBuilding,
  upsertNode,
  upsertSite,
  type AssetRow,
  type AssetValues,
  type SiteIndex,
  type SiteRow,
  type SiteValues,
} from './model.js';

/**
 * The plant registry's services (#218): sites with their hierarchy and buildings, assets, their images, external
 * references and own fields. Every function checks that the module is on and the caller's rights on the site, and
 * audits every change (entity types site and asset; the hierarchy and buildings are audited on their site).
 */

const LEVEL_TYPE = { area: 'area', work_center: 'workCenter', work_unit: 'workUnit' } as const;
const levelText = (l: string) => l.replace('_', ' ');

// ---------- sites ----------

/** The site, if the caller may see it (404 otherwise, like one that does not exist). */
export function visibleSite(id: string): { row: SiteRow; perms: PlantPermission[] } {
  requirePlant();
  const row = siteRowOf(id);
  const perms = row ? sitePermissions(row) : [];
  if (!row || !perms.includes('view')) throw notFound('site', id);
  return { row, perms };
}

function manageableSite(id: string, what: string): SiteRow {
  const s = visibleSite(id);
  requireManage(s.perms, what);
  return s.row;
}

function statusCounts(assets: AssetRow[]): Map<string, Partial<Record<AssetStatus, number>>> {
  const out = new Map<string, Partial<Record<AssetStatus, number>>>();
  for (const a of assets) {
    const c = out.get(a.site_id) ?? {};
    c[a.status] = (c[a.status] ?? 0) + 1;
    out.set(a.site_id, c);
  }
  return out;
}

const summaryOf = (
  r: SiteRow,
  perms: PlantPermission[],
  index: SiteIndex | undefined,
  counts: Partial<Record<AssetStatus, number>> | undefined,
): PlantSiteSummary => {
  const v = siteValuesOf(r, []);
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    names: v.names,
    description: r.description,
    geo: v.geo,
    areaCount: [...(index?.nodes.values() ?? [])].filter((n) => n.level === 'area').length,
    buildingCount: index?.buildings.size ?? 0,
    assetCount: Object.values(counts ?? {}).reduce((a, b) => a + (b ?? 0), 0),
    statusCounts: counts ?? {},
    canManage: perms.includes('manage'),
    importId: r.import_id,
    notInSource: !!r.not_in_source,
    revision: Number(r.revision ?? 1),
    // 0.13.0: the site's switch "Changes need a second person" (plant.changeSet optional)
    review: Number((r as SiteRow & { review?: number }).review ?? 0) === 1,
    canPropose: perms.includes('propose'),
    updatedAt: r.updated_at,
  };
};

export function listSites(): PlantSiteSummary[] {
  requirePlant();
  const rows = db().all<SiteRow>('SELECT * FROM plant_sites ORDER BY name');
  const rights = siteRights(rows);
  const visible = rows.filter((r) => rights.get(r.id)!.includes('view'));
  if (!visible.length) return [];
  const indexes = loadAllIndexes();
  const counts = statusCounts(db().all<AssetRow>('SELECT site_id, status FROM plant_assets'));
  return visible.map((r) => summaryOf(r, rights.get(r.id)!, indexes.get(r.id), counts.get(r.id)));
}

export function getSite(id: string): PlantSiteDetail {
  const { row, perms } = visibleSite(id);
  const index = loadIndex(id);
  const assets = db().all<AssetRow>('SELECT * FROM plant_assets WHERE site_id = ?', id);
  const placed = new Map<string, number>();
  for (const a of assets) {
    const at = a.work_unit_id ?? a.work_center_id ?? a.area_id;
    if (at) placed.set(at, (placed.get(at) ?? 0) + 1);
  }
  const v = siteValuesOf(row, refsOfOne('site', id));
  return {
    ...summaryOf(row, perms, index, statusCounts(assets).get(id)),
    contacts: v.contacts,
    refs: v.refs,
    fields: v.fields,
    areas: nodeTree(index, placed),
    buildings: buildingList(index, assets),
    acl: perms.includes('manage') ? parseJson<AclEntry<PlantPermission>[]>(row.acl, []) : null,
    // as before 0.13: view and manage (the propose right is canPropose – clients that compare the list keep working)
    permissions: perms.filter((x) => x !== 'propose'),
    links: listLinks('site', id),
    backlinks: listBacklinks('site', id),
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

/** The sites with their trees and buildings, for pickers and filters. */
export function hierarchy(siteId?: string): PlantHierarchySite[] {
  requirePlant();
  const rows = siteId ? [visibleSite(siteId).row] : db().all<SiteRow>('SELECT * FROM plant_sites ORDER BY name');
  const rights = siteRights(rows);
  const indexes = loadAllIndexes();
  return rows
    .filter((r) => rights.get(r.id)!.includes('view'))
    .map((r) => {
      const index = indexes.get(r.id) ?? { siteId: r.id, nodes: new Map(), buildings: new Map() };
      return {
        id: r.id,
        code: r.code,
        name: r.name,
        names: parseJson(r.names, {}),
        canManage: rights.get(r.id)!.includes('manage'),
        areas: nodeTree(index, new Map()),
        buildings: buildingList(index, []),
      };
    });
}

export function plantConfig(): PlantConfig {
  requirePlant();
  const s = plantSettings();
  return {
    enterprise: s.enterprise,
    labels: s.labels,
    fields: s.fields,
    canCreateSites: canCreateSites(),
    canManageSome: plantManagesSome(),
    canManageCatalogue: canManageCatalogue(),
    map: mapClient(),
  };
}

function checkSiteCode(code: string, id: string): void {
  if (!code) return;
  const other = db().get<{ id: string; acl: string }>('SELECT id, acl FROM plant_sites WHERE lower(code) = lower(?) AND id <> ?', code, id);
  if (!other) return;
  // a site the caller may not see is not named
  if (!sitePermissions(other).includes('view')) throw new HttpError(409, `Another site has the code ${code} already`, 'PLANT_SITE_CODE_TAKEN_HIDDEN', { code });
  throw new HttpError(409, `Site "${other.id}" has the code ${code} already`, 'PLANT_SITE_CODE_TAKEN', { code, id: other.id });
}

const siteValues = (id: string, b: z.infer<typeof siteUpdate>): SiteValues => ({
  id,
  code: b.code,
  name: b.name,
  names: b.names,
  description: b.description,
  geo: b.geo,
  contacts: b.contacts,
  refs: cleanRefs(b.refs),
  fields: cleanFields('site', b.fields),
});

export function createSite(input: z.infer<typeof siteInput>): PlantSiteDetail {
  requirePlant();
  const u = me();
  if (!canCreateSites(u)) throw new HttpError(403, 'You are not allowed to add sites', 'FORBIDDEN', { context: 'createSites' });
  if (siteRowOf(input.id)) throw new HttpError(409, `A site with the id ${input.id} exists already`, 'PLANT_ID_TAKEN', { id: input.id });
  // an old id of a renamed entry still leads there (0.11.0): it is not free
  refuseAliasId('site', '', input.id);
  if (Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM plant_sites')!.n) >= PLANT_LIMITS.sites)
    throw new HttpError(409, `At most ${PLANT_LIMITS.sites} sites`, 'PLANT_LIMIT', { max: PLANT_LIMITS.sites });
  const v = siteValues(input.id, input);
  checkSiteCode(v.code, v.id);
  db().tx(() => {
    upsertSite(v, { at: nowIso(), by: u.username });
    assignCreatorTeams('site', v.id, u);
    audit({ action: 'site.created', entityType: 'site', entityId: v.id, summary: `Site "${v.name}" (${v.id}) added`, details: { code: v.code } });
  });
  return getSite(v.id);
}

export function updateSite(id: string, input: z.infer<typeof siteUpdate>): PlantSiteDetail {
  const row = manageableSite(id, 'change this site');
  const u = me();
  const before = siteValuesOf(row, refsOfOne('site', id));
  const v = siteValues(id, input);
  checkSiteCode(v.code, id);
  const changes = changedKeys(before, v);
  if (!changes.length) return getSite(id);
  db().tx(() => {
    // a record changed by hand keeps where it came from (a later import still knows it)
    upsertSite(v, { at: nowIso(), by: u.username }, { keepSource: true });
    audit({
      action: 'site.updated',
      entityType: 'site',
      entityId: id,
      summary: `Site "${v.name}" changed (${changes.join(', ')})`,
      details: { changes, old: pick(before, changes), new: pick(v, changes) },
    });
  });
  return getSite(id);
}

const pick = <T extends object>(o: T, keys: string[]) => Object.fromEntries(keys.map((k) => [k, (o as Record<string, unknown>)[k]]));

export function deleteSite(id: string): void {
  const row = manageableSite(id, 'delete this site');
  const n = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM plant_assets WHERE site_id = ?', id)!.n);
  if (n) throw new HttpError(409, `The site has ${n} assets – remove or move them first`, 'PLANT_SITE_HAS_ASSETS', { count: n });
  const nodes = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM plant_nodes WHERE site_id = ?', id)!.n);
  const buildings = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM plant_buildings WHERE site_id = ?', id)!.n);
  db().tx(() => {
    removeSiteRows(id);
    audit({
      action: 'site.deleted',
      entityType: 'site',
      entityId: id,
      summary: `Site "${row.name}" (${id}) deleted with ${nodes} hierarchy nodes and ${buildings} buildings`,
      details: { code: row.code, nodes, buildings },
    });
  });
}

export function setSiteAccess(id: string, acl: unknown): PlantSiteDetail {
  const row = manageableSite(id, 'change access to this site');
  const next = cleanAcl<PlantPermission>(acl, PLANT_PERMISSIONS).filter((e) => e.permissions.length);
  const before = parseJson<AclEntry<PlantPermission>[]>(row.acl, []);
  if (JSON.stringify(before) === JSON.stringify(next)) return getSite(id);
  db().tx(() => {
    db().run('UPDATE plant_sites SET acl = ?, updated_at = ?, updated_by = ? WHERE id = ?', JSON.stringify(next), nowIso(), me().username, id);
    audit({
      action: 'site.access_changed',
      entityType: 'site',
      entityId: id,
      summary: next.length ? `Access to site "${row.name}" restricted to ${next.length} entries` : `Access list of site "${row.name}" removed`,
      details: { old: before, new: next },
    });
  });
  return getSite(id);
}

// ---------- hierarchy ----------

const touchSite = (id: string) => db().run('UPDATE plant_sites SET updated_at = ?, updated_by = ? WHERE id = ?', nowIso(), me().username, id);

function nodeRules(
  index: SiteIndex,
  v: { id: string; level: 'area' | 'work_center' | 'work_unit'; parentId: string | null; buildingId: string | null; type: string },
) {
  const p = nodeProblem(index, v);
  if (p) throw ruleError(p);
}

export function createNode(siteId: string, input: z.infer<typeof nodeInput>): PlantSiteDetail {
  manageableSite(siteId, 'change this site');
  const index = loadIndex(siteId);
  if (index.nodes.has(input.id)) throw new HttpError(409, `The site has a node "${input.id}" already`, 'PLANT_ID_TAKEN', { id: input.id });
  // an old id of a renamed entry still leads there (0.11.0): it is not free
  refuseAliasId('node', siteId, input.id);
  if (index.nodes.size >= PLANT_LIMITS.nodesPerSite)
    throw new HttpError(409, `At most ${PLANT_LIMITS.nodesPerSite} nodes per site`, 'PLANT_LIMIT', { max: PLANT_LIMITS.nodesPerSite });
  nodeRules(index, input);
  const v = { ...input, fields: cleanFields(LEVEL_TYPE[input.level], input.fields) };
  const position = Math.max(-1, ...[...index.nodes.values()].filter((n) => n.parent_id === v.parentId).map((n) => n.position)) + 1;
  db().tx(() => {
    upsertNode(siteId, v, position, { at: nowIso(), by: me().username });
    touchSite(siteId);
    audit({
      action: 'site.node_added',
      entityType: 'site',
      entityId: siteId,
      summary: `${levelText(v.level)} "${v.name}" (${v.id}) added to site ${siteId}`,
      details: { node: v.id, level: v.level, parentId: v.parentId, buildingId: v.buildingId },
    });
  });
  return getSite(siteId);
}

export function updateNode(siteId: string, nodeId: string, input: z.infer<typeof nodeUpdate>): PlantSiteDetail {
  manageableSite(siteId, 'change this site');
  const index = loadIndex(siteId);
  const cur = index.nodes.get(nodeId);
  if (!cur) throw notFound('node', nodeId);
  const v = { id: nodeId, level: cur.level, ...input, fields: cleanFields(LEVEL_TYPE[cur.level], input.fields) };
  nodeRules(index, v);
  const before = nodeValuesOf(cur);
  const changes = changedKeys(before, v);
  if (!changes.length) return getSite(siteId);
  // moving a node (Move to…, 0.12) puts it last below its new parent and takes its assets along: they are placed
  // below it (their upper levels follow)
  const moved = changes.includes('parentId');
  const position = moved
    ? Math.max(-1, ...[...index.nodes.values()].filter((n) => n.parent_id === v.parentId && n.id !== nodeId).map((n) => n.position)) + 1
    : cur.position;
  db().tx(() => {
    upsertNode(siteId, v, position, { at: nowIso(), by: me().username }, { keepSource: true });
    if (moved) relocateAssets(siteId);
    touchSite(siteId);
    audit({
      action: 'site.node_changed',
      entityType: 'site',
      entityId: siteId,
      summary: `${levelText(cur.level)} "${v.name}" (${nodeId}) changed (${changes.join(', ')})`,
      details: { node: nodeId, changes, old: pick(before, changes), new: pick(v, changes) },
    });
  });
  return getSite(siteId);
}

/** After a node moved: the upper levels of every asset follow its innermost node. */
function relocateAssets(siteId: string): void {
  const index = loadIndex(siteId);
  const parentOf = (id: string | null) => (id ? (index.nodes.get(id)?.parent_id ?? null) : null);
  for (const a of db().all<AssetRow>('SELECT id, area_id, work_center_id, work_unit_id FROM plant_assets WHERE site_id = ?', siteId)) {
    const workCenterId = a.work_unit_id ? parentOf(a.work_unit_id) : a.work_center_id;
    const areaId = workCenterId ? parentOf(workCenterId) : a.area_id;
    if (workCenterId !== a.work_center_id || areaId !== a.area_id)
      db().run('UPDATE plant_assets SET area_id = ?, work_center_id = ? WHERE id = ?', areaId, workCenterId, a.id);
  }
}

export function deleteNode(siteId: string, nodeId: string): PlantSiteDetail {
  manageableSite(siteId, 'change this site');
  const index = loadIndex(siteId);
  const cur = index.nodes.get(nodeId);
  if (!cur) throw notFound('node', nodeId);
  const children = [...index.nodes.values()].filter((n) => n.parent_id === nodeId).length;
  const assets = Number(
    db().get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM plant_assets WHERE site_id = ? AND (area_id = ? OR work_center_id = ? OR work_unit_id = ?)',
      siteId,
      nodeId,
      nodeId,
      nodeId,
    )!.n,
  );
  if (children || assets)
    throw new HttpError(409, `"${cur.name}" still holds ${children} nodes and ${assets} assets`, 'PLANT_NODE_IN_USE', { children, assets });
  db().tx(() => {
    db().run('DELETE FROM plant_nodes WHERE site_id = ? AND id = ?', siteId, nodeId);
    touchSite(siteId);
    audit({
      action: 'site.node_removed',
      entityType: 'site',
      entityId: siteId,
      summary: `${levelText(cur.level)} "${cur.name}" (${nodeId}) removed from site ${siteId}`,
      details: { node: nodeId, level: cur.level },
    });
  });
  return getSite(siteId);
}

// ---------- buildings ----------

export function createBuilding(siteId: string, input: z.infer<typeof buildingInput>): PlantSiteDetail {
  manageableSite(siteId, 'change this site');
  const index = loadIndex(siteId);
  if (index.buildings.has(input.id)) throw new HttpError(409, `The site has a building "${input.id}" already`, 'PLANT_ID_TAKEN', { id: input.id });
  // an old id of a renamed entry still leads there (0.11.0): it is not free
  refuseAliasId('building', siteId, input.id);
  if (index.buildings.size >= PLANT_LIMITS.buildingsPerSite)
    throw new HttpError(409, `At most ${PLANT_LIMITS.buildingsPerSite} buildings per site`, 'PLANT_LIMIT', { max: PLANT_LIMITS.buildingsPerSite });
  const p = buildingProblem(index, input);
  if (p) throw ruleError(p);
  const v = { ...input, fields: cleanFields('building', input.fields) };
  db().tx(() => {
    upsertBuilding(siteId, v, index.buildings.size, { at: nowIso(), by: me().username });
    touchSite(siteId);
    audit({
      action: 'site.building_added',
      entityType: 'site',
      entityId: siteId,
      summary: `Building "${v.name}" (${v.id}) added to site ${siteId}`,
      details: { building: v.id, kind: v.kind },
    });
  });
  return getSite(siteId);
}

export function updateBuilding(siteId: string, buildingId: string, input: z.infer<typeof buildingUpdate>): PlantSiteDetail {
  manageableSite(siteId, 'change this site');
  const index = loadIndex(siteId);
  const cur = index.buildings.get(buildingId);
  if (!cur) throw notFound('building', buildingId);
  const v = { id: buildingId, ...input, fields: cleanFields('building', input.fields) };
  const p = buildingProblem(index, v);
  if (p) throw ruleError(p);
  const before = buildingValuesOf(cur);
  const changes = changedKeys(before, v);
  if (!changes.length) return getSite(siteId);
  db().tx(() => {
    upsertBuilding(siteId, v, cur.position, { at: nowIso(), by: me().username }, { keepSource: true });
    touchSite(siteId);
    audit({
      action: 'site.building_changed',
      entityType: 'site',
      entityId: siteId,
      summary: `Building "${v.name}" (${buildingId}) changed (${changes.join(', ')})`,
      details: { building: buildingId, changes, old: pick(before, changes), new: pick(v, changes) },
    });
  });
  return getSite(siteId);
}

export function deleteBuilding(siteId: string, buildingId: string): PlantSiteDetail {
  manageableSite(siteId, 'change this site');
  const index = loadIndex(siteId);
  const cur = index.buildings.get(buildingId);
  if (!cur) throw notFound('building', buildingId);
  const nodes = [...index.nodes.values()].filter((n) => n.building_id === buildingId).length;
  const parts = [...index.buildings.values()].filter((b) => b.parent_id === buildingId).length;
  const assets = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM plant_assets WHERE site_id = ? AND building_id = ?', siteId, buildingId)!.n);
  if (nodes || parts || assets)
    throw new HttpError(409, `"${cur.name}" is named by ${nodes} nodes, ${parts} building parts and ${assets} assets`, 'PLANT_BUILDING_IN_USE', {
      nodes,
      parts,
      assets,
    });
  db().tx(() => {
    db().run('DELETE FROM plant_buildings WHERE site_id = ? AND id = ?', siteId, buildingId);
    touchSite(siteId);
    audit({
      action: 'site.building_removed',
      entityType: 'site',
      entityId: siteId,
      summary: `Building "${cur.name}" (${buildingId}) removed from site ${siteId}`,
      details: { building: buildingId },
    });
  });
  return getSite(siteId);
}

// ---------- assets ----------

export interface AssetFilter {
  site?: string;
  /** Any level: assets in this area, work center or work unit */
  node?: string;
  domain?: string;
  status?: string;
  tag?: string;
  q?: string;
  /** An external reference: system:id (or just the id) */
  ref?: string;
  /** Assets with this device profile (#219) */
  profile?: string;
  /** With profile: assets that deliver this data point of it */
  dataPoint?: string;
}

/** Assets the caller may see (filtered), with their locations; sorted by name. */
export function listAssets(f: AssetFilter = {}): PlantAssetSummary[] {
  requirePlant();
  const sites = db().all<SiteRow>('SELECT * FROM plant_sites');
  const rights = siteRights(sites);
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const indexes = loadAllIndexes();
  let rows = db()
    .all<AssetRow>('SELECT * FROM plant_assets ORDER BY name, id')
    .filter((a) => rights.get(a.site_id)?.includes('view'));
  if (f.site) rows = rows.filter((a) => a.site_id === f.site);
  if (f.node) rows = rows.filter((a) => a.area_id === f.node || a.work_center_id === f.node || a.work_unit_id === f.node);
  if (f.status) rows = rows.filter((a) => a.status === f.status);
  if (f.domain) {
    const d = f.domain.toLowerCase();
    rows = rows.filter(
      (a) =>
        a.domain.toLowerCase() === d ||
        (indexes
          .get(a.site_id)
          ?.nodes.get(a.area_id ?? '')
          ?.domain.toLowerCase() ?? '') === d,
    );
  }
  if (f.tag) {
    const t = f.tag.toLowerCase();
    rows = rows.filter((a) => parseJson<string[]>(a.tags, []).some((x) => x.toLowerCase() === t));
  }
  if (f.profile) {
    // the profile and the profiles that extend it (0.11.0), each asset with its own resolved profile
    const wanted = f.profile;
    const profiles = allProfiles();
    const assigned = new Map(
      db()
        .all<AssignmentRow>('SELECT * FROM plant_assignments WHERE profile_id IS NOT NULL')
        .map((r) => [r.asset_id, assignmentValuesOf(r)]),
    );
    rows = rows.filter((a) => {
      const x = assigned.get(a.id);
      const profile = x?.profileId ? profiles.get(x.profileId) : undefined;
      if (!x || !profile || !profile.chain.includes(wanted)) return false;
      return !f.dataPoint || !!deliveries(x, profile).get(f.dataPoint)?.delivers;
    });
  }
  const refs = refsOf(
    'asset',
    rows.map((a) => a.id),
  );
  if (f.ref) {
    const i = f.ref.indexOf(':');
    const [system, id] = i > 0 ? [f.ref.slice(0, i).toLowerCase(), f.ref.slice(i + 1)] : [null, f.ref];
    rows = rows.filter((a) => (refs.get(a.id) ?? []).some((r) => r.id === id && (!system || r.system.toLowerCase() === system)));
  }
  if (f.q?.trim()) {
    const q = f.q.trim().toLowerCase();
    rows = rows.filter((a) =>
      [a.id, a.name, a.manufacturer, a.model, a.domain, a.role, ...parseJson<string[]>(a.tags, []), ...(refs.get(a.id) ?? []).map((r) => r.id)].some((x) =>
        x.toLowerCase().includes(q),
      ),
    );
  }
  const children = new Map<string, number>();
  for (const r of db().all<{ parent_id: string; n: number }>(
    'SELECT parent_id, COUNT(*) AS n FROM plant_assets WHERE parent_id IS NOT NULL GROUP BY parent_id',
  ))
    children.set(r.parent_id, Number(r.n));
  const images = new Set(
    db()
      .all<{ asset_id: string }>('SELECT asset_id FROM plant_asset_images')
      .map((r) => r.asset_id),
  );
  return rows.map((a) => summary(a, siteById.get(a.site_id)!, indexes.get(a.site_id), children.get(a.id) ?? 0, images.has(a.id)));
}

function summary(a: AssetRow, site: SiteRow, index: SiteIndex | undefined, childCount: number, hasImage: boolean): PlantAssetSummary {
  return {
    id: a.id,
    name: a.name,
    manufacturer: a.manufacturer,
    model: a.model,
    status: a.status,
    siteId: a.site_id,
    location: locationOf(site, index ?? { siteId: site.id, nodes: new Map(), buildings: new Map() }, a),
    domain: a.domain,
    processArea: a.process_area,
    role: a.role,
    tags: parseJson<string[]>(a.tags, []),
    parentId: a.parent_id,
    childCount,
    hasImage,
    importId: a.import_id,
    notInSource: !!a.not_in_source,
    revision: Number(a.revision ?? 1),
    updatedAt: a.updated_at,
  };
}

/** The asset, if the caller may see its site (404 otherwise). */
export function visibleAsset(id: string): { row: AssetRow; site: SiteRow; perms: PlantPermission[] } {
  requirePlant();
  const row = assetRowOf(id);
  const site = row ? siteRowOf(row.site_id) : undefined;
  const perms = site ? sitePermissions(site) : [];
  if (!row || !site || !perms.includes('view')) throw notFound('asset', id);
  return { row, site, perms };
}

const assetRef = (r: Pick<AssetRow, 'id' | 'name' | 'status' | 'site_id'>, rights: Map<string, PlantPermission[]>) => {
  const visible = !!rights.get(r.site_id)?.includes('view');
  return { id: visible ? r.id : '', name: visible ? r.name : '', status: r.status, visible };
};

export function getAsset(id: string): PlantAssetDetail {
  const { row, site, perms } = visibleAsset(id);
  const index = loadIndex(row.site_id);
  const children = db().all<AssetRow>('SELECT id, name, status, site_id FROM plant_assets WHERE parent_id = ? ORDER BY name', id);
  const parent = row.parent_id ? assetRowOf(row.parent_id) : undefined;
  const rights = siteRights(db().all<SiteRow>('SELECT id, acl FROM plant_sites'));
  const img = db().get<{ mime: string; size: number; width: number; height: number; sha256: string; updated_at: string }>(
    'SELECT mime, size, width, height, sha256, updated_at FROM plant_asset_images WHERE asset_id = ?',
    id,
  );
  const v = assetValuesOf(row, refsOfOne('asset', id));
  return {
    ...summary(row, site, index, children.length, !!img),
    description: v.description,
    capabilities: v.capabilities,
    commissioned: v.commissioned,
    endOfSupport: v.endOfSupport,
    imageName: v.imageName,
    image: img
      ? { mime: img.mime, size: Number(img.size), width: Number(img.width), height: Number(img.height), sha256: img.sha256, updatedAt: img.updated_at }
      : null,
    refs: v.refs,
    fields: v.fields,
    parent: parent ? assetRef(parent, rights) : null,
    children: children.map((c) => assetRef(c, rights)),
    canManage: perms.includes('manage'),
    // 0.13.0: may keep drafts of changes to it; its site's switch "Changes need a second person"
    canPropose: perms.includes('propose'),
    siteReview: Number((site as SiteRow & { review?: number }).review ?? 0) === 1,
    links: listLinks('asset', id),
    backlinks: listBacklinks('asset', id),
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

/** The values of an asset, checked: its location in its site, its parent (same site, no cycle), own fields. */
function assetValues(id: string, b: z.infer<typeof assetUpdate>): AssetValues {
  const site = siteRowOf(b.siteId);
  if (!site || !sitePermissions(site).includes('view')) throw notFound('site', b.siteId);
  requireManage(sitePermissions(site), 'add or change assets of this site');
  const r = resolveLocation(loadIndex(b.siteId), b);
  if ('problem' in r) throw ruleError(r);
  if (b.parentId) {
    if (b.parentId === id) throw new HttpError(400, 'An asset cannot be its own parent', 'PLANT_EQUIPMENT_CYCLE', { path: id });
    const p = assetRowOf(b.parentId);
    if (!p || !sitePermissions(siteRowOf(p.site_id)!).includes('view')) throw notFound('asset', b.parentId);
    if (p.site_id !== b.siteId) throw new HttpError(400, `The parent "${p.name}" is in another site`, 'PLANT_PARENT_OTHER_SITE', { id: p.id });
    const cycle = equipmentCycle(id, b.parentId, (x) => (x === id ? b.parentId : (assetRowOf(x)?.parent_id ?? null)));
    if (cycle) throw new HttpError(400, `This makes a cycle: ${cycle.join(' → ')}`, 'PLANT_EQUIPMENT_CYCLE', { path: cycle.join(' → ') });
  }
  return {
    id,
    siteId: b.siteId,
    ...r.value,
    name: b.name,
    manufacturer: b.manufacturer,
    model: b.model,
    status: b.status,
    parentId: b.parentId,
    domain: b.domain,
    processArea: b.processArea,
    role: b.role,
    tags: cleanTags(b.tags),
    commissioned: b.commissioned,
    endOfSupport: b.endOfSupport,
    description: b.description,
    capabilities: b.capabilities,
    imageName: b.imageName,
    refs: cleanRefs(b.refs),
    fields: cleanFields('asset', b.fields),
  };
}

export function createAsset(input: z.infer<typeof assetInput>): PlantAssetDetail {
  requirePlant();
  const u = me();
  if (assetRowOf(input.id)) throw new HttpError(409, `An asset with the id ${input.id} exists already`, 'PLANT_ID_TAKEN', { id: input.id });
  // an old id of a renamed entry still leads there (0.11.0): it is not free
  refuseAliasId('asset', '', input.id);
  if (Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM plant_assets')!.n) >= PLANT_LIMITS.assets)
    throw new HttpError(409, `At most ${PLANT_LIMITS.assets} assets`, 'PLANT_LIMIT', { max: PLANT_LIMITS.assets });
  const v = assetValues(input.id, input);
  db().tx(() => {
    upsertAsset(v, { at: nowIso(), by: u.username });
    audit({
      action: 'asset.created',
      entityType: 'asset',
      entityId: v.id,
      summary: `Asset "${v.name}" (${v.id}) added to site ${v.siteId}`,
      details: { siteId: v.siteId, status: v.status },
    });
  });
  return getAsset(v.id);
}

export function updateAsset(id: string, input: z.infer<typeof assetUpdate>): PlantAssetDetail {
  const cur = visibleAsset(id);
  requireManage(cur.perms, 'change this asset');
  const before = assetValuesOf(cur.row, refsOfOne('asset', id));
  const v = assetValues(id, input);
  const changes = changedKeys(before, v);
  if (!changes.length) return getAsset(id);
  // moving an asset to another site takes its children along only by hand: they keep theirs and lose the parent
  db().tx(() => {
    upsertAsset(v, { at: nowIso(), by: me().username }, { keepSource: true });
    if (v.siteId !== before.siteId) db().run('UPDATE plant_assets SET parent_id = NULL WHERE parent_id = ? AND site_id <> ?', id, v.siteId);
    audit({
      action: 'asset.updated',
      entityType: 'asset',
      entityId: id,
      summary: `Asset "${v.name}" changed (${changes.join(', ')})`,
      details: { changes, old: pick(before, changes), new: pick(v, changes) },
    });
  });
  return getAsset(id);
}

export function deleteAsset(id: string): void {
  const cur = visibleAsset(id);
  requireManage(cur.perms, 'delete this asset');
  const children = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM plant_assets WHERE parent_id = ?', id)!.n);
  db().tx(() => {
    removeAssetRow(id);
    audit({
      action: 'asset.deleted',
      entityType: 'asset',
      entityId: id,
      summary: `Asset "${cur.row.name}" (${id}) deleted${children ? ` – its ${children} child assets have no parent now` : ''}`,
      details: { siteId: cur.row.site_id, children },
    });
  });
}

// ---------- images ----------

export function setAssetImage(id: string, data: Buffer): PlantAssetDetail {
  const cur = visibleAsset(id);
  requireManage(cur.perms, 'change this asset');
  if (!data.length) throw new HttpError(400, 'The file is empty', 'PLANT_IMAGE_EMPTY');
  if (data.length > PLANT_LIMITS.imageBytes)
    throw new HttpError(400, `The image is too large (max. ${PLANT_LIMITS.imageBytes / 1024} KB)`, 'PLANT_IMAGE_TOO_LARGE', {
      kb: PLANT_LIMITS.imageBytes / 1024,
    });
  const info = imageInfo(data);
  if (!info) {
    if (looksLikeSvg(data))
      throw new HttpError(400, 'SVG images are not accepted (they can contain scripts). Use a PNG, JPEG or WebP image.', 'PLANT_IMAGE_SVG');
    throw new HttpError(400, 'The image must be a PNG, JPEG or WebP file', 'PLANT_IMAGE_TYPE');
  }
  if (!info.width || !info.height || info.width > PLANT_LIMITS.imagePixels || info.height > PLANT_LIMITS.imagePixels)
    throw new HttpError(400, `The image must be between 1 and ${PLANT_LIMITS.imagePixels} pixels wide and high`, 'PLANT_IMAGE_DIMENSIONS', {
      max: PLANT_LIMITS.imagePixels,
    });
  const hash = sha256(data);
  const at = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO plant_asset_images (asset_id, mime, size, width, height, sha256, data, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (asset_id) DO UPDATE SET mime = excluded.mime, size = excluded.size, width = excluded.width, height = excluded.height,
         sha256 = excluded.sha256, data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      id,
      info.mime,
      data.length,
      info.width,
      info.height,
      hash,
      data.toString('base64'),
      at,
      me().username,
    );
    audit({
      action: 'asset.image_set',
      entityType: 'asset',
      entityId: id,
      summary: `Image of asset "${cur.row.name}" uploaded (${info.mime}, ${info.width}×${info.height}, ${data.length} bytes)`,
      details: { sha256: hash, size: data.length, mime: info.mime },
    });
  });
  return getAsset(id);
}

export function removeAssetImage(id: string): PlantAssetDetail {
  const cur = visibleAsset(id);
  requireManage(cur.perms, 'change this asset');
  const img = db().get<{ sha256: string }>('SELECT sha256 FROM plant_asset_images WHERE asset_id = ?', id);
  if (img)
    db().tx(() => {
      db().run('DELETE FROM plant_asset_images WHERE asset_id = ?', id);
      audit({
        action: 'asset.image_removed',
        entityType: 'asset',
        entityId: id,
        summary: `Image of asset "${cur.row.name}" removed`,
        details: { sha256: img.sha256 },
      });
    });
  return getAsset(id);
}

/** The stored image, checked again (type and size from the content; the stored type is never trusted). */
export function assetImage(id: string): { mime: string; data: Buffer; sha256: string } | null {
  visibleAsset(id);
  const r = db().get<{ data: string }>('SELECT data FROM plant_asset_images WHERE asset_id = ?', id);
  if (!r) return null;
  const data = Buffer.from(r.data, 'base64');
  const info = data.length <= PLANT_LIMITS.imageBytes ? imageInfo(data) : null;
  return info ? { mime: info.mime, data, sha256: sha256(data) } : null;
}

// ---------- links (records/links.ts: the source's rights are checked here) ----------

export function linkSourceLabel(kind: 'site' | 'asset', id: string, manage = true): string {
  if (kind === 'site') {
    const s = visibleSite(id);
    if (manage) requireManage(s.perms, 'change this site');
    return `site "${s.row.name}"`;
  }
  const a = visibleAsset(id);
  if (manage) requireManage(a.perms, 'change this asset');
  return `asset "${a.row.name}"`;
}

export { siteInput, siteUpdate, nodeInput, nodeUpdate, buildingInput, buildingUpdate, assetInput, assetUpdate };
