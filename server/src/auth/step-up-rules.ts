import type { FastifyRequest } from 'fastify';
import { getSettings, passwordLoginMode } from '../settings.js';
import { getNotificationSettings } from '../notifications/settings.js';
import { getUser } from './users.js';

/**
 * Step-up rules of routes where only some changes are sensitive (step-up.ts): the request asks for a confirmation when
 * it changes what is listed here, and goes through without one otherwise (a new display name, a retention period).
 * The body is the raw request body (validated by the route afterwards); a rule that throws asks for the confirmation.
 */

const body = (req: FastifyRequest): Record<string, unknown> => (req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {});
const list = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map((x) => String(x).trim().toLowerCase()).filter(Boolean) : undefined);
const sameSet = (a: string[], b: string[]) => new Set(a).size === new Set(b).size && a.every((x) => b.includes(x));

/** A new account with roles (granting a role). */
export function grantsRoles(req: FastifyRequest): boolean {
  return (list(body(req).roles) ?? []).length > 0;
}

/** An account change of roles, of the sign-in provider (binding), or activating / deactivating an administrator. */
export function changesAccess(req: FastifyRequest): boolean {
  const b = body(req);
  const u = getUser((req.params as { id: string }).id);
  if (b.provider) return true;
  const roles = list(b.roles);
  if (roles && !sameSet(roles, u.roles)) return true;
  const admin = u.roles.includes('admin') || !!roles?.includes('admin');
  return typeof b.active === 'boolean' && b.active !== u.active && admin;
}

/** Sign-in mode (password sign-in) and the outbound policy and allow-list. */
export function changesSignInOrOutbound(req: FastifyRequest): boolean {
  const b = body(req);
  const s = getSettings();
  if (b.passwordLogin !== undefined && b.passwordLogin !== passwordLoginMode()) return true;
  if (b.outboundPolicy !== undefined && b.outboundPolicy !== s.outboundPolicy) return true;
  const allow = list(b.outboundAllowList);
  return (
    !!allow &&
    !sameSet(
      allow,
      (s.outboundAllowList ?? []).map((x) => x.toLowerCase()),
    )
  );
}

/** The e-mail domains addresses outside Steward may have (notifications/domains.ts). */
export function changesEmailDomains(req: FastifyRequest): boolean {
  const domains = list(body(req).allowedEmailDomains)?.map((d) => d.replace(/^@/, '').replace(/\.$/, ''));
  return !!domains && !sameSet(domains, getNotificationSettings().allowedEmailDomains);
}
