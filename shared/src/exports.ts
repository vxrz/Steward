import type { ModuleId } from './modules.js';

/**
 * Scheduled exports to S3 (0.16.0, docs/EXPORTS.md, ADR 0027): readable files of chosen parts of Steward's data –
 * cost plans, the plant registry, the catalogue, monitors, the audit log – on a schedule, into a folder of an S3
 * bucket. For sharing and archiving outside Steward, not for a restore (that is what backups are for).
 */

/** The parts that can be exported (server/src/export/parts.ts has what each one writes). */
export const EXPORT_PART_IDS = ['costPlans', 'plant', 'services', 'applications', 'systems', 'monitors', 'auditLog'] as const;
export type ExportPartId = (typeof EXPORT_PART_IDS)[number];
export const isExportPartId = (x: unknown): x is ExportPartId => typeof x === 'string' && (EXPORT_PART_IDS as readonly string[]).includes(x);

export const EXPORT_FORMATS = ['csv', 'yaml', 'json', 'jsonl'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Which fiscal year the cost plans are exported for, counted from the day of the run. */
export const EXPORT_FISCAL_YEARS = ['current', 'previous', 'next'] as const;
export type ExportFiscalYear = (typeof EXPORT_FISCAL_YEARS)[number];

export const EXPORT_LIMITS = {
  jobs: 50,
  nameMax: 60,
  keepRunsMax: 100,
  auditDaysMax: 366,
  /** Entries of the audit log in one export at most: the newest of the period (the manifest says when it was cut) */
  auditEntries: 200_000,
  /** Run rows kept per export (older ones are removed from the history; their files went with the retention rule) */
  historyRuns: 200,
} as const;

/** One part of an export with its format and options. */
export interface ExportPartChoice {
  id: ExportPartId;
  format: ExportFormat;
  /** costPlans: the fiscal year (default current) */
  fiscalYear?: ExportFiscalYear;
  /** auditLog: the entries of the last so many days (default 7) */
  days?: number;
}

/** What an administrator sets: POST and PUT /api/exports. */
export interface ExportJobInput {
  /** Also the folder in the bucket: letters, digits, . _ - */
  name: string;
  /** Runs on its schedule (Run now works either way) */
  enabled: boolean;
  /** An S3 platform (AWS SigV4, service s3) – the backup's or another one */
  platformId: string | null;
  /** Folder in the bucket, e.g. "exports/" */
  prefix: string;
  cron: string;
  timezone: string;
  parts: ExportPartChoice[];
  /** Encrypt every file with the backup key (readable with `steward backup decrypt`); default off: readable files */
  encrypt: boolean;
  /** Runs whose files stay in the bucket (the newest successful ones) */
  keepRuns: number;
}

export const DEFAULT_EXPORT_JOB: ExportJobInput = {
  name: '',
  enabled: true,
  platformId: null,
  prefix: 'exports/',
  cron: '30 3 * * 1',
  timezone: 'UTC',
  parts: [],
  encrypt: false,
  keepRuns: 10,
};

export type ExportRunStatus = 'running' | 'succeeded' | 'failed';

export interface ExportFileInfo {
  /** The part that wrote it (manifest: "manifest") */
  part: ExportPartId | 'manifest';
  /** File name in the run's folder (encrypted: with .smbackup) */
  name: string;
  /** The object in the bucket */
  key: string;
  bytes: number;
  /** SHA-256 of the content as written (before encryption) */
  sha256: string;
}

export interface ExportRun {
  id: string;
  jobId: string;
  status: ExportRunStatus;
  trigger: 'schedule' | 'manual';
  triggeredBy: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** The run's folder in the bucket: <prefix><name>/<UTC time>/ */
  folder: string | null;
  files: ExportFileInfo[];
  bytes: number | null;
  /** Why it failed (never a secret) */
  message: string | null;
  /** The files were removed from the bucket by the retention rule */
  pruned: boolean;
}

export interface ExportJob extends ExportJobInput {
  id: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  nextRunAt: string | null;
  running: boolean;
  lastRun: ExportRun | null;
  /**
   * The S3 target is not the one an administrator confirmed: the platform's address, region, connection or access key
   * (or the export's folder) changed since. Runs fail with EXPORT_TARGET_CHANGED until it is confirmed again
   * (POST /api/exports/:id/confirm-target, step-up).
   */
  targetChanged: boolean;
}

/** A part as the export page offers it. */
export interface ExportPartInfo {
  id: ExportPartId;
  formats: ExportFormat[];
  /** The module it belongs to: not exported while that module is switched off */
  module: ModuleId | null;
  available: boolean;
  options: ('fiscalYear' | 'days')[];
}

/** GET /api/exports */
export interface ExportsStatus {
  jobs: ExportJob[];
  parts: ExportPartInfo[];
  /** The backup passphrase is set: exports can be encrypted with the backup key */
  encryptionAvailable: boolean;
  /** The backup's S3 platform (suggested as the target) */
  backupPlatformId: string | null;
}
