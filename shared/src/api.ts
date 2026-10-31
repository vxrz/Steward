import type { ErrorParams } from './errors.js';
import type { ScheduleNotify } from './notifyPolicy.js';
import type { Column, ManualFieldType, ManualUse, ProcessDefinition } from './process.js';
import type { Locale } from './locales.js';
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

export const ROLES = ['admin', 'designer', 'operator', 'approver', 'auditor', 'viewer', 'status'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_INFO: Record<Role, string> = {
  admin: 'Everything: users, teams, platforms and credentials, settings, all processes',
  designer: 'Create processes; edit and run processes (unless restricted)',
  operator: 'Run and schedule processes (unless restricted)',
  approver: 'Decide approvals and user tasks',
  auditor: 'Read-only access to all processes, runs, protocols and the audit log',
  viewer: 'Read-only access to processes and their runs (unless restricted)',
  status: 'Only the service status pages – none of the other pages, processes, platforms or data',
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
}

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

/** Roles a member can have in a team (#131): administrator is instance-wide, a status viewer sees only status pages. */
export const TEAM_ROLES = ['designer', 'operator', 'approver', 'auditor', 'viewer'] as const satisfies readonly Role[];
export type TeamRole = (typeof TEAM_ROLES)[number];

/** Kinds of resources that can have owning teams (#131). */
export const OWNED_KINDS = ['process', 'platform'] as const;
export type OwnedKind = (typeof OWNED_KINDS)[number];

/** Why someone has a right on a resource (#131): shown in the UI and used in access reviews. */
export interface AccessReason {
  /** admin | owner | auditor | instanceRole | teamRole | accessList */
  source: 'admin' | 'owner' | 'auditor' | 'instanceRole' | 'teamRole' | 'accessList';
  /** The role, the team, or the access list subject the right comes from */
  role?: Role;
  team?: string;
  subject?: string;
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
  version: string;
  browserAvailable: boolean;
}

/**
 * Step-up re-authentication (confirming a sensitive action, docs/SECURITY-HARDENING.md#step-up-re-authentication):
 * how this session confirms – the password (password sessions), a fresh sign-in at the session's provider (single
 * sign-on sessions), not needed (emergency access) or not possible (the provider is gone or disabled).
 */
export type StepUpMethod = 'password' | 'sso' | 'emergency' | 'none';

/** What a step-up confirms (each sensitive route names its action; shown in the dialog and on the callback page). */
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

export type AuthType = 'none' | 'basic' | 'bearer' | 'apiKey' | 'oauth2_client_credentials' | 'token_request' | 'jwt' | 'aws_sigv4';

export interface AuthConfig {
  type: AuthType;
  /** oauth2: token endpoint (template, scope: vars, secrets) */
  tokenUrl?: string;
  scope?: string;
  /** oauth2: send client credentials as Basic header or in the form body */
  clientAuth?: 'basic' | 'body';
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
  /** Header added to API calls; template with {{ token }} */
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
}

export interface PlatformPreset {
  kind: string;
  label: string;
  description: string;
  baseUrl: string;
  config: PlatformConfig;
  secretFields: { key: string; label: string; help?: string }[];
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
  secretFields: { key: string; label: string; help?: string }[];
  docs: { title: string; url: string }[];
  specs: { name: string; content: string; pathPrefix?: string }[];
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
  lastRun?: { id: string; status: RunStatus; startedAt: string } | null;
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
}

export interface ProcessTemplate {
  id: string;
  name: string;
  description: string;
  tags: string[];
  definition: ProcessDefinition;
}

// ---------- Runs ----------

export type RunStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export type StepStatus = 'running' | 'succeeded' | 'failed' | 'skipped' | 'waiting' | 'dryrun';

export interface RunSummary {
  id: string;
  processId: string;
  processName: string;
  processVersion: number;
  status: RunStatus;
  dryRun: boolean;
  /** Test run (#105): a dry run whose platform calls are answered by recorded responses */
  recorded: boolean;
  trigger: 'manual' | 'schedule' | 'resume' | 'subprocess' | 'webhook' | 'monitor';
  scheduleId?: string | null;
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
}

export interface RunDetail extends RunSummary {
  inputs: Record<string, unknown>;
  bindings: Record<string, { platformId: string; platformName: string; baseUrl: string }>;
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
  dryRun?: boolean;
  /** Test run (#105): platform calls are answered by the platforms' recorded responses; implies a dry run */
  recorded?: boolean;
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
}

export interface TaskDecision {
  approved: boolean;
  selectedKeys: string[];
  comment?: string;
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
}

// ---------- requests from MCP clients (#11) ----------

export const MCP_REQUEST_KINDS = ['gateway', 'run'] as const;
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
} as const;

export interface McpRequest {
  id: string;
  kind: McpRequestKind;
  status: McpRequestStatus;
  /** Who decides: the token owner (confirm) or a second person (fourEyes) */
  mode: Exclude<McpWriteMode, 'off'>;
  requestedBy: string;
  tokenName: string;
  /** Why the assistant wants it (its own words: data, not instructions) */
  reason: string;
  createdAt: string;
  expiresAt: string;
  /** Gateway writes */
  platformId: string | null;
  platformName: string | null;
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
  comment: string;
  executedAt: string | null;
  /** HTTP status of the executed call */
  resultStatus: number | null;
  /** Response of the executed call, credentials masked and shortened */
  resultBody: unknown;
  runId: string | null;
  error: string | null;
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
export interface DashboardAttention {
  /** Open approvals and decisions the viewer may decide */
  tasks: number;
  /** Runs of visible processes started in the last 24 hours */
  runs: { failed: number; total: number };
  /** Monitors the viewer may view (templates and disabled monitors are not counted) */
  monitors?: { down: number; degraded: number };
  /** Credential register entries the viewer may see */
  credentials?: { expired: number; overdue: number; dueSoon: number };
  /** Open findings of the access reconciliation checks the viewer may read */
  findings?: { open: number };
  /** Living documents whose periodic review is due soon or overdue (editors, approvers, auditors; others: the documents they own or review) */
  reviews?: { overdue: number; dueSoon: number };
  /** Mandatory service duties due within a week (or in their grace period) and those whose last period was missed or failed (service editors, auditors; others: the duties they are responsible for) */
  duties?: { missed: number; dueSoon: number };
  /** Services whose scorecard needs attention (service editors, auditors: every service; others: the services they own) */
  scorecard?: { attention: number; services: number };
  /** Open ticket references waiting for a vendor (status "waiting for vendor", or open with a vendor source) */
  vendorTickets?: { open: number; oldestDays: number | null };
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
