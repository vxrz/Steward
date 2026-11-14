import { z } from 'zod';
import {
  CONTACT_EXPOSURE,
  CONTACT_ID_PREFIX,
  CONTACT_LIMITS,
  CONTACT_LINK_ROLES,
  contactEmailKey,
  contactInput,
  contactLinkInput,
  contactNameKey,
  type ContactDetail,
  type ContactDuplicateGroup,
  type ContactInput,
  type ContactKind,
  type ContactLink,
  type ContactLinkInput,
  type ContactLinkKind,
  type ContactList,
  type ContactListItem,
  type ContactRef,
  type ContactReplaceInput,
  type ContactReplaceResult,
  type ContactSnapshot,
  type ContactStatus,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentActor, currentUser, type AuthUser } from '../auth/context.js';
import { forbid, hasRole, me, requireAdmin } from '../auth/access.js';
import { isAdmin } from '../auth/permissions.js';
import { likeEscape } from '../database/sql.js';
import { HttpError, newId, nowIso } from '../util.js';
import { contactHooks, contactKind } from './registry.js';

/**
 * The contacts directory (0.25.1, ADR 0038 part 1, docs/CONTACTS.md): one entry per person or group, linked to items
 * with a role. Core, not a module: services, suppliers, plant sites and the data products module name contacts through
 * the functions below and register their link kinds (registry.ts).
 *
 * - A contact never gives a right in Steward, also when it is linked to a Steward user.
 * - Who sees a contact: who may see at least one item it is linked to; administrators and auditors; its creator while
 *   it is linked to nothing. Everyone else gets 404 CONTACT_NOT_FOUND, as for a contact that does not exist – a reader
 *   is never told that a hidden contact or a hidden item exists, except that the where-used page counts the links on
 *   items they may not see (never names them).
 * - Who changes a contact: who may change at least one item it is linked to, its creator while it is linked to
 *   nothing, and administrators. Audited: contact.created, contact.updated, contact.replaced, contact.erased (the
 *   name, never the e-mail address or phone number).
 * - What leaves the app is decided per link kind (CONTACT_EXPOSURE), never per contact: linksOf() with `surface`.
 *
 * Statements: every read is in bulk (contacts and links by id lists of up to 500), so the count does not grow with the
 * number of items or contacts (server/test/contacts.test.ts counts them).
 */

// ---------- rows ----------

interface ContactRow {
  id: string;
  kind: ContactKind;
  name: string;
  name_norm: string;
  email: string;
  email_norm: string;
  phone: string;
  org_unit: string;
  url: string;
  user_id: string | null;
  status: ContactStatus;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  /** users.username of user_id (LEFT JOIN) */
  username?: string | null;
}

interface LinkRow {
  kind: string;
  item_id: string;
  role: string;
  contact_id: string;
  position: number;
  created_at: string;
  created_by: string;
}

/** Where personal data goes (CONTACT_EXPOSURE): the web app, the public API and MCP, exports and reports, a module's file format. */
export type ContactSurface = 'app' | 'api' | 'export' | 'file';

const CHUNK = 500;
const CONTACT_COLUMNS =
  'c.id, c.kind, c.name, c.name_norm, c.email, c.email_norm, c.phone, c.org_unit, c.url, c.user_id, c.status, c.created_at, c.created_by, c.updated_at, c.updated_by, u.username';
const FROM_CONTACTS = 'contacts c LEFT JOIN users u ON u.id = c.user_id';

const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');

function inChunks<T>(ids: readonly string[], read: (part: string[]) => T[]): T[] {
  const uniq = [...new Set(ids)];
  const out: T[] = [];
  for (let i = 0; i < uniq.length; i += CHUNK) out.push(...read(uniq.slice(i, i + CHUNK)));
  return out;
}

function contactRows(ids: readonly string[]): Map<string, ContactRow> {
  const rows = inChunks(ids, (part) => db().all<ContactRow>(`SELECT ${CONTACT_COLUMNS} FROM ${FROM_CONTACTS} WHERE c.id IN (${marks(part.length)})`, ...part));
  return new Map(rows.map((r) => [r.id, r]));
}

function linkRowsOfContacts(contactIds: readonly string[]): LinkRow[] {
  return inChunks(contactIds, (part) => db().all<LinkRow>(`SELECT * FROM contact_links WHERE contact_id IN (${marks(part.length)})`, ...part));
}

const notFound = (id: string): never => {
  throw new HttpError(404, `Contact ${id} not found`, 'CONTACT_NOT_FOUND', { id });
};

// ---------- who sees, who changes ----------

/** Administrators, auditors and jobs (no user) see every contact. */
const seesAll = (u: AuthUser | null): boolean => !u || isAdmin(u) || hasRole(u, ['auditor']);
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

interface Decided {
  visible: boolean;
  /** Links on items the reader may see */
  links: LinkRow[];
  /** Links on items the reader may not see (counted on the where-used page, never named) */
  hidden: number;
}

/**
 * Who sees which of these contacts (ADR 0038): one call of each link kind's visibleIds() for all the items involved.
 * `links` are the links of these contacts (all of them; read by the caller in bulk).
 */
