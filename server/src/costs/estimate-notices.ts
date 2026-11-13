import { moneyText, parseQuantity, type Locale } from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { nowIso, parseJson, sha256 } from '../util.js';
import { listUsers, toAuthUser } from '../auth/users.js';
import type { UserInfo } from '@sm/shared';
import { runAs, type AuthUser } from '../auth/context.js';
import { notify, titleName } from '../notifications/service.js';
import { t } from '../i18n/index.js';
import { costSettings, scopeInfo } from './access.js';
import { priceSight } from './price-books.js';
import { dueEstimates, monthlyFor, recalculateInBackground, type EstimateRow, type RecalcCause } from './estimates.js';
import { SEE_ALL, type PriceSight } from './estimate-model.js';
import type { StoredResult } from './pricing.js';

/**
 * Recalculation in the background and "Estimate changed" (0.23.0, ADR 0035 part 6, event `cost.estimate_changed`).
 *
 * - A new version of a book an estimate uses, or a changed condition of a contract it used, marks it (estimates.ts);
 *   the job "costs" recalculates the marked ones – at most 500 a run, yielding between them – with the same books and
 *   contracts, and keeps the new result beside the current one until a person chooses _Accept new prices_.
 * - The estimate's owners (a service's named owners and owning teams' members, a platform's managers and owning
 *   teams' members) get the notice once per estimate and price version when the monthly total moves by at least the
 *   threshold (5 % by default, Costs → Settings) – each recipient in their own view: a line priced with rates they may
 *   not see is at list price for them, so a change of a hidden rate alone tells them nothing; the cause names a book or
 *   contract only to who may see it.
 */

export const RECALC_PER_RUN = 500;

const claim = (estimateId: string, key: string): boolean =>
  db().run(
    "INSERT INTO cost_estimate_notices (estimate_id, kind, notice_key, sent_at) VALUES (?, 'changed', ?, ?) ON CONFLICT DO NOTHING",
    estimateId,
    key,
    nowIso(),
  ).changes === 1;

const pctOf = (before: number, after: number): number | null => (before === 0 ? (after === 0 ? 0 : null) : Math.round(((after - before) / before) * 1000) / 10);

