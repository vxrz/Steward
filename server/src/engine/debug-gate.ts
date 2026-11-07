import type { DebugManualAnswer, DebugPause, DebugSignal, TaskDecision } from '@sm/shared';
import { HttpError } from '../util.js';

/** What a paused step-through run does next. */
export type GateAction =
  | { type: 'run'; how: 'step' | 'continue'; by: string }
  | { type: 'skip'; by: string }
  | { type: 'answer'; by: string; decision?: TaskDecision; manual?: DebugManualAnswer }
  | { type: 'stop'; by: string };

/**
 * The pause gate of a step-through debug run (ADR 0010): it stops before the nodes the person chose (every node,
 * breakpoints, the next one after "Step") and waits for their signal. It lives in memory only: a debug run is never
 * resumed after a restart, recovery cancels it.
 */
export class DebugGate {
  private pauseBeforeEach: boolean;
  private stepping = false;
  breakpoints: Set<string>;
  paused: DebugPause | null = null;
  private resolve?: (a: GateAction) => void;
  private timer?: NodeJS.Timeout;

  constructor(opts: { pauseBeforeEach?: boolean; breakpoints?: string[] }) {
    this.pauseBeforeEach = !!opts.pauseBeforeEach;
    this.breakpoints = new Set(opts.breakpoints ?? []);
  }

  /** Why the run stops before this node, or null. */
  reasonFor(nodeId: string): DebugPause['reason'] | null {
    if (this.stepping) return 'step';
    if (this.breakpoints.has(nodeId)) return 'breakpoint';
    if (this.pauseBeforeEach) return 'each';
    return null;
  }

  /**
   * Waits for the person's signal. `timeoutMs`: then `onTimeout` runs (it cancels the run); an aborted run resolves
   * as stopped.
   */
  wait(pause: DebugPause, o: { timeoutMs: number; onTimeout: () => void; signal: AbortSignal }): Promise<GateAction> {
    this.paused = pause;
    return new Promise<GateAction>((resolve) => {
      const done = (a: GateAction) => {
        clearTimeout(this.timer);
        this.timer = undefined;
        this.resolve = undefined;
        this.paused = null;
        o.signal.removeEventListener('abort', onAbort);
        resolve(a);
      };
      const onAbort = () => done({ type: 'stop', by: 'system' });
      if (o.signal.aborted) return onAbort();
      o.signal.addEventListener('abort', onAbort, { once: true });
      this.resolve = done;
      this.timer = setTimeout(o.onTimeout, o.timeoutMs);
      this.timer.unref?.();
    });
  }

  /** Applies a signal (stop is handled by the engine: it cancels the run). 409 when the run is not paused for it. */
  apply(s: Exclude<DebugSignal, { type: 'debug.stop' }>, by: string): void {
    if (s.type === 'debug.breakpoints') {
      this.breakpoints = new Set(s.breakpoints);
      return;
    }
    const p = this.paused;
    if (!p || !this.resolve) throw new HttpError(409, 'The debug run is not paused', 'DEBUG_NOT_PAUSED');
    if (s.type === 'debug.answer') {
      if (p.reason !== 'decision') throw new HttpError(409, 'The debug run does not wait for an answer', 'DEBUG_NO_DECISION');
      this.resolve({ type: 'answer', by, decision: s.decision, manual: s.manual });
      return;
    }
    if (p.reason === 'decision' && s.type !== 'debug.skip') throw new HttpError(409, 'Answer the decision or skip it', 'DEBUG_DECISION_OPEN');
    if (s.type === 'debug.skip') return this.resolve({ type: 'skip', by });
    // continue runs to the next breakpoint (also when it paused before each node); step stops before the next node
    this.stepping = s.type === 'debug.step';
    if (s.type === 'debug.continue') this.pauseBeforeEach = false;
    this.resolve({ type: 'run', how: s.type === 'debug.step' ? 'step' : 'continue', by });
  }

  close(): void {
    clearTimeout(this.timer);
  }
}
