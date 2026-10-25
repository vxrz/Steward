import type { AuditCheckpoint, AuditEntry } from '@sm/shared';
import { db } from '../db.js';
import { authenticRows, setVerifiedImports, toEntry, type AuditRow } from '../audit.js';
import { verifyExport } from '../cli/audit-verify-export.js';
import { parseJson, sha256 } from '../util.js';

export interface ImportedHistoryCheck {
  ok: boolean;
  entries: number;
  /** The source's audit entries still match the source's signed checkpoint (public key in the import record) */
  history: { ok: boolean; message: string };
  /** This instance's own (HMAC-chained) `instance.imported` entry names the same package and mapping */
  record: { ok: boolean; message: string };
}

/**
 * Verifies an import again: the imported audit history (unchanged entries, linked by their hashes, covered by
 * the source's Ed25519-signed checkpoint) and the import record (package hash and mapping table) against the
 * authentic `instance.imported` entry in this instance's audit chain.
 */
export function verifyImportedHistory(importId: string): ImportedHistoryCheck {
  const imp = db().get<{
    package_sha256: string;
    source_public_key: string;
    history_checkpoint: string;
    history_entries: number;
    mapping: string;
    mapping_sha256: string;
  }>('SELECT * FROM instance_imports WHERE id = ?', importId);
  if (!imp) return { ok: false, entries: 0, history: { ok: false, message: 'Import not found' }, record: { ok: false, message: 'Import not found' } };
  const entries: AuditEntry[] = db()
    .all<AuditRow & { import_id: string }>('SELECT * FROM imported_audit_log WHERE import_id = ? ORDER BY seq', importId)
    .map((r) => toEntry(r));
  const cp = parseJson<AuditCheckpoint | null>(imp.history_checkpoint, null);
  const v = cp
    ? verifyExport({ entries, checkpoints: [{ source: 'checkpoint of the export', cp }], publicKey: imp.source_public_key, keySource: 'export' })
    : null;
  const historyOk = !!v && v.ok && v.uncovered === 0 && entries.length === Number(imp.history_entries);
  const history = {
    ok: historyOk,
    message: historyOk
      ? `All ${entries.length} imported entries match the source's signed checkpoint`
      : (v?.problems[0] ??
        (entries.length !== Number(imp.history_entries) ? `${entries.length} of ${imp.history_entries} entries are there` : 'No checkpoint')),
  };
  // the import record is bound to this instance's own audit chain
  const { rows } = authenticRows("action = 'instance.imported' AND entity_id = ?", [importId], { limit: 5, ownOnly: true });
  const d = rows[0] ? parseJson<{ packageSha256?: string; mappingSha256?: string }>(rows[0].details, {}) : null;
  const mappingOk = sha256(imp.mapping) === imp.mapping_sha256;
  const record = !d
    ? { ok: false, message: 'There is no authentic instance.imported entry for this import in the audit log' }
    : d.packageSha256 !== imp.package_sha256 || d.mappingSha256 !== imp.mapping_sha256 || !mappingOk
      ? { ok: false, message: 'The import record differs from its audit entry (package or mapping changed)' }
      : { ok: true, message: `Package and mapping match audit entry #${rows[0]!.seq}` };
  return { ok: history.ok && record.ok, entries: entries.length, history, record };
}

/** Verified imports, re-checked at most every 10 minutes (the imported history is append-only, see the migration). */
const CHECK_MS = 10 * 60_000;
let verified: { at: number; ids: string[] } | null = null;
export function invalidateVerifiedImports(): void {
  verified = null;
}
setVerifiedImports(() => {
  if (verified && Date.now() - verified.at < CHECK_MS) return verified.ids;
  let ids: string[];
  try {
    ids = db()
      .all<{ id: string }>('SELECT id FROM instance_imports ORDER BY imported_at')
      .map((r) => r.id)
      .filter((id) => verifyImportedHistory(id).ok);
  } catch {
    ids = []; // before the migration that creates the tables
  }
  verified = { at: Date.now(), ids };
  return ids;
});
