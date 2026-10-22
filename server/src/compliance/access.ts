import type { AclEntry, PlatformPermission, Role } from '@sm/shared';
import { currentUser, type AuthUser } from '../auth/context.js';
import { isAdmin, platformPermissions } from '../auth/permissions.js';
import { db } from '../db.js';
import { HttpError, parseJson } from '../util.js';

/**
 * Who may do what with the compliance features. Auditors read everything (read-only), administrators
 * manage control catalogues, designers and administrators tag items with controls and set up access
 * reconciliation checks, operators/designers/administrators document access changes.
 */

const has = (u: AuthUser | null, roles: Role[]) => !!u && u.roles.some((r) => roles.includes(r));
export const same = (a: string | null | undefined, b: string | null | undefined): boolean => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export const isAuditor = (u: AuthUser | null): boolean => has(u, ['auditor']);
/** Administrators and auditors see all compliance data. */
export const readsEverything = (u: AuthUser | null = currentUser()): boolean => isAdmin(u) || isAuditor(u);

export function platformAcl(platformId: string): { exists: boolean; name: string; kind: string; acl: AclEntry<PlatformPermission>[] } {
  const r = db().get<{ name: string; kind: string; acl: string }>('SELECT name, kind, acl FROM platforms WHERE id = ?', platformId);
  return r ? { exists: true, name: r.name, kind: r.kind, acl: parseJson(r.acl, []) } : { exists: false, name: '', kind: '', acl: [] };
}

export function platformPerms(u: AuthUser | null, platformId: string): PlatformPermission[] {
  const p = platformAcl(platformId);
  return p.exists ? platformPermissions(u, { acl: p.acl }) : [];
}

/** The platform's name, or null when the reader may not see the platform (or it does not exist). */
export function visiblePlatformName(u: AuthUser | null, platformId: string): string | null {
  const p = platformAcl(platformId);
  if (!p.exists) return null;
  return readsEverything(u) || platformPermissions(u, { acl: p.acl }).length > 0 ? p.name : null;
}

export interface CheckOwnerInfo {
  owner: string;
  platform_id: string;
}

/** Reconciliation checks, snapshots and findings: administrators, auditors, the owner and whoever may use the platform. */
export const canReadCheck = (u: AuthUser | null, c: CheckOwnerInfo): boolean =>
  !!u && (readsEverything(u) || same(c.owner, u.username) || platformPerms(u, c.platform_id).includes('use'));
export const canCreateChecks = (u: AuthUser | null = currentUser()): boolean => has(u, ['admin', 'designer']);
export const canEditCheck = (u: AuthUser | null, c: CheckOwnerInfo): boolean => isAdmin(u) || (!!u && canCreateChecks(u) && same(c.owner, u.username));
/** Document a finding (creates an access change entry): record editors who may read the check. */
export const canDocumentFinding = (u: AuthUser | null, c: CheckOwnerInfo): boolean => has(u, ['admin', 'designer', 'operator']) && canReadCheck(u, c);
export const canDismissFinding = (u: AuthUser | null, c: CheckOwnerInfo): boolean => canEditCheck(u, c);

export const canManageCatalogues = (u: AuthUser | null = currentUser()): boolean => isAdmin(u);
export const canTagControls = (u: AuthUser | null = currentUser()): boolean => has(u, ['admin', 'designer']);
/** Evidence packs: everyone but viewers (the pack only holds what the requester may see). */
export const canExportEvidence = (u: AuthUser | null = currentUser()): boolean => has(u, ['admin', 'designer', 'operator', 'approver', 'auditor']);

export function me(): AuthUser {
  const u = currentUser();
  if (!u) throw new HttpError(401, 'Please sign in', 'NOT_SIGNED_IN');
  return u;
}

/** 403 FORBIDDEN; `context` picks the translated text (errors:codes.FORBIDDEN_<context>). */
export function forbid(what: string, context?: string): never {
  throw new HttpError(403, `You are not allowed to ${what}`, 'FORBIDDEN', context ? { context } : undefined);
}
