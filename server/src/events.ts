import { EventEmitter } from 'node:events';
import { logger } from './log.js';

/** Why a schedule did not start a run (translated in notifications). */
export type ScheduleSkipReason = 'overlap' | 'ownerMissing' | 'mayNotRun' | 'mayNotUsePlatform';

/**
 * In-process domain events. Producers (engine, scheduler, datasets, HTTP client)
 * emit; consumers (notifications, metrics) subscribe. Listeners must never throw
 * into producers – emit() isolates them.
 */
export interface DomainEvents {
  'run.started': { runId: string; processId: string; processName: string; actor: string; trigger: string; dryRun: boolean };
  'run.finished': {
    runId: string;
    processId: string;
    processName: string;
    actor: string;
    trigger: string;
    scheduleId?: string | null;
    dryRun: boolean;
    status: 'succeeded' | 'failed' | 'cancelled';
    error?: string;
    durationMs: number;
  };
  'step.finished': { runId: string; processId: string; nodeType: string; status: string; durationMs: number };
  'task.created': {
    taskId: string;
    runId: string;
    processId: string;
    processName: string;
    title: string;
    assignees: string[];
    fourEyes: boolean;
    runActor: string;
    /** The run is a dry run: the task is real (the run waits for it), the message says it is a test */
    dryRun: boolean;
  };
  'task.completed': { taskId: string; runId: string };
  /** A manual step was completed and waits for a second person */
  'task.verification_needed': {
    taskId: string;
    runId: string;
    processId: string;
    processName: string;
    title: string;
    completedBy: string;
    runActor: string;
    dryRun: boolean;
  };
  /** The verifier sent a manual step back to the person who completed it */
  'task.returned': {
    taskId: string;
    runId: string;
    processId: string;
    processName: string;
    title: string;
    completedBy: string;
    rejectedBy: string;
    comment: string;
    dryRun: boolean;
  };
  'check.failed': {
    runId: string;
    processId: string;
    processName: string;
    check: string;
    severity: string;
    message: string;
    dryRun: boolean;
    /**
     * Runs of a source with a policy (#127, #139): new – started failing; changed – another result; reminder – still
     * failing; every – the source notifies after every run; pauseEnded – a pause ended while the check still fails.
     * Missing: a run started by hand (as before).
     */
    phase?: 'new' | 'changed' | 'reminder' | 'every' | 'pauseEnded';
    /** The schedule of the source (kept for webhook receivers) */
    scheduleId?: string;
    /** Key of the source: schedule:<id>, trigger:<id>, monitor:<id>:<output> */
    source?: string;
    /** When the check started failing (runs of a source) */
    since?: string;
  } & CheckContent;
  /** A check of a source's run passes again (the source asked for this message) */
  'check.resolved': {
    runId: string;
    processId: string;
    processName: string;
    check: string;
    dryRun: boolean;
    scheduleId?: string;
    source?: string;
    since: string;
  } & CheckContent;
  'http.request': { host: string; method: string; status: number; durationMs: number; error?: boolean };
  'dataset.published': { key: string; title: string; processId: string; staleAfterMinutes?: number };
  /** A record moved to another status (records workflow) or went back to draft (action "revise") */
  'record.transitioned': { recordId: string; typeId: string; action: string; to: string };
  /** reason: English text (logs, audit); reasonCode + reasonVars: for translated notifications */
  'schedule.skipped': {
    scheduleId: string;
    name: string;
    owner: string | null;
    reason: string;
    reasonCode?: ScheduleSkipReason;
    reasonVars?: Record<string, string>;
  };
  /** MCP endpoint: one per JSON-RPC message (outcome ok, error or a refusal reason) */
  'mcp.request': { method: string; outcome: string };
  /** MCP tool call (outcome ok, error = reported to the client, failed = internal error) */
  'mcp.tool': { tool: string; outcome: string };
  /** MCP platform gateway call (outcome ok, http_error, failed or a refusal reason) */
  'mcp.gateway': { platformId: string; outcome: string };
}

/** What the process author added for the messages of a check (#144), all optional. */
export interface CheckContent {
  checkId?: string;
  headline?: string;
  value?: number;
  previousValue?: number;
  /** better / worse / same: from the value (betterWhen), else from the severity */
  direction?: 'better' | 'worse' | 'same';
  items?: string[];
  /** A living document (rec_…) or an http(s) URL */
  runbook?: string | null;
}

type Name = keyof DomainEvents;
const emitter = new EventEmitter();
emitter.setMaxListeners(50);

export function on<K extends Name>(name: K, fn: (e: DomainEvents[K]) => void | Promise<void>): () => void {
  const wrapped = (e: DomainEvents[K]) => {
    try {
      const r = fn(e);
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch((err) => logger.warn({ err, event: name }, 'event listener failed'));
      }
    } catch (err) {
      logger.warn({ err, event: name }, 'event listener failed');
    }
  };
  emitter.on(name, wrapped);
  return () => emitter.off(name, wrapped);
}

export function emit<K extends Name>(name: K, e: DomainEvents[K]): void {
  emitter.emit(name, e);
}
