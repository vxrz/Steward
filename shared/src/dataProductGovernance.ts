import { z } from 'zod';
import {
  DATA_AGREEMENT_KINDS,
  DATA_CONSUMER_KINDS,
  DATA_PRODUCT_LIMITS as L,
  type DataAgreement,
  type DataClassification,
  type DataConsumerKind,
  type DataElementKind,
  type DataEnvironmentRule,
  type DataMemberRole,
  type DataProductLifecycle,
  type DataRef,
  type LegalBasis,
  type PersonalDataLevel,
} from './dataProducts.js';

/**
 * Consumers, access and governance of data products (0.24.0, ADR 0036 phase 2, docs/DATA-PRODUCTS.md): declared
 * against actual consumers (Snowflake ACCESS_HISTORY, Kafka consumer groups), access requests and port access reviews,
 * promotion between environments, endorsement (maturity level 5) and the GDPR Art. 30 view. Types, limits, input
 * schemas and the pure functions the server and the web app share.
 */

export const DATA_GOVERNANCE_LIMITS = {
  /** ACCESS_HISTORY is read for this many days (the reads of a port's objects) */
  actualWindowDays: 30,
  /** Actual consumers kept per port, environment and platform (the most active first) */
  actualPerPlatform: 500,
  /** Objects named per actual consumer */
  actualObjects: 20,
  /** Bound objects one read asks about (a bundle's topics count one by one) */
  objectsPerRead: 200,
  /** A port is read again by the job when its last read is older than this */
  actualRefreshHours: 24,
  /** Platform identities named on one registration */
  identitiesPerConsumer: 20,
  /** Open requests per port */
  pendingPerPort: 100,
  /** A page of the request list */
  requestPage: 100,
  /** Items of one port access review */
  reviewItems: 2_000,
  /** An endorsement is valid this long unless a review date is set */
  endorsementMonths: 12,
  /** The reminder `dataproduct.endorsement_review` is sent this many days before the review date */
  endorsementWarnDays: 30,
  /** Elements one promotion carries (members and bindings together) */
  promotionElements: 5_000,
  /** Promotions listed per product (the newest) */
  promotionsListed: 50,
  /** Art. 30 view: data objects with personal data in one answer */
  ropaObjects: 5_000,
  comment: 2_000,
  identity: 255,
} as const;

export const DATA_GOVERNANCE_ID_PREFIX = { request: 'dpx_', review: 'dpv_', reviewItem: 'dpw_', promotion: 'dpt_' } as const;

// ---------- declared against actual consumers ----------

/** Who really reads: a Snowflake user or role (ACCESS_HISTORY), a Kafka consumer group (committed offsets). */
export const DATA_ACTUAL_KINDS = ['user', 'role', 'group'] as const;
export type DataActualKind = (typeof DATA_ACTUAL_KINDS)[number];

/**
 * A platform identity a registration names, so Steward can match who really reads: `user:<Snowflake user>`,
 * `role:<Snowflake role>`, `group:<Kafka consumer group>` (compared without case).
 */
export const DATA_IDENTITY_RE = /^(user|role|group):[^\s:][^\n\r]{0,254}$/;

/** How a read of a platform went: ok; notAvailable – the edition or the role cannot read ACCESS_HISTORY; failed; noObjects – nothing to ask about. */
export const DATA_ACTUAL_READ_STATUSES = ['ok', 'notAvailable', 'failed', 'noObjects'] as const;
export type DataActualReadStatus = (typeof DATA_ACTUAL_READ_STATUSES)[number];

export interface DataActualRead {
  platformId: string | null;
  /** null: a platform the reader may not see (its consumers are counted in hiddenActual) */
  platformName: string | null;
  platformKind: string | null;
  status: DataActualReadStatus;
  /** Why it failed or was not available (in English from the platform; the web app has its own words per status) */
  message: string;
  windowDays: number;
  /** Bound objects asked about */
  objects: number;
  readAt: string;
  readBy: string;
}

