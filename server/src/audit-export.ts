import { BRAND, type AuditCheckpoint, type AuditEntry } from '@sm/shared';
import { config } from './config.js';
import { publicKeyFingerprint, publicKeyPem, vault } from './vault.js';
import { nowIso } from './util.js';
import { csvCell } from './csv.js';

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
/** The header line of the audit log as CSV – the file is written in pages (the export route, scheduled exports). */
export const auditCsvHead = (): string => AUDIT_CSV_HEAD.join(',') + '\r\n';
/** One line of the audit log as CSV. */
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
/**
 * The bundle (format json) as text in pieces: everything but the entries, then the entries as they come – the
 * interactive export streams them page by page instead of holding the chain in memory (security review 0.19.0 M2).
 */
export async function* auditExportBundleText(
  pages: AsyncIterable<AuditEntry[]>,
  checkpoint: AuditCheckpoint | null,
  startCheckpoint: AuditCheckpoint | null = null,
): AsyncGenerator<string> {
  const head = JSON.stringify(auditExportBundle([], checkpoint, startCheckpoint), null, 1);
  // the head ends with `"entries": []\n}`: open the list instead
  yield head.slice(0, head.lastIndexOf('[')) + '[';
  let first = true;
  for await (const page of pages) {
    if (!page.length) continue;
    yield (first ? '\n' : ',\n') + page.map((e) => JSON.stringify(e)).join(',\n');
    first = false;
  }
  yield '\n]\n}';
}

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
