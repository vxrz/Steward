import fs from 'node:fs';
import { entryEvidence, type ReportLang, type RunStats, type RunStatus, type TaskRecord } from '@sm/shared';
import { db } from '../db.js';
import * as store from '../engine/store.js';
import { allAuditAscending, sealedProtocol, sealedProtocolHash } from '../audit.js';
import { findUserByName } from '../auth/users.js';
import { getProcess } from '../processes/service.js';
import { canonicalJson, sha256 } from '../util.js';
import { evidenceFile } from '../engine/manual.js';

/**
 * Data of a run report, collected from the run journal, tasks, artifacts and
 * the audit log. The renderer only formats this model; its canonical JSON
 * hash (contentHash) is embedded in the PDF metadata.
 */

export const LIMITS = { steps: 1500, items: 300, rows: 1000, audit: 400, summaryRuns: 5000 };

export interface Person {
  username: string;
  displayName: string;
}

export interface ReportContext {
  reportId: string;
  version: number;
  generatedAt: string;
  generatedBy: Person;
  lang: ReportLang;
  timeZone: string;
  classification: string;
  comment: string | null;
}

export interface RunReportModel extends ReportContext {
  kind: 'run';
  /** Branding preview with invented data */
  sample?: boolean;
  interim: boolean;
  run: {
    id: string;
    status: RunStatus;
    error: string | null;
    dryRun: boolean;
    trigger: string;
    /** Webhook trigger or monitor that started the run */
    triggerName: string | null;
    scheduleName: string | null;
    parentRunId: string | null;
    actor: Person;
    startedAt: string;
    finishedAt: string | null;
    durationMs: number | null;
    stats: RunStats;
  };
  process: { id: string; name: string; version: number; definitionHash: string; description: string | null };
  connections: { slot: string; platformName: string; kind: string | null; environment: string | null }[];
  inputs: { name: string; label: string | null; value: string }[];
  steps: {
    startedAt: string;
    key: string;
    depth: number;
    name: string;
    type: string;
    status: string;
    result: string;
    durationMs: number | null;
    failed: boolean;
  }[];
  stepsOmitted: number;
  writes: { startedAt: string; name: string; method: string; url: string; status: string; httpStatus: number | null; result: string }[];
  decisions: {
    title: string;
    mode: 'select' | 'approve';
    status: TaskRecord['status'];
    instructions: string | null;
    decidedBy: Person | null;
    decidedAt: string | null;
    approved: boolean | null;
    selectedCount: number;
    total: number;
    comment: string | null;
    fourEyes: boolean;
    startedBy: Person;
    assignees: string[];
    columns: string[];
    items: { selected: boolean | null; cells: string[] }[];
    itemsOmitted: number;
  }[];
  /** Manual steps (user tasks in mode "manual"): what was done, by whom, with which evidence and verification */
  manualSteps: ManualStepModel[];
  checks: { name: string; passed: boolean; severity: string; message: string }[];
  sections: { title: string; text: string | null; columns: string[]; rows: string[][]; rowsOmitted: number }[];
  evidence: { id: string; name: string; stepKey: string; kind: string; mime: string; sha256: string; size: number; createdAt: string }[];
  errors: { at: string | null; where: string; message: string }[];
  integrity: {
    sealedHash: string | null;
    currentHash: string;
    intact: boolean | null;
    /** The seal is in audit history imported from another instance: the fingerprint of that instance's key */
    importedFrom?: string;
  };
  audit: { seq: number; ts: string; actor: string; action: string; summary: string; hash: string }[];
  auditOmitted: number;
}

export interface ManualStepModel {
  title: string;
  status: TaskRecord['status'];
  stage: 'work' | 'verify' | 'done';
  instructions: string | null;
  checklist: { item: string; checked: boolean | null }[];
  checklistAllRequired: boolean;
  fields: { label: string; type: string; required: boolean; value: string; notAvailable: string | null }[];
  evidenceMode: string;
  evidence: { id: string; filename: string; mime: string; size: number; sha256: string; uploadedBy: Person; uploadedAt: string }[];
  /** Required evidence or fields that were not available, with the reason */
  notAvailable: { what: string; reason: string }[];
  completedBy: Person | null;
  completedAt: string | null;
  doneAt: string | null;
  doneAtReason: string | null;
  comment: string | null;
  verificationRequired: boolean;
  verificationReasons: string[];
  verifiers: string[];
  notRunStarter: boolean;
  verifiedBy: Person | null;
  verifiedAt: string | null;
  verificationApproved: boolean | null;
  verificationComment: string | null;
  /** Earlier entries the verifier sent back */
  returned: { completedBy: Person; completedAt: string; rejectedBy: Person; rejectedAt: string; comment: string; evidence: string }[];
}

