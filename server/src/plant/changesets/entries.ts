import type { z } from 'zod';
import { PLANT_ENTRY_KINDS, type PlantEntryKind } from '@sm/shared';
import { db } from '../../db.js';
import * as svc from '../service.js';
import * as cat from '../catalogue.js';
import * as net from '../network.js';
import * as coll from '../collections.js';
import { assignmentInput, deleteAssignment, putAssignment } from '../assignments.js';
import {
  assetInput,
  assetUpdate,
  assetValuesOf,
  buildingInput,
  buildingUpdate,
  buildingValuesOf,
  nodeInput,
  nodeUpdate,
  nodeValuesOf,
  refsOf,
  siteInput,
  siteUpdate,
  siteValuesOf,
  type AssetRow,
  type BuildingRow,
  type NodeRow,
  type SiteRow,
} from '../model.js';
import { assignmentValuesOf, kpiInput, kpiUpdate, kpiValuesOf, profileInput, profileUpdate, profileValuesOf } from '../data-model.js';
import type { AssignmentRow, KpiRow, ProfileRow } from '../data-model.js';
import {
  assetChecksInput,
  assetChecksValuesOf,
  conduitInput,
  conduitUpdate,
  conduitValuesOf,
  dataPathInput,
  dataPathUpdate,
  dataPathValuesOf,
  deviceInput,
  deviceUpdate,
  deviceValuesOf,
  vlanInput,
  vlanUpdate,
  vlanValuesOf,
  zoneInput,
  zoneUpdate,
  zoneValuesOf,
  type AssetChecksRow,
  type ConduitRow,
  type DataPathRow,
  type DeviceRow,
  type VlanRow,
  type ZoneRow,
} from '../network-model.js';
import { collectionInput, collectionUpdate, collectionValuesOf, type CollectionRow } from '../collections-model.js';
import { redactValue } from '../collections-redact.js';

/**
 * The entries of the plant registry as change sets see them (0.13.0, ADR 0020): per kind its table, how its values are
 * read (the camelCase values of the edit forms and the import – what the history keeps and the merge compares), the
 * bodies of its routes and the services that write it. The services keep every rule, right and audit entry of the
 * routes: a change set's operation is applied exactly as the edit form's request would be.
 */

type Row = Record<string, unknown>;

export interface EntrySnap {
  kind: PlantEntryKind;
  scope: string;
  id: string;
  revision: number;
  name: string;
  /** The site the entry belongs to ('' for device profiles and KPI definitions) */
  siteId: string;
  values: Record<string, unknown>;
}

export interface KindDef {
  kind: PlantEntryKind;
  table: string;
  /** The column of the scope (site or asset id); null: unique in the installation */
  scopeCol: string | null;
  idCol: string;
  /** Values of rows (what the history keeps) */
  read(rows: Row[]): EntrySnap[];
  /** The bodies of PUT (update) and POST (add) */
  update: z.ZodTypeAny;
  create: z.ZodTypeAny | null;
  /** The services of the routes (rights, rules, audit) */
  set(scope: string, id: string, body: unknown): unknown;
  add(scope: string, body: unknown, id: string): unknown;
  remove(scope: string, id: string, value: { cascade?: boolean }): unknown;
}

const n = (v: unknown) => Number(v ?? 1);
const str = (v: unknown) => String(v ?? '');

/** The sites of assets (asset-scoped entries belong to their asset's site). */
export function assetSites(ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    if (!chunk.length) continue;
    for (const r of db().all<{ id: string; site_id: string }>(
      `SELECT id, site_id FROM plant_assets WHERE id IN (${chunk.map(() => '?').join(', ')})`,
      ...chunk,
    ))
      out.set(r.id, r.site_id);
  }
  return out;
}

const byAsset = (rows: Row[], fn: (r: Row, site: string) => EntrySnap): EntrySnap[] => {
  const sites = assetSites([...new Set(rows.map((r) => str(r.asset_id)))]);
  return rows.map((r) => fn(r, sites.get(str(r.asset_id)) ?? ''));
};

