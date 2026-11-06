import { runCostJob } from './sources.js';

/** The job "costs" (#226): the sources that are due, the links of every line once a day. */
export async function runCostsJob(now = Date.now()): Promise<{ read: number; failed: number; remapped: number }> {
  return runCostJob(now);
}