export function person(username: string | null | undefined): Person {
  const u = username || 'system';
  const info = u === 'system' ? undefined : findUserByName(u);
  return { username: u, displayName: info?.displayName || (u === 'system' ? 'System' : u) };
}

export const personLabel = (p: Person | null | undefined): string =>
  !p ? '–' : p.displayName && p.displayName !== p.username ? `${p.displayName} (${p.username})` : p.username;

const SECRET_KEY = /pass(word)?|secret|token|api[-_]?key|credential|private/i;

function short(v: unknown, max = 400): string {
  let s: string;
  if (v === null || v === undefined) s = '';
  else if (typeof v === 'string') s = v;
  else if (Array.isArray(v) && v.length && typeof v[0] === 'object') s = `[${v.length}] ` + JSON.stringify(v);
  else s = JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + ' …' : s;
}

function redactInput(name: string, v: unknown): string {
  if (SECRET_KEY.test(name)) return '***';
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, val]) => [k, SECRET_KEY.test(k) ? '***' : walk(val)]));
    return x;
  };
  return short(walk(v));
}

/** Sealed protocol hash: recorded in the (authentic) audit entry written when the run finished. */
export { sealedProtocolHash };

export function buildRunModel(runId: string, ctx: ReportContext): RunReportModel {
  const run = store.getRunDetail(runId);
  const finished = ['succeeded', 'failed', 'cancelled'].includes(run.status);

  let description: string | null = null;
  try {
    description = getProcess(run.processId, run.processVersion).definition.description ?? null;
  } catch {
    /* process deleted */
  }

  let scheduleName: string | null = null;
  if (run.scheduleId) {
    try {
      scheduleName = db().get<{ name: string }>('SELECT name FROM schedules WHERE id = ?', run.scheduleId)?.name ?? null;
    } catch {
      /* ignore */
    }
  }

  const connections = Object.entries(run.bindings).map(([slot, b]) => {
    const p = db().get<{ kind: string; environment: string | null }>('SELECT kind, environment FROM platforms WHERE id = ?', b.platformId);
    return { slot, platformName: b.platformName, kind: p?.kind ?? null, environment: p?.environment || null };
  });

  let inputLabels: Record<string, string> = {};
  try {
    inputLabels = Object.fromEntries(
      (getProcess(run.processId, run.processVersion).definition.inputs ?? []).filter((i) => i.label).map((i) => [i.name, i.label!]),
    );
  } catch {
    /* ignore */
  }
  const inputs = Object.entries(run.inputs).map(([name, v]) => ({ name, label: inputLabels[name] ?? null, value: redactInput(name, v) }));

  const visibleSteps = run.steps.slice(0, LIMITS.steps);
  const steps = visibleSteps.map((s) => ({
    startedAt: s.startedAt,
    key: s.key,
    depth: s.key.split('/').length - 1,
    name: s.name || s.stepId,
    type: s.type,
    status: s.status,
    result: short(s.error ?? s.summary ?? '', 300),
    durationMs: s.durationMs ?? null,
    failed: s.status === 'failed',
  }));

  const writes = run.steps
    .filter((s) => s.type === 'http' && (s.input as { write?: boolean } | undefined)?.write)
    .map((s) => {
      const full = store.getStepFull(runId, s.id);
      const i = (full.input ?? {}) as { method?: string; url?: string };
      const o = (full.output ?? {}) as { status?: number };
      return {
        startedAt: s.startedAt,
        name: s.name || s.stepId,
        method: i.method ?? '',
        url: i.url ?? '',
        status: s.status,
        httpStatus: s.status === 'dryrun' || typeof o.status !== 'number' || o.status === 0 ? null : o.status,
        result: short(s.error ?? s.summary ?? '', 300),
      };
    });

  const byCreation = run.tasks.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const manualSteps = byCreation.filter((t) => t.mode === 'manual' && t.manual).map((t) => manualStepModel(t));
  const decisions = byCreation
    .flatMap((t) => (t.mode === 'manual' ? [] : [{ ...t, mode: t.mode }]))
    .map((t) => {
      const sel = new Set(t.decision?.selectedKeys ?? []);
      const items = t.mode === 'select' ? t.items : [];
      return {
        title: t.title,
        mode: t.mode,
        status: t.status,
        instructions: t.instructions ?? null,
        decidedBy: t.decidedBy ? person(t.decidedBy) : null,
        decidedAt: t.decidedAt ?? null,
        approved: t.status === 'completed' ? !!t.decision?.approved : null,
        selectedCount: t.status === 'completed' ? sel.size : 0,
        total: t.items.length,
        comment: t.decision?.comment?.trim() || null,
        fourEyes: t.fourEyes,
        startedBy: person(t.startedBy ?? run.actor),
        assignees: t.assignees,
        columns: t.columns.map((c) => c.label),
        items: items
          .slice(0, LIMITS.items)
          .map((i) => ({ selected: t.status === 'completed' ? sel.has(i.key) : null, cells: i.cells.map((c) => short(c, 200)) })),
        itemsOmitted: Math.max(0, items.length - LIMITS.items),
      };
    });

  const checks = run.steps
    .filter((s) => s.type === 'check')
    .map((s) => {
      const o = (s.output && typeof s.output === 'object' ? s.output : {}) as { passed?: boolean; severity?: string; message?: string };
      return { name: s.name || s.stepId, passed: !!o.passed, severity: o.severity ?? 'error', message: short(o.message ?? s.error ?? '', 500) };
    });

  const sections = run.reports.map((r) => ({
    title: r.title,
    text: r.text ?? null,
    columns: r.columns ?? [],
    rows: (r.rows ?? []).slice(0, LIMITS.rows).map((row) => row.map((c) => short(c, 300))),
    rowsOmitted: Math.max(0, (r.rows?.length ?? 0) - LIMITS.rows),
  }));

  const evidence = run.artifacts.map((a) => ({
    id: a.id,
    name: a.name,
    stepKey: a.stepKey,
    kind: a.kind,
    mime: a.mime,
    sha256: a.sha256,
    size: a.size,
    createdAt: a.createdAt,
  }));

  const errors: RunReportModel['errors'] = [];
  if (run.error && run.status === 'failed') errors.push({ at: run.finishedAt ?? null, where: '', message: run.error });
  for (const s of run.steps)
    if (s.status === 'failed' && s.type !== 'check' && s.error) errors.push({ at: s.startedAt, where: s.name || s.stepId, message: short(s.error, 600) });
  const seen = new Set(errors.map((e) => e.message));
  for (const l of run.logs) {
    if (l.level !== 'error' || seen.has(l.message) || [...seen].some((m) => l.message.includes(m))) continue;
    seen.add(l.message);
    errors.push({ at: l.ts, where: l.stepKey ?? '', message: short(l.message, 600) });
  }

  const sealed = finished ? sealedProtocol(runId) : null;
  const sealedHash = sealed?.hash ?? null;
  const currentHash = store.protocolHash(runId);
  const auditAll = allAuditAscending(runId);

  return {
    ...ctx,
    kind: 'run',
    interim: !finished,
    run: {
      id: run.id,
      status: run.status,
      error: run.error ?? null,
      dryRun: run.dryRun,
      trigger: run.trigger,
      triggerName: run.triggerName ?? null,
      scheduleName,
      parentRunId: run.parentRunId ?? null,
      actor: person(run.actor),
      startedAt: run.startedAt,
      finishedAt: run.finishedAt ?? null,
      durationMs: run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : null,
      stats: run.stats,
    },
    process: { id: run.processId, name: run.processName, version: run.processVersion, definitionHash: run.definitionHash, description },
    connections,
    inputs,
    steps,
    stepsOmitted: Math.max(0, run.steps.length - LIMITS.steps),
    writes,
    decisions,
    manualSteps,
    checks,
    sections,
    evidence,
    errors,
    integrity: {
      sealedHash,
      currentHash,
      intact: sealedHash ? sealedHash === currentHash : null,
      ...(sealed?.importedHistory ? { importedFrom: sealed.importedHistory.sourceFingerprint } : {}),
    },
    audit: auditAll.slice(-LIMITS.audit).map((a) => ({ seq: a.seq, ts: a.ts, actor: a.actor, action: a.action, summary: short(a.summary, 300), hash: a.hash })),
    auditOmitted: Math.max(0, auditAll.length - LIMITS.audit),
  };
}