export const KINDS: Record<PlantEntryKind, KindDef> = {
  site: {
    kind: 'site',
    table: 'plant_sites',
    scopeCol: null,
    idCol: 'id',
    read: (rows) => {
      const refs = refsOf(
        'site',
        rows.map((r) => str(r.id)),
      );
      return rows.map((r) => ({
        kind: 'site',
        scope: '',
        id: str(r.id),
        revision: n(r.revision),
        name: str(r.name),
        siteId: str(r.id),
        values: { ...siteValuesOf(r as unknown as SiteRow, refs.get(str(r.id)) ?? []) },
      }));
    },
    update: siteUpdate,
    create: siteInput,
    set: (_s, id, b) => svc.updateSite(id, b as z.infer<typeof siteUpdate>),
    add: (_s, b) => svc.createSite(b as z.infer<typeof siteInput>),
    remove: (_s, id) => svc.deleteSite(id),
  },
  node: {
    kind: 'node',
    table: 'plant_nodes',
    scopeCol: 'site_id',
    idCol: 'id',
    read: (rows) =>
      rows.map((r) => ({
        kind: 'node',
        scope: str(r.site_id),
        id: str(r.id),
        revision: n(r.revision),
        name: str(r.name),
        siteId: str(r.site_id),
        values: { ...nodeValuesOf(r as unknown as NodeRow) },
      })),
    update: nodeUpdate,
    create: nodeInput,
    set: (s, id, b) => svc.updateNode(s, id, b as z.infer<typeof nodeUpdate>),
    add: (s, b) => svc.createNode(s, b as z.infer<typeof nodeInput>),
    remove: (s, id) => svc.deleteNode(s, id),
  },
  building: {
    kind: 'building',
    table: 'plant_buildings',
    scopeCol: 'site_id',
    idCol: 'id',
    read: (rows) =>
      rows.map((r) => ({
        kind: 'building',
        scope: str(r.site_id),
        id: str(r.id),
        revision: n(r.revision),
        name: str(r.name),
        siteId: str(r.site_id),
        values: { ...buildingValuesOf(r as unknown as BuildingRow) },
      })),
    update: buildingUpdate,
    create: buildingInput,
    set: (s, id, b) => svc.updateBuilding(s, id, b as z.infer<typeof buildingUpdate>),
    add: (s, b) => svc.createBuilding(s, b as z.infer<typeof buildingInput>),
    remove: (s, id) => svc.deleteBuilding(s, id),
  },
  asset: {
    kind: 'asset',
    table: 'plant_assets',
    scopeCol: null,
    idCol: 'id',
    read: (rows) => {
      const refs = refsOf(
        'asset',
        rows.map((r) => str(r.id)),
      );
      return rows.map((r) => ({
        kind: 'asset',
        scope: '',
        id: str(r.id),
        revision: n(r.revision),
        name: str(r.name),
        siteId: str(r.site_id),
        values: { ...assetValuesOf(r as unknown as AssetRow, refs.get(str(r.id)) ?? []) },
      }));
    },
    update: assetUpdate,
    create: assetInput,
    set: (_s, id, b) => svc.updateAsset(id, b as z.infer<typeof assetUpdate>),
    add: (_s, b) => svc.createAsset(b as z.infer<typeof assetInput>),
    remove: (_s, id) => svc.deleteAsset(id),
  },
  assignment: {
    kind: 'assignment',
    table: 'plant_assignments',
    scopeCol: null,
    idCol: 'asset_id',
    read: (rows) =>
      byAsset(rows, (r, site) => ({
        kind: 'assignment',
        scope: '',
        id: str(r.asset_id),
        revision: n(r.revision),
        name: str(r.asset_id),
        siteId: site,
        values: { ...assignmentValuesOf(r as unknown as AssignmentRow) },
      })),
    update: assignmentInput,
    create: assignmentInput,
    set: (_s, id, b) => putAssignment(id, b as z.infer<typeof assignmentInput>),
    add: (_s, b, id) => putAssignment(id, b as z.infer<typeof assignmentInput>),
    remove: (_s, id) => deleteAssignment(id),
  },
  asset_checks: {
    kind: 'asset_checks',
    table: 'plant_asset_checks',
    scopeCol: null,
    idCol: 'asset_id',
    read: (rows) =>
      byAsset(rows, (r, site) => ({
        kind: 'asset_checks',
        scope: '',
        id: str(r.asset_id),
        revision: n(r.revision),
        name: str(r.asset_id),
        siteId: site,
        values: { ...assetChecksValuesOf(r as unknown as AssetChecksRow) },
      })),
    update: assetChecksInput,
    create: assetChecksInput,
    set: (_s, id, b) => net.putAssetChecks(id, b as z.infer<typeof assetChecksInput>),
    add: (_s, b, id) => net.putAssetChecks(id, b as z.infer<typeof assetChecksInput>),
    remove: (_s, id) => net.putAssetChecks(id, { checks: [] }),
  },
  profile: {
    kind: 'profile',
    table: 'plant_profiles',
    scopeCol: null,
    idCol: 'id',
    read: (rows) =>
      rows.map((r) => ({
        kind: 'profile',
        scope: '',
        id: str(r.id),
        revision: n(r.revision),
        name: str(r.name),
        siteId: '',
        values: { ...profileValuesOf(r as unknown as ProfileRow) },
      })),
    update: profileUpdate,
    create: profileInput,
    set: (_s, id, b) => cat.updateProfile(id, b as z.infer<typeof profileUpdate>),
    add: (_s, b) => cat.createProfile(b as z.infer<typeof profileInput>),
    remove: (_s, id) => cat.deleteProfile(id),
  },
  kpi: {
    kind: 'kpi',
    table: 'plant_kpis',
    scopeCol: null,
    idCol: 'id',
    read: (rows) =>
      rows.map((r) => ({
        kind: 'kpi',
        scope: '',
        id: str(r.id),
        revision: n(r.revision),
        name: str(r.name),
        siteId: '',
        values: { ...kpiValuesOf(r as unknown as KpiRow) },
      })),
    update: kpiUpdate,
    create: kpiInput,
    set: (_s, id, b) => cat.updateKpi(id, b as z.infer<typeof kpiUpdate>),
    add: (_s, b) => cat.createKpi(b as z.infer<typeof kpiInput>),
    remove: (_s, id) => cat.deleteKpi(id),
  },
  vlan: {
    kind: 'vlan',
    table: 'plant_vlans',
    scopeCol: 'site_id',
    idCol: 'id',
    read: (rows) =>
      rows.map((r) => ({
        kind: 'vlan',
        scope: str(r.site_id),
        id: str(r.id),
        revision: n(r.revision),
        name: str(r.name),
        siteId: str(r.site_id),
        values: { ...vlanValuesOf(r as unknown as VlanRow) },
      })),
    update: vlanUpdate,
    create: vlanInput,
    set: (s, id, b) => net.updateVlan(s, id, b as z.infer<typeof vlanUpdate>),
    add: (s, b) => net.createVlan(s, b as z.infer<typeof vlanInput>),
    remove: (s, id) => net.deleteVlan(s, id),
  },
  zone: {
    kind: 'zone',
    table: 'plant_zones',
    scopeCol: 'site_id',
    idCol: 'id',
    read: (rows) =>
      rows.map((r) => ({
        kind: 'zone',
        scope: str(r.site_id),
        id: str(r.id),
        revision: n(r.revision),
        name: str(r.name),
        siteId: str(r.site_id),
        values: { ...zoneValuesOf(r as unknown as ZoneRow) },
      })),
    update: zoneUpdate,
    create: zoneInput,
    set: (s, id, b) => net.updateZone(s, id, b as z.infer<typeof zoneUpdate>),
    add: (s, b) => net.createZone(s, b as z.infer<typeof zoneInput>),
    remove: (s, id) => net.deleteZone(s, id),
  },
  conduit: {
    kind: 'conduit',
    table: 'plant_conduits',
    scopeCol: 'site_id',
    idCol: 'id',
    read: (rows) =>
      rows.map((r) => ({
        kind: 'conduit',
        scope: str(r.site_id),
        id: str(r.id),
        revision: n(r.revision),
        name: str(r.name),
        siteId: str(r.site_id),
        values: { ...conduitValuesOf(r as unknown as ConduitRow) },
      })),
    update: conduitUpdate,
    create: conduitInput,
    set: (s, id, b) => net.updateConduit(s, id, b as z.infer<typeof conduitUpdate>),
    add: (s, b) => net.createConduit(s, b as z.infer<typeof conduitInput>),
    remove: (s, id) => net.deleteConduit(s, id),
  },
  device: {
    kind: 'device',
    table: 'plant_devices',
    scopeCol: 'asset_id',
    idCol: 'id',
    read: (rows) =>
      byAsset(rows, (r, site) => ({
        kind: 'device',
        scope: str(r.asset_id),
        id: str(r.id),
        revision: n(r.revision),
        name: str(r.hostname) || str(r.id),
        siteId: site,
        values: { ...deviceValuesOf(r as unknown as DeviceRow) },
      })),
    update: deviceUpdate,
    create: deviceInput,
    set: (s, id, b) => net.updateDevice(s, id, b as z.infer<typeof deviceUpdate>),
    add: (s, b) => net.createDevice(s, b as z.infer<typeof deviceInput>),
    remove: (s, id) => net.deleteDevice(s, id),
  },
  data_path: {
    kind: 'data_path',
    table: 'plant_data_paths',
    scopeCol: 'asset_id',
    idCol: 'id',
    read: (rows) =>
      byAsset(rows, (r, site) => ({
        kind: 'data_path',
        scope: str(r.asset_id),
        id: str(r.id),
        revision: n(r.revision),
        name: str(r.subject) || str(r.id),
        siteId: site,
        values: { ...dataPathValuesOf(r as unknown as DataPathRow) },
      })),
    update: dataPathUpdate,
    create: dataPathInput,
    set: (s, id, b) => net.updateDataPath(s, id, b as z.infer<typeof dataPathUpdate>),
    add: (s, b) => net.createDataPath(s, b as z.infer<typeof dataPathInput>),
    remove: (s, id) => net.deleteDataPath(s, id),
  },
  collection: {
    kind: 'collection',
    table: 'plant_collections',
    scopeCol: 'asset_id',
    idCol: 'id',
    read: (rows) =>
      byAsset(rows, (r, site) => ({
        kind: 'collection',
        scope: str(r.asset_id),
        id: str(r.id),
        revision: n(r.revision),
        name: str(r.name),
        siteId: site,
        // what came from a collector's file never keeps a secret (the redaction of kept configurations, 0.12)
        values: redactValue({ ...collectionValuesOf(r as unknown as CollectionRow) }).value,
      })),
    update: collectionUpdate,
    create: collectionInput,
    set: (s, id, b) => coll.updateCollection(s, id, b as z.infer<typeof collectionUpdate>),
    add: (s, b) => coll.createCollection(s, b as z.infer<typeof collectionInput>),
    remove: (s, id, v) => coll.deleteCollection(s, id, !!v.cascade),
  },
};

