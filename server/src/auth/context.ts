import { AsyncLocalStorage } from 'node:async_hooks';
import type { ResourceShare, Role } from '@sm/shared';

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
  /** What the identity provider said at the last step-up (single sign-on): auth_time (s), amr, acr */
  stepUpDetail?: StepUpDetail | null;
}

/** The identity provider's claims of a single sign-on confirmation (kept with the session, named in the audit proof). */
export interface StepUpDetail {
  authTime?: number;
  amr?: string[];
  acr?: string;
  provider?: string;
}

interface RequestStore {
  user: AuthUser | null;
  ip?: string;
  /** The request is authenticated by an API token (its id), not a signed-in session */
  apiToken?: string;
  /** Owning teams of all resources, read once per request (auth/policy.ts) */
  teamIndex?: Map<string, { id: string; name: string }[]>;
  /** Shares and Restricted resources, read once per request and kind (auth/share-store.ts) */
  shareIndex?: ShareIndex;
  /** How this request met the assurance policy (auth/assurance.ts): written into its audit entries */
  assurance?: { proofs: Record<string, unknown>[]; consumed: boolean };
}

/** What auth/share-store.ts reads once per request (ADR 0033 "Performance"). */
export interface ShareIndex {
  /** `<user id>|<kind>` → resource id → the shares of that user's subjects (expired ones included; deciding drops them) */
  mine: Map<string, Map<string, ResourceShare[]>>;
  /** kind → the ids of its Restricted resources */
  restricted: Map<string, Set<string>>;
  /** A preview (withShareState): `<kind>:<id>` → the state to decide with instead of the stored one */
  overlay?: Map<string, { shares?: ResourceShare[]; restricted?: boolean }>;
}

/** Per-request context so services can attribute audit entries to the signed-in user. */
export const requestContext = new AsyncLocalStorage<RequestStore>();

/** The store of the current request (or job run), if there is one. */
export const currentStore = (): RequestStore | undefined => requestContext.getStore();

export function currentUser(): AuthUser | null {
  return requestContext.getStore()?.user ?? null;
}

/**
 * Whether the current request comes with an API token instead of a signed-in session. Secrets that outlive the token
 * (heartbeat secrets of new monitor checks …) are not handed out then: revoking a leaked token must end its access.
 */
export const viaApiToken = (): boolean => !!requestContext.getStore()?.apiToken;

/** Name recorded in the audit log for the current action. */
export function currentActor(): string {
  return requestContext.getStore()?.user?.username ?? 'system';
}

export function runAs<T>(user: AuthUser | null, fn: () => T): T {
  return requestContext.run({ user }, fn);
}
