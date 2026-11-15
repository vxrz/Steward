import {
  CONTACT_LINK_ROLES,
  inheritByRole,
  type ContactLink,
  type InheritedContactLink,
  type ContactLinkInput,
  type ContactLinkKind,
  type DataConsumerContacts,
  type DataProductPermission,
  type ReportLang,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { forbid, me } from '../auth/access.js';
import { viaApiToken } from '../auth/context.js';
import type { ContactHooks, ContactKindDef } from '../contacts/registry.js';
import { roleLabelOf } from '../contacts/roles.js';
import {
  contactChanges,
  contactForGroup,
  contactForUser,
  importContact,
  linksOf,
  linksOfKinds,
  namesOfLinks,
  setLinks,
  type ContactSurface,
} from '../contacts/service.js';
import { t } from '../i18n/index.js';
import { csvTable } from '../csv.js';
import { canCreate, domainAccess, objectAccess, productAccess } from './access.js';
import { countDecisions, forgetErasedContact } from './decisions.js';
import { productNotFound } from './common.js';
import { chunks, consumersOf, marks, portsOf, productRow, productsByIds, type ConsumerRow } from './store.js';

/**
 * Contacts of data products, domains, data objects and consumer registrations (0.25.1, ADR 0038 parts 1, 2 and 6): the
 * business side named on an item – product owners and business contacts, domain owners, a data object's data owner
 * and stewards, a registration's consumer contacts – are **contacts** of the directory (contacts/service.ts), linked
 * with a role. A contact never gives a right. Technical custodians of a data object stay teams.
 *
 * - **Who sees and changes them** is the module's: the kinds are registered with its visibility and edit checks
 *   (DATA_PRODUCT_CONTACT_KINDS, the manifest's `contactKinds`).
 * - **Exposure** (CONTACT_EXPOSURE `names`): names and roles in exports, /api/v1, MCP and reports; e-mail addresses
 *   only in the module's file format and ODPS.
 * - **Subjects of before 0.25.1** (`user:`, `team:`) – the upgrade and the old fields of the file format and the API –
 *   become contacts: a user the person contact linked to that account, a team a group contact of that name.
 * - **The consumers' contacts** of a product (or a port) are listed for its readers by name and role; who may change the
 *   product – its IT maintainers, who inform them of a deprecation or a breaking change – also sees their e-mail
 *   addresses and downloads them as CSV (an export from the app by a maintainer, audited).
 */

const ROLES = CONTACT_LINK_ROLES;
export const PRODUCT_CONTACT_ROLES = ROLES.data_product;
export const DOMAIN_CONTACT_ROLES = ROLES.data_domain;
export const OBJECT_CONTACT_ROLES = ROLES.data_object;
export const CONSUMER_CONTACT_ROLE = ROLES.data_consumer[0];

const enc = encodeURIComponent;
const can = (perms: readonly DataProductPermission[], p: DataProductPermission) => perms.includes(p);

function bulkVisible(ids: readonly string[], table: 'dp_products' | 'dp_domains' | 'dp_objects', ok: (id: string) => boolean): Set<string> {
  const out = new Set<string>();
  for (const part of chunks([...new Set(ids)]))
    for (const r of db().all<{ id: string }>(`SELECT id FROM ${table} WHERE id IN (${marks(part.length)})`, ...part)) if (ok(r.id)) out.add(r.id);
  return out;
}
function bulkNames(ids: readonly string[], table: 'dp_products' | 'dp_domains' | 'dp_objects'): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of chunks([...new Set(ids)]))
    for (const r of db().all<{ id: string; name: string }>(`SELECT id, name FROM ${table} WHERE id IN (${marks(part.length)})`, ...part)) out.set(r.id, r.name);
  return out;
}