function decide(u: AuthUser | null, contacts: readonly ContactRow[], links: readonly LinkRow[]): Map<string, Decided> {
  const byContact = new Map<string, LinkRow[]>();
  for (const l of links) byContact.set(l.contact_id, [...(byContact.get(l.contact_id) ?? []), l]);
  let visibleItem: (l: LinkRow) => boolean = () => true;
  if (!seesAll(u)) {
    const byKind = new Map<string, Set<string>>();
    for (const l of links) byKind.set(l.kind, (byKind.get(l.kind) ?? new Set()).add(l.item_id));
    const seen = new Map<string, Set<string>>();
    for (const [kind, ids] of byKind) seen.set(kind, contactKind(kind).visibleIds(u!, [...ids]));
    visibleItem = (l) => !!seen.get(l.kind)?.has(l.item_id);
  }
  const out = new Map<string, Decided>();
  for (const c of contacts) {
    const all = byContact.get(c.id) ?? [];
    const shown = all.filter(visibleItem);
    const visible = seesAll(u) || shown.length > 0 || (all.length === 0 && sameName(c.created_by, u!.username));
    out.set(c.id, { visible, links: shown, hidden: all.length - shown.length });
  }
  return out;
}

/** The contacts of `ids` the user may see (bulk). */
export function visibleContactIds(ids: readonly string[], u: AuthUser | null = currentUser()): Set<string> {
  const rows = [...contactRows(ids).values()];
  const d = decide(u, rows, seesAll(u) ? [] : linkRowsOfContacts(rows.map((r) => r.id)));
  return new Set([...d].filter(([, x]) => x.visible).map(([id]) => id));
}

/** Who may change a contact: administrators, who may change one item it is linked to, its creator while it is unlinked. */
function mayChange(u: AuthUser | null, c: ContactRow, links: readonly LinkRow[]): boolean {
  if (!u) return true;
  if (isAdmin(u)) return true;
  if (!links.length) return sameName(c.created_by, u.username);
  return links.some((l) => contactKind(l.kind).canChange(u, l.item_id));
}

/** One contact the user may see, with its links; 404 otherwise (also for a contact that is hidden from them). */
function visibleContact(id: string, u: AuthUser | null): { row: ContactRow; links: LinkRow[]; decided: Decided } {
  const row = contactRows([id]).get(id) ?? notFound(id);
  const links = linkRowsOfContacts([id]);
  const decided = decide(u, [row], links).get(id)!;
  if (!decided.visible) notFound(id);
  return { row, links, decided };
}

// ---------- shapes ----------

type Level = 'full' | 'names' | 'namesEmail';

/** What a link kind shows of a contact on a surface (CONTACT_EXPOSURE). */
export function exposureLevel(kind: ContactLinkKind, surface: ContactSurface): Level {
  if (surface === 'app') return 'full';
  const e = CONTACT_EXPOSURE[kind];
  if (e === 'asBefore') return 'full';
  if (e === 'app') return 'names';
  return surface === 'file' ? 'namesEmail' : 'names';
}

function refOf(r: ContactRow, level: Level = 'full'): ContactRef {
  const base: ContactRef = { id: r.id, kind: r.kind, name: r.name, status: r.status };
  if (level === 'names') return base;
  if (level === 'namesEmail') return { ...base, email: r.email };
  return { ...base, email: r.email, phone: r.phone, orgUnit: r.org_unit, url: r.url, user: r.username ?? null };
}

const listItem = (r: ContactRow, usedBy: number): ContactListItem => ({
  ...refOf(r),
  email: r.email,
  phone: r.phone,
  orgUnit: r.org_unit,
  url: r.url,
  usedBy,
});

// ---------- links of items (the API other modules use) ----------

const roleList = (kind: ContactLinkKind): readonly string[] | null => CONTACT_LINK_ROLES[kind];

function knownKind(kind: string): ContactLinkKind {
  if (!(kind in CONTACT_LINK_ROLES)) throw new HttpError(400, `Unknown contact link kind "${kind}"`, 'CONTACT_KIND_UNKNOWN', { kind });
  return kind as ContactLinkKind;
}

/** The order of an item's contacts: as entered (position, item-wide), then by role. */
function sortLinks(kind: ContactLinkKind, rows: { role: string; position: number }[]): void {
  const roles = roleList(kind);
  rows.sort((a, b) => a.position - b.position || (roles ? roles.indexOf(a.role) - roles.indexOf(b.role) : a.role.localeCompare(b.role)));
}

/**
 * The contacts of many items of one kind, in bulk (one statement per 500 items), in the shape the surface allows
 * (CONTACT_EXPOSURE; default `app`: everything). No visibility check: the caller reads items the reader may see, and
 * a contact linked to an item is seen by who sees the item.
 */
export function linksOf(kind: ContactLinkKind, itemIds: readonly string[], opts: { surface?: ContactSurface } = {}): Map<string, ContactLink[]> {
  const level = exposureLevel(kind, opts.surface ?? 'app');
  const rows = inChunks(itemIds, (part) =>
    db().all<ContactRow & { item_id: string; role: string; position: number }>(
      `SELECT l.item_id, l.role, l.position, ${CONTACT_COLUMNS} FROM contact_links l JOIN contacts c ON c.id = l.contact_id LEFT JOIN users u ON u.id = c.user_id
        WHERE l.kind = ? AND l.item_id IN (${marks(part.length)})`,
      kind,
      ...part,
    ),
  );
  sortLinks(kind, rows);
  const out = new Map<string, ContactLink[]>(itemIds.map((id) => [id, []]));
  for (const r of rows) out.get(r.item_id)?.push({ role: r.role, contact: refOf(r, level) });
  return out;
}

