import { Cron } from 'croner';
import { refuseResumeWhileHeld } from './libraries/lookup.js';
import { openInputs, sealInputs } from './engine/secret-inputs.js';
import {
  DEFAULT_SCHEDULE_NOTIFY,
  type NotifyPause,
  type ProcessPermission,
  type RunStatus,
  type Schedule,
  type ScheduleCatchUp,
  type ScheduleMissedFires,
  type ScheduleNotify,
  type ScheduleNotifyMode,
} from '@sm/shared';
import { policyOfColumns } from './engine/notify-source.js';
import { resetAlerts } from './engine/check-alerts.js';
import { db } from './db.js';
import { audit } from './audit.js';
import { engine } from './engine/index.js';
import { startProblem } from './engine/commands.js';
import { HttpError, newId, nowIso, parseJson } from './util.js';
import { getProcess, permissionsFor, processPermissionMap } from './processes/service.js';
import { currentUser, runAs } from './auth/context.js';
import { findUserByName, toAuthUser } from './auth/users.js';
import { isAdmin } from './auth/permissions.js';
import { logger } from './log.js';
import { isUnexpected, reportError } from './errorReporting.js';
import { emit, type ScheduleSkipReason } from './events.js';
import { readSetting, writeSetting } from './settings.js';

interface ScheduleRow {
  id: string;
  name: string;
  process_id: string;
  cron: string;
  timezone: string | null;
  inputs: string;
  sealed_inputs?: string | null;
  bindings: string;
  /** Slot → identity id (0.13.0, ADR 0009) */
  identities?: string;
  dry_run: number;
  enabled: number;
  allow_overlap: number;
  last_run_at: string | null;
  last_run_id: string | null;
  created_at: string;
  process_name?: string;
  last_status?: RunStatus | null;
  owner: string | null;
  notify_mode?: ScheduleNotifyMode;
  notify_reminder_hours?: number;
  notify_resolved?: number;
  notify_urgent?: number;
  notify_change?: string;
  notify_channels?: string | null;
  notify_pause?: string | null;
  catch_up?: ScheduleCatchUp | null;
  last_fired_at?: string | null;
  missed?: string | null;
}

const notifyOf = (r: ScheduleRow): ScheduleNotify => policyOfColumns(r, DEFAULT_SCHEDULE_NOTIFY);

const jobs = new Map<string, Cron>();

function toSchedule(r: ScheduleRow, perms?: Map<string, ProcessPermission[]>): Schedule {
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
    identities: parseJson(r.identities ?? '{}', {}),
    dryRun: !!r.dry_run,
    enabled: !!r.enabled,
    allowOverlap: !!r.allow_overlap,
    lastRunAt: r.last_run_at,
    lastRunId: r.last_run_id,
    lastRunStatus: r.last_status ?? null,
    nextRunAt: job?.nextRun()?.toISOString() ?? null,
    createdAt: r.created_at,
    owner: r.owner,
    canEdit: canEditSchedule(r, perms),
    notify: notifyOf(r),
    catchUp: r.catch_up === 'once' ? 'once' : 'none',
    missed: parseJson<ScheduleMissedFires | null>(r.missed ?? null, null),
  };
}

// debug runs: the schedule's own last run, by id (never a debug run)
const SELECT = `SELECT s.*, p.name AS process_name, (SELECT status FROM runs WHERE id = s.last_run_id) AS last_status
  FROM schedules s JOIN processes p ON p.id = s.process_id`;

function canEditSchedule(r: { owner: string | null; process_id: string }, perms?: Map<string, ProcessPermission[]>): boolean {
  const u = currentUser();
  if (!u) return false;
  if (isAdmin(u) || (r.owner && r.owner.toLowerCase() === u.username.toLowerCase())) return true;
  return (perms ? (perms.get(r.process_id) ?? []) : permissionsFor(r.process_id)).includes('manage');
}

