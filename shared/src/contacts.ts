import { z } from 'zod';
import { isCalendarDate } from './costPlans.js';

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

/**
 * The kinds of items contacts are linked to, with their **built-in** roles (0.26.0, ADR 0039 part 1). Since 0.26.0
 * roles are data – the role catalogue (`contact_roles`, Settings → Contacts → Roles, ContactRole) – and this list is
 * only what the catalogue is seeded with: validation reads the catalogue. Steward's own logic relies on the built-in
 * keys (product owner: "needs an owner" and ODPS; domain owner: who endorsed; data owner and steward: the records of
 * processing; consumer contact: the consumers' contacts list), so they are never deleted or re-keyed.
 */
export const CONTACT_LINK_ROLES = {
  service: ['business', 'it'],
  supplier: ['accountManager', 'support', 'security', 'dataProtection', 'other'],
  /** No built-in role: a plant site's roles are own roles (0.26.0: its free-text roles of before became own roles) */
  plant_site: [],
  data_product: ['productOwner', 'businessContact'],
  data_domain: ['domainOwner'],
  data_object: ['dataOwner', 'dataSteward'],
  /** A consumer registration of an output port: who is told about deprecations and breaking changes */
  data_consumer: ['consumerContact'],
  /** 0.26.0: business contacts of applications and systems, beside their owners (who maintain them, with rights) */
  application: ['businessOwner', 'applicationManager'],
  system: ['businessOwner', 'systemManager'],
} as const satisfies Record<string, readonly string[]>;

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
  application: 'names',
  system: 'names',
};

