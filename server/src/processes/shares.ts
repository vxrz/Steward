import type { ProcessPermission } from '@sm/shared';
import { db } from '../db.js';
import { PROCESS_SHARE_MODEL, processAccess } from '../auth/policy.js';
import type { ShareKindDef } from '../auth/shares.js';

/**
 * Processes switched to shares (0.23.0, ADR 0033 phase 2, #297): their access lists became shares (migrations/access.ts)
 * and the Access tab replaces the access-list editor. The owner keeps every right – an implied Manage with every action
 * right, computed from the owner field. Who manages the process switches Restricted (decision 15).
 */
const row = (id: string) => db().get<{ name: string; owner: string | null }>('SELECT name, owner FROM processes WHERE id = ?', id);

export const PROCESS_SHARE_KIND: ShareKindDef<ProcessPermission> = {
  kind: 'process',
  model: PROCESS_SHARE_MODEL,
  name: (id) => row(id)?.name,
  link: (id) => `/processes/${id}`,
  rights: (u, id) => {
    const r = row(id);
    return r ? processAccess(u, { id, owner: r.owner }).permissions : [];
  },
  implied: (id) => {
    const owner = row(id)?.owner?.trim().toLowerCase();
    return owner ? [{ subject: `user:${owner}`, level: 'manage', as: 'owner' }] : [];
  },
  restrictBy: 'manage',
  // a migrated Custom entry with `manage` but not `edit` changed the access list: it still changes the shares (ADR 0033 "Migration")
  managesWith: 'manage',
};
