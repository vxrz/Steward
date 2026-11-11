import { z } from 'zod';
import { isCalendarDate } from './costPlans.js';

/**
 * Corrective actions (ISO/IEC 27001 clause 10.2, ADR 0029 part 3, docs/COMPLIANCE.md#corrective-actions): one register
 * of nonconformities and observations – from audits, entered by hand, and from what Steward itself notices, suggested
 * and confirmed by a person – with actions, owners, due dates and reminders, and an effectiveness check by a second
 * person (control point `correctiveAction.verify`). Part of the Compliance module, preview.
 *
 * - A finding (CA-2026-0001) has a source, affected controls and a service, a severity, an owner, a due date, a cause,
 *   a GRC reference and a status: open → inProgress → implemented → closed (effective), or cancelled (administrators).
 * - Its actions have owners and a due date and are reminded like incident review measures. A finding of an incident
 *   review reads the review's measures as its actions (they stay in the review, ADR 0029 decision 5).
 * - Suggestions come from sources (a registry on the server, compliance/corrective-sources.ts) with a unique source
 *   key, so the same event is suggested once; a person confirms or dismisses each one.
 */

/** Where a finding comes from. supplierReview: added with the suppliers (ADR 0029 part 1). */
export const CA_SOURCES = ['internalAudit', 'externalAudit', 'duty', 'accessReview', 'reconciliation', 'incidentReview', 'supplierReview', 'other'] as const;
export type CaSource = (typeof CA_SOURCES)[number];
/**
 * The sources a person records by hand; the others come from confirmed suggestions. supplierReview: a finding of a
 * supplier review, recorded from the supplier's page (or the register) with the supplier.
 */
export const CA_MANUAL_SOURCES = ['internalAudit', 'externalAudit', 'supplierReview', 'other'] as const satisfies readonly CaSource[];

/** major and minor: nonconformities; observation: an opportunity for improvement. */
export const CA_SEVERITIES = ['major', 'minor', 'observation'] as const;
export type CaSeverity = (typeof CA_SEVERITIES)[number];

export const CA_STATUSES = ['open', 'inProgress', 'implemented', 'closed', 'cancelled'] as const;
export type CaStatus = (typeof CA_STATUSES)[number];
/** The statuses a finding's editors set themselves; closed comes from the effectiveness check, cancelled from an administrator. */
export const CA_EDITABLE_STATUSES = ['open', 'inProgress', 'implemented'] as const satisfies readonly CaStatus[];
export const CA_OPEN_STATUSES: readonly CaStatus[] = ['open', 'inProgress', 'implemented'];

export const CA_EFFECTIVENESS_RESULTS = ['effective', 'notEffective'] as const;
export type CaEffectivenessResult = (typeof CA_EFFECTIVENESS_RESULTS)[number];

export const CA_SUGGESTION_STATUSES = ['pending', 'confirmed', 'dismissed'] as const;
export type CaSuggestionStatus = (typeof CA_SUGGESTION_STATUSES)[number];

/**
 * The switches of the suggestion sources (tab Settings, administrators) and their defaults (ADR 0029 decision 6): few,
 * clear signals first. supplierReview: an expired certificate of a confirmed supplier that is in use, and a missed or
 * failed period of a duty that reviews a supplier (on by default).
 */
export const CA_SOURCE_SWITCHES = [
  'dutyMandatory',
  'dutyRecommended',
  'incidentMajor',
  'incidentMinor',
  'personReview',
  'reconciliation',
  'supplierReview',
] as const;
export type CaSourceSwitch = (typeof CA_SOURCE_SWITCHES)[number];
export const CA_SOURCE_DEFAULTS: Record<CaSourceSwitch, boolean> = {
  dutyMandatory: true,
  dutyRecommended: false,
  incidentMajor: true,
  incidentMinor: false,
  personReview: true,
  reconciliation: false,
  supplierReview: true,
};

export const CA_LIMITS = {
  findings: 20_000,
  actionsPerFinding: 50,
  /** Pending suggestions at most; further ones wait until some are decided (the page says so) */
  pendingSuggestions: 1000,
  title: 200,
  description: 10_000,
  cause: 4000,
  note: 2000,
  method: 1000,
  reason: 2000,
  grcRef: 200,
  url: 2000,
  sourceLabel: 200,
  controls: 50,
  owners: 10,
  /** Events older than this are not suggested (a source switched on later does not bring the whole history) */
  lookbackDays: 90,
  /** A person review's removals still there this many days after its approval */
  personReviewDays: 30,
  /** Reconciliation findings still open after this many days (one suggestion per check and week) */
  reconciliationDays: 7,
  /** A reminder this many days before an action's due date (and on it, then once a week while overdue) */
  reminderDays: 3,
} as const;

