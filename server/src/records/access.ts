import { ACCESS_TYPE_ID, type RecordFieldDef, type Role } from '@sm/shared';
import type { AuthUser } from '../auth/context.js';
import { currentUser } from '../auth/context.js';
import { isAdmin, matches } from '../auth/permissions.js';
import { sameIdentity } from '../auth/aliases.js';
import { canReadAccessEntry } from '../compliance/access.js';
import { HttpError, parseJson, type ErrorParam } from '../util.js';

/**
 * Who may do what with records and services. Everyone who can sign in reads
 * records and services (auditors included) – except access change entries,
 * which name people and their rights (see canReadRecordRow); changes need one
 * of the roles below, checked on the server for every route.
 */

const has = (u: AuthUser | null, roles: Role[]) => !!u && u.roles.some((r) => roles.includes(r));
const same = (a: string | null | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();

/** Create records, edit drafts, run the non-approval transitions. */
export const RECORD_EDITOR_ROLES: Role[] = ['admin', 'designer', 'operator'];
/** Approve or reject (four-eyes applies). */
export const RECORD_APPROVER_ROLES: Role[] = ['admin', 'approver'];
/** Create and edit catalogue services. */
export const SERVICE_EDITOR_ROLES: Role[] = ['admin', 'designer'];

/** Read records and catalogue services: everyone who can sign in. */
export const canReadRecords = (u: AuthUser | null = currentUser()): boolean => !!u;

/**
 * Read one record: everyone who can sign in, but access change entries (the built-in type AC) only
 * administrators, auditors, approvers, the entry's owner and whoever has a right on its platform.
 */
export function canReadRecordRow(u: AuthUser | null, r: { type_id: string; fields: string; owner: string }): boolean {
  if (!u) return false;
  if (r.type_id !== ACCESS_TYPE_ID) return true;
  return canReadAccessEntry(u, parseJson<Record<string, string>>(r.fields, {}).platform ?? '', r.owner);
}
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
export function fourEyesReason(u: AuthUser, r: RecordRoleInfo, authors: string[]): ActionReason | null {
  // former names of imported accounts count as the same person (auth/aliases.ts)
  if (sameIdentity(r.owner, u)) return { code: 'FOUR_EYES_OWNER', message: 'Four-eyes principle: the owner of a record cannot approve or reject it' };
  if (sameIdentity(r.created_by, u)) return { code: 'FOUR_EYES_AUTHOR', message: 'Four-eyes principle: the author of a record cannot approve or reject it' };
  if (sameIdentity(r.submitted_by, u))
    return { code: 'FOUR_EYES_SUBMITTER', message: 'Four-eyes principle: the person who submitted a record cannot approve or reject it' };
  if (authors.some((a) => sameIdentity(a, u)))
    return {
      code: 'FOUR_EYES_CONTENT_AUTHOR',
      message: 'Four-eyes principle: an author of the content (text, fields or attached files) cannot approve or reject it',
    };
  return null;
}

/** Why an action is not possible: English message (API, logs) and a code the web UI translates (errors:codes.<code>). */
export interface ActionReason {
  code: string;
  message: string;
}

/** A record status as an error parameter: the web UI shows it translated (records:status.<status>). */
export const statusParam = (status: string): ErrorParam => ({ message: status, code: 'RECORD_STATUS', params: { status } });
/** A field label as an error parameter: the web UI translates the labels of the built-in types (records:builtinTypes). */
export const fieldParam = (typeKey: string | undefined, f: Pick<RecordFieldDef, 'key' | 'label'>): ErrorParam => ({
  message: f.label,
  code: 'RECORD_FIELD',
  params: { type: typeKey ?? '', field: f.key, label: f.label },
});

/** Service editors by role, plus the Steward users and teams named as its owners. */
export const canEditService = (u: AuthUser | null, owners: string[] = []): boolean =>
  has(u, SERVICE_EDITOR_ROLES) || (!!u && owners.some((s) => matches(u, s)));
export const canCreateServices = (u: AuthUser | null = currentUser()): boolean => has(u, SERVICE_EDITOR_ROLES);

export function me(): AuthUser {
  const u = currentUser();
  if (!u) throw new HttpError(401, 'Please sign in', 'NOT_SIGNED_IN');
  return u;
}

/** 403 FORBIDDEN; `context` picks a specific translated text (errors:codes.FORBIDDEN_<context>). */
export function forbid(what: string, context?: string): never {
  throw new HttpError(403, `You are not allowed to ${what}`, 'FORBIDDEN', context ? { context } : undefined);
}
