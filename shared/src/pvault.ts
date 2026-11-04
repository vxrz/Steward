/**
 * IBM Security Verify Privilege Vault (Delinea Secret Server under the IBM name, 12.0; v0.5.0, #205, docs/IBM-PAM.md):
 * who may use which privileged account, whether rotation works, and who used a secret. Steward reads metadata only –
 * never a secret value (platforms/deniedPaths.ts refuses the value endpoints for this kind).
 */

export const PVAULT_KIND = 'privilege-vault';

export const PVAULT_LIMITS = {
  /** Items per page (take) */
  pageSize: 500,
  /** Pages of one list */
  pages: 100,
  /** Secrets read at once (access source, hygiene, evidence) */
  secrets: 10_000,
  /** Users, groups and folders read at once */
  principals: 5_000,
  /** Calls in parallel per read */
  concurrency: 4,
  /** One request */
  timeoutMs: 30_000,
  /** A linked credentials register entry is read again after (hours) */
  refreshHours: 6,
  /** Audit records read per secret and period */
  auditPerSecret: 2_000,
  /** Audit records of one evidence read */
  auditEvents: 20_000,
  /** The longest period of a privileged-use read (days) */
  auditDays: 400,
} as const;

/** Secret access roles from least to most (Secret Server: List, View, Edit, Owner). */
export const PVAULT_SECRET_ROLES = ['List', 'View', 'Edit', 'Owner'] as const;

/** Heartbeat states that mean the account could not be verified (SecretHeartbeatStatus). */
export const PVAULT_HEARTBEAT_FAILED = [
  'Failed',
  'UnableToConnect',
  'UnknownError',
  'IncompatibleHost',
  'AccountLockedOut',
  'DnsMismatch',
  'UnableToValidateServerPublicKey',
  'ArgumentError',
  'AccessDenied',
] as const;

/** SecretHeartbeatStatus by number, for answers that send the enum's value. */
export const PVAULT_HEARTBEAT_BY_NUMBER = [
  'Failed',
  'Success',
  'Pending',
  'Disabled',
  'UnableToConnect',
  'UnknownError',
  'IncompatibleHost',
  'AccountLockedOut',
  'DnsMismatch',
  'UnableToValidateServerPublicKey',
  'Processing',
  'ArgumentError',
  'AccessDenied',
] as const;

/** A secret as Steward keeps it: the search summary, never a field value. */
export interface PvSecret {
  id: number;
  name: string;
  folderId: number | null;
  /** \Folder\Sub, as the vault shows it ('' for no folder) */
  folderPath: string;
  templateId: number | null;
  templateName: string;
  active: boolean;
  autoChangeEnabled: boolean;
  checkOutEnabled: boolean;
  requiresApproval: boolean;
  requiresComment: boolean;
  inheritsPermissions: boolean;
  /** Success, Failed, Pending, Disabled … (null: never) */
  heartbeat: string | null;
  /** The last password change attempt (null: none) */
  lastPasswordChangeAt: string | null;
  /** The last change attempt failed or the vault reports it out of sync */
  outOfSync: boolean;
  /** Days until the password expires (negative: expired; null: no expiry) */
  daysUntilExpiration: number | null;
  lastAccessedAt: string | null;
}

/** Which folders and templates count as privileged (hygiene and evidence). */
export interface PvPrivilegedScope {
  /** Folder paths (\Privileged, \IT\Domain Admins); a secret in one of them or below counts. Empty: no folder counts */
  folders: string[];
  /** Template names (Windows Account, Unix Account (SSH)); exact, case-insensitive */
  templates: string[];
}

export const PV_FINDING_KINDS = ['heartbeat', 'notRotated', 'expired', 'autoChangeOff', 'noOwner', 'noCheckout', 'noApproval'] as const;
export type PvFindingKind = (typeof PV_FINDING_KINDS)[number];

export interface PvHygieneOptions extends PvPrivilegedScope {
  /** A password changed longer ago (or never) counts as not rotated (days) */
  maxAgeDays: number;
  /** The findings to look for (default: all) */
  kinds?: PvFindingKind[];
  /** Only secrets of this folder and below ('' or missing: all the account may list) */
  folder?: string;
}

export interface PvFinding {
  kind: PvFindingKind;
  secretId: number;
  secret: string;
  folder: string;
  template: string;
  privileged: boolean;
  detail: string;
}

/** A credentials register entry's link to its vault secret. */
export interface PvVaultLink {
  platformId: string;
  secretId: number;
}

/** What Steward last read about a linked secret (GET /secrets/{id}/summary): metadata only. */
export interface PvSecretReadout {
  readAt: string;
  error: string | null;
  secret: {
    id: number;
    name: string;
    template: string;
    folder: string;
    lastChangeAt: string | null;
    /** When the password expires, from daysUntilExpiration at readAt (null: no expiry) */
    expiresAt: string | null;
    autoChangeEnabled: boolean;
    heartbeat: string | null;
    outOfSync: boolean;
  } | null;
}

/** One use of a privileged secret from the vault's audit (views, checkouts, …) or an access request. */
export interface PvAuditEvent {
  at: string;
  secretId: number;
  secret: string;
  folder: string;
  user: string;
  /** VIEW, CHECKOUT, CHECKIN, PASSWORDDISPLAYED, LAUNCH … or ACCESS REQUEST <status> */
  action: string;
  notes: string;
  ticket: string;
}

const norm = (s: string) => s.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

/** Whether a folder path is the folder or below it (\IT matches \IT and \IT\Servers, not \ITX). */
export function pvFolderWithin(path: string, folder: string): boolean {
  const p = norm(path);
  const f = norm(folder);
  if (!f) return true;
  return p === f || p.startsWith(`${f}\\`);
}

/** Whether a secret counts as privileged: in a privileged folder (or below) or of a privileged template. */
export function pvPrivileged(s: Pick<PvSecret, 'folderPath' | 'templateName'>, scope: PvPrivilegedScope): boolean {
  if (scope.folders.some((f) => f.trim() && pvFolderWithin(s.folderPath, f))) return true;
  const t = s.templateName.trim().toLowerCase();
  return scope.templates.some((x) => x.trim().toLowerCase() === t);
}

/** Why a folder path is not accepted (access source scope, hygiene folder), or null. \Folder\Sub, at most 500 characters. */
export function pvFolderProblem(folder: string): string | null {
  if (folder.length > 500) return 'The folder path is longer than 500 characters';
  if (!folder) return null;
  if (!folder.startsWith('\\')) return 'A folder path starts with \\ (e.g. \\IT\\Servers)';
  // eslint-disable-next-line no-control-regex -- control characters are refused
  if (/[\u0000-\u001f\u007f]/.test(folder)) return 'The folder path contains control characters';
  return null;
}

/** "Folder,Other" or lines → a clean list (process inputs, monitor fields). */
export function pvList(v: string | string[] | undefined | null): string[] {
  const list = Array.isArray(v) ? v : String(v ?? '').split(/[\n,;]/);
  return [...new Set(list.map((x) => x.trim()).filter(Boolean))];
}