/** A consumer registration's product and port (for its contacts' visibility and where-used). */
function consumerItems(ids: readonly string[]): Map<string, { productId: string; portId: string; portName: string; label: string }> {
  const out = new Map<string, { productId: string; portId: string; portName: string; label: string }>();
  for (const part of chunks([...new Set(ids)]))
    for (const r of db().all<{
      id: string;
      product_id: string;
      port_id: string;
      port_name: string;
      consumer_text: string;
      consumer_subjects: string;
      consumer_kind: string;
    }>(
      `SELECT c.id, p.product_id, c.port_id, p.name AS port_name, c.consumer_text, c.consumer_subjects, c.consumer_kind
         FROM dp_consumers c JOIN dp_ports p ON p.id = c.port_id WHERE c.id IN (${marks(part.length)})`,
      ...part,
    ))
      out.set(r.id, {
        productId: r.product_id,
        portId: r.port_id,
        portName: r.port_name,
        label: r.consumer_text || (JSON.parse(r.consumer_subjects || '[]') as string[])[0] || r.consumer_kind,
      });
  return out;
}

const productKind: ContactKindDef = {
  // the module's contributors and managers (module-only users too) create contacts for the items they keep
  createsContacts: (u) => canCreate(u),
  visibleIds: (u, ids) => bulkVisible(ids, 'dp_products', (id) => productAccess(u, { id }).permissions.length > 0),
  canChange: (u, id) => can(productAccess(u, { id }).permissions, 'edit'),
  names: (ids) => bulkNames(ids, 'dp_products'),
  href: (id) => `/data-products/${enc(id)}`,
};
const domainKind: ContactKindDef = {
  // the module's contributors and managers (module-only users too) create contacts for the items they keep
  createsContacts: (u) => canCreate(u),
  visibleIds: (u, ids) => bulkVisible(ids, 'dp_domains', (id) => domainAccess(u, { id }).permissions.length > 0),
  canChange: (u, id) => can(domainAccess(u, { id }).permissions, 'edit'),
  names: (ids) => bulkNames(ids, 'dp_domains'),
  href: (id) => `/data-domains?open=${enc(id)}`,
};
const objectKind: ContactKindDef = {
  // the module's contributors and managers (module-only users too) create contacts for the items they keep
  createsContacts: (u) => canCreate(u),
  visibleIds: (u, ids) => bulkVisible(ids, 'dp_objects', (id) => objectAccess(u, { id }).permissions.length > 0),
  canChange: (u, id) => can(objectAccess(u, { id }).permissions, 'edit'),
  names: (ids) => bulkNames(ids, 'dp_objects'),
  href: (id) => `/data-objects/${enc(id)}`,
};
/** A registration's contacts: who may see its product sees them, who may change the product changes them. */
const consumerKind: ContactKindDef = {
  // the module's contributors and managers (module-only users too) create contacts for the items they keep
  createsContacts: (u) => canCreate(u),
  visibleIds: (u, ids) => {
    const items = consumerItems(ids);
    const seen = new Map<string, boolean>();
    const out = new Set<string>();
    for (const [id, c] of items) {
      if (!seen.has(c.productId)) seen.set(c.productId, productAccess(u, { id: c.productId }).permissions.length > 0);
      if (seen.get(c.productId)) out.add(id);
    }
    return out;
  },
  canChange: (u, id) => {
    const c = consumerItems([id]).get(id);
    return !!c && can(productAccess(u, { id: c.productId }).permissions, 'edit');
  },
  names: (ids) => {
    const items = consumerItems(ids);
    const products = productsByIds([...new Set([...items.values()].map((c) => c.productId))]);
    return new Map([...items].map(([id, c]) => [id, `${products.get(c.productId)?.name ?? ''} / ${c.portName}: ${c.label}`]));
  },
  href: (id) => {
    const c = consumerItems([id]).get(id);
    return c ? `/data-products/${enc(c.productId)}/ports?contacts=${enc(c.portId)}` : '';
  },
};

/** The module's link kinds of the contacts directory (features/dataproducts.ts `contactKinds`). */
export const DATA_PRODUCT_CONTACT_KINDS: readonly { kind: ContactLinkKind; def: ContactKindDef }[] = [
  { kind: 'data_product', def: productKind },
  { kind: 'data_domain', def: domainKind },
  { kind: 'data_object', def: objectKind },
  { kind: 'data_consumer', def: consumerKind },
];

/** Documented decisions name contacts: counted on a contact's page, its id nulled when it is erased. */
export const DATA_PRODUCT_CONTACT_HOOKS: ContactHooks = {
  countDecisions,
  onErased: forgetErasedContact,
};

