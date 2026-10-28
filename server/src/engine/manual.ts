import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  MANUAL_LIMITS,
  type ManualSubmission,
  type ManualTaskState,
  type ManualTaskSpec,
  type ManualVerification,
  type NodeOf,
  type TaskDecision,
  type TaskEvidence,
  type TaskRecord,
  type VerificationReason,
} from '@sm/shared';
import { config } from '../config.js';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { emit } from '../events.js';
import { HttpError, newId, nowIso, pathInside, sha256 } from '../util.js';
import { safeFilename, sniff } from '../records/attachments.js';
import { ticketReadable } from '../tickets/service.js';
import type { AuthUser } from '../auth/context.js';
import * as store from './store.js';

/**
 * Manual steps (user task mode "manual"): a person carries out work outside Steward and documents it in the run –
 * checklist, fields, evidence files, "not available" reasons, an after-the-fact time – and a second person may have
 * to verify it before the run continues (maker–checker).
 *
 *   work ──complete──▶ done                       (no verification needed)
 *   work ──complete──▶ verify ──verify──▶ done
 *                       verify ──reject──▶ work   (onReject: return, the default; the entry is kept as a returned round)
 *                       verify ──reject──▶ done   (onReject: fail – the run fails)
 *
 * Verification is always needed when something required was "not available" or the work was entered after the fact.
 * The permission checks (who may complete, who may verify) are in auth/permissions.ts (decisionCheck); this module
 * checks the content, writes the entries and the audit log.
 */

const DAY_MS = 86_400_000;
/** ISO 8601 date and time with Z or an explicit offset (2026-10-26T09:30:00Z, 2026-10-26T10:30+01:00) */
export const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
/** Clock skew allowed for a stated "done at" time */
const FUTURE_SKEW_MS = 60_000;

/** The settings of a manual step, as copied into its task. */
export function manualSpec(step: NodeOf<'userTask'>): ManualTaskSpec {
  return {
    checklist: (step.checklist ?? []).map((c) => c.trim()).filter(Boolean),
    checklistAllRequired: !!step.checklistAllRequired,
    fields: (step.fields ?? [])
      .filter((f) => (f.use ?? 'optional') !== 'off')
      .map((f) => ({ id: f.id, type: f.type, label: f.label, ...(f.hint ? { hint: f.hint } : {}), use: f.use === 'required' ? 'required' : 'optional' })),
    evidence: step.evidence ?? 'optional',
    verification: {
      required: !!step.verification?.required,
      notRunStarter: !!step.verification?.notRunStarter,
      verifiers: step.verification?.verifiers ?? [],
      onReject: step.verification?.onReject ?? 'return',
    },
    backdateDays: Math.min(MANUAL_LIMITS.backdateDays, Math.max(0, step.backdateDays ?? 0)),
  };
}

export const manualCompletionSchema = z
  .object({
    checked: z.array(z.number().int().min(0).max(MANUAL_LIMITS.checklistItems)).max(MANUAL_LIMITS.checklistItems).default([]),
    fields: z
      .array(z.object({ id: z.string().max(100), value: z.string().max(MANUAL_LIMITS.fieldValueChars) }).strict())
      .max(MANUAL_LIMITS.fields)
      .default([]),
    notAvailable: z
      .array(z.object({ target: z.string().max(100), reason: z.string().max(MANUAL_LIMITS.reasonChars) }).strict())
      .max(MANUAL_LIMITS.fields + 1)
      .default([]),
    // ISO 8601 with Z or an offset, checked in completeManual (MANUAL_DONE_AT_INVALID)
    doneAt: z.string().max(64).optional(),
    doneAtReason: z.string().max(MANUAL_LIMITS.reasonChars).optional(),
    comment: z.string().max(MANUAL_LIMITS.commentChars).optional(),
  })
  .strict();
export type ManualCompletionInput = z.infer<typeof manualCompletionSchema>;

