import {
  DATA_GOVERNANCE_ID_PREFIX,
  DATA_GOVERNANCE_LIMITS as G,
  addMonths,
  dataPortReviewApprovalInput,
  dataPortReviewDecisionsInput,
  dataPortReviewInput,
  type DataPortReview,
  type DataPortReviewDue,
  type DataPortReviewItem,
  type DataPortReviewItemKind,
  type DataPortReviewStatus,
  type DataPortReviewSummary,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { forbid, me } from '../auth/access.js';
import type { AuthUser } from '../auth/context.js';
import { samePerson } from '../auth/assurance.js';
import { isAdmin } from '../auth/permissions.js';
import { moduleEnabled } from '../modules/registry.js';
import { logger } from '../log.js';
import { HttpError, canonicalJson, newId, nowIso, parseJson, sha256 } from '../util.js';
import { decidesFor, reviewMonthsOf } from './access-requests.js';
import { portNotFound } from './common.js';
import { actualView } from './consumers-actual.js';
import { claimNotice, decidersOf, people, productLink, send, t, titleName } from './governance-notices.js';
import { visibleProduct } from './service.js';
import { bindingsOf, elementsByIds, portRow, portsOf, productRow, type PortRow, type ProductRow } from './store.js';

/**
 * Port access reviews (ADR 0036 part 12 phase 2): the periodic review of who consumes an output port, built on the
 * person access reviews' way of working (compliance/person-reviews.ts): what is found is **frozen** into the review –
 * the registered consumers with what the platforms say of them (_seen_, _registered but silent_), who reads without a
 * registration (_not registered_) and, from an access check of the access reconciliation, the **grants** on the port's
 * objects (read live as the check is read for person reviews, else its latest snapshot) – and a reviewer decides
 * each: keep or remove (a removal with a reason). Submitted, a second person approves (four eyes, on by default; never
 * the submitter); approved, the review is **sealed** (SHA-256 over the review and its decisions, in the audit log) and
 * registrations decided _remove_ end today. Grants and readers to remove are the platform team's work: the review is
 * the evidence. Who reviews: who decides access requests of the product; approvers and administrators approve too.
 * The product's access settings give the interval; `dataproduct.access_review_due` reminds once per due date.
 */

interface ReviewRow {
  id: string;
  product_id: string;
  port_id: string;
  environment: string;
  status: DataPortReviewStatus;
  four_eyes: number;
  check_info: string | null;
  created_by: string;
  created_at: string;
  submitted_by: string | null;
  submitted_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  approval_comment: string;
  seal_hash: string | null;
}

interface ItemRow {
  id: string;
  review_id: string;
  seq: number;
  kind: DataPortReviewItemKind;
  consumer_id: string | null;
  label: string;
  finding: string;
  detail: string;
  decision: 'keep' | 'remove' | null;
  comment: string;
  decided_by: string | null;
  decided_at: string | null;
}

export const reviewNotFound = (id: string) => new HttpError(404, `Port access review ${id} not found`, 'DATA_PORT_REVIEW_NOT_FOUND', { id });
const reviewState = (message: string, context: string, extra: Record<string, string | number> = {}) =>
  new HttpError(409, message, 'DATA_PORT_REVIEW_STATE', { context, ...extra });

const mayDecide = (u: AuthUser, r: ReviewRow, p: ProductRow) => r.status === 'open' && decidesFor(u, p);
const mayApprove = (u: AuthUser, r: ReviewRow, p: ProductRow) =>
  r.status === 'submitted' && (decidesFor(u, p) || isAdmin(u) || u.roles.includes('approver')) && !samePerson(r.submitted_by, u);

function summary(r: ReviewRow, port: PortRow | undefined, counts: { items: number; removals: number }): DataPortReviewSummary {
  return {
    id: r.id,
    productId: r.product_id,
    portId: r.port_id,
    portName: `${port?.name ?? ''}${port?.version ? ` ${port.version}` : ''}`,
    environment: r.environment,
    status: r.status,
    fourEyes: !!r.four_eyes,
    items: counts.items,
    removals: counts.removals,
    createdBy: r.created_by,
    createdAt: r.created_at,
    approvedAt: r.approved_at,
  };
}

const itemView = (i: ItemRow): DataPortReviewItem => ({
  id: i.id,
  seq: Number(i.seq),
  kind: i.kind,
  consumerId: i.consumer_id,
  label: i.label,
  finding: i.finding,
  detail: i.detail,
  decision: i.decision,
  comment: i.comment,
  decidedBy: i.decided_by,
  decidedAt: i.decided_at,
});

/** GET /api/data-products/:id/port-reviews – the reviews of a product's ports (the newest first) and when the next ones are due. */
export function productReviews(productId: string): { items: DataPortReviewSummary[]; due: DataPortReviewDue[] } {
  const { row: p } = visibleProduct(productId);
  const rows = db().all<ReviewRow>('SELECT * FROM dp_port_reviews WHERE product_id = ? ORDER BY created_at DESC, id DESC LIMIT 200', p.id);
  const counts = new Map(
    db()
      .all<{ review_id: string; n: number; removals: number }>(
        `SELECT i.review_id, COUNT(*) AS n, SUM(CASE WHEN i.decision = 'remove' THEN 1 ELSE 0 END) AS removals
           FROM dp_port_review_items i JOIN dp_port_reviews r ON r.id = i.review_id WHERE r.product_id = ? GROUP BY i.review_id`,
        p.id,
      )
      .map((c) => [c.review_id, { items: Number(c.n), removals: Number(c.removals ?? 0) }]),
  );
  const ports = new Map(portsOf([p.id]).map((x) => [x.id, x]));
  return {
    items: rows.map((r) => summary(r, ports.get(r.port_id), counts.get(r.id) ?? { items: 0, removals: 0 })),
    due: dueOf(p, [...ports.values()]),
  };
}

/** When each bound output port's next review is due (the interval after the last approved review; none yet: today). */
function dueOf(p: ProductRow, ports: PortRow[], today = nowIso().slice(0, 10)): DataPortReviewDue[] {
  const months = reviewMonthsOf(p.id);
  if (!months) return [];
  const outputs = ports.filter((x) => x.direction === 'output' && x.lifecycle !== 'retired');
  if (!outputs.length) return [];
  const last = new Map(
    db()
      .all<{ port_id: string; environment: string; at: string }>(
        "SELECT port_id, environment, MAX(approved_at) AS at FROM dp_port_reviews WHERE product_id = ? AND status = 'approved' GROUP BY port_id, environment",
        p.id,
      )
      .map((r) => [`${r.port_id}|${r.environment}`, r.at]),
  );
  const out: DataPortReviewDue[] = [];
  for (const b of bindingsOf(outputs.map((x) => x.id))) {
    const port = outputs.find((x) => x.id === b.port_id)!;
    const lastAt = last.get(`${b.port_id}|${b.environment}`) ?? null;
    const dueDate = lastAt ? addMonths(lastAt.slice(0, 10), months) : today;
    out.push({
      portId: port.id,
      portName: `${port.name}${port.version ? ` ${port.version}` : ''}`,
      environment: b.environment,
      lastApprovedAt: lastAt,
      dueDate,
      overdue: dueDate < today,
    });
  }
  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.portName.localeCompare(b.portName));
}

