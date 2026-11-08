import { z } from 'zod';
import { ASSET_STATUSES, PLANT_ID_RE } from './plant.js';
import { PLANT_NAME_RE } from './plantData.js';
import { DEVICE_CONFIDENCE, DEVICE_STATES } from './plantNetwork.js';

/**
 * Changing the ids of plant registry entries (0.11.0, docs/PLANT.md#changing-ids): one rename core for every kind of
 * entry with an id, aliases that keep old ids working, an id mapping for the import, and changing or removing many
 * entries at once (docs/PLANT.md#changing-many-entries-at-once).
 */

/**
 * Kinds of entries with an id people see and other entries name. Nodes are the ISA-95 areas, work centers and work
 * units of a site (one id space per site). Interfaces and data points live in their device profile.
 */
export const PLANT_ID_KINDS = [
  'site',
  'building',
  'node',
  'asset',
  'profile',
  'interface',
  'data_point',
  'kpi',
  'vlan',
  'zone',
  'conduit',
  'device',
  'data_path',
] as const;
export type PlantIdKind = (typeof PLANT_ID_KINDS)[number];

/** What an id is unique in: the installation, its site, its asset or its device profile. */
export type PlantIdScope = 'none' | 'site' | 'asset' | 'profile';
export const PLANT_ID_SCOPE: Record<PlantIdKind, PlantIdScope> = {
  site: 'none',
  building: 'site',
  node: 'site',
  asset: 'none',
  profile: 'none',
  interface: 'profile',
  data_point: 'profile',
  kpi: 'none',
  vlan: 'site',
  zone: 'site',
  conduit: 'site',
  device: 'asset',
  data_path: 'asset',
};

/** The id rules of a kind: plant ids (lower case), or names of interfaces and data points (devices name them). */
export const plantIdPattern = (kind: PlantIdKind): RegExp => (kind === 'interface' || kind === 'data_point' ? PLANT_NAME_RE : PLANT_ID_RE);

/** Kinds an entry can be removed of (interfaces and data points are removed by editing their profile). */
export const PLANT_REMOVABLE_KINDS = ['site', 'building', 'node', 'asset', 'profile', 'kpi', 'vlan', 'zone', 'conduit', 'device', 'data_path'] as const;
export type PlantRemovableKind = (typeof PLANT_REMOVABLE_KINDS)[number];

/**
 * Bulk changes (more than one entry renamed or removed, or more than PLANT_BULK.editStepUp entries edited) ask for a
 * step-up (control point plant.bulkChange); a single rename asks only when the policy says so (plant.renameId).
 */
export const PLANT_BULK = { maxItems: 500, editStepUp: 25, maxMapEntries: 5000, maxRules: 20 } as const;

/** An entry: its kind, the scope it is unique in (site, asset or profile id; empty for the others) and its id. */
export interface PlantEntryRef {
  kind: PlantIdKind;
  scope: string;
  id: string;
}

export const plantEntryRefInput = z
  .object({
    kind: z.enum(PLANT_ID_KINDS),
    scope: z.string().trim().max(120).default(''),
    id: z.string().trim().min(1).max(120),
  })
  .strict();

/** POST /api/plant/ids/rename[/preview] */
export const plantRenameInput = plantEntryRefInput.extend({ newId: z.string().trim().min(1).max(120) }).strict();
export type PlantRenameInput = z.infer<typeof plantRenameInput>;

/** How many references of one kind a rename updates (tables and fields that name the entry). */
export interface PlantReferenceCount {
  /** What holds the references: asset, assignment, item_link, owning_team, alias … */
  what: string;
  count: number;
}

export interface PlantRenamePreview {
  kind: PlantIdKind;
  scope: string;
  id: string;
  newId: string;
  name: string;
  /** Null: the rename can go ahead */
  problem: { code: string; message: string } | null;
  references: PlantReferenceCount[];
  /** Old ids of the entry that keep working (with the one this rename adds) */
  aliases: string[];
}

export interface PlantRenameResult extends PlantRenamePreview {
  /** The entry's page under its new id (null: it has none) */
  path: string | null;
}

/** An old id that still leads to its entry (Settings → Modules → Plant registry lists them). */
export interface PlantIdAlias {
  kind: PlantIdKind;
  scope: string;
  oldId: string;
  newId: string;
  renamedAt: string;
  renamedBy: string;
  /** The entry's page (null: none, or not visible) */
  path: string | null;
}

// ---------- the import's id mapping ----------

export const PLANT_ID_RULE_TYPES = ['replacePrefix', 'addPrefix', 'addSuffix', 'lowerCase'] as const;
export type PlantIdRuleType = (typeof PLANT_ID_RULE_TYPES)[number];

export const plantIdMapInput = z
  .object({
    /** old → new; without a kind it applies to every kind */
    entries: z
      .array(
        z
          .object({
            kind: z.enum(PLANT_ID_KINDS).nullable().default(null),
            old: z.string().trim().min(1).max(120),
            new: z.string().trim().min(1).max(120),
          })
          .strict(),
      )
      .max(PLANT_BULK.maxMapEntries)
      .default([]),
    rules: z
      .array(
        z
          .object({
            type: z.enum(PLANT_ID_RULE_TYPES),
            /** replacePrefix: the prefix to replace */
            from: z.string().max(80).default(''),
            /** replacePrefix: its replacement; addPrefix / addSuffix: what is added */
            to: z.string().max(80).default(''),
            kinds: z.array(z.enum(PLANT_ID_KINDS)).max(PLANT_ID_KINDS.length).default([]),
          })
          .strict(),
      )
      .max(PLANT_BULK.maxRules)
      .default([]),
  })
  .strict();