export const verificationSchema = z.object({ approved: z.boolean(), comment: z.string().max(MANUAL_LIMITS.commentChars).optional() }).strict();

/** What the runner continues with once a manual step is done. */
export interface Settled {
  decision: TaskDecision;
  by: string;
  at: string;
}

function manualOf(t: TaskRecord) {
  if (t.mode !== 'manual' || !t.manual) throw new HttpError(409, 'This task is not a manual step', 'TASK_NOT_MANUAL');
  return t.manual;
}

function requireStage(t: TaskRecord, stage: 'work' | 'verify') {
  const m = manualOf(t);
  if (t.status !== 'open') throw new HttpError(409, `Task is ${t.status}`, 'TASK_CLOSED');
  if (m.stage !== stage)
    throw new HttpError(
      409,
      stage === 'work' ? 'This step was completed and waits for its verification' : 'This step does not wait for a verification',
      stage === 'work' ? 'TASK_WAITS_FOR_VERIFICATION' : 'TASK_NOT_IN_VERIFICATION',
    );
  return m;
}

const isUrl = (v: string): boolean => {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
};

/** A field value checked and normalised for its type; null for an empty value. */
function fieldValue(def: ManualTaskSpec['fields'][number], raw: string): { value: string | number | null; ticketId?: string | null } {
  const v = raw.trim();
  if (!v) return { value: null };
  const invalid = () => new HttpError(400, `"${def.label}" is not a valid ${def.type}`, 'MANUAL_FIELD_INVALID', { field: def.label, type: def.type });
  switch (def.type) {
    case 'number': {
      if (!/^[-+]?(\d+([.,]\d*)?|[.,]\d+)([eE][-+]?\d+)?$/.test(v)) throw invalid();
      const n = Number(v.replace(',', '.'));
      if (!Number.isFinite(n)) throw invalid();
      return { value: n };
    }
    case 'datetime': {
      const ms = ISO_WITH_OFFSET.test(v) ? Date.parse(v) : NaN;
      if (!Number.isFinite(ms)) throw invalid();
      return { value: new Date(ms).toISOString() };
    }
    case 'link':
      if (!isUrl(v)) throw invalid();
      return { value: v };
    case 'ticket': {
      if (v.length > 200) throw invalid();
      // a ticket reference documented in Steward with this number (the web links to it for readers who may see it)
      const ref = db().get<{ id: string }>('SELECT id FROM ticket_refs WHERE lower(external_number) = lower(?) ORDER BY created_at DESC LIMIT 1', v);
      return { value: v, ticketId: ref?.id ?? null };
    }
    default:
      return { value: v };
  }
}

/**
 * Person A completes the step (the caller checked that A may: decisionCheck). Returns what the run continues with
 * when the step is done, or null while it waits for the second person.
 */