export interface DataActualConsumer {
  platformId: string;
  platformName: string;
  kind: DataActualKind;
  name: string;
  /** The port's objects it read (Snowflake) or committed offsets on (Kafka) */
  objects: string[];
  /** Reads in the window (Snowflake: queries); null for Kafka */
  reads: number | null;
  /** Snowflake: the last read; Kafka: when Steward saw the committed offsets */
  lastSeen: string | null;
  /** Kafka: the group's state (Stable, Empty …) */
  detail: string;
  /** The registrations it was matched to (consumer ids) – empty: _not registered_ */
  registeredAs: string[];
}

/** A registration and whether it was seen reading. */
export type DataDeclaredState = 'seen' | 'silent' | 'unknown';

export interface DataDeclaredConsumer {
  consumerId: string;
  kind: DataConsumerKind;
  /** The name as the reader may see it (null: hidden) */
  label: string | null;
  subject: string | null;
  purpose: string;
  endDate: string | null;
  /** Platform identities named on the registration (user:, role:, group:) */
  identities: string[];
  /** seen: an identity read in the window; silent: identities known but nothing read (_registered but silent_); unknown: nothing to match on, or no read */
  state: DataDeclaredState;
  /** The actual consumers it was matched to (`kind:name`) */
  seenAs: string[];
}

/** GET /api/data-products/:id/ports/:portId/actual?environment= */
export interface DataActualView {
  portId: string;
  environment: string;
  windowDays: number;
  reads: DataActualRead[];
  actual: DataActualConsumer[];
  /** Actual consumers on platforms the reader may not see (counted, never named) */
  hiddenActual: number;
  declared: DataDeclaredConsumer[];
  counts: { seen: number; silent: number; unknown: number; notRegistered: number };
  /** Whether the reader may read now (who may change the product and use a bound platform) */
  canRead: boolean;
}

export const dataConsumerIdentitiesInput = z
  .object({
    identities: z
      .array(z.string().trim().max(DATA_GOVERNANCE_LIMITS.identity).regex(DATA_IDENTITY_RE, 'user:<name>, role:<name> or group:<name>'))
      .max(DATA_GOVERNANCE_LIMITS.identitiesPerConsumer),
  })
  .strict();

export const dataActualReadInput = z.object({ environment: z.string().trim().min(1).max(60) }).strict();

const norm = (s: string) => s.trim().toLowerCase();
export const identityOf = (kind: DataActualKind, name: string): string => `${kind}:${name}`;

/**
 * Declared against actual (pure): registrations are matched to actual consumers by the identities they name, and a
 * registered user by their user name or e-mail address as a Snowflake user. A registration is _seen_ when one of them
 * read, _silent_ when it has something to match on and the read succeeded without it, _unknown_ otherwise; an actual
 * consumer no registration matches is _not registered_.
 */
export function matchConsumers(
  declared: readonly { consumerId: string; identities: readonly string[]; userNames: readonly string[] }[],
  actual: readonly { kind: DataActualKind; name: string }[],
  readOk: boolean,
): { declared: Map<string, { state: DataDeclaredState; seenAs: string[] }>; actual: Map<string, string[]> } {
  const byIdentity = new Map<string, string[]>();
  for (const d of declared) {
    const keys = new Set([...d.identities.map(norm), ...d.userNames.map((u) => `user:${norm(u)}`)]);
    for (const k of keys) byIdentity.set(k, [...(byIdentity.get(k) ?? []), d.consumerId]);
  }
  const actualOut = new Map<string, string[]>();
  const seen = new Map<string, string[]>();
  for (const a of actual) {
    const key = identityOf(a.kind, a.name);
    const ids = [...new Set(byIdentity.get(norm(key)) ?? [])];
    actualOut.set(key, ids);
    for (const id of ids) seen.set(id, [...(seen.get(id) ?? []), key]);
  }
  const declaredOut = new Map<string, { state: DataDeclaredState; seenAs: string[] }>();
  for (const d of declared) {
    const s = seen.get(d.consumerId) ?? [];
    const matchable = d.identities.length > 0 || d.userNames.length > 0;
    declaredOut.set(d.consumerId, { state: s.length ? 'seen' : readOk && matchable ? 'silent' : 'unknown', seenAs: s });
  }
  return { declared: declaredOut, actual: actualOut };
}

// ---------- access requests ----------