function reviewRow(id: string): ReviewRow {
  const r = db().get<ReviewRow>('SELECT * FROM dp_port_reviews WHERE id = ?', id);
  if (!r) throw reviewNotFound(id);
  return r;
}

/** A review of a product the caller may see (else: not found). */
function visibleReview(id: string, u: AuthUser): { r: ReviewRow; p: ProductRow } {
  const r = reviewRow(id);
  const p = productRow(r.product_id);
  if (!p) throw reviewNotFound(id);
  try {
    visibleProduct(p.id, u);
  } catch {
    throw reviewNotFound(id);
  }
  return { r, p };
}

/** GET /api/data-products/port-reviews/:reviewId */
export function getReview(id: string): DataPortReview {
  const u = me();
  const { r, p } = visibleReview(id, u);
  const items = db().all<ItemRow>('SELECT * FROM dp_port_review_items WHERE review_id = ? ORDER BY seq', r.id);
  const port = portRow(r.port_id);
  return {
    ...summary(r, port, { items: items.length, removals: items.filter((i) => i.decision === 'remove').length }),
    submittedBy: r.submitted_by,
    submittedAt: r.submitted_at,
    approvedBy: r.approved_by,
    approvalComment: r.approval_comment,
    sealHash: r.seal_hash,
    check: parseJson<DataPortReview['check']>(r.check_info, null),
    entries: items.map(itemView),
    mayDecide: mayDecide(u, r, p),
    mayApprove: mayApprove(u, r, p),
  };
}

