import type {
  Column,
  RunArtifact,
  RunDetail,
  RunLog,
  RunReportSection,
  RunStats,
  RunStatus,
  RunStepRecord,
  RunSummary,
  StepStatus,
  TaskDecision,
  TaskItem,
  TaskRecord,
} from '@sm/shared';
import { db } from '../db.js';
import { HttpError, canonicalJson, nowIso, parseJson, preview, sha256 } from '../util.js';

export const emptyStats = (): RunStats => ({
  steps: 0,
  failedSteps: 0,
  writes: 0,
  skippedWrites: 0,
  checksPassed: 0,
  checksFailed: 0,
  openTasks: 0,
});

interface RunRow {
  id: string;
  process_id: string;
  process_name: string;
  process_version: number;
  definition_hash: string;
  status: RunStatus;
  dry_run: number;
  trigger: RunSummary['trigger'];
  schedule_id: string | null;
  actor: string;
  inputs: string;
  bindings: string;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  stats: string;
}

export interface StepRow {
  id: number;
  run_id: string;
  key: string;
  parent_key: string | null;
  step_id: string;
  type: string;
  name: string;
  status: StepStatus;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  summary: string | null;
  error: string | null;
  input: string | null;
  output: string | null;
}

interface TaskRow {
  id: string;
  run_id: string;
  step_key: string;
  mode: 'select' | 'approve';
  title: string;
  instructions: string | null;
  columns: string;
  items: string;
  status: TaskRecord['status'];
  decision: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
  process_name?: string;
  dry_run?: number;
}

export function runRow(id: string): RunRow {
  const r = db().get<RunRow>('SELECT * FROM runs WHERE id = ?', id);
  if (!r) throw new HttpError(404, `Run ${id} not found`);
  return r;
}

function toSummary(r: RunRow): RunSummary {
  const stats = { ...emptyStats(), ...parseJson<Partial<RunStats>>(r.stats, {}) };
  stats.openTasks = db().get<{ n: number }>("SELECT COUNT(*) AS n FROM run_tasks WHERE run_id = ? AND status = 'open'", r.id)!.n;
  return {
    id: r.id,
    processId: r.process_id,
    processName: r.process_name,
    processVersion: r.process_version,
    status: r.status,
    dryRun: !!r.dry_run,
    trigger: r.trigger,
    scheduleId: r.schedule_id,
    actor: r.actor,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    error: r.error,
    stats,
  };
}

export function listRuns(f: { processId?: string; status?: string; scheduleId?: string; limit?: number; before?: string }): RunSummary[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.processId) (where.push('process_id = ?'), params.push(f.processId));
  if (f.status) (where.push(`status IN (${f.status.split(',').map(() => '?').join(',')})`), params.push(...f.status.split(',')));
  if (f.scheduleId) (where.push('schedule_id = ?'), params.push(f.scheduleId));
  if (f.before) (where.push('started_at < ?'), params.push(f.before));
  params.push(Math.min(f.limit ?? 100, 1000));
  return db()
    .all<RunRow>(`SELECT * FROM runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY started_at DESC LIMIT ?`, ...params)
    .map(toSummary);
}

export function getRunSummary(id: string): RunSummary {
  return toSummary(runRow(id));
}

export function stepRecord(r: StepRow, full = false): RunStepRecord {
  const out = parseJson<unknown>(r.output, undefined);
  const [prev, truncated] = full ? [out, false] : preview(out, 8000);
  const [inp] = full ? [parseJson<unknown>(r.input, undefined)] : preview(parseJson<unknown>(r.input, undefined), 8000);
  return {
    id: r.id,
    key: r.key,
    parentKey: r.parent_key,
    stepId: r.step_id,
    type: r.type,
    name: r.name,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    durationMs: r.duration_ms,
    summary: r.summary,
    error: r.error,
    input: inp,
    output: prev,
    outputTruncated: truncated,
    seq: r.id,
  };
}

