import { checkBudgetNotices } from './budgets.js';
import { publishCostPlansDataset, publishCostsDataset } from './dataset.js';
import { runCostJob } from './sources.js';

/**
 * The job "costs" (#226): the sources that are due, the links of every line once a day, the 80 % and 100 % notices of
 * the budgets, and the datasets "Costs" and "Cost plans" (at most hourly).
 */
export async function runCostsJob(now = Date.now()): Promise<{ read: number; failed: number; remapped: number; notices: number; published: boolean }> {
  const r = await runCostJob(now);
  const notices = checkBudgetNotices(now);
  const published = publishCostsDataset(r.read > 0 || r.remapped > 0, now);
  publishCostPlansDataset(false, now);
  return { ...r, notices, published };
}
