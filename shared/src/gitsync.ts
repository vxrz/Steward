/**
 * Git sync: pull processes, dashboards, monitors and record types from a Git repository
 * (Forgejo/Gitea, GitHub, GitLab) and stage every change as a pending update for review.
 * Pull-only: nothing is ever written to the repository, and nothing is applied without a decision.
 */

export const GIT_PROVIDERS = ['forgejo', 'github', 'gitlab'] as const;
export type GitProvider = (typeof GIT_PROVIDERS)[number];

/** What a source may bring in. */
export const SYNC_KINDS = ['process', 'dashboard', 'monitor', 'recordType'] as const;
export type SyncKind = (typeof SYNC_KINDS)[number];

export const SYNC_UPDATE_STATUSES = ['pending', 'accepted', 'rejected', 'superseded', 'invalid'] as const;
export type SyncUpdateStatus = (typeof SYNC_UPDATE_STATUSES)[number];

/** Limits of one fetch (files in the configured folder). */
export const SYNC_LIMITS = {
  /** Definition files (.yaml/.yml/.json) in the folder */
  maxFiles: 200,
  /** One file */
  maxFileBytes: 256 * 1024,
  /** All definition files together */
  maxTotalBytes: 4 * 1024 * 1024,
  /** New commits whose signatures one fetch checks (require signed commits); more fail the fetch */
  maxCheckedCommits: 250,
  /** Entries of a source's allowed-signer list */
  maxAllowedSigners: 50,
} as const;

/** Days after which superseded updates are deleted and the content of rejected updates is removed. */
export const SYNC_RETENTION_DAYS = 30;

/** Inbound webhook bodies (push events) are small; larger ones are refused. */
export const SYNC_WEBHOOK_MAX_BODY_BYTES = 512 * 1024;

export interface SyncSourceSettings {
  name: string;
  provider: GitProvider;
  /** Web URL of the repository, e.g. https://git.example.com/team/steward-library */
  repoUrl: string;
  /** API base URL; empty = derived from the repository URL (github.com → api.github.com, Forgejo → /api/v1, GitLab → /api/v4) */
  apiUrl?: string;
  branch: string;
  /** Folder inside the repository; only files below it are read ('' = whole repository) */
  folder: string;
  kinds: SyncKind[];
  /** Minutes between scheduled fetches; 0 = no schedule (manual and webhook only) */
  intervalMinutes: number;
  webhookEnabled: boolean;
  /**
   * Fetches fail unless every new commit since the last fetched commit (the first fetch: the head
   * commit) carries a signature the Git host verified
   */
  requireSignedCommits: boolean;
  /**
   * With requireSignedCommits: only commits signed by these accounts are accepted – Git host logins
   * or e-mail addresses, lower case. Empty = any verified signature.
   */
  allowedSigners: string[];
  /** New items (not yet in Steward) are created right away – monitors disabled; changes to existing items still need a review */
  autoAcceptNew: boolean;
  enabled: boolean;
}

export interface SyncSource extends SyncSourceSettings {
  id: string;
  hasToken: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Path of the inbound webhook (POST, signed with the webhook secret) */
  webhookPath: string;
  webhookSecretPrefix: string | null;
  lastFetchAt: string | null;
  lastCommit: string | null;
  lastStatus: 'ok' | 'error' | null;
  lastError: string | null;
  lastVerified: boolean | null;
  pendingCount: number;
}

/** Returned once on creation / webhook secret rotation. */
export interface SyncSourceSecret {
  source: SyncSource;
  webhookSecret?: string;
}

export interface SyncFetchResult {
  sourceId: string;
  commit: string | null;
  verified: boolean | null;
  /** Nothing new on the branch since the last fetch */
  upToDate: boolean;
  files: number;
  staged: number;
  unchanged: number;
  invalid: number;
  autoAccepted: number;
  error?: string;
}

export interface SyncOrigin {
  kind: SyncKind;
  entityId: string;
  sourceId: string;
  sourceName: string;
  repoUrl: string;
  path: string;
  commit: string;
  /** Link to the file at that commit on the Git host */
  webUrl: string;
  appliedAt: string;
  appliedBy: string;
}

export interface SyncUpdate {
  id: string;
  sourceId: string;
  sourceName: string;
  kind: SyncKind | null;
  path: string;
  commit: string;
  commitVerified: boolean | null;
  webUrl: string;
  /** The Steward item this file maps to (id, key) */
  entityId: string | null;
  entityName: string | null;
  action: 'create' | 'update';
  /** The local item was changed since it was last synced (or never came from Git) */
  conflict: boolean;
  conflictReason: 'notFromGit' | 'changedLocally' | null;
  status: SyncUpdateStatus;
  errors: string[];
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  comment: string | null;
  /** Process version / monitor version created by the acceptance */
  resultVersion: number | null;
  canDecide: boolean;
  /** The file's content was removed by the retention (rejected updates after SYNC_RETENTION_DAYS) */
  contentRemoved: boolean;
}

export interface SyncUpdateDetail extends SyncUpdate {
  /** Incoming definition as YAML (normalised) */
  incomingText: string;
  /** Current local definition as YAML (normalised), null for new items */
  currentText: string | null;
  /** Processes: both definitions for the node-level change summary */
  incomingDefinition?: unknown;
  currentDefinition?: unknown;
}
