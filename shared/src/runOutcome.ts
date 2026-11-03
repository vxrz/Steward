import type { RunFindings, RunOutcome, RunStatus } from './api.js';

/** No findings. */
export const NO_FINDINGS: RunFindings = { total: 0, error: 0, warning: 0, info: 0 };

/**
 * A run's outcome: what it found, apart from whether it executed. A run that executed to the end (`succeeded`) with
 * failed checks "completed with findings"; every other status is its own outcome.
 */
export function runOutcome(status: RunStatus, findings: number): RunOutcome {
  return status === 'succeeded' && findings > 0 ? 'findings' : status;
}

/** The outcome of a run summary, also for summaries of older servers without `outcome` (from the failed checks). */
export function outcomeOf(r: { status: RunStatus; outcome?: RunOutcome; findings?: RunFindings; stats: { checksFailed: number } }): RunOutcome {
  return r.outcome ?? runOutcome(r.status, r.findings?.total ?? r.stats.checksFailed);
}

/** The most severe level among a run's findings (null: none). */
export function topSeverity(f: RunFindings | undefined): 'error' | 'warning' | 'info' | null {
  if (!f?.total) return null;
  return f.error ? 'error' : f.warning ? 'warning' : f.info ? 'info' : 'error';
}
