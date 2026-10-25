import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Answers that rest on audit history imported from another instance (docs/MIGRATION.md) say so: they name the import
 * and the fingerprint of the source's key, so nobody takes them for this instance's own evidence.
 */
let s: TestServer;
const IMPORT = 'imp_labels';
const FP = '1a2b:3c4d:5e6f:7a8b:9c0d:1e2f:3a4b:5c6d';

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const { db } = await import('../src/db.js');
  const now = new Date().toISOString();
  db().run(
    `INSERT INTO instance_imports (id, package_id, package_sha256, imported_at, imported_by, source_fingerprint, source_public_key, source_version,
       source_exported_at, source_exported_by, manifest, mapping, mapping_sha256, counts, history_checkpoint, history_entries)
     VALUES (?, 'pkg_labels', 'x', ?, 'admin', ?, 'x', '0.1.0', ?, 'admin', '{}', '[]', 'x', '{}', '{}', 2)`,
    IMPORT,
    now,
    FP,
    now,
  );
  const add = (seq: number, action: string, entityType: string, entityId: string | null, runId: string | null, details: unknown) =>
    db().run(
      `INSERT INTO imported_audit_log (import_id, seq, ts, actor, action, entity_type, entity_id, run_id, summary, details, prev_hash, hash)
       VALUES (?, ?, ?, 'dana', ?, ?, ?, ?, 'imported', ?, 'p', 'h')`,
      IMPORT,
      seq,
      now,
      action,
      entityType,
      entityId,
      runId,
      JSON.stringify(details),
    );
  const { sha256 } = await import('../src/util.js');
  add(1, 'report.generated', 'report', 'rep_moved', null, { sha256: sha256(Buffer.from('%PDF-1.7 moved report')), size: 21, kind: 'run' });
  add(2, 'run.succeeded', 'run', 'run_moved', 'run_moved', { protocolHash: 'abc' });
  // as if the imported history verified (migration/history.ts registers the real check)
  const { setVerifiedImports } = await import('../src/audit.js');
  setVerifiedImports(() => [IMPORT]);
});
afterAll(async () => {
  await s?.app.close();
});

describe('answers that rest on imported history', () => {
  it('report verification names the imported history', async () => {
    const reports = await import('../src/reports/service.js');
    const data = Buffer.from('%PDF-1.7 moved report');
    const v = reports.verificationOf(data, reports.findGenerated(data));
    expect(v.match).toBe('exact');
    expect(v.importedHistory).toEqual({ importId: IMPORT, sourceFingerprint: FP });
  });

  it('a protocol seal names the imported history, an own one does not', async () => {
    const { sealedProtocol, audit } = await import('../src/audit.js');
    expect(sealedProtocol('run_moved')).toEqual({ hash: 'abc', importedHistory: { importId: IMPORT, sourceFingerprint: FP } });
    audit({ action: 'run.succeeded', entityType: 'run', entityId: 'run_own', runId: 'run_own', summary: 'done', details: { protocolHash: 'def' } });
    expect(sealedProtocol('run_own')).toEqual({ hash: 'def' });
  });

  it('an own report verification has no such label', async () => {
    const reports = await import('../src/reports/service.js');
    const { audit } = await import('../src/audit.js');
    const { sha256 } = await import('../src/util.js');
    const data = Buffer.from('%PDF-1.7 own report');
    audit({ action: 'report.generated', entityType: 'report', entityId: 'rep_own', summary: 'own', details: { sha256: sha256(data), size: data.length } });
    const v = reports.verificationOf(data, reports.findGenerated(data));
    expect(v.match).toBe('exact');
    expect(v.importedHistory).toBeUndefined();
  });
});
