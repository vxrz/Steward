import { z } from 'zod';
import { isCalendarDate } from './costPlans.js';

/**
 * Suppliers (0.17.0, ADR 0029 part 1, docs/SUPPLIERS.md): who runs, backs up, patches and recovers what a service team
 * uses – with contacts, contracts (term, notice period, renewal, SLA, contractual RTO and RPO) and certificates. Core
 * catalogue, not a module: applications, systems, ticket references, page watches, cost plan lines and duties link
 * them (`supplier_id`; the free-text vendor stays as a fallback).
 *
 * Dates are calendar dates (YYYY-MM-DD) in the instance's time zone, as for cost plans.
 */

export const SUPPLIER_TYPES = ['saas', 'managedPlatform', 'softwareVendor', 'serviceProvider', 'other'] as const;
export type SupplierType = (typeof SUPPLIER_TYPES)[number];

/** unconfirmed: made from a free-text vendor on upgrade, waiting under "To confirm"; archived: kept for history */
export const SUPPLIER_STATUSES = ['unconfirmed', 'active', 'archived'] as const;
export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number];

export const SUPPLIER_CONTACT_ROLES = ['accountManager', 'support', 'security', 'dataProtection', 'other'] as const;
export type SupplierContactRole = (typeof SUPPLIER_CONTACT_ROLES)[number];

/** automatic: renews by `renewalMonths` unless given notice; byAgreement: both sides agree on a renewal; fixedEnd: ends */
export const SUPPLIER_RENEWALS = ['automatic', 'byAgreement', 'fixedEnd'] as const;
export type SupplierRenewal = (typeof SUPPLIER_RENEWALS)[number];

export const SUPPLIER_CERTIFICATE_KINDS = ['iso27001', 'iso27017', 'iso27018', 'iso22301', 'soc2type1', 'soc2type2', 'c5', 'tisax', 'other'] as const;
export type SupplierCertificateKind = (typeof SUPPLIER_CERTIFICATE_KINDS)[number];

/** Whether the data processing agreement is in place (only asked when the supplier processes personal data). */
export const SUPPLIER_DPA_STATUSES = ['inPlace', 'missing'] as const;
export type SupplierDpaStatus = (typeof SUPPLIER_DPA_STATUSES)[number];

/**
 * Where a supplier is linked from (the five former free-text vendors, and duties); the Compliance module's
 * responsibility matrix, SoA rows and corrective action findings (ADR 0029).
 */
export const SUPPLIER_LINK_KINDS = ['application', 'system', 'ticket', 'watch', 'costPlanLine', 'duty', 'responsibility', 'soaEntry', 'finding'] as const;
export type SupplierLinkKind = (typeof SUPPLIER_LINK_KINDS)[number];

/** Reminders before a certificate runs out and before a notice-by date (days). */
export const SUPPLIER_REMINDER_DAYS = [90, 30] as const;
/** A certificate or notice-by date within this many days is "due soon". */
export const SUPPLIER_DUE_DAYS = 90;

export const SUPPLIER_LIMITS = {
  suppliers: 2000,
  contacts: 20,
  /** 200 since 0.18.0 (ADR 0031): a shared supplier holds several teams' contracts */
  contracts: 200,
  /** Services one contract covers, its owners and the purpose of each covered service (ADR 0031) */
  contractServices: 50,
  contractOwners: 20,
  purpose: 200,
  certificates: 20,
  aliases: 50,
  name: 160,
  description: 4000,
  url: 2000,
  text: 200,
  reference: 100,
  note: 2000,
  noticeDays: 3650,
  renewalMonths: 120,
  hours: 100000,
} as const;

// ---------- dates ----------