function manualStepModel(t: TaskRecord): ManualStepModel {
  const m = t.manual!;
  const sub = m.submission;
  const done = !!sub;
  const na = new Map((sub?.notAvailable ?? []).map((n) => [n.target, n.reason]));
  const value = (v: string | number | null | undefined) => (v === null || v === undefined ? '' : short(v, 500));
  return {
    title: t.title,
    status: t.status,
    stage: m.stage,
    instructions: t.instructions ?? null,
    checklist: m.spec.checklist.map((item, i) => ({ item: short(item, 500), checked: done ? sub!.checked.includes(i) : null })),
    checklistAllRequired: m.spec.checklistAllRequired,
    fields: m.spec.fields.map((f) => ({
      label: f.label,
      type: f.type,
      required: f.use === 'required',
      value: value(sub?.fields.find((x) => x.id === f.id)?.value),
      notAvailable: na.get(f.id) ?? null,
    })),
    evidenceMode: m.spec.evidence,
    evidence: entryEvidence(m).map((e) => ({
      id: e.id,
      filename: e.filename,
      mime: e.mime,
      size: e.size,
      sha256: e.sha256,
      uploadedBy: person(e.uploadedBy),
      uploadedAt: e.uploadedAt,
    })),
    notAvailable: (sub?.notAvailable ?? []).map((n) => ({
      what: n.target === 'evidence' ? 'evidence' : (m.spec.fields.find((f) => f.id === n.target)?.label ?? n.target),
      reason: short(n.reason, 2000),
    })),
    completedBy: sub ? person(sub.completedBy) : null,
    completedAt: sub?.completedAt ?? null,
    doneAt: sub?.doneAt ?? null,
    doneAtReason: sub?.doneAtReason ?? null,
    comment: sub?.comment ?? null,
    verificationRequired: m.spec.verification.required || !!sub?.verificationReasons.length,
    verificationReasons: sub?.verificationReasons ?? (m.spec.verification.required ? ['step'] : []),
    verifiers: m.spec.verification.verifiers,
    notRunStarter: m.spec.verification.notRunStarter,
    verifiedBy: m.verification ? person(m.verification.by) : null,
    verifiedAt: m.verification?.at ?? null,
    verificationApproved: m.verification ? m.verification.approved : null,
    verificationComment: m.verification?.comment ?? null,
    returned: m.returned.map((r) => ({
      completedBy: person(r.submission.completedBy),
      completedAt: r.submission.completedAt,
      rejectedBy: person(r.rejection.by),
      rejectedAt: r.rejection.at,
      comment: short(r.rejection.comment ?? '', 2000),
      evidence: (r.submission.evidence ?? []).map((e) => `${e.filename} (SHA-256 ${e.sha256.slice(0, 16)}…)`).join(', '),
    })),
  };
}

