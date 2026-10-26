import type { Backlink, ItemLink, ReviewStatus, ServiceCriticality } from './records.js';

/**
 * Applications in the service catalogue (#84): what people call a platform ("Insights Hub", "Industrial Edge")
 * and smaller applications without an interface. Steward platforms (integrations with an API and credentials)
 * are mapped to them, services consist of them, and each one has an optional CIA rating (protection need).
 */

// ---------- CIA rating (protection need) ----------

/** The three dimensions of a protection need: confidentiality, integrity, availability. */
export const CIA_DIMENSIONS = ['confidentiality', 'integrity', 'availability'] as const;
export type CiaDimension = (typeof CIA_DIMENSIONS)[number];

/**
 * Colours a level can have: a fixed palette (Mantine colour names), so administrators choose from a list and never
 * enter CSS.
 */
export const CIA_COLORS = ['gray', 'green', 'teal', 'cyan', 'blue', 'indigo', 'violet', 'grape', 'pink', 'yellow', 'orange', 'red'] as const;
export type CiaColor = (typeof CIA_COLORS)[number];

/** Keys of levels: stable (ratings store them), lower case. */
export const CIA_LEVEL_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const CIA_LIMITS = { minLevels: 2, maxLevels: 10, label: 60, description: 500, justification: 2000, reason: 2000 } as const;

export interface CiaLevel {
  key: string;
  label: string;
  description: string;
  color: CiaColor;
}

/**
 * The default scale: the protection needs of BSI IT-Grundschutz (BSI-Standard 200-2), lowest first. Their labels and
 * descriptions are translated in the UI (built-in levels); a custom scale shows what the administrator entered.
 */
export const DEFAULT_CIA_LEVELS: readonly CiaLevel[] = [
  { key: 'normal', label: 'Normal', description: 'The impact of damage is limited and calculable.', color: 'green' },
  { key: 'high', label: 'High', description: 'The impact of damage can be considerable.', color: 'orange' },
  { key: 'very_high', label: 'Very high', description: 'The impact of damage can reach an existentially threatening, catastrophic level.', color: 'red' },
];

/**
 * default: the BSI scale for all three dimensions; shared: one custom scale for all three; perDimension: a custom
 * scale for each dimension.
 */
export const CIA_SCALE_MODES = ['default', 'shared', 'perDimension'] as const;
export type CiaScaleMode = (typeof CIA_SCALE_MODES)[number];

export interface CiaScale {
  mode: CiaScaleMode;
  /** The ordered levels (lowest first) of each dimension; the same list three times unless mode is perDimension */
  levels: Record<CiaDimension, CiaLevel[]>;
  updatedAt: string | null;
  updatedBy: string | null;
  /** How many application ratings and service overrides use each level key, per dimension (for the mapping when the scale changes) */
  usage: Record<CiaDimension, Record<string, number>>;
  canEdit: boolean;
}

/** One dimension of an application's rating. */
export interface CiaRating {
  /** Key of a level of the dimension's scale */
  level: string;
  justification: string;
  ratedAt: string;
  ratedBy: string;
  /** The scale changed and this level is no longer on it (or was flagged for re-rating): it does not count until rated again */
  needsRerating: boolean;
  /** Set by a scale change: the label the level had before (mapped or flagged) */
  previousLabel: string | null;
}

export type ApplicationRating = Record<CiaDimension, CiaRating | null>;

/** A service override of a dimension of its derived protection need (cumulation or distribution effect). */
export interface ProtectionNeedOverride {
  level: string;
  reason: string;
  setAt: string;
  setBy: string;
  needsRerating: boolean;
  previousLabel: string | null;
}

/**
 * One dimension of a service's protection need: derived with the maximum principle (the highest level across its
 * applications that are not archived), and the effective one (the override when set, else the derived level).
 */
export interface ProtectionNeedDimension {
  /** Highest level across the applications (null: none rated) */
  derived: string | null;
  /** Applications whose rating gave the derived level */
  derivedFrom: string[];
  /** Applications (not archived) with a valid rating of this dimension … */
  rated: number;
  /** … of this many applications (not archived) */
  total: number;
  /** Applications whose rating needs re-rating after a scale change (not counted) */
  needsRerating: number;
  override: ProtectionNeedOverride | null;
  /** The override when set (and valid), else the derived level */
  effective: string | null;
}

export type ServiceProtectionNeed = Record<CiaDimension, ProtectionNeedDimension>;

// ---------- applications ----------

/** How a service uses an application: its primary application, a dependency, or something else (free text). */
export const APPLICATION_ROLES = ['primary', 'dependency', 'other'] as const;
export type ApplicationRole = (typeof APPLICATION_ROLES)[number];

export interface ApplicationServiceRef {
  id: string;
  name: string;
  archived: boolean;
  role: ApplicationRole | null;
  roleText: string;
}

/** A Steward platform mapped to an application. Platforms the reader may not see: visible false, no id or name. */
export interface ApplicationIntegration {
  visible: boolean;
  platformId: string | null;
  name: string;
  kind: string | null;
  environment: string | null;
  path: string | null;
  mappedAt: string;
  mappedBy: string;
}

export interface ApplicationSummary {
  id: string;
  name: string;
  vendor: string;
  version: string;
  url: string;
  criticality: ServiceCriticality | null;
  /** Steward users and teams responsible (user:<name>, team:<name>) */
  owners: string[];
  tags: string[];
  cmdb: { system: string; id: string; url: string } | null;
  archived: boolean;
  services: ApplicationServiceRef[];
  /** Mapped platforms (all, also those the reader may not see) */
  integrationCount: number;
  rating: ApplicationRating;
  /** Living documents scoped to the application that the reader may read */
  documentCount: number;
  overdueDocuments: number;
  updatedAt: string;
}

/** A living document scoped to an application ("applies to"). Only documents the reader may read are listed. */
export interface ApplicationDocument {
  id: string;
  number: string;
  title: string;
  typeKey: string;
  typeName: string;
  status: string;
  edition: string | null;
  reviewStatus: ReviewStatus;
  nextReviewAt: string | null;
  daysLeft: number | null;
}

export interface ApplicationDetail extends ApplicationSummary {
  description: string;
  createdAt: string;
  createdBy: string;
  updatedBy: string;
  integrations: ApplicationIntegration[];
  links: ItemLink[];
  backlinks: Backlink[];
  documents: ApplicationDocument[];
  canEdit: boolean;
}

/** An application of a service (service page), with its rating and its integrations. */
export interface ServiceApplication {
  id: string;
  name: string;
  archived: boolean;
  criticality: ServiceCriticality | null;
  role: ApplicationRole | null;
  roleText: string;
  rating: ApplicationRating;
  integrations: ApplicationIntegration[];
  addedAt: string;
  addedBy: string;
}

/** An application a document applies to. */
export interface DocumentApplicationRef {
  id: string;
  name: string;
  archived: boolean;
}

/** Index of a level in a scale (-1: not on it). The maximum principle compares these. */
export function levelRank(levels: readonly CiaLevel[], key: string | null | undefined): number {
  return key ? levels.findIndex((l) => l.key === key) : -1;
}

/** A value for each dimension. */
export function byDimension<T>(f: (d: CiaDimension) => T): Record<CiaDimension, T> {
  return { confidentiality: f('confidentiality'), integrity: f('integrity'), availability: f('availability') };
}