export function completeManual(t: TaskRecord, input: ManualCompletionInput, actor: string): Settled | null {
  const m = requireStage(t, 'work');
  const spec = m.spec;

  const checked = [...new Set(input.checked)].sort((a, b) => a - b);
  if (checked.some((i) => i >= spec.checklist.length)) throw new HttpError(400, 'A ticked checklist item does not exist', 'MANUAL_CHECKLIST_INVALID');
  if (spec.checklistAllRequired && checked.length < spec.checklist.length) {
    const missing = spec.checklist.filter((_, i) => !checked.includes(i));
    throw new HttpError(400, `Tick every checklist item (missing: ${missing.join('; ')})`, 'MANUAL_CHECKLIST_INCOMPLETE', { missing: missing.join('; ') });
  }

  const given = new Map<string, string>();
  for (const f of input.fields) {
    if (!spec.fields.some((d) => d.id === f.id)) throw new HttpError(400, `Unknown field "${f.id}"`, 'MANUAL_FIELD_UNKNOWN', { field: f.id });
    if (given.has(f.id)) throw new HttpError(400, `Field "${f.id}" is given twice`, 'MANUAL_FIELD_UNKNOWN', { field: f.id });
    given.set(f.id, f.value);
  }
  const fields = spec.fields.map((d) => ({ id: d.id, ...fieldValue(d, given.get(d.id) ?? '') }));

  // the files of this round: earlier rounds were sent back, their files stay with those entries
  const roundEvidence = m.evidence.filter((e) => e.round === m.round);
  // "not available, because …": only for something required that is missing
  const evidenceCount = roundEvidence.length;
  const missingRequired = new Set<string>([
    ...spec.fields.filter((d) => d.use === 'required' && fields.find((f) => f.id === d.id)?.value === null).map((d) => d.id),
    ...(spec.evidence === 'required' && evidenceCount === 0 ? ['evidence'] : []),
  ]);
  const notAvailable: ManualSubmission['notAvailable'] = [];
  for (const n of input.notAvailable) {
    const reason = n.reason.trim();
    if (!missingRequired.has(n.target) || notAvailable.some((x) => x.target === n.target))
      throw new HttpError(
        400,
        `"Not available" only applies to required evidence or a required field that is empty (${n.target})`,
        'MANUAL_NOT_AVAILABLE_INVALID',
        {
          target: n.target,
        },
      );
    if (!reason) throw new HttpError(400, 'Say why it is not available', 'MANUAL_REASON_REQUIRED');
    notAvailable.push({ target: n.target, reason });
  }
  for (const target of missingRequired) {
    if (notAvailable.some((x) => x.target === target)) continue;
    if (target === 'evidence') throw new HttpError(400, 'This step needs evidence: attach a file, or say why it is not available', 'MANUAL_EVIDENCE_REQUIRED');
    const label = spec.fields.find((d) => d.id === target)?.label ?? target;
    throw new HttpError(400, `"${label}" is required: fill it in, or say why it is not available`, 'MANUAL_FIELD_REQUIRED', { field: label });
  }

  // after-the-fact entry: a stated time, never in the future, not before the run (minus the allowed back-dating)
  const now = Date.now();
  let doneAt: string | null = null;
  let doneAtReason: string | null = null;
  if (input.doneAt?.trim()) {
    // an explicit offset (Z or ±hh:mm): never read in the server's time zone
    const ms = ISO_WITH_OFFSET.test(input.doneAt.trim()) ? Date.parse(input.doneAt.trim()) : NaN;
    if (!Number.isFinite(ms)) throw new HttpError(400, 'The "done at" time is not a valid date and time', 'MANUAL_DONE_AT_INVALID');
    if (ms > now + FUTURE_SKEW_MS) throw new HttpError(400, 'The "done at" time is in the future', 'MANUAL_DONE_AT_FUTURE');
    const runStart = Date.parse(store.runRow(t.runId).started_at);
    const earliest = runStart - spec.backdateDays * DAY_MS;
    if (ms < earliest) {
      const at = new Date(earliest).toISOString();
      throw new HttpError(
        400,
        spec.backdateDays
          ? `The "done at" time may be at most ${spec.backdateDays} day(s) before the run started (${at})`
          : `The "done at" time may not be before the run started (${at})`,
        spec.backdateDays ? 'MANUAL_DONE_AT_TOO_EARLY_DAYS' : 'MANUAL_DONE_AT_TOO_EARLY',
        { earliest: at, days: spec.backdateDays },
      );
    }
    doneAtReason = input.doneAtReason?.trim() || null;
    if (!doneAtReason) throw new HttpError(400, 'Say why the step is entered after the fact', 'MANUAL_DONE_AT_REASON_REQUIRED');
    doneAt = new Date(ms).toISOString();
  }

  const reasons: VerificationReason[] = [
    ...(spec.verification.required ? (['step'] as const) : []),
    ...(notAvailable.length ? (['notAvailable'] as const) : []),
    ...(doneAt ? (['backdated'] as const) : []),
    // once an entry was sent back, every later one is verified too
    ...(m.returned.length ? (['returned'] as const) : []),
  ];
  const completedAt = nowIso();
  const sub: ManualSubmission = {
    checked,
    fields,
    notAvailable,
    doneAt,
    doneAtReason,
    comment: input.comment?.trim() || null,
    completedBy: actor,
    completedAt,
    verificationReasons: reasons,
    evidence: [],
  };
  const next = reasons.length ? 'verify' : 'done';
  db().tx(() => {
    // the entry's evidence: exactly the files of this round as stored now (read inside the transaction)
    sub.evidence = store
      .listEvidence(t.id)
      .filter((e) => e.round === m.round)
      .map((e) => ({ id: e.id, filename: e.filename, size: e.size, sha256: e.sha256, uploadedBy: e.uploadedBy }));
    if (spec.evidence === 'required' && !sub.evidence.length && !notAvailable.some((n) => n.target === 'evidence'))
      throw new HttpError(400, 'This step needs evidence: attach a file, or say why it is not available', 'MANUAL_EVIDENCE_REQUIRED');
    if (!store.submitManual(t.id, sub, next)) throw new HttpError(409, 'This step was completed in the meantime', 'TASK_WAITS_FOR_VERIFICATION');
    audit({
      actor,
      action: 'task.completed',
      entityType: 'task',
      entityId: t.id,
      runId: t.runId,
      summary:
        `"${t.title}" completed by ${actor}` +
        (spec.checklist.length ? ` (${checked.length} of ${spec.checklist.length} checklist items)` : '') +
        (notAvailable.length ? ` – not available: ${notAvailable.map((n) => `${targetLabel(spec, n.target)} (${n.reason})`).join('; ')}` : '') +
        (next === 'verify' ? ' – waiting for verification by a second person' : ''),
      details: {
        round: m.round,
        checklist: spec.checklist.map((item, i) => ({ item, checked: checked.includes(i) })),
        fields,
        notAvailable,
        doneAt,
        doneAtReason,
        comment: sub.comment,
        evidence: sub.evidence,
        verificationReasons: reasons,
      },
    });
    if (doneAt)
      audit({
        actor,
        action: 'task.backdated',
        entityType: 'task',
        entityId: t.id,
        runId: t.runId,
        summary: `"${t.title}" entered after the fact: done at ${doneAt}, entered at ${completedAt} – ${doneAtReason}`,
        details: { doneAt, enteredAt: completedAt, reason: doneAtReason },
      });
  });
  if (next === 'verify') {
    const r = store.runRow(t.runId);
    emit('task.verification_needed', {
      taskId: t.id,
      runId: t.runId,
      processId: r.process_id,
      processName: r.process_name,
      title: t.title,
      completedBy: actor,
      runActor: r.actor,
      dryRun: !!r.dry_run,
    });
    return null;
  }
  return { decision: { approved: true, selectedKeys: [], comment: sub.comment ?? undefined }, by: actor, at: completedAt };
}

