import type { PlantMapClient } from './plantMap.js';
import type { AclEntry, AccessReason } from './api.js';
import type { Backlink, ItemLink } from './records.js';
import type { PlantCheck } from './plantData.js';
import type { PlantAliasUse, PlantPlannedRename, PlantRemovalPlan } from './plantIds.js';
import type { PlantChangeSetConfig, PlantStewardFlags } from './plantChanges.js';

/**
 * Plant registry (#217, #218): an opt-in module, off by default (Settings → Modules). The sites of the enterprise
 * (the installation), their role-based equipment hierarchy after ISA-95 / IEC 62264 (area → work center → work unit),
 * a second, spatial axis of buildings (IEC 81346: function and location stay apart; the innermost building wins), and
 * the assets in them. See docs/PLANT.md and docs/adr/0007-plant-registry.md.
 *
 * Ids are stable: chosen by people or by the import file, never changed afterwards (links and imports rely on them).
 */

/** The record types of the module (own fields and display names are per type). */
export const PLANT_RECORD_TYPES = ['site', 'area', 'workCenter', 'workUnit', 'building', 'asset'] as const;
export type PlantRecordType = (typeof PLANT_RECORD_TYPES)[number];

/** The ISA-95 levels below a site. */
export const PLANT_LEVELS = ['area', 'work_center', 'work_unit'] as const;
export type PlantLevel = (typeof PLANT_LEVELS)[number];
export const LEVEL_RECORD_TYPE: Record<PlantLevel, PlantRecordType> = { area: 'area', work_center: 'workCenter', work_unit: 'workUnit' };

/** ISA-95 (IEC 62264-1) kinds of work centers and work units; optional. */
export const WORK_CENTER_TYPES = ['production_line', 'production_unit', 'process_cell', 'storage_zone'] as const;
export const WORK_UNIT_TYPES = ['unit', 'work_cell', 'storage_unit'] as const;
export type WorkCenterType = (typeof WORK_CENTER_TYPES)[number];
export type WorkUnitType = (typeof WORK_UNIT_TYPES)[number];

/** Kinds of a place on the spatial axis. */
export const BUILDING_KINDS = ['building', 'hall', 'floor', 'room', 'outdoor', 'other'] as const;
export type BuildingKind = (typeof BUILDING_KINDS)[number];

