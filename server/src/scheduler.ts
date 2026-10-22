import { Cron } from 'croner';
import type { RunStatus, Schedule } from '@sm/shared';
import { db } from './db.js';
import { audit } from './audit.js';
import { startRun } from './engine/runner.js';
import { HttpError, newId, nowIso, parseJson } from './util.js';
import { getProcess, permissionsFor } from './processes/service.js';
import { getPlatform } from './platforms/service.js';
import { currentUser, runAs } from './auth/context.js';
import { findUserByName, toAuthUser } from './auth/users.js';
import { isAdmin } from './auth/permissions.js';
import { logger } from './log.js';
import { emit, type ScheduleSkipReason } from './events.js';

interface ScheduleRow {
  id: string;
  name: string;
  process_id: string;
  cron: string;
  timezone: string | null;
  inputs: string;
  bindings: string;
  dry_run: number;
  enabled: number;
  allow_overlap: number;
  last_run_at: string | null;
  last_run_id: string | null;
  created_at: string;
  process_name?: string;
  last_status?: RunStatus | null;
  owner: string | null;
}

const jobs = new Map<string, Cron>();

function toSchedule(r: ScheduleRow): Schedule {
  const job = jobs.get(r.id);
  return {
    id: r.id,
    name: r.name,
    processId: r.process_id,
    processName: r.process_name,
    cron: r.cron,
    timezone: r.timezone ?? undefined,
    inputs: parseJson(r.inputs, {}),
    bindings: parseJson(r.bindings, {}),
    dryRun: !!r.dry_run,
    enabled: !!r.enabled,
    allowOverlap: !!r.allow_overlap,
    lastRunAt: r.last_run_at,
    lastRunId: r.last_run_id,
    lastRunStatus: r.last_status ?? null,
    nextRunAt: job?.nextRun()?.toISOString() ?? null,
    createdAt: r.created_at,
    owner: r.owner,
    canEdit: canEditSchedule(r),
  };
}

const SELECT = `SELECT s.*, p.name AS process_name, (SELECT status FROM runs WHERE id = s.last_run_id) AS last_status
  FROM schedules s JOIN processes p ON p.id = s.process_id`;

function canEditSchedule(r: { owner: string | null; process_id: string }): boolean {
  const u = currentUser();
  if (!u) return false;
  if (isAdmin(u) || (r.owner && r.owner.toLowerCase() === u.username.toLowerCase())) return true;
  return permissionsFor(r.process_id).includes('manage');
}

/** Schedules of processes the current user can see. */
export function listSchedules(): Schedule[] {
  return db()
    .all<ScheduleRow>(`${SELECT} ORDER BY s.name`)
    .filter((r) => permissionsFor(r.process_id).includes('view'))
    .map(toSchedule);
}

export function requireScheduleEdit(id: string): void {
  const r = db().get<ScheduleRow>('SELECT * FROM schedules WHERE id = ?', id);
  if (!r) throw new HttpError(404, 'Schedule not found');
  if (!canEditSchedule(r)) throw new HttpError(403, 'Only the owner, an administrator or a process manager can change this schedule');
}

export function getSchedule(id: string): Schedule {
  const r = db().get<ScheduleRow>(`${SELECT} WHERE s.id = ?`, id);
  if (!r) throw new HttpError(404, 'Schedule not found');
  return toSchedule(r);
}

export function validateCron(cron: string, timezone?: string): string[] {
  try {
    const c = new Cron(cron, { paused: true, timezone: timezone || undefined });
    const next = c.nextRuns(5).map((d) => d.toISOString());
    c.stop();
    return next;
  } catch (e) {
    throw new HttpError(400, `Invalid cron expression: ${(e as Error).message}`);
  }
}

type ScheduleInput = Omit<Schedule, 'id' | 'createdAt' | 'processName' | 'lastRunAt' | 'lastRunId' | 'lastRunStatus' | 'nextRunAt'>;

