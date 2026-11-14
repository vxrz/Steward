import type { DataProductPermission } from '@sm/shared';
import { db } from '../db.js';
import type { ShareKindDef } from '../auth/shares.js';
import { DATA_PRODUCT_SHARES, domainAccess, objectAccess, productAccess } from './access.js';

/**
 * Data products, domains and data objects as kinds of the shares core (ADR 0036 part 12, ADR 0033; auth/shares.ts):
 * what the expiry job, its reminders and the items' Access tabs need – the share model, the item's name and page, and a
 * user's rights through the module's access functions (shares, Restricted and module access included). Registered by
 * the module's manifest.
 *
 * Since 0.25.1 (ADR 0038 part 2) owner fields imply no share: product owners, domain owners, a data object's owner and
 * stewards are contacts. Domains and data objects are kinds of the shares core since then, so that who held a right
 * only through such a field keeps it as an explicit share (migrations/dataproducts.ts `dataproducts-007a-owner-shares`).
 */
const nameOf = (table: 'dp_products' | 'dp_domains' | 'dp_objects', id: string) =>
  db().get<{ name: string }>(`SELECT name FROM ${table} WHERE id = ?`, id)?.name;
const exists = (table: 'dp_products' | 'dp_domains' | 'dp_objects', id: string) => !!db().get(`SELECT 1 FROM ${table} WHERE id = ?`, id);

export const DATA_PRODUCT_SHARE_KIND: ShareKindDef<DataProductPermission> = {
  kind: 'data_product',
  model: DATA_PRODUCT_SHARES,
  name: (id) => nameOf('dp_products', id),
  link: (id) => `/data-products/${encodeURIComponent(id)}`,
  rights: (u, id) => (exists('dp_products', id) ? productAccess(u, { id }).permissions : []),
};

export const DATA_DOMAIN_SHARE_KIND: ShareKindDef<DataProductPermission> = {
  kind: 'data_domain',
  model: DATA_PRODUCT_SHARES,
  name: (id) => nameOf('dp_domains', id),
  link: (id) => `/data-domains?open=${encodeURIComponent(id)}`,
  rights: (u, id) => (exists('dp_domains', id) ? domainAccess(u, { id }).permissions : []),
};

export const DATA_OBJECT_SHARE_KIND: ShareKindDef<DataProductPermission> = {
  kind: 'data_object',
  model: DATA_PRODUCT_SHARES,
  name: (id) => nameOf('dp_objects', id),
  link: (id) => `/data-objects/${encodeURIComponent(id)}`,
  rights: (u, id) => (exists('dp_objects', id) ? objectAccess(u, { id }).permissions : []),
};

export const DATA_PRODUCT_MODULE_SHARE_KINDS = [DATA_PRODUCT_SHARE_KIND, DATA_DOMAIN_SHARE_KIND, DATA_OBJECT_SHARE_KIND] as const;
