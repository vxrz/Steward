import type { MonitorPermission } from '@sm/shared';
import { db } from '../db.js';
import { MONITOR_SHARE_MODEL } from '../auth/policy.js';
import type { ShareKindDef } from '../auth/shares.js';
import { monitorAccess } from './model.js';

/**
 * Monitors (and monitor templates) switched to shares (0.23.0, ADR 0033 phase 2, #297): their access lists became
 * shares (migrations/access.ts). The owner keeps every right – an implied Manage, computed from the owner field.
 */
const row = (id: string) => db().get<{ name: string; owner: string }>('SELECT name, owner FROM monitors WHERE id = ?', id);

export const MONITOR_SHARE_KIND: ShareKindDef<MonitorPermission> = {
  kind: 'monitor',
  model: MONITOR_SHARE_MODEL,
  name: (id) => row(id)?.name,
  link: (id) => `/monitors/${id}`,
  rights: (u, id) => {
    const r = row(id);
    return r ? monitorAccess(u, { id, owner: r.owner }).permissions : [];
  },
  implied: (id) => {
    const owner = row(id)?.owner?.trim().toLowerCase();
    return owner ? [{ subject: `user:${owner}`, level: 'manage', as: 'owner' }] : [];
  },
  restrictBy: 'manage',
};
