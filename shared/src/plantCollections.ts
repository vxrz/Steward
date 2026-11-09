import type { PlantSource } from './plant.js';
import type { PlantDirection, PlantProtocol } from './plantData.js';
import type { PlantCollector, PlantItemRef } from './plantNetwork.js';
import type { PlantSourceDocumentResult } from './plantDocs.js';

/**
 * Plant registry, 0.11.0: data collections (docs/adr/0019-data-collections.md, docs/PLANT.md "Data collections").
 *
 * A **data collection** documents what a collector – a gateway, an ETL job – reads from one asset and interface: how
 * (mode, interval, debounce, triggers), where it loads it (destination), what it may do on the machine (access
 * patterns) and its **items**: the address read, the collector's name for the value, and the data point of the
 * asset's model it is (or none: raw). Three layers stay apart: the profile data point (canonical id, name, known-as
 * names), the asset's address of it (the assignment's override) and the collector's item.
 */

export const COLLECTION_MODES = ['interval', 'on_change', 'trigger', 'other'] as const;
export type CollectionMode = (typeof COLLECTION_MODES)[number];

/**
 * Where a collection loads its data: a Steward system (with a path), a Steward dataset, a publication target, text;
 * since 0.12 also a Steward platform or application (a sink's target).
 */
export const COLLECTION_DESTINATION_KINDS = ['system', 'dataset', 'publication', 'other', 'platform', 'application'] as const;
export type CollectionDestinationKind = (typeof COLLECTION_DESTINATION_KINDS)[number];

/** The importers (the format of the collector's configuration). */
export const COLLECTION_FORMATS = ['gateway_json', 'table', 'ie_opcua', 'node_red'] as const;
export type CollectionFormat = (typeof COLLECTION_FORMATS)[number];
/** Importers that may still change: their format is known from a public example only. */
export const COLLECTION_PREVIEW_FORMATS: readonly CollectionFormat[] = ['ie_opcua'];

export interface PlantCollectionTrigger {
  name: string;
  /** anychange, a comparison … (the collector's words) */
  condition: string;
  /** The address or data point the trigger watches */
  referencePoint: string;
  referenceValue: string;
}

export interface PlantCollectionTransform {
  /** Rename, type conversion, scaling, an expression – free text */
  note: string;
  scale: number | null;
  offset: number | null;
  /** int, float, string, bool … (empty: none) */
  cast: string;
}

export interface PlantCollectionItem {
  /** The address the collector reads */
  address: string;
  /** The collector's name for the value (a gateway's variable name) */
  outputName: string;
  outputType: string;
  /** The data point of the asset's model it is; null: raw (not mapped) */
  dataPoint: string | null;
  transform: PlantCollectionTransform;
  /** 0.12.0: what the value is, in plain text (optional) */
  description: string;
  notes: string;
}

/** What the collector may do on the machine, as address patterns (prefixes, wildcards – the collector's syntax). */
export interface PlantCollectionAccess {
  read: string[];
  write: string[];
  create: string[];
  delete: string[];
}

export interface PlantCollectionDestination {
  kind: CollectionDestinationKind;
  /** A Steward system (id), a dataset (key), a publication target or text */
  ref: string;
  /** Where there: a topic, a path, a table */
  path: string;
  notes: string;
}

// ---------- sinks and transformations (0.12) ----------

/**
 * What a transformation step does (documentation only – Steward never runs one): rename, scale or convert units,
 * aggregate over a window, filter, enrich or join, compute an expression, format the message, or something else.
 */
export const SINK_TRANSFORM_KINDS = ['rename', 'scale', 'unit', 'aggregate', 'filter', 'enrich', 'compute', 'format', 'other'] as const;
export type SinkTransformKind = (typeof SINK_TRANSFORM_KINDS)[number];

/** One step on the way to a sink, in order. Expressions and code are text: never run. */
export interface PlantSinkTransform {
  kind: SinkTransformKind;
  /** The field or item it applies to (empty: all) */
  field: string;
  /** A new name, a factor, a condition, an expression or code (text) */
  expression: string;
  /** Aggregation: the window (e.g. 1 min, 100 values) and the function (avg, max …) */
  window: string;
  function: string;
  description: string;
}

/** An item of the collection as the sink knows it: its target name or field there, and its own transformation. */
export interface PlantSinkMapping {
  /** The item: its output name, else its address */
  item: string;
  target: string;
  /** A transformation for this item only (overrides the sink's steps for it; text) */
  transform: string;
}

/**
 * A sink: where the collected data goes after it is loaded (and perhaps transformed) – a broker topic, a table, an
 * asset and aspect, a bucket path. The target is a Steward system, platform, application or dataset where one exists,
 * else text.
 */
