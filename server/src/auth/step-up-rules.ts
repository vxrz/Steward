import type { FastifyRequest } from 'fastify';
import { getSettings, passwordLoginMode } from '../settings.js';
import { channelSecrets, getNotificationSettings } from '../notifications/settings.js';
import { getPlatform } from '../platforms/service.js';
import { getProcess, permissionsFor } from '../processes/service.js';
import { requireMonitor } from '../monitors/service.js';
import { getUser, listTeams } from './users.js';
import { MONITOR_PERMISSIONS, PLATFORM_PERMISSIONS, PROCESS_PERMISSIONS, type Role } from '@sm/shared';
import { DEFAULT_PLATFORM, DEFAULT_PROCESS } from './permissions.js';
import { MONITOR_DEFAULTS } from '../monitors/model.js';

/**
 * Step-up rules of routes where only some changes are sensitive (step-up.ts): the request asks for a confirmation when
 * it changes what is listed here, and goes through without one otherwise (a new display name, a retention period).
 * The body is the raw request body (validated by the route afterwards). A rule that throws asks for the confirmation –
 * except "not found" (404), which the route answers itself.
 */

const body = (req: FastifyRequest): Record<string, unknown> => (req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {});
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map((x) => String(x).trim().toLowerCase()).filter(Boolean) : undefined);
const sameSet = (a: string[], b: string[]) => new Set(a).size === new Set(b).size && a.every((x) => b.includes(x));
const id = (req: FastifyRequest) => (req.params as { id: string }).id;

/** A new account with roles (granting a role). */
export function grantsRoles(req: FastifyRequest): boolean {
  return (list(body(req).roles) ?? []).length > 0;
}

/** An account change of roles, of the sign-in provider (binding), or activating / deactivating an administrator. */
export function changesAccess(req: FastifyRequest): boolean {
  const b = body(req);
  const u = getUser(id(req));
  if (b.provider) return true;
  const roles = list(b.roles);
  if (roles && !sameSet(roles, u.roles)) return true;
  const admin = u.roles.includes('admin') || !!roles?.includes('admin');
  return typeof b.active === 'boolean' && b.active !== u.active && admin;
}

/**
 * Sign-in mode (password sign-in), the outbound policy and allow-list, and turning the four-eyes rule for dismissing
 * compliance findings off.
 */
export function changesSignInOrOutbound(req: FastifyRequest): boolean {
  const b = body(req);
  const s = getSettings();
  if (b.passwordLogin !== undefined && b.passwordLogin !== passwordLoginMode()) return true;
  if (b.outboundPolicy !== undefined && b.outboundPolicy !== s.outboundPolicy) return true;
  if (b.findingDismissFourEyes === false && s.findingDismissFourEyes !== false) return true;
  const allow = list(b.outboundAllowList);
  return (
    !!allow &&
    !sameSet(
      allow,
      (s.outboundAllowList ?? []).map((x) => x.toLowerCase()),
    )
  );
}

/**
 * Where notifications go and who they may reach: the SMTP server, port, TLS, user and sender, a new or replaced Teams or
 * webhook URL, the base URL of links, the allowed e-mail domains, and the channels of the emergency access alert.
 * Changing only the password or removing a URL is not sensitive (it cannot send anything elsewhere).
 */
export function changesNotificationDelivery(req: FastifyRequest): boolean {
  const b = body(req);
  const now = getNotificationSettings();
  const email = obj(b.email);
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v));
  const smtp = (['host', 'user', 'from'] as const).some((k) => k in email && text(email[k]).toLowerCase() !== text(now.email[k]).toLowerCase());
  if (smtp || ('port' in email && Number(email.port) !== now.email.port) || ('secure' in email && !!email.secure !== now.email.secure)) return true;
  const secrets = channelSecrets();
  const url = (v: unknown, stored: string | undefined) => typeof v === 'string' && v.trim() !== '' && v.trim() !== (stored ?? '');
  if (url(obj(b.teams).webhookUrl, secrets.teamsWebhookUrl) || url(obj(b.webhook).url, secrets.webhookUrl)) return true;
  if ('baseUrl' in b && text(b.baseUrl).replace(/\/+$/, '') !== (now.baseUrl ?? '')) return true;
  const emergency = list(obj(b.routes)['security.emergency']);
  if (
    emergency &&
    !sameSet(
      emergency,
      now.routes['security.emergency'].map((c) => c.toLowerCase()),
    )
  )
    return true;
  const domains = list(b.allowedEmailDomains)?.map((d) => d.replace(/^@/, '').replace(/\.$/, ''));
  return !!domains && !sameSet(domains, now.allowedEmailDomains);
}

/**
 * Teams are subjects of access lists (team:<name>): adding a member, or renaming a team to a name an access list grants
 * rights to, gives lasting access like a role. Removing members (and deleting a team) takes access away only.
 */
