import type { Locale } from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { listUsers, toAuthUser } from '../auth/users.js';
import { notify, titleName } from '../notifications/service.js';
import { t } from '../i18n/index.js';
import { nowIso } from '../util.js';
import { bookRights, reviewDue, type BookRow } from './price-books.js';

/**
 * "Prices to review" (0.21.0, ADR 0035 part 2, event `cost.price_review_due`): price books kept by hand whose review is
 * due remind their maintainers in the app. Kept apart from price-books.ts, which the access checks read.
 */

let reviewsChecked = 0;

/**
 * Books kept by hand whose review is due: their maintainers get "Prices to review" in the app, once per book and due
 * date (at most hourly). Maintainers: who may change the book (without administrators when there are others).
 */
export function checkPriceReviews(now = Date.now(), force = false): number {
  if (!force && now - reviewsChecked < 3600_000) return 0;
  if (!vault().unlocked) return 0;
  reviewsChecked = now;
  const due = db()
    .all<BookRow>("SELECT * FROM cost_price_books WHERE source IN ('manual', 'csv') AND current_version > 0")
    .filter((r) => reviewDue(r, now));
  if (!due.length) return 0;
  const users = listUsers()
    .filter((u) => u.active)
    .map((u) => ({ u, au: toAuthUser(u) }));
  let sent = 0;
  for (const r of due) {
    const dueOn = new Date(Date.parse(r.checked_at ?? r.created_at) + Number(r.review_days) * 86_400_000).toISOString().slice(0, 10);
    const claimed =
      db().run('INSERT INTO cost_price_review_notices (book_id, due_on, sent_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', r.id, dueOn, nowIso()).changes === 1;
    if (!claimed) continue;
    try {
      const maintainers = users.filter((x) => bookRights(r, x.au).edit);
      const others = maintainers.filter((x) => !x.u.roles.includes('admin'));
      const recipients = (others.length ? others : maintainers).map((x) => x.u);
      if (!recipients.length) continue;
      notify({
        event: 'cost.price_review_due',
        personal: true,
        text: (l: Locale) => ({
          title: t(l, 'priceReview.title', { book: titleName(r.name) }),
          body: t(l, 'priceReview.body', { book: r.name, days: String(r.review_days), checked: (r.checked_at ?? r.created_at).slice(0, 10) }),
        }),
        link: `/costs/price-books/${encodeURIComponent(r.id)}`,
        recipients,
        inAppKey: `cost.price_review_due:${r.id}:${dueOn}`,
        externalKey: `cost.price_review_due:${r.id}:${dueOn}`,
        data: { bookId: r.id, book: r.name, dueOn },
      });
      sent++;
    } catch (err) {
      logger.warn({ err, bookId: r.id }, 'price review reminder could not be sent');
    }
  }
  return sent;
}
