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

type AfterReport = (runId: string, reportId: string | null) => Promise<unknown> | unknown;
const afterReport: AfterReport[] = [];
/**
 * Work that needs the run's archived protocol once a run has finished (e.g. automatic access change
 * entries): called after the automatic report, with its id (null when the process has none).
 */
export function onRunReported(fn: AfterReport): void {
  afterReport.push(fn);
}

let subscribed = false;
export function initAutoReports(): void {
  if (subscribed) return;
  subscribed = true;
  on('run.finished', (e) => {
    setImmediate(() => {
      void autoReport(e.runId)
        .catch((err) => {
          logger.warn({ err, runId: e.runId }, 'automatic run report failed');
          return null;
        })
        .then(async (reportId) => {
          for (const fn of afterReport) {
            try {
              await fn(e.runId, reportId);
            } catch (err) {
              logger.warn({ err, runId: e.runId }, 'work after the run report failed');
            }
          }
        });
    });
  });
}