const DAY = 86_400_000;
const utc = (d: string) => Date.parse(`${d}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** A calendar date plus n days. */
export function addDays(date: string, n: number): string {
  return iso(utc(date) + n * DAY);
}

/** A calendar date plus n months (the last day of a shorter month: 31 January + 1 month = 28/29 February). */
export function addMonths(date: string, n: number): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7)) - 1 + n;
  const d = Number(date.slice(8, 10));
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  return iso(Date.UTC(yy, mm, Math.min(d, last)));
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((utc(to) - utc(from)) / DAY);
}

/**
 * The end of a contract's current term and its notice-by date, as of `today`. An automatically renewing contract
 * whose end has passed runs on by its renewal months (term by term); the others end on their end date. The notice-by
 * date is the term's end minus the notice period – the last day to give notice. Without an end date: neither.
 */
export function contractDates(
  c: { endsOn: string | null; noticeDays: number | null; renewal: SupplierRenewal; renewalMonths: number | null },
  today: string,
): { termEnd: string | null; noticeBy: string | null } {
  if (!c.endsOn) return { termEnd: null, noticeBy: null };
  let end = c.endsOn;
  const step = c.renewal === 'automatic' && c.renewalMonths && c.renewalMonths > 0 ? c.renewalMonths : 0;
  // the term whose notice-by date is still ahead (at most 1,200 terms: a monthly contract over a century)
  for (let i = 0; step && i < 1200; i++) {
    const by = addDays(end, -(c.noticeDays ?? 0));
    if (by >= today) break;
    end = addMonths(end, step);
  }
  return { termEnd: end, noticeBy: c.noticeDays === null ? null : addDays(end, -c.noticeDays) };
}

/** Valid until of a SOC 2 report when none is given: the end of its period (issued) plus twelve months. */
export const soc2ValidUntil = (periodEnd: string): string => addMonths(periodEnd, 12);
export const isSoc2 = (k: SupplierCertificateKind): boolean => k === 'soc2type1' || k === 'soc2type2';

/** valid, dueSoon (runs out within SUPPLIER_DUE_DAYS), expired, or unknown (no date). */
export type SupplierDateState = 'ok' | 'dueSoon' | 'past' | 'none';
export function dateState(date: string | null, today: string): SupplierDateState {
  if (!date) return 'none';
  if (date < today) return 'past';
  return daysBetween(today, date) <= SUPPLIER_DUE_DAYS ? 'dueSoon' : 'ok';
}

// ---------- input ----------

const dateText = z
  .string()
  .trim()
  .max(10)
  .refine((s) => isCalendarDate(s), 'a date like 2026-10-01');
/** http(s) URL */
const url = z
  .string()
  .trim()
  .max(SUPPLIER_LIMITS.url)
  .refine((s) => /^https?:\/\/[^\s]+$/i.test(s), 'an http(s) URL');
/** A document: an http(s) URL or a record (its id rec_… or number, e.g. DOC-2026-0004) */
export const SUPPLIER_DOC_LINK_RE = /^(https?:\/\/\S+|rec_[A-Za-z0-9_-]{4,40}|[A-Z][A-Z0-9]{0,9}-\d{4}-\d{4,6})$/i;
const docLink = z
  .string()
  .trim()
  .max(SUPPLIER_LIMITS.url)
  .refine((s) => s === '' || SUPPLIER_DOC_LINK_RE.test(s), 'an http(s) URL or a record (id or number)')
  .default('');
const ownerSubject = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(user|team):[^\s].{0,119}$/, 'Use user:<name> or team:<name>');

export const supplierInput = z
  .object({
    name: z.string().trim().min(1).max(SUPPLIER_LIMITS.name),
    type: z.enum(SUPPLIER_TYPES).default('other'),
    description: z.string().trim().max(SUPPLIER_LIMITS.description).default(''),
    website: z.union([url, z.literal('')]).default(''),
    owners: z.array(ownerSubject).max(20).default([]),
    personalData: z.boolean().default(false),
    /** Only when personalData; missing then: "missing" */
    dpaStatus: z.enum(SUPPLIER_DPA_STATUSES).nullable().default(null),
    dpaSince: dateText.nullable().default(null),
    dpaLink: docLink,
  })
  .strict();
export type SupplierInput = z.input<typeof supplierInput>;

export const supplierContactInput = z
  .object({
    name: z.string().trim().min(1).max(SUPPLIER_LIMITS.text),
    role: z.enum(SUPPLIER_CONTACT_ROLES).default('other'),
    email: z.union([z.string().trim().max(254).email(), z.literal('')]).default(''),
    phone: z
      .string()
      .trim()
      .max(40)
      .regex(/^[+0-9 ()/.-]*$/, 'digits, spaces and + ( ) / . -')
      .default(''),
    note: z.string().trim().max(SUPPLIER_LIMITS.note).default(''),
  })
  .strict();
export type SupplierContactInput = z.input<typeof supplierContactInput>;

const hours = z.number().min(0).max(SUPPLIER_LIMITS.hours).nullable().default(null);

/** A covered service of a contract (ADR 0031): confirmed, or proposed by the 0.18 upgrade and waiting for a person. */
export const SUPPLIER_CONTRACT_SERVICE_STATUSES = ['confirmed', 'proposed'] as const;
export type SupplierContractServiceStatus = (typeof SUPPLIER_CONTRACT_SERVICE_STATUSES)[number];
/** Where a proposed covered service came from (the upgrade): plan lines, cost entries and matrix rows naming the contract. */
export const SUPPLIER_CONTRACT_PROPOSAL_SOURCES = ['costPlanLine', 'costEntry', 'responsibility', 'paymentSchedule'] as const;
export type SupplierContractProposalSource = (typeof SUPPLIER_CONTRACT_PROPOSAL_SOURCES)[number];

const purpose = z.string().trim().max(SUPPLIER_LIMITS.purpose).default('');
const contractServiceItem = z.object({ serviceId: z.string().trim().min(1).max(100), purpose }).strict();

export const supplierContractInput = z
  .object({
    title: z.string().trim().min(1).max(SUPPLIER_LIMITS.text),
    reference: z.string().trim().max(SUPPLIER_LIMITS.reference).default(''),
    startsOn: dateText.nullable().default(null),
    endsOn: dateText.nullable().default(null),
    noticeDays: z.number().int().min(0).max(SUPPLIER_LIMITS.noticeDays).nullable().default(null),
    renewal: z.enum(SUPPLIER_RENEWALS).default('fixedEnd'),
    /** automatic: renews by this many months */
    renewalMonths: z.number().int().min(1).max(SUPPLIER_LIMITS.renewalMonths).nullable().default(null),
    link: docLink,
    /** SLA: availability target in % (e.g. 99.9) */
    slaAvailability: z.number().min(0).max(100).nullable().default(null),
    slaSupportHours: z.string().trim().max(SUPPLIER_LIMITS.text).default(''),
    slaResponse: z.string().trim().max(SUPPLIER_LIMITS.note).default(''),
    /** Contractual recovery time and recovery point objectives (hours) */
    rtoHours: hours,
    rpoHours: hours,
    note: z.string().trim().max(SUPPLIER_LIMITS.note).default(''),
    /**
     * Who manages the contract and gets its notice reminders (ADR 0031): users and teams. Missing: on create the creator
     * and the creator's teams for new resources, on change the owners stay.
     */
    owners: z.array(ownerSubject).max(SUPPLIER_LIMITS.contractOwners).optional(),
    /** On create: the services it covers, each with its purpose (later: the routes of the covered services) */
    services: z.array(contractServiceItem).max(SUPPLIER_LIMITS.contractServices).optional(),
    /** A change that leaves no team among the owners opens the contract to every reader of the supplier: say so */
    confirmOpen: z.boolean().optional(),
    /** The master agreement it belongs to (one level, the same supplier); null: none. Missing: on change it stays */
    parentId: z.string().trim().min(1).max(100).nullable().optional(),
    /** Processes personal data for the services it covers: true, false, null as the master and the supplier (default) */
    personalData: z.boolean().nullable().optional(),
    /** Its own data processing agreement; null: as the master and the supplier (default) */
    dpaStatus: z.enum(SUPPLIER_DPA_STATUSES).nullable().optional(),
    dpaSince: dateText.nullable().optional(),
    dpaLink: z
      .string()
      .trim()
      .max(SUPPLIER_LIMITS.url)
      .refine((s) => s === '' || SUPPLIER_DOC_LINK_RE.test(s), 'an http(s) URL or a record (id or number)')
      .nullable()
      .optional(),
  })
  .strict()
  .superRefine((x, ctx) => {
    if (x.startsOn && x.endsOn && x.endsOn < x.startsOn) ctx.addIssue({ code: 'custom', path: ['endsOn'], message: 'the end is before the start' });
    if (x.renewal === 'automatic' && !x.renewalMonths) ctx.addIssue({ code: 'custom', path: ['renewalMonths'], message: 'the months it renews by' });
  });
export type SupplierContractInput = z.input<typeof supplierContractInput>;

export const supplierCertificateInput = z
  .object({
    kind: z.enum(SUPPLIER_CERTIFICATE_KINDS),
    /** For kind other: what it is */
    name: z.string().trim().max(SUPPLIER_LIMITS.text).default(''),
    scope: z.string().trim().max(SUPPLIER_LIMITS.note).default(''),
    issuer: z.string().trim().max(SUPPLIER_LIMITS.text).default(''),
    /** Issued on; a SOC 2 report: the end of its period */
    issuedOn: dateText.nullable().default(null),
    /** Missing for a SOC 2 report: the end of its period plus twelve months */
    validUntil: dateText.nullable().default(null),
    link: docLink,
    /** Whoever changes it says they looked at it now */
    checked: z.boolean().default(false),
  })
  .strict();
export type SupplierCertificateInput = z.input<typeof supplierCertificateInput>;

/** A covered service of a contract: its purpose, and confirming a proposed one. Adds the service when it is not covered yet. */
export const supplierContractServiceInput = z
  .object({ purpose: z.string().trim().max(SUPPLIER_LIMITS.purpose).optional(), confirm: z.boolean().optional() })
  .strict();
export type SupplierContractServiceInput = z.input<typeof supplierContractServiceInput>;

/** Merge a supplier into another: its links, contacts, contracts, certificates and spellings move. */
export const supplierMergeInput = z.object({ into: z.string().trim().min(1).max(100) }).strict();
export const supplierArchiveInput = z.object({ archived: z.boolean() }).strict();

/** The supplier of a linked item in a form: missing keeps it, null clears it. */
export const supplierLinkField = z.string().trim().min(1).max(100).nullable().optional();

// ---------- read ----------

/** A linked supplier as other records show it (application, system, ticket, watch, cost plan line, duty). */
export interface SupplierRef {
  id: string;
  name: string;
  status: SupplierStatus;
}

export interface SupplierContact {
  id: string;
  name: string;
  role: SupplierContactRole;
  /** Personal data of people outside Steward: shown in the app only, never in /api/v1, MCP, datasets or exports */
  email: string;
  phone: string;
  note: string;
}

/** A service a contract covers, as the reader may see it (ADR 0031). */
export interface SupplierContractService {
  id: string;
  name: string;
  archived: boolean;
  purpose: string;
  status: SupplierContractServiceStatus;
  /** proposed: where it came from */
  proposedFrom: SupplierContractProposalSource[];
  /** The reader may change the purpose, leave the contract, confirm or dismiss it */
  canChange: boolean;
}

/** The SLA values an order form takes from its master agreement while its own are empty (ADR 0031 part 3). */
export const SUPPLIER_INHERITED_FIELDS = ['slaAvailability', 'slaSupportHours', 'slaResponse', 'rtoHours', 'rpoHours'] as const;
export type SupplierInheritedField = (typeof SUPPLIER_INHERITED_FIELDS)[number];
/** Where an effective value comes from: the contract itself, its master agreement, or the supplier (the company-wide default). */
export type SupplierValueSource = 'contract' | 'master' | 'supplier';

/** Personal data and the data processing agreement of a contract as they apply (ADR 0031 part 5). */
export interface SupplierContractDpa {
  personalData: boolean;
  personalDataFrom: SupplierValueSource;
  status: SupplierDpaStatus | null;
  since: string | null;
  link: string;
  /** Where the agreement comes from */
  inheritedFrom: SupplierValueSource;
  /** Processes personal data, and the agreement is missing */
  missing: boolean;
}

/** What a contract says itself (null or '': empty, inherited). */
export interface SupplierContractOwnTerms {
  slaAvailability: number | null;
  slaSupportHours: string;
  slaResponse: string;
  rtoHours: number | null;
  rpoHours: number | null;
  personalData: boolean | null;
  dpaStatus: SupplierDpaStatus | null;
  dpaSince: string | null;
  dpaLink: string | null;
}

/**
 * The terms that apply to a contract (ADR 0031 parts 3 and 5): an order form takes the SLA, the contractual RTO/RPO,
 * personal data and the agreement from its master while its own are empty; personal data and the agreement then fall
 * back to the supplier's company-wide default (order form → master → supplier). Dates and the document are never
 * inherited. "DPA missing" only where the effective answer is "processes personal data".
 */
export function effectiveTerms(
  own: SupplierContractOwnTerms,
  master: SupplierContractOwnTerms | null,
  supplier: { personalData: boolean; dpaStatus: SupplierDpaStatus | null; dpaSince: string | null; dpaLink: string },
): { values: Pick<SupplierContractOwnTerms, SupplierInheritedField>; inherited: SupplierInheritedField[]; dpa: SupplierContractDpa } {
  const empty = (v: unknown) => v === null || v === undefined || v === '';
  const values = { ...own } as Pick<SupplierContractOwnTerms, SupplierInheritedField>;
  const inherited: SupplierInheritedField[] = [];
  for (const f of SUPPLIER_INHERITED_FIELDS)
    if (empty(own[f]) && master && !empty(master[f])) {
      (values as Record<string, unknown>)[f] = master[f];
      inherited.push(f);
    }
  const pd: [boolean, SupplierValueSource] =
    own.personalData !== null && own.personalData !== undefined
      ? [own.personalData, 'contract']
      : master && master.personalData !== null && master.personalData !== undefined
        ? [master.personalData, 'master']
        : [supplier.personalData, 'supplier'];
  const agreement: { status: SupplierDpaStatus | null; since: string | null; link: string; from: SupplierValueSource } = own.dpaStatus
    ? { status: own.dpaStatus, since: own.dpaSince, link: own.dpaLink ?? '', from: 'contract' }
    : master?.dpaStatus
      ? { status: master.dpaStatus, since: master.dpaSince, link: master.dpaLink ?? '', from: 'master' }
      : { status: supplier.dpaStatus, since: supplier.dpaSince, link: supplier.dpaLink, from: 'supplier' };
  const status = pd[0] ? (agreement.status ?? 'missing') : agreement.status;
  return {
    values,
    inherited,
    dpa: {
      personalData: pd[0],
      personalDataFrom: pd[1],
      status,
      since: status === 'inPlace' ? agreement.since : null,
      link: status === 'inPlace' ? agreement.link : '',
      inheritedFrom: agreement.from,
      missing: pd[0] && status !== 'inPlace',
    },
  };
}

/** Why the reader sees a contract (the contract page's "Owners and visibility"). */
export type SupplierContractReadReason = 'supplierReaders' | 'admin' | 'auditor' | 'owner' | 'service';

export interface SupplierContract {
  id: string;
  title: string;
  reference: string;
  startsOn: string | null;
  endsOn: string | null;
  noticeDays: number | null;
  renewal: SupplierRenewal;
  renewalMonths: number | null;
  /** Derived: the end of the current term (automatic renewal rolls on) and the last day to give notice */
  termEnd: string | null;
  noticeBy: string | null;
  noticeState: SupplierDateState;
  link: string;
  /** The record `link` names, when the reader may read it */
  record: { id: string; number: string; title: string } | null;
  slaAvailability: number | null;
  slaSupportHours: string;
  slaResponse: string;
  rtoHours: number | null;
  rpoHours: number | null;
  note: string;
  /** Cost plan lines that pay for it (services the reader may see) */
  costPlanLines: { id: string; serviceId: string; serviceName: string; fiscalYear: number; title: string }[];
  /** Users and teams who manage it (ADR 0031) */
  owners: string[];
  /**
   * The master agreement (one level). `parent` null with `parentHidden`: a master the reader may not see – its values
   * still apply. `orderForms`: the order forms the reader may see.
   */
  parentId: string | null;
  parent: { id: string; title: string; reference: string } | null;
  parentHidden: boolean;
  orderForms: string[];
  /** An order form that ends after its master: a hint, not a block */
  endsAfterMaster: boolean;
  /** The SLA and RTO/RPO values above that come from the master agreement (the values are the effective ones) */
  inherited: SupplierInheritedField[];
  /** Its own answers (null: as the master and the supplier) */
  personalData: boolean | null;
  dpaStatus: SupplierDpaStatus | null;
  dpaSince: string | null;
  dpaLink: string | null;
  /** Personal data and the agreement as they apply */
  dpa: SupplierContractDpa;
  /** A team among the owners: seen only by its owners, the readers of the services it covers, administrators and auditors */
  teamOwned: boolean;
  /** The covered services the reader may see */
  services: SupplierContractService[];
  /** Covered services the reader may not see – counted only for its owners and who may change it, else 0 */
  hiddenServices: number;
  /** Why the reader sees it */
  readReason: SupplierContractReadReason;
  /** Change it (terms, SLA, owners, remove it) */
  canEdit: boolean;
  createdBy: string;
  updatedBy: string;
}

export interface SupplierCertificate {
  id: string;
  kind: SupplierCertificateKind;
  name: string;
  scope: string;
  issuer: string;
  issuedOn: string | null;
  validUntil: string | null;
  state: SupplierDateState;
  link: string;
  record: { id: string; number: string; title: string } | null;
  checkedBy: string | null;
  checkedAt: string | null;
}

/** Highest protection need of the linked applications per dimension (derived, not stored). */
export interface SupplierCriticality {
  confidentiality: { level: string; label: string } | null;
  integrity: { level: string; label: string } | null;
  availability: { level: string; label: string } | null;
}

export interface SupplierSummary {
  id: string;
  name: string;
  type: SupplierType;
  status: SupplierStatus;
  description: string;
  website: string;
  owners: string[];
  aliases: string[];
  personalData: boolean;
  dpaStatus: SupplierDpaStatus | null;
  dpaSince: string | null;
  dpaLink: string;
  criticality: SupplierCriticality;
  contractCount: number;
  certificateCount: number;
  /** The earliest notice-by date ahead (or the latest passed) of its contracts */
  nextNoticeBy: string | null;
  noticeState: SupplierDateState;
  /** The earliest valid-until of its certificates */
  nextCertificateExpiry: string | null;
  certificateState: SupplierDateState;
  /** Contracts the reader may see that process personal data without an agreement (ADR 0031 part 5) */
  dpaMissingContracts: number;
  /** DPA missing: such contracts, or – without contracts – the supplier's own fields (as in 0.17) */
  dpaMissing: boolean;
  /** Visible items that link it */
  usage: Record<SupplierLinkKind, number>;
  updatedAt: string;
}

/** What links a supplier (visible items only). */
export interface SupplierUsage {
  kind: SupplierLinkKind;
  id: string;
  name: string;
  /** In-app path */
  path: string;
  detail: string;
  /** The contract it names (ADR 0031) – null with `contractHidden`: a contract the reader may not see */
  contract?: { id: string; title: string } | null;
  contractHidden?: boolean;
}

export interface SupplierDetail extends SupplierSummary {
  contacts: SupplierContact[];
  contracts: SupplierContract[];
  certificates: SupplierCertificate[];
  usedBy: SupplierUsage[];
  /** Supplier review duties that name it, with their last periods */
  duties: { id: string; name: string; serviceId: string; serviceName: string; periods: { periodKey: string; status: string; dueAt: string }[] }[];
  /** Free-text spellings that became this supplier on upgrade */
  migratedFrom: { table: string; spellings: string[] }[];
  createdAt: string;
  createdBy: string;
  updatedBy: string;
  /** Change the supplier (the company record), its company-wide contacts and certificates */
  canEdit: boolean;
  /** Add a contract: designers, administrators, the supplier's owners, and editors of a service (ADR 0031) */
  canAddContract: boolean;
  /** Confirm, merge, mark "not a supplier", archive: designers and administrators */
  canManage: boolean;
}

/**
 * What the statement of applicability and the responsibility matrix read of a supplier (ADR 0029 part 2): its SLA,
 * contractual RTO/RPO per contract and the certificates valid today. Read, not copied.
 */
export interface SupplierFacts {
  id: string;
  name: string;
  type: SupplierType;
  status: SupplierStatus;
  contracts: Pick<
    SupplierContract,
    'id' | 'title' | 'reference' | 'termEnd' | 'noticeBy' | 'slaAvailability' | 'slaSupportHours' | 'slaResponse' | 'rtoHours' | 'rpoHours'
  >[];
  validCertificates: Pick<SupplierCertificate, 'id' | 'kind' | 'name' | 'scope' | 'issuer' | 'validUntil'>[];
}

/** Supplier picker: the suppliers a person may link (not archived), with their contracts for cost plan lines. */
export interface SupplierOption {
  id: string;
  name: string;
  status: SupplierStatus;
  aliases: string[];
  /** The contracts the person may see; `services` the services each covers (ADR 0031), `canEdit` whether the person may add a service to it */
  contracts: { id: string; title: string; reference: string; services: string[]; canEdit: boolean }[];
}

/** A contract covering a service, as the service page's "Suppliers" section shows it (ADR 0031). */
export interface ServiceContract {
  supplier: SupplierRef;
  contract: SupplierContract;
  /** The covered service's purpose and status for this service */
  purpose: string;
  status: SupplierContractServiceStatus;
  /** The reader may change the purpose, leave, confirm or dismiss for this service */
  canChange: boolean;
}

export interface ServiceContracts {
  serviceId: string;
  contracts: ServiceContract[];
  /** Suppliers its applications and systems link without a contract (the reader sees) covering the service */
  uncovered: (SupplierRef & { via: { kind: 'application' | 'system'; id: string; name: string }[] })[];
  /** Add a contract for the service / add the service to a contract: who may edit the service */
  canEdit: boolean;
}

/** The contract page (ADR 0031): the contract with its supplier and who sees it and why. */
export interface SupplierContractDetail {
  supplier: SupplierRef & { owners: string[]; teams: string[] };
  contract: SupplierContract;
  /** Who sees it: the supplier's readers (no team owner), or the owning teams, user owners and the readers of the covered services */
  visibility: { open: boolean; teams: string[]; users: string[]; services: { id: string; name: string }[]; hiddenServices: number };
}

/**
 * The pure rule of who reads a contract (ADR 0031 part 2): only who may see its supplier; of them, for a contract
 * with a team among its owners, its owners (members of the teams, the user owners), the readers of a service it covers
 * (proposed ones count), administrators and auditors; a contract without a team owner is read by every reader of the
 * supplier. Returns why, or null.
 */
export function contractReaders(
  contract: { owners: readonly string[] },
  reader: { seesSupplier: boolean; admin: boolean; auditor: boolean; owner: boolean; seesCoveredService: boolean },
): SupplierContractReadReason | null {
  if (!reader.seesSupplier) return null;
  if (!contract.owners.some((o) => o.toLowerCase().startsWith('team:'))) return 'supplierReaders';
  if (reader.admin) return 'admin';
  if (reader.owner) return 'owner';
  if (reader.seesCoveredService) return 'service';
  if (reader.auditor) return 'auditor';
  return null;
}

/** Whether a set of owners holds a team (a team-owned contract). */
export const hasTeamOwner = (owners: readonly string[]): boolean => owners.some((o) => o.toLowerCase().startsWith('team:'));

/** The built-in dataset of certificates and notice-by dates in the next 90 days (administrators and auditors). */
export const SUPPLIERS_EXPIRING_DATASET = 'suppliers.expiring';
