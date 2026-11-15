import { convertServiceContacts } from '../catalogue/contacts.js';
import { convertSupplierContacts } from '../suppliers/contacts.js';
import { convertSiteContacts } from '../plant/contacts.js';
import { logger } from '../log.js';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { forgetRoleCatalogue, insertUpgradeRole, roleCatalogue } from './roles.js';

/**
 * The upgrade to 0.25.1 (ADR 0038 part 1, docs/CONTACTS.md#upgrade): the contacts services, suppliers and plant sites
 * kept themselves become contacts of the directory and links, kind by kind, once – each item in a transaction of its
 * own, its stored list emptied in the same transaction, so a second run finds nothing to do. Run once the vault is
 * open (the audit log needs its key) and after a migration package is imported, like migrateVendorTexts. Until then the
 * kinds show their stored lists (catalogue/contacts.ts, plant/contacts.ts, suppliers/service.ts).
 *
 * Not part of the directory's core (contacts/service.ts imports no module): an entry point calls it.
 */
export function convertItemContacts(): { services: number; suppliers: number; sites: number } {
  const out = { services: convertServiceContacts(), suppliers: convertSupplierContacts(), sites: convertSiteContacts() };
  if (out.services || out.suppliers || out.sites)
    logger.info(out, 'contacts directory: the contacts of services, suppliers and plant sites converted (0.25.1)');
  return out;
}

const norm = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The upgrade to 0.26.0 (ADR 0039 part 1, docs/CONTACTS.md#upgrade-to-0260): each distinct free-text role of plant
 * sites (letter case and spaces aside) becomes an own role of the catalogue for plant sites – an own role of that label
 * an administrator made already is used – and the links name its key. The text becomes the role's label (English and
 * German), so the plant registry's files, /api/v1, MCP and change sets show the same text as before (variants that
 * differ only in letter case show as the most used one). A link without a role stays without.
 *
 * Idempotent: a role that is the key of an own role already is left alone, so a second run finds nothing to do –
 * it runs after convertItemContacts() when the vault is opened and after a migration package is imported. Each role in
 * a transaction of its own; one audit entry for the whole conversion (contact.role_created by system). Returns the
 * number of links rewritten.
 */
export function convertPlantSiteRoles(): { roles: number; links: number } {
  // the database may have been replaced (a migration package, a restore): read the catalogue afresh
  forgetRoleCatalogue();
  const texts = db().all<{ role: string; n: number }>(
    "SELECT role, COUNT(*) AS n FROM contact_links WHERE kind = 'plant_site' AND role <> '' GROUP BY role ORDER BY role",
  );
  if (!texts.length) return { roles: 0, links: 0 };
  const catalogue = roleCatalogue();
  // a link that names an own role's key is converted already – also when the role no longer applies to sites
  // (switched off for them since): own roles exist only from 0.26.0 on, made by this conversion or by administrators
  // after it, so no text of before is one's key. Built-in keys never apply to sites: such a text is a text.
  const ownKeys = new Set(catalogue.filter((r) => !r.builtIn).map((r) => r.key));
  const todo = texts.filter((t) => !ownKeys.has(t.role));
  if (!todo.length) return { roles: 0, links: 0 };
  // the texts by their normalised form; the label is the most used variant (then the first by text)
  const groups = new Map<string, { role: string; n: number }[]>();
  for (const t of todo) groups.set(norm(t.role), [...(groups.get(norm(t.role)) ?? []), { role: t.role, n: Number(t.n) }]);
  const taken = new Set(catalogue.map((r) => r.key));
  const made: { key: string; label: string; links: number; reused: boolean }[] = [];
  let links = 0;
  for (const [n, variants] of groups) {
    const label = [...variants].sort((a, b) => b.n - a.n || a.role.localeCompare(b.role))[0]!.role.trim();
    db().tx(() => {
      const own = roleCatalogue().find(
        (r) => !r.builtIn && r.kinds.includes('plant_site') && (norm(r.labels.en) === n || (!!r.labels.de && norm(r.labels.de) === n)),
      );
      const key = own?.key ?? insertUpgradeRole(label, ['plant_site'], taken, { fromSiteText: true });
      let count = 0;
      for (const v of variants) {
        // the same contact named on a site in two variants of the text: one link
        db().run(
          `DELETE FROM contact_links WHERE kind = 'plant_site' AND role = ? AND EXISTS (
             SELECT 1 FROM contact_links o WHERE o.kind = 'plant_site' AND o.item_id = contact_links.item_id AND o.role = ? AND o.contact_id = contact_links.contact_id)`,
          v.role,
          key,
        );
        count += Number(db().get<{ n: number }>("SELECT COUNT(*) AS n FROM contact_links WHERE kind = 'plant_site' AND role = ?", v.role)!.n);
        db().run("UPDATE contact_links SET role = ? WHERE kind = 'plant_site' AND role = ?", key, v.role);
      }
      made.push({ key, label, links: count, reused: !!own });
      links += count;
    });
    forgetRoleCatalogue();
  }
  audit({
    actor: 'system',
    action: 'contact.role_created',
    entityType: 'contact_role',
    entityId: null,
    summary: `Contact roles (0.26.0): ${made.filter((m) => !m.reused).length} roles made from the free-text roles of plant sites, ${links} links`,
    details: { kind: 'plant_site', upgrade: '0.26.0', roles: made, links },
  });
  logger.info({ roles: made.length, links }, 'contact roles: the free-text roles of plant sites converted (0.26.0)');
  return { roles: made.filter((m) => !m.reused).length, links };
}
