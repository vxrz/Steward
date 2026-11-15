import type { ContactLink, ContactLinkInput, SiteContact } from '@sm/shared';
import { db } from '../db.js';
import { parseJson } from '../util.js';
import type { ContactKindDef } from '../contacts/registry.js';
import { LegacyContactMatcher, linksOf, setLinks, writeItemLinks, writeLegacyLinks } from '../contacts/service.js';
import { makeSystemRole, roleKeyFor, roleLabelOf, roleOf } from '../contacts/roles.js';
import { plantManagesSome, siteRights } from './access.js';
import { plantEnabled } from './settings.js';

/**
 * Plant sites as a link kind of the contacts directory (0.25.1, ADR 0038, docs/CONTACTS.md): a site's contacts are seen
 * by who sees the site and changed by who manages it. The plant registry's API, YAML import and export, change sets and
 * history keep a site's contacts in their shape of before (name, role, e-mail, phone, URL); the directory holds the
 * person.
 *
 * Roles (0.26.0, ADR 0039 part 1): a site's free-text roles became own roles of the catalogue at the upgrade
 * (contacts/upgrade.ts convertPlantSiteRoles). The shape of before shows the role's English label where the text was,
 * and takes the text back: a role's key or label (letter case aside) is that role; a text that is neither is refused
 * with a hint (an import never makes a role), unless the site names it already (a text that was kept).
 */
const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');

function siteRows(ids: readonly string[]): { id: string; name: string; acl: string }[] {
  const out: { id: string; name: string; acl: string }[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    out.push(...db().all<{ id: string; name: string; acl: string }>(`SELECT id, name, acl FROM plant_sites WHERE id IN (${marks(part.length)})`, ...part));
  }
  return out;
}

export const plantSiteContactKind: ContactKindDef = {
  visibleIds: (u, ids) => {
    if (!plantEnabled()) return new Set();
    const rows = siteRows(ids);
    const rights = siteRights(rows, u);
    return new Set(rows.filter((r) => rights.get(r.id)?.includes('view')).map((r) => r.id));
  },
  canChange: (u, id) =>
    plantEnabled() &&
    !!siteRights(siteRows([id]), u)
      .get(id)
      ?.includes('manage'),
  names: (ids) => new Map(siteRows(ids).map((r) => [r.id, r.name])),
  href: (id) => `/plant/sites/${encodeURIComponent(id)}`,
  // who manages a site (a plant registry manager without a core role too) creates contacts for it
  createsContacts: (u) => plantEnabled() && plantManagesSome(u),
};

/**
 * The text of a site contact's role: the role's English label – an own role (sites have no built-in role); a text of
 * before that was kept, or one the upgrade has not converted yet, as it is.
 */
export const siteRoleLabel = (role: string): string => {
  const r = role ? roleOf(role) : undefined;
  return r && !r.builtIn ? roleLabelOf(role) : role;
};

/** A site contact as before 0.25.1: name, role, e-mail address, phone, URL. */
export const toSiteContact = (l: ContactLink): SiteContact => ({
  name: l.contact.name,
  role: siteRoleLabel(l.role),
  email: l.contact.email ?? '',
  phone: l.contact.phone ?? '',
  url: l.contact.url ?? '',
});

/**
 * The contacts of sites, in bulk (one statement): from the directory – or, for a site the upgrade has not converted yet
 * (the conversion runs once the vault is open), its stored list.
 */
export function siteContactsOf(rows: readonly { id: string; contacts: string }[]): Map<string, SiteContact[]> {
  const links = linksOf(
    'plant_site',
    rows.map((r) => r.id),
  );
  return new Map(
    rows.map((r) => {
      const stored = parseJson<SiteContact[]>(r.contacts, []);
      const mine = links.get(r.id) ?? [];
      return [r.id, stored.length && !mine.length ? stored : mine.map(toSiteContact)];
    }),
  );
}

/** The directory links of a site (the web app's picker). */
export const siteContactLinks = (id: string): ContactLink[] => linksOf('plant_site', [id]).get(id) ?? [];

/**
 * Writes a site's contacts (the site's form or API, the YAML import, an applied change set): in their old shape, or as
 * directory links (the picker). The stored list stays empty.
 */
export function writeSiteContacts(siteId: string, contacts: readonly SiteContact[], links?: ContactLinkInput[]): void {
  if (links) setLinks('plant_site', siteId, links);
  else
    writeLegacyLinks(
      'plant_site',
      siteId,
      contacts.map((c) => ({ ...c, role: siteRoleKey(c.role ?? '') })),
      ['phone', 'url'],
    );
}

/**
 * Whether a site contact's role text may be written (the import's preview): none, a role of the catalogue for sites
 * (its key or label), or a text the site shows already (`current`: its contacts in the shape of before).
 */
export function siteRoleKnown(text: string, current: readonly SiteContact[]): boolean {
  const t = (text ?? '').trim();
  if (!t) return true;
  const key = roleKeyFor('plant_site', t) ?? roleKeyFor('plant_site', t, { anyOwn: true });
  if (key) return true;
  return current.some((c) => c.role === t);
}

/**
 * The demo and the examples (0.26.0): the own roles of sites that these texts name, made where the catalogue has none
 * (as the system, audited) – "Load demo data" loads a file whose sites name roles, and an import never makes one.
 */
export function ensureSiteRoles(texts: readonly string[]): string[] {
  const made: string[] = [];
  for (const t of [...new Set(texts.map((x) => x.trim()).filter(Boolean))]) {
    if (roleKeyFor('plant_site', t, { anyOwn: true })) continue;
    made.push(makeSystemRole(t, ['plant_site']));
  }
  return made;
}

/** The role a site contact's text names (its key or label, letter case aside), else the text as it is (checked by the writer). */
export const siteRoleKey = (text: string): string =>
  text.trim() ? (roleKeyFor('plant_site', text) ?? roleKeyFor('plant_site', text, { anyOwn: true }) ?? text) : '';

/**
 * The upgrade to 0.25.1 (ADR 0038): each site's stored contacts become directory contacts and links, once – a converted
 * site keeps an empty list. Runs once the vault is open and after a migration package is imported; audited as a whole.
 */
export function convertSiteContacts(): number {
  const rows = db()
    .all<{ id: string; contacts: string }>("SELECT id, contacts FROM plant_sites WHERE contacts IS NOT NULL AND contacts <> '[]'")
    .map((r) => ({ id: r.id, list: parseJson<SiteContact[]>(r.contacts, []) }));
  if (!rows.length) return 0;
  const m = new LegacyContactMatcher('plant_site', ['phone', 'url']);
  let links = 0;
  for (const r of rows)
    db().tx(() => {
      const entries = (Array.isArray(r.list) ? r.list : []).filter((c) => c && typeof c.name === 'string' && c.name.trim());
      const had = db().all<{ role: string; contact_id: string }>(
        "SELECT role, contact_id FROM contact_links WHERE kind = 'plant_site' AND item_id = ? ORDER BY position",
        r.id,
      );
      const made = entries.map((c) => ({
        role: c.role ?? '',
        contactId: m.contactOf({ role: c.role ?? '', name: c.name, email: c.email ?? '', phone: c.phone ?? '', url: c.url ?? '' }, r.id),
      }));
      writeItemLinks('plant_site', r.id, [...had.map((h) => ({ role: h.role, contactId: h.contact_id })), ...made]);
      db().run("UPDATE plant_sites SET contacts = '[]' WHERE id = ?", r.id);
      links += made.length;
    });
  m.audit(rows.length, links);
  return rows.length;
}
