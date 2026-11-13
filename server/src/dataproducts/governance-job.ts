import { moduleEnabled } from '../modules/registry.js';
import { refreshActualConsumers } from './consumers-actual.js';
import { forgetRequestsOfMissingProducts } from './access-requests.js';
import { noticeEndorsementReviews } from './endorsements.js';
import { noticeReviewsDue } from './port-reviews.js';

/**
 * The job `data-products-governance` (0.24.0, ADR 0036 phase 2), asked every 5 minutes, working at most hourly: the
 * actual consumers of ports read more than a day ago are read again (as the person who read them, their use right
 * checked again), and the reminders `dataproduct.endorsement_review` and `dataproduct.access_review_due` are sent –
 * each once (dp_notices). Nothing while the module is off.
 */

const HOUR = 3_600_000;
let last = 0;

export async function runGovernanceJob(now = Date.now(), force = false): Promise<{ read: number; endorsements: number; reviews: number } | null> {
  if (!moduleEnabled('dataProducts')) return null;
  if (!force && now - last < HOUR) return null;
  last = now;
  forgetRequestsOfMissingProducts();
  const read = await refreshActualConsumers(now);
  const endorsements = noticeEndorsementReviews();
  const reviews = noticeReviewsDue();
  return { read, endorsements, reviews };
}