// ---------- subjects of before 0.25.1 ----------

/**
 * A subject of before 0.25.1 as a contact: `user:<name>` the person contact of that account (a name without an account:
 * a person contact of that name), `team:<name>` a group contact of that name. `audit: false` for the upgrade, which
 * audits the item once.
 */
export function contactOfSubject(subject: string, opts: { audit?: boolean } = {}): string | null {
  const s = subject.trim();
  const name = s.replace(/^(user|team):/i, '').trim();
  if (!name) return null;
  // a team's group contact is named as the team is written (subjects are lower case), else as given
  if (/^team:/i.test(s)) return contactForGroup(db().get<{ name: string }>('SELECT name FROM teams WHERE lower(name) = lower(?)', name)?.name ?? name, opts).id;
  if (/^user:/i.test(s)) return (contactForUser(name, opts) ?? importContact({ kind: 'person', name }, opts)).id;
  return null;
}

/** Links of subjects with a role (the old fields of the API and the file format). */
export const linksOfSubjects = (subjects: readonly string[], role: string, opts: { audit?: boolean } = {}): ContactLinkInput[] =>
  [...new Set(subjects.map((s) => s.trim().toLowerCase()))].flatMap((s) => {
    const id = contactOfSubject(s, opts);
    return id ? [{ role, contactId: id }] : [];
  });

/** The `user:<name>` subjects of the linked Steward users of a role – the deprecated `owners` of /api/v1 and MCP. */
export const userSubjectsOf = (links: readonly ContactLink[] | undefined, role: string): string[] => [
  ...new Set((links ?? []).filter((l) => l.role === role && l.contact.user).map((l) => `user:${l.contact.user!.toLowerCase()}`)),
];

/** Names and roles only (exports, /api/v1, MCP, reports); 0.26.0: the role's label, deputy and until. */
export const namesOf = namesOfLinks;

/**
 * The links of one role after an old subject field (`owners`, `owner`, `stewards`, a consumer's `contacts` as
 * subjects) was written (0.25.1, deprecated): such a field can only name Steward users and teams, and reads back as the
 * linked users of the role (userSubjectsOf). So it manages the role's contacts linked to a user – one it no longer
 * names goes, one it names is the item's own contact of that user, else the person contact of the account – and adds a
 * team's group contact; the role's other contacts (a person without an account, a group, a contact of a team) stay. A
 * client of before that sends back the `owners` it read changes nothing.
 */
export function legacyRoleLinks(current: readonly ContactLink[], role: string, subjects: readonly string[]): ContactLinkInput[] {
  const mine = current.filter((k) => k.role === role);
  const wanted = [...new Set(subjects.map((x) => x.trim().toLowerCase()))];
  const userOf = (k: ContactLink) => (k.contact.user ? `user:${k.contact.user.toLowerCase()}` : null);
  const out: ContactLinkInput[] = mine.filter((k) => !userOf(k) || wanted.includes(userOf(k)!)).map((k) => ({ role, contactId: k.contact.id }));
  const have = new Set(mine.map(userOf).filter(Boolean));
  for (const l of linksOfSubjects(
    wanted.filter((x) => !have.has(x)),
    role,
  ))
    if (!out.some((o) => o.contactId === l.contactId)) out.push(l);
  return out;
}

/**
 * Writes an item's contacts inside the caller's transaction and returns what changed (for its audit entry): the new
 * `contacts` when given, else the old fields as subjects per role (legacyRoleLinks: they change only what they can
 * express), else nothing (the item keeps its contacts).
 */
export function writeContacts(
  kind: ContactLinkKind,
  itemId: string,
  input: { contacts?: readonly ContactLinkInput[] | null; legacy?: readonly { role: string; subjects: readonly string[] | undefined }[] },
): { added: string[]; removed: string[]; updated?: string[] } | null {
  let links: ContactLinkInput[] | null = null;
  if (input.contacts) links = [...input.contacts];
  else if (input.legacy?.some((l) => l.subjects !== undefined)) {
    const keep = linksOf(kind, [itemId]).get(itemId) ?? [];
    links = input.legacy.flatMap((l) =>
      l.subjects === undefined
        ? keep.filter((k) => k.role === l.role).map((k) => ({ role: k.role, contactId: k.contact.id }))
        : legacyRoleLinks(keep, l.role, l.subjects),
    );
    // roles the old fields do not cover (a business contact) stay
    const covered = new Set(input.legacy.map((l) => l.role));
    links.push(...keep.filter((k) => !covered.has(k.role)).map((k) => ({ role: k.role, contactId: k.contact.id })));
  }
  if (!links) return null;
  return contactChanges(setLinks(kind, itemId, links));
}

