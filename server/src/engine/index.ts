/**
 * The engine for the rest of Steward (ADR 0011). Code outside `engine/` imports this module, never `engine/runner.ts`
 * (ESLint `no-restricted-imports`); rights are checked first in `engine/commands.ts`.
 */
import type { RunEngine } from './engine.js';
import { builtinEngine } from './runner.js';

export type { DebugNodeSeed, RunEngine, RunOrigin, RunSignal, RunState, SignalResult, StartCommand } from './engine.js';
export { modeOf, modeOfRow } from './engine.js';

/** The configured engine: in 0.10.0 always the built-in one. */
export function engine(): RunEngine {
  return builtinEngine;
}

// Helpers of the built-in engine other modules use (not part of the interface): masking secrets in values, the
// sub-process depth limit and the CSV parser of table inputs.
export { MAX_SUBPROCESS_DEPTH, Redactor, parseCsv, resumeAcceptingRuns } from './runner.js';
