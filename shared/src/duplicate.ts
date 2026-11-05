/**
 * Duplicating things (0.4.0): one endpoint per kind (POST /api/<kind>/:id/duplicate) with the same rules everywhere.
 *
 * - Secrets are never copied (heartbeat secrets, webhook trigger secrets, platform credentials, status page links,
 *   MCP tokens): the copy gets new ones or none.
 * - The copy gets a new name and id/key (suggested: "… (copy)", "…-copy", "…-copy-2"), checked before it is saved.
 * - The copy belongs to the person creating it (their default owning teams). The original's access list and owning
 *   teams are copied only when that person may manage the original ("copy access settings").
 * - History, runs, results and the audit trail stay with the original; schedules, report schedules, maintenance
 *   windows and access checks start disabled.
 * - The copy records where it came from, and `<entity>.duplicated` is in the audit log with the original's id.
 */

export const DUPLICATE_KINDS = [
  'monitor',
  'process',
  'dashboard',
  'credential',
  'application',
  'service',
  'schedule',
  'report-schedule',
  'maintenance-window',
  'access-check',
  'status-page',
  'system',
  'asset',
  'device-profile',
  'kpi-definition',
] as const;
export type DuplicateKind = (typeof DUPLICATE_KINDS)[number];

/**
 * What can be copied along with an application (components, "runs on" systems, documents) or a service (its
 * applications, documents). Owners and owning teams are the access settings ("copy access settings"); platform
 * mappings are never copied – a platform belongs to one application.
 */
export const DUPLICATE_OPTIONS = ['components', 'systems', 'applications', 'documents'] as const;
export type DuplicateOption = (typeof DUPLICATE_OPTIONS)[number];

/** What the dialog shows before duplicating (GET /api/duplicates/:kind/:id). */
export interface DuplicateSuggestion {
  kind: DuplicateKind;
  sourceId: string;
  sourceName: string;
  /** A free name for the copy */
  name: string;
  /** A free key/id for the copy (null: the kind has no key the person chooses) */
  key: string | null;
  /** The kind has an access list or owning teams to copy */
  accessApplies: boolean;
  /** The person may manage the original, so its access settings may be copied */
  canCopyAccess: boolean;
  /** The copy starts disabled */
  startsDisabled: boolean;
  /** Options with how many things each would copy (applications and services) */
  options: { option: DuplicateOption; count: number }[];
}

/** The answer of a duplicate endpoint. */
export interface DuplicateResult {
  kind: DuplicateKind;
  id: string;
  name: string;
  key: string | null;
  /** The copy's page in the web app, and its editor (for people who may edit it) */
  path: string;
  editPath: string | null;
  /** What was left out, e.g. documents the person may not change, or services they may not see */
  skipped: { what: string; count: number }[];
  /** New secrets the copy got (monitor heartbeat checks): shown once */
  secrets?: { checkId: string; secret: string; path: string }[];
}

/** Where a copy came from (GET /api/duplicates/:kind/:id/source); the original's name only for who may see it. */
export interface CopiedFrom {
  kind: DuplicateKind;
  sourceId: string | null;
  sourceName: string | null;
  /** The original is gone or the reader may not see it */
  hidden: boolean;
  at: string;
  by: string;
}

/** A field of a monitor that becomes a template parameter ("Save as template"). */
export interface MonitorTemplateParamChoice {
  name: string;
  label?: string;
  fields: { checkId: string; field: string }[];
}
