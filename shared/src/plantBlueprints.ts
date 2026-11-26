import type { PlantAssetBrief } from './plantData.js';

/**
 * Machine blueprints (0.30.0, ADR 0041): a checklist per kind of machine – the signals one expects of it (names and
 * meanings, no data types) – compared with device profiles and assets. A blueprint is advice: it never changes a profile
 * or an asset, it only reports what is covered and what is missing.
 */

/** How much a signal matters: must have, should have, nice to have. */
export const BLUEPRINT_IMPORTANCES = ['must', 'should', 'nice'] as const;
export type BlueprintImportance = (typeof BLUEPRINT_IMPORTANCES)[number];

/** Why a signal matters (any of them). */
export const BLUEPRINT_WHY = ['quality', 'energy', 'availability', 'maintenance', 'safety', 'traceability'] as const;
export type BlueprintWhy = (typeof BLUEPRINT_WHY)[number];

/** What a blueprint is assigned to. */
export const BLUEPRINT_TARGETS = ['profile', 'asset'] as const;
export type BlueprintTargetKind = (typeof BLUEPRINT_TARGETS)[number];

export const BLUEPRINT_LIMITS = {
  /** Blueprints of the installation */
  blueprints: 500,
  signals: 200,
  /** Known-as names and keywords of one signal */
  aliases: 20,
  name: 200,
  text: 2000,
  reason: 1000,
  /** Blueprints of one profile or asset */
  perTarget: 50,
  /** Data points one signal maps to (three phases …) */
  pointsPerSignal: 50,
} as const;

/** One signal a blueprint expects: what it tells, not how it is delivered. */
export interface PlantBlueprintSignal {
  /** Stable id, unique in the blueprint (mappings and marks name it) */
  id: string;
  name: string;
  /** What it tells (no data type, no unit, no address) */
  meaning: string;
  why: BlueprintWhy[];
  importance: BlueprintImportance;
  /** Known-as names and keywords: used only for suggestions */
  aliases: string[];
}

export interface PlantBlueprintValues {
  id: string;
  name: string;
  description: string;
  /** A standard, or "own experience" */
  reference: string;
  version: string;
  signals: PlantBlueprintSignal[];
}

export type BlueprintCounts = Record<BlueprintImportance, number>;

export interface PlantBlueprintSummary {
  id: string;
  name: string;
  reference: string;
  version: string;
  signalCount: number;
  byImportance: BlueprintCounts;
  /** Device profiles and assets the reader may see that have it */
  profileCount: number;
  assetCount: number;
  importId: string | null;
  notInSource: boolean;
  updatedAt: string;
}

export interface PlantBlueprintDetail extends PlantBlueprintSummary {
  description: string;
  signals: PlantBlueprintSignal[];
  /** The profiles and assets (that the reader may see) it is assigned to */
  profiles: { id: string; name: string }[];
  assets: PlantAssetBrief[];
  /** The reader may change it / manage it (shares, delete) */
  canEdit: boolean;
  canManage: boolean;
  updatedBy: string;
}

/** A mark: this signal does not apply, with a reason (free text, required). */
export interface PlantBlueprintNotApplicable {
  reason: string;
  by: string;
  at: string;
  /** Where the mark is: the profile (holds for its assets) or the asset itself */
  on: BlueprintTargetKind;
}

/** What suggests a data point for a signal: a name or known-as name that matches – never counted as covered. */
export interface PlantBlueprintSuggestion {
  dataPoint: string;
  name: string;
  matchedBy: 'name' | 'alias' | 'keyword';
  /** The text of the signal that matched */
  matched: string;
}

/** A data point a signal is mapped to. */
export interface PlantBlueprintMappedPoint {
  id: string;
  name: string;
  /** Where the mapping is made: the profile or the asset */
  source: BlueprintTargetKind;
  /** A data point the profile (or the asset's data) no longer has */
  missing?: boolean;
  /** Asset: a data collection of the asset reads it (null on a profile) */
  collected: boolean | null;
}

/**
 * covered: mapped to data points that exist (asset: and every one is collected)
 * missing: not mapped – the profile has no matching data point (or the mapping leads nowhere)
 * notCollected: asset only – the profile (or the asset) has it, but no data collection of this asset reads it
 * notApplicable: marked with a reason
 */
export const BLUEPRINT_STATES = ['covered', 'missing', 'notCollected', 'notApplicable'] as const;
export type BlueprintState = (typeof BLUEPRINT_STATES)[number];

export interface PlantBlueprintSignalCoverage {
  signal: PlantBlueprintSignal;
  state: BlueprintState;
  points: PlantBlueprintMappedPoint[];
  notApplicable: PlantBlueprintNotApplicable | null;
  /** Only where nothing is mapped (state missing): matches by name, never counted */
  suggestions: PlantBlueprintSuggestion[];
}

export interface PlantBlueprintTotals {
  total: number;
  /** total less the signals marked not applicable */
  applicable: number;
  covered: number;
  notCollected: number;
  missing: number;
  notApplicable: number;
  /** Missing signals that have a suggestion (not counted as covered) */
  suggested: number;
}

export interface PlantBlueprintCoverage {
  blueprint: { id: string; name: string; reference: string; version: string };
  /** How the target has it: assigned to it, through its profile, or both (an asset) */
  via: 'direct' | 'profile' | 'both';
  totals: PlantBlueprintTotals;
  byImportance: Record<BlueprintImportance, PlantBlueprintTotals>;
  signals: PlantBlueprintSignalCoverage[];
}

/** GET /plant/profiles/:id/blueprints and /plant/assets/:id/blueprints */
export interface PlantBlueprintCoverageView {
  target: { kind: BlueprintTargetKind; id: string; name: string };
  /** An asset: its profile (null: none, only blueprints assigned to the asset itself show) */
  profile: { id: string; name: string } | null;
  /** The reader may assign, map and mark on this target */
  canEdit: boolean;
  blueprints: PlantBlueprintCoverage[];
}
