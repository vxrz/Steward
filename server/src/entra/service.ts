import {
  ENTRA_PERMISSIONS,
  type AccessSubject,
  type EntraAppCredential,
  type EntraCheckMode,
  type EntraScope,
  type MonitorStatus,
  type Platform,
} from '@sm/shared';
import { tokenClaims } from '../platforms/http.js';
import { GraphError, graphGet, graphList, optionalList } from './graph.js';

/**
 * Entra ID through Microsoft Graph (v0.5.0, docs/ENTRA.md) – read-only:
 *
 *   access     users (UPN, e-mail addresses as other names, guests, disabled accounts, last sign-in, MFA registration),
 *              group memberships (direct and nested) and ownerships, directory role assignments (active and – where
 *              readable – eligible through PIM), app role assignments of the enterprise applications
 *   credentials secrets and certificates of app registrations and service principals, with their end dates
 *   health     Microsoft 365 service health (optional permission ServiceHealth.Read.All)
 *
 * Parts that need Entra ID P1/P2 (sign-in activity, MFA registration, PIM) or an optional permission are used when
 * readable; otherwise the result says "not available (licence or permission)" and the rest is read as usual.
 */

export const ENTRA_LIMITS = { users: 50_000, groups: 5_000, servicePrincipals: 2_000, membersPerGroup: 50_000, workers: 4 } as const;

const DAY = 86_400_000;
const NOT_AVAILABLE = 'not available (licence or permission)';

interface GUser {
  id: string;
  userPrincipalName?: string;
  displayName?: string;
  mail?: string | null;
  otherMails?: string[];
  userType?: string;
  accountEnabled?: boolean;
  externalUserState?: string | null;
  signInActivity?: {
    lastSignInDateTime?: string | null;
    lastNonInteractiveSignInDateTime?: string | null;
    lastSuccessfulSignInDateTime?: string | null;
  } | null;
}
interface GObject {
  '@odata.type'?: string;
  id: string;
  displayName?: string;
  userPrincipalName?: string;
  appId?: string;
}
interface GGroup {
  id: string;
  displayName?: string;
}
interface GRoleAssignment {
  principalId?: string;
  roleDefinitionId?: string;
  directoryScopeId?: string;
}
interface GServicePrincipal {
  id: string;
  appId?: string;
  displayName?: string;
  appRoles?: { id?: string; value?: string | null; displayName?: string }[];
  passwordCredentials?: GCredential[];
  keyCredentials?: GCredential[];
}
interface GCredential {
  keyId?: string;
  displayName?: string | null;
  startDateTime?: string | null;
  endDateTime?: string | null;
  usage?: string;
}
interface GApplication {
  id: string;
  appId?: string;
  displayName?: string;
  passwordCredentials?: GCredential[];
  keyCredentials?: GCredential[];
}

const text = (s: unknown) =>
  String(s ?? '')
    .trim()
    .slice(0, 300);
const typeOf = (o: GObject) => (o['@odata.type'] ?? '').replace('#microsoft.graph.', '');

/** The latest sign-in of a user (interactive, non-interactive or the last successful one), or null. */
export function lastSignIn(a: GUser['signInActivity']): string | null {
  const times = [a?.lastSignInDateTime, a?.lastNonInteractiveSignInDateTime, a?.lastSuccessfulSignInDateTime]
    .map((x) => (x ? Date.parse(x) : NaN))
    .filter((x) => !Number.isNaN(x));
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

/** Runs `fn` for every item with a few at a time (the platform layer limits the requests in flight anyway). */
async function pool<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(ENTRA_LIMITS.workers, items.length) }, worker));
}

export interface EntraAccess {
  subjects: AccessSubject[];
  /** Parts not read, in plain words (licence or permission missing) */
  notes: string[];
}

/**
 * Who has what in the tenant, for an access review (source "entra"). Users are named by their user principal name, with
 * their e-mail addresses and object id as other names – person reviews find them by any of these. Groups and service
 * principals that hold a role themselves are subjects too (group:<name>, sp:<name>).
 *
 * Rights: group:<name>, group:<name> (nested), owner:group:<name>, role:<name> [@<scope>] [(eligible)] [(via group <g>)],
 * app:<application>[/<app role>] [(via group <g>)], account:disabled.
 */