interface Frozen {
  kind: DataPortReviewItemKind;
  consumerId: string | null;
  label: string;
  finding: string;
  detail: string;
}

/** The grants of an access check on the port's objects (the check read now as for person reviews, else its last snapshot). */
async function grantsOf(checkId: string, objects: string[]): Promise<{ items: Frozen[]; check: NonNullable<DataPortReview['check']> }> {
  if (!moduleEnabled('compliance')) throw new HttpError(404, `Access check ${checkId} not found`, 'ACCESS_CHECK_NOT_FOUND', { id: checkId });
  const { getCheck, readCheckSource } = await import('../compliance/reconciliation.js');
  const check = getCheck(checkId);
  const read = await readCheckSource(checkId);
  const names = objects.map((o) => o.toLowerCase());
  const mentions = (right: string) => names.some((n) => right.toLowerCase().includes(n));
  // a check scoped to the port's objects names them in no right: then every right it read is about them
  const scoped = !read.subjects.some((s) => s.rights.some(mentions));
  const items: Frozen[] = [];
  for (const s of read.subjects) {
    const rights = scoped ? s.rights : s.rights.filter(mentions);
    if (!rights.length) continue;
    items.push({ kind: 'grant', consumerId: null, label: s.name || s.id, finding: rights.join(', ').slice(0, 2_000), detail: s.type ?? '' });
  }
  return { items, check: { id: check.id, name: check.name, origin: read.origin, takenAt: read.takenAt, error: read.error } };
}