/** The built-in dataset of the register (administrators and auditors, like costs.plans). */
export const CORRECTIVE_DATASET = 'compliance.correctiveActions';

// ---------- inputs ----------

const day = z.string().refine(isCalendarDate, 'a date YYYY-MM-DD').describe('YYYY-MM-DD');
const subject = z
  .string()
  .trim()
  .regex(/^(user|team):[^\s:].{0,119}$/i, 'user:<name> or team:<name>')
  .transform((s) => s.toLowerCase());
const httpUrl = z
  .string()
  .trim()
  .max(CA_LIMITS.url)
  .refine((v) => v === '' || /^https?:\/\/\S+$/i.test(v), 'an http(s) address');
const ids = z
  .array(z.string().min(1).max(100))
  .max(CA_LIMITS.controls)
  .transform((v) => [...new Set(v)]);

const findingFields = {
  title: z.string().trim().min(1).max(CA_LIMITS.title),
  description: z.string().max(CA_LIMITS.description),
  severity: z.enum(CA_SEVERITIES),
  serviceId: z.string().min(1).max(100).nullable(),
  /** The supplier the finding is about (one the person may see) */
  supplierId: z.string().min(1).max(100).nullable(),
  /** A contract of that supplier (0.18.0, ADR 0031): its owners read the finding */
  supplierContractId: z.string().min(1).max(100).nullable(),
  controlIds: ids,
  /** A Steward user name */
  owner: z.string().trim().min(1).max(128).nullable(),
  dueDate: day.nullable(),
  cause: z.string().max(CA_LIMITS.cause),
  grcRef: z.string().trim().max(CA_LIMITS.grcRef),
  grcUrl: httpUrl,
};

/** POST /api/compliance/corrective-actions: a finding entered by hand (an audit or another source outside Steward). */
export const caFindingInput = z
  .object({
    ...findingFields,
    description: findingFields.description.default(''),
    severity: findingFields.severity.default('minor'),
    serviceId: findingFields.serviceId.default(null),
    supplierId: findingFields.supplierId.default(null),
    supplierContractId: findingFields.supplierContractId.default(null),
    controlIds: ids.default([]),
    owner: findingFields.owner.default(null),
    dueDate: findingFields.dueDate.default(null),
    cause: findingFields.cause.default(''),
    grcRef: findingFields.grcRef.default(''),
    grcUrl: httpUrl.default(''),
    source: z.enum(CA_MANUAL_SOURCES),
    /** What it came from: e.g. "External audit 2026, finding 4" and a link to the report */
    sourceLabel: z.string().trim().max(CA_LIMITS.sourceLabel).default(''),
    sourceUrl: httpUrl.default(''),
  })
  .strict();
export type CaFindingInput = z.input<typeof caFindingInput>;

/** PUT /api/compliance/corrective-actions/:id: the fields to change, and the status among open, in progress, implemented. */
export const caFindingUpdate = z
  .object({ ...findingFields, status: z.enum(CA_EDITABLE_STATUSES) })
  .partial()
  .strict();
export type CaFindingUpdate = z.input<typeof caFindingUpdate>;

export const caActionInput = z
  .object({
    title: z.string().trim().min(1).max(CA_LIMITS.title),
    owners: z.array(subject).min(1).max(CA_LIMITS.owners),
    dueDate: day,
    note: z.string().max(CA_LIMITS.note).default(''),
    done: z.boolean().optional(),
  })
  .strict();
export type CaActionInput = z.input<typeof caActionInput>;
export const caActionUpdate = caActionInput.partial().strict();

export const caEffectivenessInput = z
  .object({
    /** How the fix was checked: a sample, a re-run, an interview … */
    method: z.string().trim().min(1).max(CA_LIMITS.method),
    result: z.enum(CA_EFFECTIVENESS_RESULTS),
    note: z.string().max(CA_LIMITS.note).default(''),
  })
  .strict();

export const caReasonInput = z.object({ reason: z.string().trim().min(1).max(CA_LIMITS.reason) }).strict();

/** Confirming a suggestion: what the person changes in the pre-filled finding. */
export const caConfirmInput = z.object(findingFields).partial().strict();

export const caSettingsInput = z
  .object({
    sources: z
      .object(Object.fromEntries(CA_SOURCE_SWITCHES.map((k) => [k, z.boolean()])) as Record<CaSourceSwitch, z.ZodBoolean>)
      .partial()
      .strict(),
  })
  .strict();

