import {
  CONTACT_LINK_ROLES,
  OWN_ROLE_KINDS,
  builtInContactRoles,
  contactRoleInput,
  contactRoleKey,
  contactRoleLabel,
  contactRoleOn,
  type ContactLinkKind,
  type ContactRole,
  type ContactRoleCardinality,
  type ContactRoleInput,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentUser } from '../auth/context.js';
import { me, requireAdmin } from '../auth/access.js';
import { contactKind } from './registry.js';
import { isAdmin } from '../auth/permissions.js';
import { HttpError, nowIso, parseJson } from '../util.js';

/**
 * The role catalogue of the contacts directory (0.26.0, ADR 0039 part 1, docs/CONTACTS.md#roles): which roles an item
 * of each link kind may name its contacts in. Administrators keep it under Settings → Contacts → Roles.
 *
 * - **Built-in roles** are every key of CONTACT_LINK_ROLES with the kinds that list it – Steward's own logic relies on
 *   them (product owner, domain owner, data owner and steward, consumer contact, the service and supplier roles, and
 *   the business owner and manager of applications and systems). They are part of the catalogue from the start; a row
 *   of `contact_roles` holds what an administrator changed: labels, description, cardinality, expected, the kinds of
 *   their seed it applies to (switched off per kind) and whether it is on at all. Never deleted or re-keyed.
 * - **Own roles** are documentation only (domain architect, technical lead, …): any kinds, deleted while unused.
 * - A role switched off – altogether or for a kind – takes no new links; links that name it stay and are marked.
 * - Changes are audited: contact.role_created, contact.role_updated, contact.role_deleted.
 *
 * The catalogue is read once and kept until it changes here (or a minute has passed: another process of the instance
 * may have changed it), so validating links and labelling them costs no statement of its own.
 */