/** POST /api/data-products/:id/ports/:portId/reviews (session only) – who decides access requests of the product. */
export async function startReview(productId: string, portId: string, body: unknown): Promise<DataPortReview> {
  const u = me();
  const { row: p } = visibleProduct(productId, u);
  if (!decidesFor(u, p)) forbid('review the consumers of this data product', 'dataProducts');
  const port = portRow(portId);
  if (!port || port.product_id !== p.id) throw portNotFound(portId);
  if (port.direction !== 'output') throw reviewState('Consumers are reviewed on output ports', 'inputPort');
  const input = dataPortReviewInput.parse(body);
  if (db().get("SELECT 1 FROM dp_port_reviews WHERE port_id = ? AND environment = ? AND status <> 'approved'", port.id, input.environment))
    throw reviewState('A review of this port is open already', 'open');
  const actual = actualView(p.id, port.id, input.environment);
  const frozen: Frozen[] = [];
  for (const d of actual.declared)
    frozen.push({
      kind: 'registered',
      consumerId: d.consumerId,
      label: d.label ?? `(${d.kind})`,
      finding: d.state,
      detail: [d.purpose, d.endDate ? `until ${d.endDate}` : '', d.identities.join(', '), d.seenAs.length ? `seen as ${d.seenAs.join(', ')}` : '']
        .filter(Boolean)
        .join(' · ')
        .slice(0, 2_000),
    });
  for (const a of actual.actual.filter((x) => !x.registeredAs.length))
    frozen.push({
      kind: 'actual',
      consumerId: null,
      label: `${a.kind}:${a.name}`,
      finding: 'notRegistered',
      detail: [a.platformName, a.objects.join(', '), a.reads !== null ? `${a.reads} reads` : '', a.lastSeen ? `last ${a.lastSeen.slice(0, 10)}` : '']
        .filter(Boolean)
        .join(' · ')
        .slice(0, 2_000),
    });
  let check: DataPortReview['check'] = null;
  if (input.checkId) {
    const b = bindingsOf([port.id]).find((x) => x.environment === input.environment);
    const objects = b ? [...elementsByIds(b.elementIds).values()].map((e) => e.qualified_name) : [];
    const g = await grantsOf(input.checkId, objects);
    frozen.push(...g.items);
    check = g.check;
  }
  if (frozen.length > G.reviewItems) throw reviewState(`At most ${G.reviewItems} entries per review`, 'tooLarge', { max: G.reviewItems });
  const id = newId(DATA_GOVERNANCE_ID_PREFIX.review);
  const now = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO dp_port_reviews (id, product_id, port_id, environment, status, four_eyes, check_info, created_by, created_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      id,
      p.id,
      port.id,
      input.environment,
      input.fourEyes ? 1 : 0,
      check ? JSON.stringify(check) : null,
      u.username,
      now,
    );
    frozen.forEach((f, i) =>
      db().run(
        'INSERT INTO dp_port_review_items (id, review_id, seq, kind, consumer_id, label, finding, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        newId(DATA_GOVERNANCE_ID_PREFIX.reviewItem),
        id,
        i + 1,
        f.kind,
        f.consumerId,
        f.label.slice(0, 500),
        f.finding,
        f.detail,
      ),
    );
    audit({
      action: 'dataproduct.access_review_started',
      entityType: 'data_product',
      entityId: p.id,
      summary: `Data product "${p.name}": access review of port "${port.name}" (${input.environment}) started with ${frozen.length} entries`,
      details: { reviewId: id, portId: port.id, environment: input.environment, entries: frozen.length, checkId: input.checkId, fourEyes: input.fourEyes },
    });
  });
  return getReview(id);
}

/** PUT /api/data-products/port-reviews/:reviewId/decisions – keep or remove per entry (a removal needs a reason). */
export function decideItems(id: string, body: unknown): DataPortReview {
  const u = me();
  const { r, p } = visibleReview(id, u);
  if (!mayDecide(u, r, p)) {
    if (r.status !== 'open') throw reviewState('The review is not open', 'notOpen');
    forbid('review the consumers of this data product', 'dataProducts');
  }
  const input = dataPortReviewDecisionsInput.parse(body);
  const items = new Map(
    db()
      .all<ItemRow>('SELECT * FROM dp_port_review_items WHERE review_id = ?', r.id)
      .map((i) => [i.id, i]),
  );
  for (const d of input.decisions) {
    if (!items.has(d.itemId)) throw new HttpError(400, `Entry ${d.itemId} is not part of this review`, 'DATA_PORT_REVIEW_STATE', { context: 'item' });
    if (d.decision === 'remove' && !d.comment) throw reviewState('Say why it is removed', 'comment');
  }
  const now = nowIso();
  db().tx(() => {
    for (const d of input.decisions)
      db().run(
        'UPDATE dp_port_review_items SET decision = ?, comment = ?, decided_by = ?, decided_at = ? WHERE id = ? AND review_id = ?',
        d.decision,
        d.comment,
        d.decision ? u.username : null,
        d.decision ? now : null,
        d.itemId,
        r.id,
      );
  });
  return getReview(id);
}

/**
 * The seal: SHA-256 over the canonical review and its decisions – everything the evidence says: four eyes or not, the
 * approver's comment, and per entry what was frozen (its detail too: purposes, identities, who was seen) and who
 * decided it when.
 */
