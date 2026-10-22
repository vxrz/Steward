import { on } from '../events.js';
import { logger } from '../log.js';
import { runRow } from '../engine/store.js';
import { getProcess } from '../processes/service.js';
import { generateRunReport } from './service.js';

/**
 * Processes with `report: { auto: true }` get their run report generated and
 * archived as soon as a run finishes (e.g. scheduled access reviews). Runs
 * deferred, after the run's final audit entry with the sealed protocol hash.
 */
export async function autoReport(runId: string): Promise<string | null> {
  const run = runRow(runId);
  let opts: { auto?: boolean; lang?: 'en' | 'de' } | undefined;
  try {
    opts = getProcess(run.process_id, run.process_version).definition.report;
  } catch {
    return null; // process deleted meanwhile
  }
  if (!opts?.auto) return null;
  const rec = await generateRunReport(runId, { actor: 'system', auto: true, lang: opts.lang ?? 'en' });
  logger.info({ runId, reportId: rec.id }, 'run report generated automatically');
  return rec.id;
}

let subscribed = false;
export function initAutoReports(): void {
  if (subscribed) return;
  subscribed = true;
  on('run.finished', (e) => {
    setImmediate(() => {
      autoReport(e.runId).catch((err) => logger.warn({ err, runId: e.runId }, 'automatic run report failed'));
    });
  });
}