export interface PlantCollectionSink {
  /** Stable id, unique in the collection */
  id: string;
  name: string;
  kind: CollectionDestinationKind;
  /** The target: a Steward item's id (system, platform, application), a dataset key, or text */
  ref: string;
  /** Where there: a topic, a table, an asset/aspect, a bucket path */
  object: string;
  /** Message format or protocol (JSON over MQTT, SQL insert, CSV file …) */
  format: string;
  /** When it is written: schedule, batching */
  schedule: string;
  /** Who looks after it (a person or team, free text) */
  owner: string;
  description: string;
  transforms: PlantSinkTransform[];
  mappings: PlantSinkMapping[];
  /** Written by an import (an import replaces it; one added by hand stays) */
  imported: boolean;
}

export interface PlantCollectionValues {
  /** Stable id, unique per asset */
  id: string;
  name: string;
  collector: PlantCollector;
  /** A data path of the asset this collection belongs to, or null */
  dataPathId: string | null;
  /** The interface of the asset's model it reads; null: unknown */
  interfaceId: string | null;
  mode: CollectionMode;
  intervalMs: number | null;
  debounceMs: number | null;
  triggers: PlantCollectionTrigger[];
  /** How the triggers combine, or how the values are composed (free text) */
  composition: string;
  /** The first sink as the destination of 0.11 (kept for older clients; `sinks` is what is stored) */
  destination: PlantCollectionDestination | null;
  /** Where the data goes (0.12): one or more sinks, each with its transformations and item mapping */
  sinks: PlantCollectionSink[];
  access: PlantCollectionAccess;
  /** Buffering, events, time sync and other settings of the collector */
  settings: { key: string; value: string }[];
  items: PlantCollectionItem[];
  /** 0.12.0: what the collection is for, in plain text (optional) */
  description: string;
  notes: string;
  /** The importer that wrote it (empty: entered by hand) and the file's name */
  format: CollectionFormat | '';
  sourceFile: string;
}

/** A data point of the asset's model, as a collection names it. */
export interface PlantCollectionPoint {
  id: string;
  name: string;
  interface: string;
  /** The asset's address: the assignment's override, else the profile's */
  address: string;
  dataType: string;
  unit: string;
  /** From the asset's additions (not the profile) */
  added: boolean;
}

export interface PlantCollectionCoverage {
  /** Items linked to a data point of the asset's model */
  mapped: number;
  /** Items without such a link */
  raw: number;
  /** Raw items whose address no data point of the model has */
  unknown: number[];
  /** Items linked to a data point the model no longer has */
  stale: number[];
  /** Data points two or more items of this collection map to (allowed, flagged) */
  duplicates: { dataPoint: string; items: number[] }[];
  /** Data points of its interface (or of the model, interface unknown) that no collection of the asset reads */
  notCollected: PlantCollectionPoint[];
}

export interface PlantCollectionView extends PlantCollectionValues, PlantSource {
  assetId: string;
  assetName: string;
  siteId: string;
  collectorRef: PlantItemRef | null;
  collectorHost: PlantItemRef | null;
  destinationRef: PlantItemRef | null;
  /** Per sink: the Steward item it names (null: text, a publication target) */
  sinkRefs: (PlantItemRef | null)[];
  /** Per item: the data point it is mapped to, as the asset's model has it (null: raw or stale) */
  points: (PlantCollectionPoint | null)[];
  coverage: PlantCollectionCoverage;
  /** Write, create or delete patterns: the collector may change something on the machine */
  writes: boolean;
  updatedAt: string;
  updatedBy: string;
}

/** GET /api/plant/assets/:assetId/collections */
export interface PlantAssetCollections {
  asset: { id: string; name: string; siteId: string };
  canManage: boolean;
  /** 0.13.0: may keep drafts of changes to it (propose) */
  canPropose?: boolean;
  /** May add known-as names to profiles and data points to the profile (the catalogue right) */
  canManageCatalogue: boolean;
  collections: PlantCollectionView[];
  /** The asset's model, for the editor */
  interfaces: { id: string; name: string; protocol: PlantProtocol; direction: PlantDirection }[];
  points: PlantCollectionPoint[];
  totals: { mapped: number; raw: number; notCollected: number };
  /** The data paths of the asset (for linking) */
  dataPaths: { id: string; subject: string }[];
}

/** A collection as a collector's or data point's page lists it. */
export interface PlantCollectionBrief {
  assetId: string;
  assetName: string;
  siteId: string;
  id: string;
  name: string;
  collector: PlantCollector;
  collectorLabel: string;
  mode: CollectionMode;
  intervalMs: number | null;
  items: number;
  writes: boolean;
  /** On a data point's page: the collector's names for it */
  outputNames?: string[];
  /** On a data point's page (0.12): where the data point goes – the sinks of the collection, with its target name there */
  goesTo?: PlantSinkTarget[];
}