/** Where an asset stands in its life. */
export const ASSET_STATUSES = ['planned', 'commissioning', 'operational', 'maintenance', 'out_of_service', 'decommissioned'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

/** Rights on a site (and everything in it): see it, propose changes to it (0.13.0: drafts and change sets, never apply), change it. */
export const PLANT_PERMISSIONS = ['view', 'propose', 'manage'] as const;
export type PlantPermission = (typeof PLANT_PERMISSIONS)[number];

/** Stable ids: lower case letters, digits and . _ - (the import file's ids, so they read well in YAML and URLs). */
export const PLANT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
/** Keys of own fields (snake_case, as in the import file). */
export const PLANT_FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
/** Language codes of translated names (en, de, pt-BR …). */
export const PLANT_LANG_RE = /^[a-z]{2}(-[A-Z]{2})?$/;

export const PLANT_LIMITS = {
  id: 80,
  code: 20,
  name: 200,
  description: 4000,
  translations: 10,
  contacts: 20,
  refs: 30,
  tags: 50,
  tag: 60,
  capabilities: 50,
  capability: 200,
  text: 200,
  fieldDefs: 40,
  fieldOptions: 50,
  fieldText: 2000,
  sites: 500,
  nodesPerSite: 5000,
  buildingsPerSite: 1000,
  assets: 50_000,
  imageBytes: 512 * 1024,
  imagePixels: 4096,
  /** Import: files, bytes of all files together, nesting depth of a document */
  importFiles: 500,
  importBytes: 8 * 1024 * 1024,
  importDepth: 12,
} as const;

/** Version of the import and export format (docs/plant/plant-registry-1.schema.json). */
export const PLANT_FORMAT_VERSION = 1;

export type Translations = Record<string, string>;

export interface ExternalRef {
  /** The other tool, e.g. erp, cmms, inventory (free text, lower case recommended) */
  system: string;
  /** The record's id there */
  id: string;
  /** Its page there (http/https), or empty */
  url: string;
  /** Optional label */
  label: string;
}

export interface SiteContact {
  name: string;
  role: string;
  email: string;
  phone: string;
  url: string;
}

export interface GeoPosition {
  lat: number;
  lon: number;
  /** Map zoom level (OpenStreetMap: 0–19) */
  zoom: number | null;
}

/** Where a record came from: the last import that wrote it, and whether that import's file still contains it. */
export interface PlantSource {
  importId: string | null;
  /** Kept although the import that replaced its earlier one did not contain it any more */
  notInSource: boolean;
  /**
   * 0.13.0: the entry's revision (one more with every change). An edit form sends it back with its save: a save of an
   * older revision is refused with 409 PLANT_ENTRY_CHANGED (docs/PLANT.md "Change sets"); without it a save writes as before.
   */
  revision?: number;
}

export interface PlantStamp {
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export type FieldValues = Record<string, string | number | boolean | null>;

export interface PlantNode extends PlantSource {
  id: string;
  level: PlantLevel;
  /** The area of a work center, the work center of a work unit (null for areas) */
  parentId: string | null;
  name: string;
  names: Translations;
  /** ISA-95 kind (work centers and work units), or empty */
  type: string;
  /** Manufacturing domain (areas; optional) */
  domain: string;
  /** The building the node names (or null: it inherits its parent's) */
  buildingId: string | null;
  /** The innermost building of the node and its parents (null: none) */
  effectiveBuildingId: string | null;
  description: string;
  fields: FieldValues;
  /** Assets placed exactly here */
  assetCount: number;
  children: PlantNode[];
}

export interface PlantBuilding extends PlantSource {
  id: string;
  name: string;
  names: Translations;
  kind: BuildingKind;
  /** A building part (floor, room) names the building it is in */
  parentId: string | null;
  description: string;
  fields: FieldValues;
  /** Nodes that name this building */
  nodeCount: number;
  /** Assets whose effective building this is */
  assetCount: number;
}

export interface PlantSiteSummary extends PlantSource {
  id: string;
  code: string;
  name: string;
  names: Translations;
  description: string;
  geo: GeoPosition | null;
  areaCount: number;
  buildingCount: number;
  assetCount: number;
  /** Assets by status */
  statusCounts: Partial<Record<AssetStatus, number>>;
  canManage: boolean;
  /** 0.13.0: may keep drafts of changes to it (propose) */
  canPropose?: boolean;
  /** 0.13.0: "Changes need a second person" (the site's switch, used while plant.changeSet is optional) */
  review?: boolean;
  /** 0.14: how often the site's documentation should be confirmed as still current (months; null: no interval) */
  docReviewMonths?: number | null;
  updatedAt: string;
}

export interface PlantSiteDetail extends PlantSiteSummary, PlantStamp {
  contacts: SiteContact[];
  refs: ExternalRef[];
  fields: FieldValues;
  /** The areas with their work centers and work units */
  areas: PlantNode[];
  buildings: PlantBuilding[];
  /** Only for who may manage the site */
  acl: AclEntry<PlantPermission>[] | null;
  permissions: PlantPermission[];
  links: ItemLink[];
  backlinks: Backlink[];
}

/** A node of the hierarchy as an asset's location shows it. */
export interface PlantPlace {
  id: string;
  name: string;
  names: Translations;
}

export interface AssetLocation {
  site: PlantPlace & { code: string };
  area: PlantPlace | null;
  workCenter: PlantPlace | null;
  workUnit: PlantPlace | null;
  /** The asset's own building (override), or null */
  buildingId: string | null;
  /** The building that applies: the asset's own, else the innermost one of its work unit, work center, area */
  building: (PlantPlace & { kind: BuildingKind }) | null;
  /** Where the building comes from */
  buildingFrom: 'asset' | 'work_unit' | 'work_center' | 'area' | null;
}

export interface AssetRef {
  id: string;
  name: string;
  status: AssetStatus;
  /** False: the asset is in a site the reader may not see (then name is empty) */
  visible: boolean;
}

export interface PlantAssetSummary extends PlantSource {
  id: string;
  name: string;
  manufacturer: string;
  model: string;
  status: AssetStatus;
  siteId: string;
  location: AssetLocation;
  domain: string;
  processArea: string;
  role: string;
  tags: string[];
  parentId: string | null;
  childCount: number;
  hasImage: boolean;
  updatedAt: string;
}

export interface PlantAssetDetail extends PlantAssetSummary, PlantStamp {
  description: string;
  capabilities: string[];
  commissioned: string | null;
  endOfSupport: string | null;
  /** The name of the image file in the source (import), kept for the export */
  imageName: string;
  image: { mime: string; size: number; width: number; height: number; sha256: string; updatedAt: string } | null;
  refs: ExternalRef[];
  fields: FieldValues;
  parent: AssetRef | null;
  children: AssetRef[];
  canManage: boolean;
  /** 0.13.0: may keep drafts of changes to it (propose) */
  canPropose?: boolean;
  /** 0.13.0: its site's switch "Changes need a second person" */
  siteReview?: boolean;
  links: ItemLink[];
  backlinks: Backlink[];
}

// ---------- settings ----------

export const PLANT_FIELD_KINDS = ['text', 'number', 'date', 'boolean', 'select', 'url'] as const;
export type PlantFieldKind = (typeof PLANT_FIELD_KINDS)[number];

export interface PlantFieldDef {
  key: string;
  label: string;
  /** Translated labels */
  labels: Translations;
  kind: PlantFieldKind;
  required: boolean;
  options: string[];
  help: string;
}

/** A display name of a record type in one language (singular and plural). */
export interface PlantLabel {
  one: string;
  other: string;
}

export interface PlantSettings {
  enabled: boolean;
  /** The enterprise this installation documents (the root of the export) */
  enterprise: string;
  /** Own names of the record types per language: { asset: { en: { one: 'Machine', other: 'Machines' } } } */
  labels: Partial<Record<PlantRecordType, Record<string, PlantLabel>>>;
  /** Own fields per record type */
  fields: Partial<Record<PlantRecordType, PlantFieldDef[]>>;
  /** 0.14: review intervals of plant documents per document type (record type key → months; "still current" hints) */
  documentReview?: Record<string, number>;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** GET /api/plant/config: what every page of the module needs. */
export interface PlantConfig {
  enterprise: string;
  labels: PlantSettings['labels'];
  fields: PlantSettings['fields'];
  /** The signed-in person may create sites */
  canCreateSites: boolean;
  /** The signed-in person may manage at least one site (import, new asset) */
  canManageSome: boolean;
  /** The signed-in person may add and change device profiles and KPI definitions (#219) */
  canManageCatalogue: boolean;
  /** The map of sites (#234): off until an administrator turns it on */
  map: PlantMapClient;
  /** 0.13.0: change sets – the policy, whether the person may keep drafts, their current draft */
  changeSets?: PlantChangeSetConfig;
}

/** GET /api/plant/hierarchy: the sites with their trees and buildings (pickers and filters). */
export interface PlantHierarchySite {
  id: string;
  code: string;
  name: string;
  names: Translations;
  canManage: boolean;
  areas: PlantNode[];
  buildings: PlantBuilding[];
}

// ---------- import ----------

export const PLANT_IMPORT_MODES = ['add', 'update', 'replace'] as const;
export type PlantImportMode = (typeof PLANT_IMPORT_MODES)[number];
/** Replace: what happens to records of the earlier import that the file does not contain any more */
export const PLANT_MISSING = ['remove', 'mark'] as const;
export type PlantMissing = (typeof PLANT_MISSING)[number];

/**
 * Kinds of records an import writes; device profiles, KPI definitions and assignments since part 2 (#219); the OT
 * network since part 3 (#220): VLANs, zones and conduits of a site, devices, data paths and the checks of an asset.
 */
export type PlantChangeKind =
  | 'site'
  | 'area'
  | 'work_center'
  | 'work_unit'
  | 'building'
  | 'asset'
  | 'profile'
  | 'kpi'
  | 'assignment'
  | 'vlan'
  | 'zone'
  | 'conduit'
  | 'device'
  | 'data_path'
  | 'asset_checks'
  /** 0.12: the sinks of an asset's data collection */
  | 'collection_sinks'
  /** 0.12: a data collection of an asset (in the file format since 0.12) */
  | 'collection';
export type PlantChangeAction = 'add' | 'change' | 'remove' | 'mark' | 'unchanged' | 'skip';

/** 0.12.0: changes to the plant registry proposed by an AI assistant (docs/PLANT.md "Proposals from assistants"). */
export const PLANT_PROPOSAL_LIMITS = {
  /** The proposed document (JSON), as sent (an MCP request is at most 64 KB) */
  documentBytes: 48 * 1024,
  title: 120,
  /**
   * 0.17.0: a larger proposal comes in parts of up to `documentBytes` each, combined into one document: at most this
   * many parts and this size together – about the 5,000 data points a profile's list may hold, with their sources
   */
  parts: 25,
  totalBytes: 1024 * 1024,
  /** 0.17.0: an unfinished proposal (more parts announced) expires this long after its last part */
  partExpiryHours: 24,
  /** 0.17.0: the combined document of the parts so far is previewed with each part up to this size (problems so far) */
  partPreviewBytes: 256 * 1024,
  /** 0.17.0: data points with a source the review lists (the first ones) */
  sourcePoints: 1000,
} as const;

/** 0.12.0: the size of the field-level differences an import's preview shows. */
export const PLANT_DIFF_LIMITS = {
  /** Differences per changed entry */
  perEntry: 50,
  /** Changed entries that get their differences (the first ones) */
  entries: 500,
  /** Characters of a text value, entries of a list value */
  text: 500,
  list: 20,
} as const;

/** 0.12.0: one difference of a changed entry: where (`interfaces[opc].description`), the stored and the new value. */
export interface PlantFieldDiff {
  path: string;
  before: unknown;
  after: unknown;
}

export interface PlantChange {
  kind: PlantChangeKind;
  action: PlantChangeAction;
  /** The site of the record (sites: their own id; profiles and KPI definitions: empty, they belong to no site) */
  siteId: string;
  id: string;
  name: string;
  /** Fields that differ (changes) */
  fields?: string[];
  /** 0.12.0: what differs, field by field (changes; the first PLANT_DIFF_LIMITS.entries changes of a preview) */
  diff?: PlantFieldDiff[];
  /**
   * 0.12.0: items the change drops from a list inside the entry (`interfaces[opc]`, `aliases: SpindleSpeed`) – an
   * assistant's proposal may not drop any
   */
  drops?: string[];
  /** A note: why it is skipped, what else changes */
  note?: string;
}

export interface PlantImportProblem {
  /** The file, and where in it (sites[0].areas[2].id) */
  file: string;
  path: string;
  message: string;
}

export type PlantCounts = Record<'add' | 'change' | 'remove' | 'mark' | 'unchanged' | 'skip', number>;

export interface PlantImportPreview {
  ok: boolean;
  mode: PlantImportMode;
  missing: PlantMissing;
  /** Replace: the earlier import */
  replaces: { id: string; createdAt: string; createdBy: string; files: string[] } | null;
  files: { name: string; sha256: string; bytes: number }[];
  /** SHA-256 of all files together (in the order given) */
  sha256: string;
  problems: PlantImportProblem[];
  warnings: PlantImportProblem[];
  changes: PlantChange[];
  counts: PlantCounts;
  /** Counts per kind */
  byKind: Partial<Record<PlantChangeKind, PlantCounts>>;
  /** What Steward checks in the records of the files once imported (they do not stop the import, #219) */
  checks: PlantCheck[];
  /** 0.11.0: entries the id mapping renames before the files update them */
  renames: PlantPlannedRename[];
  /** 0.11.0: old ids in the files, read as the entries they lead to */
  aliasUses: PlantAliasUse[];
  /** 0.11.0: entries the import removes (`remove:` in the files, or "Remove entries that are not in the files") */
  removals: PlantRemovalPlan | null;
  /** 0.11.0: importing asks for a step-up (more than one entry renamed or removed) */
  stepUp: boolean;
  /** 0.13.0: what importing writes – send it with the import: a different result is refused (PLANT_IMPORT_CHANGED) */
  fingerprint?: string;
  /**
   * 0.19.0: fields the import would change that were changed in Steward since the last import – they keep Steward's
   * value unless taken from the file (`changedInSteward` of the body); left out when there are none
   */
  changedInSteward?: PlantStewardFlags;
}

export interface PlantImportSummary {
  id: string;
  createdAt: string;
  createdBy: string;
  mode: PlantImportMode;
  missing: PlantMissing;
  replaces: string | null;
  files: { name: string; sha256: string; bytes: number }[];
  sha256: string;
  counts: PlantCounts;
  sites: string[];
  /** Records this import wrote that are still there */
  records: number;
}

export interface PlantImportResult extends PlantImportPreview {
  import: PlantImportSummary;
}

/** Why someone has a right on a site (for the access panel). */
export interface PlantAccessInfo {
  permissions: PlantPermission[];
  reasons: AccessReason[];
}

/** The name of a plant record in a language: the translation, or the name. */
export function plantName(x: { name: string; names?: Translations | null }, lang?: string | null): string {
  if (!lang || !x.names) return x.name;
  return x.names[lang] ?? x.names[lang.split('-')[0]!] ?? x.name;
}