/**
 * Contacts of items for a surface (bulk). The app's internal API called with an API token is an API like /api/v1
 * (CONTACT_EXPOSURE `names`): names, roles and the linked Steward user (the deprecated `owners`, `owner`, `stewards`
 * read it) – no e-mail address, phone or address; the full contact is the web app's.
 */
export function contactsOf(kind: ContactLinkKind, ids: readonly string[], surface: ContactSurface = 'app'): Map<string, ContactLink[]> {
  if (!ids.length) return new Map();
  return forSurface(linksOf(kind, ids, { surface }), surface);
}

/** An API token on the internal API: names, roles and the linked user only (see contactsOf). */
function forSurface(links: Map<string, ContactLink[]>, surface: ContactSurface): Map<string, ContactLink[]> {
  if (surface !== 'app' || !viaApiToken()) return links;
  for (const list of links.values())
    for (const l of list) l.contact = { id: l.contact.id, kind: l.contact.kind, name: l.contact.name, status: l.contact.status, user: l.contact.user ?? null };
  return links;
}

/**
 * The contacts of products and of the domains they inherit from, in one statement (the product page, 0.26.0): `domains`
 * are the ids whose contacts domainContactChains() then reads from `preloaded`.
 */
export function productAndDomainContacts(
  productIds: readonly string[],
  domainIds: readonly string[],
  surface: ContactSurface = 'app',
): { products: Map<string, ContactLink[]>; domains: Map<string, ContactLink[]> } {
  const all = linksOfKinds(
    [
      { kind: 'data_product', ids: productIds },
      { kind: 'data_domain', ids: domainIds },
    ],
    { surface },
  );
  return { products: forSurface(all.get('data_product') ?? new Map(), surface), domains: forSurface(all.get('data_domain') ?? new Map(), surface) };
}

/** The domains whose contacts inherit to these domains' items: each domain and its parent, those the reader may see. */
export function chainDomainIds(domainIds: readonly (string | null)[], domains: ReadonlyMap<string, DomainNode>, visible: (id: string) => boolean): string[] {
  const out = new Set<string>();
  for (const id of domainIds) {
    if (!id || !domains.has(id) || !visible(id)) continue;
    out.add(id);
    const p = domains.get(id)!.parent_id;
    if (p && domains.has(p) && visible(p)) out.add(p);
  }
  return [...out];
}

// ---------- inherited along the domain hierarchy (0.26.0, ADR 0039 part 2) ----------

/** A domain as inheritance needs it: its name and parent. */
export interface DomainNode {
  id: string;
  name: string;
  parent_id: string | null;
}

/**
 * What items inherit from domains, in bulk (one statement for every domain involved): per domain id, its contacts as an
 * item in it sees them – its own (from it) and, in the roles it names none of its own, its parent's (from the parent).
 * Never copied: read from the domains every time. Only from domains the reader may see (`visible`): a hidden domain
 * gives nothing, and nothing says there was something (a hidden sub-domain hides its parent's too – the product would
 * otherwise tell where its domain sits).
 */
export function domainContactChains(
  domainIds: readonly (string | null)[],
  domains: ReadonlyMap<string, DomainNode>,
  visible: (id: string) => boolean,
  surface: ContactSurface = 'app',
  /** The domains' contacts read already (productAndDomainContacts) */
  preloaded?: Map<string, ContactLink[]>,
): Map<string, InheritedContactLink[]> {
  const wanted = [...new Set(domainIds.filter((id): id is string => !!id && domains.has(id) && visible(id)))];
  const out = new Map<string, InheritedContactLink[]>();
  if (!wanted.length) return out;
  const parents = wanted.map((id) => domains.get(id)!.parent_id).filter((p): p is string => !!p && domains.has(p) && visible(p));
  const links = preloaded ?? contactsOf('data_domain', [...new Set([...wanted, ...parents])], surface);
  const mark = (id: string): InheritedContactLink[] => {
    const d = domains.get(id)!;
    return (links.get(id) ?? []).map((l) => ({ ...l, from: { kind: 'data_domain', id: d.id, name: d.name } }));
  };
  for (const id of wanted) {
    const own = mark(id);
    const parent = domains.get(id)!.parent_id;
    out.set(id, [...own, ...(parent && parents.includes(parent) ? inheritByRole(own, mark(parent)) : [])]);
  }
  return out;
}

