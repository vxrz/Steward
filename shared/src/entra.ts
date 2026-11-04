/**
 * Microsoft Graph / Entra ID (v0.5.0, docs/ENTRA.md): a platform of kind microsoft-graph reads one Entra ID tenant
 * through Microsoft Graph with application permissions – read-only.
 */

export const ENTRA_KIND = 'microsoft-graph';

/**
 * What an access check of source "entra" reads (its scope): empty – everything; groups – group memberships and
 * ownerships; roles – directory roles (active and eligible); apps – app role assignments; guests – every right of guests.
 */
export const ENTRA_SCOPES = ['groups', 'roles', 'apps', 'guests'] as const;
export type EntraScope = (typeof ENTRA_SCOPES)[number];

/** The scope of an entra check: empty or one of ENTRA_SCOPES, else what is wrong. */
export function entraScopeProblem(scope: string | null | undefined): string | null {
  const s = (scope ?? '').trim();
  if (!s || (ENTRA_SCOPES as readonly string[]).includes(s)) return null;
  return `An Entra ID scope is empty (everything) or one of ${ENTRA_SCOPES.join(', ')}`;
}

/** The application permissions Steward asks for, and what each one is used for (connection test, docs/ENTRA.md). */
export const ENTRA_PERMISSIONS: readonly { permission: string; optional: boolean; usedFor: string }[] = [
  { permission: 'User.Read.All', optional: false, usedFor: 'users, guests, disabled accounts' },
  { permission: 'Group.Read.All', optional: false, usedFor: 'groups, their members (also nested) and owners' },
  { permission: 'Directory.Read.All', optional: false, usedFor: 'the tenant, directory objects named in assignments, administrative units' },
  { permission: 'AuditLog.Read.All', optional: false, usedFor: 'last sign-in (signInActivity) and MFA registration' },
  { permission: 'RoleManagement.Read.Directory', optional: false, usedFor: 'directory role assignments, active and eligible (PIM)' },
  { permission: 'Application.Read.All', optional: false, usedFor: 'app registrations, their secrets and certificates, app role assignments' },
  { permission: 'ServiceHealth.Read.All', optional: true, usedFor: 'Microsoft 365 service health (monitor check)' },
];

/** Monitor check "entra": expiring secrets and certificates of app registrations, or Microsoft 365 service health. */
export const ENTRA_CHECK_MODES = ['app-credentials', 'service-health'] as const;
export type EntraCheckMode = (typeof ENTRA_CHECK_MODES)[number];

/** One secret or certificate of an app registration (or of a service principal). */
export interface EntraAppCredential {
  /** app registration or service principal */
  owner: 'application' | 'servicePrincipal';
  appId: string;
  appName: string;
  type: 'secret' | 'certificate';
  keyId: string;
  /** The credential's name in Entra (displayName), may be empty */
  name: string;
  startDateTime: string | null;
  endDateTime: string | null;
  /** Days until the end (negative: expired), null without an end */
  daysLeft: number | null;
}

/** What an import of app credentials into the credentials register did (or would do: dryRun). */
export interface EntraRegisterImport {
  platformId: string;
  dryRun: boolean;
  /** Secrets and certificates read from Entra ID */
  read: number;
  created: number;
  updated: number;
  unchanged: number;
  /** Entries whose expiry differs but the user may not change */
  notAllowed: number;
  items: {
    appName: string;
    appId: string;
    type: EntraAppCredential['type'];
    name: string;
    keyId: string;
    endDateTime: string | null;
    daysLeft: number | null;
    action: 'create' | 'update' | 'unchanged' | 'notAllowed';
    credentialId: string | null;
  }[];
}