function sealOf(r: ReviewRow, items: ItemRow[]): string {
  return sha256(
    canonicalJson({
      id: r.id,
      productId: r.product_id,
      portId: r.port_id,
      environment: r.environment,
      fourEyes: !!Number(r.four_eyes),
      createdBy: r.created_by,
      createdAt: r.created_at,
      submittedBy: r.submitted_by,
      submittedAt: r.submitted_at,
      approvedBy: r.approved_by,
      approvedAt: r.approved_at,
      approvalComment: r.approval_comment,
      check: parseJson(r.check_info, null),
      items: items.map((i) => ({
        seq: Number(i.seq),
        kind: i.kind,
        consumerId: i.consumer_id,
        label: i.label,
        finding: i.finding,
        detail: i.detail,
        decision: i.decision,
        comment: i.comment,
        decidedBy: i.decided_by,
        decidedAt: i.decided_at,
      })),
    }),
  );
}

/** Approved: sealed, registrations decided _remove_ end today (inside the transaction). */
function seal(r: ReviewRow, p: ProductRow, approver: string, comment: string): void {
  const now = nowIso();
  db().run("UPDATE dp_port_reviews SET status = 'approved', approved_by = ?, approved_at = ?, approval_comment = ? WHERE id = ?", approver, now, comment, r.id);
  const row = reviewRow(r.id);
  const items = db().all<ItemRow>('SELECT * FROM dp_port_review_items WHERE review_id = ? ORDER BY seq', r.id);
  const hash = sealOf(row, items);
  db().run('UPDATE dp_port_reviews SET seal_hash = ? WHERE id = ?', hash, r.id);
  const ended: string[] = [];
  for (const i of items.filter((x) => x.kind === 'registered' && x.decision === 'remove' && x.consumer_id)) {
    const c = db().get<{ id: string; end_date: string | null }>('SELECT id, end_date FROM dp_consumers WHERE id = ?', i.consumer_id);
    if (!c || (c.end_date && c.end_date <= now.slice(0, 10))) continue;
    db().run('UPDATE dp_consumers SET end_date = ?, updated_at = ?, updated_by = ? WHERE id = ?', now.slice(0, 10), now, approver, c.id);
    ended.push(c.id);
  }
  audit({
    action: 'dataproduct.access_review_approved',
    entityType: 'data_product',
    entityId: p.id,
    summary: `Data product "${p.name}": access review of a port (${r.environment}) approved and sealed – ${items.filter((i) => i.decision === 'remove').length} to remove, ${ended.length} registration(s) ended`,
    details: {
      reviewId: r.id,
      portId: r.port_id,
      environment: r.environment,
      sealHash: hash,
      removals: items.filter((i) => i.decision === 'remove').map((i) => ({ kind: i.kind, label: i.label })),
      endedConsumers: ended,
    },
  });
}

/** POST /api/data-products/port-reviews/:reviewId/submit (session only) – every entry decided; without four eyes sealed at once. */
export function submitReview(id: string): DataPortReview {
  const u = me();
  const { r, p } = visibleReview(id, u);
  if (!mayDecide(u, r, p)) {
    if (r.status !== 'open') throw reviewState('The review is not open', 'notOpen');
    forbid('review the consumers of this data product', 'dataProducts');
  }
  const open = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM dp_port_review_items WHERE review_id = ? AND decision IS NULL', r.id)!.n);
  if (open) throw reviewState(`${open} entries are not decided yet`, 'undecided', { count: open });
  const now = nowIso();
  db().tx(() => {
    db().run("UPDATE dp_port_reviews SET status = 'submitted', submitted_by = ?, submitted_at = ? WHERE id = ?", u.username, now, r.id);
    audit({
      action: 'dataproduct.access_review_submitted',
      entityType: 'data_product',
      entityId: p.id,
      summary: `Data product "${p.name}": access review of a port (${r.environment}) submitted`,
      details: { reviewId: r.id, portId: r.port_id, fourEyes: !!r.four_eyes },
    });
    if (!r.four_eyes) seal(reviewRow(r.id), p, u.username, '');
  });
  return getReview(id);
}