const targetLabel = (spec: ManualTaskSpec, target: string): string =>
  target === 'evidence' ? 'evidence' : (spec.fields.find((f) => f.id === target)?.label ?? target);

/**
 * Person B verifies (approved) or rejects the step (the caller checked that B may: decisionCheck in stage verify).
 * Returns what the run continues with, or null when the step went back to the person who completed it.
 */
export function verifyManual(t: TaskRecord, input: z.infer<typeof verificationSchema>, actor: string): Settled | null {
  const m = requireStage(t, 'verify');
  const sub = m.submission;
  if (!sub) throw new HttpError(409, 'This step has no entry to verify', 'TASK_NOT_IN_VERIFICATION');
  const comment = input.comment?.trim() || null;
  if (!input.approved && !comment) throw new HttpError(400, 'Say why you reject the step', 'VERIFY_COMMENT_REQUIRED');
  const v: ManualVerification = { approved: input.approved, comment, by: actor, at: nowIso() };
  const spec = m.spec;
  // a step sent back too often fails the run instead (bounded history)
  const fail = !input.approved && (spec.verification.onReject === 'fail' || m.round >= MANUAL_LIMITS.rounds);
  db().tx(() => {
    const changed =
      input.approved || fail ? store.closeVerified(t.id, v, sub) : store.returnManual(t.id, [...m.returned, { submission: sub, rejection: v }], m.round + 1);
    if (!changed) throw new HttpError(409, 'This step was verified in the meantime', 'TASK_NOT_IN_VERIFICATION');
    audit({
      actor,
      action: input.approved ? 'task.verified' : 'task.verification_rejected',
      entityType: 'task',
      entityId: t.id,
      runId: t.runId,
      summary: input.approved
        ? `"${t.title}" verified by ${actor} (completed by ${sub.completedBy})${comment ? `: ${comment}` : ''}`
        : `"${t.title}" rejected by ${actor} (completed by ${sub.completedBy}): ${comment} – ${fail ? 'the run fails' : 'sent back'}`,
      details: {
        round: m.round,
        completedBy: sub.completedBy,
        completedAt: sub.completedAt,
        comment,
        outcome: input.approved ? 'verified' : fail ? 'failed' : 'returned',
      },
    });
  });
  if (input.approved || fail)
    return { decision: { approved: input.approved, selectedKeys: [], comment: sub.comment ?? undefined }, by: sub.completedBy, at: sub.completedAt };
  const r = store.runRow(t.runId);
  emit('task.returned', {
    taskId: t.id,
    runId: t.runId,
    processId: r.process_id,
    processName: r.process_name,
    title: t.title,
    completedBy: sub.completedBy,
    rejectedBy: actor,
    comment: comment ?? '',
    dryRun: !!r.dry_run,
  });
  return null;
}

