import type {
  PlantAuthKind,
  PlantDataPoint,
  PlantDirection,
  PlantFileSet,
  PlantInterface,
  PlantPointGroup,
  PlantProfileValues,
  PlantProtocol,
} from './plantData.js';

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
  /**
   * Data points added to it; a group of the same name as an inherited one adds to that group, and its description
   * (when not empty) replaces the inherited group's (0.12.0)
   */
  groups: PlantPointGroup[];
  /** Files added to it; the same id as an inherited file set replaces that one (an empty description inherits, 0.12.0) */
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

/** The key of a group or file set in `PlantResolvedProfile.origins` (interface ids hold no "/"). */
export const plantOriginKey = (iface: string, name: string): string => `${iface}/${name}`;

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
  /** 0.12.0: the profile whose description of it is in effect (inherited descriptions say where they come from) */
  descriptionFrom: string;
}

/**
 * A device profile as it is in effect: the bases' interfaces, groups, data points and files with this profile's
 * changes and additions. `interfaces` is the effective list (only what is present); `extends`, `interfaceOverrides`
 * and `pointOverrides` are this profile's own part, as stored.
 */
export interface PlantResolvedProfile extends PlantProfileValues {
  /** The profile and its bases, nearest first: [this, base, base of the base …] */
  chain: string[];
  /** 0.12.0: the profile whose description is in effect (a derived profile without its own inherits its base's) */
  descriptionFrom: string;
  origins: {
    interfaces: Record<string, PlantModelOrigin>;
    points: Record<string, PlantModelOrigin>;
    /** 0.12.0: data point groups, by `<interface>/<group name>` (the group without a name: `<interface>/`) */
    groups: Record<string, PlantModelOrigin>;
    /** 0.12.0: file sets, by `<interface>/<file set id>` */
    fileSets: Record<string, PlantModelOrigin>;
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

// ---------- 0.12.0: extract a base profile ----------

/**
 * Extract a base profile (docs/PLANT.md "Extracting a base profile"): from two or more device profiles without a base,
 * the data points they share become a new base profile that each of them extends. Ids that differ are renamed to the
 * base's id (the old id stays an alias); fields that differ stay as the profile's overrides; assets do not change.
 */
export interface PlantExtractPoint {
  /** The data point's id in the base – and, afterwards, in every profile */
  id: string;
  /** Per profile (id): the id the data point has there now */
  from: Record<string, string>;
}

export interface PlantExtractInput {
  /** The new base profile */
  id: string;
  name: string;
  description: string;
  /** The base is a template (only for other profiles to extend) – on by default */
  template: boolean;
  /** The profile whose data points give the base's name, data type, unit and description (one of `profiles`) */
  leading: string;
  /** The profiles that extend the base afterwards (2 or more, none with a base yet) */
  profiles: string[];
  points: PlantExtractPoint[];
}

/** Why a data point cannot go into the base (it is refused; leave it out or change the profiles first). */
export const PLANT_EXTRACT_POINT_PROBLEMS = ['missing', 'twice', 'protocol', 'group', 'interface', 'id_taken'] as const;
export type PlantExtractPointProblem = (typeof PLANT_EXTRACT_POINT_PROBLEMS)[number];

/** Why the extraction cannot go ahead as a whole. */
export const PLANT_EXTRACT_PROBLEMS = ['profile_unknown', 'has_base', 'not_enough', 'leading', 'base_taken', 'no_points', 'rules'] as const;
export type PlantExtractProblem = (typeof PLANT_EXTRACT_PROBLEMS)[number];

/** POST /api/plant/profiles/extract-base/candidates: the data points of the leading profile and their best matches. */
export interface PlantExtractCandidates {
  profiles: {
    id: string;
    name: string;
    extends: string | null;
    template: boolean;
    /** Assets with the profile (that the caller may see) */
    assets: number;
    /** Its data points, to match by hand */
    dataPoints: { id: string; name: string; unit: string; interface: string }[];
  }[];
  points: {
    id: string;
    name: string;
    unit: string;
    interface: string;
    protocol: PlantProtocol;
    group: string;
    /** Per other profile: the best match (null: none found) and why it matches */
    matches: Record<string, { id: string; name: string; unit: string; by: ('id' | 'known_as' | 'name' | 'unit')[] } | null>;
  }[];
}

/** POST /api/plant/profiles/extract-base/preview and the answer of POST /api/plant/profiles/extract-base. */
export interface PlantExtractPreview {
  /** The base profile as it would be created */
  base: PlantProfileValues;
  points: { id: string; problem: { code: PlantExtractPointProblem; message: string; params: Record<string, string> } | null }[];
  profiles: {
    id: string;
    name: string;
    /** Ids changed to the base's (data points and interfaces), with the references that follow */
    renames: { kind: 'interface' | 'data_point'; from: string; to: string; references: number }[];
    /** Inherited data points whose fields differ from the base: what the profile overrides */
    pointOverrides: { dataPoint: string; fields: string[] }[];
    interfaceOverrides: { interface: string; fields: string[] }[];
    /** What stays the profile's own: interfaces and data points */
    own: { interfaces: number; points: number };
    /** Assets with the profile (that the caller may see); their models do not change */
    assets: number;
  }[];
  problems: { code: PlantExtractProblem; message: string; params: Record<string, string> }[];
  /** Nothing refused: the extraction can be applied */
  ok: boolean;
}