export function saveSchedule(input: ScheduleInput, id?: string): Schedule {
  getProcess(input.processId);
  validateCron(input.cron, input.timezone);
  const sid = id ?? newId('sch_');
  db().tx(() => {
    if (id) {
      const r = db().run(
        `UPDATE schedules SET name=?, process_id=?, cron=?, timezone=?, inputs=?, bindings=?, dry_run=?, enabled=?, allow_overlap=? WHERE id=?`,
        input.name,
        input.processId,
        input.cron,
        input.timezone ?? null,
        JSON.stringify(input.inputs ?? {}),
        JSON.stringify(input.bindings ?? {}),
        input.dryRun ? 1 : 0,
        input.enabled ? 1 : 0,
        input.allowOverlap ? 1 : 0,
        id,
      );
      if (!r.changes) throw new HttpError(404, 'Schedule not found');
    } else {
      db().run(
        `INSERT INTO schedules (id, name, process_id, cron, timezone, inputs, bindings, dry_run, enabled, allow_overlap, created_at, owner)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        sid,
        input.name,
        input.processId,
        input.cron,
        input.timezone ?? null,
        JSON.stringify(input.inputs ?? {}),
        JSON.stringify(input.bindings ?? {}),
        input.dryRun ? 1 : 0,
        input.enabled ? 1 : 0,
        input.allowOverlap ? 1 : 0,
        nowIso(),
        currentUser()?.username ?? null,
      );
    }
    audit({
      action: id ? 'schedule.updated' : 'schedule.created',
      entityType: 'schedule',
      entityId: sid,
      summary: `Schedule "${input.name}" ${id ? 'updated' : 'created'} (${input.cron}${input.enabled ? '' : ', disabled'}${input.dryRun ? ', dry run' : ''})`,
      details: { processId: input.processId, cron: input.cron, timezone: input.timezone, inputs: input.inputs, bindings: input.bindings },
    });
  });
  arm(sid);
  return getSchedule(sid);
}

export function deleteSchedule(id: string): void {
  const s = getSchedule(id);
  disarm(id);
  db().tx(() => {
    db().run('DELETE FROM schedules WHERE id = ?', id);
    audit({ action: 'schedule.deleted', entityType: 'schedule', entityId: id, summary: `Schedule "${s.name}" deleted` });
  });
}

function disarm(id: string) {
  jobs.get(id)?.stop();
  jobs.delete(id);
}

function arm(id: string) {
  disarm(id);
  const r = db().get<ScheduleRow>('SELECT * FROM schedules WHERE id = ?', id);
  if (!r || !r.enabled) return;
  const job = new Cron(r.cron, { timezone: r.timezone || undefined, protect: true }, () => {
    fire(id).catch((e) => logger.error({ err: e, scheduleId: id }, 'schedule failed'));
  });
  jobs.set(id, job);
}

export async function fire(id: string, manual = false): Promise<string | null> {
  const r = db().get<ScheduleRow>('SELECT * FROM schedules WHERE id = ?', id);
  if (!r) return null;
  if (!r.allow_overlap && r.last_run_id) {
    const last = db().get<{ status: string }>('SELECT status FROM runs WHERE id = ?', r.last_run_id);
    if (last && ['running', 'waiting', 'queued'].includes(last.status)) {
      audit({
        actor: 'scheduler',
        action: 'schedule.skipped',
        entityType: 'schedule',
        entityId: id,
        summary: `Schedule "${r.name}" skipped: previous run ${r.last_run_id} is still ${last.status}`,
      });
      emit('schedule.skipped', {
        scheduleId: id,
        name: r.name,
        owner: r.owner,
        reason: `previous run ${r.last_run_id} is still ${last.status}`,
        reasonCode: 'overlap',
        reasonVars: { runId: r.last_run_id, status: last.status },
      });
      return null;
    }
  }
  // Scheduled runs execute with the rights of the schedule owner.
  const owner = r.owner ? findUserByName(r.owner) : undefined;
  const runner = manual ? currentUser() : owner && owner.active ? toAuthUser(owner) : null;
  // `text` is English (log and audit); code + vars let notifications say the same in the recipient's language.
  type Problem = { text: string; code: ScheduleSkipReason; vars: Record<string, string> };
  const problem: Problem | null = !runner
    ? { text: `owner ${r.owner ?? '(none)'} is missing or disabled`, code: 'ownerMissing', vars: { owner: r.owner ?? '–' } }
    : runAs(runner, (): Problem | null => {
        if (!permissionsFor(r.process_id).includes('run')) {
          return { text: `${runner.username} may not run this process`, code: 'mayNotRun', vars: { user: runner.username } };
        }
        for (const pid of Object.values(parseJson<Record<string, string>>(r.bindings, {}))) {
          if (!getPlatform(pid).permissions.includes('use')) {
            return { text: `${runner.username} may not use platform ${pid}`, code: 'mayNotUsePlatform', vars: { user: runner.username, platform: pid } };
          }
        }
        return null;
      });
  if (problem) {
    logger.warn({ scheduleId: id, reason: problem.text }, 'schedule skipped');
    audit({ actor: 'scheduler', action: 'schedule.skipped', entityType: 'schedule', entityId: id, summary: `Schedule "${r.name}" skipped: ${problem.text}` });
    emit('schedule.skipped', { scheduleId: id, name: r.name, owner: r.owner, reason: problem.text, reasonCode: problem.code, reasonVars: problem.vars });
    return null;
  }
  try {
    const runId = await runAs(runner, () =>
      startRun(
        { processId: r.process_id, inputs: parseJson(r.inputs, {}), bindings: parseJson(r.bindings, {}), dryRun: !!r.dry_run },
        { trigger: 'schedule', scheduleId: id, actor: runner!.username },
      ),
    );
    db().run('UPDATE schedules SET last_run_at = ?, last_run_id = ? WHERE id = ?', nowIso(), runId, id);
    return runId;
  } catch (e) {
    audit({
      actor: 'scheduler',
      action: 'schedule.failed',
      entityType: 'schedule',
      entityId: id,
      summary: `Schedule "${r.name}" could not start: ${(e as Error).message}`,
    });
    return null;
  }
}

export function startScheduler(): void {
  for (const r of db().all<{ id: string }>('SELECT id FROM schedules WHERE enabled = 1')) arm(r.id);
}

export function stopScheduler(): void {
  for (const id of [...jobs.keys()]) disarm(id);
}

export function upcoming(limit = 8): Schedule[] {
  return listSchedules()
    .filter((s) => s.enabled && s.nextRunAt)
    .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))
    .slice(0, limit);
}
