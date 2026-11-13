import { PLANT_PERMISSIONS, coreRoleDefaults, moduleRoleRights, type AclEntry, type AccessReason, type PlantPermission, type Role } from '@sm/shared';
import type { AuthUser } from '../auth/context.js';
import { currentUser } from '../auth/context.js';
import { decide } from '../auth/policy.js';
import { forbid } from '../auth/access.js';
import { db } from '../db.js';
import { parseJson } from '../util.js';
import { moduleRole, usesModule } from '../modules/access.js';

/**
 * Rights in the plant registry (#218): per site, through the one policy module (auth/policy.ts, ADR 0006). Assets,
 * the hierarchy and the buildings of a site follow the site.
 *
 * - Without owning teams and without an access list: every signed-in role sees the site (as the catalogue), designers
 *   and administrators manage it, operators and approvers propose, status viewers never.
 * - Since 0.23.0 (ADR 0034 part 5) these role defaults are the plant module's: `fromCoreRoles` maps each core role to a
 *   module role (designer → manager, operator and approver → contributor, auditor and viewer → viewer) and the module
 *   declares what each gives (shared/src/modules.ts). Module roles granted to a person, a team or through single
 *   sign-on count like instance roles; the former instance role "plant" (Plant viewer) is a contributor grant.
 * - An access list restricts the site to its entries (view or manage), as with processes and platforms.
 * - With owning teams: their members have their instance and team roles on it; auditors see it; administrators always
 *   manage it.
 */
export const DEFAULT_PLANT: Record<Role, PlantPermission[]> = coreRoleDefaults('plant', 'site', PLANT_PERMISSIONS);

export function siteAccess(
  u: AuthUser | null,
  s: { id: string; acl: AclEntry<PlantPermission>[] | string },
): { permissions: PlantPermission[]; reasons: AccessReason[] } {
  // someone who does not use the plant registry (ADR 0034) has no right on a site: wherever a core page names a site
  // or an asset (maintenance targets, impact, links), they see nothing of it
  if (u && !usesModule(u, 'plant')) return { permissions: [], reasons: [] };
  const acl = typeof s.acl === 'string' ? parseJson<AclEntry<PlantPermission>[]>(s.acl, []) : s.acl;
  const d = decide(u, { kind: 'site', id: s.id, acl }, PLANT_PERMISSIONS, DEFAULT_PLANT, 'view', { module: { id: 'plant', kind: 'site' } });
  // managing a site includes seeing it and proposing changes; proposing includes seeing it
  if (d.permissions.includes('manage')) d.permissions = [...PLANT_PERMISSIONS];
  else if (d.permissions.includes('propose') && !d.permissions.includes('view')) d.permissions = ['view', 'propose'];
  // a proposer's dry run (the preview of their draft): they may do what they propose, in a transaction rolled back
  if (proposerElevation > 0 && d.permissions.includes('propose') && !d.permissions.includes('manage')) d.permissions = [...PLANT_PERMISSIONS];
  return d;
}

export const sitePermissions = (s: { id: string; acl: string }, u: AuthUser | null = currentUser()): PlantPermission[] => siteAccess(u, s).permissions;

/** Who may add sites (and import files with new sites): the plant module's managers – administrators and designers by default. */
const createsSites = (u: AuthUser | null): boolean => moduleRoleRights('plant', moduleRole('plant', u), 'registry').includes('createSites');

export const canCreateSites = (u: AuthUser | null = currentUser()): boolean => createsSites(u) || (proposerElevation > 0 && plantProposesSome(u));

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
  if (createsSites(u)) return true;
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
