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
import { unitRelation } from './plantData.js';

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

/**
 * Fields of an inherited interface a derived profile may change. Its protocol only where the inherited one is `other`
 * (0.13: a base across protocols); everywhere else it stays.
 */
export const PROFILE_INTERFACE_FIELDS = [
  'name',
  'protocol',
  'direction',
  'description',
  'version',
  'defaultPort',
  'authentication',
  'client',
  'notes',
] as const;
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
  /**
   * 0.13: the protocol – only for an inherited interface whose protocol is `other` (a base across protocols: the derived
   * profile says which one its device speaks, and the data points' addresses)
   */
  protocol?: PlantProtocol;
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
  /**
   * 0.13: the base's id of an interface, by the leading profile's interface id (left out: the same id). Each profile's
   * interface that holds the shared data points gets it – useful where the profiles' interfaces have different
   * protocols (the base's is then `other`)
   */
  interfaces?: Record<string, string>;
}

/**
 * Why a data point cannot go into the base (it is refused; leave it out or change the profiles first). `protocol` is no
 * longer used since 0.13 (interfaces of different protocols share a base interface of protocol `other`).
 */
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
    /** 0.13: its interfaces with their protocols */
    interfaces: { id: string; name: string; protocol: PlantProtocol }[];
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

// ---------- 0.13: matching data points of two profiles ----------

/** Why a data point matches another: the same id, a known-as name, the name, the unit. */
export type PlantPointMatchBy = 'id' | 'known_as' | 'name' | 'unit';

type MatchablePoint = { id: string; name: string; unit: string; aliases?: string[] };

const matchKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * How well a candidate matches a data point (extracting a base profile, a KPI input's mapping): the same id (8), a
 * known-as name or id in common (4), the same name (2), the same unit (1). A unit alone is no match (score ≤ 1).
 */
export function pointMatch(point: MatchablePoint, candidate: MatchablePoint): { by: PlantPointMatchBy[]; score: number } {
  const keys = (d: MatchablePoint) => new Set([d.id, ...(d.aliases ?? [])].map(matchKey).filter(Boolean));
  const mine = keys(point);
  const by: PlantPointMatchBy[] = [];
  if (candidate.id === point.id) by.push('id');
  if (candidate.id !== point.id && [...keys(candidate)].some((k) => mine.has(k))) by.push('known_as');
  if (matchKey(candidate.name) && matchKey(candidate.name) === matchKey(point.name)) by.push('name');
  if (point.unit && candidate.unit && unitRelation(point.unit, candidate.unit) === 'same') by.push('unit');
  const score = (by.includes('id') ? 8 : 0) + (by.includes('known_as') ? 4 : 0) + (by.includes('name') ? 2 : 0) + (by.includes('unit') ? 1 : 0);
  return { by, score };
}

/**
 * The best match of each data point among the candidates, in the points' order; a candidate matches one data point at
 * most (null: none matches better than a unit alone).
 */
export function matchPoints<C extends MatchablePoint>(points: MatchablePoint[], candidates: C[]): ({ point: C; by: PlantPointMatchBy[] } | null)[] {
  const taken = new Set<string>();
  return points.map((point) => {
    const best = candidates
      .filter((c) => !taken.has(c.id))
      .map((c) => ({ c, ...pointMatch(point, c) }))
      .filter((x) => x.score > 1)
      .sort((a, b) => b.score - a.score)[0];
    if (!best) return null;
    taken.add(best.c.id);
    return { point: best.c, by: best.by };
  });
}
