import type { PlantCollector } from './plantNetwork.js';
import type { CollectionFormat } from './plantCollections.js';
import type { RecordTypeDefinition } from './records.js';

/**
 * Plant registry, 0.12: documents on plant entries and the versioned sources of collection imports
 * (docs/PLANT.md "Documents" and "Gateway configurations").
 *
 * Records and documents link to sites, assets, device profiles, data collections and their sinks (link kinds of the
 * plant module). A plant page lists the records linked to it and – read-only – those of what it inherits from: a
 * derived profile its base profiles' documents, an asset its profile chain's and its collections'.
 */

/** The plant entries with a Documents panel (their link kinds). */
export const PLANT_DOC_KINDS = ['site', 'asset', 'device-profile', 'data-collection', 'data-sink'] as const;
export type PlantDocKind = (typeof PLANT_DOC_KINDS)[number];

/** A record linked to a plant entry, as far as the reader may read it. */
export interface PlantDocItem {
  id: string;
  number: string;
  title: string;
  typeKey: string;
  typeName: string;
  /** The type's workflow ("document": a living document with editions) */
  workflow: string;
  status: string;
  /** Living documents: the edition valid now (null: none approved yet) */
  edition: string | null;
  /** Files attached to its current content */
  attachments: number;
  /** Written by an import of a collector's configuration (its generated part is rewritten by the next import) */
  generated: boolean;
}

/** The documents of one entry: its own, or those it inherits from one other entry. */
export interface PlantDocGroup {
  /** null: the entry's own documents; else the entry they are inherited from */
  from: { kind: PlantDocKind; id: string; label: string; path: string | null } | null;
  documents: PlantDocItem[];
  /** Linked records the reader may not read: counted, not named */
  hidden: number;
}

/** GET /api/plant/documents?kind=&id= */
export interface PlantDocuments {
  kind: PlantDocKind;
  id: string;
  label: string;
  own: PlantDocGroup;
  /** Read-only, in order: base profiles (nearest first), the profile chain of an asset, its collections and sinks */
  inherited: PlantDocGroup[];
  /** May create records (the button "New document") */
  canCreate: boolean;
}

// ---------- the sources of collection imports ----------

/**
 * The built-in type of the gateway configuration documents (a living document, no periodic review): created with the
 * first import that writes one; its id is fixed, its key GWC unless an installation already uses it.
 */
export const PLANT_SOURCE_TYPE_ID = 'rty_gwc';
export const PLANT_SOURCE_TYPE_KEYS = ['GWC', 'GWCFG', 'GATEWAY', 'PLGW'];
export const PLANT_SOURCE_RECORD_TYPE: RecordTypeDefinition = {
  key: 'GWC',
  name: 'Gateway configuration',
  description:
    'The configuration of a collector (a gateway, an ETL job) as an import of data collections read it: a summary that each import rewrites, the file with its secrets removed, and your own notes below it.',
  workflow: 'document',
  template: '',
  fields: [],
  reviewIntervalMonths: 0,
};
/** The heading of the part of a gateway configuration document that each import rewrites (not translated: it is found by it). */
export const PLANT_SOURCE_GENERATED_HEADING = '## Gateway configuration (generated)';

/** One file of an import of a collector's configuration, as Steward keeps it: secrets removed. */
export interface PlantCollectionSource {
  id: string;
  assetId: string;
  collector: PlantCollector;
  /** The collector's name as the reader may see it */
  collectorLabel: string;
  /** Per asset and collector: 1, 2, 3 … (one per import) */
  version: number;
  fileName: string;
  format: CollectionFormat;
  /** SHA-256 and size of the file as uploaded (never stored) */
  sha256: string;
  size: number;
  /** SHA-256 and size of what Steward keeps */
  redactedSha256: string;
  redactedSize: number;
  /** Where values were removed (JSON paths, CSV columns) – never the values */
  redactedPaths: string[];
  /** The collections this import wrote */
  collections: string[];
  importedBy: string;
  importedAt: string;
}

/** GET …/collections/sources?collection= : the versions, newest first. */
export interface PlantCollectionSources {
  assetId: string;
  sources: PlantCollectionSource[];
}

export interface PlantSourceChange {
  op: 'added' | 'removed' | 'changed';
  /** A JSON path, e.g. datasets[0].datapoints[3].address */
  path: string;
  before: string | null;
  after: string | null;
}

export interface PlantSourceDiffLine {
  op: 'same' | 'added' | 'removed' | 'gap';
  text: string;
}

/** GET …/collections/sources/diff?from=&to= */
export interface PlantSourceDiff {
  from: Pick<PlantCollectionSource, 'id' | 'version' | 'fileName' | 'importedAt'>;
  to: Pick<PlantCollectionSource, 'id' | 'version' | 'fileName' | 'importedAt'>;
  /** structure: both are JSON or YAML (the changes by path); lines: a line diff */
  kind: 'structure' | 'lines';
  changes: PlantSourceChange[];
  /** The line diff with three lines of context ("gap" for skipped equal lines) */
  lines: PlantSourceDiffLine[];
  /** More changes or lines than shown */
  truncated: boolean;
}

/** What an import did with the gateway configuration document of a collection. */
export interface PlantSourceDocumentResult {
  collection: string;
  /** created, updated, revised (a new edition started), skipped */
  action: 'created' | 'updated' | 'revised' | 'skipped';
  recordId: string | null;
  number: string | null;
  /** Why it was skipped: the reader may not create or change records, the document is in review */
  reason?: 'forbidden' | 'in_review' | 'failed';
}

export const PLANT_SOURCE_LIMITS = {
  /** Changes and diff lines answered */
  diffChanges: 2000,
  diffLines: 4000,
  /** Paths listed per source */
  redactedPaths: 500,
} as const;
