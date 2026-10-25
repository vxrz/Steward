// ---------- Moving an instance (migration packages, #51) ----------

/** What happens to a user of the source instance on import. */
export type UserDecision =
  /** an existing user of this instance (e.g. their single sign-on account) */
  | { action: 'map'; to: string; confirm?: boolean }
  /**
   * a new account without a password, linked at the first single sign-on with exactly this user name – through
   * `provider` only (an enabled provider's id; may be left out when exactly one is enabled)
   */
  | { action: 'create-sso'; username: string; provider?: string; confirm?: boolean }
  /** a new local account with a one-time password (only while password sign-in is allowed) */
  | { action: 'create-local'; username?: string; confirm?: boolean }
  /** a former user: an inactive account that keeps the history readable and cannot sign in */
  | { action: 'archive'; username?: string; confirm?: boolean };

export type UserAction = UserDecision['action'];

/** What happens to a team of the source instance on import. */
export type TeamDecision = { action: 'map'; to: string } | { action: 'create'; name?: string } | { action: 'drop' };

export interface MigrationMapping {
  /** Keyed by the source user name */
  users: Record<string, UserDecision>;
  /** Keyed by the source team name */
  teams: Record<string, TeamDecision>;
}

export interface MigrationPlanUser {
  username: string;
  displayName: string;
  email: string | null;
  roles: string[];
  active: boolean;
  kind: 'local' | 'sso';
  provider: string | null;
  teams: string[];
  lastLoginAt: string | null;
  suggestion: UserDecision;
  /** Why the suggestion was made: 'email', 'username', 'localPart', 'none' */
  suggestedBy: 'email' | 'username' | 'localPart' | 'none';
  /** A user of this instance has the same name */
  clash: { username: string; admin: boolean } | null;
}

export interface MigrationPlanTeam {
  name: string;
  description: string;
  members: string[];
  suggestion: TeamDecision;
  clash: boolean;
}

/** The dry run of an import: what comes in, what is refused and how identities could be mapped. */
export interface MigrationPlan {
  /** Staged upload (web UI); the CLI has none */
  id?: string;
  packageId: string;
  packageSha256: string;
  sizeBytes: number;
  source: { fingerprint: string; version: string; exportedAt: string; exportedBy: string; database: 'sqlite' | 'postgres' };
  schema: { core: number; named: number; migrationsToApply: number };
  counts: { table: string; rows: number }[];
  files: { count: number; bytes: number };
  history: { entries: number; ok: boolean; message: string; checkpointSeq: number };
  users: MigrationPlanUser[];
  teams: MigrationPlanTeam[];
  targetUsers: { username: string; displayName: string; email: string | null; roles: string[]; active: boolean; sso: boolean }[];
  targetTeams: string[];
  /** Automation that is imported paused (schedules, triggers, monitors, …) with counts */
  paused: { label: string; count: number }[];
  settings: { applied: string[]; notApplied: string[] };
  notMoved: { what: string; why: string }[];
  /** Reasons the import cannot run (target not empty, newer package, …) */
  blocking: string[];
  warnings: string[];
  /** Enabled single sign-on providers here (a new single sign-on account is bound to one of them) */
  providers: { id: string; displayName: string }[];
  /** Password sign-in on this instance (create-local is not offered with 'none') */
  passwordLogin: 'all' | 'adminsOnly' | 'none';
}

export interface MigrationMappingRow {
  kind: 'user' | 'team';
  source: string;
  /** e.g. "local", "sso (Entra ID)" for users */
  sourceKind: string;
  action: UserAction | TeamDecision['action'];
  target: string | null;
  targetId: string | null;
}

export interface InstanceImport {
  id: string;
  packageId: string;
  packageSha256: string;
  importedAt: string;
  importedBy: string;
  source: { fingerprint: string; version: string; exportedAt: string; exportedBy: string };
  mapping: MigrationMappingRow[];
  mappingSha256: string;
  counts: Record<string, number>;
  historyEntries: number;
}

export interface ImportResult {
  importId: string;
  counts: Record<string, number>;
  files: number;
  historyEntries: number;
  /** One-time passwords of new local accounts – shown once */
  temporaryPasswords: { username: string; password: string }[];
  paused: { label: string; count: number }[];
}

export interface ImportedHistoryEntry {
  seq: number;
  ts: string;
  actor: string;
  /** The account the actor is on this instance, from the mapping ("arvid" → "arvid@corp.example") */
  actorNow: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string;
}