export function getRunDetail(id: string): RunDetail {
  const r = runRow(id);
  const steps = db().all<StepRow>('SELECT * FROM run_steps WHERE run_id = ? ORDER BY id', id);
  const reports: RunReportSection[] = steps
    .filter((s) => s.type === 'report' && s.status === 'succeeded')
    .map((s) => {
      const o = parseJson<{ title: string; text?: string; columns?: string[]; rows?: unknown[][] }>(s.output, { title: s.name });
      return { stepKey: s.key, ...o };
    });
  return {
    ...toSummary(r),
    inputs: parseJson(r.inputs, {}),
    bindings: parseJson(r.bindings, {}),
    definitionHash: r.definition_hash,
    steps: steps.map((s) => stepRecord(s)),
    logs: listLogs(id),
    tasks: listTasks({ runId: id }),
    artifacts: listArtifacts(id),
    reports,
  };
}

export function getStepFull(runId: string, stepRowId: number): RunStepRecord {
  const r = db().get<StepRow>('SELECT * FROM run_steps WHERE run_id = ? AND id = ?', runId, stepRowId);
  if (!r) throw new HttpError(404, 'Step not found');
  return stepRecord(r, true);
}

export function loadJournal(runId: string): Map<string, StepRow> {
  const m = new Map<string, StepRow>();
  for (const r of db().all<StepRow>('SELECT * FROM run_steps WHERE run_id = ?', runId)) m.set(r.key, r);
  return m;
}

export function upsertStep(
  runId: string,
  s: { key: string; parentKey: string | null; stepId: string; type: string; name: string; status: StepStatus; input?: unknown },
): void {
  db().run(
    `INSERT INTO run_steps (run_id, key, parent_key, step_id, type, name, status, started_at, input)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, key) DO UPDATE SET status = excluded.status, started_at = excluded.started_at,
       input = COALESCE(excluded.input, run_steps.input), finished_at = NULL, error = NULL`,
    runId,
    s.key,
    s.parentKey,
    s.stepId,
    s.type,
    s.name,
    s.status,
    nowIso(),
    s.input === undefined ? null : JSON.stringify(s.input),
  );
}

export function updateStepInput(runId: string, key: string, input: unknown): void {
  db().run('UPDATE run_steps SET input = ? WHERE run_id = ? AND key = ?', JSON.stringify(input ?? null), runId, key);
}

export function finishStep(
  runId: string,
  key: string,
  f: { status: StepStatus; output?: unknown; summary?: string; error?: string; startedMs: number },
): void {
  db().run(
    'UPDATE run_steps SET status = ?, output = ?, summary = ?, error = ?, finished_at = ?, duration_ms = ? WHERE run_id = ? AND key = ?',
    f.status,
    f.output === undefined ? null : JSON.stringify(f.output),
    f.summary ?? null,
    f.error ?? null,
    nowIso(),
    Date.now() - f.startedMs,
    runId,
    key,
  );
}

export function setStepStatus(runId: string, key: string, status: StepStatus): void {
  db().run('UPDATE run_steps SET status = ? WHERE run_id = ? AND key = ?', status, runId, key);
}

export function addLog(runId: string, level: RunLog['level'], message: string, stepKey?: string | null, data?: unknown): void {
  db().run(
    'INSERT INTO run_logs (run_id, ts, level, step_key, message, data) VALUES (?, ?, ?, ?, ?, ?)',
    runId,
    nowIso(),
    level,
    stepKey ?? null,
    message,
    data === undefined ? null : JSON.stringify(preview(data, 20000)[0]),
  );
}

export function listLogs(runId: string): RunLog[] {
  return db()
    .all<{ id: number; ts: string; level: RunLog['level']; step_key: string | null; message: string; data: string | null }>(
      'SELECT * FROM run_logs WHERE run_id = ? ORDER BY id',
      runId,
    )
    .map((l) => ({ id: l.id, ts: l.ts, level: l.level, stepKey: l.step_key, message: l.message, data: parseJson(l.data, undefined) }));
}

export function setRunStatus(runId: string, status: RunStatus, extra: { error?: string | null; finished?: boolean } = {}): void {
  db().run(
    'UPDATE runs SET status = ?, error = COALESCE(?, error), finished_at = ? WHERE id = ?',
    status,
    extra.error ?? null,
    extra.finished ? nowIso() : null,
    runId,
  );
}

export function saveStats(runId: string, stats: RunStats): void {
  db().run('UPDATE runs SET stats = ? WHERE id = ?', JSON.stringify(stats), runId);
}

// ---------- Tasks ----------