export const DATA_ACCESS_REQUEST_STATUSES = ['pending', 'approved', 'refused', 'withdrawn'] as const;
export type DataAccessRequestStatus = (typeof DATA_ACCESS_REQUEST_STATUSES)[number];

const isoDate = () =>
  z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'a date like 2027-03-31');
const identities = () =>
  z
    .array(z.string().trim().max(DATA_GOVERNANCE_LIMITS.identity).regex(DATA_IDENTITY_RE, 'user:<name>, role:<name> or group:<name>'))
    .max(DATA_GOVERNANCE_LIMITS.identitiesPerConsumer);

export const dataAccessRequestInput = z
  .object({
    environment: z.string().trim().min(1).max(60),
    consumer: z
      .object({
        kind: z.enum(DATA_CONSUMER_KINDS),
        refId: z.string().trim().min(1).max(100).nullable().default(null),
        subject: z
          .string()
          .trim()
          .max(L.short)
          .regex(/^(user|team):.+$/, 'user:<name> or team:<name>')
          .nullable()
          .default(null),
        text: z.string().trim().max(L.short).default(''),
      })
      .strict(),
    purpose: z.string().trim().min(1).max(L.text),
    until: isoDate().nullable().default(null),
    agreement: z
      .object({ kind: z.enum(DATA_AGREEMENT_KINDS), ref: z.string().trim().min(1).max(L.url), label: z.string().trim().max(L.short).default('') })
      .strict()
      .nullable()
      .default(null),
    identities: identities().default([]),
  })
  .strict();
export type DataAccessRequestInput = z.input<typeof dataAccessRequestInput>;