export async function entraAccess(platform: Platform, secrets: Record<string, string>, scope: EntraScope | '' = ''): Promise<EntraAccess> {
  const notes: string[] = [];
  const base = 'id,userPrincipalName,displayName,mail,otherMails,userType,accountEnabled,externalUserState';
  let users: GUser[];
  let signIns = true;
  try {
    users = await graphList<GUser>(platform, secrets, '/v1.0/users', { $select: `${base},signInActivity` }, { maxItems: ENTRA_LIMITS.users });
  } catch (e) {
    if (!(e instanceof GraphError && e.unavailable)) throw e;
    // sign-in activity needs AuditLog.Read.All and Entra ID P1: without it, the users alone
    users = await graphList<GUser>(platform, secrets, '/v1.0/users', { $select: base }, { maxItems: ENTRA_LIMITS.users });
    signIns = false;
    notes.push(`Last sign-in ${NOT_AVAILABLE}: ${e.message}`);
  }
  const mfa = new Map<string, boolean>();
  const reg = await optionalList<{ id: string; isMfaRegistered?: boolean }>(platform, secrets, '/v1.0/reports/authenticationMethods/userRegistrationDetails', {
    $select: 'id,isMfaRegistered',
  });
  if (reg.items) for (const r of reg.items) mfa.set(r.id, !!r.isMfaRegistered);
  else notes.push(`MFA registration ${NOT_AVAILABLE}: ${reg.unavailable}`);

  const byId = new Map<string, GUser>(users.map((u) => [u.id, u]));
  const rights = new Map<string, Set<string>>();
  const grant = (key: string, right: string) => {
    let s = rights.get(key);
    if (!s) rights.set(key, (s = new Set()));
    s.add(right.slice(0, 300));
  };
  // non-user subjects (groups, service principals holding a role or an app role themselves)
  const others = new Map<string, { id: string; name: string; type: string; aliases: string[] }>();
  const otherSubject = (o: { id: string; name: string; type: 'group' | 'service principal'; aliases: string[] }) => {
    const key = `${o.type === 'group' ? 'group' : 'sp'}:${o.name || o.aliases[0]}`;
    if (!others.has(o.id)) others.set(o.id, { id: key, name: o.name, type: o.type, aliases: o.aliases });
    return o.id;
  };

  // groups: members (direct; nested ones resolved here) and owners, read when needed
  const groups = await graphList<GGroup>(platform, secrets, '/v1.0/groups', { $select: 'id,displayName' }, { maxItems: ENTRA_LIMITS.groups });
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const groupName = (id: string) => text(groupById.get(id)?.displayName) || id;
  const members = new Map<string, GObject[]>();
  const loadMembers = async (ids: string[]) => {
    const todo = [...new Set(ids)].filter((id) => !members.has(id) && groupById.has(id));
    await pool(todo, async (id) => {
      members.set(
        id,
        await graphList<GObject>(
          platform,
          secrets,
          `/v1.0/groups/${encodeURIComponent(id)}/members`,
          { $select: 'id,displayName,userPrincipalName,appId' },
          {
            maxItems: ENTRA_LIMITS.membersPerGroup,
          },
        ),
      );
    });
    // nested groups: their members too
    const nested = todo.flatMap((id) => (members.get(id) ?? []).filter((m) => typeOf(m) === 'group').map((m) => m.id));
    if (nested.length) await loadMembers(nested);
  };
  /** Users in a group: direct members, and those of nested groups (marked). */
  const usersIn = (groupId: string): { direct: Set<string>; nested: Set<string> } => {
    const direct = new Set<string>();
    const nested = new Set<string>();
    const seen = new Set<string>([groupId]);
    const walk = (id: string, top: boolean) => {
      for (const m of members.get(id) ?? []) {
        const t = typeOf(m);
        if (t === 'group') {
          if (!seen.has(m.id)) {
            seen.add(m.id);
            walk(m.id, false);
          }
        } else if (t === 'user' || byId.has(m.id)) (top ? direct : nested).add(m.id);
      }
    };
    walk(groupId, true);
    for (const d of direct) nested.delete(d);
    return { direct, nested };
  };

  const want = (part: 'groups' | 'roles' | 'apps') => scope === '' || scope === 'guests' || scope === part;

  if (want('groups')) {
    await loadMembers(groups.map((g) => g.id));
    for (const g of groups) {
      const { direct, nested } = usersIn(g.id);
      for (const u of direct) grant(u, `group:${groupName(g.id)}`);
      for (const u of nested) grant(u, `group:${groupName(g.id)} (nested)`);
    }
    await pool(groups, async (g) => {
      const owners = await graphList<GObject>(platform, secrets, `/v1.0/groups/${encodeURIComponent(g.id)}/owners`, {
        $select: 'id,displayName,userPrincipalName,appId',
      });
      for (const o of owners)
        if (typeOf(o) === 'servicePrincipal')
          grant(
            otherSubject({ id: o.id, name: text(o.displayName), type: 'service principal', aliases: [o.appId ?? '', o.id].filter(Boolean) }),
            `owner:group:${groupName(g.id)}`,
          );
        else grant(o.id, `owner:group:${groupName(g.id)}`);
    });
  }

  // service principals: named in role and app role assignments
  let sps: GServicePrincipal[] = [];
  const spById = new Map<string, GServicePrincipal>();
  const loadSps = async () => {
    if (sps.length) return;
    sps = await graphList<GServicePrincipal>(
      platform,
      secrets,
      '/v1.0/servicePrincipals',
      { $select: 'id,appId,displayName,appRoles' },
      {
        maxItems: ENTRA_LIMITS.servicePrincipals * 10,
      },
    );
    for (const s of sps) spById.set(s.id, s);
  };
  /** A right of a principal: a user directly, a group's users (and the group itself), a service principal. */
  const grantTo = async (principalId: string, right: string) => {
    if (byId.has(principalId)) return grant(principalId, right);
    if (groupById.has(principalId)) {
      grant(otherSubject({ id: principalId, name: groupName(principalId), type: 'group', aliases: [principalId] }), right);
      await loadMembers([principalId]);
      const { direct, nested } = usersIn(principalId);
      for (const u of [...direct, ...nested]) grant(u, `${right} (via group ${groupName(principalId)})`);
      return;
    }
    await loadSps();
    const sp = spById.get(principalId);
    grant(
      otherSubject({ id: principalId, name: text(sp?.displayName), type: 'service principal', aliases: [sp?.appId ?? '', principalId].filter(Boolean) }),
      right,
    );
  };

  if (want('roles')) {
    const defs = await graphList<{ id: string; displayName?: string }>(platform, secrets, '/v1.0/roleManagement/directory/roleDefinitions', {
      $select: 'id,displayName',
    });
    const roleName = new Map(defs.map((d) => [d.id, text(d.displayName) || d.id]));
    const right = (a: GRoleAssignment, eligible: boolean) =>
      `role:${roleName.get(a.roleDefinitionId ?? '') ?? a.roleDefinitionId ?? '?'}${a.directoryScopeId && a.directoryScopeId !== '/' ? ` @${a.directoryScopeId}` : ''}${eligible ? ' (eligible)' : ''}`;
    const active = await graphList<GRoleAssignment>(platform, secrets, '/v1.0/roleManagement/directory/roleAssignments', {
      $select: 'id,principalId,roleDefinitionId,directoryScopeId',
    });
    for (const a of active) if (a.principalId) await grantTo(a.principalId, right(a, false));
    // eligible assignments (PIM) need Entra ID P2
    const eligible = await optionalList<GRoleAssignment>(platform, secrets, '/v1.0/roleManagement/directory/roleEligibilityScheduleInstances', {
      $select: 'id,principalId,roleDefinitionId,directoryScopeId',
    });
    if (eligible.items) {
      for (const a of eligible.items) if (a.principalId) await grantTo(a.principalId, right(a, true));
    } else notes.push(`Eligible role assignments (PIM) ${NOT_AVAILABLE}: ${eligible.unavailable}`);
  }

  if (want('apps')) {
    // the enterprise applications (what the Entra admin center lists): who is assigned to which app role
    const apps = await graphList<GServicePrincipal>(
      platform,
      secrets,
      '/v1.0/servicePrincipals',
      { $select: 'id,appId,displayName,appRoles', $filter: "tags/any(t:t eq 'WindowsAzureActiveDirectoryIntegratedApp')" },
      { maxItems: ENTRA_LIMITS.servicePrincipals },
    );
    await pool(apps, async (sp) => {
      const assigned = await graphList<{ principalId?: string; appRoleId?: string }>(
        platform,
        secrets,
        `/v1.0/servicePrincipals/${encodeURIComponent(sp.id)}/appRoleAssignedTo`,
        { $select: 'id,principalId,appRoleId' },
      );
      for (const a of assigned) {
        if (!a.principalId) continue;
        const role = (sp.appRoles ?? []).find((r) => r.id === a.appRoleId);
        const roleName = text(role?.value || role?.displayName);
        await grantTo(a.principalId, `app:${text(sp.displayName) || sp.appId}${roleName ? `/${roleName}` : ''}`);
      }
    });
  }

  const subjects: AccessSubject[] = [];
  for (const u of users) {
    const guest = (u.userType ?? '').toLowerCase() === 'guest';
    if (scope === 'guests' && !guest) continue;
    const r = [...(rights.get(u.id) ?? [])];
    if (u.accountEnabled === false) r.push('account:disabled');
    // groups, roles, apps: the people with such a right only (the whole tenant is the empty scope)
    if ((scope === 'groups' || scope === 'roles' || scope === 'apps') && !rights.get(u.id)?.size) continue;
    const upn = text(u.userPrincipalName) || u.id;
    const aliases = [...new Set([u.mail ?? '', ...(u.otherMails ?? []), u.id].map(text).filter((a) => a && a.toLowerCase() !== upn.toLowerCase()))];
    const parts: string[] = [];
    let activityInfo: AccessSubject['activityInfo'];
    if (signIns) {
      const last = lastSignIn(u.signInActivity);
      parts.push(last ? `last sign-in ${last.slice(0, 10)} (${Math.max(0, Math.floor((Date.now() - Date.parse(last)) / DAY))} days ago)` : 'never signed in');
      activityInfo = { lastLoginAt: last, passwordWithoutMfa: mfa.get(u.id) === false };
    } else parts.push(`last sign-in ${NOT_AVAILABLE}`);
    if (mfa.get(u.id) === false) parts.push('no MFA method registered');
    if (guest && u.externalUserState === 'PendingAcceptance') parts.push('invitation not accepted');
    if (u.accountEnabled === false) parts.push('account disabled');
    subjects.push({
      id: upn,
      name: text(u.displayName),
      type: guest ? 'guest' : 'user',
      rights: r,
      ...(aliases.length ? { aliases: aliases.slice(0, 10) } : {}),
      activity: parts.join(', '),
      ...(activityInfo ? { activityInfo } : {}),
    });
  }
  if (scope !== 'guests')
    for (const [objectId, o] of others) {
      const r = [...(rights.get(objectId) ?? [])];
      if (r.length) subjects.push({ id: o.id, name: o.name, type: o.type, rights: r, aliases: o.aliases.slice(0, 10) });
    }
  const only = scope === 'groups' ? /^(group|owner):/ : scope === 'roles' ? /^role:/ : scope === 'apps' ? /^app:/ : null;
  return {
    subjects: only ? subjects.map((s) => ({ ...s, rights: s.rights.filter((x) => only.test(x)) })).filter((s) => s.rights.length) : subjects,
    notes,
  };
}

