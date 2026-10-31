import { ACCESS_TYPE_ID, type RecordFieldDef, type Role } from '@sm/shared';
import type { AuthUser } from '../auth/context.js';
import { currentUser } from '../auth/context.js';
import { isAdmin } from '../auth/permissions.js';
import { sameIdentity } from '../auth/aliases.js';
import { canReadAccessEntry } from '../compliance/access.js';
import { parseJson, type ErrorParam } from '../util.js';
import { forbid, me } from '../auth/access.js';
import { catalogueAccess, recordAccess, type CatalogueKind } from '../auth/policy.js';
export { forbid, me };

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
 * Read one record: everyone who can sign in – or, when it has owning teams, their members, administrators, auditors
 * and its owner (auth/policy.ts, #131) – but access change entries (the built-in type AC) only administrators,
 * auditors, approvers, the entry's owner and whoever has a right on its platform.
 */
export function canReadRecordRow(u: AuthUser | null, r: { id: string; type_id: string; fields: string; owner: string }): boolean {
  if (!u) return false;
  if (!recordAccess(u, r).view) return false;
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
/** Editors by role, plus the record's owner (in the record's owning teams, when it has some: auth/policy.ts). */
export const canEditRecord = (u: AuthUser | null, r: { id: string; owner: string }): boolean => recordAccess(u, r).edit;
/** Approvers by role (in the record's owning teams, when it has some). Four-eyes applies on top. */
export const canApproveRecord = (u: AuthUser | null, r: { id: string; owner: string }): boolean => recordAccess(u, r).approve;
export const canCommentRecord = (u: AuthUser | null, r: { id: string; owner: string }): boolean => {
  const d = recordAccess(u, r);
  return d.edit || d.approve;
};

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
/** Changing a service, application or system (auth/policy.ts decides, with owning teams, #131). */
export const canEditService = (u: AuthUser | null, r: { kind: CatalogueKind; id: string; owners: string[] }): boolean => catalogueAccess(u, r).edit;
/** Seeing a service, application or system (#131): without owning teams everybody signed in. */
export const canViewCatalogue = (u: AuthUser | null, r: { kind: CatalogueKind; id: string; owners: string[] }): boolean => catalogueAccess(u, r).view;
export const canCreateServices = (u: AuthUser | null = currentUser()): boolean => has(u, SERVICE_EDITOR_ROLES);

/**
 * Whether the current reader may see a catalogue item (#131); jobs without a reader see everything. For lists and
 * names shown elsewhere (a service's applications, an application's services, systems, scorecard, duties …).
 */
export function catalogueVisibleNow(kind: CatalogueKind, r: { id: string; owners?: string | string[] | null }): boolean {
  const u = currentUser();
  if (!u) return true;
  const owners = Array.isArray(r.owners) ? r.owners : parseJson<string[]>(r.owners ?? '[]', []);
  return canViewCatalogue(u, { kind, id: r.id, owners });
}
