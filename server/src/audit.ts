import crypto from 'node:crypto';
import type { AuditCheckpoint, AuditEntry, AuditVerifyResult } from '@sm/shared';
import { db } from './db.js';
import { likeEscape } from './database/sql.js';
import { vault } from './vault.js';
import { canonicalJson, nowIso, parseJson, sha256 } from './util.js';
import { currentActor } from './auth/context.js';
import { logger } from './log.js';

/**
 * Append-only, hash-chained audit log. Every entry is signed with an HMAC
 * (key wrapped in the vault) and chained to its predecessor, so edits,
 * deletions and re-ordering are detected by verify(). Removing entries at the
 * end (or all of them) is detected against an anchor: a signed checkpoint
 * kept outside the database (see audit-anchor.ts).
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

export const GENESIS = 'GENESIS';
/** Start value of the public (unkeyed) SHA-256 digest chain that checkpoints sign. */
export const DIGEST_SEED = sha256('steward-audit-digest-v1');

// ---------- size limits (an unauthenticated sign-in must not be able to write megabytes) ----------

export const LIMITS = { actor: 128, short: 200, summary: 2000, details: 16 * 1024 };

/** Cuts long text and records how long it was and its SHA-256, so the original can still be matched. */
export function capText(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}… [truncated: ${s.length} chars, sha256 ${sha256(s).slice(0, 16)}]`;
}

function capDetails(d: unknown): unknown {
  if (d === undefined || d === null) return null;
  const json = JSON.stringify(d);
  if (json === undefined) return null;
  if (json.length <= LIMITS.details) return JSON.parse(json);
  return { truncated: true, size: json.length, sha256: sha256(json), preview: json.slice(0, 2048) };
}

function capped(input: AuditInput) {
  return {
    actor: input.actor === undefined ? undefined : capText(String(input.actor), LIMITS.actor),
    action: capText(input.action, LIMITS.short),
    entityType: capText(input.entityType, LIMITS.short),
    entityId: input.entityId == null ? null : capText(String(input.entityId), LIMITS.short),
    runId: input.runId == null ? null : capText(String(input.runId), LIMITS.short),
    summary: capText(input.summary, LIMITS.summary),
    details: capDetails(input.details),
  };
}
type Capped = ReturnType<typeof capped> & { ts?: string };

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

/** One step of the public digest chain (verifiable without the HMAC key, e.g. on an export). */
export function digestStep(prevDigest: string, e: AuditEntry): string {
  const pub = canonicalJson({
    seq: e.seq,
    ts: e.ts,
    actor: e.actor,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId ?? null,
    runId: e.runId ?? null,
    summary: e.summary,
    details: e.details ?? null,
    prevHash: e.prevHash ?? null,
    hash: e.hash,
  });
  return sha256(prevDigest + '\n' + pub);
}

// ---------- entries recorded while the vault is locked ----------

/** Entries recorded while the vault is locked (e.g. sign-ins) are signed and written on unlock – bounded. */
export const PENDING_MAX = 1000;
const pending: (Capped & { ts: string; actor: string })[] = [];
let droppedWhileLocked = 0;

export function audit(input: AuditInput): AuditEntry {
  const c = capped(input);
  if (!vault().unlocked) {
    const e = { ...c, actor: c.actor ?? capText(currentActor(), LIMITS.actor), ts: nowIso() };
    if (pending.length >= PENDING_MAX) {
      if (droppedWhileLocked++ === 0) logger.warn({ max: PENDING_MAX }, 'audit buffer full while the vault is locked – further entries are dropped and counted');
    } else {
      pending.push(e);
    }
    // The operational log keeps a copy (ship it to your SIEM): pending entries are lost if the server stops before the unlock.
    logger.info(
      { audit: { ts: e.ts, actor: e.actor, action: e.action, entityType: e.entityType, entityId: e.entityId, summary: e.summary.slice(0, 300) } },
      'audit entry pending (vault locked)',
    );
    return { seq: 0, ts: e.ts, actor: e.actor, action: e.action, entityType: e.entityType, summary: e.summary, hash: '' };
  }
  return write(c);
}

export function pendingAuditCount(): { pending: number; dropped: number } {
  return { pending: pending.length, dropped: droppedWhileLocked };
}

export function flushPendingAudit(): void {
  while (pending.length) write(pending.shift()!);
  if (droppedWhileLocked) {
    const n = droppedWhileLocked;
    droppedWhileLocked = 0;
    write(
      capped({
        actor: 'system',
        action: 'audit.entries_dropped',
        entityType: 'audit',
        summary: `${n} audit entr${n === 1 ? 'y' : 'ies'} recorded while the vault was locked could not be kept (buffer limit ${PENDING_MAX}); see the operational log`,
        details: { dropped: n, limit: PENDING_MAX },
      }),
    );
  }
}

/** Last entry this process wrote: entries up to it must still be there (a cheap in-memory anchor). */
let lastWritten: { seq: number; hash: string } | null = null;

function write(input: Capped): AuditEntry {
  const d = db();
  const out = d.tx(() => {
    const last = d.get<{ seq: number; hash: string }>('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1');
    const lastSeq = last ? Number(last.seq) : 0;
    const entry: Omit<AuditEntry, 'hash'> = {
      seq: Math.max(lastSeq, 0) + 1,
      ts: input.ts ?? nowIso(),
      actor: input.actor ?? capText(currentActor(), LIMITS.actor),
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      runId: input.runId ?? null,
      summary: input.summary,
      details: input.details ?? null,
    };
    const prev = last && lastSeq >= 1 ? last.hash : GENESIS;
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
    return { ...entry, prevHash: prev, hash };
  });
  lastWritten = { seq: out.seq, hash: out.hash };
  return out;
}

/** Tests: forget what this process wrote (simulates a restart). */
export function resetAuditMemory(): void {
  lastWritten = null;
}

export interface AuditRow {
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

export const toEntry = (r: AuditRow): AuditEntry => ({
  seq: Number(r.seq),
  ts: r.ts,
  actor: r.actor,
  action: r.action,
  entityType: r.entity_type,
  entityId: r.entity_id,
  runId: r.run_id,
  summary: r.summary,
  details: parseJson(r.details, null),
  prevHash: r.prev_hash,
  hash: r.hash,
});

/** Only real entries: sequence numbers start at 1 (rows with seq < 1 can only come from outside the app and are flagged by verify). */
export const VALID_SEQ = 'seq >= 1';

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
  const where: string[] = [VALID_SEQ];
  const params: unknown[] = [];
  if (f.runId) (where.push('run_id = ?'), params.push(f.runId));
  if (f.entityType) (where.push('entity_type = ?'), params.push(f.entityType));
  if (f.entityId) (where.push('entity_id = ?'), params.push(f.entityId));
  // case-insensitive on SQLite and PostgreSQL alike; user input is matched literally
  const like = (col: string) => `lower(${col}) LIKE lower(?) ESCAPE '\\'`;
  if (f.action) (where.push(like('action')), params.push(likeEscape(f.action) + '%'));
  if (f.q) {
    const q = `%${likeEscape(f.q)}%`;
    where.push(`(${like('summary')} OR ${like('actor')} OR ${like('action')})`);
    params.push(q, q, q);
  }
  if (f.actor) (where.push('actor = ?'), params.push(f.actor));
  if (f.from) (where.push('ts >= ?'), params.push(f.from));
  if (f.to) (where.push('ts < ?'), params.push(f.to));
  if (f.beforeSeq) (where.push('seq < ?'), params.push(f.beforeSeq));
  const sql = `SELECT * FROM audit_log WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT ?`;
  params.push(Math.min(Math.max(1, f.limit ?? 200), 5000));
  return db().all<AuditRow>(sql, ...params).map(toEntry);
}

export function allAuditAscending(runId?: string): AuditEntry[] {
  return runId
    ? db().all<AuditRow>(`SELECT * FROM audit_log WHERE run_id = ? AND ${VALID_SEQ} ORDER BY seq`, runId).map(toEntry)
    : db().all<AuditRow>(`SELECT * FROM audit_log WHERE ${VALID_SEQ} ORDER BY seq`).map(toEntry);
}

/**
 * Whether an entry is genuine: its HMAC is right and it is linked to its actual predecessor.
 * Callers that rely on a single entry (report verification, protocol seals) use this; the
 * whole chain is checked by verifyAudit. Needs the unlocked vault (false while locked).
 */
export function isAuthentic(r: AuditRow | undefined): boolean {
  if (!r || !vault().unlocked) return false;
  const seq = Number(r.seq);
  if (!Number.isInteger(seq) || seq < 1) return false;
  const prev = seq === 1 ? { hash: GENESIS } : db().get<{ hash: string }>('SELECT hash FROM audit_log WHERE seq = ?', seq - 1);
  if (!prev || r.prev_hash !== prev.hash) return false;
  const expected = Buffer.from(computeHash(vault().auditKey(), r.prev_hash, toEntry(r)));
  const actual = Buffer.from(String(r.hash));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** Rows matching `where` (newest first unless ascending); only authentic ones are returned, `rejected` counts the others. */
export function authenticRows(where: string, params: unknown[], opts: { ascending?: boolean; limit?: number } = {}): { rows: AuditRow[]; rejected: number } {
  const rows = db().all<AuditRow>(
    `SELECT * FROM audit_log WHERE (${where}) ORDER BY seq ${opts.ascending ? 'ASC' : 'DESC'} LIMIT ?`,
    ...params,
    opts.limit ?? 50,
  );
  const ok: AuditRow[] = [];
  let rejected = 0;
  for (const r of rows) {
    if (isAuthentic(r)) ok.push(r);
    else rejected++;
  }
  return { rows: ok, rejected };
}

/** Protocol fingerprint sealed in the (authentic) audit entry written when the run finished. */
export function sealedProtocolHash(runId: string): string | null {
  const { rows } = authenticRows("run_id = ? AND action IN ('run.succeeded', 'run.failed', 'run.cancelled')", [runId], { limit: 10 });
  const d = rows[0] ? parseJson<{ protocolHash?: string } | null>(rows[0].details, null) : null;
  return d?.protocolHash ?? null;
}

// ---------- verification ----------

export interface Anchor {
  /** Where the anchor comes from (shown in the result) */
  source: string;
  seq: number;
  hash: string;
  digest?: string;
}

export interface VerifyOptions {
  anchors?: Anchor[];
  /** Incremental check: start after this already verified entry (e.g. the last checkpoint). */
  from?: { seq: number; hash: string; digest: string };
}

export type VerifyOutcome = AuditVerifyResult & { head?: { seq: number; hash: string; digest: string } };

function fail(checked: number, firstBadSeq: number | undefined, message: string): VerifyOutcome {
  return { ok: false, checked, firstBadSeq, message };
}

/**
 * Verifies the chain in pages of 5000 rows. The generator yields after each page,
 * so the async variant can let the server breathe on large logs.
 */
function* verifySteps(o: VerifyOptions = {}): Generator<void, VerifyOutcome> {
  const key = vault().auditKey();
  const stats = db().get<{ n: number; bad: number | null }>('SELECT COUNT(*) AS n, SUM(CASE WHEN seq < 1 THEN 1 ELSE 0 END) AS bad FROM audit_log')!;
  const total = Number(stats.n);
  if (Number(stats.bad ?? 0) > 0) {
    const r = db().get<{ seq: number }>('SELECT seq FROM audit_log WHERE seq < 1 ORDER BY seq LIMIT 1')!;
    return fail(0, Number(r.seq), `Unexpected entry #${r.seq}: sequence numbers start at 1 – ${stats.bad} row(s) were inserted outside the application`);
  }
  let prev = GENESIS;
  let digest = DIGEST_SEED;
  let expectedSeq = 1;
  if (o.from) {
    const r = db().get<AuditRow>('SELECT * FROM audit_log WHERE seq = ?', o.from.seq);
    if (!r || r.hash !== o.from.hash) return fail(o.from.seq - 1, o.from.seq, `Entry #${o.from.seq} (last signed checkpoint) was removed or modified`);
    prev = o.from.hash;
    digest = o.from.digest;
    expectedSeq = o.from.seq + 1;
  }
  const anchors = [...(o.anchors ?? [])].sort((a, b) => a.seq - b.seq);
  const anchorResults: NonNullable<AuditVerifyResult['anchors']> = [];
  let ai = 0;
  while (ai < anchors.length && anchors[ai]!.seq < expectedSeq) ai++; // covered by the incremental start
  for (;;) {
    const rows = db().all<AuditRow>('SELECT * FROM audit_log WHERE seq >= ? ORDER BY seq LIMIT 5000', expectedSeq);
    if (!rows.length) break;
    for (const r of rows) {
      if (Number(r.seq) !== expectedSeq) return fail(expectedSeq - 1, expectedSeq, `Entry #${expectedSeq} is missing`);
      const e = toEntry(r);
      const hash = computeHash(key, prev, e);
      if (r.prev_hash !== prev || hash !== r.hash) return fail(expectedSeq - 1, e.seq, `Entry #${e.seq} was modified or re-ordered`);
      digest = digestStep(digest, e);
      while (ai < anchors.length && anchors[ai]!.seq === e.seq) {
        const a = anchors[ai++]!;
        const problem =
          e.hash !== a.hash
            ? `Entry #${a.seq} differs from the ${a.source} (hash ${e.hash.slice(0, 12)}… instead of ${a.hash.slice(0, 12)}…)`
            : a.digest && a.digest !== digest
              ? `Entries up to #${a.seq} differ from the ${a.source} (digest mismatch)`
              : null;
        if (problem) return { ...fail(e.seq - 1, e.seq, problem), anchors: [...anchorResults, { source: a.source, seq: a.seq, ok: false, message: problem }] };
        anchorResults.push({ source: a.source, seq: a.seq, ok: true, message: `Entry #${a.seq} matches the ${a.source}` });
      }
      prev = r.hash;
      expectedSeq++;
    }
    yield;
  }
  const last = expectedSeq - 1;
  if (ai < anchors.length) {
    const a = anchors[ai]!;
    const message = `The log ends at entry #${last}, but the ${a.source} proves that entry #${a.seq} existed – entries were removed`;
    return { ...fail(last, last + 1, message), anchors: [...anchorResults, { source: a.source, seq: a.seq, ok: false, message }] };
  }
  // (entries written during the walk are part of it, so only "fewer in the chain than in the table" is a finding)
  if (!o.from && last < total) return fail(last, last + 1, `The log holds ${total} rows but only ${last} form the chain – unexpected rows were inserted`);
  if (lastWritten && last < lastWritten.seq) {
    return fail(last, last + 1, `Entries after #${last} were removed while the server was running (it wrote entry #${lastWritten.seq})`);
  }
  return {
    ok: true,
    checked: o.from ? last - o.from.seq : last,
    message: `All ${last} entries are intact`,
    anchors: anchorResults.length ? anchorResults : undefined,
    head: { seq: last, hash: prev, digest },
  };
}

