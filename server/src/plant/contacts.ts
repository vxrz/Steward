import type { ContactLink, ContactLinkInput, SiteContact } from '@sm/shared';
import { db } from '../db.js';
import { parseJson } from '../util.js';
import type { ContactKindDef } from '../contacts/registry.js';
import { LegacyContactMatcher, linksOf, setLinks, writeItemLinks, writeLegacyLinks } from '../contacts/service.js';
import { plantManagesSome, siteRights } from './access.js';
import { plantEnabled } from './settings.js';

/**
 * Plant sites as a link kind of the contacts directory (0.25.1, ADR 0038, docs/CONTACTS.md): a site's contacts – free-text
 * roles – are seen by who sees the site and changed by who manages it. The plant registry's API, YAML import and
 * export, change sets and history keep a site's contacts in their shape of before (name, role, e-mail, phone, URL);
 * the directory holds the person.
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

/** A site contact as before 0.25.1: name, role, e-mail address, phone, URL. */
export const toSiteContact = (l: ContactLink): SiteContact => ({
  name: l.contact.name,
  role: l.role,
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
  else writeLegacyLinks('plant_site', siteId, contacts, ['phone', 'url']);
}

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
