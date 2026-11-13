/**
 * Import and export of the data products module (0.22.0, ADR 0036 part 15, docs/DATA-PRODUCTS.md "Import and export"):
 * the shapes of the preview and the result of an import in Steward's file format. The format itself is the JSON
 * Schema docs/data-products/data-products-1.schema.json (GET /api/data-products/schema).
 */

/**
 * Add only: entries that exist are left as they are. Add and update: existing entries take what the files say.
 * Replace (phase 2): as add and update, and the files are the whole of an earlier import of the same `origin` – its
 * entries the files no longer hold are removed, and the lists of the products the files hold (members, ports, steps,
 * consumers) lose the items the files leave out; what the importer may not see is never removed (counted).
 */
export const DATA_PRODUCT_IMPORT_MODES = ['add', 'update', 'replace'] as const;
export type DataProductImportMode = (typeof DATA_PRODUCT_IMPORT_MODES)[number];

export const DATA_PRODUCT_IMPORT_KINDS = ['domain', 'dataObject', 'element', 'dataProduct'] as const;
export type DataProductImportKind = (typeof DATA_PRODUCT_IMPORT_KINDS)[number];

export type DataProductImportAction = 'add' | 'change' | 'unchanged' | 'skip' | 'remove';

/** The name an import keeps its entries under (an import's own name, `git:<source>` for Git sync): letters, digits, ". _ - : /" */
export const DATA_PRODUCT_IMPORT_ORIGIN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
/**
 * GET /api/data-products/import-origins (0.24.0): an earlier import's origin with the entries under it the caller may
 * see – what _Replace an earlier import_ can name. Origins without such an entry are neither listed nor counted.
 */
export interface DataProductImportOrigin {
  origin: string;
  /** Entries the caller may see (domains, data objects, elements, products) */
  entries: number;
  /** When the newest of them was recorded */
  lastAt: string;
}
/** At most this many origins are listed, the newest first */
export const DATA_PRODUCT_IMPORT_ORIGINS_LISTED = 50;

/** More removals than this ask for the step-up dataproduct.bulkChange */
export const DATA_PRODUCT_IMPORT_REMOVALS_WITHOUT_STEP_UP = 1;

export interface DataProductImportField {
  /** The field in the file's words, with the item of a list: `ports[output orders v2].bindings[prod].contract` */
  field: string;
  before: unknown;
  after: unknown;
}

export interface DataProductImportChange {
  kind: DataProductImportKind;
  /** The key, or an element's platform, kind, qualified name and environment */
  key: string;
  action: DataProductImportAction;
  /** What changes, field by field (action change) */
  fields: DataProductImportField[];
  /** Why it is skipped (action skip) */
  reason?: string;
}

export interface DataProductImportProblem {
  file: string;
  /** Where: a place in the file, or the entry */
  path: string;
  message: string;
  /** The error code of a refusal the services gave (DATA_PRODUCT_KEY_TAKEN …) */
  code?: string;
}

export interface DataProductImportCounts {
  add: number;
  change: number;
  unchanged: number;
  skip: number;
  /** Mode replace: entries removed (their list items removed are counted under `removedItems`) */
  remove?: number;
  /** Mode replace: members, ports, steps and consumers the files leave out of their products */
  removedItems?: number;
  /** Mode replace: entries and items the files leave out that the importer may not see – kept, never removed */
  keptHidden?: number;
}

export interface DataProductImportPreview {
  mode: DataProductImportMode;
  counts: DataProductImportCounts;
  /** Added, changed and skipped entries (unchanged ones are counted), at most 2,000 */
  changes: DataProductImportChange[];
  /** Nothing is imported while there is one */
  problems: DataProductImportProblem[];
  /** Hints that do not stop the import (a confirmation it will ask for, fields an import does not change) */
  warnings: string[];
  files: { name: string; sha256: string; bytes: number }[];
  /** Pass it to the import: a different result is refused (DATA_PRODUCT_IMPORT_CHANGED) */
  fingerprint: string;
  /** The origin the import keeps its entries under (mode replace: the earlier import it replaces) */
  origin?: string | null;
  /** Mode replace removes more than one entry or item: importing asks for the step-up dataproduct.bulkChange */
  stepUp?: boolean;
  /** ODPS documents among the files, read as data products of Steward's format */
  odps?: number;
}

export interface DataProductImportResult {
  mode: DataProductImportMode;
  counts: DataProductImportCounts;
  warnings: string[];
}