const linkList = z.array(contactLinkInput).max(CONTACT_LIMITS.perRole * 10);

export interface SetLinksResult {
  /** Links added and removed (role and contact) */
  added: { role: string; contactId: string; name: string }[];
  removed: { role: string; contactId: string; name: string }[];
  /** Contacts made on the way (inline) */
  created: string[];
}

/**
 * Replaces the contacts of an item (only those of `opts.roles`, if given) inside the caller's transaction. Each link
 * names an existing contact by id – one the user may see (else 404 CONTACT_NOT_FOUND, as if it did not exist), active
 * unless the item had it already (CONTACT_LEFT) – or a new contact, which is made (contact.created). Roles follow
 * CONTACT_LINK_ROLES (free text of at most 80 characters where the kind has no list), at most CONTACT_LIMITS.perRole
 * contacts per role; the same contact twice in one role counts once. The caller checks that the user may change the
 * item, and audits the item's change (the result says what was added and removed).
 */
export function setLinks(kind: ContactLinkKind, itemId: string, input: readonly ContactLinkInput[], opts: { roles?: readonly string[] } = {}): SetLinksResult {
  knownKind(kind);
  const links = linkList.parse(input);
  const roles = roleList(kind);
  const scope = opts.roles ? new Set(opts.roles) : null;
  const perRole = new Map<string, number>();
  for (const l of links) {
    if ((roles && !roles.includes(l.role)) || (scope && !scope.has(l.role)))
      throw new HttpError(400, `"${l.role}" is not a contact role here`, 'CONTACT_ROLE_UNKNOWN', { role: l.role });
    perRole.set(l.role, (perRole.get(l.role) ?? 0) + 1);
  }
  for (const [role, n] of perRole)
    if (n > CONTACT_LIMITS.perRole)
      throw new HttpError(400, `At most ${CONTACT_LIMITS.perRole} contacts per role`, 'CONTACT_ROLE_LIMIT', { role, max: CONTACT_LIMITS.perRole });
  const u = currentUser();
  return db().tx(() => {
    const existing = db()
      .all<LinkRow>('SELECT * FROM contact_links WHERE kind = ? AND item_id = ?', kind, itemId)
      .filter((l) => !scope || scope.has(l.role));
    const had = new Set(existing.map((l) => l.contact_id));
    // existing contacts named: the item's own ones are known; others must be visible and active
    const named = [...new Set(links.flatMap((l) => (l.contactId ? [l.contactId] : [])))];
    const rows = contactRows(named);
    const fresh = named.filter((id) => !had.has(id));
    const freshRows = fresh.map((id) => rows.get(id)).filter((r): r is ContactRow => !!r);
    const seen = decide(u, freshRows, seesAll(u) ? [] : linkRowsOfContacts(freshRows.map((r) => r.id)));
    for (const id of fresh) {
      const r = rows.get(id);
      if (!r || !seen.get(id)?.visible) notFound(id);
      if (r!.status === 'left') throw new HttpError(409, `${r!.name} has left – choose another contact`, 'CONTACT_LEFT', { name: r!.name });
    }
    const created: string[] = [];
    const wanted: { role: string; contactId: string; name: string }[] = [];
    for (const l of links) {
      let id = l.contactId;
      let name = id ? rows.get(id)!.name : '';
      if (!id) {
        const c = insertContact(contactInput.parse(l.contact), { audit: true });
        id = c.id;
        name = c.name;
        created.push(id);
      }
      if (!wanted.some((w) => w.role === l.role && w.contactId === id)) wanted.push({ role: l.role, contactId: id, name });
    }
    const key = (x: { role: string; contactId?: string; contact_id?: string }) => `${x.role}\u0000${x.contactId ?? x.contact_id}`;
    const before = new Map(existing.map((l) => [key(l), l]));
    const after = new Set(wanted.map(key));
    const oldNames = contactRows(existing.map((l) => l.contact_id));
    const removed = existing
      .filter((l) => !after.has(key(l)))
      .map((l) => ({ role: l.role, contactId: l.contact_id, name: oldNames.get(l.contact_id)?.name ?? '' }));
    const added = wanted.filter((w) => !before.has(key(w)));
    writeItemLinks(kind, itemId, wanted, { roles: opts.roles, existing: before });
    return { added, removed, created };
  });
}

/**
 * Writes an item's links as given (the caller validated the roles and that the user may name these contacts): the
 * kinds' own adapters (a plant site's free-text roles of up to 200 characters, an empty role) and the upgrade. Keeps
 * when and by whom a link that stays was made; positions follow the order given, after the item's other roles.
 */