// ---------- what the API returns ----------

/** What a finding or suggestion came from, as the reader may see it. */
export interface CaSourceRef {
  /** duty, record, personReview, accessCheck, url */
  kind: string;
  id: string | null;
  label: string;
  /** In-app path or http(s) address; null when the reader may not see it */
  path: string | null;
  visible: boolean;
}

export interface CaControlRef {
  id: string;
  ref: string;
  catalogueKey: string;
  title: string;
}

export interface CaAction {
  id: string;
  title: string;
  owners: string[];
  dueDate: string;
  note: string;
  doneAt: string | null;
  doneBy: string | null;
  overdue: boolean;
  /** A measure of the finding's incident review (read through, kept in the review) */
  measure: boolean;
  createdAt: string;
  createdBy: string;
  /** May change or remove it (the finding's editors; for a measure the review's editors) */
  canEdit: boolean;
  /** May mark it done (its owners and the editors) */
  canMarkDone: boolean;
}

export interface CaEffectiveness {
  method: string;
  result: CaEffectivenessResult;
  note: string;
  checkedBy: string;
  checkedAt: string;
}

export interface CaFindingSummary {
  id: string;
  number: string;
  title: string;
  source: CaSource;
  severity: CaSeverity;
  status: CaStatus;
  serviceId: string | null;
  /** null when the reader may not see the service */
  serviceName: string | null;
  supplierId: string | null;
  /** null when the reader may not see the supplier */
  supplierName: string | null;
  /** The contract it names (0.18.0, ADR 0031); null with `supplierContractHidden`: a contract the reader may not see */
  supplierContract: { id: string; title: string } | null;
  supplierContractHidden: boolean;
  owner: string | null;
  dueDate: string | null;
  /** Not closed or cancelled, and past its due date or with an action past its due date */
  overdue: boolean;
  actionsOpen: number;
  actionsTotal: number;
  controls: CaControlRef[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface CaFinding extends CaFindingSummary {
  description: string;
  cause: string;
  sourceRef: CaSourceRef | null;
  /** The incident review whose measures are the actions (source incident review) */
  record: { id: string; number: string; title: string; visible: boolean } | null;
  grcRef: string;
  grcUrl: string;
  effectiveness: CaEffectiveness | null;
  cancelReason: string;
  suggestionId: string | null;
  /** The owners of the contract it names, when the reader may see it (0.18.0): proposed as owners of the first action */
  supplierContractOwners: string[];
  actions: CaAction[];
  createdBy: string;
  updatedBy: string;
  closedBy: string | null;
  permissions: {
    edit: boolean;
    addActions: boolean;
    cancel: boolean;
    /** May check the effectiveness now (status implemented, a role that checks, a second person) */
    verify: boolean;
    /** Why not, for a checker: notImplemented, ownPart (the finding's or an action's owner, or who marked one done) */
    verifyBlocked: 'notImplemented' | 'ownPart' | null;
    /** A second person must check (correctiveAction.verify) */
    fourEyes: boolean;
  };
}

export interface CaFindingList {
  items: CaFindingSummary[];
  /** May record findings (designers, administrators, editors of a service) */
  canCreate: boolean;
  /** Pending suggestions the reader may see */
  pendingSuggestions: number;
  /** Administrators: suggestion sources, cancelling */
  canManage: boolean;
}

export interface CaSuggestion {
  id: string;
  source: CaSource;
  sourceKey: string;
  sourceRef: CaSourceRef | null;
  serviceId: string | null;
  serviceName: string | null;
  /** The supplier a supplier-review suggestion is about (the finding takes it); null when not visible */
  supplierId: string | null;
  supplierName: string | null;
  controls: CaControlRef[];
  /** English; the web app translates `details.kind` with its params */
  title: string;
  details: Record<string, string | number> & { kind: string };
  severity: CaSeverity;
  recordId: string | null;
  occurredAt: string;
  status: CaSuggestionStatus;
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  reason: string;
  findingId: string | null;
  findingNumber: string | null;
  canDecide: boolean;
}

export interface CaSuggestionList {
  items: CaSuggestion[];
  pending: number;
  limit: number;
  /** The pending suggestions reached the limit: further ones wait */
  atLimit: boolean;
}

export interface CaSettings {
  sources: Record<CaSourceSwitch, boolean>;
  updatedAt: string | null;
  updatedBy: string | null;
  canEdit: boolean;
}
