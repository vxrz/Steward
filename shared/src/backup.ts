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
}

export const DEFAULT_BACKUP_SETTINGS: BackupSettings = {
  enabled: false,
  platformId: null,
  prefix: 'steward/',
  cron: '15 2 * * *',
  timezone: 'UTC',
  retention: { daily: 7, weekly: 4, monthly: 12 },
  restoreTest: { enabled: true, cron: '45 3 * * 0' },
};

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
