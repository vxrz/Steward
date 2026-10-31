import type { AclEntry, PlatformPermission, Role } from '@sm/shared';
import { aliasesOf } from '../auth/aliases.js';
import { currentUser, type AuthUser } from '../auth/context.js';
import { isAdmin, platformPermissions } from '../auth/permissions.js';
import { findUserByName } from '../auth/users.js';
import { db } from '../db.js';
import { parseJson } from '../util.js';
import { forbid, me } from '../auth/access.js';
export { forbid, me };

/**
 * Who may do what with the compliance features. Auditors read everything (read-only), administrators
 * manage control catalogues, designers and administrators tag items with controls and set up access
 * reconciliation checks, operators/designers/administrators who may use a platform document its
 * access changes. Access change entries name people and their rights: they are read by
 * administrators, auditors, approvers (who verify them), their owner and whoever may use the platform.
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

/** Steward itself (automatic entries of runs): creates and documents records and sees every run to link it; never approves or verifies. */
export const SYSTEM_USER: AuthUser = { id: 'system', username: 'system', displayName: 'Steward', roles: ['operator', 'auditor'], teams: [] };
export const isSystem = (u: AuthUser | null): boolean => !!u && u.id === SYSTEM_USER.id && u.username === SYSTEM_USER.username;

/** Read an access change entry: administrators, auditors, approvers (they verify entries), the entry's owner and whoever has a right on the platform. */
export function canReadAccessEntry(u: AuthUser | null, platformId: string, owner?: string | null): boolean {
  if (!u) return false;
  if (readsEverything(u) || has(u, ['approver']) || isSystem(u)) return true;
  if (same(owner, u.username)) return true;
  return !!platformId && platformPerms(u, platformId).length > 0;
}

/** Create, change or document access change entries of a platform: record editors (and Steward itself) who may use the platform. */
export const canDocumentAccessOn = (u: AuthUser | null, platformId: string): boolean =>
  isSystem(u) || isAdmin(u) || (has(u, ['designer', 'operator']) && !!platformId && platformPerms(u, platformId).includes('use'));

/** The names a Steward user goes by on platforms: the user name and the e-mail address (lower case). */
export function identitiesOf(username: string | null | undefined): string[] {
  if (!username || username === SYSTEM_USER.username) return [];
  const u = findUserByName(username);
  // former names of an imported account are the same person (auth/aliases.ts)
  return [...new Set([username, u?.username, u?.email, ...(u ? aliasesOf(u.id) : [])].filter((x): x is string => !!x).map((x) => x.trim().toLowerCase()))];
}

/** Whether the Steward user is the subject of an access change (by subject id or name, case-insensitive). */
export function isSubjectOf(username: string | null | undefined, s: { subjectId?: string | null; subjectName?: string | null }): boolean {
  const mine = new Set(identitiesOf(username));
  return [s.subjectId, s.subjectName].some((x) => !!x && mine.has(x.trim().toLowerCase()));
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
/** Document a finding (creates an access change entry): record editors who may read the check and use its platform. */
export const canDocumentFinding = (u: AuthUser | null, c: CheckOwnerInfo): boolean =>
  (isSystem(u) || has(u, ['admin', 'designer', 'operator'])) && canReadCheck(u, c) && canDocumentAccessOn(u, c.platform_id);
export const canDismissFinding = (u: AuthUser | null, c: CheckOwnerInfo): boolean => canEditCheck(u, c);

export const canManageCatalogues = (u: AuthUser | null = currentUser()): boolean => isAdmin(u);
export const canTagControls = (u: AuthUser | null = currentUser()): boolean => has(u, ['admin', 'designer']);
/** Evidence packs: everyone but viewers (the pack only holds what the requester may see). */
export const canExportEvidence = (u: AuthUser | null = currentUser()): boolean => has(u, ['admin', 'designer', 'operator', 'approver', 'auditor']);
