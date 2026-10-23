import type {
  Column,
  RunChild,
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

export interface RunRow {
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
  parent_run_id?: string | null;
  parent_step_key?: string | null;
  outputs?: string | null;
  trigger_id?: string | null;
  trigger_name?: string | null;
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
  assignees: string;
  four_eyes: number;
  process_id?: string;
  run_actor?: string;
}

export function runRow(id: string): RunRow {
  const r = db().get<RunRow>('SELECT * FROM runs WHERE id = ?', id);
  if (!r) throw new HttpError(404, `Run ${id} not found`);
  return r;
}

function toSummary(r: RunRow & { open_tasks?: number }): RunSummary {
  const stats = { ...emptyStats(), ...parseJson<Partial<RunStats>>(r.stats, {}) };
  stats.openTasks = r.open_tasks ?? db().get<{ n: number }>("SELECT COUNT(*) AS n FROM run_tasks WHERE run_id = ? AND status = 'open'", r.id)!.n;
  return {
    id: r.id,
    processId: r.process_id,
    processName: r.process_name,
    processVersion: r.process_version,
    status: r.status,
    dryRun: !!r.dry_run,
    trigger: r.trigger,
    scheduleId: r.schedule_id,
    ...(r.trigger_id ? { triggerId: r.trigger_id, triggerName: r.trigger_name ?? null } : {}),
    actor: r.actor,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    error: r.error,
    stats,
    parentRunId: r.parent_run_id ?? null,
    parentStepKey: r.parent_step_key ?? null,
  };
}

export function listRuns(f: { processId?: string; status?: string; scheduleId?: string; limit?: number; before?: string; since?: string }): RunSummary[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.processId) (where.push('process_id = ?'), params.push(f.processId));
  if (f.status)
    (where.push(
      `status IN (${f.status
        .split(',')
        .map(() => '?')
        .join(',')})`,
    ),
      params.push(...f.status.split(',')));
  if (f.scheduleId) (where.push('schedule_id = ?'), params.push(f.scheduleId));
  if (f.before) (where.push('started_at < ?'), params.push(f.before));
  if (f.since) (where.push('started_at > ?'), params.push(f.since));
  params.push(Math.min(f.limit ?? 100, 1000));
  return db()
    .all<RunRow & { open_tasks: number }>(
      `SELECT runs.*, (SELECT COUNT(*) FROM run_tasks t WHERE t.run_id = runs.id AND t.status = 'open') AS open_tasks
       FROM runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY started_at DESC LIMIT ?`,
      ...params,
    )
    .map(toSummary);
}

/** Keyset-paginated run list (newest first) for the public API. */
export interface RunPageFilter {
  /** Restrict to these processes (visibility); an empty list matches nothing. */
  processIds?: string[];
  status?: string[];
  trigger?: string[];
  dryRun?: boolean;
  scheduleId?: string;
  parentRunId?: string;
  /** started_at >= from (ISO 8601, normalised) */
  from?: string;
  /** started_at < to */
  to?: string;
  /** Continue after this run (exclusive) */
  after?: { startedAt: string; id: string };
  limit: number;
}

export function listRunsPage(f: RunPageFilter): RunSummary[] {
  const where: string[] = [];
  const params: unknown[] = [];
  const inList = (col: string, vals: string[]) => (where.push(`${col} IN (${vals.map(() => '?').join(',')})`), params.push(...vals));
  if (f.processIds) {
    if (!f.processIds.length) return [];
    inList('process_id', f.processIds);
  }
  if (f.status?.length) inList('status', f.status);
  if (f.trigger?.length) inList('trigger', f.trigger);
  if (f.dryRun !== undefined) (where.push('dry_run = ?'), params.push(f.dryRun ? 1 : 0));
  if (f.scheduleId) (where.push('schedule_id = ?'), params.push(f.scheduleId));
  if (f.parentRunId) (where.push('parent_run_id = ?'), params.push(f.parentRunId));
  if (f.from) (where.push('started_at >= ?'), params.push(f.from));
  if (f.to) (where.push('started_at < ?'), params.push(f.to));
  if (f.after) (where.push('(started_at < ? OR (started_at = ? AND id < ?))'), params.push(f.after.startedAt, f.after.startedAt, f.after.id));
  params.push(f.limit);
  return db()
    .all<RunRow>(`SELECT * FROM runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY started_at DESC, id DESC LIMIT ?`, ...params)
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
    outputs: parseJson<Record<string, unknown> | null>(r.outputs ?? null, null),
    children: listChildRuns(id),
  };
}

// ---------- Sub-process runs ----------