export function verifyAudit(o: VerifyOptions = {}): VerifyOutcome {
  const it = verifySteps(o);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}

/** Same as verifyAudit, but yields to the event loop between pages. */
export async function verifyAuditAsync(o: VerifyOptions = {}): Promise<VerifyOutcome> {
  const it = verifySteps(o);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** The result without the internal head. */
export function publicResult(r: VerifyOutcome, extra: Partial<AuditVerifyResult> = {}): AuditVerifyResult {
  const { head: _h, ...rest } = r;
  return { ...rest, ...extra };
}

// ---------- checkpoints (signing and anchoring: audit-anchor.ts) ----------

/** The exact bytes a checkpoint signature covers. */
export function checkpointPayload(c: Omit<AuditCheckpoint, 'signature'>): string {
  return canonicalJson({ v: c.v, seq: c.seq, hash: c.hash, digest: c.digest, count: c.count, ts: c.ts, keyFingerprint: c.keyFingerprint });
}

/** The most recent authentic checkpoint entry whose signature checks out. */
export function latestCheckpoint(valid: (c: AuditCheckpoint) => boolean): { entrySeq: number; checkpoint: AuditCheckpoint } | null {
  const { rows } = authenticRows("action = 'audit.checkpoint'", [], { limit: 20 });
  for (const r of rows) {
    const c = parseJson<AuditCheckpoint | null>(r.details, null);
    if (c && typeof c.seq === 'number' && c.seq < Number(r.seq) && valid(c)) return { entrySeq: Number(r.seq), checkpoint: c };
  }
  return null;
}
