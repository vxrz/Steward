import { z } from 'zod';

/**
 * Data products, phase 3 package D (0.25.0, ADR 0037 parts 4 and 6, and the GDPR Art. 30 carry-over of 0.24.0):
 * semantic models (Apache Ossie) as governed records of a product, previews on ports and elements, and the Art. 30
 * details – transfers to third countries with their safeguards (Art. 30(1)(e)) and the reference to the technical and
 * organisational measures (Art. 30(1)(g)) – entered on a data object or a product.
 */

// ---------- semantic models (ADR 0037 part 4) ----------

/** The Ossie revisions Steward lints against (the vendored official schemas, server/assets/ossie). */
export const OSSIE_REVISIONS = ['0.1.1', '0.2.0.dev0'] as const;
export type OssieRevision = (typeof OSSIE_REVISIONS)[number];

export const DATA_SEMANTIC_LIMITS = {
  /** One stored document as written */
  documentBytes: 1024 * 1024,
  /** Versions kept per product (every save is one; nothing is ever removed but with the product) */
  versions: 500,
  note: 1_000,
  /** Lint and drift findings returned per kind (the rest counted) */
  findings: 200,
  /** The document an MCP read returns (characters; the rest is cut and said) */
  mcpChars: 60_000,
  /** Semantic models in one proposal of an assistant */
  proposalModels: 10,
  /** Recorded responses linked to one port */
  recordingsPerPort: 20,
  /** What a port preview shows of a recorded response's body (characters, masked) */
  recordingPreviewChars: 16_384,
  /** Examples shown per property of a contract, and properties per schema object */
  examplesPerProperty: 5,
  exampleChars: 500,
  exampleProperties: 300,
} as const;

/** Where a version came from: the editor, a draft started from the bound contracts, an assistant's proposal, the API. */
export const DATA_SEMANTIC_ORIGINS = ['page', 'draft', 'proposal', 'api'] as const;
export type DataSemanticOrigin = (typeof DATA_SEMANTIC_ORIGINS)[number];

export interface DataSemanticSignOff {
  by: string;
  at: string;
  /** The day from which the version is the valid one (the day of the sign-off) */
  validFrom: string;
  note: string;
  /** The SHA-256 of the document the person signed off */
  sha256: string;
}

export interface DataSemanticVersionSummary {
  version: number;
  sha256: string;
  size: number;
  format: 'yaml' | 'json';
  /** The document's `version` when it names a revision Steward knows, else null */
  ossieVersion: string | null;
  note: string;
  origin: DataSemanticOrigin;
  /** Lint findings when it was saved (they never block saving) */
  lintFindings: number;
  createdBy: string;
  createdAt: string;
  signOff: DataSemanticSignOff | null;
}

export const DATA_SEMANTIC_FINDING_KINDS = [
  // lint: the document against the vendored official schema
  'parse',
  'version',
  'schema',
  // drift: the document against what Steward knows of the product, on read
  'sourceNotBound',
  'columnMissing',
  'personalNoAiContext',
  'metricUnknownField',
  'metricUnknownDataset',
] as const;
export type DataSemanticFindingKind = (typeof DATA_SEMANTIC_FINDING_KINDS)[number];

export interface DataSemanticFinding {
  kind: DataSemanticFindingKind;
  severity: 'error' | 'warning';
  /** A JSON pointer into the document ('' : the document) */
  path: string;
  /** In English (the web app words it from kind and params) */
  message: string;
  params: Record<string, string | number>;
}

export interface DataSemanticFindings {
  findings: DataSemanticFinding[];
  /** Findings left out beyond DATA_SEMANTIC_LIMITS.findings */
  more: number;
}

/** GET /api/data-products/:id/semantic-model/versions/:n – one version with its text, lint and drift findings. */
export interface DataSemanticVersion extends DataSemanticVersionSummary {
  document: string;
  /** Against the revision the document names (0.1.1 when it names none Steward knows) */
  lint: DataSemanticFindings & { revision: OssieRevision };
  drift: DataSemanticFindings & {
    /** 0.25.0: false when the document does not parse – drift was not checked (no findings, no datasets) */
    checked: boolean;
    /** Bound contracts the reader may not see: their columns and personal fields were not used */
    hiddenContracts: number;
    /** Datasets whose columns Steward knows (a bound contract or a schema snapshot) */
    datasetsChecked: number;
  };
}

/** GET /api/data-products/:id/semantic-model */
export interface DataSemanticModelView {
  productId: string;
  /** The newest version */
  current: DataSemanticVersionSummary | null;
  /** The version valid today: the newest sign-off whose day has come */
  validToday: DataSemanticVersionSummary | null;
  /** Newest first */
  versions: DataSemanticVersionSummary[];
  mayEdit: boolean;
  maySignOff: boolean;
}

/** GET /api/data-products/:id/semantic-model/valid?date= – which model was valid on a date, and who approved it. */
export interface DataSemanticValidAnswer {
  date: string;
  /** The signed-off version valid on that day (with its sign-off), null when none was signed off by then */
  valid: DataSemanticVersionSummary | null;
  /** The newest version saved by the end of that day, signed off or not */
  latest: DataSemanticVersionSummary | null;
}

/** GET /api/data-products/:id/semantic-model/draft – a document to start from (not saved). */
export interface DataSemanticDraft {
  document: string;
  revision: OssieRevision;
  environment: string;
  datasets: number;
  /** Data objects whose definitions, synonyms and key attributes went into it */
  dataObjects: number;
  lint: DataSemanticFindings;
}

const isoDate = () =>
  z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'a date like 2027-03-31');