// ---------- app credentials ----------

const credentialsOf = (owner: EntraAppCredential['owner'], a: GApplication | GServicePrincipal, now: number): EntraAppCredential[] => {
  const one = (type: EntraAppCredential['type'], c: GCredential): EntraAppCredential => {
    const end = c.endDateTime ? Date.parse(c.endDateTime) : NaN;
    return {
      owner,
      appId: text(a.appId),
      appName: text(a.displayName) || text(a.appId),
      type,
      keyId: text(c.keyId),
      name: text(c.displayName),
      startDateTime: c.startDateTime ?? null,
      endDateTime: Number.isNaN(end) ? null : new Date(end).toISOString(),
      daysLeft: Number.isNaN(end) ? null : Math.floor((end - now) / DAY),
    };
  };
  return [
    ...(a.passwordCredentials ?? []).map((c) => one('secret', c)),
    // a certificate's "Sign" usage is its private key half (SAML signing): the "Verify" half carries the same dates
    ...(a.keyCredentials ?? []).filter((c) => c.usage !== 'Sign').map((c) => one('certificate', c)),
  ];
};

/**
 * Secrets and certificates of every app registration and – where readable – of the enterprise applications (their SAML
 * signing certificates), with the days left. Only names, ids and dates: Graph never returns the secrets themselves, and
 * the hint (the first characters of a secret) is left out.
 */
