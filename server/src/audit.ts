import crypto from 'node:crypto';
import type { AuditCheckpoint, AuditEntry, AuditVerifyResult, ImportedHistoryRef } from '@sm/shared';
import { db } from './db.js';
import { likeEscape } from './database/sql.js';
import { vault, verifySignature } from './vault.js';
import { canonicalJson, nowIso, parseJson, sha256 } from './util.js';
import { currentActor, currentStore, currentUser } from './auth/context.js';
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
  return crypto
    .createHmac('sha256', key)
    .update(prevHash + '\n' + payload)
    .digest('hex');
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

/**
 * Entries written by a request that passed a control point of the assurance policy carry how it was met (who, which
 * rule, how confirmed – auth/assurance.ts), inside the HMAC chain. Entries of "system" (a job of the request) too.
 */
function withAssurance(input: AuditInput): AuditInput {
  const bag = currentStore()?.assurance;
  if (!bag?.proofs.length) return input;
  bag.consumed = true;
  const d = input.details;
  const plain = d !== null && typeof d === 'object' && !Array.isArray(d);
  return {
    ...input,
    details: { ...(plain ? (d as Record<string, unknown>) : d === undefined || d === null ? {} : { value: d }), assurance: bag.proofs.map((p) => ({ ...p })) },
  };
}

/**
 * Details every entry written inside fn carries (0.13.0: the plant registry's change set – `changeSetId` – on the
 * existing actions of edits, imports, bulk changes, renames and proposals). fn is synchronous (a transaction).
 */
const extraDetails: Record<string, unknown>[] = [];
export function withAuditDetails<T>(extra: Record<string, unknown>, fn: () => T): T {
  extraDetails.push(extra);
  try {
    return fn();
  } finally {
    extraDetails.pop();
  }
}
/**
 * A dry run in a transaction that is rolled back (0.13.0: previews of plant change sets run the routes' services):
 * nothing is audited – an entry written and rolled back would leave the chain's memory (lastWritten) ahead of the log.
 */
let silenced = 0;
export function withoutAudit<T>(fn: () => T): T {
  silenced++;
  try {
    return fn();
  } finally {
    silenced--;
  }
}
function withExtra(input: AuditInput): AuditInput {
  if (!extraDetails.length) return input;
  const d = input.details;
  const plain = d !== null && typeof d === 'object' && !Array.isArray(d);
  return {
    ...input,
    details: { ...(plain ? (d as Record<string, unknown>) : d === undefined || d === null ? {} : { value: d }), ...Object.assign({}, ...extraDetails) },
  };
}

/** Entries of a session opened with emergency access carry the flag in the summary and the details. */
function flagEmergency(input: AuditInput, grantId: string): AuditInput {
  const d = input.details;
  const plain = d !== null && typeof d === 'object' && !Array.isArray(d);
  return {
    ...input,
    summary: `[Emergency access] ${input.summary}`,
    details: { ...(plain ? (d as Record<string, unknown>) : d === undefined || d === null ? {} : { value: d }), emergencyAccess: grantId },
  };
}