/** Schedules of processes the current user can see (the processes' rights read in one statement, not one per schedule). */
export function listSchedules(): Schedule[] {
  const perms = processPermissionMap();
  return db()
    .all<ScheduleRow>(`${SELECT} ORDER BY s.name`)
    .filter((r) => (perms.get(r.process_id) ?? []).includes('view'))
    .map((r) => toSchedule(r, perms));
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

/** An IANA time zone the runtime knows (Europe/Berlin, UTC). */
export function knownTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The next five runs of a cron expression in its time zone. A wrong time zone is named as such (it is not the
 * expression's fault), and both errors carry a code for the translated text.
 */
export function validateCron(cron: string, timezone?: string): string[] {
  if (timezone && !knownTimeZone(timezone)) throw new HttpError(400, `Unknown time zone "${timezone}"`, 'TIME_ZONE_UNKNOWN', { tz: timezone });
  try {
    const c = new Cron(cron, { paused: true, timezone: timezone || undefined });
    const next = c.nextRuns(5).map((d) => d.toISOString());
    c.stop();
    return next;
  } catch (e) {
    throw new HttpError(400, `Invalid cron expression: ${(e as Error).message}`, 'CRON_INVALID', { detail: (e as Error).message });
  }
}

export interface CronWarning {
  code: 'CRON_DAY_OR';
  message: string;
  /** `context: 'suggestion'` when `suggestion` names the expression to use (the web UI's text variant) */
  params: { suggestion?: string; context?: 'suggestion' };
}

const WEEKDAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const restricted = (field: string | undefined) => !!field && field !== '*' && field !== '?';

/**
 * Traps in a cron expression that still parses. Like vixie cron, croner runs on a day when day-of-month **or**
 * day-of-week matches once both are restricted: `0 6 1-7 * 1` ("the first Monday") runs on every day 1–7 and on
 * every Monday. The nth weekday (`1#1`) is what was meant; for a week-long day range the warning names it.
 */
export function cronWarnings(cron: string): CronWarning[] {
  const fields = cron.trim().split(/\s+/);
  if (fields.length < 5 || fields.length > 6) return []; // @daily and friends restrict nothing twice
  const dom = fields[fields.length - 3]!;
  const dow = fields[fields.length - 1]!;
  if (!restricted(dom) || !restricted(dow) || dow.includes('#') || /L|W/i.test(dom)) return [];
  let suggestion: string | undefined;
  const range = /^(\d{1,2})-(\d{1,2})$/.exec(dom);
  const day = /^[0-7]$/.test(dow) ? dow : WEEKDAY_NAMES.includes(dow.toUpperCase()) ? dow.toUpperCase() : undefined;
  if (range && day) {
    const [from, to] = [Number(range[1]), Number(range[2])];
    if (to - from === 6 && (from - 1) % 7 === 0 && from <= 22) {
      const out = [...fields];
      out[out.length - 3] = '*';
      out[out.length - 1] = `${day}#${(from - 1) / 7 + 1}`;
      suggestion = out.join(' ');
    }
  }
  return [
    {
      code: 'CRON_DAY_OR',
      message:
        `Day of month (${dom}) and day of week (${dow}) are both set: the schedule runs on a day when either matches, not only when both do. ` +
        (suggestion
          ? `For the nth weekday of a month use ${suggestion}.`
          : 'For the nth weekday of a month use the # syntax, e.g. 0 6 * * 1#1 (the first Monday).'),
      params: suggestion ? { suggestion, context: 'suggestion' } : {},
    },
  ];
}

type ScheduleInput = Omit<Schedule, 'id' | 'createdAt' | 'processName' | 'lastRunAt' | 'lastRunId' | 'lastRunStatus' | 'nextRunAt' | 'missed'>;

export function saveSchedule(input: ScheduleInput, id?: string): Schedule {
  const proc = getProcess(input.processId);
  // a library on hold (ADR 0014): its schedules stay off until an administrator lifts the hold
  if (input.enabled) refuseResumeWhileHeld({ processId: input.processId });
  validateCron(input.cron, input.timezone);
  const sid = id ?? newId('sch_');
  // inputs of type "secret" are stored encrypted ("***" in the schedule and the audit log)
  const previous = id ? db().get<{ sealed_inputs: string | null }>('SELECT sealed_inputs FROM schedules WHERE id = ?', id)?.sealed_inputs : null;
  const { visible, sealed } = sealInputs(proc.definition.inputs, input.inputs ?? {}, previous);
  input = { ...input, inputs: visible };
  const before = id ? db().get<ScheduleRow>('SELECT * FROM schedules WHERE id = ?', id) : undefined;
  // the pause has its own actions: a save keeps it
  const kept = before ? notifyOf(before) : DEFAULT_SCHEDULE_NOTIFY;
  const notify: ScheduleNotify = input.notify
    ? {
        ...kept,
        ...input.notify,
        change: input.notify.change ?? kept.change,
        channels: input.notify.channels === undefined ? kept.channels : input.notify.channels,
        pause: kept.pause ?? null,
      }
    : kept;
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
      db().run('UPDATE schedules SET sealed_inputs = ? WHERE id = ?', sealed, id);
      // a schedule that stops notifying, or notifies after every run, starts over with its failing checks
      if (before && (before.notify_mode !== notify.mode || (before.notify_change ?? 'result') !== notify.change)) resetAlerts(`schedule:${id}`);
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
      db().run('UPDATE schedules SET sealed_inputs = ? WHERE id = ?', sealed, sid);
    }
    // the identity per slot (0.13.0): missing in the input (an older client) – unchanged
    if (input.identities !== undefined) db().run('UPDATE schedules SET identities = ? WHERE id = ?', JSON.stringify(input.identities), sid);
    // missing in the input (an older client): unchanged
    if (input.catchUp !== undefined || !id) db().run('UPDATE schedules SET catch_up = ? WHERE id = ?', input.catchUp === 'once' ? 'once' : 'none', sid);
    db().run(
      'UPDATE schedules SET notify_mode = ?, notify_reminder_hours = ?, notify_resolved = ?, notify_change = ?, notify_channels = ?, notify_urgent = ? WHERE id = ?',
      notify.mode,
      notify.reminderHours,
      notify.resolved ? 1 : 0,
      notify.change ?? 'result',
      notify.channels ? JSON.stringify(notify.channels) : null,
      notify.urgent ? 1 : 0,
      sid,
    );
    audit({
      action: id ? 'schedule.updated' : 'schedule.created',
      entityType: 'schedule',
      entityId: sid,
      summary: `Schedule "${input.name}" ${id ? 'updated' : 'created'} (${input.cron}${input.enabled ? '' : ', disabled'}${input.dryRun ? ', dry run' : ''})`,
      details: {
        processId: input.processId,
        cron: input.cron,
        timezone: input.timezone,
        inputs: input.inputs,
        bindings: input.bindings,
        ...(input.identities && Object.keys(input.identities).length ? { identities: input.identities } : {}),
        notify,
        ...(input.catchUp ? { catchUp: input.catchUp } : {}),
      },
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
    resetAlerts(`schedule:${id}`);
    audit({ action: 'schedule.deleted', entityType: 'schedule', entityId: id, summary: `Schedule "${s.name}" deleted` });
  });
}

/**
 * Pauses the messages of a schedule's runs (#139) until `until` (null: until resumed), optionally still in the app.
 * Runs, checks and the start page are not affected. Audited as schedule.paused / schedule.resumed.
 */
export function setSchedulePause(id: string, pause: NotifyPause | null, reason?: string): Schedule {
  const s = getSchedule(id);
  db().tx(() => {
    db().run('UPDATE schedules SET notify_pause = ? WHERE id = ?', pause ? JSON.stringify({ ...pause, at: nowIso() }) : null, id);
    audit({
      action: pause ? 'schedule.paused' : 'schedule.resumed',
      entityType: 'schedule',
      entityId: id,
      summary: pause
        ? `Messages of schedule "${s.name}" paused ${pause.until ? `until ${pause.until}` : 'until resumed'}${pause.reason ? `: ${pause.reason}` : ''}`
        : `Messages of schedule "${s.name}" resumed${reason ? ` (${reason})` : ''}`,
      details: pause ? { until: pause.until, reason: pause.reason, inApp: pause.inApp } : { reason: reason ?? null },
    });
  });
  return getSchedule(id);
}

/** After a schedule's `enabled` changed outside saveSchedule (a library on hold, libraries/install.ts): arm or disarm it. */
export function rearmSchedule(id: string): void {
  arm(id);
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
    // every fire of the cron expression counts, also one that is skipped: what came after it is missed if Steward stops
    try {
      db().run('UPDATE schedules SET last_fired_at = ? WHERE id = ?', nowIso(), id);
    } catch (e) {
      logger.warn({ err: e, scheduleId: id }, 'could not record the fire of a schedule');
    }
    fire(id).catch((e) => {
      logger.error({ err: e, scheduleId: id }, 'schedule failed');
      if (isUnexpected(e)) reportError(e, { tags: { phase: 'schedule' } });
    });
  });
  jobs.set(id, job);
}

