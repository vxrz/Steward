import type { FastifyRequest } from 'fastify';
import { getSettings, passwordLoginMode } from '../settings.js';
import { channelSecrets, getNotificationSettings } from '../notifications/settings.js';
import { getPlatform } from '../platforms/service.js';
import { getProcess, permissionsFor } from '../processes/service.js';
import { requireMonitor } from '../monitors/service.js';
import { getUser, listTeams } from './users.js';

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
  return !!list(b.members)?.some((m) => !before.includes(m));
}

type Entry = { subject?: unknown; permissions?: unknown };
/** Whether a new access list gives a subject a management right it did not have before (raising or adding, not removing). */
function grantsRight(before: Entry[], after: unknown, rights: string[]): boolean {
  if (!Array.isArray(after)) return false;
  const had = new Map<string, Set<string>>();
  for (const e of before)
    had.set(
      String(e.subject ?? '')
        .trim()
        .toLowerCase(),
      new Set((Array.isArray(e.permissions) ? e.permissions : []).map(String)),
    );
  return (after as Entry[]).some((e) => {
    const perms = Array.isArray(e?.permissions) ? e.permissions.map(String) : [];
    const old =
      had.get(
        String(e?.subject ?? '')
          .trim()
          .toLowerCase(),
      ) ?? new Set<string>();
    return perms.some((p) => rights.includes(p) && !old.has(p));
  });
}
const ownerChanges = (v: unknown, owner: string | null | undefined) =>
  typeof v === 'string' && v.trim() !== '' && v.trim().toLowerCase() !== (owner ?? '').toLowerCase();

/** Access lists: who the route serves (its own right) and which changes grant a management right or ownership. */
export const platformAccess = {
  who: (req: FastifyRequest) => getPlatform(id(req)).permissions.includes('manage'),
  when: (req: FastifyRequest) => grantsRight(getPlatform(id(req)).acl, body(req).acl, ['manage']),
};
export const processAccess = {
  who: (req: FastifyRequest) => permissionsFor(id(req)).includes('manage'),
  when: (req: FastifyRequest) => {
    const p = getProcess(id(req));
    return grantsRight(p.acl, body(req).acl, ['manage']) || ownerChanges(body(req).owner, p.owner);
  },
};
export const monitorAccess = {
  who: (req: FastifyRequest) => !!requireMonitor(id(req), 'manage'),
  when: (req: FastifyRequest) => {
    const m = requireMonitor(id(req), 'manage');
    return grantsRight(JSON.parse(m.acl || '[]') as Entry[], body(req).acl, ['manage']) || ownerChanges(body(req).owner, m.owner);
  },
};