export type PlantIdMapInput = z.infer<typeof plantIdMapInput>;

/** An entry the import renames (its old id is in the mapping and exists) before it updates it from the files. */
export interface PlantPlannedRename {
  kind: PlantIdKind;
  scope: string;
  id: string;
  newId: string;
  name: string;
  references: PlantReferenceCount[];
}

/** An id of the files that is an old id of an entry: read as the entry's id (a note in the preview). */
export interface PlantAliasUse {
  kind: PlantIdKind;
  scope: string;
  oldId: string;
  newId: string;
}

// ---------- removing ----------

/** What goes with an entry that is removed, or what refuses it. */
export interface PlantRemovalItem {
  kind: PlantRemovableKind;
  scope: string;
  id: string;
  name: string;
  /** Removed with it (with "also remove what belongs to it"), or – when refused – what belongs to it */
  with: PlantReferenceCount[];
  /** Null: it is removed. Otherwise why not */
  refused: { code: string; message: string } | null;
}

export interface PlantRemovalPlan {
  items: PlantRemovalItem[];
  /** Entries removed in all, with what goes with them */
  counts: PlantReferenceCount[];
}

// ---------- bulk changes from the lists ----------

export const PLANT_BULK_KINDS = ['asset', 'site', 'profile', 'kpi', 'vlan', 'device'] as const;
export type PlantBulkKind = (typeof PLANT_BULK_KINDS)[number];

const tagList = z.array(z.string().trim().min(1).max(60)).max(50);
const optText = (max: number) => z.string().trim().max(max).optional();

/** The fields that may be set on many entries at once, per kind (missing: unchanged). */
export const plantBulkSetInput = z
  .object({
    // assets
    status: z.enum(ASSET_STATUSES).optional(),
    addTags: tagList.optional(),
    removeTags: tagList.optional(),
    /** A building of the asset's site (null: none) */
    buildingId: z.string().trim().max(80).nullable().optional(),
    /** A hierarchy node of the asset's site: its place (null: the site only) */
    nodeId: z.string().trim().max(80).nullable().optional(),
    domain: optText(60),
    processArea: optText(60),
    role: optText(60),
    manufacturer: optText(200),
    model: optText(200),
    endOfSupport: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    /** Device profile of the asset's assignment (null: none) */
    profileId: z.string().trim().max(80).nullable().optional(),
    // device profiles and KPI definitions
    category: optText(100),
    // VLANs
    type: optText(60),
    managedBy: optText(200),
    restricted: z.boolean().optional(),
    // VLANs and devices
    owner: optText(200),
    // devices
    state: z.enum(DEVICE_STATES).optional(),
    confidence: z.enum(DEVICE_CONFIDENCE).nullable().optional(),
    addFlags: z
      .array(
        z
          .string()
          .trim()
          .regex(/^[a-z][a-z0-9_]{0,39}$/),
      )
      .max(20)
      .optional(),
    removeFlags: z.array(z.string().trim().max(40)).max(20).optional(),
  })
  .strict();
export type PlantBulkSet = z.infer<typeof plantBulkSetInput>;

/** The fields of plantBulkSetInput each kind takes. */
export const PLANT_BULK_FIELDS: Record<PlantBulkKind, readonly (keyof PlantBulkSet)[]> = {
  asset: ['status', 'addTags', 'removeTags', 'buildingId', 'nodeId', 'domain', 'processArea', 'role', 'manufacturer', 'model', 'endOfSupport', 'profileId'],
  site: [],
  profile: ['category', 'manufacturer'],
  kpi: ['category'],
  vlan: ['type', 'managedBy', 'restricted', 'owner'],
  device: ['state', 'confidence', 'owner', 'addFlags', 'removeFlags'],
};

export const plantBulkInput = z
  .object({
    kind: z.enum(PLANT_BULK_KINDS),
    action: z.enum(['edit', 'remove']),
    items: z
      .array(z.object({ scope: z.string().trim().max(120).default(''), id: z.string().trim().min(1).max(120) }).strict())
      .min(1)
      .max(PLANT_BULK.maxItems),
    set: plantBulkSetInput.default({}),
    /** remove: also remove what belongs to each entry */
    cascade: z.boolean().default(false),
  })
  .strict();
export type PlantBulkInput = z.infer<typeof plantBulkInput>;

export interface PlantBulkItem {
  scope: string;
  id: string;
  name: string;
  /** changed | unchanged | removed | skipped (no right) | refused (a rule or a reference) */
  outcome: 'changed' | 'unchanged' | 'removed' | 'skipped' | 'refused';
  /** The fields that change */
  fields?: string[];
  with?: PlantReferenceCount[];
  reason?: { code: string; message: string };
}

/** POST /api/plant/bulk[/preview] */
export interface PlantBulkResult {
  kind: PlantBulkKind;
  action: 'edit' | 'remove';
  applied: boolean;
  items: PlantBulkItem[];
  counts: Record<PlantBulkItem['outcome'], number>;
  /** Whether applying it asks for a step-up */
  stepUp: boolean;
}
