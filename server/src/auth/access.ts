/**
 * One place for "who is asking, and may they" (#16).
 *
 * Two layers:
 * - **Route access** (`config.access` on a route): who may reach a route at all – without signing in, by webhook
 *   secret, signed in, only with a signed-in session (no API token), only with certain roles, and whether a status
 *   viewer may. Checked once for every route in app.ts, before the request body is read. Routes that say nothing
 *   need a signed-in user.
 * - **Object rights** (in the services): what the caller may do with a given process, platform, record …; these
 *   use `me()`, `forbid()` and the right checks of permissions.ts, because they depend on the object.
 */
import type { Capabilities, Role } from '@sm/shared';
import { HttpError } from '../util.js';
import { currentUser, type AuthUser } from './context.js';
import { capabilities, isAdmin } from './permissions.js';

/** How a route is reached. */
export type RouteAuth =
  /** without signing in */
  | 'public'
  /** machine-to-machine, authenticated by the route's own secret (webhooks, heartbeats); no session needed */
  | 'hook'
  /** signed in, by session or API token (the default) */
  | 'user'
  /** signed in with a session in the web app; API tokens are refused, whatever their scope */
  | 'session';

export interface RouteAccess {
  auth?: RouteAuth;
  /** Only these instance roles (any of them); others get 403 before the body is read */
  roles?: readonly Role[];
  /** A status viewer (role "status" only) may call it; every other route refuses them */
  statusViewer?: boolean;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: RouteAccess;
  }
}

/** Route config shorthands. */
export const PUBLIC: { access: RouteAccess } = { access: { auth: 'public' } };
export const HOOK: { access: RouteAccess } = { access: { auth: 'hook' } };
export const SESSION: { access: RouteAccess } = { access: { auth: 'session' } };
export const ADMIN_ONLY: { access: RouteAccess } = { access: { roles: ['admin'] } };
export const ADMIN_SESSION: { access: RouteAccess } = { access: { auth: 'session', roles: ['admin'] } };

/** The signed-in user; 401 NOT_SIGNED_IN otherwise. */
export function me(): AuthUser {
  const u = currentUser();
  if (!u) throw new HttpError(401, 'Please sign in', 'NOT_SIGNED_IN');
  return u;
}

/** 403 FORBIDDEN; `context` picks a translated text in the web app (errors:codes.FORBIDDEN_<context>). */
export function forbid(what: string, context?: string): never {
  throw new HttpError(403, `You are not allowed to ${what}`, 'FORBIDDEN', context ? { context } : undefined);
}

/** The signed-in user, if they have the capability; 403 otherwise. */
export function withCapability(cap: keyof Capabilities, what: string, context?: string): AuthUser {
  const u = me();
  if (!capabilities(u)[cap]) forbid(what, context);
  return u;
}

/** The signed-in user, if they are an administrator; 403 otherwise. */
export function requireAdmin(what: string, context?: string): AuthUser {
  const u = me();
  if (!isAdmin(u)) forbid(what, context);
  return u;
}

/** Whether `u` has any of `roles`. */
export const hasRole = (u: AuthUser | null, roles: readonly Role[]): boolean => !!u && u.roles.some((r) => roles.includes(r));

/** A status viewer: role "status" and no other (#26). */
export const isStatusViewer = (roles: readonly string[]): boolean => roles.length > 0 && roles.every((r) => r === 'status');
