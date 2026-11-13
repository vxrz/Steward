import { PLANT_PERMISSIONS, type AccessReason, type PlantPermission, type Role } from '@sm/shared';
import type { AuthUser } from '../auth/context.js';
import { currentUser } from '../auth/context.js';
import { SITE_SHARE_MODEL, decide } from '../auth/policy.js';
import { forbid, hasRole } from '../auth/access.js';
import { db } from '../db.js';
import { usesModule } from '../modules/access.js';

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
  admin: ['view', 'propose', 'manage'],
  designer: ['view', 'propose', 'manage'],
  // 0.13.0: who knows the data best may keep drafts and propose changes (ADR 0020, owner decision 1) – never apply them
  operator: ['view', 'propose'],
  approver: ['view', 'propose'],
  auditor: ['view'],
  viewer: ['view'],
  status: [],
  plant: ['view', 'propose'],
};

/** Who may add sites (and import files with new sites). */
const SITE_CREATORS: readonly Role[] = ['admin', 'designer'];

/** The rights on a site: owning teams, shares and the Restricted scope (the `acl` passed is no longer read, 0.23.0). */
export function siteAccess(u: AuthUser | null, s: { id: string; acl?: unknown }): { permissions: PlantPermission[]; reasons: AccessReason[] } {
  // someone who does not use the plant registry (ADR 0034) has no right on a site: wherever a core page names a site
  // or an asset (maintenance targets, impact, links), they see nothing of it
  if (u && !usesModule(u, 'plant')) return { permissions: [], reasons: [] };
  const d = decide(u, { kind: 'site', id: s.id, acl: [] }, PLANT_PERMISSIONS, DEFAULT_PLANT, 'view', { shares: SITE_SHARE_MODEL });
  // managing a site includes seeing it and proposing changes; proposing includes seeing it
  if (d.permissions.includes('manage')) d.permissions = [...PLANT_PERMISSIONS];
  else if (d.permissions.includes('propose') && !d.permissions.includes('view')) d.permissions = ['view', 'propose'];
  // a proposer's dry run (the preview of their draft): they may do what they propose, in a transaction rolled back
  if (proposerElevation > 0 && d.permissions.includes('propose') && !d.permissions.includes('manage')) d.permissions = [...PLANT_PERMISSIONS];
  return d;
}

export const sitePermissions = (s: { id: string; acl?: unknown }, u: AuthUser | null = currentUser()): PlantPermission[] => siteAccess(u, s).permissions;

export const canCreateSites = (u: AuthUser | null = currentUser()): boolean => hasRole(u, SITE_CREATORS) || (proposerElevation > 0 && plantProposesSome(u));

/**
 * A proposer's preview (0.13.0, change sets): what their draft would do is computed with the rights they propose with
 * – inside a transaction that is always rolled back (asProposer refuses to run outside one). Nothing is ever written
 * with these rights: applying runs as the person who applies, with their own rights.
 */
let proposerElevation = 0;
/** Whether a proposer's dry run is under way (the catalogues elevate like sites: plant/catalogue-access.ts). */
export const proposing = (): boolean => proposerElevation > 0;
export function asProposer<T>(fn: () => T): T {
  if (!db().inTransaction) throw new Error('asProposer runs only inside a transaction that is rolled back (dryRun)');
  proposerElevation++;
  try {
    return fn();
  } finally {
    proposerElevation--;
  }
}

/** Whether someone may keep drafts and propose changes: the propose right on some site (or on any site they may add). */
export function plantProposesSome(u: AuthUser | null = currentUser()): boolean {
  if (hasRole(u, SITE_CREATORS)) return true;
  const saved = proposerElevation;
  proposerElevation = 0;
  try {
    return db()
      .all<{ id: string; acl: string }>('SELECT id, acl FROM plant_sites')
      .some((r) => sitePermissions(r, u).includes('propose'));
  } finally {
    proposerElevation = saved;
  }
}

/**
 * Who adds entries to the catalogues of part 2 (#219) – device profiles and KPI definitions, which belong to no site:
 * whoever may add sites (designers and administrators). Since 0.21.0 (#293) the rights on one entry follow its owning
 * teams and shares (plant/catalogue-access.ts); an entry without them is managed by these people, as before.
 */
export const canManageCatalogue = (u: AuthUser | null = currentUser()): boolean => canCreateSites(u);

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