export const dataAccessDecisionInput = z
  .object({
    decision: z.enum(['approve', 'refuse']),
    comment: z.string().trim().max(DATA_GOVERNANCE_LIMITS.comment).default(''),
    /** The ticket of the grant on the platform (a ticket reference is made where the product names a ticket source) */
    ticket: z
      .object({
        externalNumber: z.string().trim().min(1).max(100),
        externalUrl: z
          .string()
          .trim()
          .max(L.url)
          .regex(/^https?:\/\/\S+$/i, 'an http(s) address')
          .or(z.literal(''))
          .default(''),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();
export type DataAccessDecisionInput = z.input<typeof dataAccessDecisionInput>;

/** What happens after an approval, per product: a run of a process the platform team owns, a ticket reference, the review interval. */
export const dataAccessSettingsInput = z
  .object({
    processId: z.string().trim().min(1).max(100).nullable().default(null),
    ticketSource: z.string().trim().min(1).max(60).nullable().default(null),
    reviewMonths: z.number().int().min(1).max(24).nullable().default(null),
  })
  .strict();
export type DataAccessSettingsInput = z.input<typeof dataAccessSettingsInput>;

export interface DataAccessSettings {
  productId: string;
  /** The process started (live, as the approver) after the last approval; null: none */
  process: { id: string; name: string | null } | null;
  ticketSource: string | null;
  /** Port access reviews are due this many months after the last approved one (null: no periodic review) */
  reviewMonths: number | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface DataAccessApproval {
  by: string;
  at: string;
  comment: string;
}

export interface DataAccessRequest {
  id: string;
  product: DataRef;
  portId: string;
  portName: string;
  portVersion: string;
  environment: string;
  requester: string;
  consumer: { kind: DataConsumerKind; refId: string | null; subject: string | null; text: string; label: string | null };
  purpose: string;
  until: string | null;
  agreement: DataAgreement | null;
  identities: string[];
  status: DataAccessRequestStatus;
  /** Two people approve (the product's rating is high or above in a dimension) */
  fourEyes: boolean;
  approvals: DataAccessApproval[];
  decidedBy: string | null;
  decidedAt: string | null;
  decisionComment: string;
  /** The registration an approval made */
  consumerId: string | null;
  ticketId: string | null;
  runId: string | null;
  createdAt: string;
  updatedAt: string;
  mayDecide: boolean;
  mayWithdraw: boolean;
}

/** A product's rating is "high or above" in a dimension: one of the top two levels of a scale of three or more (the top one of a shorter scale). */
export function highOrAbove(levelKeys: readonly string[], level: string | null | undefined): boolean {
  if (!level) return false;
  const i = levelKeys.indexOf(level);
  if (i < 0) return false;
  return levelKeys.length >= 3 ? i >= levelKeys.length - 2 : i === levelKeys.length - 1;
}

// ---------- port access reviews ----------

export const DATA_PORT_REVIEW_STATUSES = ['open', 'submitted', 'approved'] as const;
export type DataPortReviewStatus = (typeof DATA_PORT_REVIEW_STATUSES)[number];
export const DATA_PORT_REVIEW_ITEM_KINDS = ['registered', 'actual', 'grant'] as const;
export type DataPortReviewItemKind = (typeof DATA_PORT_REVIEW_ITEM_KINDS)[number];
export const DATA_PORT_REVIEW_DECISIONS = ['keep', 'remove'] as const;

export const dataPortReviewInput = z
  .object({
    environment: z.string().trim().min(1).max(60),
    /** An access check (access reconciliation) whose grants are reviewed beside the consumers – read now as its owner */
    checkId: z.string().trim().min(1).max(100).nullable().default(null),
    fourEyes: z.boolean().default(true),
  })
  .strict();

export const dataPortReviewDecisionsInput = z
  .object({
    decisions: z
      .array(
        z
          .object({
            itemId: z.string().min(1).max(100),
            decision: z.enum(DATA_PORT_REVIEW_DECISIONS).nullable(),
            comment: z.string().trim().max(DATA_GOVERNANCE_LIMITS.comment).default(''),
          })
          .strict(),
      )
      .min(1)
      .max(DATA_GOVERNANCE_LIMITS.reviewItems),
  })
  .strict();

export const dataPortReviewApprovalInput = z
  .object({ approve: z.boolean(), comment: z.string().trim().max(DATA_GOVERNANCE_LIMITS.comment).default('') })
  .strict();

export interface DataPortReviewItem {
  id: string;
  seq: number;
  kind: DataPortReviewItemKind;
  /** A registered consumer: its id (removing it ends the registration when the review is approved) */
  consumerId: string | null;
  label: string;
  /** What was found: seen, silent, unknown (registrations); notRegistered (actual); the rights (grants) */
  finding: string;
  detail: string;
  decision: 'keep' | 'remove' | null;
  comment: string;
  decidedBy: string | null;
  decidedAt: string | null;
}

export interface DataPortReviewSummary {
  id: string;
  productId: string;
  portId: string;
  portName: string;
  environment: string;
  status: DataPortReviewStatus;
  fourEyes: boolean;
  items: number;
  removals: number;
  createdBy: string;
  createdAt: string;
  approvedAt: string | null;
}

export interface DataPortReview extends DataPortReviewSummary {
  submittedBy: string | null;
  submittedAt: string | null;
  approvedBy: string | null;
  approvalComment: string;
  sealHash: string | null;
  /** The access check read for grants, if any */
  check: { id: string; name: string; origin: 'live' | 'snapshot'; takenAt: string | null; error: string | null } | null;
  entries: DataPortReviewItem[];
  mayDecide: boolean;
  mayApprove: boolean;
}

/** When a port's next access review is due (the product's review interval after the last approved review). */
export interface DataPortReviewDue {
  portId: string;
  portName: string;
  environment: string;
  lastApprovedAt: string | null;
  dueDate: string;
  overdue: boolean;
}

// ---------- promotion between environments ----------

export const DATA_PROMOTION_EVIDENCE_KINDS = ['record', 'ticket', 'run', 'url', 'text'] as const;
export type DataPromotionEvidenceKind = (typeof DATA_PROMOTION_EVIDENCE_KINDS)[number];

export const dataPromotionInput = z
  .object({
    from: z.string().trim().min(1).max(60),
    to: z.string().trim().min(1).max(60),
    /** The change record, ticket or process run that is the evidence of the promotion (Steward deploys nothing) */
    evidence: z
      .object({ kind: z.enum(DATA_PROMOTION_EVIDENCE_KINDS), ref: z.string().trim().min(1).max(L.url) })
      .strict()
      .nullable()
      .default(null),
    note: z.string().trim().max(DATA_GOVERNANCE_LIMITS.comment).default(''),
    /** The preview's fingerprint: the promotion is refused when what it would do changed since */
    fingerprint: z.string().trim().max(100).nullable().default(null),
  })
  .strict();
export type DataPromotionInput = z.input<typeof dataPromotionInput>;

export type DataPromotionState = 'found' | 'missing' | 'already';

export interface DataPromotionElement {
  sourceId: string;
  sourceName: string;
  kind: DataElementKind;
  /** The names looked for in the target environment (the name rules first, then the same name) */
  candidates: string[];
  targetId: string | null;
  targetName: string | null;
  state: DataPromotionState;
}

export interface DataPromotionPreview {
  productId: string;
  from: string;
  to: string;
  /** The environment rules of the discovery sources of the platforms involved */
  rules: DataEnvironmentRule[];
  members: (DataPromotionElement & { role: DataMemberRole })[];
  bindings: {
    portId: string;
    portName: string;
    version: string;
    contract: DataRef | null;
    contractVersion: number | null;
    /** The port has a binding in the target environment already (promotion adds to it) */
    targetBound: boolean;
    elements: DataPromotionElement[];
  }[];
  counts: { found: number; missing: number; already: number };
  /** Source elements the reader may not see (left out, counted) */
  hidden: number;
  fingerprint: string;
}

export interface DataPromotion {
  id: string;
  productId: string;
  from: string;
  to: string;
  members: number;
  bindings: number;
  missing: number;
  evidence: { kind: DataPromotionEvidenceKind; ref: string } | null;
  note: string;
  createdBy: string;
  createdAt: string;
}

const RULE_ROOT_KINDS = new Set(['kafka.topic', 'kafka.topicBundle']);

/** The part of a qualified name the environment rules look at: the Snowflake database or SQL schema, the whole topic. */
export const ruleRootOf = (qualifiedName: string, kind: string): string => (RULE_ROOT_KINDS.has(kind) ? qualifiedName : (qualifiedName.split('.')[0] ?? ''));

/**
 * The names an element of `from` has in `to` by the environment rules (pure, ADR 0036 part 4): the rule of `from` that
 * matches the root (a prefix or suffix, without case) is taken off, then – unless a rule of `to` already matches –
 * the first rule of `to` is put on; the same name follows as the second candidate (platforms per environment).
 * `DEV_DB.SALES.ORDERS` → `PROD_DB.SALES.ORDERS`, `SHOP_DEV.RAW.X` → `SHOP.RAW.X`.
 */
export function promotedNames(qualifiedName: string, kind: string, from: string, to: string, rules: readonly DataEnvironmentRule[]): string[] {
  const root = ruleRootOf(qualifiedName, kind);
  const rest = qualifiedName.slice(root.length);
  const low = root.toLowerCase();
  const fromRule = rules.find((r) => r.environment === from && r.value.trim() && (r.match === 'prefix' ? low.startsWith(norm(r.value)) : low.endsWith(norm(r.value))));
  let base = root;
  if (fromRule) {
    const v = fromRule.value.trim();
    base = fromRule.match === 'prefix' ? root.slice(v.length) : root.slice(0, root.length - v.length);
  }
  const toRules = rules.filter((r) => r.environment === to && r.value.trim());
  const lowBase = base.toLowerCase();
  let target = base;
  if (toRules.length && !toRules.some((r) => (r.match === 'prefix' ? lowBase.startsWith(norm(r.value)) : lowBase.endsWith(norm(r.value))))) {
    const r = toRules[0]!;
    // keep the case of the name: an upper-case name gets an upper-case affix
    const v = root === root.toUpperCase() ? r.value.trim().toUpperCase() : r.value.trim();
    target = r.match === 'prefix' ? `${v}${base}` : `${base}${v}`;
  }
  const out = [`${target}${rest}`];
  if (!out.includes(qualifiedName) && target) out.push(qualifiedName);
  return [...new Set(out.filter((x) => x && !x.startsWith('.')))];
}

// ---------- endorsement ----------

export const dataEndorsementInput = z
  .object({
    /** The review date (at most 12 months ahead; default 12 months) */
    reviewDate: isoDate().nullable().default(null),
    note: z.string().trim().max(DATA_GOVERNANCE_LIMITS.comment).default(''),
  })
  .strict();
export type DataEndorsementInput = z.input<typeof dataEndorsementInput>;

/** Why an endorsement needs a review: its date passed, it is near, a bound contract broke, the rating fell below the floor. */
export const DATA_ENDORSEMENT_REVIEW_REASONS = ['expired', 'reviewDue', 'breakingChange', 'belowFloor'] as const;
export type DataEndorsementReviewReason = (typeof DATA_ENDORSEMENT_REVIEW_REASONS)[number];

export interface DataEndorsement {
  productId: string;
  endorsedBy: string;
  endorsedAt: string;
  reviewDate: string;
  note: string;
  /** Counts for maturity level 5: not expired and not flagged for review */
  valid: boolean;
  review: DataEndorsementReviewReason | null;
}

/** GET /api/data-products/:id/endorsement */
export interface DataEndorsementView {
  endorsement: DataEndorsement | null;
  /** Who endorses: the owners of the product's domain (and of its parent domain); without any, the module's managers */
  endorsers: string[];
  mayEndorse: boolean;
  /** Why the reader may not: they own the product, or are no endorser */
  whyNot: 'ownProduct' | 'notEndorser' | null;
}

/** An endorsement's state on `today` (pure): flagged reasons first, then the review date. */
export function endorsementState(
  e: { reviewDate: string; flagged: DataEndorsementReviewReason | null },
  today: string,
  belowFloor: boolean,
): { valid: boolean; review: DataEndorsementReviewReason | null } {
  if (e.flagged) return { valid: false, review: e.flagged };
  if (belowFloor) return { valid: false, review: 'belowFloor' };
  if (e.reviewDate < today) return { valid: false, review: 'expired' };
  const warn = new Date(`${today}T00:00:00Z`);
  warn.setUTCDate(warn.getUTCDate() + DATA_GOVERNANCE_LIMITS.endorsementWarnDays);
  return { valid: true, review: e.reviewDate <= warn.toISOString().slice(0, 10) ? 'reviewDue' : null };
}

// ---------- GDPR Art. 30: records of processing ----------

export interface DataRopaProduct {
  product: DataRef & { id: string };
  purpose: string;
  lifecycle: DataProductLifecycle;
  /** implements: a member element implements the object; exposes: an output port declares it */
  how: ('implements' | 'exposes')[];
}

export interface DataRopaRecipient {
  /** A registered consumer (team, user, application, service, text) or a consuming product */
  kind: DataConsumerKind;
  label: string;
  /** The product whose port it consumes */
  via: string;
}

export interface DataRopaProcessor {
  /** The platform the data is stored or moved on */
  platform: string;
  supplier: string | null;
  contract: string | null;
  /** The contract's (else the supplier's) answer: processes personal data */
  personalData: boolean | null;
  /** The data processing agreement: in place, missing, not needed … (null: not recorded) */
  dpa: string | null;
}

export interface DataRopaEntry {
  object: DataRef & { id: string };
  domain: DataRef | null;
  classification: DataClassification | null;
  personalData: PersonalDataLevel;
  categories: string[];
  specialCategories: string[];
  subjects: string[];
  legalBasis: LegalBasis | null;
  legalNote: string;
  purposes: string[];
  retention: string;
  deletionRule: string;
  regulatoryFlags: string[];
  owner: string | null;
  stewards: string[];
  products: DataRopaProduct[];
  hiddenProducts: number;
  recipients: DataRopaRecipient[];
  hiddenRecipients: number;
  processors: DataRopaProcessor[];
  hiddenProcessors: number;
}

/** GET /api/data-products/records-of-processing */
export interface DataRopa {
  items: DataRopaEntry[];
  generatedAt: string;
  /** The suppliers module is on (processors name suppliers and their contracts) */
  suppliers: boolean;
}

export const dataRopaQuery = z
  .object({
    domain: z.string().trim().max(100).optional(),
    q: z.string().trim().max(200).optional(),
    personalData: z.enum(['personal', 'special']).optional(),
  })
  .strict();