export async function fire(id: string, manual = false, opts: { catchUp?: boolean } = {}): Promise<string | null> {
  const r = db().get<ScheduleRow>('SELECT * FROM schedules WHERE id = ?', id);
  if (!r) return null;
  if (!r.allow_overlap && r.last_run_id) {
    // debug runs: the schedule's own last run, by id (never a debug run)
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
  // the command layer's start check (ADR 0011), as the owner
  const identities = parseJson<Record<string, string>>(r.identities ?? '{}', {});
  const sp = runner ? startProblem(runner, { processId: r.process_id, bindings: parseJson<Record<string, string>>(r.bindings, {}), identities }) : null;
  const problem: Problem | null = !runner
    ? { text: `owner ${r.owner ?? '(none)'} is missing or disabled`, code: 'ownerMissing', vars: { owner: r.owner ?? '–' } }
    : !sp
      ? null
      : sp.code === 'mayNotUsePlatform' || sp.code === 'platformMissing'
        ? { text: sp.text, code: 'mayNotUsePlatform', vars: { user: runner.username, platform: sp.vars.platform ?? '' } }
        : sp.code === 'identityMissing'
          ? { text: sp.text, code: 'identityMissing', vars: { platform: sp.vars.platform ?? '', identity: sp.vars.identity ?? '' } }
          : sp.code === 'mayNotUseIdentity' || sp.code === 'identityWriteRequired'
            ? { text: sp.text, code: 'mayNotUseIdentity', vars: { user: runner.username, platform: sp.vars.platform ?? '', identity: sp.vars.identity ?? '' } }
            : sp.code === 'actorMissing'
              ? { text: sp.text, code: 'ownerMissing', vars: { owner: r.owner ?? '–' } }
              : { text: `${runner.username} may not run this process`, code: 'mayNotRun', vars: { user: runner.username } };
  if (problem) {
    logger.warn({ scheduleId: id, reason: problem.text }, 'schedule skipped');
    audit({ actor: 'scheduler', action: 'schedule.skipped', entityType: 'schedule', entityId: id, summary: `Schedule "${r.name}" skipped: ${problem.text}` });
    emit('schedule.skipped', { scheduleId: id, name: r.name, owner: r.owner, reason: problem.text, reasonCode: problem.code, reasonVars: problem.vars });
    return null;
  }
  try {
    const { runId } = await runAs(runner, () =>
      engine().start({
        processId: r.process_id,
        inputs: openInputs(parseJson(r.inputs, {}), r.sealed_inputs),
        bindings: parseJson(r.bindings, {}),
        identities,
        mode: r.dry_run ? 'dry' : 'live',
        actor: runner!.username,
        origin: { trigger: 'schedule', scheduleId: id },
      }),
    );
    db().run('UPDATE schedules SET last_run_at = ?, last_run_id = ? WHERE id = ?', nowIso(), runId, id);
    if (opts.catchUp) {
      audit({
        actor: 'scheduler',
        action: 'schedule.caught_up',
        entityType: 'schedule',
        entityId: id,
        runId,
        summary: `Schedule "${r.name}": one catch-up run started for the fires missed while Steward was not running`,
      });
    }
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

// ---------- fires missed while Steward was not running ----------

/** When the scheduler was last known to run (a background job writes it every minute, and the shutdown). */
export const ALIVE_KEY = 'system.schedulerAliveAt';
/** Missed fires listed per schedule (all are counted, up to MISSED_COUNT_LIMIT). */
const MISSED_LISTED = 10;
const MISSED_COUNT_LIMIT = 10000;

let running = false;

/** Records that the scheduler runs now (only while it does: while the vault is locked nothing fires either). */
export function recordAlive(at = new Date()): void {
  if (!running) return;
  try {
    writeSetting(ALIVE_KEY, at.toISOString());
  } catch (err) {
    logger.warn({ err }, 'could not record that the scheduler runs');
  }
}

/** The fires of `cron` after `since` up to `now` (at most MISSED_LISTED listed, all counted up to the limit). */
export function firesBetween(
  cron: string,
  timezone: string | null | undefined,
  since: Date,
  now: Date,
): { times: string[]; count: number; last: string | null } {
  const c = new Cron(cron, { paused: true, timezone: timezone || undefined });
  const times: string[] = [];
  let count = 0;
  let last: Date | null = null;
  try {
    for (let t = c.nextRun(since); t && t.getTime() <= now.getTime() && count < MISSED_COUNT_LIMIT; t = c.nextRun(t)) {
      count++;
      last = t;
      if (times.length < MISSED_LISTED) times.push(t.toISOString());
    }
  } finally {
    c.stop();
  }
  return { times, count, last: last?.toISOString() ?? null };
}

/**
 * At start: compares each enabled schedule's cron expression with the last time the scheduler ran (and the
 * schedule's last fire); fires in between were missed. Each schedule with missed fires gets one event (notification
 * "Missed while Steward was not running"), one audit entry and the record shown on the schedule; with
 * catchUp 'once' one run starts right away. Nothing is recorded on the first start of this version (no time known).
 */
export function detectMissedFires(now = new Date()): { scheduleId: string; count: number; catchUp: boolean }[] {
  const alive = readSetting<string | null>(ALIVE_KEY, null);
  if (!alive || Number.isNaN(Date.parse(alive))) return [];
  const out: { scheduleId: string; count: number; catchUp: boolean }[] = [];
  for (const r of db().all<ScheduleRow>('SELECT * FROM schedules WHERE enabled = 1')) {
    const since = new Date(Math.max(Date.parse(alive), Date.parse(r.last_fired_at ?? '') || 0, Date.parse(r.created_at) || 0));
    if (since.getTime() >= now.getTime()) continue;
    let found: ReturnType<typeof firesBetween>;
    try {
      found = firesBetween(r.cron, r.timezone, since, now);
    } catch (e) {
      logger.warn({ err: e, scheduleId: r.id }, 'could not check a schedule for missed fires');
      continue;
    }
    if (!found.count) continue;
    const catchUp = r.catch_up === 'once';
    const missed: ScheduleMissedFires = {
      detectedAt: now.toISOString(),
      from: since.toISOString(),
      count: found.count,
      times: found.times,
      last: found.last,
      catchUp,
    };
    const listed = found.times.join(', ') + (found.count > found.times.length ? ` … (${found.count} in all)` : '');
    db().tx(() => {
      db().run('UPDATE schedules SET missed = ? WHERE id = ?', JSON.stringify(missed), r.id);
      audit({
        actor: 'scheduler',
        action: 'schedule.missed',
        entityType: 'schedule',
        entityId: r.id,
        summary: `Schedule "${r.name}": missed while Steward was not running: ${listed}${catchUp ? ' – one catch-up run starts' : ''}`,
        details: missed,
      });
    });
    logger.warn(
      { scheduleId: r.id, missed: found.count, first: found.times[0], last: found.last, catchUp },
      'schedule fires missed while Steward was not running',
    );
    emit('schedule.skipped', {
      scheduleId: r.id,
      name: r.name,
      owner: r.owner,
      reason: `missed while Steward was not running: ${listed}`,
      reasonCode: 'missed',
      reasonVars: { count: String(found.count) },
      missed: { times: found.times, count: found.count, catchUp },
    });
    out.push({ scheduleId: r.id, count: found.count, catchUp });
  }
  return out;
}

export function startScheduler(now = new Date()): void {
  let missed: ReturnType<typeof detectMissedFires> = [];
  try {
    missed = detectMissedFires(now);
  } catch (e) {
    logger.error({ err: e }, 'could not check the schedules for missed fires');
    if (isUnexpected(e)) reportError(e, { tags: { phase: 'schedule' } });
  }
  for (const r of db().all<{ id: string }>('SELECT id FROM schedules WHERE enabled = 1')) arm(r.id);
  running = true;
  recordAlive(now);
  for (const m of missed.filter((x) => x.catchUp)) {
    fire(m.scheduleId, false, { catchUp: true }).catch((e) => {
      logger.error({ err: e, scheduleId: m.scheduleId }, 'catch-up run failed');
      if (isUnexpected(e)) reportError(e, { tags: { phase: 'schedule' } });
    });
  }
}

export function stopScheduler(): void {
  // the moment it stops is the last moment it ran (a fire after it is missed)
  recordAlive();
  running = false;
  for (const id of [...jobs.keys()]) disarm(id);
}

export function upcoming(limit = 8): Schedule[] {
  return listSchedules()
    .filter((s) => s.enabled && s.nextRunAt)
    .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))
    .slice(0, limit);
}