/** The contacts an item inherits: those of the chain in the roles the item names none of its own. */
export const inheritedFor = (own: readonly ContactLink[], chain: readonly InheritedContactLink[] | undefined): InheritedContactLink[] =>
  inheritByRole(own, chain ?? []);

// ---------- the consumers' contacts (ADR 0038 part 6) ----------

/**
 * GET /api/data-products/:id/consumer-contacts?port= – the contacts of the registered consumers of a product's output
 * ports (or of one port): name and role for who may see the product; e-mail addresses only for who may change it.
 */
/** A product the caller may see, with their rights (else 404, as if it did not exist). */
function readable(productId: string) {
  const u = me();
  const p = productRow(productId);
  const perms = p ? productAccess(u, p).permissions : [];
  if (!p || !perms.length) throw productNotFound(productId);
  return { p, perms };
}

export function consumerContacts(productId: string, portId?: string | null): DataConsumerContacts {
  const { p, perms } = readable(productId);
  // e-mail addresses for the IT maintainers in the app (an API token gets names and roles, as on /api/v1)
  const maintainer = can(perms, 'edit') && !viaApiToken();
  const ports = portsOf([p.id]).filter((x) => x.direction === 'output' && (!portId || x.id === portId));
  const consumers: ConsumerRow[] = consumersOf(ports.map((x) => x.id));
  const links = contactsOf(
    'data_consumer',
    consumers.map((c) => c.id),
  );
  const portName = new Map(ports.map((x) => [x.id, `${x.name}${x.version ? ` ${x.version}` : ''}`]));
  return {
    productId: p.id,
    portId: portId ?? null,
    withEmail: maintainer,
    entries: consumers.map((c) => ({
      consumerId: c.id,
      portId: c.port_id,
      portName: portName.get(c.port_id) ?? '',
      consumer: c.consumer_text || (JSON.parse(c.consumer_subjects || '[]') as string[])[0] || c.consumer_kind,
      kind: c.consumer_kind as DataConsumerContacts['entries'][number]['kind'],
      endDate: c.end_date,
      contacts: (links.get(c.id) ?? []).map((l) => ({
        name: l.contact.name,
        role: l.role,
        status: l.contact.status,
        ...(maintainer && l.contact.email ? { email: l.contact.email } : {}),
      })),
    })),
  };
}

/** GET /api/data-products/:id/consumer-contacts.csv – who may change the product (an export by an IT maintainer, audited). */
export function consumerContactsCsv(productId: string, portId: string | null, lang: ReportLang): string {
  const { p, perms } = readable(productId);
  if (!can(perms, 'edit')) forbid('export the contacts of this data product’s consumers', 'dataProducts');
  const v = consumerContacts(productId, portId);
  const k = (key: string) => t(lang, `dataProducts.consumerContacts.${key}` as never);
  const rows: string[][] = [];
  for (const e of v.entries)
    for (const c of e.contacts.length ? e.contacts : [null])
      rows.push([e.portName, e.consumer, c?.name ?? '', c ? roleLabelOf(c.role, lang) : '', c?.email ?? '']);
  audit({
    action: 'dataproduct.consumer_contacts_exported',
    entityType: 'data_product',
    entityId: p.id,
    summary: `Data product "${p.name}": the consumers' contacts exported as CSV (${v.entries.reduce((n: number, e) => n + e.contacts.length, 0)} contacts)`,
    details: { portId, entries: v.entries.length },
  });
  return csvTable([k('port'), k('consumer'), k('name'), k('role'), k('email')], rows, { bom: true });
}