export const ASSET_SCOPED: readonly PlantEntryKind[] = ['device', 'data_path', 'collection'];
export const SITE_SCOPED: readonly PlantEntryKind[] = ['node', 'building', 'vlan', 'zone', 'conduit'];
/** Entries keyed by their asset's id (one per asset). */
export const PER_ASSET: readonly PlantEntryKind[] = ['assignment', 'asset_checks'];
export const CATALOGUE_KINDS: readonly PlantEntryKind[] = ['profile', 'kpi'];

export const entryKey = (k: { kind: string; scope: string; id: string }) => `${k.kind}\u0000${k.scope}\u0000${k.id}`;

/** One entry now (null: there is none). */
export function readEntry(kind: PlantEntryKind, scope: string, id: string): EntrySnap | null {
  const d = KINDS[kind];
  const row = d.scopeCol
    ? db().get<Row>(`SELECT * FROM ${d.table} WHERE ${d.scopeCol} = ? AND ${d.idCol} = ?`, scope, id)
    : db().get<Row>(`SELECT * FROM ${d.table} WHERE ${d.idCol} = ?`, id);
  return row ? (d.read([row])[0] ?? null) : null;
}

/** The entry's revision now (null: there is none). */
export function revisionOf(kind: PlantEntryKind, scope: string, id: string): number | null {
  const d = KINDS[kind];
  const r = d.scopeCol
    ? db().get<{ revision: number }>(`SELECT revision FROM ${d.table} WHERE ${d.scopeCol} = ? AND ${d.idCol} = ?`, scope, id)
    : db().get<{ revision: number }>(`SELECT revision FROM ${d.table} WHERE ${d.idCol} = ?`, id);
  return r ? Number(r.revision) : null;
}