/** Thumbnails: at most this many bytes and pixels (PDFKit decodes the whole image in memory) */
const THUMB = { bytes: 8 * 1024 * 1024, side: 8000, pixels: 40_000_000 };

/** Width and height of a PNG or JPEG from its header, or null when it is neither or cannot be read. */
export function imageSize(data: Buffer): { w: number; h: number } | null {
  if (
    data.length > 24 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
    data.subarray(12, 16).toString('latin1') === 'IHDR'
  )
    return { w: data.readUInt32BE(16), h: data.readUInt32BE(20) };
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    let i = 2;
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) return null;
      const marker = data[i + 1]!;
      const len = data.readUInt16BE(i + 2);
      // start of frame (baseline, progressive …), not DHT (c4), JPG (c8) or DAC (cc)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { h: data.readUInt16BE(i + 5), w: data.readUInt16BE(i + 7) };
      if (len < 2) return null;
      i += 2 + len;
    }
  }
  return null;
}

/** Whether an image is small enough to be drawn as a thumbnail. */
export function thumbnailable(data: Buffer): boolean {
  if (data.length > THUMB.bytes) return false;
  const size = imageSize(data);
  return !!size && size.w > 0 && size.h > 0 && size.w <= THUMB.side && size.h <= THUMB.side && size.w * size.h <= THUMB.pixels;
}

/**
 * Images for thumbnails: screenshots (PNG/JPEG) of the run and PNG/JPEG evidence files of manual steps. Missing or
 * changed files (SHA-256) and images too large to decode safely are skipped – they are listed with their hash only.
 */
export function evidenceImages(model: RunReportModel): { id: string; data: Buffer }[] {
  const out: { id: string; data: Buffer }[] = [];
  for (const e of model.evidence) {
    if (!/^image\/(png|jpe?g)$/.test(e.mime)) continue;
    try {
      out.push({ id: e.id, data: fs.readFileSync(store.artifactFile(e.id).path) });
    } catch {
      /* file missing */
    }
  }
  for (const step of model.manualSteps)
    for (const e of step.evidence) {
      if (!/^image\/(png|jpeg)$/.test(e.mime)) continue;
      try {
        const row = db().get<{ path: string; task_id: string }>('SELECT path, task_id FROM run_task_evidence WHERE id = ?', e.id);
        if (!row) continue;
        const data = fs.readFileSync(evidenceFile(row.path));
        if (sha256(data) === e.sha256 && thumbnailable(data)) out.push({ id: e.id, data });
      } catch {
        /* file missing */
      }
    }
  return out;
}

export const contentHash = (model: unknown): string => sha256(canonicalJson(model));
