import type { LinkTarget } from '@sm/shared';
import { db } from '../db.js';
import { currentUser } from '../auth/context.js';
import { likeEscape } from '../database/sql.js';
import { moduleEnabled } from '../modules/registry.js';
import type { LinkResolver } from '../records/links.js';
import { objectAccess, productAccess } from './access.js';

/**
 * Data products and data objects as link kinds (ADR 0036 part 17): documents, records (change and incident records),
 * ticket references and the other link sources name them, and a product's Links tab lists them (GET /api/backlinks).
 * A target is resolved only while the module is on and only for a reader who may see it – otherwise the link is shown
 * without its name, as every link to a hidden item.
 */

const like = (q: string) => `%${likeEscape(q.trim().toLowerCase())}%`;

const productKind: LinkResolver = {
  resolve(id) {
    if (!moduleEnabled('dataProducts')) return null;
    const p = db().get<{ id: string; key: string; name: string; owners: string; lifecycle: string }>(
      'SELECT id, key, name, owners, lifecycle FROM dp_products WHERE id = ?',
      id,
    );
    if (!p || !productAccess(currentUser(), p).permissions.length) return null;
    return { label: p.name, path: `/data-products/${p.id}`, detail: p.key };
  },
  search(q, limit): LinkTarget[] {
    if (!moduleEnabled('dataProducts')) return [];
    const u = currentUser();
    return db()
      .all<{ id: string; key: string; name: string; owners: string }>(
        "SELECT id, key, name, owners FROM dp_products WHERE lower(name) LIKE ? ESCAPE '\\' OR lower(key) LIKE ? ESCAPE '\\' ORDER BY name_norm, id LIMIT 500",
        like(q),
        like(q),
      )
      .filter((p) => productAccess(u, p).permissions.length > 0)
      .slice(0, limit)
      .map((p) => ({ kind: 'data-product' as const, id: p.id, label: p.name, detail: p.key }));
  },
};

const objectKind: LinkResolver = {
  resolve(id) {
    if (!moduleEnabled('dataProducts')) return null;
    const o = db().get<{ id: string; key: string; name: string; owner: string | null; stewards: string }>(
      'SELECT id, key, name, owner, stewards FROM dp_objects WHERE id = ?',
      id,
    );
    if (!o || !objectAccess(currentUser(), o).permissions.length) return null;
    return { label: o.name, path: `/data-objects/${o.id}`, detail: o.key };
  },
  search(q, limit): LinkTarget[] {
    if (!moduleEnabled('dataProducts')) return [];
    const u = currentUser();
    return db()
      .all<{ id: string; key: string; name: string; owner: string | null; stewards: string }>(
        "SELECT id, key, name, owner, stewards FROM dp_objects WHERE lower(name) LIKE ? ESCAPE '\\' OR lower(key) LIKE ? ESCAPE '\\' ORDER BY name_norm, id LIMIT 500",
        like(q),
        like(q),
      )
      .filter((o) => objectAccess(u, o).permissions.length > 0)
      .slice(0, limit)
      .map((o) => ({ kind: 'data-object' as const, id: o.id, label: o.name, detail: o.key }));
  },
};

/** The link kinds of the data products module (features/dataproducts.ts registers them). */
export const DATA_PRODUCT_LINK_KIND_RESOLVERS: readonly { kind: string; resolver: LinkResolver }[] = [
  { kind: 'data-product', resolver: productKind },
  { kind: 'data-object', resolver: objectKind },
];
