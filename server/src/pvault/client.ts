import { PVAULT_HEARTBEAT_BY_NUMBER, PVAULT_KIND, PVAULT_LIMITS, pvFolderWithin, type Platform, type PvSecret } from '@sm/shared';
import { HttpError } from '../util.js';
import { platformRequest } from '../platforms/http.js';

/**
 * The REST API of IBM Security Verify Privilege Vault 12.0 (Delinea Secret Server; docs/IBM-PAM.md lists every
 * endpoint with its source). The platform's base URL is the application root – https://HOST/SecretServer on premises,
 * https://TENANT.secretservercloud.com in the cloud – and the API lives under /api/v1. Sign-in is the platform's token
 * request (POST /oauth2/token, grant_type password, refresh_token).
 *
 * Only metadata is read: the secret search (summaries), a secret's summary, folders, permissions, users, groups, roles,
 * templates, a secret's audit and access requests. The value endpoints are refused for this kind in platformRequest
 * (platforms/deniedPaths.ts), and the value keys of every answer are removed there too.
 *
 * Lists are paged with skip and take; a page says hasNext and nextSkip (Secret Server's PagingOf… model).
 */

export const API = '/api/v1';

/** The states of an access request (SecretAccessStatus). */
export const PV_REQUEST_STATES = ['Approved', 'Denied', 'Canceled', 'Pending'] as const;

interface Paged<T> {
  records?: T[];
  hasNext?: boolean;
  nextSkip?: number;
  total?: number;
}

/** What a 403 on a list means in plain words: the permission the service account lacks (docs/IBM-PAM.md). */
const PERMISSION_HINTS: Record<string, string> = {
  'users/current': 'sign in with the service account',
  secrets: 'list secrets – give the service account the folder permission View with the secret permission List on the folders to review',
  folders: 'list folders – the folder permission View on the folders to review',
  'secret-permissions': 'read who has access to a secret – the role permission "View Secret" is not enough on some versions; see docs/IBM-PAM.md',
  'folder-permissions': 'read folder permissions – see docs/IBM-PAM.md',
  users: 'list users – the role permission "View Users"',
  groups: 'list groups and their members – the role permission "View Groups"',
  roles: 'list roles and role assignments – the role permission "View Roles"',
  'roles-assigned': 'read the roles of a user – the role permission "View Roles"',
  'secret-templates': 'list secret templates – the role permission "View Secret Templates"',
  audits: 'read a secret\'s audit – the role permission "View Secret Audit"',
  'secret-access-requests': 'list access requests – the role permission "View Secret Access Requests"',
  summary: "read a secret's summary – at least the secret permission List",
};

/** The hint for a path: its last named segment that has one (users/current, roles-assigned, audits …). */
export function permissionHint(path: string): string | null {
  const segs = path.split('?')[0]!.split('/').filter(Boolean);
  const after = segs.slice(segs.indexOf('v1') + 1);
  if (after.join('/') === 'users/current') return PERMISSION_HINTS['users/current']!;
  for (let i = after.length - 1; i >= 0; i--) {
    const h = PERMISSION_HINTS[after[i]!];
    if (h) return h;
  }
  return null;
}

