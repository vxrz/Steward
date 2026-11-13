import type { ModuleStates } from './modules.js';
import type { LibraryOrigin } from './libraries.js';
import type { AiGatewaySettings } from './ai.js';
import type { DatabaseSettings } from './database.js';
import type { ErrorParams } from './errors.js';
import type { ControlTagKind } from './compliance.js';
import type { ScheduleNotify } from './notifyPolicy.js';
import type { Column, FlowNode, ManualFieldType, ManualUse, ProcessDefinition } from './process.js';
import type { Locale } from './locales.js';
import type { DailySummaryPrefs } from './dailySummary.js';
import type { PlantChange, PlantImportProblem } from './plant.js';
import type { DigestPrefs, QuietHours } from './quietHours.js';
import type {
  SsoConfigWarning,
  SsoGroupValues,
  SsoLinkPolicy,
  SsoPreset,
  SsoProfileField,
  SsoRequiredClaim,
  SsoSyncRules,
  SsoUsernameTransform,
} from './sso.js';

// ---------- Users, roles, permissions ----------

export const ROLES = ['admin', 'designer', 'operator', 'approver', 'auditor', 'viewer', 'status', 'plant'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_INFO: Record<Role, string> = {
  admin: 'Everything: users, teams, platforms and credentials, settings, all processes',
  designer: 'Create processes; edit and run processes (unless restricted)',
  operator: 'Run and schedule processes (unless restricted)',
  approver: 'Decide approvals and user tasks',
  auditor: 'Read-only access to all processes, runs, protocols and the audit log',
  viewer: 'Read-only access to processes and their runs (unless restricted)',
  status: 'Only the service status pages – none of the other pages, processes, platforms or data',
  plant: 'Sees only the plant registry (sites and assets, unless a site is restricted) – none of the other pages, processes, services or documents',
};

export const PROCESS_PERMISSIONS = ['view', 'run', 'edit', 'approve', 'manage'] as const;
export type ProcessPermission = (typeof PROCESS_PERMISSIONS)[number];
export const PLATFORM_PERMISSIONS = ['use', 'manage'] as const;
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

/** subject: user:<username> | team:<team name> | role:<role> */
export interface AclEntry<P extends string = string> {
  subject: string;
  permissions: P[];
}

export interface UserInfo {
  id: string;
  username: string;
  displayName: string;
  email?: string;
  roles: Role[];
  teams: string[];
  active: boolean;
  mustChangePassword: boolean;
  lastLoginAt?: string | null;
  createdAt: string;
  /** 'local' (password) or the id of the single sign-on provider the account belongs to */
  authSource: string;
  /** Receive e-mail notifications (if an e-mail address is set and e-mail is configured) */
  emailNotifications: boolean;
  /** Preferred UI and notification language; null = not chosen yet (browser language in the UI, Settings.defaultLocale for messages) */
  locale: Locale | null;
  firstName?: string;
  lastName?: string;
  /** Read-only fields from the single sign-on provider (department, job title …), in the provider's order */
  profile: UserProfileValue[];
  /** Fields the single sign-on provider keeps up to date at every sign-in: not editable in Steward */
  managedFields: ('displayName' | 'firstName' | 'lastName' | 'email')[];
  /** When an administrator replaced the person's data by a pseudonym (0.11.0, docs/PRIVACY.md): for good */
  pseudonymisedAt?: string | null;
}

/**
 * What Steward holds about one person (GDPR Art. 15 and 20, docs/PRIVACY.md): GET /api/me/data-export for oneself,
 * GET /api/users/{id}/data-export for administrators. Secrets are never part of it (no token, hash or session key).
 * Long lists are cut at their limit and say so; the audit entries come in pages (`audit.next`).
 */
export interface PersonalDataExport {
  format: 'steward-personal-data-v1';
  generatedAt: string;
  version: string;
  account: {
    id: string;
    username: string;
    displayName: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    locale: string | null;
    emailNotifications: boolean;
    roles: string[];
    active: boolean;
    authSource: string;
    /** Single sign-on: whether the account is linked to an identity at the provider (the identifier itself stays out) */
    linkedIdentity: boolean;
    /** Fields from the single sign-on provider */
    profile: UserProfileValue[];
    createdAt: string;
    updatedAt: string;
    lastLoginAt: string | null;
    pseudonymisedAt: string | null;
  };
  teams: { name: string; roles: string[] }[];
  apiTokens: {
    name: string;
    scope: string;
    prefix: string;
    createdAt: string;
    lastUsedAt: string | null;
    expiresAt: string | null;
    revokedAt: string | null;
  }[];
  sessions: { createdAt: string; lastSeenAt: string; expiresAt: string; ip: string | null; userAgent: string | null; method: string | null }[];
  mcpClients: { client: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }[];
  emergencyAccess: { issuedBy: string; createdAt: string; expiresAt: string; usedAt: string | null; usedIp: string | null; revokedAt: string | null }[];
  settings: { notificationPrefs: unknown; dailySummary: unknown; personalChannels?: unknown; optIns?: unknown };
  notifications: { total: number; items: { ts: string; event: string; title: string; read: boolean }[] };
  teamsChats: { installedAt: string; removedAt: string | null }[];
  /** Where the person is named: as the one who did something (history) and as owner or responsible (now) */
  activity: PersonalDataActivity[];
  audit: { total: number; limit: number; entries: AuditEntry[]; next: string | null };
}

export interface PersonalDataActivity {
  table: string;
  column: string;
  /** history: who did something (started, decided, authored …); current: who owns or answers for something now */
  kind: 'history' | 'current';
  total: number;
  /** The newest rows (at most `PERSONAL_DATA_LIMITS.rowsPerColumn`): id, a name or title, a time */
  rows: { id: string | null; label: string | null; at: string | null }[];
}

export const PERSONAL_DATA_LIMITS = { rowsPerColumn: 500, notifications: 200, auditPerPage: 2000 } as const;

export interface UserProfileValue {
  key: string;
  label: string;
  value: string;
}

// ---------- Single sign-on (OpenID Connect) ----------

export interface SsoRoleMapping {
  /** Value of the groups/roles claim, e.g. an Entra app role "SM.Operators" or a group object id */
  claimValue: string;
  roles: Role[];
  teams: string[];
  /** Roles the user gets in these teams (#131), beside their instance roles */
  teamRoles?: Role[];
}

export interface SsoProvider {
  id: string;
  displayName: string;
  /** 'entra' only changes defaults/help texts; both use standard OIDC */
  type: 'entra' | 'oidc';
  /** OIDC issuer, e.g. https://login.microsoftonline.com/<tenant-id>/v2.0 */
  issuer: string;
  clientId: string;
  hasClientSecret: boolean;
  clientAuth: 'client_secret_post' | 'client_secret_basic' | 'none';
  scopes: string;
  usernameClaim: string;
  displayNameClaim: string;
  emailClaim: string;
  /** Claim with roles/groups used for the mappings (Entra: "roles" for app roles, "groups" for group ids) */
  groupsClaim: string;
  mappings: SsoRoleMapping[];
  /** Roles every user of this provider gets */
  defaultRoles: Role[];
  /** Create accounts on first sign-in */
  autoProvision: boolean;
  /** Overwrite roles (and mapped team memberships) from the claims at every sign-in */
  syncRoles: boolean;
  /** Deny sign-in when no mapping matches */
  requireMapping: boolean;
  /** The preset the provider was set up with (pre-fill and help texts only) */
  preset: SsoPreset;
  /** Claims that identify a person for good, together with the issuer (default: sub; Entra ID: tid + oid) */
  stableIdClaims: string[];
  usernameTransform: SsoUsernameTransform;
  /** With usernameTransform "stripDomain": the only domains removed; a user name of any other domain is refused */
  stripDomains: string[];
  /**
   * The stable id claims hold no subject claim (sub, oid): the claims the administrator confirmed as unique per person.
   * The confirmation holds only while it lists exactly the configured claims.
   */
  stableIdConfirmedClaims: string[];
  /** Saved before #77 with the e-mail claim naming accounts: sign-ins need email_verified now – shown until decided */
  emailVerificationNotice: boolean;
  /** Display name from claims, e.g. "{given_name} {family_name}"; empty: the display name claim */
  displayNameTemplate: string;
  firstNameClaim: string;
  lastNameClaim: string;
  /** Read-only account fields filled from claims (nested claims with dots: address.locality) */
  profileFields: SsoProfileField[];
  /** Per field: updated at every sign-in (not editable in Steward) or only set when the account is created or linked */
  sync: SsoSyncRules;
  /** Whether the groups claim carries names (matched ignoring case) or ids (matched exactly) */
  groupValues: SsoGroupValues;
  /** Which existing accounts the first sign-in of an identity may link: by user name, only accounts bound to this provider, none */
  linkExisting: SsoLinkPolicy;
  /** The provider only issues verified e-mail addresses (for providers that never send email_verified) */
  emailVerifiedByProvider: boolean;
  /** Also read the userinfo endpoint (claims missing from the ID token) */
  useUserinfo: boolean;
  /** Sign-in only when each of these claims has one of the values (e.g. hd for Google Workspace, tid for Entra ID) */
  requiredClaims: SsoRequiredClaim[];
  /** Step-up (confirming a sensitive action): require multi-factor authentication – amr contains "mfa", or the acr/acrs below */
  stepUpMfa: boolean;
  /** Step-up with MFA: acr_values asked for (space-separated); the ID token's acr must be one of them. Empty: amr is checked */
  stepUpAcrValues: string;
  /** Step-up with MFA at Entra ID: a Conditional Access authentication context (c1–c99) asked for; the token's acrs must contain it */
  stepUpAuthContext: string;
  /** What to look at in the saved configuration (computed, read-only) */
  warnings: SsoConfigWarning[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Settings added after the first version are optional: a request without them keeps the stored values (or the defaults). */
type SsoProviderLaterFields =
  | 'preset'
  | 'stableIdClaims'
  | 'usernameTransform'
  | 'stripDomains'
  | 'stableIdConfirmedClaims'
  | 'emailVerificationNotice'
  | 'displayNameTemplate'
  | 'firstNameClaim'
  | 'lastNameClaim'
  | 'profileFields'
  | 'sync'
  | 'groupValues'
  | 'linkExisting'
  | 'emailVerifiedByProvider'
  | 'useUserinfo'
  | 'requiredClaims'
  | 'stepUpMfa'
  | 'stepUpAcrValues'
  | 'stepUpAuthContext';

export type SsoProviderInput = Omit<SsoProvider, 'id' | 'hasClientSecret' | 'createdAt' | 'updatedAt' | 'warnings' | SsoProviderLaterFields> &
  Partial<Pick<SsoProvider, SsoProviderLaterFields>> & {
    /** New secret; omit to keep the stored one, '' to remove it */
    clientSecret?: string;
    /** When the issuer changes: keep the accounts linked (the new issuer issues the same subjects). Default: links stay with the former issuer */
    keepLinksOnIssuerChange?: boolean;
  };

/**
 * What the sign-in page shows after a failed single sign-on: the server redirects with `?sso_error=<code>` (and
 * `&sso_ref=<reference>` for a refused sign-in), and the page shows a fixed, translated text for one of these codes –
 * never text from the address (security review 0.10.0 S8). Anything else shows the generic text of SSO_FAILED.
 */
export const SSO_ERROR_CODES = [
  'SSO_FAILED',
  'SSO_STATE_UNKNOWN',
  'SSO_PROVIDER_UNAVAILABLE',
  'SSO_VAULT_LOCKED',
  'SSO_IDP_ERROR',
  'SSO_SIGN_IN_REFUSED',
] as const;
export type SsoErrorCode = (typeof SSO_ERROR_CODES)[number];
/** The reference of a refused single sign-on (the audit entry names it): 8 hex digits. */
export const SSO_REFERENCE = /^[0-9a-f]{8}$/;
export const isSsoErrorCode = (v: unknown): v is SsoErrorCode => typeof v === 'string' && (SSO_ERROR_CODES as readonly string[]).includes(v);

export interface SsoProviderPublic {
  id: string;
  displayName: string;
  type: 'entra' | 'oidc';
}

export interface SsoDiscoveryResult {
  ok: boolean;
  message: string;
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  scopesSupported?: string[];
  claimsSupported?: string[];
}

export interface Team {
  id: string;
  name: string;
  description: string;
  members: string[];
  /** Roles a member has in this team (#131), by username; members without an entry have only their instance roles */
  memberRoles: Record<string, Role[]>;
  createdAt: string;
}

/**
 * A team's own channel for messages about its resources (#136): a Teams Workflow/incoming webhook (card) or a JSON
 * webhook. "also" posts to the instance channel as well; "instead" leaves it out when every owning team of the
 * resource has its own channel that says so.
 */
export const TEAM_CHANNEL_FORMATS = ['teams', 'json'] as const;
export const TEAM_CHANNEL_MODES = ['also', 'instead'] as const;
export interface TeamChannel {
  enabled: boolean;
  format: (typeof TEAM_CHANNEL_FORMATS)[number];
  mode: (typeof TEAM_CHANNEL_MODES)[number];
  /** a URL is stored (never returned) */
  hasUrl: boolean;
  /** Teams format only: the channel's quiet hours (0.10.0, ADR 0012) */
  quietHours?: QuietHours;
}
/**
 * Which new resources of its members a team owns (#136): auto – once the team owns something (the default, so a team
 * that does not use scopes yet changes nothing); always – from the start; never – none (members choose it themselves).
 */
export const TEAM_NEW_RESOURCE_MODES = ['auto', 'always', 'never'] as const;
export type TeamNewResourceMode = (typeof TEAM_NEW_RESOURCE_MODES)[number];
/** A team's report branding: each field overrides the instance's; null keeps the instance value. */
export interface TeamReportBranding {
  companyName: string | null;
  accentColor: string | null;
  classification: string | null;
  footerNote: string | null;
  /** the team has its own logo */
  customLogo: boolean;
}
/** A team's settings and what they inherit (#136). */
export interface TeamSettings {
  teamId: string;
  teamName: string;
  /** null: the team uses the instance channel (the default) */
  channel: TeamChannel | null;
  /** the instance channel the team falls back to */
  instance: {
    teamsEnabled: boolean;
    webhookEnabled: boolean;
    branding: { companyName: string; accentColor: string; classification: string; footerNote: string };
  };
  newResources: TeamNewResourceMode;
  /** the daily summary its members get unless they chose their own; null: the instance default (off) */
  summary: DailySummaryPrefs | null;
  /** quiet hours and digests its members get unless they chose their own (0.10.0, ADR 0012); null: off */
  quietHours: QuietHours | null;
  digests: DigestPrefs | null;
  /** null: reports use the instance branding */
  branding: TeamReportBranding | null;
  /** report schedules of the team (they use its branding) */
  reportSchedules: { id: string; name: string }[];
  canChange: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** Where a personal value comes from (#136): the person's own choice, a team default or the instance default. */
export type SettingSource = { from: 'own' } | { from: 'team'; team: string } | { from: 'instance' };

/** The owning teams of the resources a person creates (#136), and where that comes from. */
export interface NewResourceTeams {
  /** teams new resources get now */
  teams: { id: string; name: string }[];
  /** own: the person chose one of their teams */
  source: { from: 'own' } | { from: 'team' } | { from: 'instance' };
  /** the person's teams they can choose from (teams that take no new resources are left out) */
  choices: { id: string; name: string }[];
  chosen: string | null;
}

/** Roles a member can have in a team (#131): administrator is instance-wide, a status viewer sees only status pages. */
export const TEAM_ROLES = ['designer', 'operator', 'approver', 'auditor', 'viewer'] as const satisfies readonly Role[];
export type TeamRole = (typeof TEAM_ROLES)[number];

/** Kinds of resources that can have owning teams (#131). */
export const OWNED_KINDS = [
  'process',
  'platform',
  'service',
  'application',
  'system',
  'record',
  'credential',
  'monitor',
  'dashboard',
  'ticket',
  'site',
  'contract',
  /** An identity of a platform (0.13.0, ADR 0009 step 2): its members may use it */
  'platform_identity',
  /** A supplier (0.17.0, ADR 0029): like systems */
  'supplier',
  /** The data products module (0.22.0, ADR 0036): products, data objects, elements of the catalogue, domains */
  'data_product',
  'data_object',
  'data_element',
  'data_domain',
] as const;
export type OwnedKind = (typeof OWNED_KINDS)[number];

/** Why someone has a right on a resource (#131): shown in the UI and used in access reviews. */
export interface AccessReason {
  /** admin | owner | auditor | instanceRole | teamRole | accessList | named (a named owner or responsible, #195) */
  source: 'admin' | 'owner' | 'auditor' | 'instanceRole' | 'teamRole' | 'accessList' | 'named';
  /** The role, the team, or the access list subject the right comes from */
  role?: Role;
  team?: string;
  subject?: string;
  /** source named: named as an owner or as a responsible (ticket references) */
  as?: 'owner' | 'responsible';
  permissions: string[];
}

export interface AccessExplanation {
  kind: OwnedKind;
  id: string;
  user: string;
  owningTeams: { id: string; name: string }[];
  permissions: string[];
  reasons: AccessReason[];
}

export interface Capabilities {
  manageUsers: boolean;
  manageSettings: boolean;
  viewAudit: boolean;
  createProcesses: boolean;
  createPlatforms: boolean;
  /** Create monitors and manage heartbeat gateways */
  createMonitors: boolean;
  /** Export evidence packs (Compliance) */
  exportEvidence?: boolean;
  /**
   * The sidebar shows Schedules and Triggers (roles that run, build or audit processes, in the instance or a team).
   * Only in GET /auth/status; missing means true.
   */
  viewAutomation?: boolean;
  /** The sidebar shows Credentials (a role that may read the register, or an entry the user owns). Missing means true. */
  viewCredentials?: boolean;
  /** The plant registry module is on and the user may use it (the sidebar's Plant area, link kinds site and asset). Missing means false. */
  plant?: boolean;
  /** With the module on: the user may manage a site or add one (the sidebar's Import). Missing means false. */
  plantManage?: boolean;
  /** A plant viewer: role "plant" and no other working role – the web app shows the Plant area and the profile only. Missing means false. */
  plantOnly?: boolean;
  /** The modules (0.11.0, ADR 0016) and whether each is on; a module missing here is on. Only in GET /auth/status. */
  modules?: ModuleStates;
}

export interface Me {
  user: UserInfo;
  capabilities: Capabilities;
  /** Set when this session was opened with an emergency access code from the server's command line */
  emergency?: { expiresAt: string };
}

/**
 * Who may sign in with a password: everyone, administrators only (break-glass), or nobody (single
 * sign-on only; emergency access from the server's command line still works).
 */
export const PASSWORD_LOGIN_MODES = ['all', 'adminsOnly', 'none'] as const;
export type PasswordLogin = (typeof PASSWORD_LOGIN_MODES)[number];

export interface AuthStatus {
  /** Vault (master passphrase) exists */
  initialized: boolean;
  /** No user accounts yet – first-time setup creates the first administrator */
  setupRequired: boolean;
  unlocked: boolean;
  me: Me | null;
  /** Enabled single sign-on providers (buttons on the sign-in page) */
  ssoProviders: SsoProviderPublic[];
  /** 'adminsOnly': password sign-in is limited to administrators (break-glass); 'none': single sign-on only */
  passwordLogin: PasswordLogin;
  demo: boolean;
  /** The server's version – only for a signed-in caller (0.19.0) */
  version?: string;
  browserAvailable: boolean;
}

/**
 * Step-up re-authentication (confirming a sensitive action, docs/SECURITY-HARDENING.md#step-up-re-authentication):
 * how this session confirms – the password (password sessions), a fresh sign-in at the session's provider (single
 * sign-on sessions), not needed (emergency access) or not possible (the provider is gone or disabled).
 */
export type StepUpMethod = 'password' | 'sso' | 'emergency' | 'none';

/** What a step-up confirms (each sensitive route names its action; shown in the dialog and on the callback page). */
/**
 * The rule for local passwords (0.11.0, NIST SP 800-63B, ASVS 5.0 V6.2): a length in characters of the Unicode NFKC
 * form – any characters, spaces too, no composition rules – and not on the bundled list of common passwords (server).
 */
export const PASSWORD_RULES = { minLength: 12, maxLength: 256 } as const;
/** The length of a password as the rule counts it: characters (code points) of its NFKC form. */
export const passwordLength = (password: string): number => [...password.normalize('NFKC')].length;

export const STEP_UP_ACTIONS = [
  'createToken',
  'changeVaultPassphrase',
  'createUser',
  'changeAccount',
  'resetPassword',
  'addSsoProvider',
  'changeSsoProvider',
  'deleteSsoProvider',
  'changeSignInSettings',
  'changeNotificationDelivery',
  'changeTeamMembers',
  'grantAccess',
  'exportEvidencePack',
  'exportAuditLog',
  'exportCredentials',
  'changeAuditAnchoring',
  'exportMigration',
  'applyMigration',
  'changeCiaScale',
  'changeBackups',
  'allowMcpWrites',
  'allowMcpClient',
  // 0.5.0 (#210): the assurance policy itself, and control points whose step-up an administrator can turn on
  'changeAssurancePolicy',
  'approveRecord',
  'decideAccessCheck',
  'decidePersonReview',
  'verifyManualStep',
  'closeFirewallChange',
  // 0.6.0 (#216): raising an AI token budget (or removing its limit)
  'changeAiBudget',
  // 0.9.0 (#226): raising a monthly cost budget (or removing it)
  'changeCostBudget',
  // 0.10.0 (#234): where the map of sites fetches its tiles from
  'changeMapSource',
  // 0.14: where Steward reads security advisories from (plant registry, docs/ADVISORIES.md)
  'changeAdvisorySources',
  // 0.10.0 (#238): trusting a library publisher or key, removing one, widening its libraries, lifting an expiry
  'changeTrustedPublishers',
  // 0.11.0: replacing a deactivated person's data by a pseudonym (for good), and exporting another person's data
  'pseudonymiseUser',
  'exportPersonalData',
  // 0.11.0 (ADR 0016): switching a module on or off
  'changeModules',
  // 0.11.0: changing the id of a plant registry entry; renaming, removing or editing many entries at once
  'renamePlantId',
  'changePlantInBulk',
  // 0.14.0 (ADR 0009 step 4): starting a run, saving a schedule or trigger, a request explorer call or approving an MCP
  // request with a privileged platform identity
  'usePrivilegedIdentity',
  // 0.16.0 (ADR 0027): defining, changing or removing a scheduled export – it sends data out of Steward
  'changeExports',
  // 0.17.0 (ADR 0029): approving or returning a version of the statement of applicability, and switching its second
  // approver off (control point soa.approve)
  'approveSoa',
  'changeSoaApproval',
  // 0.19.0 (#195): naming an owner or responsible from outside the owning teams of an item (control point access.grant)
  'grantNamedAccess',
  // 0.19.0 (security review H1): a new address of a platform's stored credentials (base URL, trusted origins, sign-in,
  // proxy, broker or database host)
  'changePlatformDestination',
  // 0.19.0 (security review L1): a Git sync source – a new one, another repository or API URL, signing loosened, auto-accept on
  'changeSyncSources',
] as const;
export type StepUpAction = (typeof STEP_UP_ACTIONS)[number];

/** The 403 STEP_UP_REQUIRED answer of a sensitive route (and GET /api/auth/step-up). */
export interface StepUpInfo {
  method: StepUpMethod;
  /** Single sign-on sessions: the provider to confirm with */
  provider?: { id: string; displayName: string };
  /** The provider asks for multi-factor authentication at step-up */
  mfa?: boolean;
  /** How long a confirmation lasts (SM_STEP_UP_MINUTES) */
  windowMinutes: number;
  /** The action that asked (403 STEP_UP_REQUIRED) */
  action?: StepUpAction;
}

/** GET /api/auth/step-up: the session's confirmation state. */
export interface StepUpStatus extends StepUpInfo {
  /** Confirmed until (ISO), or null */
  until: string | null;
  /** How it was confirmed: password, sso, sso+mfa or emergency */
  confirmedWith: string | null;
  /** The last refused single sign-on confirmation of this session (shown in the dialog) */
  failure?: { code: string; message: string; at: string };
}

/** POST /api/auth/step-up/sso: open this URL (popup or the same window). */
export interface StepUpSsoStart {
  authorizationUrl: string;
  expiresAt: string;
}

export interface Subject {
  value: string;
  /** English display label (the web UI builds a translated one from kind + name) */
  label: string;
  kind: 'user' | 'team' | 'role';
  /** Team name (original spelling) or role id */
  name?: string;
}

// ---------- Platforms ----------

export const AUTH_TYPES = ['none', 'basic', 'bearer', 'apiKey', 'oauth2_client_credentials', 'token_request', 'jwt', 'aws_sigv4'] as const;
export type AuthType = (typeof AUTH_TYPES)[number];

export interface AuthConfig {
  type: AuthType;
  /** oauth2: token endpoint (template, scope: vars, secrets) */
  tokenUrl?: string;
  scope?: string;
  /**
   * oauth2: send client credentials as Basic header or in the form body; assertion (v0.5.0): a client assertion JWT
   * signed with the private key (secrets privateKey, certificate – Entra ID certificate credentials). basic/body
   * without a client secret but with a private key use the assertion too.
   */
  clientAuth?: 'basic' | 'body' | 'assertion';
  extraParams?: Record<string, string>;
  /** apiKey */
  apiKeyIn?: 'header' | 'query';
  apiKeyName?: string;
  /** token_request: custom login call */
  request?: {
    method: 'POST' | 'GET' | 'PUT';
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
    bodyType?: 'json' | 'form';
  };
  /** token_request: expression for the token in the response body */
  tokenPath?: string;
  /** token_request: expression for lifetime in seconds (optional) */
  expiresInPath?: string;
  /**
   * token_request (v0.5.0): renew an expired token with a refresh token before signing in again (an OAuth2
   * refresh_token grant, e.g. IBM Verify Privilege Vault). tokenPath: expression for the refresh token in the login and
   * refresh answers; request: the refresh call, its templates also see {{ refreshToken }}. When the refresh fails,
   * Steward signs in again with the login request.
   */
  refresh?: {
    tokenPath: string;
    request: {
      method: 'POST' | 'GET' | 'PUT';
      url: string;
      headers?: Record<string, string>;
      body?: unknown;
      bodyType?: 'json' | 'form';
    };
  };
  /**
   * Header added to API calls; template with {{ token }}. bearer: the header the token goes in – Authorization (default,
   * as `Bearer <token>`) or another name, which gets the bare token (GitLab's default: PRIVATE-TOKEN).
   */
  headerName?: string;
  headerValue?: string;
  /**
   * jwt (#114): a JWT signed with the private key (secrets privateKey, privateKeyPassphrase). claims are templates
   * (scope: vars, secrets, publicKeyFingerprint); iat, exp and jti are set by Steward. mode token: the JWT is the token
   * (headerName/headerValue); exchange: it is sent to tokenUrl (RFC 7523 jwt-bearer) for an access token.
   */
  jwt?: {
    alg?: 'RS256' | 'RS384' | 'RS512' | 'PS256' | 'ES256' | 'ES384';
    claims?: Record<string, string>;
    /** seconds, at most 3600 */
    lifetimeSeconds?: number;
    kid?: string;
    mode?: 'token' | 'exchange';
  };
  /** aws_sigv4 (#114): every request signed (secrets accessKeyId, secretAccessKey, optional sessionToken); optionally as an assumed role */
  aws?: {
    region: string;
    service: string;
    roleArn?: string;
    externalId?: string;
    sessionName?: string;
    /** S3: send UNSIGNED-PAYLOAD instead of the body's hash (large uploads) */
    unsignedPayload?: boolean;
    /** STS endpoint for assuming the role (default https://sts.<region>.amazonaws.com; GovCloud, China, VPC endpoints) */
    stsEndpoint?: string;
  };
}

export interface HttpOptions {
  /** Accept self-signed certificates (e.g. on-prem Industrial Edge Management). */
  insecureTls?: boolean;
  /** Extra CA certificate (PEM). */
  caPem?: string;
  /** Proxy URL; empty = use HTTPS_PROXY / NO_PROXY environment. 'none' = direct. */
  proxy?: string;
  timeoutMs?: number;
  defaultHeaders?: Record<string, string>;
  /** Retries for 429/502/503/504 and network errors, honouring Retry-After (exponential backoff with jitter) */
  retry?: {
    /** default 3; 0 disables */
    maxRetries?: number;
    /** default 500 ms */
    baseDelayMs?: number;
    /** default 30 s */
    maxDelayMs?: number;
    /** POST/PATCH are not repeated unless enabled (they may not be idempotent) */
    retryNonIdempotent?: boolean;
  };
  /** Maximum concurrent requests to this platform (default 4) */
  maxConcurrency?: number;
  /**
   * Further origins (scheme://host[:port]) that may receive this platform's credentials.
   * By default credentials are only sent to the origin of the base URL; requests to
   * absolute URLs elsewhere are sent without credentials.
   */
  trustedOrigins?: string[];
}

export interface PlatformConfig {
  auth: AuthConfig;
  /** Non-secret variables, e.g. tenant, region. Usable as {{ vars.tenant }} in URLs. */
  variables: Record<string, string>;
  http: HttpOptions;
  /** Optional URL used by "Test connection" (relative to base URL). */
  testPath?: string;
  /** Browser automation start URL if different from base URL. */
  portalUrl?: string;
  /**
   * Read-only access for MCP clients through Steward's platform gateway (docs/MCP.md). Off unless a user
   * with the "manage" right turns it on (PUT /api/platforms/:id/mcp-gateway); never copied to new
   * platforms or connector types.
   */
  mcpGateway?: McpGatewayConfig;
  /** LLM gateways (0.6.0, docs/AI.md): models and allowed data – changed with PUT /api/platforms/:id/ai only */
  ai?: AiGatewaySettings;
  /** Database platforms (0.7.0, docs/DATABASES.md): the connection – changed with PUT /api/platforms/:id/database only */
  database?: DatabaseSettings;
}

/**
 * Changing calls (POST, PUT, PATCH, DELETE) through the MCP gateway (#11): off (refused), confirm (the token owner
 * confirms each request in Steward), fourEyes (an approver or administrator other than the token owner approves).
 */
export const MCP_WRITE_MODES = ['off', 'confirm', 'fourEyes'] as const;
export type McpWriteMode = (typeof MCP_WRITE_MODES)[number];

export interface McpGatewayConfig {
  enabled: boolean;
  /** Changing calls need an approval in Steward first (default off: refused) */
  writes?: McpWriteMode;
  /**
   * GET path prefixes MCP clients may read without an OpenAPI operation (for platforms without an API
   * specification), e.g. "/api/v1/devices". Empty: only the operations of the platform's API specifications.
   */
  allowedPathPrefixes?: string[];
}

/**
 * MCP mode of an identity (0.9.0, ADR 0009): off, read, or approved writes (`writes`: confirm or fourEyes). With mode
 * off, `writes` keeps the approval mode chosen before (turning the gateway on again without one restores it).
 */
export const IDENTITY_MCP_MODES = ['off', 'read', 'writes'] as const;
export type IdentityMcpMode = (typeof IDENTITY_MCP_MODES)[number];
export interface IdentityMcp {
  mode: IdentityMcpMode;
  writes?: Exclude<McpWriteMode, 'off'>;
}

/**
 * One set of credentials under a platform (0.9.0, #228, ADR 0009). Every platform has exactly one default identity;
 * requests that name no identity use it. Never carries a secret, the sign-in settings or variables – only names and flags.
 */
export interface PlatformIdentity {
  id: string;
  platformId: string;
  name: string;
  description: string;
  default: boolean;
  readOnly: boolean;
  privileged: boolean;
  mcp: IdentityMcp;
  /** null: every operation (no filter) */
  operationFilter: IdentityOperationFilter | null;
  /** Operations of the filter that no longer resolve (a spec was removed or changed): they match nothing (0.13.0) */
  staleOperations?: number;
  /** Who may use it besides the platform's users (0.13.0): never set on the default identity (everyone with "use") */
  acl?: AclEntry<'use'>[];
  /**
   * Kept but not usable (0.13.0): it was added or changed outside Steward when an administrator confirmed the platform's
   * settings – no credentials are sent with it until an administrator enables it (POST …/identities/:iid/enable).
   */
  disabled?: boolean;
  /** Whether the identity signs in with its own settings (false: the platform's sign-in settings) */
  ownSignIn: boolean;
  /** Names of its stored secrets (values are never returned) */
  secretKeys: string[];
  /** Integrity of its seal, as for the platform */
  integrity: 'ok' | 'unsealed' | 'mismatch' | 'locked';
  /** Whether the current user may use it (the default identity: the platform's "use") */
  mayUse: boolean;
  /**
   * Entries of the credentials register that document it (0.14.0, ADR 0009 step 4) – not archived; only the number, the
   * entries themselves follow the register's own rights (GET /api/credentials?identity=…)
   */
  registerEntries?: number;
  createdAt: string;
  updatedAt: string;
}

/** A reference to an operation of a platform's API specification (ADR 0009): the spec's own path, so a new path prefix follows. */
export interface IdentityOperationRef {
  specId: string;
  method: string;
  specPath: string;
  operationId?: string;
}

/** An identity's operation filter (0.13.0, ADR 0009 step 3): read = every GET/HEAD of the current specs plus `operations`; chosen = only `operations`. */
export interface IdentityOperationFilter {
  preset: 'read' | 'chosen';
  operations: IdentityOperationRef[];
}

/**
 * An identity's settings for its managers (0.13.0, GET /platforms/:id/identities/:iid/settings, "manage"): its own sign-in
 * settings (null: the platform's) and variables. Never credentials.
 */
export interface PlatformIdentitySettings {
  auth: AuthConfig | null;
  variables: Record<string, string>;
  /** Variables an identity may not set: they decide where requests and credentials go (IDENTITY_VARIABLE_FIXED) */
  fixedVariables: string[];
  /** Its operation filter with each reference resolved (stale: no longer in the platform's specs) */
  operations: (IdentityOperationRef & { path: string | null; stale: boolean })[];
}

/** Create (POST /platforms/:id/identities) or change (PUT …/identities/:iid) an identity (0.13.0). */
export interface PlatformIdentityInput {
  name: string;
  description?: string;
  /** null: sign in with the platform's settings */
  auth?: AuthConfig | null;
  variables?: Record<string, string>;
  readOnly?: boolean;
  /**
   * Privileged (0.14.0, ADR 0009 step 4): using it asks for a step-up (control point platform.privilegedIdentity), runs
   * may wait for a second person, MCP only with approved writes (fourEyes). Never the default identity. Turning it off is
   * a loosening (step-up).
   */
  privileged?: boolean;
  operationFilter?: IdentityOperationFilter | null;
}

/**
 * What an administrator confirms for a platform whose settings were changed outside Steward (0.9.0,
 * GET /platforms/:id/confirm-config): per identity what the platform page does not show. Since 0.13.0 (ADR 0009 step 2)
 * the default identity and every identity whose own seal verified are kept as shown and sealed (action "keep"); any
 * other identity – added or changed outside Steward – is kept disabled ("disable") until an administrator enables it.
 * Only a credential source (reserved for PAM, not built) is reset ("reset").
 */
export interface PlatformConfirmReview {
  baseUrl: string;
  integrity: 'ok' | 'unsealed' | 'mismatch' | 'locked';
  identities: {
    id: string;
    name: string;
    default: boolean;
    integrity: 'ok' | 'unsealed' | 'mismatch' | 'locked';
    mcp: IdentityMcp;
    /** Names of its stored credentials (never values) */
    secretKeys: string[];
    /** Variables set on the identity (they would override the platform's) */
    variables: Record<string, string>;
    /** Its own sign-in settings: the type and where it signs in (origin and path) */
    signIn: { type: string; url: string | null } | null;
    /** Set flags: readOnly, privileged, operationFilter, credentialSource */
    flags: string[];
    /** Its access list (subjects; 0.13.0) – not sealed, shown so nobody is given an identity unseen */
    access?: string[];
    /** Disabled already (0.13.0) */
    disabled?: boolean;
    /** disable (0.13.0): an identity other than the default whose seal did not verify – kept, but disabled until enabled */
    action: 'keep' | 'reset' | 'remove' | 'disable';
  }[];
}

export interface Platform {
  id: string;
  name: string;
  kind: string;
  description: string;
  baseUrl: string;
  environment: string;
  config: PlatformConfig;
  /** Names of stored secrets (values are never returned). */
  secretKeys: string[];
  /**
   * Integrity of the connection settings (HMAC with the vault's integrity key): "mismatch"/"unsealed" =
   * changed outside the application (e.g. directly in the database) – no requests until an administrator confirms.
   */
  integrity?: 'ok' | 'unsealed' | 'mismatch' | 'locked';
  acl: AclEntry<PlatformPermission>[];
  /** What the current user may do with this platform. */
  permissions: PlatformPermission[];
  createdAt: string;
  updatedAt: string;
  /** The latest connection test (from the audit log; GET /platforms only, null: never tested) */
  lastTest?: { at: string; ok: boolean } | null;
  /** Its identities (0.9.0, ADR 0009), the default first – names and flags only */
  identities?: PlatformIdentity[];
}

export interface PlatformPreset {
  kind: string;
  label: string;
  description: string;
  baseUrl: string;
  config: PlatformConfig;
  /** `auth`: the authentication the field is for – filled in on a preset with authentication "none", it picks that type */
  secretFields: { key: string; label: string; help?: string; auth?: AuthType }[];
  docs: { title: string; url: string }[];
  /** Saved/imported connector type (vs. built-in preset) */
  custom?: boolean;
  /** Number of API specifications bundled with the connector type */
  specCount?: number;
  createdAt?: string;
}

/** Shareable connector definition (no credentials). */
export interface ConnectorPackage {
  /** 'steward-connector' (legacy files: 'service-manager-connector') */
  format: 'steward-connector' | 'service-manager-connector';
  version: 1;
  kind: string;
  label: string;
  description: string;
  baseUrl: string;
  config: PlatformConfig;
  secretFields: { key: string; label: string; help?: string; auth?: AuthType }[];
  docs: { title: string; url: string }[];
  specs: { name: string; content: string; pathPrefix?: string }[];
  /**
   * Identity templates (0.13.0, ADR 0009): a platform made from the type gets these identities – without credentials,
   * closed (no access list) and with MCP off. `default`: settings of the new platform's default identity. Operations
   * name operations of the bundled specs as "METHOD /path" (the spec's own path). Never secrets, access lists or MCP modes.
   */
  identities?: ConnectorIdentityTemplate[];
}

export interface ConnectorIdentityTemplate {
  name: string;
  description?: string;
  default?: boolean;
  readOnly?: boolean;
  /** 0.14.0 (ADR 0009 step 4): never on the default template (a default identity is not privileged) */
  privileged?: boolean;
  operationFilter?: { preset: 'read' | 'chosen'; operations: string[] } | null;
}

export interface ParamSchema {
  type?: string;
  format?: string;
  enum?: unknown[];
  default?: unknown;
}

export interface ApiOperation {
  specId: string;
  operationId?: string;
  method: string;
  /** Effective path: the spec's path prefix (from its server URL, editable per spec) followed by specPath. */
  path: string;
  /** The path as written in the specification, without the prefix (only set when it differs from path). */
  specPath?: string;
  summary?: string;
  tag?: string;
  description?: string;
  parameters?: { name: string; in: string; required?: boolean; description?: string; schema?: ParamSchema }[];
  hasBody?: boolean;
  /** Content type of the request body (e.g. application/json) */
  requestContentType?: string;
  /** Example body generated from the request schema */
  requestBodyExample?: unknown;
  /** Status codes documented as success */
  successStatus?: number[];
}

export interface PlatformSpec {
  id: string;
  platformId: string;
  name: string;
  format: string;
  title?: string;
  version?: string;
  serverUrl?: string;
  /**
   * Put in front of every operation path of this spec (relative to the platform base URL): empty, or
   * "/seg/seg" – by default the path of the spec's server URL, unless the base URL already ends with it.
   */
  pathPrefix: string;
  operationCount: number;
  createdAt: string;
}

export interface PlatformDoc {
  id: string;
  platformId: string;
  title: string;
  kind: 'note' | 'link' | 'file';
  content?: string;
  url?: string;
  filename?: string;
  mime?: string;
  size?: number;
  createdAt: string;
}

// ---------- Processes ----------

export interface ProcessSummary {
  id: string;
  name: string;
  description: string;
  tags: string[];
  currentVersion: number;
  updatedAt: string;
  lastRun?: { id: string; status: RunStatus; outcome?: RunOutcome; startedAt: string } | null;
  owner?: string | null;
  acl: AclEntry<ProcessPermission>[];
  /** What the current user may do with this process. */
  permissions: ProcessPermission[];
}

export interface ProcessDetail extends ProcessSummary {
  definition: ProcessDefinition;
  definitionHash: string;
}

export interface ProcessVersion {
  version: number;
  hash: string;
  author: string;
  comment: string;
  createdAt: string;
  /** The library release this version came from (0.10.0, ADR 0014) */
  origin?: LibraryOrigin | null;
}

export interface ProcessTemplate {
  id: string;
  name: string;
  description: string;
  tags: string[];
  definition: ProcessDefinition;
  /**
   * The connections the template needs (0.3.1): per slot the platform kinds that fit – the slot's `kind`, or the
   * template's `kinds` hint for slots that take several (e.g. GitHub, GitLab or Forgejo); empty: any platform.
   */
  connections?: ProcessTemplateConnection[];
  /** Every platform kind named by the connections, sorted (for a platform filter) */
  connectionKinds?: string[];
  /**
   * The recommended schedule: `cron` from the template's `recommendedSchedule` (or the first cron expression in
   * backticks of the "Recommended schedule:" sentence), `text` that sentence of the description; null when it has none
   */
  recommendedSchedule?: { cron: string | null; text: string } | null;
  /** The datasets its publish steps write */
  datasets?: string[];
  /** The dashboard templates that read one of these datasets */
  dashboards?: { id: string; name: string }[];
  /** `# steward-min-version` of the file, or null */
  minVersion?: string | null;
}

export interface ProcessTemplateConnection {
  slot: string;
  kinds: string[];
  description: string;
}

// ---------- Runs ----------

export type RunStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export type StepStatus = 'running' | 'succeeded' | 'failed' | 'skipped' | 'waiting' | 'dryrun';

/**
 * What a run came to, kept apart from whether it executed: `findings` = the run executed to the end (status
 * `succeeded`) but check steps failed. Derived on read – the stored `status` keeps its meaning.
 */
export type RunOutcome = RunStatus | 'findings';

/** The failed check steps of a run ("findings"), by the check's severity. */
export interface RunFindings {
  total: number;
  error: number;
  warning: number;
  info: number;
}

export interface RunSummary {
  id: string;
  processId: string;
  processName: string;
  processVersion: number;
  status: RunStatus;
  dryRun: boolean;
  /** Test run (#105): a dry run whose platform calls are answered by recorded responses */
  recorded: boolean;
  trigger: 'manual' | 'schedule' | 'resume' | 'subprocess' | 'webhook' | 'monitor' | 'debug';
  scheduleId?: string | null;
  /** A debug run (0.10.0, ADR 0010): one node or a step-through run; null for ordinary runs */
  debug?: DebugSpec | null;
  /** What started this run: the webhook trigger (trigger 'webhook') or the monitor (trigger 'monitor'), by id and name */
  triggerId?: string | null;
  triggerName?: string | null;
  /** Set when this run was started by a "subprocess" node of another run */
  parentRunId?: string | null;
  /** Activation key of the parent's subprocess node */
  parentStepKey?: string | null;
  actor: string;
  startedAt: string;
  finishedAt?: string | null;
  error?: string | null;
  stats: RunStats;
  /** Derived from status and findings (see RunOutcome); left out by older servers */
  outcome?: RunOutcome;
  /** Failed check steps by severity; left out by older servers */
  findings?: RunFindings;
}

export interface RunStats {
  steps: number;
  failedSteps: number;
  writes: number;
  skippedWrites: number;
  checksPassed: number;
  checksFailed: number;
  openTasks: number;
}

export interface RunStepRecord {
  id: number;
  key: string;
  parentKey: string | null;
  stepId: string;
  type: string;
  name: string;
  status: StepStatus;
  startedAt: string;
  finishedAt?: string | null;
  durationMs?: number | null;
  summary?: string | null;
  error?: string | null;
  /** Resolved request / configuration (secrets redacted). */
  input?: unknown;
  /** Output preview (truncated). Use the step endpoint for full output. */
  output?: unknown;
  outputTruncated?: boolean;
  seq: number;
}

export interface RunLog {
  id: number;
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  stepKey?: string | null;
  message: string;
  data?: unknown;
}

export interface RunArtifact {
  id: string;
  runId: string;
  stepKey: string;
  kind: 'screenshot' | 'file';
  name: string;
  mime: string;
  sha256: string;
  size: number;
  createdAt: string;
}

export interface RunReportSection {
  stepKey: string;
  title: string;
  text?: string;
  columns?: string[];
  rows?: unknown[][];
  /** The section carries text written by these AI models (0.6.0, docs/AI.md) */
  aiGenerated?: { models: string[] };
}

export interface RunDetail extends RunSummary {
  /** The library release the process version came from (0.10.0, ADR 0014); null for a local version */
  libraryOrigin?: (LibraryOrigin & { keyRevoked: boolean }) | null;
  inputs: Record<string, unknown>;
  /** identityId, identityName: the platform identity the slot used (0.13.0, ADR 0009; older runs: the default identity) */
  /** privileged (0.14.0): the identity was privileged when the run resolved its connection */
  bindings: Record<string, { platformId: string; platformName: string; baseUrl: string; identityId?: string; identityName?: string; privileged?: boolean }>;
  definitionHash: string;
  steps: RunStepRecord[];
  logs: RunLog[];
  tasks: TaskRecord[];
  artifacts: RunArtifact[];
  reports: RunReportSection[];
  /** Evaluated definition outputs (when the run succeeded and the process declares outputs) */
  outputs?: Record<string, unknown> | null;
  /** Runs started by subprocess nodes of this run */
  children?: RunChild[];
}

export interface RunChild {
  id: string;
  processId: string;
  processName: string;
  status: RunStatus;
  /** Activation key of the subprocess node that started it */
  parentStepKey: string | null;
  startedAt: string;
  finishedAt?: string | null;
}

export interface StartRunRequest {
  processId: string;
  version?: number;
  inputs?: Record<string, unknown>;
  bindings?: Record<string, string>;
  /** Slot → identity id of the bound platform (0.13.0, ADR 0009); a missing slot uses the platform's default identity */
  identities?: Record<string, string>;
  dryRun?: boolean;
  /** Test run (#105): platform calls are answered by the platforms' recorded responses; implies a dry run */
  recorded?: boolean;
}

// ---------- Engine modes and debug runs (0.10.0, ADR 0010/0011) ----------

/** How a run treats platforms: live; dry (writes skipped); test (answers from recordings, no writes). */
export type RunMode = 'live' | 'dry' | 'test';

/** Where a single-node debug run gets its answers: nothing is contacted; recordings (default); a live read. */
export type DebugAnswers = 'offline' | 'recorded' | 'live';

/** What a debug run is (stored in `runs.debug`): never values, only where they came from. */
export interface DebugSpec {
  kind: 'node' | 'step';
  /** Single node: the node that runs */
  nodeId?: string;
  /** Single node: where the variables came from */
  varsFrom?: 'run' | 'sample' | 'inputs';
  /** Single node: the run the variables were taken from */
  varsRunId?: string;
  /** Single node: offline, recorded or live */
  answers?: DebugAnswers;
  /** Single node: the editor's unsaved node was run (the definition hash covers it) */
  draft?: boolean;
  /** Single node: a live read */
  live?: boolean;
  /** Single node: the answer was pasted (never stored as a recording) */
  pasted?: boolean;
  /** Step through: pause before every node */
  pauseBeforeEach?: boolean;
  /** Step through: pause before these nodes */
  breakpoints?: string[];
  /** The step key of the first simulated or skipped decision: from there on the run answers from recordings only */
  recordedFrom?: string;
}

/** Limits of debug runs. */
export const DEBUG_LIMITS = {
  sampleBytes: 1024 * 1024,
  breakpoints: 500,
  pauseMinutes: { min: 1, max: 240, default: 30 },
  retentionDays: { min: 1, max: 90, default: 7 },
} as const;

/** Signals to a paused step-through run (only its starter sends them). */
export type DebugSignal =
  | { type: 'debug.continue' }
  | { type: 'debug.step' }
  | { type: 'debug.skip' }
  | { type: 'debug.stop' }
  | { type: 'debug.breakpoints'; breakpoints: string[] }
  /** The simulated answer of a decision, selection or manual step the run waits for */
  | { type: 'debug.answer'; decision?: TaskDecision; manual?: DebugManualAnswer };

export interface DebugManualAnswer {
  /** Indexes of the checked checklist items */
  checked?: number[];
  fields?: Record<string, string>;
  comment?: string;
}

/** A step-through run stopped before a node, or waiting for a simulated answer. */
export interface DebugPause {
  reason: 'breakpoint' | 'step' | 'each' | 'decision';
  nodeId: string;
  nodeType: string;
  nodeName: string;
  stepKey: string;
  /** The variables now (redacted) */
  vars: Record<string, unknown>;
  /** The node's resolved inputs (request, query, body …), redacted; $now(), $uuid() and the like may give another value when it runs */
  preview?: unknown;
  /** The decision, selection or manual step to answer (reason 'decision') */
  task?: {
    mode: 'approve' | 'select' | 'manual';
    title: string;
    instructions?: string;
    columns: { label: string }[];
    items: TaskItem[];
    checklist?: string[];
    fields?: { id: string; label: string; type: string }[];
  };
  since: string;
  expiresAt: string;
}

/** What the debug panel polls (GET /api/runs/:id/debug). */
export interface DebugRunState {
  runId: string;
  status: RunStatus;
  mode: RunMode;
  debug: DebugSpec;
  current: string[];
  paused: DebugPause | null;
  /** Only the starter drives the run */
  canSignal: boolean;
  steps: RunStepRecord[];
  error?: string | null;
}

/** POST /api/processes/:id/debug/node */
export interface DebugNodeRequest {
  version?: number;
  nodeId: string;
  /** The editor's unsaved node (checked like a saved definition) */
  node?: FlowNode;
  vars:
    | { from: 'run'; runId: string }
    | { from: 'sample'; vars: Record<string, unknown>; inputs?: Record<string, unknown> }
    | { from: 'inputs'; inputs: Record<string, unknown> };
  answers?: DebugAnswers;
  bindings?: Record<string, string>;
  /** A pasted answer for this node's requests (http) */
  answer?: { status: number; headers?: Record<string, string>; body?: unknown };
  /** For a decision, selection or manual step node: the simulated answer */
  decision?: TaskDecision;
  manual?: DebugManualAnswer;
}

export interface DebugNodeResult {
  runId: string;
  status: RunStatus;
  mode: RunMode;
  answers: DebugAnswers;
  step: RunStepRecord | null;
  /** Variables the node wrote (redacted) */
  written: Record<string, unknown>;
  /** Variables that were masked in the source run ("***") */
  masked: string[];
  logs: RunLog[];
  error?: string | null;
}

/** POST /api/processes/:id/debug/runs */
export interface DebugRunRequest {
  version?: number;
  inputs?: Record<string, unknown>;
  bindings?: Record<string, string>;
  mode?: 'dry' | 'test';
  pauseBeforeEach?: boolean;
  breakpoints?: string[];
}

/** Why a node cannot run live in a single-node run (null: it can). */
export type DebugLiveRefusal = 'writes' | 'interacts' | 'noPlatform' | null;

// ---------- Comparing two runs (0.10.0, ADR 0010) ----------

export const COMPARE_LIMITS = { activations: 2000, valueChars: 8000 } as const;

export interface RunCompareSide {
  id: string;
  processVersion: number;
  status: RunStatus;
  outcome?: RunOutcome;
  mode: RunMode;
  startedAt: string;
  finishedAt?: string | null;
  actor: string;
  durationMs: number | null;
  /** More activations than COMPARE_LIMITS.activations: the rest is left out */
  cut: boolean;
}

/** A value of one run in the comparison: masked ("***" in the protocol), secret (not compared), or the value (cut to COMPARE_LIMITS.valueChars) */
export type CompareValue = { masked: true } | { secret: true } | { value: unknown; cut?: boolean } | null;

export interface CompareStepSide {
  status: StepStatus;
  durationMs?: number | null;
  decision?: unknown;
  check?: { passed: boolean; severity?: string; message?: string };
  task?: { decision: unknown; decidedBy: string | null; decidedAt: string | null };
  request?: { method?: string; path?: string; status?: number; durationMs?: number; attempts?: number };
  error?: string | null;
  summary?: string | null;
}

export interface CompareRow {
  key: string;
  nodeId: string;
  nodeName: string;
  type: string;
  /** Present in both runs, only in a, only in b */
  presence: 'both' | 'a' | 'b';
  /** The node exists in only one of the two versions */
  node?: 'added' | 'removed';
  a?: CompareStepSide;
  b?: CompareStepSide;
  /** Which aspects differ */
  differs: ('path' | 'status' | 'decision' | 'check' | 'request' | 'error' | 'duration' | 'vars')[];
  /** Variables before this node that differ (name → a / b) */
  vars?: Record<string, { a: CompareValue; b: CompareValue }>;
}

export interface RunComparison {
  processId: string;
  processName: string;
  a: RunCompareSide;
  b: RunCompareSide;
  /** Inputs side by side; secret inputs are "secret – not compared" */
  inputs: Record<string, { a: CompareValue; b: CompareValue; same: boolean | null }>;
  rows: CompareRow[];
  summary: { steps: number; differing: number; onlyA: number; onlyB: number };
}

// ---------- Recorded platform responses (#105) ----------

export const RECORDING_LIMITS = { perPlatform: 500, bodyBytes: 1024 * 1024, headers: 50, headerChars: 4000, pathChars: 2000, queryKeys: 50 } as const;

export interface RecordingInput {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  /** Relative to the platform's base URL, as in process steps; `{name}` matches one segment, a trailing `*` the rest */
  path: string;
  /** Query parameters the request must have (others may be there too) */
  query?: Record<string, string>;
  /** Parts of the JSON body the request must have (objects match by their keys) */
  bodyMatch?: unknown;
  status: number;
  headers?: Record<string, string>;
  /** The answer: JSON, or a string for an answer that is not JSON */
  body?: unknown;
  note?: string;
}

export interface PlatformRecording extends Required<Omit<RecordingInput, 'bodyMatch' | 'body'>> {
  id: string;
  platformId: string;
  bodyMatch: unknown;
  body: unknown;
  /** Stored bytes (body and headers) */
  size: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

// ---------- Tasks ----------

export interface TaskItem {
  key: string;
  cells: string[];
  preselected: boolean;
}

export interface TaskRecord {
  id: string;
  runId: string;
  processName?: string;
  processId?: string;
  stepKey: string;
  mode: 'select' | 'approve' | 'manual';
  title: string;
  instructions?: string;
  columns: Column[];
  items: TaskItem[];
  status: 'open' | 'completed' | 'cancelled';
  decision?: TaskDecision | null;
  decidedBy?: string | null;
  decidedAt?: string | null;
  createdAt: string;
  dryRun?: boolean;
  /** Who may decide (empty = everyone allowed to run/approve the process). */
  assignees: string[];
  fourEyes: boolean;
  /** Who started the run */
  startedBy?: string;
  /** Whether the current user may decide this task (manual steps: complete it in stage work, verify it in stage verify). */
  canDecide?: boolean;
  /** Why not (when canDecide is false). */
  cannotDecideReason?: string;
  /** cannotDecideReason as a code and parameters the web UI translates (errors:codes.<code>) */
  cannotDecideCode?: string;
  cannotDecideParams?: ErrorParams;
  /** Manual steps only: checklist, fields, evidence, completion and verification */
  manual?: ManualTaskState;
  /**
   * The start approval of a run with a privileged identity (0.14.0, ADR 0009 step 4): a person with `approve` on the
   * process other than the requesters approves it before the first step; it expires (the run is cancelled).
   */
  startApproval?: StartApproval;
}

/** The step key of a run's start approval (run_tasks.step_key): never a node id (those are identifiers). */
export const START_APPROVAL_KEY = '$start';

/** What a start approval is about (0.14.0, ADR 0009 step 4). */
export interface StartApproval {
  /** The privileged identities of the run, per connection slot */
  identities: { slot: string; platformId: string; platformName: string; identityId: string; identityName: string }[];
  /** Who asked: the run's starter, and the owner of the schedule or trigger that started it – none of them approves */
  requesters: string[];
  /** Why a second person is needed: the assurance policy, or the process setting */
  reason: 'policy' | 'process';
  /** When the run is cancelled if nobody approved it */
  expiresAt: string;
}

/** How long a start approval waits (0.14.0, ADR 0009 step 4). */
export const START_APPROVAL_HOURS = 24;

export interface TaskDecision {
  approved: boolean;
  selectedKeys: string[];
  comment?: string;
  /** Decided from a card in Microsoft Teams (0.10.0, ADR 0013); missing: in Steward */
  via?: 'teams';
}

/** A manual step's settings, copied into the task when the run reached it (later edits of the process do not change it). */
export interface ManualTaskSpec {
  checklist: string[];
  checklistAllRequired: boolean;
  fields: { id: string; type: ManualFieldType; label: string; hint?: string; use: Exclude<ManualUse, 'off'> }[];
  evidence: ManualUse;
  verification: { required: boolean; notRunStarter: boolean; verifiers: string[]; onReject: 'return' | 'fail' };
  /** An after-the-fact entry may state a time up to this many days before the run started */
  backdateDays: number;
}

/** Why a step needs the second-person verification (returned: an earlier entry was sent back) */
export type VerificationReason = 'step' | 'notAvailable' | 'backdated' | 'returned';

/** An evidence file as it was submitted with an entry */
export interface SubmittedEvidence {
  id: string;
  filename: string;
  size: number;
  sha256: string;
  uploadedBy: string;
}

/** What the person who completed a manual step entered. */
export interface ManualSubmission {
  /** Indexes of the ticked checklist items */
  checked: number[];
  fields: { id: string; value: string | number | null; ticketId?: string | null }[];
  /** Required evidence ("evidence") or required fields (their id) that could not be provided, with the reason */
  notAvailable: { target: string; reason: string }[];
  /** After-the-fact entry: when the work was done, stated by the person (ISO), and why it is entered afterwards */
  doneAt: string | null;
  doneAtReason: string | null;
  comment: string | null;
  completedBy: string;
  /** When it was entered in Steward */
  completedAt: string;
  verificationReasons: VerificationReason[];
  /** The evidence files of this entry, fixed when it was completed (files of the round, with their SHA-256) */
  evidence: SubmittedEvidence[];
}

export interface ManualVerification {
  approved: boolean;
  comment: string | null;
  by: string;
  at: string;
}

/** An evidence file of a manual step (stored like record attachments: content-checked, with its SHA-256). */
export interface TaskEvidence {
  id: string;
  taskId: string;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  uploadedBy: string;
  uploadedAt: string;
  /** The completion round it was added in (it can be removed until that round is submitted) */
  round: number;
}

export interface ManualTaskState {
  spec: ManualTaskSpec;
  /** work: waiting for the person doing the step; verify: waiting for the second person; done */
  stage: 'work' | 'verify' | 'done';
  /** 1 + the times the step was sent back */
  round: number;
  submission: ManualSubmission | null;
  verification: ManualVerification | null;
  /** Earlier rounds that a verifier sent back, oldest first */
  returned: { submission: ManualSubmission; rejection: ManualVerification }[];
  evidence: TaskEvidence[];
}

/**
 * The evidence files that belong to what a manual step shows: the files fixed in its entry once it was completed
 * (nothing added later appears in a completed or verified entry), else the files of the round being worked on.
 */
export function entryEvidence(m: Pick<ManualTaskState, 'evidence' | 'round' | 'submission'>): TaskEvidence[] {
  if (!m.submission) return m.evidence.filter((e) => e.round === m.round);
  const ids = new Set((m.submission.evidence ?? []).map((e) => e.id));
  return m.evidence.filter((e) => ids.has(e.id));
}

/** Body of POST /tasks/:id/complete for a manual step. */
export interface ManualCompletion {
  checked?: number[];
  fields?: { id: string; value: string }[];
  notAvailable?: { target: string; reason: string }[];
  doneAt?: string;
  doneAtReason?: string;
  comment?: string;
}

// ---------- Schedules ----------

export interface Schedule {
  id: string;
  name: string;
  processId: string;
  processName?: string;
  cron: string;
  timezone?: string;
  inputs: Record<string, unknown>;
  bindings: Record<string, string>;
  /** Slot → identity id (0.13.0, ADR 0009); a missing slot uses the platform's default identity */
  identities?: Record<string, string>;
  dryRun: boolean;
  enabled: boolean;
  allowOverlap: boolean;
  lastRunAt?: string | null;
  lastRunId?: string | null;
  lastRunStatus?: RunStatus | null;
  nextRunAt?: string | null;
  createdAt: string;
  /** Scheduled runs execute with the permissions of this user. */
  owner?: string | null;
  canEdit?: boolean;
  /** Notification policy of its runs (#127, #139); missing in input: unchanged (new schedules: on change). `pause` is set with the pause and resume actions. */
  notify?: ScheduleNotify;
  /** After a start that found missed fires: 'once' starts one run right away, 'none' (default) waits for the next fire. Missing in input: unchanged. */
  catchUp?: ScheduleCatchUp;
  /** The fires missed the last time Steward was not running (set at start; null: none found yet). */
  missed?: ScheduleMissedFires | null;
}

export const SCHEDULE_CATCH_UP = ['none', 'once'] as const;
export type ScheduleCatchUp = (typeof SCHEDULE_CATCH_UP)[number];

/** Fires of a schedule that fell into a time when Steward was not running (or its vault was locked). */
export interface ScheduleMissedFires {
  /** When the start found them */
  detectedAt: string;
  /** Since when (the last time the scheduler was known to run, or the schedule's last fire) */
  from: string;
  count: number;
  /** The first missed fires (at most 10, ISO) */
  times: string[];
  last: string | null;
  /** Whether one catch-up run was started */
  catchUp: boolean;
}

// ---------- Audit ----------

/**
 * A check that relied on audit history imported from another instance (moving an instance, docs/MIGRATION.md):
 * that history verified against the source's signed checkpoint and key, not against this instance's own key.
 */
export interface ImportedHistoryRef {
  importId: string;
  /** SHA-256 fingerprint of the source instance's signing key */
  sourceFingerprint: string;
}

/**
 * Columns the audit log can be sorted by on the server (0.13): `time` is the order of the chain (the sequence number,
 * so entries written in the same millisecond keep their order), `target` the entity type and id.
 */
export const AUDIT_SORT_KEYS = ['time', 'actor', 'action', 'target'] as const;
export type AuditSortKey = (typeof AUDIT_SORT_KEYS)[number];

/** The actors and target types in the audit log (the filters of the audit page; GET /api/audit/facets). */
export interface AuditFacets {
  actors: string[];
  entityTypes: string[];
}

export interface AuditEntry {
  seq: number;
  ts: string;
  actor: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  runId?: string | null;
  summary: string;
  details?: unknown;
  /** Hash of the previous entry ("GENESIS" for #1) */
  prevHash?: string;
  hash: string;
}

/**
 * A signed statement "the audit log had `count` entries and entry #seq had this hash" (Ed25519,
 * per-install key kept in the vault). Kept outside the database – SIEM, e-mail, a file – it is an
 * anchor that detects removed entries. `digest` is an unkeyed SHA-256 chain over entries 1..seq,
 * so an export can be checked offline with the public key only.
 */
export interface AuditCheckpoint {
  v: 1;
  seq: number;
  hash: string;
  digest: string;
  count: number;
  ts: string;
  keyFingerprint: string;
  /** Ed25519 signature (base64) over the canonical JSON of the other fields */
  signature: string;
}

export interface AuditVerifyResult {
  ok: boolean;
  checked: number;
  firstBadSeq?: number;
  message: string;
  /** Anchors the chain was compared with (pasted checkpoint, local anchor file, SM_AUDIT_ANCHOR) */
  anchors?: { source: string; seq: number; ok: boolean; message: string }[];
  /** The checkpoint written after a successful verification */
  checkpoint?: AuditCheckpoint;
  /**
   * incremental (default): the entries after the newest signed checkpoint; full: every entry still in the database
   * (from #1, or from the signed checkpoint of the newest archive whose entries were deleted)
   */
  mode?: AuditVerifyMode;
  /** Incremental: the entry the check started after (the signed checkpoint's) */
  fromSeq?: number;
  /** Entries up to this one were archived and deleted from the database (retention); the archives hold them */
  deletedThroughSeq?: number;
}

export const AUDIT_VERIFY_MODES = ['incremental', 'full'] as const;
export type AuditVerifyMode = (typeof AUDIT_VERIFY_MODES)[number];

/** The last verification of a mode, as GET /api/audit/archive reports it (the stored "verified head"). */
export interface AuditVerificationRecord {
  at: string;
  by: string;
  mode: AuditVerifyMode;
  ok: boolean;
  checked: number;
  /** The first entry checked */
  fromSeq: number | null;
  /** The last entry checked (the verified head) */
  toSeq: number | null;
  message: string;
}

/** Archiving of closed epochs and the retention of archived entries (Audit log → Archive). */
export interface AuditArchiveSettings {
  /** Export closed epochs (one archive per month of signed checkpoints) to <data dir>/audit-archives */
  archive: boolean;
  /** Also upload each archive, encrypted with the backup key, to the S3 target of the backups */
  upload: boolean;
  /** Delete archived entries older than this many days from the database; 0 = never (default) */
  retentionDays: number;
}
export const DEFAULT_AUDIT_ARCHIVE_SETTINGS: AuditArchiveSettings = { archive: false, upload: false, retentionDays: 0 };

export interface AuditArchiveInfo {
  id: string;
  firstSeq: number;
  lastSeq: number;
  firstTs: string;
  lastTs: string;
  entries: number;
  /** Signed checkpoints (epoch boundaries) in the archive */
  epochs: number;
  file: string;
  size: number;
  sha256: string;
  /** The file is no longer in the data folder (moved elsewhere) */
  fileMissing: boolean;
  remoteKey: string | null;
  uploadedAt: string | null;
  createdAt: string;
  createdBy: string;
  /** The entries are being deleted from the database (retention) */
  pruning: boolean;
  prunedAt: string | null;
  prunedEntries: number | null;
}

/** GET /api/audit/archive – epochs, archives, retention and the last verifications (auditors and administrators). */
export interface AuditArchiveStatus {
  settings: AuditArchiveSettings;
  /** Uploading needs backups to S3 with a backup passphrase (Settings → Backups) */
  canUpload: boolean;
  epochs: { closed: number; archived: number };
  latestCheckpoint: { seq: number; ts: string } | null;
  archivedThrough: { seq: number; ts: string } | null;
  deletedThrough: { seq: number; ts: string } | null;
  entriesInDatabase: number;
  /** Newest first (at most 100) */
  archives: AuditArchiveInfo[];
  verification: {
    incremental: AuditVerificationRecord | null;
    full: AuditVerificationRecord | null;
    /** A full verification running in the background */
    running: { startedAt: string; by: string; checked: number; total: number } | null;
    /** Days between automatic full verifications (SM_AUDIT_FULL_VERIFY_DAYS; 0 = only by hand) */
    fullIntervalDays: number;
  };
}

/** GET /api/audit/anchoring – how the audit log is anchored outside the database. */
export interface AuditAnchoring {
  /** Ed25519 public key of this installation (PEM); checkpoints are signed with it */
  publicKeyPem: string | null;
  fingerprint: string | null;
  latest: AuditCheckpoint | null;
  /** Interval of automatic checkpoints */
  intervalMinutes: number;
  /** Anchors the server compares with on every verification */
  configuredAnchors: string[];
  /** Addresses that receive signed checkpoints by e-mail (administrators can change them) */
  emailRecipients: string[];
  emailIntervalHours: number;
}

// ---------- Misc ----------

/** @deprecated use AuthStatus */
export type VaultStatus = AuthStatus & { operator?: string };

export interface Settings {
  /** 'adminsOnly' limits password sign-in to administrators once SSO is in place; 'none' turns it off (SM_PASSWORD_LOGIN overrides it) */
  passwordLogin: PasswordLogin;
  /** Read-only: passwordLogin comes from SM_PASSWORD_LOGIN and cannot be changed in the UI */
  passwordLoginFromEnv?: boolean;
  /**
   * Read-only: SM_PASSWORD_LOGIN=none is set, but administrators still sign in with a password (passwordLogin is
   * 'adminsOnly') until an administrator signed in with single sign-on – then it takes effect for good
   */
  passwordLoginPending?: 'none';
  browserHeadless: boolean;
  /** Delete runs (journal, logs, evidence files) older than this many days; 0 = keep forever. The audit log is never pruned. */
  retentionRunDays: number;
  /** Delete finished debug runs (ADR 0010) older than this many days (1–90, default 7); before the ordinary run cleanup */
  retentionDebugRunDays: number;
  /** A paused step-through debug run is cancelled after this many minutes (1–240, default 30) */
  debugPauseMinutes: number;
  /** Delete read notifications older than this many days */
  retentionNotificationDays: number;
  /** Keep monitor status history, hourly samples and recent results this many days (default 30) */
  retentionMonitorDays: number;
  browserTimeoutMs: number;
  /** Language of messages that go to a channel rather than a person (Teams, webhook), and for users without a chosen language */
  defaultLocale: Locale;
  /** Who may open the public API documentation (Swagger UI) and its OpenAPI document. SM_API_DOCS overrides it. */
  apiDocs: ApiDocsMode;
  /**
   * Where process-controlled requests (http node, browser navigation, OpenAPI import by URL) may go.
   * 'platforms' (default): the origins of configured platforms (+ their trusted origins) and the allow-list below.
   * 'allowList': only the allow-list below. 'open': any host (labs only – shows a warning). Cloud-metadata and
   * link-local addresses and the server's own port are always blocked. SM_OUTBOUND_POLICY overrides it.
   */
  outboundPolicy: OutboundPolicy;
  /** Extra destinations processes may reach: origins (https://host[:port]), host names/globs (*.example.com) or CIDRs. */
  outboundAllowList: string[];
  /** Access reconciliation: dismissing a finding needs a second person who confirms it (four-eyes) */
  findingDismissFourEyes: boolean;
}

export const OUTBOUND_POLICIES = ['platforms', 'allowList', 'open'] as const;
export type OutboundPolicy = (typeof OUTBOUND_POLICIES)[number];

// ---------- Public REST API (/api/v1) ----------

/** off: no documentation page; authenticated: signed-in users (session); public: everyone who can reach the server */
export const API_DOCS_MODES = ['off', 'authenticated', 'public'] as const;
export type ApiDocsMode = (typeof API_DOCS_MODES)[number];

/** Effective configuration of the public API, for the web UI (GET /api/public-api). */
export interface PublicApiStatus {
  enabled: boolean;
  /** Base path of the versioned API, e.g. "/api/v1" */
  basePath: string;
  /** Effective documentation mode (environment overrides the setting) */
  docs: ApiDocsMode;
  /** "env" when SM_API_DOCS decides the documentation mode (the setting is then ignored) */
  docsSource: 'env' | 'settings';
  /** Link to the Swagger UI when the current user may open it, else null */
  docsUrl: string | null;
  /** Requests per minute and token; 0 = unlimited */
  rateLimitPerMinute: number;
  apiVersion: string;
}

/** MCP server (docs/MCP.md), for the settings and profile pages (GET /api/mcp-server). */
export interface McpServerStatus {
  enabled: boolean;
  /** SM_MCP=off: turned off by the environment, the setting is ignored */
  forcedOff: boolean;
  /** Path of the Streamable HTTP endpoint, e.g. "/api/mcp" */
  path: string;
  /** Supported protocol revisions, newest first */
  protocolVersions: string[];
  rateLimitPerMinute: number;
  gatewayRateLimitPerMinute: number;
  /** Assistants may ask to start runs (each confirmed by the token owner in Steward) */
  runRequests: boolean;
  /** Assistants may propose control catalogues and mappings, each reviewed in Steward (#74) */
  controlProposals: boolean;
  /** OAuth sign-in for MCP clients (#12): optional, off by default; MCP tokens keep working either way */
  oauth: McpOAuthSettings;
}

/** OAuth sign-in for MCP clients (#12), set by administrators. */
export interface McpOAuthSettings {
  enabled: boolean;
  /** clients may register themselves (RFC 7591); otherwise administrators add them */
  dynamicRegistration: boolean;
  accessTokenMinutes: number;
  /** a refresh token that is not used for this long expires (each refresh starts it again) */
  refreshTokenDays: number;
  /** a connection ends this many days after the person allowed it, however often it was refreshed (sign in again) */
  grantMaxDays: number;
}
export const MCP_OAUTH_LIMITS = {
  accessTokenMinutes: [5, 1440],
  refreshTokenDays: [1, 365],
  grantMaxDays: [1, 730],
  clients: 500,
  redirectUris: 10,
} as const;
/** An OAuth client of the MCP server (administrators). */
export interface McpOAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
  /** "dynamic" (registered itself) or the administrator who added it */
  registeredBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** people who granted it access now */
  grants: number;
}
/** Access a person gave an MCP client (Profile → Connected MCP clients). */
export interface McpOAuthGrant {
  id: string;
  clientId: string;
  clientName: string;
  /** the user it acts as (administrators see everyone's) */
  owner: string;
  scope: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** when the refresh token runs out (the client must ask again) */
  expiresAt: string;
}
/** What the consent page shows before a person allows a client. */
export interface McpOAuthConsent {
  clientId: string;
  clientName: string;
  redirectUri: string;
  /** the host the browser returns to: what the person checks */
  redirectHost: string;
  registeredBy: string;
  scope: string;
  resource: string;
  /** the person already allowed this client (a new grant replaces the old one) */
  alreadyGranted: boolean;
}

// ---------- requests from MCP clients (#11) ----------

/**
 * gateway: a changing platform call; run: a run; catalogue, mappings: a control catalogue or control mappings for review
 * (#74); plant: changes to the plant registry for review (0.12.0)
 */
export const MCP_REQUEST_KINDS = ['gateway', 'run', 'catalogue', 'mappings', 'plant'] as const;
export type McpRequestKind = (typeof MCP_REQUEST_KINDS)[number];
/** pending → approved → done | failed; or rejected / expired / withdrawn */
export const MCP_REQUEST_STATUSES = ['pending', 'rejected', 'withdrawn', 'expired', 'done', 'failed'] as const;
export type McpRequestStatus = (typeof MCP_REQUEST_STATUSES)[number];

export const MCP_REQUEST_LIMITS = {
  /** JSON request body of a gateway write */
  bodyBytes: 64 * 1024,
  reason: 500,
  comment: 2000,
  /** A request nobody decided on expires */
  expiryHours: 24,
  /** Open requests per user */
  pendingPerUser: 20,
  /** Stored response of an executed call */
  resultChars: 16_000,
  /** Control catalogue and mapping proposals (#74): reviewed for up to 14 days */
  proposalExpiryDays: 14,
  /** Controls or mappings per call (an MCP request is at most 64 KB); larger proposals come in parts */
  proposalPart: 200,
  /** Mappings in one proposal */
  proposalMappings: 1000,
  /** Stored size of one proposal, and of all open proposals of one person (the reviewers' inbox reads them) */
  proposalBytes: 2 * 1024 * 1024,
  proposalBytesPerUser: 8 * 1024 * 1024,
} as const;

/** A proposal in the list of AI requests (#74): what it is about, without its content. */
export type McpProposalSummary =
  | { type: 'catalogue'; key: string; name: string; controls: number }
  | { type: 'mappings'; catalogueKey: string; mappings: number }
  | { type: 'plant'; title: string; added: number; changed: number };

/** A control catalogue proposed by an AI assistant (#74), as the reviewer sees it: compared with the catalogue of that key. */
export interface McpCatalogueProposal {
  type: 'catalogue';
  key: string;
  name: string;
  version: string;
  description: string;
  /** The assistant is still sending parts: nobody can decide yet */
  incomplete: boolean;
  /** The catalogue with this key, when there is one (the proposal updates it in place) */
  existing: { id: string; name: string; version: string; builtin: boolean } | null;
  controls: {
    ref: string;
    title: string;
    description: string;
    change: 'new' | 'changed' | 'same';
    /** The current texts of a changed control */
    before?: { title: string; description: string };
  }[];
  /** Controls of the existing catalogue the proposal does not contain (removed only when the reviewer ticks them) */
  missing: { ref: string; title: string; mapped: number }[];
}

/** Mappings of controls to Steward items proposed by an AI assistant (#74), as the reviewer sees them. */
export interface McpMappingsProposal {
  type: 'mappings';
  catalogueKey: string;
  catalogueId: string | null;
  incomplete: boolean;
  mappings: {
    /** Position in the proposal (what the reviewer accepts) */
    index: number;
    ref: string;
    controlId: string | null;
    controlTitle: string;
    kind: ControlTagKind;
    /** null when the reviewer may not see the item */
    targetId: string | null;
    label: string;
    path: string | null;
    reason: string;
    /** new: can be mapped; mapped: already is; noControl: the catalogue has no such control; notVisible: the reviewer may not see the item */
    state: 'new' | 'mapped' | 'noControl' | 'notVisible';
  }[];
}

/** What a plant proposal's import preview shows (0.12.0): only additions and changes – proposals never remove or rename. */
export interface McpPlantPreview {
  counts: { add: number; change: number };
  /** The entries added and changed, a changed one with its differences field by field */
  changes: PlantChange[];
  warnings: PlantImportProblem[];
  /** What Steward checks in the entries once applied (they do not stop it) */
  checks: { code: string; message: string }[];
}

/**
 * 0.17.0: the data points a plant proposal adds or changes with a source, grouped by entry and document (docs/PLANT.md
 * "Sources of data points"): the reviewer sees where each comes from, and whether the document is kept in Steward.
 */
export interface McpPlantSourceGroup {
  /** A device profile's data points, or an asset's own (its assignment's additions) */
  kind: 'profile' | 'asset';
  entry: string;
  entryName: string;
  /** The entry is in Steward now (a new one gets its documents once the proposal is applied) */
  exists: boolean;
  /** The document as the source names it: a title, or the number of a record */
  document: string;
  /** The record that is this document, linked to the entry (or inherited from its bases) and readable by the reader */
  record: { id: string; number: string; title: string } | null;
  points: { interface: string; group: string; id: string; name: string; action: 'add' | 'change'; page: string; section: string }[];
}

/**
 * Changes to the plant registry proposed by an AI assistant (0.12.0, docs/PLANT.md "Proposals from assistants"): a
 * document of the plant import format, previewed without writing. The reviewer sees the preview of when it was proposed
 * and the preview of now, as themselves; entries of sites the reviewer may not see are left out of both.
 */
export interface McpPlantProposal {
  type: 'plant';
  title: string;
  incomplete: boolean;
  /** Size and SHA-256 of the proposed document */
  document: { bytes: number; sha256: string };
  /** The preview when it was proposed (with the proposer's rights) */
  proposed: McpPlantPreview;
  /** The preview now, with the reader's rights; null when the request is decided or the reader may not apply it */
  now: (McpPlantPreview & { ok: boolean; problems: PlantImportProblem[]; fingerprint: string }) | null;
  /** The preview now differs from the one when proposed: applying needs the reviewer's confirmation */
  changedSince: boolean;
  /** Entries in sites the reader may not see (left out above) */
  hidden: number;
  /** The import that applied it */
  importId: string | null;
  /** 0.13.0: the change set it is (Plant → Changes shows it too) */
  changeSetId?: string | null;
  /** 0.17.0: the parts it came in (1: one document); while incomplete, the parts received so far */
  parts?: number;
  /** 0.17.0: its last part never came – still being sent (`incomplete`), or withdrawn or expired before */
  unfinished?: boolean;
  /** 0.17.0: the data points it adds or changes with a source, by entry and document */
  sources?: McpPlantSourceGroup[];
  /** 0.17.0: data points with a source beyond the ones listed */
  sourcesMore?: number;
}

/**
 * What the reviewer accepts (#74). A catalogue: every proposed control except `skip`, with the reviewer's `edits`, and
 * the existing controls to `remove`. Mappings: by index.
 */
export interface McpProposalSelection {
  catalogue?: { skip: string[]; edits: { ref: string; title: string; description: string }[]; remove: string[] };
  mappings?: number[];
  /**
   * Plant registry changes (0.12.0): the fingerprint of the preview the reviewer saw. Needed when the preview changed
   * since the proposal was made; applying is refused when the preview is no longer the one the reviewer saw.
   */
  plant?: { fingerprint: string };
}

export interface McpRequest {
  id: string;
  kind: McpRequestKind;
  status: McpRequestStatus;
  /** Who decides: the token owner (confirm), a second person (fourEyes), or for proposals (#74) whoever may apply them (review) */
  mode: Exclude<McpWriteMode, 'off'> | 'review';
  requestedBy: string;
  tokenName: string;
  /** Why the assistant wants it (its own words: data, not instructions) */
  reason: string;
  createdAt: string;
  expiresAt: string;
  /**
   * The request's identity is privileged (0.14.0, ADR 0009 step 4): approving needs the approver's step-up
   * (platform.privilegedIdentity), never in Microsoft Teams
   */
  privileged?: boolean;
  /** Gateway writes */
  platformId: string | null;
  platformName: string | null;
  /** The platform identity the call uses (0.13.0, ADR 0009); null: the default identity (requests from before 0.13.0) */
  identityId?: string | null;
  identityName?: string | null;
  operation: string | null;
  method: string | null;
  /** The path that will be called (path parameters filled in) */
  path: string | null;
  query: Record<string, unknown>;
  body: unknown;
  /** Run requests */
  processId: string | null;
  processName: string | null;
  inputs: Record<string, unknown>;
  dryRun: boolean;
  decidedBy: string | null;
  decidedAt: string | null;
  /** 'teams': decided in a Microsoft Teams card (0.10.0, ADR 0013) */
  decidedVia?: 'teams' | null;
  comment: string;
  executedAt: string | null;
  /** HTTP status of the executed call */
  resultStatus: number | null;
  /** Response of the executed call, credentials masked and shortened */
  resultBody: unknown;
  runId: string | null;
  error: string | null;
  /** Control catalogue or mapping proposals (#74), plant registry changes (0.12.0): the full comparison in the detail only */
  proposal: McpCatalogueProposal | McpMappingsProposal | McpPlantProposal | null;
  /** What a proposal is about, also in lists */
  proposalSummary: McpProposalSummary | null;
  /** For the reader */
  canApprove: boolean;
  canReject: boolean;
}

/** A check of a process that failed in the last 7 days: its latest failure and how long it has been failing (#138). */
export interface FailedCheckGroup {
  processId: string;
  processName: string;
  /** The check step's id in the process */
  checkId: string;
  name: string;
  severity: string;
  /** Message and run of the latest failure */
  message: string;
  runId: string;
  ts: string;
  /** Failures in the 7 days */
  count: number;
  /** First failure of the current streak (since the check last passed, within the 7 days) */
  since: string;
  /** Failures since then */
  streak: number;
  /** The check passed in a later run */
  resolved: boolean;
}

export interface DashboardData {
  openTasks: TaskRecord[];
  activeRuns: RunSummary[];
  recentRuns: RunSummary[];
  /** Failed checks of the last 7 days, one entry per process and check (#138) */
  failedChecks: FailedCheckGroup[];
  upcoming: Schedule[];
  counts: { platforms: number; processes: number; schedules: number; runs24h: number; failed24h: number };
  /** The start page's tiles: what needs the viewer's attention */
  attention: DashboardAttention;
  /** Administrators only: what is set up so far (the getting-started checklist on the start page) */
  setup?: DashboardSetup;
}

/**
 * The start page's tiles, counted with the viewer's permissions (only what they may see). An entry is
 * left out when the viewer has no right to that kind of item at all – the tile is not shown then.
 */
/** A process that publishes a dataset key ("Publish to dashboard" node in its current version), for empty widgets. */
export interface DatasetPublisher {
  processId: string;
  processName: string;
  /** An enabled schedule runs it */
  scheduled: boolean;
  /** The viewer may edit / run it */
  canEdit: boolean;
  canRun: boolean;
}

export interface DashboardAttention {
  /** Open approvals and decisions the viewer may decide */
  tasks: number;
  /** Runs of visible processes started in the last 24 hours: failed, completed with findings (failed checks), all */
  runs: { failed: number; withFindings?: number; total: number };
  /** Monitors the viewer may view (templates and disabled monitors are not counted) */
  monitors?: { down: number; degraded: number; total?: number };
  /** Credential register entries the viewer may see */
  credentials?: { expired: number; overdue: number; dueSoon: number; total?: number };
  /** Open findings of the access reconciliation checks the viewer may read (checks: how many checks they may read) */
  findings?: { open: number; checks?: number };
  /** Living documents whose periodic review is due soon or overdue (editors, approvers, auditors; others: the documents they own or review) */
  reviews?: { overdue: number; dueSoon: number; total?: number };
  /** Mandatory service duties due within a week (or in their grace period) and those whose last period was missed or failed (service editors, auditors; others: the duties they are responsible for) */
  duties?: { missed: number; dueSoon: number; total?: number };
  /** Services whose scorecard needs attention (service editors, auditors: every service; others: the services they own) */
  scorecard?: { attention: number; services: number };
  /** Open ticket references waiting for a vendor (status "waiting for vendor", or open with a vendor source) */
  vendorTickets?: { open: number; oldestDays: number | null; total?: number };
}

/** Instance-wide numbers of the getting-started checklist (all entries, not only the visible ones). */
export interface DashboardSetup {
  platforms: number;
  processes: number;
  runs: number;
  schedules: number;
  monitors: number;
  credentials: number;
  users: number;
  reportSchedules: number;
}

// ---------- API contract check (sandbox contract tests) ----------

export interface ContractCheckResult {
  platformId: string;
  /** Operations called */
  checked: number;
  passed: number;
  failed: number;
  /** GET operations left out (required path parameters, over the cap of 30) */
  skipped: number;
  results: {
    operationId?: string;
    method: string;
    path: string;
    status: number;
    ok: boolean;
    problems: string[];
    durationMs?: number;
  }[];
}