export async function appCredentials(
  platform: Platform,
  secrets: Record<string, string>,
  now = Date.now(),
): Promise<{ items: EntraAppCredential[]; notes: string[] }> {
  const apps = await graphList<GApplication>(platform, secrets, '/v1.0/applications', { $select: 'id,appId,displayName,passwordCredentials,keyCredentials' });
  const sps = await optionalList<GServicePrincipal>(platform, secrets, '/v1.0/servicePrincipals', {
    $select: 'id,appId,displayName,passwordCredentials,keyCredentials',
    $filter: "tags/any(t:t eq 'WindowsAzureActiveDirectoryIntegratedApp')",
  });
  const items = [...apps.flatMap((a) => credentialsOf('application', a, now)), ...(sps.items ?? []).flatMap((s) => credentialsOf('servicePrincipal', s, now))];
  items.sort((a, b) => (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity) || a.appName.localeCompare(b.appName));
  return { items, notes: sps.unavailable ? [`Service principal credentials ${NOT_AVAILABLE}: ${sps.unavailable}`] : [] };
}

/**
 * Per application and type, the credential that lasts longest: an expired or expiring secret next to a newer one counts
 * as rotated. Returns the ones whose last credential ends within `days` (expired ones too), soonest first.
 */
export function expiringApps(
  items: EntraAppCredential[],
  days: number,
): { appName: string; appId: string; type: EntraAppCredential['type']; daysLeft: number }[] {
  const last = new Map<string, { appName: string; appId: string; type: EntraAppCredential['type']; daysLeft: number }>();
  for (const c of items) {
    if (c.daysLeft === null) continue;
    const key = `${c.owner}|${c.appId}|${c.type}`;
    const cur = last.get(key);
    if (!cur || c.daysLeft > cur.daysLeft) last.set(key, { appName: c.appName, appId: c.appId, type: c.type, daysLeft: c.daysLeft });
  }
  return [...last.values()].filter((x) => x.daysLeft <= days).sort((a, b) => a.daysLeft - b.daysLeft);
}