/** A manual step as a reader sees it: links to ticket references only when the reader may read that reference. */
export function manualForReader(m: ManualTaskState, u: AuthUser | null): ManualTaskState {
  const cache = new Map<string, boolean>();
  const readable = (id: string) => {
    if (!cache.has(id)) cache.set(id, ticketReadable(u, id));
    return cache.get(id)!;
  };
  const fix = (sub: ManualSubmission): ManualSubmission => ({
    ...sub,
    fields: sub.fields.map((f) => (f.ticketId && !readable(f.ticketId) ? { ...f, ticketId: null } : f)),
  });
  return {
    ...m,
    submission: m.submission ? fix(m.submission) : null,
    returned: m.returned.map((r) => ({ ...r, submission: fix(r.submission) })),
  };
}

// ---------- evidence files ----------

const artifactsDir = (): string => path.join(config.dataDir, 'artifacts');
/** Absolute path of a stored evidence file (rows keep it relative to <data>/artifacts). */
export const evidenceFile = (rel: string): string => pathInside(artifactsDir(), ...rel.split('/'));

/** Adds an evidence file (the caller checked that the user may work on the step). Untrusted: allow-listed types, content-checked. */
export function addEvidence(t: TaskRecord, filename: string, data: Buffer, actor: string): TaskEvidence {
  const m = requireStage(t, 'work');
  if (m.spec.evidence === 'off') throw new HttpError(409, 'This step takes no evidence files', 'EVIDENCE_OFF');
  if (data.length > MANUAL_LIMITS.evidenceBytes)
    throw new HttpError(413, `The file is too large (at most ${MANUAL_LIMITS.evidenceBytes / 1024 / 1024} MB)`, 'FILE_TOO_LARGE', {
      maxMb: MANUAL_LIMITS.evidenceBytes / 1024 / 1024,
    });
  if (m.evidence.length >= MANUAL_LIMITS.evidenceFiles)
    throw new HttpError(400, `At most ${MANUAL_LIMITS.evidenceFiles} evidence files per step`, 'EVIDENCE_LIMIT', { max: MANUAL_LIMITS.evidenceFiles });
  const name = safeFilename(filename);
  const { mime } = sniff(name, data);
  const id = newId('tev_');
  const hash = sha256(data);
  const rel = `${t.runId}/evidence/${id}-${name.replace(/[^A-Za-z0-9._-]/g, '_')}`;
  const file = evidenceFile(rel);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, data, { flag: 'wx' });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o400);
  const e: TaskEvidence = { id, taskId: t.id, filename: name, mime, size: data.length, sha256: hash, uploadedBy: actor, uploadedAt: nowIso(), round: m.round };
  try {
    db().tx(() => {
      // checked again here: the step may have been completed, sent back or cancelled while the file was uploading
      if (!store.insertEvidence({ ...e, runId: t.runId, stepKey: t.stepKey, path: rel }, MANUAL_LIMITS.evidenceFiles)) {
        const now = store.getTask(t.id);
        if (now.status === 'open' && now.manual?.stage === 'work' && now.manual.round === m.round)
          throw new HttpError(400, `At most ${MANUAL_LIMITS.evidenceFiles} evidence files per step`, 'EVIDENCE_LIMIT', { max: MANUAL_LIMITS.evidenceFiles });
        throw new HttpError(409, 'The step was completed or sent back while the file was uploading – the file was not added', 'EVIDENCE_TOO_LATE');
      }
      audit({
        actor,
        action: 'task.evidence_added',
        entityType: 'task',
        entityId: t.id,
        runId: t.runId,
        summary: `${name} added to "${t.title}" (${data.length} bytes, sha256 ${hash.slice(0, 16)}…)`,
        details: { evidenceId: id, filename: name, size: data.length, sha256: hash, mime, round: m.round },
      });
    });
  } catch (err) {
    removeFile(file);
    throw err;
  }
  return e;
}

