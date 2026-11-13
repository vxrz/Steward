import { checkBudgetNotices } from './budgets.js';
import { publishCostPlansDataset, publishCostsDataset } from './dataset.js';
import { runCostJob } from './sources.js';
import { publishCommitmentsDataset } from './commitments.js';
import { checkBookingReminders } from './booking-reminders.js';
import { checkVolumeNotices } from './volume-notices.js';
import { checkPriceReviews } from './price-reviews.js';
import { runPriceSources } from './price-sources.js';
import { recalculateDue } from './estimate-notices.js';
import { rederiveAll } from './price-books.js';
import { db } from '../db.js';

/**
 * The job "costs" (#226): the sources that are due, the links of every line once a day, the 80 % and 100 % notices of
 * the budgets, the warnings of contract volumes, and the datasets "Costs", "Cost plans" and "Commitments" (at most hourly).
 */
export async function runCostsJob(now = Date.now()): Promise<{
  read: number;
  failed: number;
  remapped: number;
  notices: number;
  published: boolean;
  prices: number;
  recalculated: number;
  changedNotices: number;
}> {
  const r = await runCostJob(now);
  const notices = checkBudgetNotices(now);
  const published = publishCostsDataset(r.read > 0 || r.remapped > 0, now);
  await publishCostPlansDataset(false, now);
  publishCommitmentsDataset(false, now);
  // the opt-in reminder "contract payments not booked" (ADR 0030), from the third day of a month
  checkBookingReminders(now);
  // the warnings of contract volumes (ADR 0032), at most hourly, once per schedule, period and kind
  checkVolumeNotices(now);
  // "Prices to review" of price books kept by hand (ADR 0035 part 2), at most hourly, once per book and due date
  checkPriceReviews(now);
  // price books read from a source (ADR 0035 part 2): Snowflake rate sheets daily, Confluent's observed rates monthly
  const prices = await runPriceSources(now);
  // once a day: derived books whose terms start or end, conditions of contracts that are gone
  if (now - lastDaily >= 86_400_000) {
    lastDaily = now;
    rederiveAll();
    db().run('DELETE FROM supplier_contract_conditions WHERE contract_id NOT IN (SELECT id FROM supplier_contracts)');
  }
  // estimates whose books or contract conditions changed: recalculated beside their result, "Estimate changed" (part 6)
  const re = await recalculateDue(now);
  return { ...r, notices, published, prices, recalculated: re.recalculated, changedNotices: re.notified };
}
let lastDaily = 0;
