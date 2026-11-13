import type { PlatformPermission } from '@sm/shared';
import { db } from '../db.js';
import { IDENTITY_SHARE_MODEL, PLATFORM_SHARE_MODEL, identityAccess, platformAccess } from '../auth/policy.js';
import type { ShareKindDef } from '../auth/shares.js';

/**
 * Platforms and their identities switched to shares (0.23.0, ADR 0033 phase 2, #297): their access lists became shares
 * (migrations/access.ts).
 *
 * - A **platform** offers View (its page and health) and Manage (its configuration, credentials, shares, deletion),
 *   with `use` beside the level; who manages it switches Restricted (decision 15).
 * - An **identity** that is not the default has shares of its own: View with `use` (closed by default, ADR 0009). They
 *   are changed by who manages the platform – as its access list was – also when that person may not use the identity
 *   themselves: managing the platform's identities includes saying who uses them. An identity is never Restricted
 *   (instance roles give nothing on it anyway); the default identity has no shares – it is open to everyone with `use`
 *   on the platform.
 */
export const PLATFORM_SHARE_KIND: ShareKindDef<PlatformPermission> = {
  kind: 'platform',
  model: PLATFORM_SHARE_MODEL,
  name: (id) => db().get<{ name: string }>('SELECT name FROM platforms WHERE id = ?', id)?.name,
  link: (id) => `/platforms/${id}`,
  rights: (u, id) => platformAccess(u, { id }).permissions,
  restrictBy: 'manage',
};

const identity = (id: string) =>
  db().get<{ name: string; platform_id: string; is_default: number | boolean; platform: string }>(
    'SELECT i.name, i.platform_id, i.is_default, p.name AS platform FROM platform_identities i JOIN platforms p ON p.id = i.platform_id WHERE i.id = ?',
    id,
  );
const isDefault = (r: { is_default: number | boolean }) => Number(r.is_default) === 1 || r.is_default === true;

export const IDENTITY_SHARE_KIND: ShareKindDef<'use' | 'manage'> = {
  kind: 'platform_identity',
  model: IDENTITY_SHARE_MODEL,
  // the default identity has no shares of its own: the Access route answers it like a missing one
  name: (id) => {
    const r = identity(id);
    return r && !isDefault(r) ? `${r.platform} › ${r.name}` : undefined;
  },
  link: (id) => `/platforms/${identity(id)?.platform_id ?? ''}?tab=identities`,
  rights: (u, id) => {
    const r = identity(id);
    if (!r) return [];
    const platform = platformAccess(u, { id: r.platform_id }).permissions;
    if (platform.includes('manage')) return ['use', 'manage'];
    return identityAccess(u, { id: r.platform_id }, { id, default: isDefault(r) }).permissions;
  },
  restrictBy: 'never',
};
