import crypto from 'node:crypto';
import type { AuditEntry, AuditVerifyResult } from '@sm/shared';
import { db } from './db.js';
import { vault } from './vault.js';
import { canonicalJson, nowIso, parseJson } from './util.js';
import { currentActor } from './auth/context.js';

/**
 * Append-only, hash-chained audit log. Every entry is signed with an HMAC
 * derived from the master key and chained to its predecessor, so edits,
 * deletions and re-ordering are detected by verify().
 */
export interface AuditInput {
  actor?: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  runId?: string | null;
  summary: string;
  details?: unknown;
}

const GENESIS = 'GENESIS';

function computeHash(key: Buffer, prevHash: string, e: Omit<AuditEntry, 'hash'>): string {
  const payload = canonicalJson({
    seq: e.seq,
    ts: e.ts,
    actor: e.actor,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId ?? null,
    runId: e.runId ?? null,
    summary: e.summary,
    details: e.details ?? null,
  });
  return crypto.createHmac('sha256', key).update(prevHash + '\n' + payload).digest('hex');
}

/** Entries recorded while the vault is locked (e.g. sign-ins) are signed and written on unlock. */
const pending: (AuditInput & { ts: string; actor: string })[] = [];

export function audit(input: AuditInput): AuditEntry {
  if (!vault().unlocked) {
    const e = { ...input, actor: input.actor ?? currentActor(), ts: nowIso() };
    pending.push(e);
    return { seq: 0, ts: e.ts, actor: e.actor, action: e.action, entityType: e.entityType, summary: e.summary, hash: '' };
  }
  return write(input);
}

export function flushPendingAudit(): void {
  while (pending.length) write(pending.shift()!);
}

function write(input: AuditInput & { ts?: string }): AuditEntry {
  const d = db();
  return d.tx(() => {
    const last = d.get<{ seq: number; hash: string }>('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1');
    const entry: Omit<AuditEntry, 'hash'> = {
      seq: (last?.seq ?? 0) + 1,
      ts: input.ts ?? nowIso(),
      actor: input.actor ?? currentActor(),
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      runId: input.runId ?? null,
      summary: input.summary,
      details: input.details === undefined ? null : JSON.parse(JSON.stringify(input.details)),
    };
    const prev = last?.hash ?? GENESIS;
    const hash = computeHash(vault().auditKey(), prev, entry);
    d.run(
      `INSERT INTO audit_log (seq, ts, actor, action, entity_type, entity_id, run_id, summary, details, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.seq,
      entry.ts,
      entry.actor,
      entry.action,
      entry.entityType,
      entry.entityId,
      entry.runId,
      entry.summary,
      entry.details == null ? null : JSON.stringify(entry.details),
      prev,
      hash,
    );
    return { ...entry, hash };
  });
}

interface AuditRow {
  seq: number;
  ts: string;
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  run_id: string | null;
  summary: string;
  details: string | null;
  prev_hash: string;
  hash: string;
}

const toEntry = (r: AuditRow): AuditEntry => ({
  seq: r.seq,
  ts: r.ts,
  actor: r.actor,
  action: r.action,
  entityType: r.entity_type,
  entityId: r.entity_id,
  runId: r.run_id,
  summary: r.summary,
  details: parseJson(r.details, null),
  hash: r.hash,
});

export function queryAudit(f: {
  runId?: string;
  entityType?: string;
  entityId?: string;
  action?: string;
  q?: string;
  /** Exact actor (user name or "system") */
  actor?: string;
  /** ts >= from (ISO 8601) */
  from?: string;
  /** ts < to (ISO 8601) */
  to?: string;
  beforeSeq?: number;
  limit?: number;
}): AuditEntry[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.runId) (where.push('run_id = ?'), params.push(f.runId));
  if (f.entityType) (where.push('entity_type = ?'), params.push(f.entityType));
  if (f.entityId) (where.push('entity_id = ?'), params.push(f.entityId));
  if (f.action) (where.push('action LIKE ?'), params.push(f.action + '%'));
  if (f.q) (where.push('(summary LIKE ? OR actor LIKE ? OR action LIKE ?)'), params.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`));
  if (f.actor) (where.push('actor = ?'), params.push(f.actor));
  if (f.from) (where.push('ts >= ?'), params.push(f.from));
  if (f.to) (where.push('ts < ?'), params.push(f.to));
  if (f.beforeSeq) (where.push('seq < ?'), params.push(f.beforeSeq));
  const sql = `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq DESC LIMIT ?`;
  params.push(Math.min(f.limit ?? 200, 5000));
  return db().all<AuditRow>(sql, ...params).map(toEntry);
}

export function allAuditAscending(runId?: string): AuditEntry[] {
  return runId
    ? db().all<AuditRow>('SELECT * FROM audit_log WHERE run_id = ? ORDER BY seq', runId).map(toEntry)
    : db().all<AuditRow>('SELECT * FROM audit_log ORDER BY seq').map(toEntry);
}

export function verifyAudit(): AuditVerifyResult {
  const key = vault().auditKey();
  const rows = db().all<AuditRow>('SELECT * FROM audit_log ORDER BY seq');
  let prev = GENESIS;
  let expectedSeq = 1;
  for (const r of rows) {
    if (r.seq !== expectedSeq) {
      return { ok: false, checked: expectedSeq - 1, firstBadSeq: expectedSeq, message: `Entry #${expectedSeq} is missing` };
    }
    const entry = toEntry(r);
    const hash = computeHash(key, prev, entry);
    if (r.prev_hash !== prev || hash !== r.hash) {
      return { ok: false, checked: expectedSeq - 1, firstBadSeq: r.seq, message: `Entry #${r.seq} was modified or re-ordered` };
    }
    prev = r.hash;
    expectedSeq++;
  }
  return { ok: true, checked: rows.length, message: `All ${rows.length} entries are intact` };
}