export function listChildRuns(runId: string): RunChild[] {
  return db()
    .all<{
      id: string;
      process_id: string;
      process_name: string;
      status: RunStatus;
      parent_step_key: string | null;
      started_at: string;
      finished_at: string | null;
    }>(
      'SELECT id, process_id, process_name, status, parent_step_key, started_at, finished_at FROM runs WHERE parent_run_id = ? ORDER BY started_at, rowid',
      runId,
    )
    .map((c) => ({
      id: c.id,
      processId: c.process_id,
      processName: c.process_name,
      status: c.status,
      parentStepKey: c.parent_step_key,
      startedAt: c.started_at,
      finishedAt: c.finished_at,
    }));
}

/** Most recent child run started by a step of a run (re-attach on resume). */
export function latestChildRun(runId: string, stepKey: string): { id: string; status: RunStatus } | undefined {
  return db().get<{ id: string; status: RunStatus }>(
    'SELECT id, status FROM runs WHERE parent_run_id = ? AND parent_step_key = ? ORDER BY started_at DESC, rowid DESC LIMIT 1',
    runId,
    stepKey,
  );
}

/** Child runs that are not finished yet. */
export function unfinishedChildRuns(runId: string): string[] {
  return db()
    .all<{ id: string }>("SELECT id FROM runs WHERE parent_run_id = ? AND status NOT IN ('succeeded', 'failed', 'cancelled')", runId)
    .map((r) => r.id);
}

/** The run and its ancestors (nearest first). */
export function ancestorChain(runId: string): { id: string; processId: string }[] {
  const out: { id: string; processId: string }[] = [];
  let cur: string | null | undefined = runId;
  const seen = new Set<string>();
  while (cur && !seen.has(cur) && out.length < 50) {
    seen.add(cur);
    const r: { id: string; process_id: string; parent_run_id: string | null } | undefined = db().get(
      'SELECT id, process_id, parent_run_id FROM runs WHERE id = ?',
      cur,
    );
    if (!r) break;
    out.push({ id: r.id, processId: r.process_id });
    cur = r.parent_run_id;
  }
  return out;
}

export function saveOutputs(runId: string, outputs: Record<string, unknown>): void {
  db().run('UPDATE runs SET outputs = ? WHERE id = ?', JSON.stringify(outputs), runId);
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

export function finishStep(runId: string, key: string, f: { status: StepStatus; output?: unknown; summary?: string; error?: string; startedMs: number }): void {
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

/** Journal entries of a run in execution order, paginated by row id (public API). Outputs are previews. */
export function listStepsPage(runId: string, f: { afterId?: number; limit: number; status?: string[]; type?: string }): RunStepRecord[] {
  const where = ['run_id = ?'];
  const params: unknown[] = [runId];
  if (f.afterId !== undefined) (where.push('id > ?'), params.push(f.afterId));
  if (f.status?.length) (where.push(`status IN (${f.status.map(() => '?').join(',')})`), params.push(...f.status));
  if (f.type) (where.push('type = ?'), params.push(f.type));
  params.push(f.limit);
  return db()
    .all<StepRow>(`SELECT * FROM run_steps WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`, ...params)
    .map((r) => stepRecord(r));
}

/** Number of journal entries of a run per status. */
export function stepStatusCounts(runId: string): Record<string, number> {
  return Object.fromEntries(
    db()
      .all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM run_steps WHERE run_id = ? GROUP BY status ORDER BY status', runId)
      .map((r) => [r.status, Number(r.n)]),
  );
}

/** Check results of a run (journal entries of type "check"). */
export function listChecks(
  runId: string,
): { stepKey: string; name: string; status: StepStatus; passed: boolean; severity: string; message: string; finishedAt: string | null }[] {
  return db()
    .all<StepRow>("SELECT * FROM run_steps WHERE run_id = ? AND type = 'check' ORDER BY id", runId)
    .map((s) => {
      const o = parseJson<{ passed?: boolean; severity?: string; message?: string }>(s.output, {});
      return {
        stepKey: s.key,
        name: s.name,
        status: s.status,
        passed: o.passed ?? s.status === 'succeeded',
        severity: o.severity ?? 'error',
        message: o.message ?? s.error ?? '',
        finishedAt: s.finished_at,
      };
    });
}

/** Run log entries paginated by id (public API). */
export function listLogsPage(runId: string, f: { afterId?: number; limit: number; level?: string[] }): RunLog[] {
  const where = ['run_id = ?'];
  const params: unknown[] = [runId];
  if (f.afterId !== undefined) (where.push('id > ?'), params.push(f.afterId));
  if (f.level?.length) (where.push(`level IN (${f.level.map(() => '?').join(',')})`), params.push(...f.level));
  params.push(f.limit);
  return db()
    .all<{ id: number; ts: string; level: RunLog['level']; step_key: string | null; message: string; data: string | null }>(
      `SELECT * FROM run_logs WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`,
      ...params,
    )
    .map((l) => ({ id: l.id, ts: l.ts, level: l.level, stepKey: l.step_key, message: l.message, data: parseJson(l.data, undefined) }));
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
    processId: r.process_id,
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
    assignees: parseJson<string[]>(r.assignees, []),
    fourEyes: !!r.four_eyes,
    startedBy: r.run_actor,
  };
}

/** Process of a task's run (for permission checks). */
export function taskProcessId(taskId: string): string {
  const r = db().get<{ process_id: string }>('SELECT r.process_id FROM run_tasks t JOIN runs r ON r.id = t.run_id WHERE t.id = ?', taskId);
  if (!r) throw new HttpError(404, 'Task not found');
  return r.process_id;
}

export function listTasks(f: { runId?: string; status?: string }): TaskRecord[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.runId) (where.push('t.run_id = ?'), params.push(f.runId));
  if (f.status) (where.push('t.status = ?'), params.push(f.status));
  return db()
    .all<TaskRow>(
      `SELECT t.*, r.process_name, r.dry_run, r.process_id, r.actor AS run_actor FROM run_tasks t JOIN runs r ON r.id = t.run_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.created_at DESC LIMIT 500`,
      ...params,
    )
    .map(toTask);
}

