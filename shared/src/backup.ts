/** Backups to S3 (#117): settings, status and runs as the API returns them. */

export interface BackupRetention {
  daily: number;
  weekly: number;
  monthly: number;
}

export interface BackupSettings {
  /** Back up on the schedule (a backup can always be started by hand once storage and key are set) */
  enabled: boolean;
  /** The S3 platform (auth type aws_sigv4, service s3) whose base URL is the bucket */
  platformId: string | null;
  /** Folder in the bucket, e.g. "steward/" (letters, digits, . _ - /) */
  prefix: string;
  /** Five-field cron expression, default 02:15 every day */
  cron: string;
  timezone: string;
  retention: BackupRetention;
  /** Weekly test: download the newest backup, decrypt it and check it completely */
  restoreTest: { enabled: boolean; cron: string };
  /**
   * Parts of the data folder an administrator left out of the backups (0.16.0, docs/BACKUPS.md#contents). Empty: all,
   * as before. Only BACKUP_OPTIONAL_PARTS can be left out – the database, vault.json, audit-anchor.json and the
   * manifest never.
   */
  exclude: BackupOptionalPart[];
}

export const DEFAULT_BACKUP_SETTINGS: BackupSettings = {
  enabled: false,
  platformId: null,
  prefix: 'steward/',
  cron: '15 2 * * *',
  timezone: 'UTC',
  retention: { daily: 7, weekly: 4, monthly: 12 },
  restoreTest: { enabled: true, cron: '45 3 * * 0' },
  exclude: [],
};

// ---------- contents (0.16.0) ----------

/**
 * What a backup holds, part by part. `required` parts are always in it – a restore needs them. The optional parts are
 * bulky folders of the data folder; each of them is evidence or the original of something, so all are included by
 * default and leaving one out is shown with what a restore then lacks.
 */
export const BACKUP_PARTS = [
  'database',
  'vault',
  'auditAnchor',
  'auditArchives',
  'records',
  'documents',
  'branding',
  'artifacts',
  'reports',
  'evidencePacks',
  'other',
] as const;
export type BackupPart = (typeof BACKUP_PARTS)[number];

/** The parts an administrator may leave out. */
export const BACKUP_OPTIONAL_PARTS = ['artifacts', 'reports', 'evidencePacks'] as const;
export type BackupOptionalPart = (typeof BACKUP_OPTIONAL_PARTS)[number];
export const isBackupOptionalPart = (x: unknown): x is BackupOptionalPart => typeof x === 'string' && (BACKUP_OPTIONAL_PARTS as readonly string[]).includes(x);

/** Where a part lives in the data folder (null: the database snapshot; "other": everything not named here). */
export const BACKUP_PART_PATHS: Record<BackupPart, string | null> = {
  database: null,
  vault: 'vault.json',
  auditAnchor: 'audit-anchor.json',
  auditArchives: 'audit-archives/',
  records: 'records/',
  documents: 'docs/',
  branding: 'branding/',
  artifacts: 'artifacts/',
  reports: 'reports/',
  evidencePacks: 'evidence-packs/',
  other: null,
};

/**
 * Whether Steward can make a part again after a restore without it: never (the original is gone), as a new version
 * (reports: generated again from the runs, with another SHA-256) or by building it again (evidence packs).
 */
export const BACKUP_PART_REGENERABLE: Record<BackupOptionalPart, 'no' | 'newVersion' | 'rebuild'> = {
  artifacts: 'no',
  reports: 'newVersion',
  evidencePacks: 'rebuild',
};

export interface BackupContentPart {
  id: BackupPart;
  path: string | null;
  required: boolean;
  /** Left out by the current settings */
  excluded: boolean;
  files: number;
  bytes: number;
}

/** GET /api/backups/contents: the parts with their current size (the data folder is walked once per call). */
export interface BackupContents {
  parts: BackupContentPart[];
}

/** What a backup left out (manifest.json "excluded", and the restore test's step "contents"). */
export interface BackupExcludedPart {
  part: BackupOptionalPart;
  path: string;
  files: number;
  bytes: number;
}

export type BackupRunKind = 'backup' | 'restore_test';
export type BackupRunStatus = 'running' | 'succeeded' | 'failed';

export interface BackupStep {
  name: string;
  ok: boolean;
  message: string;
}

export interface BackupRun {
  id: string;
  kind: BackupRunKind;
  status: BackupRunStatus;
  trigger: 'schedule' | 'manual';
  triggeredBy: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** The object in the bucket */
  objectKey: string | null;
  /** Size of the encrypted file */
  bytes: number | null;
  /** SHA-256 of the encrypted file */
  sha256: string | null;
  message: string | null;
  steps: BackupStep[];
  /** Backups removed by the retention rule after this backup */
  deleted: number;
}

export interface StoredBackup {
  key: string;
  size: number;
  createdAt: string;
  /** Why the retention rule keeps it (daily, weekly, monthly, newest); empty: removed by the next backup */
  keptAs: string[];
}

export interface BackupStatus {
  settings: BackupSettings;
  /** The backup key (from the backup passphrase); the passphrase itself is never stored */
  key: { keyId: string; setAt: string; setBy: string } | null;
  running: BackupRunKind | null;
  lastBackup: BackupRun | null;
  lastSuccess: BackupRun | null;
  lastRestoreTest: BackupRun | null;
  nextBackupAt: string | null;
  nextRestoreTestAt: string | null;
  runs: BackupRun[];
  database: 'sqlite' | 'postgres';
}
