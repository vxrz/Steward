import { BRAND, type AuditCheckpoint, type AuditEntry } from '@sm/shared';
import { config } from './config.js';
import { publicKeyFingerprint, publicKeyPem, vault } from './vault.js';
import { nowIso } from './util.js';
import { csvCell, csvTable } from './csv.js';

export { csvCell } from './csv.js';

const AUDIT_CSV_HEAD = ['seq', 'ts', 'actor', 'action', 'entityType', 'entityId', 'runId', 'summary', 'details', 'prevHash', 'hash'] as const;
const auditCells = (a: AuditEntry): unknown[] => [
  a.seq,
  a.ts,
  a.actor,
  a.action,
  a.entityType,
  a.entityId,
  a.runId,
  a.summary,
  a.details ?? null,
  a.prevHash,
  a.hash,
];

/** The audit log as CSV (every cell quoted; see csv.ts). */
export function auditCsv(entries: AuditEntry[]): string {
  return csvTable(AUDIT_CSV_HEAD, entries.map(auditCells));
}

/** The header line of auditCsv – for a file written in pages (scheduled exports). */
export const auditCsvHead = (): string => AUDIT_CSV_HEAD.join(',') + '\r\n';
/** One line of auditCsv. */
export const auditCsvLine = (a: AuditEntry): string =>
  auditCells(a)
    .map((v) => csvCell(v))
    .join(',') + '\r\n';

export const EXPORT_FORMAT = 'steward-audit-export';

export interface AuditExportBundle {
  format: typeof EXPORT_FORMAT;
  version: 1;
  product: string;
  productVersion: string;
  exportedAt: string;
  /** Ed25519 public key of the installation (PEM) – compare its fingerprint with one you trust */
  publicKeyPem: string | null;
  fingerprint: string | null;
  /** Signed checkpoint covering entries 1..checkpoint.seq (entries after it are not covered yet) */
  checkpoint: AuditCheckpoint | null;
  /**
   * After archived entries were deleted (retention): the signed checkpoint the entries continue – the first entry
   * links to its hash and the digest continues from its digest. The entries before it are in the audit archives.
   */
  startCheckpoint?: AuditCheckpoint;
  entries: AuditEntry[];
}

/** The JSON export: entries with prevHash and details plus the latest signed checkpoint (offline check: npm run audit:verify-export). */
export function auditExportBundle(
  entries: AuditEntry[],
  checkpoint: AuditCheckpoint | null,
  startCheckpoint: AuditCheckpoint | null = null,
): AuditExportBundle {
  const pub = vault().signingPublicKey();
  return {
    format: EXPORT_FORMAT,
    version: 1,
    product: BRAND.name,
    productVersion: config.version,
    exportedAt: nowIso(),
    publicKeyPem: pub ? publicKeyPem(pub) : null,
    fingerprint: pub ? publicKeyFingerprint(pub) : null,
    checkpoint,
    ...(startCheckpoint ? { startCheckpoint } : {}),
    entries,
  };
}