function toTask(r: TaskRow): TaskRecord {
  return {
    id: r.id,
    runId: r.run_id,
    processName: r.process_name,
    stepKey: r.step_key,
    mode: r.mode,
    title: r.title,
    instructions: r.instructions ?? undefined,
    columns: parseJson<Column[]>(r.columns, []),
    items: parseJson<TaskItem[]>(r.items, []),
    status: r.status,
    decision: parseJson<TaskDecision | null>(r.decision, null),
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    createdAt: r.created_at,
    dryRun: !!r.dry_run,
  };
}

export function listTasks(f: { runId?: string; status?: string }): TaskRecord[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.runId) (where.push('t.run_id = ?'), params.push(f.runId));
  if (f.status) (where.push('t.status = ?'), params.push(f.status));
  return db()
    .all<TaskRow>(
      `SELECT t.*, r.process_name, r.dry_run FROM run_tasks t JOIN runs r ON r.id = t.run_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.created_at DESC LIMIT 500`,
      ...params,
    )
    .map(toTask);
}

export function getTask(id: string): TaskRecord {
  const r = db().get<TaskRow>(
    'SELECT t.*, r.process_name, r.dry_run FROM run_tasks t JOIN runs r ON r.id = t.run_id WHERE t.id = ?',
    id,
  );
  if (!r) throw new HttpError(404, 'Task not found');
  return toTask(r);
}

export function findTask(runId: string, stepKey: string): TaskRecord | undefined {
  const r = db().get<{ id: string }>('SELECT id FROM run_tasks WHERE run_id = ? AND step_key = ?', runId, stepKey);
  return r ? getTask(r.id) : undefined;
}

export function insertTask(t: Omit<TaskRecord, 'status' | 'createdAt' | 'decision' | 'decidedBy' | 'decidedAt'>): void {
  db().run(
    `INSERT INTO run_tasks (id, run_id, step_key, mode, title, instructions, columns, items, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    t.id,
    t.runId,
    t.stepKey,
    t.mode,
    t.title,
    t.instructions ?? null,
    JSON.stringify(t.columns),
    JSON.stringify(t.items),
    nowIso(),
  );
}

export function decideTask(id: string, status: 'completed' | 'cancelled', decision: TaskDecision | null, by: string): void {
  db().run(
    'UPDATE run_tasks SET status = ?, decision = ?, decided_by = ?, decided_at = ? WHERE id = ?',
    status,
    decision ? JSON.stringify(decision) : null,
    by,
    nowIso(),
    id,
  );
}

// ---------- Artifacts ----------

export function addArtifact(a: Omit<RunArtifact, 'createdAt'> & { path: string }): RunArtifact {
  const createdAt = nowIso();
  db().run(
    'INSERT INTO run_artifacts (id, run_id, step_key, kind, name, mime, path, sha256, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    a.id,
    a.runId,
    a.stepKey,
    a.kind,
    a.name,
    a.mime,
    a.path,
    a.sha256,
    a.size,
    createdAt,
  );
  const { path: _p, ...rest } = a;
  return { ...rest, createdAt };
}

export function listArtifacts(runId: string): RunArtifact[] {
  return db()
    .all<{ id: string; run_id: string; step_key: string; kind: 'screenshot' | 'file'; name: string; mime: string; sha256: string; size: number; created_at: string }>(
      'SELECT * FROM run_artifacts WHERE run_id = ? ORDER BY created_at',
      runId,
    )
    .map((a) => ({ id: a.id, runId: a.run_id, stepKey: a.step_key, kind: a.kind, name: a.name, mime: a.mime, sha256: a.sha256, size: a.size, createdAt: a.created_at }));
}

export function artifactFile(id: string): { path: string; mime: string; name: string } {
  const r = db().get<{ path: string; mime: string; name: string }>('SELECT path, mime, name FROM run_artifacts WHERE id = ?', id);
  if (!r) throw new HttpError(404, 'Artifact not found');
  return r;
}

/** Fingerprint of everything recorded for a run (steps, decisions, artifacts). */
export function protocolHash(runId: string): string {
  const steps = db().all<StepRow>('SELECT key, type, status, input, output, error, summary FROM run_steps WHERE run_id = ? ORDER BY key', runId);
  const tasks = db().all('SELECT step_key, status, decision, decided_by, decided_at FROM run_tasks WHERE run_id = ? ORDER BY step_key', runId);
  const arts = db().all('SELECT step_key, name, sha256 FROM run_artifacts WHERE run_id = ? ORDER BY id', runId);
  return sha256(canonicalJson({ steps, tasks, arts }));
}
