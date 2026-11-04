import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * A simulated IBM Security Verify Privilege Vault 12.0 (Delinea Secret Server REST API v1) for the demo and the tests
 * (#205), modelled on the documented answers (docs/IBM-PAM.md): at /mock/pvault/SecretServer, like
 * https://HOST/SecretServer on premises.
 *
 *   POST /oauth2/token                      grant_type password (username, password, optional domain) or refresh_token
 *   GET  /api/v1/users/current, /version, /healthcheck
 *   GET  /api/v1/secrets                    search: summaries, skip/take, filter.folderId + includeSubFolders, includeInactive
 *   GET  /api/v1/secrets/{id}/summary, /secrets/{id}/audits
 *   GET  /api/v1/folders, /secret-permissions?filter.secretId, /folder-permissions?filter.folderId
 *   GET  /api/v1/users, /groups, /groups/{id}/users, /users/{id}/roles-assigned, /roles, /secret-templates
 *   GET  /api/v1/secret-access-requests
 *   GET  /api/v1/secrets/{id}, /secrets/{id}/fields/{slug}   the VALUE endpoints: answered like the real vault (with
 *        items[].itemValue) and counted – Steward must never call them (tests assert the count stays 0)
 *
 * Sign-in: DEMO_PVAULT.username / password (the service account, an application account), or DEMO_PVAULT.limited /
 * password (a local user without the role permissions View Roles and View Secret Audit: 403 there – the
 * permission-denied case). Tokens live DEMO_PVAULT.lifetimeSeconds (setPvaultTokenLifetime for tests); an expired
 * token answers 401. Lists are paged with skip/take (hasNext, nextSkip); setPvaultPageCap limits a page.
 *
 * Data: folders \IT (Domain Admins: Owner), \IT\Servers (inherits), \Privileged (alice: Owner, DB Admins: View),
 * \Privileged\Domain (inherits), \Shared (bob: Edit – nobody owns its secrets). Six active secrets with heartbeat,
 * rotation, expiry, checkout and approval settings that give every hygiene finding once or more; audits and access
 * requests relative to now. The group Hidden's members cannot be read (403).
 */

export const DEMO_PVAULT = {
  username: 'steward-reader',
  limited: 'limited-reader',
  password: 'demo-vault-password',
  domain: 'CORP',
  lifetimeSeconds: 1200,
};

const DAY = 86_400_000;

interface Secret {
  id: number;
  name: string;
  folderId: number;
  secretTemplateName: string;
  secretTemplateId: number;
  active: boolean;
  lastHeartBeatStatus: string;
  changedDaysAgo: number | null;
  daysUntilExpiration: number | null;
  autoChangeEnabled: boolean;
  checkOutEnabled: boolean;
  requiresApproval: boolean;
  inheritsPermissions: boolean;
  isOutOfSync?: boolean;
  /** permissions of its own: [userId | null, groupId | null, role] */
  own: [number | null, number | null, string][];
  password: string;
}

interface State {
  users: {
    id: number;
    userName: string;
    displayName: string;
    domainName: string;
    emailAddress: string;
    enabled: boolean;
    isApplicationAccount: boolean;
    lastLoginDaysAgo: number | null;
    twoFactorMethod: string;
  }[];
  groups: { id: number; name: string; domainName: string; members: number[]; hidden?: boolean }[];
  roles: { id: number; name: string }[];
  /** userId → [roleId, direct, via groups] */
  roleAssignments: Record<number, [number, boolean, string[]][]>;
  folders: {
    id: number;
    folderName: string;
    folderPath: string;
    parentFolderId: number;
    inheritPermissions: boolean;
    perms: [number | null, number | null, string, string][];
  }[];
  secrets: Secret[];
  templates: { id: number; name: string; heartbeatEnabled: boolean }[];
  /** secretId → [daysAgo, action, user, notes] */
  audits: Record<number, [number, string, string, string][]>;
  requests: { id: number; secretId: number; user: string; status: string; daysAgo: number; approver: string; comment: string }[];
}

function seed(): State {
  return {
    users: [
      {
        id: 10,
        userName: 'alice',
        displayName: 'Alice Admin',
        domainName: '',
        emailAddress: 'alice@example.com',
        enabled: true,
        isApplicationAccount: false,
        lastLoginDaysAgo: 1,
        twoFactorMethod: 'Email',
      },
      {
        id: 11,
        userName: 'bob',
        displayName: 'Bob Builder',
        domainName: 'CORP',
        emailAddress: 'bob@example.com',
        enabled: true,
        isApplicationAccount: false,
        lastLoginDaysAgo: 3,
        twoFactorMethod: '',
      },
      {
        id: 12,
        userName: 'erika',
        displayName: 'Erika Mustermann',
        domainName: 'CORP',
        emailAddress: 'Erika.Mustermann@example.com',
        enabled: true,
        isApplicationAccount: false,
        lastLoginDaysAgo: 0,
        twoFactorMethod: 'Duo',
      },
      {
        id: 13,
        userName: 'svc-backup',
        displayName: 'Backup service',
        domainName: '',
        emailAddress: '',
        enabled: true,
        isApplicationAccount: true,
        lastLoginDaysAgo: null,
        twoFactorMethod: '',
      },
      {
        id: 14,
        userName: 'gone',
        displayName: 'Gone User',
        domainName: 'CORP',
        emailAddress: 'gone@example.com',
        enabled: false,
        isApplicationAccount: false,
        lastLoginDaysAgo: 120,
        twoFactorMethod: '',
      },
      {
        id: 20,
        userName: DEMO_PVAULT.username,
        displayName: 'Steward (read-only)',
        domainName: '',
        emailAddress: '',
        enabled: true,
        isApplicationAccount: true,
        lastLoginDaysAgo: 0,
        twoFactorMethod: '',
      },
      {
        id: 21,
        userName: DEMO_PVAULT.limited,
        displayName: 'Limited reader',
        domainName: '',
        emailAddress: '',
        enabled: true,
        isApplicationAccount: false,
        lastLoginDaysAgo: 0,
        twoFactorMethod: '',
      },
    ],
    groups: [
      { id: 100, name: 'Domain Admins', domainName: 'CORP', members: [11, 12] },
      { id: 101, name: 'DB Admins', domainName: '', members: [12, 14] },
      { id: 102, name: 'Auditors', domainName: '', members: [10] },
      { id: 103, name: 'Hidden', domainName: '', members: [10], hidden: true },
    ],
    roles: [
      { id: 1, name: 'Administrator' },
      { id: 2, name: 'User' },
      { id: 3, name: 'Steward Reader' },
    ],
    roleAssignments: {
      10: [[1, true, []]],
      11: [[2, true, []]],
      12: [[2, false, ['Domain Admins']]],
      13: [[2, true, []]],
      20: [[3, true, []]],
      21: [[2, true, []]],
    },
    folders: [
      { id: 1, folderName: 'IT', folderPath: '\\IT', parentFolderId: -1, inheritPermissions: false, perms: [[null, 100, 'Owner', 'Owner']] },
      { id: 2, folderName: 'Servers', folderPath: '\\IT\\Servers', parentFolderId: 1, inheritPermissions: true, perms: [] },
      {
        id: 3,
        folderName: 'Privileged',
        folderPath: '\\Privileged',
        parentFolderId: -1,
        inheritPermissions: false,
        perms: [
          [10, null, 'Owner', 'Owner'],
          [null, 101, 'View', 'View'],
        ],
      },
      { id: 4, folderName: 'Domain', folderPath: '\\Privileged\\Domain', parentFolderId: 3, inheritPermissions: true, perms: [] },
      { id: 5, folderName: 'Shared', folderPath: '\\Shared', parentFolderId: -1, inheritPermissions: false, perms: [[11, null, 'Edit', 'Edit']] },
    ],
    secrets: [
      s(101, 'root@db1', 2, 'Unix Account (SSH)', 6, 'Success', 10, 80, true, false, false, true, [], 'db1-root-Pa55!'),
      s(102, 'Administrator@dc1', 4, 'Windows Account', 7, 'Success', 5, 85, true, true, true, true, [], 'dc1-Adm1n-Pa55!'),
      s(103, 'sa@sql1', 3, 'SQL Server Account', 8, 'Failed', 200, -20, false, false, false, false, [[null, 101, 'Edit']], 'sql1-sa-Pa55!'),
      s(104, 'backup-svc', 5, 'Active Directory Account', 9, 'AccountLockedOut', null, null, false, false, false, true, [], 'backup-Pa55!'),
      s(
        105,
        'web-deploy',
        2,
        'Unix Account (SSH)',
        6,
        'Success',
        30,
        60,
        true,
        false,
        false,
        false,
        [
          [11, null, 'Owner'],
          [null, 103, 'View'],
        ],
        'web-deploy-Pa55!',
      ),
      s(106, 'vpn-shared', 5, 'Web Password', 10, 'Pending', 100, 5, false, false, false, false, [[12, null, 'Owner']], 'vpn-Pa55!'),
      { ...s(107, 'old-retired', 5, 'Web Password', 10, 'Disabled', 900, null, false, false, false, true, [], 'old-Pa55!'), active: false },
    ],
    templates: [
      { id: 6, name: 'Unix Account (SSH)', heartbeatEnabled: true },
      { id: 7, name: 'Windows Account', heartbeatEnabled: true },
      { id: 8, name: 'SQL Server Account', heartbeatEnabled: true },
      { id: 9, name: 'Active Directory Account', heartbeatEnabled: true },
      { id: 10, name: 'Web Password', heartbeatEnabled: false },
    ],
    audits: {
      102: [
        [40, 'VIEW', 'Bob Builder', ''],
        [3, 'VIEW', 'Alice Admin', 'Patch night'],
        [2, 'CHECKOUT', 'Erika Mustermann', 'CHG-1234'],
        [1.9, 'CHECKIN', 'Erika Mustermann', ''],
        [1, 'HEARTBEAT', 'System', 'Heartbeat succeeded'],
      ],
      103: [
        [6, 'EDIT', 'Alice Admin', 'Changed the notes'],
        [1, 'PASSWORDDISPLAYED', 'Bob Builder', 'Incident INC-77'],
      ],
      101: [[4, 'VIEW', 'Bob Builder', '']],
    },
    requests: [
      { id: 1, secretId: 102, user: 'bob', status: 'Approved', daysAgo: 4, approver: 'Alice Admin', comment: 'Domain controller patch' },
      { id: 2, secretId: 103, user: 'erika', status: 'Denied', daysAgo: 10, approver: 'Alice Admin', comment: 'Database check' },
      { id: 3, secretId: 101, user: 'bob', status: 'Pending', daysAgo: 1, approver: '', comment: 'Disk full' },
    ],
  };
}

function s(
  id: number,
  name: string,
  folderId: number,
  secretTemplateName: string,
  secretTemplateId: number,
  lastHeartBeatStatus: string,
  changedDaysAgo: number | null,
  daysUntilExpiration: number | null,
  autoChangeEnabled: boolean,
  checkOutEnabled: boolean,
  requiresApproval: boolean,
  inheritsPermissions: boolean,
  own: Secret['own'],
  password: string,
): Secret {
  return {
    id,
    name,
    folderId,
    secretTemplateName,
    secretTemplateId,
    active: true,
    lastHeartBeatStatus,
    changedDaysAgo,
    daysUntilExpiration,
    autoChangeEnabled,
    checkOutEnabled,
    requiresApproval,
    inheritsPermissions,
    own,
    password,
  };
}

let state = seed();
const tokens = new Map<string, { user: string; expiresAt: number }>();
const refreshTokens = new Map<string, string>();
let lifetime = DEMO_PVAULT.lifetimeSeconds;
let pageCap = 1000;
let leak = false;
/** What tests check: sign-ins by grant type and calls of the value endpoints (must stay 0). */
export const pvaultCalls = { password: 0, refresh: 0, valueEndpoints: 0, requests: 0 };

export function resetPvault(): void {
  state = seed();
  tokens.clear();
  refreshTokens.clear();
  lifetime = DEMO_PVAULT.lifetimeSeconds;
  pageCap = 1000;
  leak = false;
  Object.assign(pvaultCalls, { password: 0, refresh: 0, valueEndpoints: 0, requests: 0 });
}
/** Tests: the lifetime of new access tokens (seconds). */
export function setPvaultTokenLifetime(seconds: number): void {
  lifetime = seconds;
}
/** Tests: every access token expires now (the next call answers 401). */
export function expirePvaultTokens(): void {
  for (const t of tokens.values()) t.expiresAt = 0;
}
/** Tests: at most this many records per page, whatever take asks for. */
export function setPvaultPageCap(n: number): void {
  pageCap = Math.max(1, n);
}
/** Tests: answers carry field values where the real summaries do not (a later version, a proxy) – Steward must drop them. */
export function setPvaultLeak(on: boolean): void {
  leak = on;
}
/** Tests and the demo: a new folder permission (the next snapshot shows it). */
export function addPvaultFolderPermission(folderId: number, userId: number | null, groupId: number | null, role: string): void {
  state.folders.find((f) => f.id === folderId)?.perms.push([userId, groupId, role, role]);
}

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();
const folderOf = (id: number) => state.folders.find((f) => f.id === id);
const userOf = (id: number | null) => (id === null ? undefined : state.users.find((u) => u.id === id));
const groupOf = (id: number | null) => (id === null ? undefined : state.groups.find((g) => g.id === id));

function paged<T>(req: FastifyRequest, all: T[]) {
  const q = req.query as Record<string, string | undefined>;
  const skip = Math.max(0, Number(q.skip ?? 0) || 0);
  const take = Math.min(pageCap, Math.max(1, Number(q.take ?? 10) || 10));
  const records = all.slice(skip, skip + take);
  const hasNext = skip + take < all.length;
  return {
    filter: {},
    skip,
    take,
    total: all.length,
    pageCount: Math.ceil(all.length / take),
    currentPage: Math.floor(skip / take) + 1,
    batchCount: Math.ceil(all.length / take),
    prevSkip: Math.max(0, skip - take),
    nextSkip: hasNext ? skip + take : 0,
    hasPrev: skip > 0,
    hasNext,
    records,
    sortBy: [],
    success: true,
    severity: 'None',
  };
}

function summary(x: Secret) {
  const f = folderOf(x.folderId);
  return {
    id: x.id,
    name: x.name,
    secretTemplateId: x.secretTemplateId,
    secretTemplateName: x.secretTemplateName,
    folderId: x.folderId,
    folderPath: f?.folderPath ?? '',
    siteId: 1,
    active: x.active,
    checkedOut: false,
    isRestricted: x.requiresApproval || x.checkOutEnabled,
    isOutOfSync: !!x.isOutOfSync || x.lastHeartBeatStatus === 'AccountLockedOut',
    outOfSyncReason: x.lastHeartBeatStatus === 'AccountLockedOut' ? 'The account is locked out' : '',
    lastHeartBeatStatus: x.lastHeartBeatStatus,
    lastPasswordChangeAttempt: x.changedDaysAgo === null ? null : iso(x.changedDaysAgo),
    responseCodes: [],
    lastAccessed: iso(1),
    extendedFields: leak ? [{ name: 'Password', value: x.password }] : null,
    checkOutEnabled: x.checkOutEnabled,
    autoChangeEnabled: x.autoChangeEnabled,
    doubleLockEnabled: false,
    requiresApproval: x.requiresApproval,
    requiresComment: x.requiresApproval,
    inheritsPermissions: x.inheritsPermissions,
    hidePassword: false,
    createDate: iso(400),
    daysUntilExpiration: x.daysUntilExpiration,
    hasLauncher: false,
    checkOutUserId: -1,
    checkOutUserName: '',
    ...(leak ? { items: [{ fieldName: 'Password', slug: 'password', isPassword: true, itemValue: x.password }] } : {}),
  };
}

const perm = (on: number, userId: number | null, groupId: number | null) => {
  const u = userOf(userId);
  const g = groupOf(groupId);
  return {
    id: on * 100 + (userId ?? groupId ?? 0),
    userId: userId ?? -1,
    userName: u?.userName ?? '',
    groupId: groupId ?? u?.id ?? -1,
    groupName: g?.name ?? u?.userName ?? '',
    domainName: u?.domainName ?? g?.domainName ?? '',
    knownAs: u?.displayName ?? g?.name ?? '',
  };
};

export async function mockPrivilegeVault(app: FastifyInstance): Promise<void> {
  const R = '/pvault/SecretServer';
  const A = `${R}/api/v1`;

  app.post(`${R}/oauth2/token`, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string | undefined>;
    const issue = (user: string) => {
      const access = crypto.randomBytes(24).toString('hex');
      const refresh = crypto.randomBytes(24).toString('hex');
      tokens.set(access, { user, expiresAt: Date.now() + lifetime * 1000 });
      refreshTokens.set(refresh, user);
      return { access_token: access, token_type: 'bearer', expires_in: lifetime, refresh_token: refresh };
    };
    if (b.grant_type === 'password') {
      pvaultCalls.password++;
      const user = String(b.username ?? '');
      const okUser = user === DEMO_PVAULT.username || user === DEMO_PVAULT.limited;
      // a directory account would name its domain; the demo accounts are local – a wrong domain fails like a wrong password
      if (!okUser || b.password !== DEMO_PVAULT.password || (b.domain !== undefined && b.domain !== '' && b.domain !== DEMO_PVAULT.domain))
        return reply.code(400).send({ error: 'Login failed.' });
      return issue(user);
    }
    if (b.grant_type === 'refresh_token') {
      pvaultCalls.refresh++;
      const user = refreshTokens.get(String(b.refresh_token ?? ''));
      if (!user) return reply.code(400).send({ error: 'invalid_grant' });
      refreshTokens.delete(String(b.refresh_token));
      return issue(user);
    }
    return reply.code(400).send({ error: 'unsupported_grant_type' });
  });

  app.get(`${A}/healthcheck`, async () => ({ healthy: true, databaseHealthy: true, serviceBusHealthy: true, storageAccountHealthy: true }));

  /** The signed-in user, or a 401 (null). */
  const who = (req: FastifyRequest, reply: FastifyReply): string | null => {
    pvaultCalls.requests++;
    const h = req.headers.authorization ?? '';
    const t = tokens.get(h.startsWith('Bearer ') ? h.slice(7) : '');
    if (!t || t.expiresAt <= Date.now()) {
      void reply.code(401).send({ message: 'Authentication failed or token expired.', errorCode: 'API_AuthenticationFailed' });
      return null;
    }
    return t.user;
  };
  const denied = (reply: FastifyReply) => reply.code(403).send({ message: 'Access Denied', errorCode: 'API_AccessDenied' });

  app.get(`${A}/version`, async (req, reply) => (who(req, reply) ? { success: true, model: { version: '12.0.000022' } } : reply));
  app.get(`${A}/users/current`, async (req, reply) => {
    const user = who(req, reply);
    if (!user) return reply;
    const u = state.users.find((x) => x.userName === user)!;
    return { id: u.id, userName: u.userName, displayName: u.displayName, emailAddress: u.emailAddress, domainId: -1 };
  });

  app.get(`${A}/secrets`, async (req, reply) => {
    if (!who(req, reply)) return reply;
    const q = req.query as Record<string, string | undefined>;
    const folderId = Number(q['filter.folderId'] ?? 0);
    const sub = q['filter.includeSubFolders'] === 'true';
    const text = String(q['filter.searchText'] ?? '').toLowerCase();
    const inFolder = (fid: number): boolean => {
      if (!folderId) return true;
      if (fid === folderId) return true;
      if (!sub) return false;
      const f = folderOf(fid);
      return !!f && f.parentFolderId > 0 && inFolder(f.parentFolderId);
    };
    const list = state.secrets
      .filter((x) => x.active || q['filter.includeInactive'] === 'true')
      .filter((x) => inFolder(x.folderId))
      .filter((x) => !text || x.name.toLowerCase().includes(text))
      .map(summary);
    return paged(req, list);
  });
  app.get(`${A}/secrets/:id/summary`, async (req, reply) => {
    if (!who(req, reply)) return reply;
    const x = state.secrets.find((y) => y.id === Number((req.params as { id: string }).id));
    return x ? summary(x) : reply.code(404).send({ message: 'Secret not found' });
  });
  app.get(`${A}/secrets/:id/audits`, async (req, reply) => {
    const user = who(req, reply);
    if (!user) return reply;
    if (user === DEMO_PVAULT.limited) return denied(reply);
    const id = Number((req.params as { id: string }).id);
    const list = (state.audits[id] ?? [])
      .map(([daysAgo, action, by, notes], i) => ({
        id: id * 1000 + i,
        action,
        actionForDisplay: action,
        byUserDisplayName: by,
        dateRecorded: iso(daysAgo),
        notes,
        ticketNumber: notes.startsWith('CHG-') ? notes : '',
        databaseName: '',
        status: '',
      }))
      .sort((a, b) => b.dateRecorded.localeCompare(a.dateRecorded));
    return paged(req, list);
  });
  // the value endpoints: answered like the real vault – and counted
  app.get(`${A}/secrets/:id`, async (req, reply) => {
    pvaultCalls.valueEndpoints++;
    if (!who(req, reply)) return reply;
    const x = state.secrets.find((y) => y.id === Number((req.params as { id: string }).id));
    if (!x) return reply.code(404).send({ message: 'Secret not found' });
    return { ...summary(x), items: [{ fieldName: 'Password', slug: 'password', isPassword: true, itemValue: x.password }] };
  });
  app.get(`${A}/secrets/:id/fields/:slug`, async (req, reply) => {
    pvaultCalls.valueEndpoints++;
    if (!who(req, reply)) return reply;
    const x = state.secrets.find((y) => y.id === Number((req.params as { id: string }).id));
    return x ? JSON.stringify(x.password) : reply.code(404).send({ message: 'Secret not found' });
  });

  app.get(`${A}/folders`, async (req, reply) => {
    if (!who(req, reply)) return reply;
    return paged(
      req,
      state.folders.map((f) => ({
        id: f.id,
        folderName: f.folderName,
        folderPath: f.folderPath,
        folderTypeId: 1,
        parentFolderId: f.parentFolderId,
        inheritPermissions: f.inheritPermissions,
        inheritSecretPolicy: true,
        secretPolicyId: -1,
      })),
    );
  });
  app.get(`${A}/secret-permissions`, async (req, reply) => {
    if (!who(req, reply)) return reply;
    const id = Number((req.query as Record<string, string | undefined>)['filter.secretId'] ?? 0);
    if (!id) return reply.code(400).send({ message: 'At least one filter is required' });
    const x = state.secrets.find((y) => y.id === id);
    const list = (x?.own ?? []).map(([u, g, role]) => ({ ...perm(id, u, g), secretId: id, secretAccessRoleId: 0, secretAccessRoleName: role }));
    return paged(req, list);
  });
  app.get(`${A}/folder-permissions`, async (req, reply) => {
    if (!who(req, reply)) return reply;
    const id = Number((req.query as Record<string, string | undefined>)['filter.folderId'] ?? 0);
    const f = folderOf(id);
    const list = (f?.perms ?? []).map(([u, g, role, secretRole]) => ({
      ...perm(id, u, g),
      folderId: id,
      folderAccessRoleId: 0,
      folderAccessRoleName: role,
      secretAccessRoleId: 0,
      secretAccessRoleName: secretRole,
    }));
    return paged(req, list);
  });
  app.get(`${A}/users`, async (req, reply) => {
    if (!who(req, reply)) return reply;
    const inactive = (req.query as Record<string, string | undefined>)['filter.includeInactive'] === 'true';
    return paged(
      req,
      state.users
        .filter((u) => u.enabled || inactive)
        .map((u) => ({
          id: u.id,
          userName: u.userName,
          displayName: u.displayName,
          domainId: u.domainName ? 1 : -1,
          domainName: u.domainName,
          emailAddress: u.emailAddress,
          enabled: u.enabled,
          isApplicationAccount: u.isApplicationAccount,
          isLockedOut: false,
          lastLogin: u.lastLoginDaysAgo === null ? null : iso(u.lastLoginDaysAgo),
          loginFailures: 0,
          twoFactorMethod: u.twoFactorMethod,
          created: iso(500),
        })),
    );
  });
  app.get(`${A}/groups`, async (req, reply) => {
    if (!who(req, reply)) return reply;
    return paged(
      req,
      state.groups.map((g) => ({ id: g.id, name: g.name, domainName: g.domainName, domainId: g.domainName ? 1 : -1, enabled: true, created: iso(500) })),
    );
  });
  app.get(`${A}/groups/:id/users`, async (req, reply) => {
    if (!who(req, reply)) return reply;
    const g = groupOf(Number((req.params as { id: string }).id));
    if (!g) return reply.code(404).send({ message: 'Group not found' });
    if (g.hidden) return denied(reply);
    return paged(
      req,
      g.members.map((id) => {
        const u = userOf(id)!;
        return {
          groupId: g.id,
          groupName: g.name,
          userId: u.id,
          userName: u.userName,
          displayName: u.displayName,
          enabled: u.enabled,
          userDomainName: u.domainName,
        };
      }),
    );
  });
  app.get(`${A}/roles`, async (req, reply) => {
    const user = who(req, reply);
    if (!user) return reply;
    if (user === DEMO_PVAULT.limited) return denied(reply);
    return paged(
      req,
      state.roles.map((r) => ({ id: r.id, name: r.name, enabled: true, isSystem: r.id < 3, created: iso(800) })),
    );
  });
  app.get(`${A}/users/:id/roles-assigned`, async (req, reply) => {
    const user = who(req, reply);
    if (!user) return reply;
    if (user === DEMO_PVAULT.limited) return denied(reply);
    const id = Number((req.params as { id: string }).id);
    return paged(
      req,
      (state.roleAssignments[id] ?? []).map(([roleId, direct, groups]) => ({
        roleId,
        roleName: state.roles.find((r) => r.id === roleId)?.name ?? '',
        isDirectAssignment: direct,
        groups: groups.map((name) => ({ groupId: state.groups.find((g) => g.name === name)?.id ?? 0, groupName: name })),
      })),
    );
  });
  app.get(`${A}/secret-templates`, async (req, reply) => {
    if (!who(req, reply)) return reply;
    return paged(
      req,
      state.templates.map((t) => ({ ...t, active: true, secretCount: state.secrets.filter((x) => x.secretTemplateId === t.id).length, passwordTypeId: 1 })),
    );
  });
  app.get(`${A}/secret-access-requests`, async (req, reply) => {
    if (!who(req, reply)) return reply;
    return paged(
      req,
      state.requests.map((r) => {
        const x = state.secrets.find((y) => y.id === r.secretId)!;
        return {
          secretAccessRequestId: r.id,
          secretId: r.secretId,
          secretName: x.name,
          folderId: x.folderId,
          requestUsername: r.user,
          requestingUserId: userOf(state.users.find((u) => u.userName === r.user)?.id ?? null)?.id ?? 0,
          status: r.status,
          requestDate: iso(r.daysAgo),
          responseDate: r.status === 'Pending' ? null : iso(r.daysAgo - 0.1),
          approverDisplayName: r.approver,
          requestComment: r.comment,
          responseComment: '',
          ticketNumber: '',
          startDate: iso(r.daysAgo),
          expirationDate: iso(r.daysAgo - 1),
          completed: r.status !== 'Pending',
        };
      }),
    );
  });
}
