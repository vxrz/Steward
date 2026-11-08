import type { DebugSpec, NodeOf, NodeType, Platform, ProcessDefinition, RunStats, StartRunRequest, StepStatus, TaskDecision } from '@sm/shared';
import type { BrowserSession } from '../browser.js';
import type { DebugNodeSeed } from '../engine.js';
import type { Bindings } from '../expr.js';
import type { Redactor } from '../redact.js';
import type { RunRow } from '../store.js';
import { ANY } from '../../ai/provenance.js';

/**
 * What a step type gets from the engine (ADR 0011, update 0.11): a narrow view of its run. The built-in engine's run
 * context implements it; a step module never sees the engine itself (ESLint: no imports of engine/runner.ts or
 * engine/index.ts from engine/steps/). Steps write their own part of the record (engine/store.ts: the step's input,
 * tasks, artifacts) and do every check on a request themselves (steps/outbound.ts) – they stay Steward's, whatever
 * runs them.
 */

/** A connection slot of the run, resolved: the platform, its credentials (never stored) and its base URL. */
export interface Binding {
  platform: Platform;
  secrets: Record<string, string>;
  baseUrl: string;
}

/** A decision on a task the step waits for (or null: the run was cancelled). */
export interface TaskResult {
  decision: TaskDecision;
  by: string;
  at: string;
}

/** What a step returns: the engine redacts the output and summary and writes them to the journal. */
export interface LeafResult {
  output?: unknown;
  status?: StepStatus;
  summary?: string;
}

/** Thrown when the run was cancelled while the step ran (the engine records the step as cancelled). */
export class Cancelled extends Error {
  constructor() {
    super('Run was cancelled');
  }
}

export interface StepContext {
  // ----- the run -----
  readonly runId: string;
  readonly processId: string;
  /** Whose rights the run carries */
  readonly actor: string;
  /** The pinned definition of the run */
  readonly def: ProcessDefinition;
  readonly inputs: Record<string, unknown>;
  /** Variables of the current scope (the item's own copy inside a parallel loop body) */
  readonly vars: Record<string, unknown>;
  /** Read each time: a debug run switches to a test run after a simulated decision (ADR 0010) */
  readonly dryRun: boolean;
  /** Test run: platform calls are answered by recorded responses (always also a dry run) */
  readonly recorded: boolean;
  /** A debug run (ADR 0010) */
  readonly debug?: Readonly<DebugSpec>;
  /** A single-node debug run: the pasted answer and the simulated decision */
  readonly debugNode?: DebugNodeSeed;
  readonly bindings: Readonly<Record<string, Binding>>;
  /** The run's counters (the step adds to them; the engine stores them with the step's result) */
  readonly stats: RunStats;
  /** Aborted when the run is cancelled: passed to every request, timer and expression */
  readonly signal: AbortSignal;
  /** Every secret value of the run: what the step records goes through it */
  readonly redactor: Redactor;

  // ----- expressions in the run scope (the run's guard rails, cancelled with it) -----
  eval(expr: string, extra?: Bindings): Promise<unknown>;
  bool(expr: string, extra?: Bindings): Promise<boolean>;
  list(expr: string, extra?: Bindings): Promise<unknown[]>;
  render(v: unknown, extra?: Bindings): Promise<unknown>;
  str(v: string | undefined, extra?: Bindings): Promise<string>;
  /** An expression against a single item ($item, and item fields at root) */
  item(expr: string, item: unknown): Promise<unknown>;
  /** An expression against response data (pagination paths) */
  data(expr: string, root: unknown): Promise<unknown>;

  // ----- the record -----
  /** A line in the run log (redacted) */
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, stepKey?: string | null, data?: unknown): void;
  /** Where a value written to a variable comes from (ai/provenance.ts) */
  taint(name: string, sources: Iterable<string>): void;
  /** The recorded sources of variables */
  sourcesOf(names: readonly string[]): Set<string>;
  /** Sources with ANY and INPUT expanded to what they stand for in this run */
  expandSources(sources: Iterable<string>): Set<string>;
  /** Remembers an AI answer: reports and check messages that carry it are marked */
  rememberAiText(text: unknown, model: string): void;
  /** The models whose answers appear in these values, or undefined */
  aiModelsIn(...values: unknown[]): string[] | undefined;

  // ----- waiting (the run holds no slot of SM_MAX_CONCURRENT_RUNS while it waits) -----
  beginWait(): void;
  endWait(): void;
  /** Waits for the decision on a task of this run (a signal wakes it; null: cancelled) */
  awaitTask(taskId: string): Promise<TaskResult | null>;
  /** Starts a sub-process run of this step: the same mode and actor, with this run and step as its parent */
  startChild(stepKey: string, req: StartRunRequest): Promise<string>;
  /** Waits until a sub-process run has finished (it may wait for a task or be interrupted by a restart) */
  waitForChild(childId: string, stepKey: string): Promise<RunRow>;

  // ----- the run's browser (closed by the engine when the run ends) -----
  browser?: BrowserSession;
  /** Page navigations the outbound policy blocked, in order */
  readonly browserBlocked: string[];
  /** Redirect hops (followed by Chromium itself) the policy refuses, not yet reported */
  readonly browserRedirects: string[];
}

/** Node types the engine itself runs (flow control); every other type is a step type behind the registry. */
export type ControlType = 'start' | 'note' | 'if' | 'forEach';
export type StepType = Exclude<NodeType, ControlType>;

/** One step type: how it runs and what it shows when a debug run pauses before it. */
export interface StepExecutor<T extends StepType> {
  type: T;
  /** Runs the step once (`attempt` counts retries from 1). Throwing fails the attempt; Cancelled ends the run. */
  exec(step: NodeOf<T>, ctx: StepContext, key: string, attempt: number): Promise<LeafResult>;
  /** The step's resolved inputs for a debug pause (the engine redacts them and shows a failing expression's error) */
  preview?(step: NodeOf<T>, ctx: StepContext): Promise<unknown>;
  /**
   * Where the step's result comes from (ai/provenance.ts), for the variable it is saved to – also when a resumed run
   * replays it. Default: ANY (computed from the run).
   */
  sources?(step: NodeOf<T>, ctx: StepContext): string[];
  /**
   * Applies the step's (redacted) output to the run, also when a resumed run replays it from the journal. Return true
   * when the step has put its output into the variables itself: its `saveAs` is then not applied.
   */
  applyOutput?(step: NodeOf<T>, ctx: StepContext, output: unknown): boolean | void;
}

export type StepRegistry = { [T in StepType]: StepExecutor<T> };

/** The platform of a step's connection as the source of its result (ai/provenance.ts); ANY when it has none. */
export function connectionSources(slot: string | undefined, ctx: StepContext): string[] {
  const id = slot ? ctx.bindings[slot]?.platform.id : undefined;
  return id ? [id] : [ANY];
}