/** A sink as the data point page names it: what the reader may see of its target. */
export interface PlantSinkTarget {
  sink: string;
  name: string;
  kind: CollectionDestinationKind;
  /** The target's name (empty: a Steward item the reader may not see) */
  label: string;
  path: string | null;
  object: string;
  /** The item's name in the sink (its mapping), if documented */
  target: string;
}

/** Where a sink's data goes next, as far as Steward knows it: data paths that read from its system, a dataset's dashboards. */
export interface PlantSinkDownstream {
  paths: { assetId: string; assetName: string; pathId: string; subject: string }[];
  /** More visible data paths than listed */
  more: number;
  /** Data paths of sites the reader may not see (counted, not named) */
  hidden: number;
  dashboards: { id: string; name: string; path: string }[];
  /** Dashboards the reader may not see */
  hiddenDashboards: number;
}

/** GET …/collections/:collectionId/flow (0.12): items → transformations → sinks → downstream, documentation only. */
export interface PlantCollectionFlow {
  assetId: string;
  collectionId: string;
  items: {
    index: number;
    address: string;
    outputName: string;
    /** The data point it is (null: raw) */
    dataPoint: { id: string; name: string } | null;
    /** The sinks it goes to, with its target name and own transformation there */
    sinks: { sink: string; target: string; transform: string }[];
  }[];
  sinks: (PlantCollectionSink & { targetRef: PlantItemRef | null; downstream: PlantSinkDownstream })[];
}

// ---------- import ----------

/** Why an item is suggested for a data point, strongest first. */
export const MAPPING_REASONS = ['mapping_file', 'remembered', 'address', 'name', 'alias', 'collector_alias', 'fuzzy', 'none'] as const;
export type MappingReason = (typeof MAPPING_REASONS)[number];

export interface PlantItemSuggestion {
  dataPoint: string | null;
  reason: MappingReason;
  /** 0 … 1 */
  confidence: number;
  /** Applied unless the person changes it (everything but a fuzzy suggestion) */
  accepted: boolean;
}

export interface PlantCollectionPreviewItem extends PlantCollectionItem {
  index: number;
  suggestion: PlantItemSuggestion;
  /** Other data points that came close (fuzzy), best first */
  alternatives: { dataPoint: string; confidence: number }[];
  /** The asset's address of the suggested data point (to offer recording the item's address) */
  pointAddress: string | null;
  /** The gateway name is not yet a known-as name of the suggested data point */
  newAlias: boolean;
}

export interface PlantCollectionPreviewEntry {
  id: string;
  name: string;
  action: 'add' | 'change' | 'unchanged' | 'remove';
  values: Omit<PlantCollectionValues, 'items'>;
  items: PlantCollectionPreviewItem[];
}

export interface PlantCollectionImportProblem {
  file: string;
  path: string;
  message: string;
}

export interface PlantCollectionPreview {
  format: CollectionFormat;
  /** The importer may still change (see COLLECTION_PREVIEW_FORMATS) */
  preview: boolean;
  collections: PlantCollectionPreviewEntry[];
  problems: PlantCollectionImportProblem[];
  warnings: PlantCollectionImportProblem[];
  /** The asset's model the items are matched against */
  points: PlantCollectionPoint[];
  canManageCatalogue: boolean;
}

/** What the person decided for one item in the preview. */
export interface PlantItemDecision {
  collection: string;
  index: number;
  dataPoint: string | null;
  /** Record the item's address as the asset's address of the data point (the assignment's override) */
  recordAddress?: boolean;
  /** Remember the gateway name as a known-as name: on the profile's data point, or only for this collector */
  alias?: 'none' | 'profile' | 'collector';
  /** An unknown address: add it as a data point – on this asset (an addition) or to the profile */
  add?: { target: 'asset' | 'profile'; id: string; name: string; interface: string; group: string };
}

export interface PlantCollectionImportResult {
  collections: { added: number; changed: number; unchanged: number; removed: number };
  items: { mapped: number; raw: number };
  remembered: number;
  addresses: number;
  aliases: { profile: number; collector: number };
  added: { asset: number; profile: number };
  /** 0.12: the files kept (secrets removed), one version per import */
  sources: { id: string; version: number; fileName: string; redactedPaths: number }[];
  /** 0.12: the gateway configuration document of each collection */
  documents: PlantSourceDocumentResult[];
}

export const PLANT_COLLECTION_LIMITS = {
  collectionsPerAsset: 200,
  items: 5000,
  triggers: 50,
  patterns: 500,
  settings: 100,
  text: 200,
  address: 500,
  longText: 8000,
  files: 10,
  fileBytes: 4 * 1024 * 1024,
  /** 0.12: sinks per collection, transformation steps per sink */
  sinks: 20,
  transforms: 50,
  /** 0.12: versions of a collector's configuration kept per asset (the oldest go first) */
  sourceVersions: 50,
} as const;