export function writeItemLinks(
  kind: ContactLinkKind,
  itemId: string,
  links: readonly { role: string; contactId: string }[],
  opts: { roles?: readonly string[]; existing?: Map<string, LinkRow> } = {},
): void {
  const key = (role: string, contactId: string) => `${role}\u0000${contactId}`;
  const all = db().all<LinkRow>('SELECT * FROM contact_links WHERE kind = ? AND item_id = ?', kind, itemId);
  const scope = opts.roles ? new Set(opts.roles) : null;
  const before = opts.existing ?? new Map(all.filter((l) => !scope || scope.has(l.role)).map((l) => [key(l.role, l.contact_id), l]));
  const others = scope ? all.filter((l) => !scope.has(l.role)) : [];
  let pos = others.reduce((m, l) => Math.max(m, l.position + 1), 0);
  if (scope) {
    for (const role of scope) db().run('DELETE FROM contact_links WHERE kind = ? AND item_id = ? AND role = ?', kind, itemId, role);
  } else db().run('DELETE FROM contact_links WHERE kind = ? AND item_id = ?', kind, itemId);
  const ts = nowIso();
  const actor = currentActor();
  const done = new Set<string>();
  for (const w of links) {
    const k = key(w.role, w.contactId);
    if (done.has(k)) continue;
    done.add(k);
    const old = before.get(k);
    db().run(
      'INSERT INTO contact_links (kind, item_id, role, contact_id, position, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      kind,
      itemId,
      w.role,
      w.contactId,
      pos++,
      old?.created_at ?? ts,
      old?.created_by ?? actor,
    );
  }
}

/** Removes every contact link of an item that is deleted (the contacts stay in the directory). */
export function removeItemLinks(kind: ContactLinkKind, itemId: string): void {
  db().run('DELETE FROM contact_links WHERE kind = ? AND item_id = ?', kind, itemId);
}

/**
 * Who a documented decision names, frozen (ContactSnapshot): each contact must be one the user may see (404
 * CONTACT_NOT_FOUND otherwise, as if it did not exist) and active (409 CONTACT_LEFT: a contact who has left decides
 * nothing new). The same contact twice with the same role counts once.
 */
export function snapshotsOf(input: readonly { contactId: string; role: string }[], u: AuthUser | null = currentUser()): ContactSnapshot[] {
  if (input.length > CONTACT_LIMITS.decidedBy)
    throw new HttpError(400, `At most ${CONTACT_LIMITS.decidedBy} contacts`, 'CONTACT_DECIDED_BY_LIMIT', { max: CONTACT_LIMITS.decidedBy });
  const rows = contactRows(input.map((x) => x.contactId));
  const seen = decide(u, [...rows.values()], seesAll(u) ? [] : linkRowsOfContacts([...rows.keys()]));
  const out: ContactSnapshot[] = [];
  for (const x of input) {
    const r = rows.get(x.contactId);
    if (!r || !seen.get(r.id)?.visible) notFound(x.contactId);
    if (r!.status === 'left') throw new HttpError(409, `${r!.name} has left – choose another contact`, 'CONTACT_LEFT', { name: r!.name });
    const role = x.role.trim().slice(0, CONTACT_LIMITS.role);
    if (!out.some((o) => o.contactId === r!.id && o.role === role)) out.push({ contactId: r!.id, name: r!.name, role });
  }
  return out;
}

// ---------- making contacts ----------

type ParsedInput = z.infer<typeof contactInput>;

/** The users.id of a userId given as an id or a user name; 400 CONTACT_USER_UNKNOWN for neither. */
function userIdOf(v: string | null): string | null {
  if (!v) return null;
  const r =
    db().get<{ id: string }>('SELECT id FROM users WHERE id = ?', v) ?? db().get<{ id: string }>('SELECT id FROM users WHERE lower(username) = lower(?)', v);
  if (!r) throw new HttpError(400, `Unknown user ${v}`, 'CONTACT_USER_UNKNOWN', { user: v });
  return r.id;
}