/** The body of the entry's PUT route with its values now (the base and "theirs" of the three-way merge). */
export function bodyOf(kind: PlantEntryKind, values: Record<string, unknown>): Record<string, unknown> {
  const shape = (KINDS[kind].update as unknown as { shape?: Record<string, unknown> }).shape ?? {};
  return Object.fromEntries(Object.keys(shape).map((k) => [k, values[k] ?? null]));
}

export const isEntryKind = (k: string): k is PlantEntryKind => (PLANT_ENTRY_KINDS as readonly string[]).includes(k);

/** The page of an entry (null: none of its own). */
export function entryPagePath(kind: PlantEntryKind, scope: string, id: string): string | null {
  const e = encodeURIComponent;
  switch (kind) {
    case 'site':
      return `/plant/sites/${e(id)}`;
    case 'asset':
    case 'assignment':
    case 'asset_checks':
      return `/plant/assets/${e(id)}`;
    case 'profile':
      return `/plant/profiles/${e(id)}`;
    case 'kpi':
      return `/plant/kpis/${e(id)}`;
    case 'node':
    case 'building':
      return `/plant/sites/${e(scope)}`;
    case 'vlan':
    case 'zone':
    case 'conduit':
      return `/plant/sites/${e(scope)}/network`;
    case 'device':
    case 'data_path':
      return `/plant/assets/${e(scope)}`;
    case 'collection':
      return `/plant/assets/${e(scope)}/collections/${e(id)}`;
  }
}
