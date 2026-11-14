import { z } from 'zod';

/**
 * Contacts (0.25.1, ADR 0038, docs/CONTACTS.md): the people and groups an item names for its business side – a data
 * product owner, a data owner, a service's business contact, a supplier's account manager, a plant site's shift lead.
 * One directory entry per person or group, linked to items with a role. **A contact never gives a right in Steward**,
 * also when it is linked to a Steward user: rights come only from roles, owning teams and shares (ADR 0033).
 *
 * Personal data: what leaves the app is decided per link kind (CONTACT_EXPOSURE), never per contact. Ids carry the
 * prefix `ct_`.
 */

export const CONTACT_ID_PREFIX = 'ct_';

export const CONTACT_KINDS = ['person', 'group'] as const;
/** person: one human; group: a shared mailbox, a board or an office ("Finance data office") */
export type ContactKind = (typeof CONTACT_KINDS)[number];

export const CONTACT_STATUSES = ['active', 'left'] as const;
/** left: kept for history and evidence, offered nowhere, marked where it is still linked */
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

/** The kinds of items contacts are linked to, with the roles each kind takes. */
export const CONTACT_LINK_ROLES = {
  service: ['business', 'it'],
  supplier: ['accountManager', 'support', 'security', 'dataProtection', 'other'],
  /** Plant sites keep their free-text roles (up to 80 characters) */
  plant_site: null,
  data_product: ['productOwner', 'businessContact'],
  data_domain: ['domainOwner'],
  data_object: ['dataOwner', 'dataSteward'],
  /** A consumer registration of an output port: who is told about deprecations and breaking changes */
  data_consumer: ['consumerContact'],
} as const satisfies Record<string, readonly string[] | null>;

export type ContactLinkKind = keyof typeof CONTACT_LINK_ROLES;
export const CONTACT_LINK_KINDS = Object.keys(CONTACT_LINK_ROLES) as ContactLinkKind[];

/**
 * What may leave the app for a link kind: `app` – shown in the app only (never in /api/v1, MCP, datasets or exports;
 * an API token gets the name and role at most where the module says so); `names` – names and roles in exports,
 * /api/v1, MCP and reports, e-mail addresses only in the module's file format and ODPS; `asBefore` – the shape the
 * kind had before 0.25.1 (services and plant sites: name, role and e-mail where they were shown before).
 */
export const CONTACT_EXPOSURE: Readonly<Record<ContactLinkKind, 'app' | 'names' | 'asBefore'>> = {
  service: 'asBefore',
  supplier: 'app',
  plant_site: 'asBefore',
  data_product: 'names',
  data_domain: 'names',
  data_object: 'names',
  data_consumer: 'names',
};

export const CONTACT_LIMITS = {
  name: 200,
  email: 254,
  phone: 60,
  orgUnit: 200,
  url: 2000,
  note: 2000,
  /** Free-text roles (plant sites) */
  role: 80,
  /** Contacts per item and role */
  perRole: 20,
  /** Contacts named in one documented decision (approved by, decided by, endorsed by) */
  decidedBy: 10,
  /** Search results in the picker */
  search: 25,
} as const;

const trimmed = (max: number) => z.string().trim().max(max);

export const contactInput = z
  .object({
    kind: z.enum(CONTACT_KINDS).default('person'),
    name: z.string().trim().min(1).max(CONTACT_LIMITS.name),
    email: z.union([z.string().trim().max(CONTACT_LIMITS.email).email(), z.literal('')]).default(''),
    phone: trimmed(CONTACT_LIMITS.phone).default(''),
    orgUnit: trimmed(CONTACT_LIMITS.orgUnit).default(''),
    url: z.union([z.string().trim().max(CONTACT_LIMITS.url).url(), z.literal('')]).default(''),
    /** The Steward user this contact is, if they have an account – documentation only, never a right */
    userId: z.string().trim().min(1).max(100).nullable().default(null),
    status: z.enum(CONTACT_STATUSES).default('active'),
  })
  .strict();
export type ContactInput = z.input<typeof contactInput>;

/** One contact named on an item with a role: an existing contact by id, or a new one created on the way. */
export const contactLinkInput = z
  .object({
    role: z.string().trim().min(1).max(CONTACT_LIMITS.role),
    contactId: z.string().trim().min(1).max(100).optional(),
    contact: contactInput.optional(),
  })
  .strict()
  .refine((v) => !!v.contactId !== !!v.contact, { message: 'contactId or contact, not both' });
export type ContactLinkInput = z.input<typeof contactLinkInput>;

