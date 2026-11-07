/**
 * The command layer in front of the engine (ADR 0011, decided question 1): the one place that checks who may start,
 * decide, verify, resume, cancel and debug runs. Every caller that starts or drives runs goes through it – the routes,
 * the scheduler, webhook triggers, monitor outputs, MCP run requests, the dashboard refresh, template bundles, the demo
 * setup and sub-process steps – so the checks cannot drift apart. The engine itself trusts its caller.
 *
 * The checks run as the given user (a schedule's owner, a trigger's owner, a run's actor), or – without one – as the
 * signed-in user of the request, whose assurance proofs (four-eyes) the request's audit entries carry.
 */
import type { DebugAnswers, TaskRecord } from '@sm/shared';
import { HttpError } from '../util.js';
import { currentUser, runAs, type AuthUser } from '../auth/context.js';
import { findUserByName, toAuthUser } from '../auth/users.js';
import { isAdmin } from '../auth/permissions.js';
import { sameIdentity } from '../auth/aliases.js';
import { me } from '../auth/access.js';
import { fourEyesRequired, noteFourEyes } from '../auth/assurance.js';
import { permissionsFor } from '../processes/service.js';
import { getPlatform } from '../platforms/service.js';
import { requireRun, visibleTask } from '../routes/helpers.js';
import * as store from './store.js';
import type { RunSignal } from './engine.js';

/** Why a start is refused – `code` for translated messages (schedule skips use the same codes), `text` in English. */
export interface StartProblem {
  code: 'actorMissing' | 'processNotFound' | 'mayNotRun' | 'mayNotEdit' | 'platformMissing' | 'mayNotUsePlatform';
  status: 403 | 404;
  text: string;
  vars: Record<string, string>;
}

/** What the start check needs to know. */
export interface StartCheck {
  processId: string;
  /** Slot → platform id */
  bindings?: Record<string, string>;
  /**
   * A debug run (ADR 0010): `edit` as well as `run`. A single node needs only the slots it uses, and offline – no
   * platform touched – only `edit`.
   */
  debug?: { kind: 'node' | 'step'; answers?: DebugAnswers; slots?: string[] };
}

/** A user by name for the checks (a run's actor), or null when missing or deactivated. */
export function userByName(name: string): AuthUser | null {
  const u = findUserByName(name);
  return u && u.active ? toAuthUser(u) : null;
}

/** Runs `fn` with `user`'s rights; without a user (or the request's own), in the current request. */
function asUser<T>(user: AuthUser | undefined, fn: () => T): T {
  return !user || user === currentUser() ? fn() : runAs(user, fn);
}

/**
 * Why `user` may not start this run, or null. `user`: whose rights the run carries – undefined for the signed-in
 * user, a string for a user by name (a run's actor), null when the owner is gone.
 */
export function startProblem(user: AuthUser | string | null | undefined, cmd: StartCheck): StartProblem | null {
  let u: AuthUser | undefined;
  if (user === null || typeof user === 'string') {
    const found = user ? userByName(user) : null;
    if (!found) return { code: 'actorMissing', status: 403, text: `${user || 'the owner'} is missing or deactivated`, vars: { owner: user || '–' } };
    u = found;
  } else u = user;
  const name = u?.username ?? currentUser()?.username ?? 'system';
  return asUser(u, (): StartProblem | null => {
    let perms: string[];
    try {
      perms = permissionsFor(cmd.processId);
    } catch {
      perms = [];
    }
    // a process the user may not see answers like a missing one
    if (!perms.includes('view')) return { code: 'processNotFound', status: 404, text: `Process ${cmd.processId} not found`, vars: { process: cmd.processId } };
    const d = cmd.debug;
    if (d && !perms.includes('edit')) return { code: 'mayNotEdit', status: 403, text: `${name} may not edit this process`, vars: { user: name } };
    // an offline single node contacts nothing: edit is enough (like the expression assistant)
    if (d?.kind === 'node' && d.answers === 'offline') return null;
    if (!perms.includes('run')) return { code: 'mayNotRun', status: 403, text: `${name} may not run this process`, vars: { user: name } };
    const slots = d?.kind === 'node' ? new Set(d.slots ?? []) : null;
    for (const [slot, pid] of Object.entries(cmd.bindings ?? {})) {
      if (slots && !slots.has(slot)) continue;
      let ok: boolean;
      try {
        ok = getPlatform(pid).permissions.includes('use');
      } catch {
        return { code: 'platformMissing', status: 404, text: `platform ${pid} no longer exists`, vars: { platform: pid } };
      }
      if (!ok) return { code: 'mayNotUsePlatform', status: 403, text: `${name} may not use platform ${pid}`, vars: { user: name, platform: pid } };
    }
    return null;
  });
}

