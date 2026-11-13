/**
 * Import and export of the data products module (0.22.0, ADR 0036 part 15, docs/DATA-PRODUCTS.md "Import and export"):
 * the shapes of the preview and the result of an import in Steward's file format. The format itself is the JSON
 * Schema docs/data-products/data-products-1.schema.json (GET /api/data-products/schema).
 */

/** Add only: entries that exist are left as they are. Add and update: existing entries take what the files say. */
export const DATA_PRODUCT_IMPORT_MODES = ['add', 'update'] as const;
export type DataProductImportMode = (typeof DATA_PRODUCT_IMPORT_MODES)[number];

export const DATA_PRODUCT_IMPORT_KINDS = ['domain', 'dataObject', 'element', 'dataProduct'] as const;
export type DataProductImportKind = (typeof DATA_PRODUCT_IMPORT_KINDS)[number];

export type DataProductImportAction = 'add' | 'change' | 'unchanged' | 'skip';

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
}

export interface DataProductImportResult {
  mode: DataProductImportMode;
  counts: DataProductImportCounts;
  warnings: string[];
}