interface RoleRow {
  key: string;
  label_en: string;
  label_de: string;
  description: string;
  kinds: string;
  cardinality: ContactRoleCardinality;
  expected: number | boolean;
  built_in: number | boolean;
  active: number | boolean;
  position: number;
  source: string;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

/** At most this many own roles (the catalogue is a short list people pick from). */
export const OWN_ROLE_LIMIT = 300;

let cached: { at: number; list: ContactRole[]; fromSiteText: Set<string> } | null = null;
const KEEP_MS = 60_000;

const LINK_KINDS = Object.keys(CONTACT_LINK_ROLES) as ContactLinkKind[];
const isLinkKind = (k: string): k is ContactLinkKind => (LINK_KINDS as string[]).includes(k);

function fromRow(r: RoleRow, seed?: ContactRole): ContactRole {
  const kinds = parseJson<string[]>(r.kinds, []).filter(isLinkKind);
  return {
    key: r.key,
    labels: { en: r.label_en, de: r.label_de },
    description: r.description,
    // a built-in role applies to a part of its seed's kinds at most
    kinds: seed ? kinds.filter((k) => seed.builtInKinds!.includes(k)) : kinds,
    ...(seed ? { builtInKinds: seed.builtInKinds } : {}),
    cardinality: r.cardinality === 'one' ? 'one' : 'many',
    expected: !!Number(r.expected),
    builtIn: !!seed,
    active: !!Number(r.active),
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

/** The whole catalogue: the built-in roles first (in their order), then the own roles by English label. */
export function roleCatalogue(now = Date.now()): ContactRole[] {
  if (cached && now - cached.at < KEEP_MS) return cached.list;
  const rows = db().all<RoleRow>('SELECT * FROM contact_roles ORDER BY position, label_en, key');
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const seeds = builtInContactRoles();
  const seedKeys = new Set(seeds.map((s) => s.key));
  const list = [
    ...seeds.map((s) => (byKey.has(s.key) ? fromRow(byKey.get(s.key)!, s) : s)),
    ...rows
      .filter((r) => !seedKeys.has(r.key))
      .map((r) => fromRow(r))
      .sort((a, b) => a.labels.en.localeCompare(b.labels.en) || a.key.localeCompare(b.key)),
  ];
  cached = { at: now, list, fromSiteText: new Set(rows.filter((r) => r.source === SITE_TEXT).map((r) => r.key)) };
  return list;
}

/** `source` of a role the upgrade made from a plant site's free-text role. */
const SITE_TEXT = 'plant_site_text';

/** The roles the upgrade made from plant sites' free texts that no administrator has saved since. */
const fromSiteText = (): Set<string> => {
  roleCatalogue();
  return cached?.fromSiteText ?? new Set();
};

/** Forgets the kept catalogue (tests, and after a change). */
export function forgetRoleCatalogue(): void {
  cached = null;
}

export const roleOf = (key: string): ContactRole | undefined => roleCatalogue().find((r) => r.key === key);

/** The label of a role (English unless `lang` says German); an unknown key – a kept free-text role – as it is. */
export const roleLabelOf = (key: string, lang = 'en'): string => contactRoleLabel(roleCatalogue(), key, lang);

/** The roles switched on for a kind, in the catalogue's order. */
export const rolesFor = (kind: ContactLinkKind): ContactRole[] => roleCatalogue().filter((r) => contactRoleOn(r, kind));

/** The roles that may apply to a kind at all (switched off or not) – for reading role texts of files and imports. */
const rolesOfKind = (kind: ContactLinkKind): ContactRole[] => roleCatalogue().filter((r) => r.kinds.includes(kind) || r.builtInKinds?.includes(kind));

const norm = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The key of a role a file, an import or a client names for a kind: a key of the catalogue's roles of that kind, else
 * a role of that kind whose English or German label is the text (letter case aside). Undefined for neither – the
 * caller refuses it with a hint (an import never makes a role on its own).
 */
export function roleKeyFor(kind: ContactLinkKind, text: string, opts: { anyOwn?: boolean } = {}): string | undefined {
  const t = text.trim();
  if (!t) return undefined;
  // anyOwn: own roles switched off for the kind too (plant sites: a kept link of a role switched off since)
  const roles = opts.anyOwn ? roleCatalogue().filter((r) => !r.builtIn || r.builtInKinds?.includes(kind)) : rolesOfKind(kind);
  const exact = roles.find((r) => r.key === t) ?? roles.find((r) => r.key.toLowerCase() === t.toLowerCase());
  if (exact) return exact.key;
  const n = norm(t);
  return roles.find((r) => norm(r.labels.en) === n || (!!r.labels.de && norm(r.labels.de) === n))?.key;
}

/** 400 CONTACT_ROLE_UNKNOWN with the hint where roles are added. */
export const unknownRole = (role: string): never => {
  throw new HttpError(400, `"${role}" is not a contact role here – administrators add roles under Settings → Contacts → Roles`, 'CONTACT_ROLE_UNKNOWN', {
    role,
  });
};

// ---------- keys of new roles ----------

/** A key made from a label: camelCase of its letters and digits (accents dropped), unique in the catalogue. */
export function newRoleKey(label: string, taken: ReadonlySet<string> = new Set(roleCatalogue().map((r) => r.key))): string {
  const words = label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  let base = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase())).join('');
  if (!/^[a-z]/.test(base)) base = `role${base[0]?.toUpperCase() ?? ''}${base.slice(1)}`;
  base = base.slice(0, 50) || 'role';
  const lower = new Set([...taken].map((k) => k.toLowerCase()));
  if (!lower.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!lower.has(`${base}${i}`.toLowerCase())) return `${base}${i}`;
}

// ---------- reading for the settings page ----------

/** Links per role and kind (administrators: whether a role is in use; nobody else is told about items they may not see). */
function usage(): Map<string, Partial<Record<ContactLinkKind, number>>> {
  const out = new Map<string, Partial<Record<ContactLinkKind, number>>>();
  for (const r of db().all<{ role: string; kind: string; n: number }>('SELECT role, kind, COUNT(*) AS n FROM contact_links GROUP BY role, kind')) {
    if (!isLinkKind(r.kind)) continue;
    const u = out.get(r.role) ?? {};
    u[r.kind] = Number(r.n);
    out.set(r.role, u);
  }
  return out;
}

/**
 * GET /api/contact-roles – every signed-in person (the pickers); administrators also get each role's usage. A role the
 * upgrade made from a plant site's free-text role – text that was shown only to who saw the site – is listed for others
 * only where they may see a site that names it (one statement and the sites' own visibility check), until an
 * administrator saves it: nobody learns a hidden site's text from the catalogue.
 */
export function listRoles(): ContactRole[] {
  const u = me();
  const list = roleCatalogue();
  const texts = fromSiteText();
  if (isAdmin(u)) {
    const used = usage();
    return list.map((r) => ({ ...r, usage: used.get(r.key) ?? {}, ...(texts.has(r.key) ? { fromSiteText: true } : {}) }));
  }
  if (!texts.size) return list;
  const marks = [...texts].map(() => '?').join(', ');
  const links = db().all<{ role: string; item_id: string }>(
    `SELECT DISTINCT role, item_id FROM contact_links WHERE kind = 'plant_site' AND role IN (${marks})`,
    ...texts,
  );
  const seen = contactKind('plant_site').visibleIds(u, [...new Set(links.map((l) => l.item_id))]);
  const shown = new Set(links.filter((l) => seen.has(l.item_id)).map((l) => l.role));
  return list.filter((r) => !texts.has(r.key) || shown.has(r.key));
}

// ---------- changing it (administrators) ----------

const notFound = (key: string): never => {
  throw new HttpError(404, `Contact role ${key} not found`, 'CONTACT_ROLE_NOT_FOUND', { key });
};

type Parsed = ReturnType<typeof contactRoleInput.parse>;

/** Two roles of one kind must not share a label: a role text of a file or an import would be ambiguous. */
/** Own roles apply to every kind but suppliers (OWN_ROLE_KINDS): a supplier's contact entries keep the supplier roles. */
function refuseOwnKinds(kinds: readonly ContactLinkKind[]): void {
  const refused = kinds.filter((k) => !OWN_ROLE_KINDS.includes(k));
  if (refused.length) throw new HttpError(400, `Own roles do not apply to ${refused.join(', ')}`, 'CONTACT_ROLE_OWN_KINDS', { kinds: refused.join(', ') });
}

function refuseLabelClash(key: string, input: Parsed, kinds: readonly ContactLinkKind[]): void {
  const mine = [input.labels.en, input.labels.de].filter(Boolean).map(norm);
  for (const r of roleCatalogue()) {
    if (r.key === key || !r.kinds.some((k) => kinds.includes(k))) continue;
    const theirs = [r.labels.en, r.labels.de].filter(Boolean).map(norm);
    const same = mine.find((l) => theirs.includes(l));
    if (same)
      throw new HttpError(409, `"${same}" is already the label of the role "${r.labels.en}" (${r.key}) for the same kind of item`, 'CONTACT_ROLE_LABEL_TAKEN', {
        label: same,
        role: r.labels.en,
      });
  }
}

function write(key: string, input: Parsed, opts: { builtIn: boolean; existing: RoleRow | undefined; position?: number; source?: string }): void {
  const u = currentUser();
  const actor = u?.username ?? 'system';
  const now = nowIso();
  if (opts.existing)
    db().run(
      `UPDATE contact_roles SET label_en = ?, label_de = ?, description = ?, kinds = ?, cardinality = ?, expected = ?, active = ?, source = '', updated_at = ?,
        updated_by = ? WHERE key = ?`,
      input.labels.en,
      input.labels.de,
      input.description,
      JSON.stringify(input.kinds),
      input.cardinality,
      input.expected ? 1 : 0,
      input.active ? 1 : 0,
      now,
      actor,
      key,
    );
  else
    db().run(
      `INSERT INTO contact_roles (key, label_en, label_de, description, kinds, cardinality, expected, built_in, active, position, source, created_at, created_by,
        updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      key,
      input.labels.en,
      input.labels.de,
      input.description,
      JSON.stringify(input.kinds),
      input.cardinality,
      input.expected ? 1 : 0,
      opts.builtIn ? 1 : 0,
      input.active ? 1 : 0,
      opts.position ?? 1000,
      opts.source ?? '',
      now,
      actor,
      now,
      actor,
    );
}

const summaryOf = (input: Pick<Parsed, 'labels' | 'kinds' | 'cardinality' | 'expected' | 'active'>) => ({
  labels: input.labels,
  kinds: input.kinds,
  cardinality: input.cardinality,
  expected: input.expected,
  active: input.active,
});

/**
 * Makes an own role (POST /api/contact-roles, administrators). The key is the one given or made from the English
 * label; a key that is taken – a built-in one too – is refused.
 */
export function createRole(body: unknown): ContactRole {
  requireAdmin('change the contact roles', 'manageContacts');
  const input = contactRoleInput.parse(body);
  const kinds = [...new Set(input.kinds)];
  if (!kinds.length) throw new HttpError(400, 'A role applies to at least one kind of item', 'CONTACT_ROLE_KINDS');
  refuseOwnKinds(kinds);
  const key = input.key ? contactRoleKey.parse(input.key) : newRoleKey(input.labels.en);
  if (roleCatalogue().some((r) => r.key.toLowerCase() === key.toLowerCase()))
    throw new HttpError(409, `The key "${key}" is taken`, 'CONTACT_ROLE_TAKEN', { key });
  refuseLabelClash(key, input, kinds);
  if (Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM contact_roles WHERE built_in = 0')!.n) >= OWN_ROLE_LIMIT)
    throw new HttpError(409, `At most ${OWN_ROLE_LIMIT} own roles`, 'CONTACT_ROLE_LIMIT_REACHED', { max: OWN_ROLE_LIMIT });
  const parsed = { ...input, kinds };
  db().tx(() => {
    write(key, parsed, { builtIn: false, existing: undefined });
    audit({
      action: 'contact.role_created',
      entityType: 'contact_role',
      entityId: key,
      summary: `Contact role "${input.labels.en}" (${key}) created`,
      details: { key, ...summaryOf(parsed) },
    });
  });
  forgetRoleCatalogue();
  return roleOf(key)!;
}

/**
 * Changes a role (PUT /api/contact-roles/:key, administrators): labels, description, kinds, cardinality, expected,
 * on or off. A built-in role keeps its key and applies to a part of its own kinds at most (switched off per kind);
 * links that name a role switched off stay (marked).
 */
export function updateRole(rawKey: string, body: unknown): ContactRole {
  requireAdmin('change the contact roles', 'manageContacts');
  const key = String(rawKey);
  const current = roleOf(key) ?? notFound(key);
  const input = contactRoleInput.parse(body);
  if (input.key !== undefined && input.key !== key)
    throw new HttpError(409, `The key of a role never changes ("${key}")`, 'CONTACT_ROLE_BUILT_IN', { key, context: 'key' });
  const kinds = [...new Set(input.kinds)];
  if (current.builtIn) {
    const extra = kinds.filter((k) => !current.builtInKinds!.includes(k));
    if (extra.length)
      throw new HttpError(409, `The built-in role "${current.labels.en}" applies only to its own kinds`, 'CONTACT_ROLE_BUILT_IN', { key, context: 'kinds' });
  } else {
    if (!kinds.length) throw new HttpError(400, 'A role applies to at least one kind of item', 'CONTACT_ROLE_KINDS');
    refuseOwnKinds(kinds);
  }
  const parsed = { ...input, kinds };
  refuseLabelClash(key, parsed, kinds);
  const existing = db().get<RoleRow>('SELECT * FROM contact_roles WHERE key = ?', key);
  const before = summaryOf(current);
  const after = summaryOf(parsed);
  const changed: string[] = (Object.keys(after) as (keyof typeof after)[]).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
  if (current.description !== parsed.description) changed.push('description');
  if (!changed.length) return current;
  const position = current.builtIn ? builtInContactRoles().findIndex((r) => r.key === key) : undefined;
  db().tx(() => {
    write(key, parsed, { builtIn: current.builtIn, existing, position });
    audit({
      action: 'contact.role_updated',
      entityType: 'contact_role',
      entityId: key,
      summary: `Contact role "${parsed.labels.en}" (${key}) changed: ${changed.join(', ')}`,
      details: { key, builtIn: current.builtIn, changed, before, after },
    });
  });
  forgetRoleCatalogue();
  return roleOf(key)!;
}

/** Deletes an own role nobody names any more (DELETE /api/contact-roles/:key, administrators). */
export function deleteRole(rawKey: string): void {
  requireAdmin('change the contact roles', 'manageContacts');
  const key = String(rawKey);
  const current = roleOf(key) ?? notFound(key);
  if (current.builtIn)
    throw new HttpError(409, `"${current.labels.en}" is a built-in role – switch it off instead`, 'CONTACT_ROLE_BUILT_IN', { key, context: 'delete' });
  const n = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM contact_links WHERE role = ?', key)!.n);
  if (n)
    throw new HttpError(409, `"${current.labels.en}" is in use (${n} links) – switch it off instead`, 'CONTACT_ROLE_IN_USE', {
      role: current.labels.en,
      count: n,
    });
  db().tx(() => {
    db().run('DELETE FROM contact_roles WHERE key = ?', key);
    audit({
      action: 'contact.role_deleted',
      entityType: 'contact_role',
      entityId: key,
      summary: `Contact role "${current.labels.en}" (${key}) deleted`,
      details: { key, labels: current.labels, kinds: current.kinds },
    });
  });
  forgetRoleCatalogue();
}

/**
 * An own role made by the upgrade (no administrator: as the system, audited by the caller as a whole): the text as its
 * English and German label, the given kinds.
 */
export function insertUpgradeRole(label: string, kinds: readonly ContactLinkKind[], taken: Set<string>, opts: { fromSiteText?: boolean } = {}): string {
  const key = newRoleKey(label, taken);
  taken.add(key);
  const text = label.trim().slice(0, 200);
  write(
    key,
    { labels: { en: text, de: text }, description: '', kinds: [...kinds], cardinality: 'many', expected: false, active: true },
    { builtIn: false, existing: undefined, source: opts.fromSiteText ? SITE_TEXT : '' },
  );
  return key;
}

/** An own role made by Steward itself (the demo), audited as contact.role_created by system. */
export function makeSystemRole(label: string, kinds: readonly ContactLinkKind[]): string {
  const key = db().tx(() => {
    const k = insertUpgradeRole(label, kinds, new Set(roleCatalogue().map((r) => r.key)));
    audit({
      actor: 'system',
      action: 'contact.role_created',
      entityType: 'contact_role',
      entityId: k,
      summary: `Contact role "${label.trim()}" (${k}) created`,
      details: { key: k, labels: { en: label.trim(), de: label.trim() }, kinds },
    });
    return k;
  });
  forgetRoleCatalogue();
  return key;
}

export type { ContactRoleInput };
