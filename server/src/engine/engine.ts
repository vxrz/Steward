/**
 * The engine boundary (ADR 0011): how Steward starts, signals, cancels and queries runs, whatever executes them.
 *
 * `engine/runner.ts` implements it as the built-in engine; `engine/index.ts` hands it out (`engine()`). Code outside
 * `engine/` imports `engine/index.ts`, never `engine/runner.ts` (ESLint `no-restricted-imports`). `engine/store.ts`
 * stays importable: it is the record, not the executor.
 *
 * The engine trusts its caller for rights: every caller checks them first in the command layer (`engine/commands.ts`).
 * Everything that keeps a run trustworthy – secrets, the checks on every request, the record and its seal – stays in
 * Steward's own step functions, whatever the engine.
 *
 * Events stay `events.ts` (decided: no outbox in 0.10.0): the engine emits `run.started` and `run.finished` (with
 * `mode` and `debug`), `step.finished`, `task.created`, `task.verification_needed` and `task.returned`.
 */
import type { DebugManualAnswer, DebugPause, DebugSignal, DebugSpec, FlowNode, RunMode, RunStatus, TaskDecision } from '@sm/shared';
import type { ManualCompletionInput } from './manual.js';

export type { DebugPause, DebugSignal, DebugSpec, RunMode };

/** What started a run. */
export interface RunOrigin {
  trigger: 'manual' | 'schedule' | 'subprocess' | 'webhook' | 'monitor' | 'debug';
  scheduleId?: string;
  /** Webhook trigger (trigger 'webhook') or monitor (trigger 'monitor', with the output id) that started the run */
  webhook?: { triggerId: string; triggerName: string; test?: boolean; output?: string };
  /** Sub-process: the run and step (activation key) that started this run */
  parent?: { runId: string; stepKey: string };
}

export interface StartCommand {
  processId: string;
  /** The current version when missing */
  version?: number;
  /** Raw: the engine coerces and seals */
  inputs: Record<string, unknown>;
  /** Slot → platform id */
  bindings: Record<string, string>;
  /** Slot → identity id (ADR 0009 step 2, not built yet: the default identity is used) */
  identities?: Record<string, string>;
  /** `test` implies no writes and recorded answers; `dry` skips writes */
  mode: RunMode;
  /** Whose rights the run carries */
  actor: string;
  origin: RunOrigin;
  /** A debug run (ADR 0010); only the built-in engine accepts it, never with mode `live` */
  debug?: DebugSpec;
  /** A single-node debug run: what it brings besides its record (never stored as such) */
  debugSeed?: DebugNodeSeed;
}

/** What a single-node debug run brings besides its record: the variables, the unsaved node, a pasted answer, the simulated answer. */
export interface DebugNodeSeed {
  vars: Record<string, unknown>;
  /** The editor's unsaved node, checked like a saved definition */
  node?: FlowNode;
  answer?: { status: number; headers?: Record<string, string>; body?: unknown };
  decision?: TaskDecision;
  manual?: DebugManualAnswer;
}

export interface ManualVerification {
  approved: boolean;
  comment?: string;
}

export type RunSignal =
  | { type: 'task.decide'; taskId: string; decision: TaskDecision }
  | { type: 'manual.complete'; taskId: string; input: ManualCompletionInput }
  | { type: 'manual.verify'; taskId: string; input: ManualVerification }
  /** A person resumes an interrupted run */
  | { type: 'resume' }
  | DebugSignal;

export type SignalResult =
  | { ok: true }
  | { ok: true; verificationNeeded: boolean }
  | { ok: true; outcome: 'verified' | 'returned' | 'failed' }
  | { ok: true; paused?: DebugPause | null };

export interface RunState {
  runId: string;
  status: RunStatus;
  mode: RunMode;
  /** Activation keys running or waiting (several in a parallel for-each) */
  current: string[];
  waitingTasks: { taskId: string; stepKey: string; mode: string; stage?: 'work' | 'verify' }[];
  /** Place in the queue (1 = next), while the run waits for a free slot */
  queuePosition?: number;
  /** A debug run paused before a node (ADR 0010) */
  paused?: DebugPause;
}

export interface RunEngine {
  readonly id: 'builtin';
  start(cmd: StartCommand): Promise<{ runId: string; status: 'queued' | 'running' }>;
  signal(runId: string, s: RunSignal, actor: string): Promise<SignalResult>;
  cancel(runId: string, reason: string, actor: string): Promise<void>;
  /** The record first (runs, run_steps, run_tasks); only the queue position and a debug pause come from memory */
  query(runId: string): RunState;
  // host lifecycle, called by bootstrap.ts and main.ts only
  recover(): Promise<void>;
  stopAccepting(): void;
  drain(graceMs: number): Promise<string[]>;
  interruptBusy(): string[];
  /** Runs in memory, for the shutdown report and tests: active, taking a slot (busy), queued */
  counts(): { active: string[]; busy: string[]; queued: string[] };
}

/** `dryRun`/`recorded` of the API (`StartRunRequest`) as a mode: recorded → test, dryRun → dry, else live. */
export function modeOf(r: { dryRun?: boolean; recorded?: boolean }): RunMode {
  return r.recorded ? 'test' : r.dryRun ? 'dry' : 'live';
}

/** The stored columns of a run as its mode. */
export function modeOfRow(r: { dry_run?: number | boolean | null; recorded?: number | boolean | null }): RunMode {
  return r.recorded ? 'test' : r.dry_run ? 'dry' : 'live';
}