export const CONTACT_LIMITS = {
  name: 200,
  email: 254,
  phone: 60,
  orgUnit: 200,
  url: 2000,
  note: 2000,
  /** A role's key or the free text of a plant site role of before 0.26.0 */
  role: 80,
  /** A role's label (a plant site's free-text role of before 0.25.1 may have been 200 characters long) */
  roleLabel: 200,
  roleDescription: 1000,
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

/** A calendar date (YYYY-MM-DD) that exists (not 2026-02-30). */
export const contactDate = z.string().refine(isCalendarDate, 'a date like 2027-03-31');

/** One contact named on an item with a role: an existing contact by id, or a new one created on the way. */
export const contactLinkInput = z
  .object({
    /**
     * The key of a role of the catalogue that applies to the item's kind and is switched on (a role the item has already
     * may stay, also when it was switched off since, or – plant sites – a role text of before that was kept)
     */
    role: z.string().trim().max(CONTACT_LIMITS.roleLabel),
    contactId: z.string().trim().min(1).max(100).optional(),
    contact: contactInput.optional(),
    /** 0.26.0: stands in for this contact – one linked in the same role on the same item (by id) */
    deputyOf: z.string().trim().min(1).max(100).nullable().optional(),
    /** 0.26.0: named until this date (YYYY-MM-DD); after it the link is marked ended and no longer counts as expected */
    until: contactDate.nullable().optional(),
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
  /** 0.26.0: the id of the contact this one stands in for (same role, same item); omitted for none */
  deputyOf?: string;
  /** 0.26.0: named until this date (YYYY-MM-DD); omitted for none */
  until?: string;
}

/**
 * A contact an item shows from elsewhere, never copied (0.26.0, ADR 0039 part 2): a sub-domain's from its parent
 * domain, a data product's from its domain – per role, unless the item names its own contact in that role. Shown only
 * to who may see the domain it comes from.
 */
export interface InheritedContactLink extends ContactLink {
  from: { kind: 'data_domain'; id: string; name: string };
}

/** A contact by name and role, as exports, /api/v1, MCP and reports give it for the kinds of exposure `names`. */
export interface ContactNameEntry {
  role: string;
  /** The role's English label (the catalogue's) */
  roleLabel: string;
  name: string;
  /** The name of the contact this one stands in for */
  deputyOf?: string;
  until?: string;
}

// ---------- the role catalogue (0.26.0, ADR 0039 part 1) ----------

export const CONTACT_ROLE_CARDINALITIES = ['one', 'many'] as const;
/** one: at most one contact in the role per item (deputies and ended links aside); many: up to CONTACT_LIMITS.perRole */
export type ContactRoleCardinality = (typeof CONTACT_ROLE_CARDINALITIES)[number];

/** A role's key: a letter, then letters and digits (camelCase), e.g. domainArchitect. */
export const contactRoleKey = z
  .string()
  .trim()
  .regex(/^[a-z][A-Za-z0-9]{0,59}$/, 'a letter, then letters and digits');

/**
 * A role of the catalogue (Settings → Contacts → Roles). Built-in roles (CONTACT_LINK_ROLES) keep their key and kinds –
 * their labels, description, cardinality and expected can be changed, and they can be switched off for a kind
 * (`kinds` is then a part of `builtInKinds`) or altogether. Own roles are documentation only.
 */
export interface ContactRole {
  key: string;
  labels: { en: string; de: string };
  description: string;
  /** The kinds it applies to (switched on) */
  kinds: ContactLinkKind[];
  /** Built-in roles: the kinds it can apply to */
  builtInKinds?: ContactLinkKind[];
  cardinality: ContactRoleCardinality;
  /** An item of its kinds without a current contact in this role gets a hint (data products: the scorecard notes it) */
  expected: boolean;
  builtIn: boolean;
  /** Switched off: no new links; existing ones stay and are marked */
  active: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  /** Administrators only: links per kind (a role in use cannot be deleted) */
  usage?: Partial<Record<ContactLinkKind, number>>;
  /**
   * Administrators only: made by the upgrade from a plant site's free-text role (0.26.0) – shown to others only where
   * they see a site that names it, until an administrator saves it
   */
  fromSiteText?: boolean;
}

export const contactRoleInput = z
  .object({
    /** On create only (default: made from the English label); a built-in role's key never changes */
    key: contactRoleKey.optional(),
    labels: z
      .object({
        en: z.string().trim().min(1).max(CONTACT_LIMITS.roleLabel),
        de: z.string().trim().max(CONTACT_LIMITS.roleLabel).default(''),
      })
      .strict(),
    description: z.string().trim().max(CONTACT_LIMITS.roleDescription).default(''),
    kinds: z.array(z.enum(Object.keys(CONTACT_LINK_ROLES) as [ContactLinkKind, ...ContactLinkKind[]])).max(20),
    cardinality: z.enum(CONTACT_ROLE_CARDINALITIES).default('many'),
    expected: z.boolean().default(false),
    active: z.boolean().default(true),
  })
  .strict();
export type ContactRoleInput = z.input<typeof contactRoleInput>;

export type ContactRoleLang = 'en' | 'de';

/** The labels the built-in roles start with (administrators may change them). */
export const BUILT_IN_CONTACT_ROLE_LABELS: Readonly<Record<string, { en: string; de: string }>> = {
  business: { en: 'Business owner', de: 'Fachlich verantwortlich' },
  it: { en: 'IT operations', de: 'IT-Betrieb' },
  // as the supplier pages named them
  accountManager: { en: 'Account manager', de: 'Account-Manager' },
  support: { en: 'Support', de: 'Supportkontakt' },
  security: { en: 'Security contact', de: 'Sicherheitskontakt' },
  dataProtection: { en: 'Data protection officer', de: 'Datenschutzbeauftragte(r)' },
  other: { en: 'Other', de: 'Sonstige' },
  productOwner: { en: 'Product owner', de: 'Product Owner' },
  businessContact: { en: 'Business contact', de: 'Fachlicher Kontakt' },
  domainOwner: { en: 'Domain owner', de: 'Domänenverantwortliche' },
  dataOwner: { en: 'Data owner', de: 'Dateneigentümer' },
  dataSteward: { en: 'Data steward', de: 'Data Steward' },
  consumerContact: { en: 'Consumer contact', de: 'Kontakt des Nutzers' },
  businessOwner: { en: 'Business owner', de: 'Fachlich verantwortlich' },
  applicationManager: { en: 'Application manager', de: 'Anwendungsverantwortliche' },
  systemManager: { en: 'System manager', de: 'Systemverantwortliche' },
};

/** The built-in roles as the catalogue starts with them: every key of CONTACT_LINK_ROLES with the kinds that list it. */
export function builtInContactRoles(): ContactRole[] {
  const kinds = new Map<string, ContactLinkKind[]>();
  for (const [kind, keys] of Object.entries(CONTACT_LINK_ROLES) as [ContactLinkKind, readonly string[]][])
    for (const k of keys) kinds.set(k, [...(kinds.get(k) ?? []), kind]);
  return [...kinds].map(([key, ks]) => ({
    key,
    labels: { ...(BUILT_IN_CONTACT_ROLE_LABELS[key] ?? { en: key, de: '' }) },
    description: '',
    kinds: [...ks],
    builtInKinds: [...ks],
    cardinality: 'many',
    expected: false,
    builtIn: true,
    active: true,
    createdAt: '',
    createdBy: 'system',
    updatedAt: '',
    updatedBy: 'system',
  }));
}

/** A role's label in a language (German falls back to English); an unknown key as it is (a kept free-text role). */
export function contactRoleLabel(roles: readonly ContactRole[], key: string, lang: string = 'en'): string {
  const r = roles.find((x) => x.key === key);
  if (!r) return key;
  return (lang.startsWith('de') && r.labels.de) || r.labels.en || key;
}

/** Whether a role is switched on for a kind (new links may name it). */
export const contactRoleOn = (r: ContactRole | undefined, kind: ContactLinkKind): boolean => !!r && r.active && r.kinds.includes(kind);

/** Today as YYYY-MM-DD (UTC), the day `until` is compared with. */
export const contactToday = (now: Date = new Date()): string => now.toISOString().slice(0, 10);

/** A link whose `until` date has passed: marked ended, no longer counts for an expected role. */
export const contactLinkEnded = (l: { until?: string | null }, today: string = contactToday()): boolean => !!l.until && l.until < today;

/**
 * The expected roles of a kind that an item lacks: no current (not ended) contact in the role – its own or one it
 * inherits (InheritedContactLink). Roles switched off are not expected.
 */
export function missingExpectedRoles(
  roles: readonly ContactRole[],
  kind: ContactLinkKind,
  links: readonly { role: string; until?: string | null }[],
  inherited: readonly { role: string; until?: string | null }[] = [],
  today: string = contactToday(),
): string[] {
  const have = new Set([...links, ...inherited].filter((l) => !contactLinkEnded(l, today)).map((l) => l.role));
  return roles.filter((r) => r.expected && contactRoleOn(r, kind) && !have.has(r.key)).map((r) => r.key);
}

/**
 * Inheritance per role: the contacts `from` gives in the roles `own` does not name (a sub-domain from its parent, a
 * product from its domain). Never copied – the caller marks where they come from.
 */
export function inheritByRole<T extends { role: string }>(own: readonly { role: string }[], from: readonly T[]): T[] {
  const named = new Set(own.map((l) => l.role));
  return from.filter((l) => !named.has(l.role));
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
