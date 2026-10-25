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
}

interface RequestStore {
  user: AuthUser | null;
  ip?: string;
}

/** Per-request context so services can attribute audit entries to the signed-in user. */
export const requestContext = new AsyncLocalStorage<RequestStore>();

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