function removeFile(file: string): void {
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* already gone */
  }
  fs.rmSync(file, { force: true });
}

/** Removes an evidence file added in the current round (before the step is completed). Earlier rounds' files stay. */
export function removeEvidence(t: TaskRecord, evidenceId: string, actor: string): void {
  const m = requireStage(t, 'work');
  const e = store.evidenceRow(t.id, evidenceId);
  if (!e) throw new HttpError(404, 'Evidence file not found', 'EVIDENCE_NOT_FOUND');
  if (e.round !== m.round) throw new HttpError(409, 'This file belongs to an earlier, submitted entry and stays with the protocol', 'EVIDENCE_LOCKED');
  db().tx(() => {
    if (!store.deleteEvidence(e.id, t.id, m.round))
      throw new HttpError(409, 'This file belongs to a submitted entry and stays with the protocol', 'EVIDENCE_LOCKED');
    audit({
      actor,
      action: 'task.evidence_removed',
      entityType: 'task',
      entityId: t.id,
      runId: t.runId,
      summary: `${e.filename} removed from "${t.title}" before it was completed`,
      details: { evidenceId: e.id, filename: e.filename, sha256: e.sha256 },
    });
  });
  removeFile(evidenceFile(e.path));
}

/** An evidence file for download (the caller checked that the user may see the run); refused when it was changed on disk. */
export function evidenceForDownload(taskId: string, evidenceId: string): { e: TaskEvidence; data: Buffer } {
  const e = store.evidenceRow(taskId, evidenceId);
  if (!e) throw new HttpError(404, 'Evidence file not found', 'EVIDENCE_NOT_FOUND');
  let data: Buffer;
  try {
    data = fs.readFileSync(evidenceFile(e.path));
  } catch {
    throw new HttpError(404, 'The evidence file is missing in the data folder', 'EVIDENCE_FILE_MISSING');
  }
  if (sha256(data) !== e.sha256)
    throw new HttpError(409, `The stored file of ${e.filename} does not match its recorded SHA-256 – it was changed outside Steward`, 'ATTACHMENT_TAMPERED', {
      file: e.filename,
    });
  return { e, data };
}