/** Recalculates the estimates that are due and sends their notices; the number recalculated and notified. */
export async function recalculateDue(now = Date.now()): Promise<{ recalculated: number; notified: number }> {
  // while the vault is locked nothing can be e-mailed; the marks stay for the next run
  if (!vault().unlocked) return { recalculated: 0, notified: 0 };
  const rows = dueEstimates(RECALC_PER_RUN);
  let recalculated = 0;
  let notified = 0;
  const threshold = costSettings().estimateChangePct;
  const run = new NoticeRun();
  for (const row of rows) {
    try {
      const cause = parseJson<RecalcCause>(row.recalc_cause ?? null, {});
      const r = await recalculateInBackground(row);
      recalculated++;
      if (r.before && r.after && sendNotice(row, cause, r.before, r.after, threshold, now, run)) notified++;
    } catch (err) {
      db().run('UPDATE cost_estimates SET recalc_cause = NULL WHERE id = ?', row.id);
      logger.warn({ err, estimateId: row.id }, 'recalculating an estimate failed');
    }
    // other work of the server goes on between estimates
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { recalculated, notified };
}

/**
 * What a run of the job asks once, whatever the number of estimates: the active users, the owners of each owner scope
 * (a service's or platform's) who see its amounts, and what each recipient may see of the prices. Without it every
 * estimate asked every user again (users × estimates).
 */
class NoticeRun {
  private people: { info: UserInfo; au: AuthUser }[] | null = null;
  private owners = new Map<string, { info: UserInfo; au: AuthUser }[]>();
  private sights = new Map<string, PriceSight>();

  private all(): { info: UserInfo; au: AuthUser }[] {
    return (this.people ??= listUsers()
      .filter((u) => u.active)
      .map((info) => ({ info, au: toAuthUser(info) })));
  }

  /** Who is told about an estimate of this owner: its owners who see its amounts, else the administrators. */
  candidates(kind: EstimateRow['owner_kind'], id: string): { info: UserInfo; au: AuthUser }[] {
    const key = `${kind}:${id}`;
    let out = this.owners.get(key);
    if (!out) {
      const owners = this.all().filter((p) => {
        if (p.info.roles.includes('admin')) return false;
        const i = runAs(p.au, () => scopeInfo(kind, id, p.au));
        return !!i?.owner && i.amounts;
      });
      out = owners.length ? owners : this.all().filter((p) => p.info.roles.includes('admin'));
      this.owners.set(key, out);
    }
    return out;
  }

  /** What `au` may see of the prices behind estimates (read once per run). */
  sight(au: AuthUser): PriceSight {
    let v = this.sights.get(au.id);
    if (!v) this.sights.set(au.id, (v = runAs(au, () => priceSight(au))));
    return v;
  }
}

function sendNotice(
  row: EstimateRow,
  cause: RecalcCause,
  before: StoredResult,
  after: StoredResult,
  threshold: number,
  now: number,
  run = new NoticeRun(),
): boolean {
  const whole = pctOf(monthlyFor(before, SEE_ALL), monthlyFor(after, SEE_ALL));
  if (whole !== null && Math.abs(whole) < threshold) return false;
  // once per estimate and price version: the versions and contracts the new result used, and what caused it
  const key = sha256(JSON.stringify({ v: [...after.versionIds].sort(), c: (after.contracts ?? []).map((c) => c.id).sort(), cause }));
  const people = run.candidates(row.owner_kind, row.owner_id);
  const candidates = people.map((p) => p.info);
  // each recipient's own view: the figures they may see, the cause only when they may see the book or contract
  const views = new Map<string, { before: number; after: number; pct: number | null; cause: 'book' | 'contract' | null }>();
  for (const { info: u, au } of people) {
    const sight = run.sight(au);
    runAs(au, () => {
      const b = monthlyFor(before, sight);
      const a = monthlyFor(after, sight);
      const pct = pctOf(b, a);
      // a change they cannot see (a hidden rate moved, their lines are at list price) is not theirs to be told
      if (pct !== null && Math.abs(pct) < threshold) return;
      const what = cause.book && sight.book(cause.book.id) ? 'book' : cause.contract && sight.conditions(cause.contract.id) ? 'contract' : null;
      views.set(u.id, { before: b, after: a, pct, cause: what });
    });
  }
  const recipients = candidates.filter((u) => views.has(u.id));
  if (!recipients.length || !claim(row.id, key)) return false;
  const ownerName = scopeInfo(row.owner_kind, row.owner_id, null)?.name ?? row.owner_id;
  const money = (n: number) => moneyText(Number(parseQuantity(String(n)) ?? 0n), row.currency);
  try {
    notify({
      event: 'cost.estimate_changed',
      personal: true,
      text: (l: Locale, u?: { id: string }) => {
        const v = u ? views.get(u.id) : undefined;
        const what =
          v?.cause === 'book' && cause.book
            ? t(l, 'estimateChanged.book', { name: cause.book.name, version: cause.book.version })
            : v?.cause === 'contract' && cause.contract
              ? t(l, 'estimateChanged.contract', { title: cause.contract.title })
              : '';
        return {
          title: t(l, 'estimateChanged.title', { title: titleName(row.title) }),
          body: t(l, 'estimateChanged.body', {
            title: row.title,
            owner: ownerName,
            cause: what ? t(l, 'estimateChanged.cause', { what }) : '',
            after: v ? money(v.after) : '',
            before: v ? money(v.before) : '',
            pct: v?.pct === null || v?.pct === undefined ? '–' : `${v.pct > 0 ? '+' : ''}${v.pct.toLocaleString(l)}`,
          }),
        };
      },
      link: `/costs/estimates/${encodeURIComponent(row.id)}`,
      recipients,
      about: { kind: row.owner_kind, id: row.owner_id },
      inAppKey: `cost.estimate_changed:${row.id}:${key.slice(0, 16)}`,
      externalKey: `cost.estimate_changed:${row.id}:${key.slice(0, 16)}`,
      data: { estimateId: row.id, ownerKind: row.owner_kind, ownerId: row.owner_id, currency: row.currency, at: new Date(now).toISOString() },
    });
  } catch (err) {
    logger.warn({ err, estimateId: row.id }, 'the notice "Estimate changed" could not be sent');
  }
  return true;
}
