import fs from 'node:fs';
import type { ReportLang, RunStats, RunStatus, TaskRecord } from '@sm/shared';
import { db } from '../db.js';
import * as store from '../engine/store.js';
import { allAuditAscending, sealedProtocolHash } from '../audit.js';
import { findUserByName } from '../auth/users.js';
import { getProcess } from '../processes/service.js';
import { canonicalJson, sha256 } from '../util.js';

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
  steps: { startedAt: string; key: string; depth: number; name: string; type: string; status: string; result: string; durationMs: number | null; failed: boolean }[];
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
  checks: { name: string; passed: boolean; severity: string; message: string }[];
  sections: { title: string; text: string | null; columns: string[]; rows: string[][]; rowsOmitted: number }[];
  evidence: { id: string; name: string; stepKey: string; kind: string; mime: string; sha256: string; size: number; createdAt: string }[];
  errors: { at: string | null; where: string; message: string }[];
  integrity: { sealedHash: string | null; currentHash: string; intact: boolean | null };
  audit: { seq: number; ts: string; actor: string; action: string; summary: string; hash: string }[];
  auditOmitted: number;
}

export function person(username: string | null | undefined): Person {
  const u = username || 'system';
  const info = u === 'system' ? undefined : findUserByName(u);
  return { username: u, displayName: info?.displayName || (u === 'system' ? 'System' : u) };
}

export const personLabel = (p: Person | null | undefined): string => (!p ? '–' : p.displayName && p.displayName !== p.username ? `${p.displayName} (${p.username})` : p.username);

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
    inputLabels = Object.fromEntries((getProcess(run.processId, run.processVersion).definition.inputs ?? []).filter((i) => i.label).map((i) => [i.name, i.label!]));
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

  const decisions = run.tasks
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
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
        items: items.slice(0, LIMITS.items).map((i) => ({ selected: t.status === 'completed' ? sel.has(i.key) : null, cells: i.cells.map((c) => short(c, 200)) })),
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

  const evidence = run.artifacts.map((a) => ({ id: a.id, name: a.name, stepKey: a.stepKey, kind: a.kind, mime: a.mime, sha256: a.sha256, size: a.size, createdAt: a.createdAt }));

  const errors: RunReportModel['errors'] = [];
  if (run.error && run.status === 'failed') errors.push({ at: run.finishedAt ?? null, where: '', message: run.error });
  for (const s of run.steps) if (s.status === 'failed' && s.type !== 'check' && s.error) errors.push({ at: s.startedAt, where: s.name || s.stepId, message: short(s.error, 600) });
  const seen = new Set(errors.map((e) => e.message));
  for (const l of run.logs) {
    if (l.level !== 'error' || seen.has(l.message) || [...seen].some((m) => l.message.includes(m))) continue;
    seen.add(l.message);
    errors.push({ at: l.ts, where: l.stepKey ?? '', message: short(l.message, 600) });
  }

  const sealedHash = finished ? sealedProtocolHash(runId) : null;
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
    checks,
    sections,
    evidence,
    errors,
    integrity: { sealedHash, currentHash, intact: sealedHash ? sealedHash === currentHash : null },
    audit: auditAll.slice(-LIMITS.audit).map((a) => ({ seq: a.seq, ts: a.ts, actor: a.actor, action: a.action, summary: short(a.summary, 300), hash: a.hash })),
    auditOmitted: Math.max(0, auditAll.length - LIMITS.audit),
  };
}

/** Screenshots (PNG/JPEG) of a run for thumbnails; missing files are skipped. */
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
  return out;
}

export const contentHash = (model: unknown): string => sha256(canonicalJson(model));
