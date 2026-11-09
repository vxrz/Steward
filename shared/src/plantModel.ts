import type { PlantAuthKind, PlantDataPoint, PlantDirection, PlantFileSet, PlantInterface, PlantPointGroup, PlantProfileValues } from './plantData.js';

/**
 * Plant registry, 0.11.0: more modelling for device profiles and assets (docs/PLANT.md, "Profile inheritance and asset
 * additions"; ADR 0007, "Update 0.11").
 *
 * - **Profile inheritance** – a device profile may extend one base profile (`extends`, several levels, no cycles). It
 *   inherits the base's interfaces, groups, data points and files, may add its own, change fields of inherited
 *   interfaces and data points (overrides) and mark inherited ones as not present. The **resolved profile** – the
 *   effective model – is computed in one place on the server and used everywhere a profile is read.
 * - **Asset additions** – an assignment may add data points to an interface of its profile and add whole interfaces for
 *   that one asset. They count as delivered like the profile's data points.
 */

/** At most this many profiles in a chain (the profile and its bases). */
export const PLANT_PROFILE_MAX_DEPTH = 8;

/** Fields of an inherited interface a derived profile may change (its protocol stays). */
export const PROFILE_INTERFACE_FIELDS = ['name', 'direction', 'description', 'version', 'defaultPort', 'authentication', 'client', 'notes'] as const;
export type ProfileInterfaceField = (typeof PROFILE_INTERFACE_FIELDS)[number];

/** Fields of an inherited data point a derived profile may change (its id, interface and group stay). */
export const PROFILE_POINT_FIELDS = [
  'name',
  'description',
  'dataType',
  'unit',
  'address',
  'access',
  'updateRateMs',
  'enumValues',
  'aliases',
  'notes',
  'publications',
] as const;
export type ProfilePointField = (typeof PROFILE_POINT_FIELDS)[number];

/** An inherited interface as a derived profile changes it. A key left out reads as inherited. */
export interface PlantInterfaceOverride {
  /** The inherited interface */
  interface: string;
  /** False: the derived device does not have it (nor its data points) */
  present: boolean;
  name?: string;
  direction?: PlantDirection;
  description?: string;
  version?: string;
  defaultPort?: number | null;
  authentication?: PlantAuthKind;
  client?: string;
  notes?: string;
  /** Data points added to it; a group of the same name as an inherited one adds to that group */
  groups: PlantPointGroup[];
  /** Files added to it; the same id as an inherited file set replaces that one */
  fileSets: PlantFileSet[];
}

/** An inherited data point as a derived profile changes it. A key left out reads as inherited. */
export interface PlantProfilePointOverride {
  dataPoint: string;
  /** False: the derived device does not have it */
  present: boolean;
  name?: string;
  description?: string;
  dataType?: string;
  unit?: string;
  address?: string;
  access?: PlantDirection;
  updateRateMs?: number | null;
  enumValues?: string[];
  aliases?: string[];
  notes?: string;
  publications?: PlantDataPoint['publications'];
}

/** Where an item of a resolved profile comes from, seen from that profile. */
export type PlantModelOriginKind = 'own' | 'inherited' | 'overridden';

export interface PlantModelOrigin {
  kind: PlantModelOriginKind;
  /** The profile that defines it */
  from: string;
  /** The fields this profile changes (overridden) */
  fields: string[];
  /** Profiles between the defining one and this one that changed it */
  changedBy: string[];
}

/**
 * A device profile as it is in effect: the bases' interfaces, groups, data points and files with this profile's
 * changes and additions. `interfaces` is the effective list (only what is present); `extends`, `interfaceOverrides`
 * and `pointOverrides` are this profile's own part, as stored.
 */
export interface PlantResolvedProfile extends PlantProfileValues {
  /** The profile and its bases, nearest first: [this, base, base of the base …] */
  chain: string[];
  origins: {
    interfaces: Record<string, PlantModelOrigin>;
    points: Record<string, PlantModelOrigin>;
  };
  /** Inherited items this profile (or a base between) marks as not present */
  notPresent: {
    interfaces: { id: string; name: string; by: string }[];
    points: { id: string; name: string; interface: string; by: string }[];
  };
  /** This profile's overrides of items its bases do not have (any more): they change nothing */
  unusedOverrides: { interfaces: string[]; points: string[] };
}

/** A data point an asset adds to an interface of its profile (or to an interface it adds itself). */
export interface PlantAssetPointAddition extends PlantDataPoint {
  /** The interface (of the profile, or added on the asset) */
  interface: string;
  /** Its group there (empty: without a group) */
  group: string;
}

/** What an assignment adds for its one asset. */
export interface PlantAssignmentAdditions {
  /** Whole interfaces of this asset alone */
  interfaces: PlantInterface[];
  /** Data points added to interfaces of the profile */
  dataPoints: PlantAssetPointAddition[];
}

export const EMPTY_ADDITIONS: PlantAssignmentAdditions = { interfaces: [], dataPoints: [] };

/** Where an item of an asset's model comes from. */
export type PlantAssetOrigin = 'profile' | 'asset';