/** Keyset-paginated task list (newest first) for the public API. */
export function listTasksPage(f: {
  processIds: string[];
  status?: string[];
  runId?: string;
  after?: { createdAt: string; id: string };
  limit: number;
}): (TaskRecord & { processId: string })[] {
  if (!f.processIds.length) return [];
  const where = [`r.process_id IN (${f.processIds.map(() => '?').join(',')})`];
  const params: unknown[] = [...f.processIds];
  if (f.status?.length) (where.push(`t.status IN (${f.status.map(() => '?').join(',')})`), params.push(...f.status));
  if (f.runId) (where.push('t.run_id = ?'), params.push(f.runId));
  if (f.after) (where.push('(t.created_at < ? OR (t.created_at = ? AND t.id < ?))'), params.push(f.after.createdAt, f.after.createdAt, f.after.id));
  params.push(f.limit);
  return db()
    .all<TaskRow>(
      `SELECT t.*, r.process_name, r.dry_run, r.process_id, r.actor AS run_actor FROM run_tasks t JOIN runs r ON r.id = t.run_id
       WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC, t.id DESC LIMIT ?`,
      ...params,
    )
    .map((r) => ({ ...toTask(r), processId: r.process_id ?? '' }));
}

export function getTask(id: string): TaskRecord {
  const r = db().get<TaskRow>(
    'SELECT t.*, r.process_name, r.dry_run, r.process_id, r.actor AS run_actor FROM run_tasks t JOIN runs r ON r.id = t.run_id WHERE t.id = ?',
    id,
  );
  if (!r) throw new HttpError(404, 'Task not found');
  return toTask(r);
}

export function findTask(runId: string, stepKey: string): TaskRecord | undefined {
  const r = db().get<{ id: string }>('SELECT id FROM run_tasks WHERE run_id = ? AND step_key = ?', runId, stepKey);
  return r ? getTask(r.id) : undefined;
}

export function insertTask(t: Omit<TaskRecord, 'status' | 'createdAt' | 'decision' | 'decidedBy' | 'decidedAt' | 'startedBy' | 'canDecide'>): void {
  db().run(
    `INSERT INTO run_tasks (id, run_id, step_key, mode, title, instructions, columns, items, status, created_at, assignees, four_eyes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
    t.id,
    t.runId,
    t.stepKey,
    t.mode,
    t.title,
    t.instructions ?? null,
    JSON.stringify(t.columns),
    JSON.stringify(t.items),
    nowIso(),
    JSON.stringify(t.assignees ?? []),
    t.fourEyes ? 1 : 0,
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
    .all<{
      id: string;
      run_id: string;
      step_key: string;
      kind: 'screenshot' | 'file';
      name: string;
      mime: string;
      sha256: string;
      size: number;
      created_at: string;
    }>('SELECT * FROM run_artifacts WHERE run_id = ? ORDER BY created_at', runId)
    .map((a) => ({
      id: a.id,
      runId: a.run_id,
      stepKey: a.step_key,
      kind: a.kind,
      name: a.name,
      mime: a.mime,
      sha256: a.sha256,
      size: a.size,
      createdAt: a.created_at,
    }));
}

export function artifactFile(id: string): { path: string; mime: string; name: string; runId: string } {
  const r = db().get<{ path: string; mime: string; name: string; runId: string }>(
    'SELECT path, mime, name, run_id AS "runId" FROM run_artifacts WHERE id = ?',
    id,
  );
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
