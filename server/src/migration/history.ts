import { z } from 'zod';
import type { AuditCheckpoint, AuditEntry } from '@sm/shared';
import { db } from '../db.js';
import { DIGEST_SEED, GENESIS, authenticRows, checkpointPayload, digestStep, setVerifiedImports, toEntry, type AuditRow } from '../audit.js';
import { publicKeyFingerprint, verifySignature } from '../vault.js';
import { parseJson, sha256 } from '../util.js';

/** One entry of a source's audit log, as a package carries it (bounded: a crafted package cannot hand over huge values). */
const entrySchema = z.object({
  seq: z.number().int().min(1),
  ts: z.string().max(64),
  actor: z.string().max(10_000),
  action: z.string().max(1000),
  entityType: z.string().max(1000),
  entityId: z.string().max(10_000).nullable().optional(),
  runId: z.string().max(10_000).nullable().optional(),
  summary: z.string().max(1_000_000),
  details: z.unknown().optional(),
  prevHash: z.string().max(200),
  hash: z.string().max(200),
});

/**
 * Checks an audit history entry by entry against one signed checkpoint – the chain from #1 (prevHash links), the public
 * digest up to the checkpoint and its Ed25519 signature – without holding the history in memory. Same rules as
 * `steward audit verify-export` with one checkpoint, and the history must end exactly at it.
 */
export class HistoryVerifier {
  private digest = DIGEST_SEED;
  private prev: { seq: number; hash: string } | null = null;
  private problem: string | null = null;
  private reached = false;
  count = 0;

  constructor(
    private readonly cp: AuditCheckpoint,
    publicKey: string,
  ) {
    const { signature, ...body } = cp;
    let fingerprint: string | null = null;
    try {
      fingerprint = publicKeyFingerprint(publicKey.includes('BEGIN') ? publicKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '') : publicKey);
    } catch {
      this.problem = 'The public key cannot be read';
    }
    if (this.problem) return;
    if (!signature || !verifySignature(publicKey, checkpointPayload(body), signature))
      this.problem = `checkpoint #${cp.seq}: the signature is invalid for this public key`;
    else if (fingerprint && cp.keyFingerprint && cp.keyFingerprint !== fingerprint)
      this.problem = `checkpoint #${cp.seq} names key ${cp.keyFingerprint}, the public key is ${fingerprint}`;
    else if (cp.count !== cp.seq) this.problem = `checkpoint #${cp.seq} counts ${cp.count} entries`;
  }

  /** Parses and checks one line of audit.jsonl; returns the entry (null once the history failed). */
  addLine(line: string): AuditEntry | null {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      raw = null;
    }
    const e = entrySchema.safeParse(raw);
    if (!e.success) {
      this.fail(`Entry ${this.count + 1} of the history is not a valid audit entry`);
      return null;
    }
    return this.add(e.data as AuditEntry);
  }

  add(e: AuditEntry): AuditEntry | null {
    this.count++;
    if (this.problem) return null;
    const expected = (this.prev?.seq ?? 0) + 1;
    if (e.seq !== expected) return this.fail(expected === 1 ? `The history starts at entry #${e.seq}, not #1` : `Entry #${expected} is missing`);
    if (e.prevHash !== (this.prev?.hash ?? GENESIS)) return this.fail(`Entry #${e.seq} does not link to entry #${e.seq - 1} (prevHash differs)`);
    if (e.seq > this.cp.seq) return this.fail(`Entry #${e.seq} comes after the signed checkpoint #${this.cp.seq}`);
    this.digest = digestStep(this.digest, e);
    if (e.seq === this.cp.seq) {
      if (e.hash !== this.cp.hash) return this.fail(`entry #${this.cp.seq} differs from the checkpoint (hash)`);
      if (this.digest !== this.cp.digest) return this.fail(`entries 1–${this.cp.seq} differ from what the checkpoint covers (digest)`);
      this.reached = true;
    }
    this.prev = { seq: e.seq, hash: e.hash };
    return e;
  }

  private fail(message: string): null {
    this.problem ??= message;
    return null;
  }

  /** `expected`: the number of entries the history must have (the manifest's, or the import record's). */
  result(expected: number): { ok: boolean; message: string; entries: number } {
    const problem =
      this.problem ??
      (!this.reached
        ? `entry #${this.cp.seq} is not in the history – entries were removed (it ends at #${this.prev?.seq ?? 0})`
        : this.count !== expected
          ? `${this.count} of ${expected} entries are there`
          : null);
    return problem
      ? { ok: false, message: problem, entries: this.count }
      : { ok: true, message: `entries 1–${this.cp.seq} match the signed checkpoint of ${this.cp.ts}`, entries: this.count };
  }
}

export interface ImportedHistoryCheck {
  ok: boolean;
  entries: number;
  /** The source's audit entries still match the source's signed checkpoint (public key in the import record) */
  history: { ok: boolean; message: string };
  /** This instance's own (HMAC-chained) `instance.imported` entry names the same package and mapping */
  record: { ok: boolean; message: string };
}

const PAGE = 5000;

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
  const cp = parseJson<AuditCheckpoint | null>(imp.history_checkpoint, null);
  let checked = 0;
  let history: { ok: boolean; message: string };
  if (!cp) history = { ok: false, message: 'No checkpoint' };
  else {
    // page by page: a large history is never held in memory as a whole
    const v = new HistoryVerifier(cp, imp.source_public_key);
    for (let after = 0; ;) {
      const rows = db().all<AuditRow & { import_id: string }>(
        'SELECT * FROM imported_audit_log WHERE import_id = ? AND seq > ? ORDER BY seq LIMIT ?',
        importId,
        after,
        PAGE,
      );
      for (const r of rows) v.add(toEntry(r));
      if (rows.length < PAGE) break;
      after = Number(rows.at(-1)!.seq);
    }
    const r = v.result(Number(imp.history_entries));
    checked = r.entries;
    history = { ok: r.ok, message: r.ok ? `All ${r.entries} imported entries match the source's signed checkpoint` : r.message };
  }
  // the import record is bound to this instance's own audit chain
  const { rows } = authenticRows("action = 'instance.imported' AND entity_id = ?", [importId], { limit: 5, ownOnly: true });
  const d = rows[0] ? parseJson<{ packageSha256?: string; mappingSha256?: string }>(rows[0].details, {}) : null;
  const mappingOk = sha256(imp.mapping) === imp.mapping_sha256;
  const record = !d
    ? { ok: false, message: 'There is no authentic instance.imported entry for this import in the audit log' }
    : d.packageSha256 !== imp.package_sha256 || d.mappingSha256 !== imp.mapping_sha256 || !mappingOk
      ? { ok: false, message: 'The import record differs from its audit entry (package or mapping changed)' }
      : { ok: true, message: `Package and mapping match audit entry #${rows[0]!.seq}` };
  return { ok: history.ok && record.ok, entries: checked, history, record };
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
