import type { DataProductPermission } from '@sm/shared';
import { db } from '../db.js';
import { parseJson } from '../util.js';
import type { ShareKindDef } from '../auth/shares.js';
import { DATA_PRODUCT_SHARES, productAccess } from './access.js';

/**
 * Data products as a kind of the shares core (0.22.0, ADR 0036 part 12, ADR 0033; auth/shares.ts): what the expiry
 * job, its reminders and the product's Access tab need – the share model, the product's name and page, and a user's
 * rights through productAccess (shares, Restricted and module access included). The product owners' rights are implied
 * (Manage, computed from the owners field, never stored). Registered by the module's manifest.
 */
const row = (id: string) => db().get<{ name: string; owners: string }>('SELECT name, owners FROM dp_products WHERE id = ?', id);

export const DATA_PRODUCT_SHARE_KIND: ShareKindDef<DataProductPermission> = {
  kind: 'data_product',
  model: DATA_PRODUCT_SHARES,
  name: (id) => row(id)?.name,
  link: (id) => `/data-products/${encodeURIComponent(id)}`,
  rights: (u, id) => {
    const r = row(id);
    return r ? productAccess(u, { id, owners: r.owners }).permissions : [];
  },
  implied: (id) =>
    [...new Set(parseJson<string[]>(row(id)?.owners ?? '[]', []).map((s) => s.trim().toLowerCase()))]
      .filter((s) => /^(user|team):./.test(s))
      .map((subject) => ({ subject, level: 'manage' as const, as: 'owner' as const })),
};