// ---------- monitor check ----------

export interface EntraCheckDef {
  mode: EntraCheckMode;
  withinDays?: number;
  downWithinDays?: number;
  apps?: string[];
  services?: string[];
}

const OK_HEALTH = new Set(['serviceOperational', 'serviceRestored', 'postIncidentReviewPublished', 'falsePositive', 'resolved']);

/** Monitor check "entra" (v0.5.0): app credentials that expire, or Microsoft 365 service health. */
export async function entraCheck(
  platform: Platform,
  secrets: Record<string, string>,
  c: EntraCheckDef,
): Promise<{ status: MonitorStatus; message: string; value?: unknown }> {
  if (c.mode === 'service-health') {
    const list = await graphList<{ id?: string; service?: string; status?: string }>(platform, secrets, '/v1.0/admin/serviceAnnouncement/healthOverviews', {
      $select: 'id,service,status',
    });
    const names = (c.services ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const shown = names.length
      ? list.filter((s) => names.includes(String(s.service ?? '').toLowerCase()) || names.includes(String(s.id ?? '').toLowerCase()))
      : list;
    if (names.length && !shown.length) return { status: 'unknown', message: `Microsoft 365: none of the services ${names.join(', ')} found` };
    const bad = shown.filter((s) => !OK_HEALTH.has(String(s.status)));
    const value = { services: shown.length, notOperational: bad.length };
    if (!bad.length) return { status: 'up', message: `Microsoft 365: ${shown.length} service(s) operational`, value };
    const down = bad.some((s) => s.status === 'serviceInterruption');
    return {
      status: down ? 'down' : 'degraded',
      message: `Microsoft 365: ${bad.map((s) => `${s.service} ${s.status}`).join(', ')}`.slice(0, 500),
      value,
    };
  }
  const within = c.withinDays ?? 30;
  const downWithin = Math.min(c.downWithinDays ?? 7, within);
  const { items } = await appCredentials(platform, secrets);
  const filter = (c.apps ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean);
  const mine = filter.length ? items.filter((i) => filter.includes(i.appName.toLowerCase()) || filter.includes(i.appId.toLowerCase())) : items;
  if (filter.length && !mine.length) return { status: 'unknown', message: `Entra ID: no app registration ${filter.join(', ')} with a secret or certificate` };
  const soon = expiringApps(mine, within);
  const word = (d: number) => (d < 0 ? `expired ${-d} day(s) ago` : d === 0 ? 'expires today' : `expires in ${d} day(s)`);
  const value = { credentials: mine.length, expiring: soon.length, soonestDays: soon[0]?.daysLeft ?? null };
  if (!soon.length) return { status: 'up', message: `Entra ID: no app secret or certificate expires within ${within} days (${mine.length} checked)`, value };
  const list = soon
    .slice(0, 5)
    .map((s) => `${s.appName} ${s.type} ${word(s.daysLeft)}`)
    .join(', ');
  return {
    status: soon[0]!.daysLeft <= downWithin ? 'down' : 'degraded',
    message: `Entra ID: ${soon.length} app credential(s) expire within ${within} days – ${list}${soon.length > 5 ? ', …' : ''}`.slice(0, 500),
    value,
  };
}

// ---------- connection test ----------

export interface TestCheck {
  name: string;
  ok: boolean;
  message: string;
}

/** What the sign-in error of Entra ID (AADSTS…) means, in plain words. */
export function signInHint(message: string): string {
  const m = /AADSTS(\d+)/.exec(message);
  const code = m?.[1] ?? '';
  const hints: Record<string, string> = {
    '90002': 'the tenant (variable tenantId) does not exist – use the directory (tenant) id or a verified domain',
    '900023': 'the tenant (variable tenantId) is not a valid tenant id or domain',
    '700016': 'the client id is not an app registration of this tenant – check the application (client) id and the tenant',
    '7000215': 'the client secret is wrong – use the secret’s value, not its secret id',
    '7000222': 'the client secret has expired – create a new one under Certificates & secrets',
    '700027': 'the certificate is not registered on the app registration, or the private key does not belong to it',
    '700024': 'the client assertion is outside its validity – check the server clock',
    '1002012': 'the scope is not valid – it must be the base URL followed by /.default',
    '70011': 'the scope is not valid – it must be the base URL followed by /.default',
    '65001': 'admin consent is missing – an administrator grants it under API permissions',
    '7000112': 'the app registration is disabled',
    '53003': 'a Conditional Access policy blocks the sign-in of the app',
  };
  const hint = hints[code];
  return hint ? `${message.slice(0, 400)} – ${hint} (docs/ENTRA.md)` : message;
}

/**
 * Connection test of a Microsoft Graph platform: signs in (Entra ID sign-in errors in plain words), reads which
 * application permissions the token carries (no roles at all: admin consent is missing), then probes each part Steward
 * reads. Passes when the sign-in works, permissions are consented and the users are readable; parts that need a licence
 * or an optional permission are listed as not available.
 */
export async function testGraph(platform: Platform, secrets: Record<string, string>): Promise<{ ok: boolean; message: string; checks: TestCheck[] }> {
  let org: { displayName?: string; id?: string } | undefined;
  try {
    org = (await graphList<{ displayName?: string; id?: string }>(platform, secrets, '/v1.0/organization', { $select: 'id,displayName' }))[0];
  } catch (e) {
    if (!(e instanceof GraphError)) throw new Error(signInHint((e as Error).message));
    // signed in, but the tenant itself is not readable (Directory.Read.All missing): the probes below say what is
  }
  const claims = tokenClaims(platform.id);
  const roles = Array.isArray(claims?.roles) ? (claims.roles as unknown[]).map(String) : [];
  const checks: TestCheck[] = [];
  const signedIn = `signed in${org?.displayName ? ` to ${org.displayName}` : ''}${claims?.tid ? ` (tenant ${String(claims.tid)})` : ''}`;
  if (!roles.length) {
    checks.push({
      name: 'Admin consent',
      ok: false,
      message:
        'the access token carries no application permission – an administrator has to grant admin consent (Entra admin center → App registrations → API permissions → Grant admin consent)',
    });
  } else {
    const missing = ENTRA_PERMISSIONS.filter((p) => !p.optional && !roles.includes(p.permission)).map((p) => p.permission);
    checks.push({
      name: 'Application permissions',
      ok: !missing.length,
      message: missing.length
        ? `granted: ${roles.join(', ')}; missing or without admin consent: ${missing.join(', ')}`
        : `granted with admin consent: ${roles.join(', ')}`,
    });
  }
  const probe = async (name: string, path: string, query: Record<string, unknown>, optional: string | null) => {
    try {
      // the first page only
      await graphGet(platform, secrets, path, { ...query, $top: 1 });
      checks.push({ name, ok: true, message: 'readable' });
      return true;
    } catch (e) {
      const m = (e as Error).message;
      checks.push({ name, ok: false, message: optional && e instanceof GraphError && e.unavailable ? `${NOT_AVAILABLE}${optional} – ${m}` : m });
      return false;
    }
  };
  const usersOk = await probe('Users (User.Read.All)', '/v1.0/users', { $select: 'id' }, null);
  await probe('Groups (Group.Read.All)', '/v1.0/groups', { $select: 'id' }, null);
  await probe('Directory roles (RoleManagement.Read.Directory)', '/v1.0/roleManagement/directory/roleAssignments', {}, null);
  await probe('App registrations (Application.Read.All)', '/v1.0/applications', { $select: 'id' }, null);
  await probe('Last sign-in (AuditLog.Read.All, Entra ID P1)', '/v1.0/users', { $select: 'id,signInActivity' }, ', optional');
  await probe('MFA registration (AuditLog.Read.All, Entra ID P1)', '/v1.0/reports/authenticationMethods/userRegistrationDetails', {}, ', optional');
  await probe(
    'Eligible roles, PIM (RoleManagement.Read.Directory, Entra ID P2)',
    '/v1.0/roleManagement/directory/roleEligibilityScheduleInstances',
    {},
    ', optional',
  );
  await probe('Service health (ServiceHealth.Read.All)', '/v1.0/admin/serviceAnnouncement/healthOverviews', {}, ', optional');
  const notReadable = checks.filter((c) => !c.ok).map((c) => c.name.replace(/ \(.*$/, ''));
  const ok = roles.length > 0 && usersOk;
  const message = !roles.length
    ? `Microsoft Graph: ${signedIn}, but admin consent is missing – the token carries no application permission (docs/ENTRA.md)`
    : `Microsoft Graph: ${signedIn}${notReadable.length ? `. Not readable: ${notReadable.join(', ')} – see below.` : ' – every part is readable'}`;
  return { ok, message, checks };
}