export const dataSemanticSaveInput = z
  .object({
    document: z.string().min(1).max(DATA_SEMANTIC_LIMITS.documentBytes),
    note: z.string().trim().max(DATA_SEMANTIC_LIMITS.note).default(''),
    /** A draft started from the bound contracts and data objects, saved as it was or after editing */
    origin: z.enum(['page', 'draft']).default('page'),
  })
  .strict();
export type DataSemanticSaveInput = z.input<typeof dataSemanticSaveInput>;

export const dataSemanticSignOffInput = z
  .object({
    /** The SHA-256 of the version the person read: a different one is refused */
    sha256: z
      .string()
      .trim()
      .regex(/^[0-9a-f]{64}$/),
    note: z.string().trim().max(DATA_SEMANTIC_LIMITS.note).default(''),
  })
  .strict();

export const dataSemanticDraftQuery = z.object({ environment: z.string().trim().max(60).optional(), revision: z.enum(OSSIE_REVISIONS).optional() }).strict();
export const dataSemanticValidQuery = z.object({ date: isoDate() }).strict();
export const dataSemanticExportQuery = z
  .object({
    version: z.coerce.number().int().min(1).max(100_000).optional(),
    /** The version valid on that day (signed off) */
    date: isoDate().optional(),
    /** Rewrite the datasets' sources to this environment's elements */
    environment: z.string().trim().max(60).optional(),
  })
  .strict();

// ---------- previews (ADR 0037 part 6) ----------

export interface DataExampleProperty {
  /** The property's path in its schema object (`address.city`) */
  name: string;
  logicalType: string | null;
  /** The bound contract marks it personal */
  personal: boolean;
  examples: string[];
}

export interface DataContractExamples {
  contract: { id: string; key: string; name: string };
  version: number;
  objects: { name: string; properties: DataExampleProperty[] }[];
  /** Properties with examples left out beyond the limit */
  more: number;
}

export interface DataPortRecordingPreview {
  recordingId: string;
  platform: { id: string; name: string };
  method: string;
  path: string;
  status: number;
  note: string;
  /** The recorded body, masked (sensitive keys, patterns and the bound contract's personal fields), cut at the limit */
  body: string;
  truncated: boolean;
  addedBy: string;
  addedAt: string;
}

/** GET /api/data-products/:id/ports/:portId/preview?environment= – no platform is read. */
export interface DataPortPreview {
  portId: string;
  environment: string;
  /** The examples of the bound contract (the version the binding is held to, else the current one) */
  examples: DataContractExamples | null;
  /** A contract is bound that the reader may not see */
  hiddenContract: boolean;
  recordings: DataPortRecordingPreview[];
  /** Linked recordings on platforms the reader may not use (recordings can hold personal data) */
  hiddenRecordings: number;
  /** May link and unlink recorded responses (changes the product) */
  mayLink: boolean;
}

export const dataPortRecordingInput = z
  .object({
    recordingId: z.string().trim().min(1).max(100),
    note: z.string().trim().max(500).default(''),
  })
  .strict();

export const dataElementPeekInput = z.object({ count: z.number().int().min(1).max(5).default(5) }).strict();

// ---------- GDPR Art. 30: transfers (e) and technical and organisational measures (g) ----------

/**
 * The safeguard of a transfer to a third country: an adequacy decision (Art. 45), standard contractual clauses
 * (Art. 46(2)(c)), binding corporate rules (Art. 47), a derogation (Art. 49) or another one (named in the note).
 */
export const DATA_TRANSFER_SAFEGUARDS = ['adequacy', 'scc', 'bcr', 'derogation', 'other'] as const;
export type DataTransferSafeguard = (typeof DATA_TRANSFER_SAFEGUARDS)[number];

export const DATA_ROPA_LIMITS = { transfers: 20, text: 500 } as const;

export interface DataTransfer {
  /** The third country or international organisation */
  country: string;
  /** Who receives it there (a processor, a group company) */
  recipient: string;
  safeguard: DataTransferSafeguard;
  note: string;
}

/** The reference to the technical and organisational measures: a link, or a document of Steward (records). */
export type DataTomsRef = { kind: 'url'; url: string; label: string } | { kind: 'record'; recordId: string };

/** As the reader sees it: a record they may not see is neither named nor linked. */
export type DataTomsView =
  { kind: 'url'; url: string; label: string } | { kind: 'record'; id: string; number: string; title: string } | { kind: 'record'; hidden: true };

/** GET /api/data-objects/:id/ropa-details, GET /api/data-products/:id/ropa-details */
export interface DataRopaDetails {
  transfers: DataTransfer[];
  toms: DataTomsView | null;
  mayEdit: boolean;
}

const ropaText = (max: number = DATA_ROPA_LIMITS.text) => z.string().trim().max(max);

export const dataTransferInput = z
  .object({
    country: z.string().trim().min(2).max(100),
    recipient: ropaText(200).default(''),
    safeguard: z.enum(DATA_TRANSFER_SAFEGUARDS),
    note: ropaText().default(''),
  })
  .strict();

export const dataTomsRefInput = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('url'),
      url: z
        .string()
        .trim()
        .max(2000)
        .regex(/^https?:\/\/\S+$/i, 'an http(s) address'),
      label: ropaText(200).default(''),
    })
    .strict(),
  z.object({ kind: z.literal('record'), recordId: z.string().trim().min(1).max(100) }).strict(),
]);

export const dataRopaDetailsInput = z
  .object({
    transfers: z.array(dataTransferInput).max(DATA_ROPA_LIMITS.transfers).default([]),
    /** null removes the reference; left out keeps it (a document the person may not see is not shown to send back) */
    toms: dataTomsRefInput.nullable().optional(),
  })
  .strict();
export type DataRopaDetailsInput = z.input<typeof dataRopaDetailsInput>;