export function changesTeamMembers(req: FastifyRequest): boolean {
  const b = body(req);
  const tid = (req.params as { id?: string }).id;
  if (!tid) return (list(b.members) ?? []).length > 0;
  const team = listTeams().find((t) => t.id === tid);
  if (!team) return false; // the route answers 404
  if (typeof b.name === 'string' && b.name.trim().toLowerCase() !== team.name.toLowerCase()) return true;
  const before = team.members.map((m) => m.toLowerCase());
  if (list(b.members)?.some((m) => !before.includes(m))) return true;
  // a role in the team that a member did not have before grants rights on the team's resources (#131)
  const had = new Map(Object.entries(team.memberRoles).map(([k, v]) => [k.toLowerCase(), v]));
  const given = b.memberRoles && typeof b.memberRoles === 'object' ? Object.entries(b.memberRoles as Record<string, unknown>) : [];
  return given.some(([name, roles]) => Array.isArray(roles) && roles.some((r) => !(had.get(name.toLowerCase()) ?? []).includes(r)));
}

type Entry = { subject?: unknown; permissions?: unknown };
type Grants = Map<string, Set<string>>;

/** How rights of one kind of object add up: the defaults of an empty list, rights that imply others, what never changes. */
interface RightsModel {
  /** Rights of each role while the access list is empty (administrators always have all: left out) */
  defaults: Record<Role, readonly string[]>;
  /** Every right of the object (the owner's) */
  all: readonly string[];
  /** Rights another right implies (manage → use …) */
  implies: Record<string, readonly string[]>;
  /** Auditors always view (processes, monitors) */
  auditorsView: boolean;
}
const PLATFORM_RIGHTS: RightsModel = { defaults: DEFAULT_PLATFORM, all: PLATFORM_PERMISSIONS, implies: { manage: ['use'] }, auditorsView: false };
const PROCESS_RIGHTS: RightsModel = { defaults: DEFAULT_PROCESS, all: PROCESS_PERMISSIONS, implies: { '*': ['view'] }, auditorsView: true };
const MONITOR_RIGHTS: RightsModel = {
  defaults: MONITOR_DEFAULTS,
  all: MONITOR_PERMISSIONS,
  implies: { manage: ['edit', 'acknowledge'], '*': ['view'] },
  auditorsView: true,
};

const subjectKey = (v: unknown) =>
  String(v ?? '')
    .trim()
    .toLowerCase();

/**
 * Who has which rights on an object, by subject (user:, team:, role:): the access list, or – while it is empty – the
 * role defaults, plus the owner. Administrators always have every right and are left out.
 */
function effectiveGrants(acl: Entry[], owner: string | null | undefined, m: RightsModel): Grants {
  const out: Grants = new Map();
  const add = (key: string, perms: readonly string[]) => {
    if (!key || key === 'role:admin') return;
    const set = out.get(key) ?? new Set<string>();
    for (const p of perms) {
      set.add(p);
      for (const x of m.implies[p] ?? []) set.add(x);
      for (const x of m.implies['*'] ?? []) set.add(x);
    }
    out.set(key, set);
  };
  if (!acl.length) for (const [role, perms] of Object.entries(m.defaults)) add(`role:${role}`, perms);
  else for (const e of acl) add(subjectKey(e?.subject), (Array.isArray(e?.permissions) ? e.permissions : []).map(String));
  if (m.auditorsView) add('role:auditor', ['view']);
  if (owner?.trim()) add(`user:${owner.trim().toLowerCase()}`, m.all);
  return out;
}

/** Whether a change gives any subject a right it did not have (adding or raising; removals and reorders do not count). */
function gainsRight(before: Grants, after: Grants): boolean {
  for (const [key, perms] of after) {
    const had = before.get(key) ?? new Set<string>();
    for (const p of perms) if (!had.has(p)) return true;
  }
  return false;
}

const aclOf = (v: unknown): Entry[] | undefined => (Array.isArray(v) ? (v as Entry[]) : undefined);

/** Access lists: who the route serves (its own right) and which changes give anyone a right (a new entry, a raise, the defaults, an owner). */
export const platformAccess = {
  who: (req: FastifyRequest) => getPlatform(id(req)).permissions.includes('manage'),
  when: (req: FastifyRequest) => {
    const p = getPlatform(id(req));
    const acl = aclOf(body(req).acl);
    return !!acl && gainsRight(effectiveGrants(p.acl, null, PLATFORM_RIGHTS), effectiveGrants(acl, null, PLATFORM_RIGHTS));
  },
};
export const processAccess = {
  who: (req: FastifyRequest) => permissionsFor(id(req)).includes('manage'),
  when: (req: FastifyRequest) => {
    const p = getProcess(id(req));
    const b = body(req);
    // (the route keeps the owner when the body leaves it out, and clears it with null)
    const owner = b.owner === undefined ? p.owner : typeof b.owner === 'string' ? b.owner : null;
    return gainsRight(effectiveGrants(p.acl, p.owner, PROCESS_RIGHTS), effectiveGrants(aclOf(b.acl) ?? p.acl, owner, PROCESS_RIGHTS));
  },
};
export const monitorAccess = {
  who: (req: FastifyRequest) => !!requireMonitor(id(req), 'manage'),
  when: (req: FastifyRequest) => {
    const m = requireMonitor(id(req), 'manage');
    const b = body(req);
    // (an empty owner keeps the current one, see monitors/service.ts setAccess)
    const owner = (typeof b.owner === 'string' && b.owner.trim()) || m.owner;
    const before = JSON.parse(m.acl || '[]') as Entry[];
    return gainsRight(effectiveGrants(before, m.owner, MONITOR_RIGHTS), effectiveGrants(aclOf(b.acl) ?? before, owner, MONITOR_RIGHTS));
  },
};
