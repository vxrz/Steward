import { currentUser } from '../auth/context.js';
import { productAccess } from './access.js';
import { productRow } from './store.js';

/**
 * Whether the current reader may see a data product – for other modules that name products (an estimate's target,
 * ADR 0035 part 6): its rights, team scope and module access decide; a missing product is not visible. Without a
 * reader (background work) every product is.
 */
export function productVisibleTo(id: string): boolean {
  const row = productRow(id);
  if (!row) return false;
  const u = currentUser();
  if (!u) return true;
  return productAccess(u, row).permissions.length > 0;
}
