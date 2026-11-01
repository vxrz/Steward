import { parentPort } from 'node:worker_threads';
import { forbidDatabase } from '../../db.js';
import { PDF_DRAWERS } from './drawers.js';
import { reviveBuffers, toWorkerError } from './pool.js';
import { reportSectionIds } from '../sections.js';

/**
 * The PDF worker (#13, see pool.ts): draws one PDF per message from data collected in the main thread. It has no
 * database – a drawer that tries to read one fails instead of opening a second connection.
 */
forbidDatabase('PDFs are drawn from collected data (reports/pdf/pool.ts)');

parentPort!.on('message', async (m: { id: number; kind: keyof typeof PDF_DRAWERS; args: unknown[] }) => {
  try {
    const draw = PDF_DRAWERS[m.kind] as (...a: unknown[]) => Promise<unknown>;
    if (!draw) throw new Error(`Unknown PDF kind ${m.kind}`);
    const result = await draw(...reviveBuffers(m.args));
    parentPort!.postMessage({ id: m.id, ok: true, result });
  } catch (e) {
    parentPort!.postMessage({ id: m.id, ok: false, error: toWorkerError(e) });
  }
});
// the sections of scheduled reports this thread knows (one registered later in the main thread is drawn there)
parentPort!.postMessage({ type: 'ready', sections: reportSectionIds() });