/** A contact as items show it. */
export interface ContactRef {
  id: string;
  kind: ContactKind;
  name: string;
  status: ContactStatus;
  /** Omitted where the link kind's exposure does not allow it */
  email?: string;
  phone?: string;
  orgUnit?: string;
  url?: string;
  /** The linked Steward user's name, if any (documentation only) */
  user?: string | null;
}

export interface ContactLink {
  role: string;
  contact: ContactRef;
}

/**
 * Who a documented decision names, frozen when it is recorded: the contact's id (null once erased) and its name and
 * role as they were. Evidence keeps its meaning when a contact later changes or leaves.
 */
export interface ContactSnapshot {
  contactId: string | null;
  name: string;
  /** e.g. productOwner, domainOwner, dataOwner – or free text */
  role: string;
}

export const contactSnapshotInput = z
  .object({
    contactId: z.string().trim().min(1).max(100),
    role: z.string().trim().min(1).max(CONTACT_LIMITS.role),
  })
  .strict();

/** Where a documented decision was made or can be checked (as promotion evidence, ADR 0036). */
export const DOCUMENTED_EVIDENCE_KINDS = ['record', 'ticket', 'url', 'document', 'text'] as const;
export type DocumentedEvidenceKind = (typeof DOCUMENTED_EVIDENCE_KINDS)[number];

export const documentedEvidenceInput = z
  .object({
    kind: z.enum(DOCUMENTED_EVIDENCE_KINDS),
    /** record, ticket, document: the item's id; url: the address; text: the text */
    value: z.string().trim().min(1).max(2000),
  })
  .strict();
export type DocumentedEvidenceInput = z.input<typeof documentedEvidenceInput>;

export interface DocumentedEvidence {
  kind: DocumentedEvidenceKind;
  value: string;
  /** record, ticket, document: the item's label as the reader may see it (null: hidden or gone) */
  label?: string | null;
}

/**
 * A decision made outside Steward and documented in it (ADR 0038): who decided (contacts, frozen), on which date,
 * the evidence, and the Steward user who recorded it.
 */
export const documentedDecisionInput = z
  .object({
    decidedBy: z.array(contactSnapshotInput).min(1).max(CONTACT_LIMITS.decidedBy),
    /** Calendar date of the decision (YYYY-MM-DD), not in the future */
    decidedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    evidence: z.array(documentedEvidenceInput).max(10).default([]),
    note: z.string().trim().max(CONTACT_LIMITS.note).default(''),
  })
  .strict();
export type DocumentedDecisionInput = z.input<typeof documentedDecisionInput>;

export interface DocumentedDecision {
  decidedBy: ContactSnapshot[];
  decidedOn: string;
  evidence: DocumentedEvidence[];
  note: string;
  recordedBy: string;
  recordedAt: string;
}

/** A contact in the directory, as the Contacts page shows it. */
export interface ContactDetail extends ContactRef {
  email: string;
  phone: string;
  orgUnit: string;
  url: string;
  /** Links on items the reader may see; links on hidden items are counted, never named */
  links: { kind: ContactLinkKind; itemId: string; itemName: string; role: string; href: string }[];
  hiddenLinks: number;
  /** Documented decisions that name it (counted) */
  decisions: number;
  canEdit: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

/** Normalised e-mail address for matching (lower case, trimmed); empty for none. */
export const contactEmailKey = (email: string | null | undefined): string => (email ?? '').trim().toLowerCase();

/** Normalised name for matching (NFKC, lower case, single spaces, trimmed). */
export const contactNameKey = (name: string | null | undefined): string => (name ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/** A contact in the directory's list and the picker's search. */
export interface ContactListItem extends ContactRef {
  email: string;
  phone: string;
  orgUnit: string;
  url: string;
  /** Links on items the reader may see */
  usedBy: number;
}

export interface ContactList {
  items: ContactListItem[];
  /** More contacts match than were returned */
  more: boolean;
  /** May create contacts on the Contacts page (the picker creates them on the item) */
  canCreate: boolean;
}

/** Administrators: contacts that share an e-mail address (made separately because a reader could not see the other). */
export interface ContactDuplicateGroup {
  email: string;
  contacts: (ContactListItem & { links: number })[];
}

/** Replace with…: every link of the contact the reader may change moves to `targetId` (administrators: all). */
export const contactReplaceInput = z
  .object({
    targetId: z.string().trim().min(1).max(100),
    /** Mark the replaced contact as left (kept for history, offered nowhere) */
    markLeft: z.boolean().default(false),
  })
  .strict();
export type ContactReplaceInput = z.input<typeof contactReplaceInput>;

export interface ContactReplaceResult {
  /** Links moved to the target (a link the target already had on the same item and role is merged) */
  moved: number;
  /** Visible links on items the reader may not change: left with the contact */
  skipped: number;
  target: ContactDetail;
}
