import { PLANT_PERMISSIONS, type AclEntry, type AccessReason, type PlantPermission, type Role } from '@sm/shared';
import type { AuthUser } from '../auth/context.js';
import { currentUser } from '../auth/context.js';
import { decide } from '../auth/policy.js';
import { forbid } from '../auth/access.js';
import { db } from '../db.js';
import { parseJson } from '../util.js';

/**
 * Rights in the plant registry (#218): per site, through the one policy module (auth/policy.ts, ADR 0006). Assets,
 * the hierarchy and the buildings of a site follow the site.
 *
 * - Without owning teams and without an access list: every signed-in role sees the site (as the catalogue), designers
 *   and administrators manage it, the role "plant" (Plant viewer) sees it, status viewers never.
 * - An access list restricts the site to its entries (view or manage), as with processes and platforms.
 * - With owning teams: their members have their instance and team roles on it; auditors see it; administrators always
 *   manage it.
 */
export const DEFAULT_PLANT: Record<Role, PlantPermission[]> = {
  admin: ['view', 'manage'],
  designer: ['view', 'manage'],
  operator: ['view'],
  approver: ['view'],
  auditor: ['view'],
  viewer: ['view'],
  status: [],
  plant: ['view'],
};

/** Who may add sites (and import files with new sites). */
const SITE_CREATORS: readonly Role[] = ['admin', 'designer'];

export function siteAccess(
  u: AuthUser | null,
  s: { id: string; acl: AclEntry<PlantPermission>[] | string },
): { permissions: PlantPermission[]; reasons: AccessReason[] } {
  const acl = typeof s.acl === 'string' ? parseJson<AclEntry<PlantPermission>[]>(s.acl, []) : s.acl;
  const d = decide(u, { kind: 'site', id: s.id, acl }, PLANT_PERMISSIONS, DEFAULT_PLANT, 'view');
  // managing a site includes seeing it
  if (d.permissions.includes('manage') && !d.permissions.includes('view')) d.permissions = [...PLANT_PERMISSIONS];
  return d;
}

export const sitePermissions = (s: { id: string; acl: string }, u: AuthUser | null = currentUser()): PlantPermission[] => siteAccess(u, s).permissions;

export const canCreateSites = (u: AuthUser | null = currentUser()): boolean => !!u && u.roles.some((r) => SITE_CREATORS.includes(r));

/**
 * The rights on every site, read once (lists of assets check many rows of few sites). Unknown sites: no rights.
 */
export function siteRights(rows: { id: string; acl: string }[], u: AuthUser | null = currentUser()): Map<string, PlantPermission[]> {
  return new Map(rows.map((r) => [r.id, sitePermissions(r, u)]));
}

export function requireManage(perms: PlantPermission[], what: string): void {
  if (!perms.includes('manage')) forbid(what, 'managePlant');
}

/** Whether someone may add a site or manage at least one (the sidebar's Import, the import's own check). */
export function plantManagesSome(u: AuthUser | null = currentUser()): boolean {
  if (canCreateSites(u)) return true;
  return db()
    .all<{ id: string; acl: string }>('SELECT id, acl FROM plant_sites')
    .some((r) => sitePermissions(r, u).includes('manage'));
}