/** Inserts a contact (unlinked); contact.created unless the caller audits itself (the upgrade's conversion). */
function insertContact(c: ParsedInput, opts: { audit: boolean }): ContactRow {
  const ts = nowIso();
  const actor = currentActor();
  const row: ContactRow = {
    id: newId(CONTACT_ID_PREFIX),
    kind: c.kind,
    name: c.name,
    name_norm: contactNameKey(c.name),
    email: c.email,
    email_norm: contactEmailKey(c.email),
    phone: c.phone,
    org_unit: c.orgUnit,
    url: c.url,
    user_id: userIdOf(c.userId),
    status: c.status,
    created_at: ts,
    created_by: actor,
    updated_at: ts,
    updated_by: actor,
  };
  db().run(
    `INSERT INTO contacts (id, kind, name, name_norm, email, email_norm, phone, org_unit, url, user_id, status, created_at, created_by, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.kind,
    row.name,
    row.name_norm,
    row.email,
    row.email_norm,
    row.phone,
    row.org_unit,
    row.url,
    row.user_id,
    row.status,
    ts,
    actor,
    ts,
    actor,
  );
  if (opts.audit)
    audit({
      action: 'contact.created',
      entityType: 'contact',
      entityId: row.id,
      summary: `Contact "${row.name}" created`,
      details: { kind: row.kind, name: row.name, email: !!row.email, phone: !!row.phone, user: !!row.user_id },
    });
  return row;
}

/** The first of `rows` the user may see: active ones first, then the oldest. */
function firstVisible(rows: ContactRow[], u: AuthUser | null): ContactRow | undefined {
  if (!rows.length) return undefined;
  const seen = decide(u, rows, seesAll(u) ? [] : linkRowsOfContacts(rows.map((r) => r.id)));
  return rows
    .filter((r) => seen.get(r.id)?.visible)
    .sort((a, b) => (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))[0];
}

interface MakeOpts {
  /** false: no contact.created entry (the caller audits a whole conversion once) */
  audit?: boolean;
}

/**
 * The person contact of a Steward account: an existing one linked to that user that the current user may see, else a
 * new one with the account's display name and e-mail address. Null when there is no such account. Documentation only:
 * the contact gives the user no right.
 */
export function contactForUser(userName: string, opts: MakeOpts = {}): ContactRef | null {
  const user = db().get<{ id: string; username: string; display_name: string; email: string | null }>(
    'SELECT id, username, display_name, email FROM users WHERE lower(username) = lower(?)',
    userName.replace(/^user:/i, '').trim(),
  );
  if (!user) return null;
  const rows = db().all<ContactRow>(`SELECT ${CONTACT_COLUMNS} FROM ${FROM_CONTACTS} WHERE c.user_id = ?`, user.id);
  const found = firstVisible(rows, currentUser());
  if (found) return refOf(found);
  const email = (user.email ?? '').trim();
  const c = insertContact(
    contactInput.parse({
      kind: 'person',
      name: (user.display_name || user.username).slice(0, CONTACT_LIMITS.name),
      email: z.string().email().safeParse(email).success ? email.slice(0, CONTACT_LIMITS.email) : '',
      userId: user.id,
    }),
    { audit: opts.audit !== false },
  );
  return refOf({ ...c, username: user.username });
}

/** The group contact of that name (a team, an office) the current user may see, else a new one. */
export function contactForGroup(name: string, opts: MakeOpts = {}): ContactRef {
  const clean =
    name
      .replace(/^team:/i, '')
      .trim()
      .slice(0, CONTACT_LIMITS.name) || '?';
  const rows = db().all<ContactRow>(`SELECT ${CONTACT_COLUMNS} FROM ${FROM_CONTACTS} WHERE c.kind = 'group' AND c.name_norm = ?`, contactNameKey(clean));
  const found = firstVisible(rows, currentUser());
  if (found) return refOf(found);
  return refOf(insertContact(contactInput.parse({ kind: 'group', name: clean }), { audit: opts.audit !== false }));
}

/**
 * A contact of a file import: the contact with the same e-mail address (case-insensitive) among those the importer may
 * see, else a new one. Without an e-mail address a new contact is made (the caller matches by name within one item). A
 * hidden contact with the same address is never matched – the import would reveal it.
 */
export function importContact(input: ContactInput, opts: MakeOpts = {}): ContactRef {
  const c = contactInput.parse(input);
  const email = contactEmailKey(c.email);
  if (email) {
    const rows = db().all<ContactRow>(`SELECT ${CONTACT_COLUMNS} FROM ${FROM_CONTACTS} WHERE c.email_norm = ? AND c.kind = ?`, email, c.kind);
    const same = rows.filter((r) => r.name_norm === contactNameKey(c.name));
    const found = firstVisible(same, currentUser()) ?? firstVisible(rows, currentUser());
    if (found) return refOf(found);
  }
  return refOf(insertContact(c, { audit: opts.audit !== false }));
}

// ---------- the kinds' own shapes of before 0.25.1 ----------

/**
 * A contact as services, suppliers and plant sites took and gave it before 0.25.1: name, role, e-mail address and –
 * where the kind had them – phone and web address. The kinds keep their APIs, exports and imports in that shape; the
 * directory holds the person.
 */
export interface LegacyContactEntry {
  role: string;
  name: string;
  email: string;
  phone?: string;
  url?: string;
}

type LegacyField = 'phone' | 'url';

const legacyDiffers = (r: ContactRow, e: LegacyContactEntry, fields: readonly LegacyField[]) =>
  r.name !== e.name || r.email !== e.email || fields.some((f) => (e[f] ?? '') !== (f === 'phone' ? r.phone : r.url));

/** Inserts a contact as a kind gave it, without the directory's own checks (its API validated it). */
function insertLegacy(e: LegacyContactEntry, fields: readonly LegacyField[], opts: { audit: boolean }): ContactRow {
  return insertContact(
    {
      kind: 'person',
      name: e.name,
      email: e.email,
      phone: fields.includes('phone') ? (e.phone ?? '') : '',
      orgUnit: '',
      url: fields.includes('url') ? (e.url ?? '') : '',
      userId: null,
      status: 'active',
    },
    opts,
  );
}

/** Changes the fields a kind owns of a contact it names (the item's form or import changed them). */
function updateLegacy(r: ContactRow, e: LegacyContactEntry, fields: readonly LegacyField[]): void {
  const phone = fields.includes('phone') ? (e.phone ?? '') : r.phone;
  const url = fields.includes('url') ? (e.url ?? '') : r.url;
  const changed = [
    ...(r.name !== e.name ? ['name'] : []),
    ...(r.email !== e.email ? ['email'] : []),
    ...(phone !== r.phone ? ['phone'] : []),
    ...(url !== r.url ? ['url'] : []),
  ];
  if (!changed.length) return;
  db().run(
    'UPDATE contacts SET name = ?, name_norm = ?, email = ?, email_norm = ?, phone = ?, url = ?, updated_at = ?, updated_by = ? WHERE id = ?',
    e.name,
    contactNameKey(e.name),
    e.email,
    contactEmailKey(e.email),
    phone,
    url,
    nowIso(),
    currentActor(),
    r.id,
  );
  audit({
    action: 'contact.updated',
    entityType: 'contact',
    entityId: r.id,
    summary: `Contact "${e.name}" changed: ${changed.join(', ')}`,
    details: { name: e.name, ...(e.name !== r.name ? { previousName: r.name } : {}), changed, status: r.status },
  });
}

/**
 * Writes an item's contacts given in its kind's own shape (a service's form or API, a plant site's form or import):
 * each entry is the contact the item names already with that e-mail address (without one: that name), else the one
 * with that address among the contacts the user may see, else a new one. The fields the kind owns are written to the
 * contact (the directory has one entry per person: a corrected name or phone number shows wherever it is named).
 * Returns the contact ids in the order of `entries`. In the caller's transaction; the caller checks the item's rights.
 */
export function writeLegacyLinks(kind: ContactLinkKind, itemId: string, entries: readonly LegacyContactEntry[], fields: readonly LegacyField[]): string[] {
  return db().tx(() => {
    const current = db().all<LinkRow>('SELECT * FROM contact_links WHERE kind = ? AND item_id = ?', kind, itemId);
    const rows = contactRows(current.map((l) => l.contact_id));
    const mine = [...rows.values()];
    const used = new Set<string>();
    const ids: string[] = [];
    for (const e of entries) {
      const email = contactEmailKey(e.email);
      const pick = (r: ContactRow) => (email ? r.email_norm === email : !r.email_norm && r.name_norm === contactNameKey(e.name));
      let r = mine.find((x) => pick(x) && !used.has(x.id)) ?? mine.find(pick);
      if (!r && email) {
        const cands = db().all<ContactRow>(`SELECT ${CONTACT_COLUMNS} FROM ${FROM_CONTACTS} WHERE c.email_norm = ?`, email);
        r = firstVisible(cands.filter((x) => x.name_norm === contactNameKey(e.name)), currentUser()) ?? firstVisible(cands, currentUser());
      }
      if (r) {
        if (legacyDiffers(r, e, fields)) updateLegacy(r, e, fields);
      } else {
        r = insertLegacy(e, fields, { audit: true });
        mine.push(r);
      }
      used.add(r.id);
      ids.push(r.id);
    }
    writeItemLinks(
      kind,
      itemId,
      entries.map((e, i) => ({ role: e.role, contactId: ids[i]! })),
    );
    return ids;
  });
}

/**
 * The upgrade's matcher (0.25.1): contacts of one kind's data before the directory become directory contacts. The same
 * e-mail address (case-insensitive) with the same name and the same phone and web address is one contact across the
 * kind's items; without an e-mail address, the same normalised name (and phone, web address) only within one item. A
 * contact never holds more than the entries it was made from showed – so nobody sees a detail they could not see
 * before; entries that differ stay apart (administrators see them under Possible duplicates). Contacts made earlier for
 * the same kind count (the conversion runs again after a migration package is imported).
 */
export class LegacyContactMatcher {
  private readonly byKey = new Map<string, string>();
  made = 0;
  constructor(
    private readonly kind: ContactLinkKind,
    private readonly fields: readonly LegacyField[],
  ) {
    const rows = db().all<ContactRow & { item_id: string }>(
      `SELECT DISTINCT l.item_id, ${CONTACT_COLUMNS} FROM contact_links l JOIN contacts c ON c.id = l.contact_id LEFT JOIN users u ON u.id = c.user_id WHERE l.kind = ?`,
      kind,
    );
    for (const r of rows) this.byKey.set(this.key({ name: r.name, email: r.email, phone: r.phone, url: r.url, role: '' }, r.item_id), r.id);
  }

  private key(e: LegacyContactEntry, itemKey: string): string {
    const extra = this.fields.map((f) => (e[f] ?? '').trim()).join('\u0000');
    const email = contactEmailKey(e.email);
    return email ? `e\u0000${email}\u0000${contactNameKey(e.name)}\u0000${extra}` : `n\u0000${itemKey}\u0000${contactNameKey(e.name)}\u0000${extra}`;
  }

  /** The contact of an entry of item `itemKey` (made when there is none yet; audited by the caller as a whole). */
  contactOf(e: LegacyContactEntry, itemKey: string): string {
    const k = this.key(e, itemKey);
    let id = this.byKey.get(k);
    if (!id) {
      id = insertLegacy({ ...e, name: e.name.trim() || e.email || '?' }, this.fields, { audit: false }).id;
      this.byKey.set(k, id);
      this.made++;
    }
    return id;
  }

  /** One audit entry for the conversion of the kind (contact.created, by system). */
  audit(items: number, links: number): void {
    if (!items) return;
    audit({
      actor: 'system',
      action: 'contact.created',
      entityType: 'contact',
      entityId: null,
      summary: `Contacts directory (0.25.1): ${this.made} contacts made from the contacts of ${items} ${this.kind} item(s), ${links} links`,
      details: { kind: this.kind, contacts: this.made, items, links, upgrade: '0.25.1' },
    });
  }
}

// ---------- the directory's pages ----------

/** Who may create contacts on the Contacts page: who works in Steward (the picker creates them on the item). */
export const canCreateContacts = (u: AuthUser | null = currentUser()): boolean => hasRole(u, ['admin', 'designer', 'operator', 'approver']);

export const contactListQuery = z
  .object({
    q: z.string().trim().max(200).default(''),
    status: z.enum(['active', 'left', 'all']).default('active'),
    limit: z.coerce.number().int().min(1).max(200).default(CONTACT_LIMITS.search),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .strict();

/**
 * The contacts the user may see that match `q` (name or e-mail address, normalised), by name. Administrators and
 * auditors page in SQL; everyone else reads candidates in pages of 500 and keeps the visible ones, so a hidden contact
 * is never counted.
 */
export function listContacts(query: z.input<typeof contactListQuery>): ContactList {
  const u = me();
  const q = contactListQuery.parse(query);
  const pattern = `%${likeEscape(contactNameKey(q.q))}%`;
  const where = [q.q ? `(c.name_norm LIKE ? ESCAPE '\\' OR c.email_norm LIKE ? ESCAPE '\\')` : '1 = 1', q.status === 'all' ? '1 = 1' : 'c.status = ?'].join(
    ' AND ',
  );
  const args = [...(q.q ? [pattern, pattern] : []), ...(q.status === 'all' ? [] : [q.status])];
  const page = (limit: number, offset: number) =>
    db().all<ContactRow>(`SELECT ${CONTACT_COLUMNS} FROM ${FROM_CONTACTS} WHERE ${where} ORDER BY c.name_norm, c.id LIMIT ? OFFSET ?`, ...args, limit, offset);
  const want = q.offset + q.limit + 1;
  const found: { row: ContactRow; usedBy: number }[] = [];
  // at most 100 pages of candidates (50,000 contacts) per request; `more` then says there may be more
  for (let offset = 0; found.length < want && offset < 100 * CHUNK; offset += CHUNK) {
    const rows = seesAll(u) ? page(want, 0) : page(CHUNK, offset);
    const d = decide(u, rows, linkRowsOfContacts(rows.map((r) => r.id)));
    for (const r of rows) if (d.get(r.id)!.visible) found.push({ row: r, usedBy: d.get(r.id)!.links.length });
    if (seesAll(u) || rows.length < CHUNK) break;
  }
  const items = found.slice(q.offset, q.offset + q.limit).map((f) => listItem(f.row, f.usedBy));
  return { items, more: found.length > q.offset + q.limit, canCreate: canCreateContacts(u) };
}

/** The where-used page of a contact (also a subject's personal data overview): links the reader may see, the others counted. */
export function getContact(id: string): ContactDetail {
  const u = me();
  const { row, links, decided } = visibleContact(id, u);
  const byKind = new Map<string, string[]>();
  for (const l of decided.links) byKind.set(l.kind, [...(byKind.get(l.kind) ?? []), l.item_id]);
  const names = new Map<string, Map<string, string>>();
  for (const [kind, ids] of byKind) names.set(kind, contactKind(kind).names(ids));
  const shown = decided.links.map((l) => ({
    kind: l.kind as ContactLinkKind,
    itemId: l.item_id,
    itemName: names.get(l.kind)?.get(l.item_id) ?? l.item_id,
    role: l.role,
    href: contactKind(l.kind).href(l.item_id),
  }));
  shown.sort((a, b) => a.kind.localeCompare(b.kind) || a.itemName.localeCompare(b.itemName) || a.role.localeCompare(b.role));
  let decisions = 0;
  for (const h of contactHooks()) decisions += h.countDecisions?.([id]).get(id) ?? 0;
  return {
    ...refOf(row),
    email: row.email,
    phone: row.phone,
    orgUnit: row.org_unit,
    url: row.url,
    links: shown,
    hiddenLinks: decided.hidden,
    decisions,
    canEdit: mayChange(u, row, links),
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

/** A contact made on the Contacts page: linked to nothing, so seen by its creator, administrators and auditors. */
export function createContact(input: ContactInput): ContactDetail {
  const u = me();
  if (!canCreateContacts(u)) forbid('create contacts', 'createContacts');
  const row = db().tx(() => insertContact(contactInput.parse(input), { audit: true }));
  return getContact(row.id);
}

const FIELDS: [keyof ParsedInput, keyof ContactRow][] = [
  ['kind', 'kind'],
  ['name', 'name'],
  ['email', 'email'],
  ['phone', 'phone'],
  ['orgUnit', 'org_unit'],
  ['url', 'url'],
  ['status', 'status'],
];

/** Changes a contact: who may change it (mayChange). Audited with the names of the fields that changed. */
export function updateContact(id: string, input: ContactInput): ContactDetail {
  const u = me();
  const { row, links } = visibleContact(id, u);
  if (!mayChange(u, row, links)) forbid('change this contact', 'changeContact');
  const c = contactInput.parse(input);
  const userId = userIdOf(c.userId);
  const changed = FIELDS.filter(([k, col]) => String(c[k] ?? '') !== String(row[col] ?? '')).map(([k]) => k as string);
  if (userId !== row.user_id) changed.push('userId');
  if (changed.length)
    db().tx(() => {
      db().run(
        `UPDATE contacts SET kind = ?, name = ?, name_norm = ?, email = ?, email_norm = ?, phone = ?, org_unit = ?, url = ?, user_id = ?, status = ?,
           updated_at = ?, updated_by = ? WHERE id = ?`,
        c.kind,
        c.name,
        contactNameKey(c.name),
        c.email,
        contactEmailKey(c.email),
        c.phone,
        c.orgUnit,
        c.url,
        userId,
        c.status,
        nowIso(),
        currentActor(),
        id,
      );
      audit({
        action: 'contact.updated',
        entityType: 'contact',
        entityId: id,
        summary: `Contact "${c.name}" changed: ${changed.join(', ')}`,
        details: { name: c.name, ...(c.name !== row.name ? { previousName: row.name } : {}), changed, status: c.status },
      });
    });
  return getContact(id);
}

/**
 * Replace with…: moves the contact's links to `targetId` – those on items the user may see and change (administrators:
 * all); visible links on items they may not change stay and are counted. A link the target already has on the same
 * item and role is merged. Audited per item (contact.replaced). `markLeft` marks the replaced contact as left.
 */
export function replaceContact(id: string, input: ContactReplaceInput): ContactReplaceResult {
  const u = me();
  const body = z
    .object({ targetId: z.string().trim().min(1).max(100), markLeft: z.boolean().default(false) })
    .strict()
    .parse(input);
  if (body.targetId === id) throw new HttpError(400, 'A contact cannot replace itself', 'CONTACT_REPLACE_SAME');
  const src = visibleContact(id, u);
  const target = visibleContact(body.targetId, u);
  if (target.row.status === 'left') throw new HttpError(409, `${target.row.name} has left – choose another contact`, 'CONTACT_LEFT', { name: target.row.name });
  const movable = src.decided.links.filter((l) => !u || isAdmin(u) || contactKind(l.kind).canChange(u, l.item_id));
  if (body.markLeft && !mayChange(u, src.row, src.links)) forbid('change this contact', 'changeContact');
  if (!movable.length && !body.markLeft) forbid('change the items this contact is linked to', 'changeContact');
  const has = new Set(target.links.map((l) => `${l.kind}\u0000${l.item_id}\u0000${l.role}`));
  db().tx(() => {
    for (const l of movable) {
      db().run('DELETE FROM contact_links WHERE kind = ? AND item_id = ? AND role = ? AND contact_id = ?', l.kind, l.item_id, l.role, id);
      if (!has.has(`${l.kind}\u0000${l.item_id}\u0000${l.role}`))
        db().run(
          'INSERT INTO contact_links (kind, item_id, role, contact_id, position, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
          l.kind,
          l.item_id,
          l.role,
          target.row.id,
          l.position,
          l.created_at,
          l.created_by,
        );
      audit({
        action: 'contact.replaced',
        entityType: l.kind,
        entityId: l.item_id,
        summary: `Contact "${src.row.name}" replaced by "${target.row.name}" (${l.role})`,
        details: { kind: l.kind, itemId: l.item_id, role: l.role, from: { id, name: src.row.name }, to: { id: target.row.id, name: target.row.name } },
      });
    }
    if (body.markLeft && src.row.status !== 'left') {
      db().run("UPDATE contacts SET status = 'left', updated_at = ?, updated_by = ? WHERE id = ?", nowIso(), currentActor(), id);
      audit({
        action: 'contact.updated',
        entityType: 'contact',
        entityId: id,
        summary: `Contact "${src.row.name}" changed: status`,
        details: { name: src.row.name, changed: ['status'], status: 'left' },
      });
    }
  });
  return { moved: movable.length, skipped: src.decided.links.length - movable.length, target: getContact(target.row.id) };
}

/**
 * Erase (administrators, GDPR Art. 17): the contact and its links are deleted. Documented decisions keep the name in
 * their frozen snapshot and get null as its id (the modules' onErased hooks, in this transaction); link kinds with rows
 * of their own per link delete them (onLinksErased). The audit entry names the contact's id and how many links went –
 * not the name, which is what is erased.
 */
export function eraseContact(id: string): void {
  requireAdmin('erase contacts', 'eraseContact');
  const row = contactRows([id]).get(id) ?? notFound(id);
  const links = linkRowsOfContacts([id]);
  db().tx(() => {
    db().run('DELETE FROM contact_links WHERE contact_id = ?', id);
    const byKind = new Map<string, string[]>();
    for (const l of links) byKind.set(l.kind, [...(byKind.get(l.kind) ?? []), l.item_id]);
    for (const [kind, ids] of byKind) contactKind(kind).onLinksErased?.([...new Set(ids)]);
    for (const h of contactHooks()) h.onErased?.(id);
    db().run('DELETE FROM contacts WHERE id = ?', id);
    audit({
      action: 'contact.erased',
      entityType: 'contact',
      entityId: id,
      summary: `Contact ${id} erased (${links.length} links)`,
      details: { kind: row.kind, links: links.length, kinds: [...byKind.keys()].sort() },
    });
  });
}

/** Administrators: contacts that share an e-mail address, with how many links each has. */
export function contactDuplicates(): ContactDuplicateGroup[] {
  requireAdmin('see possible duplicates', 'manageContacts');
  const emails = db()
    .all<{ email_norm: string }>("SELECT email_norm FROM contacts WHERE email_norm <> '' GROUP BY email_norm HAVING COUNT(*) > 1 ORDER BY email_norm LIMIT 500")
    .map((r) => r.email_norm);
  if (!emails.length) return [];
  const rows = inChunks(emails, (part) =>
    db().all<ContactRow>(`SELECT ${CONTACT_COLUMNS} FROM ${FROM_CONTACTS} WHERE c.email_norm IN (${marks(part.length)}) ORDER BY c.created_at, c.id`, ...part),
  );
  const counts = new Map<string, number>();
  for (const l of linkRowsOfContacts(rows.map((r) => r.id))) counts.set(l.contact_id, (counts.get(l.contact_id) ?? 0) + 1);
  return emails.map((email) => ({
    email,
    contacts: rows.filter((r) => r.email_norm === email).map((r) => ({ ...listItem(r, counts.get(r.id) ?? 0), links: counts.get(r.id) ?? 0 })),
  }));
}
