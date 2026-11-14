import { db } from '../db.js';
import { parseJson } from '../util.js';
import { canEditService, canViewCatalogue } from '../records/access.js';
import type { ContactLink, ContactLinkInput, ServiceContact } from '@sm/shared';
import { moduleOnly } from '../auth/policy.js';
import type { ContactKindDef } from '../contacts/registry.js';
import { LegacyContactMatcher, linksOf, setLinks, writeItemLinks, writeLegacyLinks } from '../contacts/service.js';

/**
 * Services as a link kind of the contacts directory (ADR 0038, docs/CONTACTS.md): a service's business and IT
 * contacts are seen by who sees the service and changed by who may change it (owning teams, roles, shares, #131).
 * A module-only user (a plant viewer, ADR 0034) never reaches the catalogue, so never a service's contacts either.
 */
const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');

function serviceRows(ids: readonly string[]): { id: string; name: string; owners: string }[] {
  const out: { id: string; name: string; owners: string }[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    out.push(...db().all<{ id: string; name: string; owners: string }>(`SELECT id, name, owners FROM services WHERE id IN (${marks(part.length)})`, ...part));
  }
  return out;
}

export const serviceContactKind: ContactKindDef = {
  visibleIds: (u, ids) =>
    moduleOnly(u)
      ? new Set()
      : new Set(
          serviceRows(ids)
            .filter((r) => canViewCatalogue(u, { kind: 'service', id: r.id, owners: parseJson<string[]>(r.owners, []) }))
            .map((r) => r.id),
        ),
  canChange: (u, id) => {
    const r = moduleOnly(u) ? undefined : serviceRows([id])[0];
    return !!r && canEditService(u, { kind: 'service', id: r.id, owners: parseJson<string[]>(r.owners, []) });
  },
  names: (ids) => new Map(serviceRows(ids).map((r) => [r.id, r.name])),
  href: (id) => `/services/${encodeURIComponent(id)}`,
};

// ---------- a service's contacts in their shape of before 0.25.1 (role, e-mail, name) ----------

/** A service contact as the API, exports and imports gave it before 0.25.1; no name: the contact is named by its address. */
export function toServiceContact(l: ContactLink): ServiceContact {
  const email = l.contact.email ?? '';
  const name = l.contact.name;
  return { role: l.role as ServiceContact['role'], email, ...(name && name.toLowerCase() !== email.toLowerCase() ? { name } : {}) };
}

/**
 * The contacts of services, in bulk (one statement): from the directory – or, for a service the upgrade has not
 * converted yet (the conversion runs once the vault is open), its stored list.
 */
export function serviceContactsOf(rows: readonly { id: string; contacts: string }[]): Map<string, { contacts: ServiceContact[]; links: ContactLink[] }> {
  const links = linksOf(
    'service',
    rows.map((r) => r.id),
  );
  return new Map(
    rows.map((r) => {
      const stored = parseJson<ServiceContact[]>(r.contacts, []);
      const mine = links.get(r.id) ?? [];
      return [r.id, stored.length && !mine.length ? { contacts: stored, links: [] } : { contacts: mine.map(toServiceContact), links: mine }];
    }),
  );
}

/** Writes a service's contacts: in their old shape (the API, imports, duplicates) or as directory links (the web app's picker). */
export function writeServiceContacts(serviceId: string, input: { contacts: ServiceContact[]; contactLinks?: ContactLinkInput[] }): void {
  if (input.contactLinks) setLinks('service', serviceId, input.contactLinks);
  else
    writeLegacyLinks(
      'service',
      serviceId,
      input.contacts.map((c) => ({ role: c.role, email: c.email, name: c.name?.trim() || c.email })),
      [],
    );
  db().run("UPDATE services SET contacts = '[]' WHERE id = ? AND contacts <> '[]'", serviceId);
}

/**
 * The upgrade to 0.25.1 (ADR 0038): each service's stored contacts become directory contacts and links, once – a
 * service whose list is converted keeps an empty list. Runs once the vault is open and after a migration package is
 * imported; audited as a whole (contact.created by system). Returns the number of services converted.
 */
export function convertServiceContacts(): number {
  const rows = db()
    .all<{ id: string; contacts: string }>("SELECT id, contacts FROM services WHERE contacts IS NOT NULL AND contacts <> '[]'")
    .map((r) => ({ id: r.id, list: parseJson<ServiceContact[]>(r.contacts, []) }));
  if (!rows.length) return 0;
  const m = new LegacyContactMatcher('service', []);
  let links = 0;
  for (const r of rows)
    db().tx(() => {
      const entries = (Array.isArray(r.list) ? r.list : []).filter((c) => c && typeof c.email === 'string' && c.email.trim());
      const had = db().all<{ role: string; contact_id: string }>("SELECT role, contact_id FROM contact_links WHERE kind = 'service' AND item_id = ? ORDER BY position", r.id);
      const made = entries.map((c) => ({
        role: c.role,
        contactId: m.contactOf({ role: c.role, email: c.email.trim(), name: c.name?.trim() || c.email.trim() }, r.id),
      }));
      writeItemLinks('service', r.id, [...had.map((h) => ({ role: h.role, contactId: h.contact_id })), ...made]);
      db().run("UPDATE services SET contacts = '[]' WHERE id = ?", r.id);
      links += made.length;
    });
  m.audit(rows.length, links);
  return rows.length;
}