export function audit(input: AuditInput): AuditEntry {
  if (silenced > 0)
    return { seq: 0, ts: nowIso(), actor: input.actor ?? currentActor(), action: input.action, entityType: input.entityType, summary: input.summary, hash: '' };
  // entries attributed to the person signed in with emergency access – also when a service names them as the actor
  // explicitly (a check run, a report); entries of someone else (such as "system") stay unflagged
  const user = currentUser();
  const emergency = user?.emergency && (input.actor === undefined || input.actor === user.username) ? user.emergency : undefined;
  const c = capped(withAssurance(withExtra(emergency ? flagEmergency(input, emergency.grantId) : input)));
  if (!vault().unlocked) {
    const e = { ...c, actor: c.actor ?? capText(currentActor(), LIMITS.actor), ts: nowIso() };
    if (pending.length >= PENDING_MAX) {
      if (droppedWhileLocked++ === 0)
        logger.warn({ max: PENDING_MAX }, 'audit buffer full while the vault is locked – further entries are dropped and counted');
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
  resetPrunedBase();
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
  return db()
    .all<AuditRow>(sql, ...params)
    .map(toEntry);
}

/** The entries after `afterSeq` in order (the chain an export holds). */
export function chainEntriesAscending(afterSeq: number): AuditEntry[] {
  return db().all<AuditRow>(`SELECT * FROM audit_log WHERE seq > ? AND ${VALID_SEQ} ORDER BY seq`, afterSeq).map(toEntry);
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
  if (prev) {
    if (r.prev_hash !== prev.hash) return false;
  } else {
    // the predecessor was archived and deleted (retention): the first remaining entry links to the signed checkpoint
    // the deletion started from; an entry kept in the deleted range (evidence other content relies on) is checked by
    // its HMAC alone – its place in the chain is proven by the archive
    const base = prunedBase();
    if (!base || 'problem' in base || seq - 1 > base.seq) return false;
    if (seq - 1 === base.seq && r.prev_hash !== base.hash) return false;
  }
  const expected = Buffer.from(computeHash(vault().auditKey(), r.prev_hash, toEntry(r)));
  const actual = Buffer.from(String(r.hash));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/**
 * Imported audit history (server/src/migration): the ids of imports whose history verifies against the source's
 * signed checkpoint and whose record matches this chain's instance.imported entry. Registered by the migration
 * module; without it (command-line tools) imported history is not consulted.
 */
let verifiedImports: (() => string[]) | null = null;
export function setVerifiedImports(fn: () => string[]): void {
  verifiedImports = fn;
}

/** An entry of an imported (verified) history: its seq is the source's. */
export type ImportedAuditRow = AuditRow & { import_id?: string };

/**
 * Rows matching `where` (newest first unless ascending); only authentic ones are returned, `rejected` counts the others.
 * Entries of verified imported history count as authentic too (content that moved with it – approvals, protocol
 * seals, snapshots – keeps its evidence); they come before this instance's own entries (they are older).
 * `ownOnly`: this instance's chain only (checkpoints, import records).
 */
export function authenticRows(
  where: string,
  params: unknown[],
  opts: { ascending?: boolean; limit?: number; ownOnly?: boolean } = {},
): { rows: ImportedAuditRow[]; rejected: number } {
  const limit = opts.limit ?? 50;
  const rows = db().all<AuditRow>(`SELECT * FROM audit_log WHERE (${where}) ORDER BY seq ${opts.ascending ? 'ASC' : 'DESC'} LIMIT ?`, ...params, limit);
  const ok: ImportedAuditRow[] = [];
  let rejected = 0;
  for (const r of rows) {
    if (isAuthentic(r)) ok.push(r);
    else rejected++;
  }
  const imports = opts.ownOnly || !verifiedImports ? [] : verifiedImports();
  if (!imports.length) return { rows: ok, rejected };
  const imported = db().all<ImportedAuditRow>(
    `SELECT * FROM imported_audit_log WHERE import_id IN (${imports.map(() => '?').join(', ')}) AND (${where}) ORDER BY seq ${opts.ascending ? 'ASC' : 'DESC'} LIMIT ?`,
    ...imports,
    ...params,
    limit,
  );
  const all = opts.ascending ? [...imported, ...ok] : [...ok, ...imported];
  return { rows: all.slice(0, limit), rejected };
}

/**
 * Where an authentic row comes from when it is not this instance's own: the import and the fingerprint of the source's
 * key. Answers that rest on such a row say so ("verified against the imported history of …").
 */
export function importedSourceOf(row: { import_id?: string | null } | null | undefined): ImportedHistoryRef | undefined {
  if (!row?.import_id) return undefined;
  const r = db().get<{ source_fingerprint: string }>('SELECT source_fingerprint FROM instance_imports WHERE id = ?', row.import_id);
  return r ? { importId: row.import_id, sourceFingerprint: r.source_fingerprint } : undefined;
}

/** The first imported source among authentic rows (see importedSourceOf). */
export function importedSourceAmong(rows: ImportedAuditRow[]): ImportedHistoryRef | undefined {
  return importedSourceOf(rows.find((r) => r.import_id));
}

/** Verified imported history holding entries that match `where`: checks of that entity may rest on it. */
export function importedHistoryFor(where: string, params: unknown[]): ImportedHistoryRef | undefined {
  const imports = verifiedImports?.() ?? [];
  if (!imports.length) return undefined;
  const r = db().get<{ import_id: string }>(
    `SELECT import_id FROM imported_audit_log WHERE import_id IN (${imports.map(() => '?').join(', ')}) AND (${where}) LIMIT 1`,
    ...imports,
    ...params,
  );
  return importedSourceOf(r);
}

/** Protocol fingerprint sealed in the (authentic) audit entry written when the run finished, and where that entry is. */
export function sealedProtocol(runId: string): { hash: string; importedHistory?: ImportedHistoryRef } | null {
  const { rows } = authenticRows("run_id = ? AND action IN ('run.succeeded', 'run.failed', 'run.cancelled')", [runId], { limit: 10 });
  const d = rows[0] ? parseJson<{ protocolHash?: string } | null>(rows[0].details, null) : null;
  if (!d?.protocolHash) return null;
  const from = importedSourceOf(rows[0]);
  return { hash: d.protocolHash, ...(from ? { importedHistory: from } : {}) };
}

export function sealedProtocolHash(runId: string): string | null {
  return sealedProtocol(runId)?.hash ?? null;
}

// ---------- archived and deleted entries (retention, audit-archive.ts) ----------

/**
 * Entries that other evidence relies on stay in the database when archived entries are deleted: records (approvals,
 * frozen revisions, generated PDFs), access checks and findings, generated reports, run results (protocol seals),
 * imports, checkpoints and the deletion records themselves. Each is still authentic by its HMAC (isAuthentic).
 */
export const KEPT_ON_DELETE_SQL =
  "(entity_type IN ('record', 'access_check', 'access_finding') OR action IN ('report.generated', 'run.succeeded', 'run.failed', 'run.cancelled', 'instance.imported', 'audit.checkpoint', 'audit.entries_delete_started', 'audit.entries_deleted'))";

/** The record written (in the chain) before archived entries are deleted; verification requires it. */
export const DELETE_STARTED_ACTION = 'audit.entries_delete_started';

/**
 * Where the entries still in the database start: the signed checkpoint of the newest archive whose entries are
 * being or were deleted. Entries up to `seq` are in the archives; the first remaining entry links to `hash`, and the
 * public digest continues from `digest`.
 */
export interface PrunedBase {
  archiveId: string;
  seq: number;
  hash: string;
  digest: string;
  ts: string;
  checkpoint: AuditCheckpoint;
}

type Source = NonNullable<VerifyOptions['source']>;

/** The pruned base of a database (the live one or a snapshot); `problem` when its record cannot be trusted. */
export function prunedBaseOf(d: Source): PrunedBase | { problem: string } | null {
  let r: { id: string; last_seq: number; checkpoint: string } | undefined;
  try {
    r = d.get('SELECT id, last_seq, checkpoint FROM audit_archives WHERE prune_started_at IS NOT NULL ORDER BY last_seq DESC LIMIT 1');
  } catch {
    return null; // a database from before 0.4.0 (a backup's snapshot)
  }
  if (!r) return null;
  const cp = parseJson<AuditCheckpoint | null>(r.checkpoint, null);
  const key = vault().unlocked ? vault().signingPublicKey() : undefined;
  const { signature, ...body } = cp ?? ({} as AuditCheckpoint);
  if (!cp || cp.seq !== Number(r.last_seq) || !key || !signature || !verifySignature(key, checkpointPayload(body), signature))
    return { problem: `The archive ${r.id} that entries were deleted up to has no valid signed checkpoint – the deletion cannot be trusted` };
  return { archiveId: r.id, seq: cp.seq, hash: cp.hash, digest: cp.digest, ts: cp.ts, checkpoint: cp };
}

let baseCache: ReturnType<typeof prunedBaseOf> | undefined;
/** The live database's pruned base (cached; audit-archive.ts resets it when a deletion starts). */
export function prunedBase(): ReturnType<typeof prunedBaseOf> {
  if (baseCache === undefined) baseCache = prunedBaseOf(db());
  return baseCache;
}
export function resetPrunedBase(): void {
  baseCache = undefined;
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
  /** Another copy of the database to check (a backup's snapshot, #117) instead of the live one. */
  source?: { get<T>(sql: string, ...params: unknown[]): T | undefined; all<T>(sql: string, ...params: unknown[]): T[] };
  /** Called after each page of 5000 entries: entries checked so far, of about `total` */
  onProgress?: (checked: number, total: number) => void;
}

export type VerifyOutcome = AuditVerifyResult & { head?: { seq: number; hash: string; digest: string } };

function fail(checked: number, firstBadSeq: number | undefined, message: string, extra: Partial<AuditVerifyResult> = {}): VerifyOutcome {
  return { ok: false, checked, firstBadSeq, message, ...extra };
}

const PAGE = 5000;

/**
 * Verifies the chain in pages of 5000 rows. The generator yields after each page,
 * so the async variant can let the server breathe on large logs.
 *
 * Without `from` (full): every entry from #1 – or, when archived entries were deleted, from the signed checkpoint of
 * the newest archive they were deleted up to (its deletion record must be in the chain, and the entries kept in the
 * deleted range must still carry their HMAC). With `from` (incremental): the entries after that verified entry.
 * Anchors before the start are checked against the entry they name (hash; the digest needs a full verification).
 */
function* verifySteps(o: VerifyOptions = {}): Generator<void, VerifyOutcome> {
  const key = vault().auditKey();
  const d = o.source ?? db();
  const bad = d.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log WHERE seq < 1')!;
  if (Number(bad.n) > 0) {
    const r = d.get<{ seq: number }>('SELECT seq FROM audit_log WHERE seq < 1 ORDER BY seq LIMIT 1')!;
    return fail(0, Number(r.seq), `Unexpected entry #${r.seq}: sequence numbers start at 1 – ${bad.n} row(s) were inserted outside the application`);
  }
  const based = o.source ? prunedBaseOf(d) : prunedBase();
  if (based && 'problem' in based) return fail(0, undefined, based.problem, { mode: o.from ? 'incremental' : 'full' });
  const base = based;
  const deleted = base ? { deletedThroughSeq: base.seq } : {};
  let prev = GENESIS;
  let digest = DIGEST_SEED;
  let expectedSeq = 1;
  let from: { seq: number; hash: string; digest: string } | undefined;
  if (o.from && (!base || o.from.seq > base.seq)) {
    const r = d.get<AuditRow>('SELECT * FROM audit_log WHERE seq = ?', o.from.seq);
    if (!r || r.hash !== o.from.hash)
      return fail(o.from.seq - 1, o.from.seq, `Entry #${o.from.seq} (last signed checkpoint) was removed or modified`, { mode: 'incremental', ...deleted });
    from = o.from;
  } else if (base) {
    from = { seq: base.seq, hash: base.hash, digest: base.digest };
  }
  if (from) {
    prev = from.hash;
    digest = from.digest;
    expectedSeq = from.seq + 1;
  }
  const mode = o.from ? 'incremental' : 'full';
  // the deletion record of the base must be among the (verified) entries walked
  let deletionRecord = !(base && expectedSeq === base.seq + 1);
  const anchors = [...(o.anchors ?? [])].sort((a, b) => a.seq - b.seq);
  const anchorResults: NonNullable<AuditVerifyResult['anchors']> = [];
  let ai = 0;
  // anchors before the start: the entry they name (or, deleted, its archive)
  for (; ai < anchors.length && anchors[ai]!.seq < expectedSeq; ai++) {
    const a = anchors[ai]!;
    if (from && a.seq === from.seq && a.hash === from.hash && (!a.digest || a.digest === from.digest)) {
      anchorResults.push({ source: a.source, seq: a.seq, ok: true, message: `Entry #${a.seq} matches the ${a.source}` });
      continue;
    }
    const r = d.get<{ hash: string }>('SELECT hash FROM audit_log WHERE seq = ?', a.seq);
    let problem: string | null = null;
    let message: string;
    if (r) {
      problem =
        r.hash !== a.hash ? `Entry #${a.seq} differs from the ${a.source} (hash ${String(r.hash).slice(0, 12)}… instead of ${a.hash.slice(0, 12)}…)` : null;
      message = `Entry #${a.seq} matches the ${a.source} (hash; a full verification also compares the digest)`;
    } else if (base && a.seq <= base.seq) {
      message = `Entry #${a.seq} of the ${a.source} was archived and deleted from the database – check it against the archive (steward audit verify-archive)`;
    } else {
      problem = `Entry #${a.seq} of the ${a.source} is missing – entries were removed`;
      message = problem;
    }
    if (problem)
      return { ...fail(0, a.seq, problem, { mode, ...deleted }), anchors: [...anchorResults, { source: a.source, seq: a.seq, ok: false, message: problem }] };
    anchorResults.push({ source: a.source, seq: a.seq, ok: true, message });
  }
  // full: entries kept in the deleted range must still be authentic (HMAC; their place is proven by the archive)
  if (base && !o.from) {
    for (let seq = 1; ;) {
      const rows = d.all<AuditRow>('SELECT * FROM audit_log WHERE seq >= ? AND seq <= ? ORDER BY seq LIMIT ?', seq, base.seq, PAGE);
      if (!rows.length) break;
      for (const r of rows) {
        if (computeHash(key, r.prev_hash, toEntry(r)) !== r.hash)
          return fail(0, Number(r.seq), `Entry #${r.seq} (kept when the archived entries were deleted) was modified`, { mode, ...deleted });
      }
      seq = Number(rows.at(-1)!.seq) + 1;
      yield;
    }
  }
  const start = expectedSeq;
  const total = Number(d.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log WHERE seq >= ?', start)!.n);
  const extra = { mode, ...(o.from ? { fromSeq: start - 1 } : {}), ...deleted } as const;
  for (;;) {
    const rows = d.all<AuditRow>('SELECT * FROM audit_log WHERE seq >= ? ORDER BY seq LIMIT ?', expectedSeq, PAGE);
    if (!rows.length) break;
    for (const r of rows) {
      if (Number(r.seq) !== expectedSeq) return fail(expectedSeq - start, expectedSeq, `Entry #${expectedSeq} is missing`, extra);
      const e = toEntry(r);
      const hash = computeHash(key, prev, e);
      if (r.prev_hash !== prev || hash !== r.hash) return fail(expectedSeq - start, e.seq, `Entry #${e.seq} was modified or re-ordered`, extra);
      digest = digestStep(digest, e);
      if (!deletionRecord && e.action === DELETE_STARTED_ACTION) {
        const x = e.details as { archiveId?: string; throughSeq?: number; checkpointHash?: string } | null;
        deletionRecord = x?.archiveId === base!.archiveId && x.throughSeq === base!.seq && x.checkpointHash === base!.hash;
      }
      while (ai < anchors.length && anchors[ai]!.seq === e.seq) {
        const a = anchors[ai++]!;
        const problem =
          e.hash !== a.hash
            ? `Entry #${a.seq} differs from the ${a.source} (hash ${e.hash.slice(0, 12)}… instead of ${a.hash.slice(0, 12)}…)`
            : a.digest && a.digest !== digest
              ? `Entries up to #${a.seq} differ from the ${a.source} (digest mismatch)`
              : null;
        if (problem)
          return { ...fail(e.seq - start, e.seq, problem, extra), anchors: [...anchorResults, { source: a.source, seq: a.seq, ok: false, message: problem }] };
        anchorResults.push({ source: a.source, seq: a.seq, ok: true, message: `Entry #${a.seq} matches the ${a.source}` });
      }
      prev = r.hash;
      expectedSeq++;
    }
    o.onProgress?.(expectedSeq - start, total);
    yield;
  }
  const last = expectedSeq - 1;
  const checked = last - (start - 1);
  if (ai < anchors.length) {
    const a = anchors[ai]!;
    const message = `The log ends at entry #${last}, but the ${a.source} proves that entry #${a.seq} existed – entries were removed`;
    return { ...fail(checked, last + 1, message, extra), anchors: [...anchorResults, { source: a.source, seq: a.seq, ok: false, message }] };
  }
  // (entries written during the walk are part of it, so only "fewer in the chain than in the table" is a finding)
  if (checked < total)
    return fail(checked, last + 1, `The log holds ${total} rows after #${start - 1} but only ${checked} form the chain – unexpected rows were inserted`, extra);
  if (!o.source && lastWritten && last < lastWritten.seq) {
    return fail(checked, last + 1, `Entries after #${last} were removed while the server was running (it wrote entry #${lastWritten.seq})`, extra);
  }
  if (!deletionRecord)
    return fail(
      checked,
      base!.seq,
      `Entries up to #${base!.seq} were deleted, but the log has no authentic record of that deletion (archive ${base!.archiveId})`,
      extra,
    );
  const message = o.from
    ? checked
      ? `Entries #${start}–#${last} are intact (checked from the signed checkpoint at entry #${start - 1})`
      : `No new entries since the signed checkpoint at entry #${start - 1}`
    : base
      ? `All ${checked} entries in the database are intact (entries #1–#${base.seq} were archived and deleted; the signed checkpoint of archive ${base.archiveId} links to entry #${base.seq + 1})`
      : `All ${last} entries are intact`;
  o.onProgress?.(checked, total);
  return {
    ok: true,
    checked,
    message,
    ...extra,
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
  const { rows } = authenticRows("action = 'audit.checkpoint'", [], { limit: 20, ownOnly: true });
  for (const r of rows) {
    const c = parseJson<AuditCheckpoint | null>(r.details, null);
    if (c && typeof c.seq === 'number' && c.seq < Number(r.seq) && valid(c)) return { entrySeq: Number(r.seq), checkpoint: c };
  }
  return null;
}
