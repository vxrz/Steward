import type { Role } from '@sm/shared';
import type { AuthUser } from '../auth/context.js';
import { currentUser } from '../auth/context.js';
import { isAdmin, matches } from '../auth/permissions.js';
import { HttpError } from '../util.js';

/**
 * Who may do what with records and services. Everyone who can sign in reads
 * records and services (auditors included); changes need one of the roles
 * below, checked on the server for every route.
 */

const has = (u: AuthUser | null, roles: Role[]) => !!u && u.roles.some((r) => roles.includes(r));
const same = (a: string | null | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();

/** Create records, edit drafts, run the non-approval transitions. */
export const RECORD_EDITOR_ROLES: Role[] = ['admin', 'designer', 'operator'];
/** Approve or reject (four-eyes applies). */
export const RECORD_APPROVER_ROLES: Role[] = ['admin', 'approver'];
/** Create and edit catalogue services. */
export const SERVICE_EDITOR_ROLES: Role[] = ['admin', 'designer'];

export const canCreateRecords = (u: AuthUser | null = currentUser()): boolean => has(u, RECORD_EDITOR_ROLES);
export const canApproveRecords = (u: AuthUser | null = currentUser()): boolean => has(u, RECORD_APPROVER_ROLES);
export const canManageRecordTypes = (u: AuthUser | null = currentUser()): boolean => isAdmin(u);

export interface RecordRoleInfo {
  owner: string;
  created_by: string;
  submitted_by: string | null;
}

export const isRecordOwner = (u: AuthUser | null, r: Pick<RecordRoleInfo, 'owner'>): boolean => !!u && same(r.owner, u.username);
/** Editors by role, plus the record's owner. */
export const canEditRecord = (u: AuthUser | null, r: Pick<RecordRoleInfo, 'owner'>): boolean => canCreateRecords(u) || isRecordOwner(u, r);
export const canCommentRecord = (u: AuthUser | null, r: Pick<RecordRoleInfo, 'owner'>): boolean => canEditRecord(u, r) || canApproveRecords(u);

/**
 * Four-eyes principle: the owner, the creator, the submitter and everyone who
 * wrote content of the record (a version of any revision, an attached or
 * removed file) cannot approve or reject it.
 */
export function fourEyesReason(u: AuthUser, r: RecordRoleInfo, authors: string[]): string | null {
  if (same(r.owner, u.username)) return 'Four-eyes principle: the owner of a record cannot approve or reject it';
  if (same(r.created_by, u.username)) return 'Four-eyes principle: the author of a record cannot approve or reject it';
  if (same(r.submitted_by, u.username)) return 'Four-eyes principle: the person who submitted a record cannot approve or reject it';
  if (authors.some((a) => same(a, u.username)))
    return 'Four-eyes principle: an author of the content (text, fields or attached files) cannot approve or reject it';
  return null;
}

/** Service editors by role, plus the Steward users and teams named as its owners. */
export const canEditService = (u: AuthUser | null, owners: string[] = []): boolean =>
  has(u, SERVICE_EDITOR_ROLES) || (!!u && owners.some((s) => matches(u, s)));
export const canCreateServices = (u: AuthUser | null = currentUser()): boolean => has(u, SERVICE_EDITOR_ROLES);

export function me(): AuthUser {
  const u = currentUser();
  if (!u) throw new HttpError(401, 'Please sign in', 'NOT_SIGNED_IN');
  return u;
}

export function forbid(what: string): never {
  throw new HttpError(403, `You are not allowed to ${what}`, 'FORBIDDEN');
}