/** The start check as an error (403/404; FORBIDDEN with the missing right, as the routes always answered). */
export function authorizeStart(user: AuthUser | string | null | undefined, cmd: StartCheck): void {
  const p = startProblem(user, cmd);
  if (!p) return;
  if (p.code === 'processNotFound') throw new HttpError(404, p.text);
  if (p.code === 'platformMissing') throw new HttpError(404, `Platform ${p.vars.platform} not found`, 'PLATFORM_NOT_FOUND', { id: p.vars.platform! });
  if (p.code === 'actorMissing') throw new HttpError(403, `The run's owner ${p.vars.owner} is missing or deactivated`, 'FORBIDDEN');
  const right = p.code === 'mayNotEdit' ? 'edit' : p.code === 'mayNotRun' ? 'run' : 'use';
  const what = right === 'use' ? `use platform ${p.vars.platform}` : right === 'edit' ? 'debug this process' : 'run this process';
  throw new HttpError(403, `You are not allowed to ${what}`, 'FORBIDDEN', { context: `right_${right}` });
}

/**
 * Who may send this signal (the signed-in user). A decision or manual step: the task must be visible, open for it
 * and decidable by this person; four-eyes is noted for the audit entry (auth/assurance.ts). Resume: `run`. Debug
 * signals: only the person who started the debug run. Returns the task a task signal is about.
 */
export function authorizeSignal(
  runId: string | null,
  s: RunSignal | { type: 'task.decide' | 'manual.complete' | 'manual.verify'; taskId: string },
): TaskRecord | undefined {
  if (s.type === 'task.decide' || s.type === 'manual.complete' || s.type === 'manual.verify') {
    // the one task (not a search of the newest tasks: an older open step is decidable too)
    const t = visibleTask(s.taskId);
    if (!t) throw new HttpError(404, 'Task not found', 'TASK_NOT_FOUND');
    const deny = (fallback: string) => {
      throw new HttpError(403, t.cannotDecideReason ?? fallback, t.cannotDecideCode ?? 'FORBIDDEN', t.cannotDecideParams);
    };
    if (s.type === 'manual.verify') {
      if (t.mode !== 'manual' || t.manual?.stage !== 'verify')
        throw new HttpError(409, 'This step does not wait for a verification', 'TASK_NOT_IN_VERIFICATION');
      if (!t.canDecide) deny('You may not verify this step');
      noteFourEyes('manualStep.verify', [t.manual.submission?.completedBy, ...(t.manual.submission?.evidence ?? []).map((e) => e.uploadedBy)], me());
      return t;
    }
    if (t.manual?.stage === 'verify') throw new HttpError(409, 'This step was completed and waits for its verification', 'TASK_WAITS_FOR_VERIFICATION');
    if (!t.canDecide) deny('You may not decide this task');
    if (s.type === 'task.decide' && t.mode === 'manual') throw new HttpError(400, 'Complete a manual step with its checklist and fields', 'TASK_IS_MANUAL');
    // the assurance proof: the run's starter asked, this person decides
    if (s.type === 'task.decide' && fourEyesRequired('run.decide', t.fourEyes)) noteFourEyes('run.decide', [t.startedBy], me(), { itemRequires: t.fourEyes });
    return t;
  }
  if (!runId) throw new HttpError(400, 'A run is needed for this signal');
  if (s.type === 'resume') {
    requireRun(runId, 'run', 'resume this run');
    return undefined;
  }
  // debug signals: the debugger alone drives the run
  const r = requireRun(runId, 'view', 'view this run');
  if (!r.debug) throw new HttpError(409, 'Not a debug run', 'DEBUG_NOT_A_DEBUG_RUN');
  if (!sameIdentity(r.actor, me())) throw new HttpError(403, 'Only the person who started this debug run can drive it', 'DEBUG_NOT_STARTER');
  return undefined;
}

/** Who may cancel a run: `run` on its process; a debug run only its starter or an administrator. */
export function authorizeCancel(runId: string): store.RunRow {
  const r = requireRun(runId, 'run', 'cancel this run');
  if (r.debug && !sameIdentity(r.actor, me()) && !isAdmin(currentUser()))
    throw new HttpError(403, 'Only the person who started this debug run or an administrator can stop it', 'DEBUG_NOT_STARTER');
  return r;
}
