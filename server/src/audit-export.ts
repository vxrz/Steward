import { BRAND, type AuditCheckpoint, type AuditEntry } from '@sm/shared';
import { config } from './config.js';
import { publicKeyFingerprint, publicKeyPem, vault } from './vault.js';
import { nowIso } from './util.js';
import { csvTable } from './csv.js';

export { csvCell } from './csv.js';

/** The audit log as CSV (every cell quoted; see csv.ts). */
export function auditCsv(entries: AuditEntry[]): string {
  const head = ['seq', 'ts', 'actor', 'action', 'entityType', 'entityId', 'runId', 'summary', 'details', 'prevHash', 'hash'];
  return csvTable(
    head,
    entries.map((a) => [a.seq, a.ts, a.actor, a.action, a.entityType, a.entityId, a.runId, a.summary, a.details ?? null, a.prevHash, a.hash]),
  );
}

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
  entries: AuditEntry[];
}

/** The JSON export: entries with prevHash and details plus the latest signed checkpoint (offline check: npm run audit:verify-export). */
export function auditExportBundle(entries: AuditEntry[], checkpoint: AuditCheckpoint | null): AuditExportBundle {
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
    entries,
  };
}
