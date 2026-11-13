import { checkBudgetNotices } from './budgets.js';
import { publishCostPlansDataset, publishCostsDataset } from './dataset.js';
import { runCostJob } from './sources.js';
import { publishCommitmentsDataset } from './commitments.js';
import { checkBookingReminders } from './booking-reminders.js';
import { checkVolumeNotices } from './volume-notices.js';
import { checkPriceReviews } from './price-reviews.js';

/**
 * The job "costs" (#226): the sources that are due, the links of every line once a day, the 80 % and 100 % notices of
 * the budgets, the warnings of contract volumes, and the datasets "Costs", "Cost plans" and "Commitments" (at most hourly).
 */
export async function runCostsJob(now = Date.now()): Promise<{ read: number; failed: number; remapped: number; notices: number; published: boolean }> {
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
  return { ...r, notices, published };
}