/** POST /api/data-products/port-reviews/:reviewId/approval (session only) – a second person approves (sealed) or sends it back. */
export function approveReview(id: string, body: unknown): DataPortReview {
  const u = me();
  const { r, p } = visibleReview(id, u);
  const input = dataPortReviewApprovalInput.parse(body);
  if (r.status !== 'submitted') throw reviewState('The review is not submitted', 'notSubmitted');
  if (samePerson(r.submitted_by, u)) throw reviewState('A second person approves', 'secondPerson');
  if (!mayApprove(u, r, p)) forbid('approve this access review', 'dataProducts');
  if (!input.approve && !input.comment) throw reviewState('Say why it goes back', 'comment');
  db().tx(() => {
    if (input.approve) seal(r, p, u.username, input.comment);
    else {
      db().run("UPDATE dp_port_reviews SET status = 'open', submitted_by = NULL, submitted_at = NULL, approval_comment = ? WHERE id = ?", input.comment, r.id);
      audit({
        action: 'dataproduct.access_review_returned',
        entityType: 'data_product',
        entityId: p.id,
        summary: `Data product "${p.name}": access review of a port sent back`,
        details: { reviewId: r.id, comment: input.comment.slice(0, 500) },
      });
    }
  });
  return getReview(id);
}

/** GET …/port-reviews/:reviewId/verify – recomputes the seal (a change in the database shows up). */
export function verifyReview(id: string): { sealed: boolean; ok: boolean; stored: string | null; computed: string | null } {
  const u = me();
  const { r } = visibleReview(id, u);
  if (!r.seal_hash) return { sealed: false, ok: false, stored: null, computed: null };
  const computed = sealOf(r, db().all<ItemRow>('SELECT * FROM dp_port_review_items WHERE review_id = ? ORDER BY seq', r.id));
  return { sealed: true, ok: computed === r.seal_hash, stored: r.seal_hash, computed };
}

// ---------- reminders ----------

/** `dataproduct.access_review_due`: ports whose review is due (today or overdue), to who decides – once per port, environment and due date. */
export function noticeReviewsDue(today = nowIso().slice(0, 10)): number {
  let sent = 0;
  try {
    const products = db().all<{ product_id: string }>('SELECT product_id FROM dp_access_settings WHERE review_months IS NOT NULL');
    if (!products.length) return 0;
    const all = people();
    for (const { product_id } of products) {
      const p = productRow(product_id);
      if (!p || p.lifecycle === 'retired') continue;
      for (const d of dueOf(p, portsOf([p.id]), today)) {
        if (d.dueDate > today || !claimNotice('review', `${d.portId}|${d.environment}`, d.dueDate)) continue;
        sent += send({
          event: 'dataproduct.access_review_due',
          recipients: decidersOf(all, p),
          link: productLink(p.id, 'access'),
          key: `review:${d.portId}:${d.environment}:${d.dueDate}`,
          title: (l) => t(l, 'dataProductGovernance.reviewDue.title', { product: titleName(p.name), port: titleName(d.portName, 60) }),
          lines: (l) => [
            t(l, 'dataProductGovernance.reviewDue.body', { port: d.portName, product: p.name, environment: d.environment, date: d.dueDate }),
            d.lastApprovedAt
              ? t(l, 'dataProductGovernance.reviewDue.last', { date: d.lastApprovedAt.slice(0, 10) })
              : t(l, 'dataProductGovernance.reviewDue.never'),
            t(l, 'dataProductGovernance.reviewDue.hint'),
          ],
          data: { productId: p.id, portId: d.portId, environment: d.environment, dueDate: d.dueDate },
        });
      }
    }
  } catch (err) {
    logger.warn({ err }, 'access review reminders could not be sent');
  }
  return sent;
}

/** Whether an access review of the product's ports was approved within its interval (the scorecard's confidentiality evidence). */
export function reviewedProducts(productIds: readonly string[], since: string): Set<string> {
  if (!productIds.length) return new Set();
  const out = new Set<string>();
  for (let i = 0; i < productIds.length; i += 500) {
    const part = productIds.slice(i, i + 500);
    for (const r of db().all<{ product_id: string }>(
      `SELECT DISTINCT product_id FROM dp_port_reviews WHERE status = 'approved' AND approved_at >= ? AND product_id IN (${part.map(() => '?').join(', ')})`,
      since,
      ...part,
    ))
      out.add(r.product_id);
  }
  return out;
}
