import { BRAND, type AuditCheckpoint, type AuditEntry } from '@sm/shared';
import { config } from './config.js';
import { publicKeyFingerprint, publicKeyPem, vault } from './vault.js';
import { nowIso } from './util.js';

/**
 * A CSV cell. Cells that a spreadsheet would read as a formula (= + - @, tab, carriage return)
 * get a leading apostrophe (OWASP "CSV injection"); the user name of a failed sign-in, for
 * example, is chosen by whoever tries to sign in.
 */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function auditCsv(entries: AuditEntry[]): string {
  const head = ['seq', 'ts', 'actor', 'action', 'entityType', 'entityId', 'runId', 'summary', 'details', 'prevHash', 'hash'];
  const lines = [head.join(',')].concat(
    entries.map((a) => [a.seq, a.ts, a.actor, a.action, a.entityType, a.entityId, a.runId, a.summary, a.details ?? null, a.prevHash, a.hash].map(csvCell).join(',')),
  );
  return lines.join('\r\n') + '\r\n';
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
