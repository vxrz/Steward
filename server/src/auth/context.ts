import { AsyncLocalStorage } from 'node:async_hooks';
import type { Role } from '@sm/shared';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  roles: Role[];
  teams: string[];
  /** The session was opened with an emergency access code (see emergency.ts): shown as a banner, flagged in the audit log */
  emergency?: { grantId: string; expiresAt: string };
  /** The signed-in session (not set for API tokens): its id (the token's hash), how it was opened, its last step-up */
  session?: SessionMeta;
}

/** A session's sign-in method and step-up state (see step-up.ts). */
export interface SessionMeta {
  id: string;
  method: 'password' | 'sso' | 'emergency';
  /** When the session last confirmed its owner (ms), or null */
  stepUpAt: number | null;
  /** How: password, sso or sso+mfa */
  stepUpMethod: string | null;
}

interface RequestStore {
  user: AuthUser | null;
  ip?: string;
  /** Owning teams of all resources, read once per request (auth/policy.ts) */
  teamIndex?: Map<string, { id: string; name: string }[]>;
}

/** Per-request context so services can attribute audit entries to the signed-in user. */
export const requestContext = new AsyncLocalStorage<RequestStore>();

/** The store of the current request (or job run), if there is one. */
export const currentStore = (): RequestStore | undefined => requestContext.getStore();

export function currentUser(): AuthUser | null {
  return requestContext.getStore()?.user ?? null;
}

/** Name recorded in the audit log for the current action. */
export function currentActor(): string {
  return requestContext.getStore()?.user?.username ?? 'system';
}

export function runAs<T>(user: AuthUser | null, fn: () => T): T {
  return requestContext.run({ user }, fn);
}