/** A failed call, with the missing permission named when the vault refused it. */
export class PvError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
  ) {
    super(message);
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null;
const bool = (v: unknown): boolean => v === true || v === 'true';
/** An id the vault sets (it sends -1 or 0 for none). */
const idOf = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
};
const iso = (v: unknown): string | null => {
  if (typeof v !== 'string' || !v.trim()) return null;
  // Secret Server sends local times without a zone on some versions: read them as UTC
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`);
  return Number.isFinite(t) && t > Date.UTC(1971, 0, 1) ? new Date(t).toISOString() : null;
};

function heartbeatOf(v: unknown): string | null {
  if (typeof v === 'number') return PVAULT_HEARTBEAT_BY_NUMBER[v] ?? String(v);
  const s = str(v).trim();
  return s || null;
}

/** A secret summary of the search or of /secrets/{id}/summary → PvSecret (only the fields Steward keeps). */
export function toSecret(r: Record<string, unknown>): PvSecret {
  return {
    id: num(r.id) ?? 0,
    name: str(r.name),
    folderId: num(r.folderId),
    folderPath: str(r.folderPath),
    templateId: num(r.secretTemplateId),
    templateName: str(r.secretTemplateName),
    active: r.active === undefined ? true : bool(r.active),
    autoChangeEnabled: bool(r.autoChangeEnabled),
    checkOutEnabled: bool(r.checkOutEnabled),
    requiresApproval: bool(r.requiresApproval) || bool(r.requireApprovalForAccess),
    requiresComment: bool(r.requiresComment),
    inheritsPermissions: r.inheritsPermissions === undefined ? true : bool(r.inheritsPermissions),
    // lastHeartBeatStatus in the API's JSON (the model's property is LastHeartBeatStatus)
    heartbeat: heartbeatOf(r.lastHeartBeatStatus ?? r.lastHeartbeatStatus),
    lastPasswordChangeAt: iso(r.lastPasswordChangeAttempt),
    outOfSync: bool(r.isOutOfSync),
    daysUntilExpiration: num(r.daysUntilExpiration),
    lastAccessedAt: iso(r.lastAccessed),
  };
}

export interface PvFolder {
  id: number;
  path: string;
  parentId: number | null;
  inheritPermissions: boolean;
}

export interface PvPermission {
  /** the secret or folder */
  on: number;
  userId: number | null;
  groupId: number | null;
  /** user name or group name as the vault shows it */
  name: string;
  domain: string;
  /** List, View, Edit, Owner (secrets); View, Edit, Add Secret, Owner (folders) */
  role: string;
  /** the folder permission's role for the secrets in it (folders only) */
  secretRole?: string;
}

export interface PvUser {
  id: number;
  username: string;
  displayName: string;
  domain: string;
  email: string;
  enabled: boolean;
  application: boolean;
  lastLoginAt: string | null;
  twoFactor: string;
}

export interface PvGroup {
  id: number;
  name: string;
  domain: string;
  enabled: boolean;
}

export interface PvRoleAssignment {
  roleId: number;
  roleName: string;
  direct: boolean;
  groups: string[];
}

export interface PvAuditRecord {
  at: string | null;
  action: string;
  user: string;
  notes: string;
  ticket: string;
}

export interface PvAccessRequest {
  id: number;
  secretId: number;
  secret: string;
  folderId: number | null;
  user: string;
  status: string;
  requestedAt: string | null;
  respondedAt: string | null;
  approver: string;
  comment: string;
  ticket: string;
  startAt: string | null;
  expiresAt: string | null;
}

/** Runs fn over the items with at most `limit` at a time, keeping the order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export class PvClient {
  constructor(
    readonly platform: Platform,
    readonly secrets: Record<string, string>,
  ) {
    if (platform.kind !== PVAULT_KIND) throw new HttpError(400, `"${platform.name}" is not an IBM Verify Privilege Vault platform`, 'PVAULT_PLATFORM');
  }

  /** One GET below /api/v1; a refusal names the missing permission. */
  async get<T>(path: string, query: Record<string, unknown> = {}): Promise<T> {
    const url = `${API}${path}`;
    const r = await platformRequest(
      this.platform,
      this.secrets,
      { method: 'GET', url, query, maxResponseBytes: 32 * 1024 * 1024, noRedirects: true },
      AbortSignal.timeout(PVAULT_LIMITS.timeoutMs),
    );
    if (!r.ok) {
      const hint = permissionHint(url);
      const why =
        r.status === 401
          ? ' – the vault did not accept the sign-in (user name, password, domain; is the account locked or its password expired?)'
          : r.status === 403
            ? hint
              ? ` – the service account may not ${hint}`
              : ' – the service account lacks a permission for this'
            : r.status === 404
              ? ' – is the base URL the application root (https://HOST/SecretServer or https://TENANT.secretservercloud.com)?'
              : '';
      const msg = (r.body as { message?: unknown } | null)?.message;
      throw new PvError(
        `GET ${url} answered HTTP ${r.status}${why}${typeof msg === 'string' && r.status >= 400 && r.status < 500 && r.status !== 401 ? ` (${msg.slice(0, 200)})` : ''}`,
        r.status,
        url,
      );
    }
    return r.body as T;
  }

  /** Every record of a paged list (skip/take, hasNext/nextSkip), at most `max`. */
  async list<T>(path: string, query: Record<string, unknown> = {}, max: number = PVAULT_LIMITS.principals): Promise<T[]> {
    const out: T[] = [];
    let skip = 0;
    for (let page = 0; page < PVAULT_LIMITS.pages; page++) {
      const body = await this.get<Paged<T> | T[]>(path, { ...query, skip, take: PVAULT_LIMITS.pageSize });
      // a plain list (some endpoints of older versions): one page
      if (Array.isArray(body)) return [...out, ...body].slice(0, max);
      const recs = Array.isArray(body?.records) ? body.records : [];
      out.push(...recs);
      if (out.length > max) throw new HttpError(400, `${path} has more than ${max} entries – narrow the folder`, 'PVAULT_TOO_MANY', { path, max });
      if (!body?.hasNext || !recs.length) return out;
      const nextSkip = num(body.nextSkip);
      skip = nextSkip !== null && nextSkip > skip ? nextSkip : skip + recs.length;
    }
    throw new HttpError(400, `${path} has more than ${PVAULT_LIMITS.pages} pages`, 'PVAULT_TOO_MANY', { path, max: PVAULT_LIMITS.pages });
  }

  currentUser(): Promise<{ id?: number; userName?: string; displayName?: string }> {
    return this.get('/users/current');
  }

  async folders(): Promise<PvFolder[]> {
    const rows = await this.list<Record<string, unknown>>('/folders', { 'filter.folderTypeId': 1 });
    return rows.map((r) => ({
      id: num(r.id) ?? 0,
      path: str(r.folderPath) || `\\${str(r.folderName)}`,
      parentId: num(r.parentFolderId),
      inheritPermissions: r.inheritPermissions === undefined ? true : bool(r.inheritPermissions),
    }));
  }

  /** The folder with this path, or a 400 that says it is not visible. */
  async folderByPath(path: string, folders?: PvFolder[]): Promise<PvFolder> {
    const list = folders ?? (await this.folders());
    const f = list.find((x) => pvFolderWithin(x.path, path) && pvFolderWithin(path, x.path));
    if (!f)
      throw new HttpError(400, `The folder ${path} does not exist or the service account may not see it`, 'PVAULT_FOLDER', { folder: path.slice(0, 200) });
    return f;
  }

  /** Secrets the account may list (summaries; restricted ones too, inactive ones not), optionally of a folder and below. */
  async searchSecrets(o: { folderId?: number } = {}): Promise<PvSecret[]> {
    const rows = await this.list<Record<string, unknown>>(
      '/secrets',
      {
        'filter.includeRestricted': 'true',
        'filter.includeInactive': 'false',
        ...(o.folderId ? { 'filter.folderId': o.folderId, 'filter.includeSubFolders': 'true' } : {}),
      },
      PVAULT_LIMITS.secrets,
    );
    return rows.map(toSecret).filter((s) => s.id > 0);
  }

  /** Secrets of a folder path ('' = all). */
  async secretsIn(folder: string, folders?: PvFolder[]): Promise<PvSecret[]> {
    if (!folder.trim()) return this.searchSecrets();
    const f = await this.folderByPath(folder, folders);
    // the vault filters by folder id; the path check keeps a version that ignores the filter honest
    return (await this.searchSecrets({ folderId: f.id })).filter((s) => pvFolderWithin(s.folderPath, folder));
  }

  async secret(id: number): Promise<PvSecret> {
    return toSecret(await this.get<Record<string, unknown>>(`/secrets/${encodeURIComponent(String(id))}/summary`));
  }

  async secretPermissions(secretId: number): Promise<PvPermission[]> {
    const rows = await this.list<Record<string, unknown>>('/secret-permissions', { 'filter.secretId': secretId });
    return rows.map((r) => ({
      on: num(r.secretId) ?? secretId,
      userId: idOf(r.userId),
      groupId: idOf(r.groupId),
      name: str(r.userName ?? r.username) || str(r.groupName),
      domain: str(r.domainName),
      role: str(r.secretAccessRoleName),
    }));
  }

  async folderPermissions(folderId: number): Promise<PvPermission[]> {
    const rows = await this.list<Record<string, unknown>>('/folder-permissions', { 'filter.folderId': folderId });
    return rows.map((r) => ({
      on: num(r.folderId) ?? folderId,
      userId: idOf(r.userId),
      groupId: idOf(r.groupId),
      name: str(r.userName ?? r.username) || str(r.groupName),
      domain: str(r.domainName),
      role: str(r.folderAccessRoleName),
      secretRole: str(r.secretAccessRoleName),
    }));
  }

  async users(): Promise<PvUser[]> {
    const rows = await this.list<Record<string, unknown>>('/users', { 'filter.includeInactive': 'true' });
    return rows.map((r) => ({
      id: num(r.id) ?? 0,
      username: str(r.userName ?? r.username),
      displayName: str(r.displayName),
      domain: str(r.domainName),
      email: str(r.emailAddress).trim().toLowerCase(),
      enabled: r.enabled === undefined ? true : bool(r.enabled),
      application: bool(r.isApplicationAccount),
      lastLoginAt: iso(r.lastLogin),
      twoFactor: str(r.twoFactorMethod),
    }));
  }

  async groups(): Promise<PvGroup[]> {
    const rows = await this.list<Record<string, unknown>>('/groups', { 'filter.includeInactive': 'false' });
    return rows.map((r) => ({ id: num(r.id) ?? 0, name: str(r.name), domain: str(r.domainName), enabled: r.enabled === undefined ? true : bool(r.enabled) }));
  }

  /** The user ids of a group's members (enabled ones). */
  async groupMembers(groupId: number): Promise<number[]> {
    const rows = await this.list<Record<string, unknown>>(`/groups/${groupId}/users`, {});
    return rows
      .filter((r) => r.enabled === undefined || bool(r.enabled))
      .map((r) => num(r.userId) ?? 0)
      .filter((x) => x > 0);
  }

  /** The roles of a user, directly or through groups (GET /users/{id}/roles-assigned). */
  async userRoles(userId: number): Promise<PvRoleAssignment[]> {
    const rows = await this.list<Record<string, unknown>>(`/users/${userId}/roles-assigned`, {});
    return rows.map((r) => ({
      roleId: num(r.roleId) ?? 0,
      roleName: str(r.roleName ?? r.name),
      direct: r.isDirectAssignment === undefined ? true : bool(r.isDirectAssignment),
      groups: (Array.isArray(r.groups) ? (r.groups as Record<string, unknown>[]) : []).map((g) => str(g.groupName)).filter(Boolean),
    }));
  }

  /** A secret's audit, newest first, until `from` (records before it end the read). */
  async audits(secretId: number, from: string, to: string): Promise<PvAuditRecord[]> {
    const out: PvAuditRecord[] = [];
    let skip = 0;
    for (let page = 0; page < PVAULT_LIMITS.pages && out.length < PVAULT_LIMITS.auditPerSecret; page++) {
      const body = await this.get<Paged<Record<string, unknown>>>(`/secrets/${secretId}/audits`, {
        'sortBy[0].name': 'dateRecorded',
        'sortBy[0].direction': 'desc',
        skip,
        take: PVAULT_LIMITS.pageSize,
      });
      const recs = Array.isArray(body?.records) ? body.records : [];
      let older = false;
      for (const r of recs) {
        const at = iso(r.dateRecorded);
        if (at && at < from) {
          older = true;
          break;
        }
        if (at && at > to) continue;
        out.push({
          at,
          action: str(r.action).toUpperCase(),
          user: str(r.byUserDisplayName) || str(r.userName ?? r.username),
          notes: str(r.notes).slice(0, 500),
          ticket: str(r.ticketNumber).slice(0, 100),
        });
      }
      if (older || !body?.hasNext || !recs.length) break;
      const nextSkip = num(body.nextSkip);
      skip = nextSkip !== null && nextSkip > skip ? nextSkip : skip + recs.length;
    }
    return out.slice(0, PVAULT_LIMITS.auditPerSecret);
  }

  /**
   * Access requests the account may see – on the vault, the ones it made or may approve – in every state
   * (filter.status takes one of Approved, Denied, Canceled, Pending).
   */
  async accessRequests(): Promise<PvAccessRequest[]> {
    const out: PvAccessRequest[] = [];
    for (const status of PV_REQUEST_STATES) {
      const rows = await this.list<Record<string, unknown>>('/secret-access-requests', { 'filter.status': status });
      for (const r of rows)
        out.push({
          id: num(r.secretAccessRequestId) ?? 0,
          secretId: num(r.secretId) ?? 0,
          secret: str(r.secretName),
          folderId: num(r.folderId),
          user: str(r.requestUsername) || str(r.requestingUserId),
          status: str(r.status) || status,
          requestedAt: iso(r.requestDate),
          respondedAt: iso(r.responseDate),
          approver: str(r.approverDisplayName),
          comment: str(r.requestComment).slice(0, 500),
          ticket: str(r.ticketNumber).slice(0, 100),
          startAt: iso(r.startDate),
          expiresAt: iso(r.expirationDate),
        });
    }
    // a request listed under two states (it changed between the calls) once
    return [...new Map(out.map((r) => [r.id, r])).values()];
  }

  async templates(): Promise<{ id: number; name: string; heartbeatEnabled: boolean }[]> {
    const rows = await this.list<Record<string, unknown>>('/secret-templates', {});
    return rows.map((r) => ({ id: num(r.id) ?? 0, name: str(r.name), heartbeatEnabled: bool(r.heartbeatEnabled) }));
  }
}
