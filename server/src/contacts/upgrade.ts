import { convertServiceContacts } from '../catalogue/contacts.js';
import { convertSupplierContacts } from '../suppliers/contacts.js';
import { convertSiteContacts } from '../plant/contacts.js';
import { logger } from '../log.js';

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
