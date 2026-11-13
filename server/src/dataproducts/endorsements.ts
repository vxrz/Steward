import {
  DATA_GOVERNANCE_LIMITS as G,
  addMonths,
  dataEndorsementInput,
  endorsementState,
  type DataEndorsement,
  type DataEndorsementReviewReason,
  type DataEndorsementView,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { forbid, me } from '../auth/access.js';
import type { AuthUser } from '../auth/context.js';
import { isAdmin, matches } from '../auth/permissions.js';
import { logger } from '../log.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import { canManageModule } from './access.js';
import { isProductOwner } from './access-requests.js';
import { claimNotice, namedPeople, people, productLink, send, seesProduct, t, titleName, type Person } from './governance-notices.js';
import { floorsOf, ratingsByItem } from './ratings.js';
import { visibleProduct } from './service.js';
import { chunks, domainRow, marks, productRow, productsByIds, type ProductRow } from './store.js';

/**
 * Endorsement (ADR 0036 part 17, decision 27): the owners of the product's domain (or of its parent domain; without
 * any, the module's managers) endorse a product – a badge with who and when, valid until a review date (12 months by
 * default, never later). Nobody endorses a product they own. An endorsement needs a **review** when its date is near
 * (30 days) or passed, when a bound contract had a breaking change (flagEndorsementReview, the contract hook), or while
 * the product's rating is below the floor of its data objects without a reason; then it no longer counts. Maturity 5
 * (_endorsed_) is a valid endorsement on top of level 4 (scorecard.ts). Session-only, audited
 * (`dataproduct.endorsed`, `dataproduct.endorsement_revoked`, `dataproduct.endorsement_flagged`);
 * `dataproduct.endorsement_review` reminds the endorsers and the product owners once per review date and reason.
 */

interface EndorsementRow {
  product_id: string;
  endorsed_by: string;
  endorsed_at: string;
  review_date: string;
  note: string;
  review_reason: DataEndorsementReviewReason | null;
  review_flagged_at: string | null;
}

const today = () => nowIso().slice(0, 10);
const invalid = (message: string, context: string) => new HttpError(400, message, 'DATA_ENDORSEMENT_INVALID', { context });

/** The subjects who endorse a product: the owners of its domain and of the domain above it. */
export function endorsersOf(p: Pick<ProductRow, 'domain_id'>): string[] {
  if (!p.domain_id) return [];
  const d = domainRow(p.domain_id);
  if (!d) return [];
  const parent = d.parent_id ? domainRow(d.parent_id) : undefined;
  return [...new Set([...parseJson<string[]>(d.owners, []), ...parseJson<string[]>(parent?.owners, [])])];
}

/** Whether `u` may endorse (and revoke) a product's endorsement, and why not. */
function endorseRight(u: AuthUser, p: ProductRow): { may: boolean; whyNot: DataEndorsementView['whyNot'] } {
  if (isProductOwner(u, p)) return { may: false, whyNot: 'ownProduct' };
  const endorsers = endorsersOf(p);
  const may = endorsers.length ? endorsers.some((s) => matches(u, s)) : canManageModule(u);
  return may ? { may: true, whyNot: null } : { may: false, whyNot: 'notEndorser' };
}

/** The endorsements of these products (bulk). */
export function endorsementRows(productIds: readonly string[]): Map<string, EndorsementRow> {
  const out = new Map<string, EndorsementRow>();
  for (const part of chunks([...new Set(productIds)]))
    for (const r of db().all<EndorsementRow>(`SELECT * FROM dp_endorsements WHERE product_id IN (${marks(part.length)})`, ...part)) out.set(r.product_id, r);
  return out;
}

/** The state of an endorsement row, with the floor warning of its product. */
export function endorsementOf(r: EndorsementRow, belowFloor: boolean, on = today()): DataEndorsement {
  const s = endorsementState({ reviewDate: r.review_date, flagged: r.review_reason }, on, belowFloor);
  return {
    productId: r.product_id,
    endorsedBy: r.endorsed_by,
    endorsedAt: r.endorsed_at,
    reviewDate: r.review_date,
    note: r.note,
    valid: s.valid,
    review: s.review,
  };
}

/** Whether each product's rating is below its data objects without a reason (bulk). */
function belowFloor(products: ProductRow[]): Map<string, boolean> {
  if (!products.length) return new Map();
  const ratings = ratingsByItem(
    'product',
    products.map((p) => p.id),
  );
  const floors = floorsOf(products, ratings);
  return new Map(products.map((p) => [p.id, !!floors.get(p.id)?.warning]));
}

/** GET /api/data-products/:id/endorsement */
export function getEndorsement(productId: string): DataEndorsementView {
  const u = me();
  const { row: p } = visibleProduct(productId, u);
  const r = endorsementRows([p.id]).get(p.id);
  const right = endorseRight(u, p);
  return {
    endorsement: r ? endorsementOf(r, !!belowFloor([p]).get(p.id)) : null,
    endorsers: endorsersOf(p),
    mayEndorse: right.may,
    whyNot: right.whyNot,
  };
}

/** PUT /api/data-products/:id/endorsement (session only) – endorse, or renew with a new review date. */
export function endorse(productId: string, body: unknown): DataEndorsementView {
  const u = me();
  const { row: p } = visibleProduct(productId, u);
  const right = endorseRight(u, p);
  if (!right.may) forbid(right.whyNot === 'ownProduct' ? 'endorse a data product you own' : 'endorse this data product', 'dataProducts');
  if (p.lifecycle === 'retired' || p.lifecycle === 'deprecated') throw invalid('Only products in use are endorsed', 'lifecycle');
  const input = dataEndorsementInput.parse(body);
  const on = today();
  const latest = addMonths(on, G.endorsementMonths);
  const reviewDate = input.reviewDate ?? latest;
  if (reviewDate <= on || reviewDate > latest) throw invalid(`The review date is after today and at most ${G.endorsementMonths} months ahead`, 'reviewDate');
  const before = endorsementRows([p.id]).get(p.id);
  const now = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO dp_endorsements (product_id, endorsed_by, endorsed_at, review_date, note, review_reason, review_flagged_at) VALUES (?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT (product_id) DO UPDATE SET endorsed_by = excluded.endorsed_by, endorsed_at = excluded.endorsed_at, review_date = excluded.review_date,
         note = excluded.note, review_reason = NULL, review_flagged_at = NULL`,
      p.id,
      u.username,
      now,
      reviewDate,
      input.note,
    );
    audit({
      action: 'dataproduct.endorsed',
      entityType: 'data_product',
      entityId: p.id,
      summary: `Data product "${p.name}" ${before ? 'endorsed again' : 'endorsed'} until ${reviewDate}`,
      details: { reviewDate, note: input.note.slice(0, 500), before: before ? { by: before.endorsed_by, reviewDate: before.review_date, reason: before.review_reason } : null },
    });
  });
  return getEndorsement(p.id);
}

/** DELETE /api/data-products/:id/endorsement (session only) – the endorsers, and who manages the module. */
export function revokeEndorsement(productId: string, reason: string): DataEndorsementView {
  const u = me();
  const { row: p } = visibleProduct(productId, u);
  const r = endorsementRows([p.id]).get(p.id);
  if (!r) throw invalid('The product is not endorsed', 'notEndorsed');
  if (!endorseRight(u, p).may && !isAdmin(u) && !canManageModule(u)) forbid('revoke this endorsement', 'dataProducts');
  db().tx(() => {
    db().run('DELETE FROM dp_endorsements WHERE product_id = ?', p.id);
    audit({
      action: 'dataproduct.endorsement_revoked',
      entityType: 'data_product',
      entityId: p.id,
      summary: `Data product "${p.name}": endorsement revoked`,
      details: { endorsedBy: r.endorsed_by, endorsedAt: r.endorsed_at, reviewDate: r.review_date, reason: reason.slice(0, 500) },
    });
  });
  return getEndorsement(p.id);
}

/**
 * Flags endorsements for review (a breaking change of a bound contract – the data contracts' hook – or another
 * reason): they stop counting until endorsed again. Returns the products flagged. Never throws.
 */
export function flagEndorsementReview(productIds: readonly string[], reason: Extract<DataEndorsementReviewReason, 'breakingChange'>, note = ''): string[] {
  const flagged: string[] = [];
  try {
    const rows = endorsementRows(productIds);
    const now = nowIso();
    for (const r of rows.values()) {
      if (r.review_reason === reason) continue;
      db().tx(() => {
        db().run('UPDATE dp_endorsements SET review_reason = ?, review_flagged_at = ? WHERE product_id = ?', reason, now, r.product_id);
        audit({
          actor: 'system',
          action: 'dataproduct.endorsement_flagged',
          entityType: 'data_product',
          entityId: r.product_id,
          summary: `Data product endorsement needs a review: ${reason}${note ? ` (${note.slice(0, 200)})` : ''}`,
          details: { reason, note: note.slice(0, 500) },
        });
      });
      flagged.push(r.product_id);
    }
    noticeEndorsementReviews(flagged);
  } catch (err) {
    logger.warn({ err }, 'endorsements could not be flagged for review');
  }
  return flagged;
}

/** Products with a valid endorsement (maturity 5 on top of level 4), with the floor warnings the caller has. */
export function validEndorsements(productIds: readonly string[], floorWarning: (id: string) => boolean, on = today()): Set<string> {
  const out = new Set<string>();
  for (const r of endorsementRows(productIds).values()) if (endorsementOf(r, floorWarning(r.product_id), on).valid) out.add(r.product_id);
  return out;
}

/**
 * `dataproduct.endorsement_review`: endorsements due for a review (30 days ahead, passed, flagged, below the floor), to
 * the endorsers and the product owners who may see the product – once per product, review date and reason.
 */
export function noticeEndorsementReviews(onlyIds?: readonly string[], on = today()): number {
  let sent = 0;
  try {
    const rows = onlyIds ? [...endorsementRows(onlyIds).values()] : db().all<EndorsementRow>('SELECT * FROM dp_endorsements');
    if (!rows.length) return 0;
    const products = productsByIds(rows.map((r) => r.product_id));
    const floors = belowFloor([...products.values()]);
    let all: Person[] | null = null;
    for (const r of rows) {
      const p = products.get(r.product_id) ?? productRow(r.product_id);
      if (!p) continue;
      const e = endorsementOf(r, !!floors.get(p.id), on);
      if (!e.review || !claimNotice('endorsement', p.id, `${e.reviewDate}:${e.review}`)) continue;
      all ??= people();
      const to = namedPeople(all, [...endorsersOf(p), ...parseJson<string[]>(p.owners, []), `user:${r.endorsed_by.toLowerCase()}`]).filter((x) => seesProduct(x, p));
      sent += send({
        event: 'dataproduct.endorsement_review',
        recipients: to,
        link: productLink(p.id),
        key: `endorsement:${p.id}:${e.reviewDate}:${e.review}`,
        title: (l) => t(l, 'dataProductGovernance.endorsementReview.title', { product: titleName(p.name) }),
        lines: (l) => [
          t(l, `dataProductGovernance.endorsementReview.${e.review!}`, { product: p.name, date: e.reviewDate }),
          t(l, 'dataProductGovernance.endorsementReview.by', { by: r.endorsed_by, date: r.endorsed_at.slice(0, 10) }),
          t(l, 'dataProductGovernance.endorsementReview.hint'),
        ],
        data: { productId: p.id, reviewDate: e.reviewDate, reason: e.review },
      });
    }
  } catch (err) {
    logger.warn({ err }, 'endorsement review notices could not be sent');
  }
  return sent;
}
