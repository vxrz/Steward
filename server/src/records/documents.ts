import { z } from 'zod';
import { sameIdentity } from '../auth/aliases.js';
import {
  REVIEW_OUTCOMES,
  type CredentialDue,
  type DocumentChangelogRow,
  type Locale,
  type RecordDetail,
  type RecordEdition,
  type RecordEditionSummary,
  type RecordReview,
  type UserInfo,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { currentUser, type AuthUser } from '../auth/context.js';
import { findUserByName, listUsers } from '../auth/users.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { formatDateTime, t } from '../i18n/index.js';
import { notify, titleName } from '../notifications/service.js';
import { reminderSettings } from '../credentials/service.js';
import { plannedReminder } from '../credentials/reminders.js';
import { isAdmin } from '../auth/permissions.js';
import { RECORD_APPROVER_ROLES, RECORD_EDITOR_ROLES, canApproveRecord, canEditRecord, forbid, me, statusParam, canReadRecordRow } from './access.js';
import { requireRecordRow, type RecordRow } from './model.js';
import { requireType, type TypeRow } from './types.js';
import { canReviewDocument, getRecord, startRevision, withStoredFields, workflowOf } from './service.js';
import {
  addMonths,
  currentApprovedAt,
  docRow,
  documentStates,
  editionRow,
  editionRows,
  ensureDocRow,
  intactEditions,
  isDocument,
  regularNextReview,
  intactReviews,
  reviewMetaHash,
  reviewRows,
  reviewState,
  reviewsOf,
  toEdition,
  toEditionSummary,
  updateDocRow,
  type ReviewRow,
} from './document-model.js';

/**
 * Living documents: reading editions, the document changelog, periodic reviews ("Reviewed – no change",
 * "Needs update"), the review settings of a document, the review reminders and the start page tile.
 * Editions themselves are created by approving a document (service.ts → approveEdition).
 */

const LIMITS = { comment: 4000 };

function requireDocument(idOrNumber: string): { r: RecordRow; t: TypeRow } {
  const r = requireRecordRow(idOrNumber);
  const t = requireType(r.type_id);
  if (!isDocument(t))
    throw new HttpError(409, `${r.number} is not a living document (its type has the workflow "${t.workflow}")`, 'NOT_A_DOCUMENT', { number: r.number });
  return { r, t };
}

// ---------- editions ----------

/** Editions of a record, newest first (empty for records that are not documents). */
export function listEditions(idOrNumber: string): RecordEditionSummary[] {
  me();
  const r = requireRecordRow(idOrNumber);
  const t = requireType(r.type_id);
  if (!isDocument(t)) return [];
  const rows = editionRows(r.id);
  const current = docRow(r.id)?.current_edition ?? null;
  const intact = intactEditions(r, t.key, rows);
  return rows.map((e) => toEditionSummary(e, current, intact.has(e.edition)));
}

/** One frozen edition with its content. */
export function getEdition(idOrNumber: string, edition: string): RecordEdition {
  me();
  const { r, t } = requireDocument(idOrNumber);
  const e = editionRow(r.id, edition);
  if (!e) throw new HttpError(404, `Edition ${edition} of ${r.number} not found`, 'EDITION_NOT_FOUND', { edition, number: r.number });
  const intact = intactEditions(r, t.key, [e]);
  return toEdition(e, docRow(r.id)?.current_edition ?? null, intact.has(e.edition));
}

/**
 * A record as it was when an edition was approved – its frozen content, files and the history up to the
 * approval, with the editions and reviews up to then – for the PDF of that edition.
 */
export function editionAsRecord(rec: RecordDetail, edition: string): RecordDetail {
  if (!rec.document) throw new HttpError(409, `${rec.number} is not a living document`, 'NOT_A_DOCUMENT', { number: rec.number });
  const e = getEdition(rec.id, edition);
  const byId = new Map(rec.attachments.map((a) => [a.id, a]));
  const order = (x: { major: number; minor: number }) => x.major * 100000 + x.minor;
  const later = rec.document.editions.filter((x) => order(x) > order(e)).sort((a, b) => order(a) - order(b))[0];
  // the next edition's approval ends what belongs to this one
  const until = later?.approvedAt ?? '9999';
  return {
    ...rec,
    title: e.title,
    body: e.body,
    fields: e.fields,
    fieldDefs: withStoredFields(e.fieldDefs, e.fields),
    status: 'published',
    revision: e.revision,
    version: e.version,
    contentHash: e.contentHash,
    frozenHash: e.contentHash,
    frozen: true,
    tampered: !e.intact,
    submittedBy: e.submittedBy,
    submittedAt: e.submittedAt,
    attachments: e.attachments.map((a) => {
      const row = byId.get(a.id);
      return row
        ? { ...row, kind: 'file' as const }
        : {
            id: a.id,
            kind: 'file' as const,
            filename: a.filename,
            mime: '',
            size: a.size,
            sha256: a.sha256,
            revision: e.revision,
            createdAt: e.approvedAt,
            createdBy: '',
            details: null,
          };
    }),
    events: rec.events.filter((x) => x.createdAt <= e.approvedAt),
    document: {
      ...rec.document,
      pending: null,
      editions: rec.document.editions.filter((x) => order(x) <= order(e)),
      reviews: rec.document.reviews.filter((v) => v.createdAt < until),
    },
  };
}

export function listReviews(idOrNumber: string): RecordReview[] {
  me();
  const r = requireRecordRow(idOrNumber);
  if (!isDocument(requireType(r.type_id))) return [];
  return reviewsOf(r.id);
}

/** Editions and reviews of a document, newest first: the document changelog. */
export function changelog(idOrNumber: string): DocumentChangelogRow[] {
  me();
  const r = requireRecordRow(idOrNumber);
  const t = requireType(r.type_id);
  if (!isDocument(t)) return [];
  const editions = editionRows(r.id);
  const reviews = reviewRows(r.id);
  const okEditions = intactEditions(r, t.key, editions);
  const okReviews = intactReviews(r.id, reviews);
  const rows: DocumentChangelogRow[] = [
    ...editions.map((e): DocumentChangelogRow => ({
      kind: 'edition',
      at: e.approved_at,
      edition: e.edition,
      people: parseJson<string[]>(e.authors, []),
      approvedBy: e.approved_by,
      text: e.change_summary,
      outcome: null,
      editionKind: e.kind,
      contentHash: e.content_hash,
      intact: okEditions.has(e.edition),
    })),
    ...reviews.map((v): DocumentChangelogRow => ({
      kind: 'review',
      at: v.created_at,
      edition: v.edition,
      people: [v.reviewer],
      approvedBy: null,
      text: v.comment,
      outcome: v.outcome,
      editionKind: null,
      contentHash: null,
      intact: okReviews.has(v.id),
    })),
  ];
  return rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.kind === 'review' ? -1 : 1));
}

// ---------- reviews ----------

export const reviewInput = z
  .object({
    outcome: z.enum(REVIEW_OUTCOMES),
    comment: z.string().max(LIMITS.comment).default(''),
  })
  .strict();

/**
 * Records a periodic review of the current edition. "no_change": the edition stays valid and the next
 * review is counted from now. "needs_update": the document gets a draft of its next edition (revising);
 * the review stays due until that edition is approved.
 */
export function reviewDocument(idOrNumber: string, input: z.infer<typeof reviewInput>): RecordDetail {
  const u = me();
  const { r, t } = requireDocument(idOrNumber);
  const d = ensureDocRow(r.id);
  if (!canReviewDocument(u, r, d)) forbid('review this document', 'reviewDocument');
  if (!d.current_edition)
    throw new HttpError(409, `${r.number} has no approved edition yet: there is nothing to review`, 'DOCUMENT_NO_EDITION', { number: r.number });
  if (!['published', 'revising'].includes(r.status))
    throw new HttpError(409, `${r.number} is ${r.status}: only a published document is reviewed`, 'INVALID_TRANSITION', {
      number: r.number,
      status: statusParam(r.status),
    });
  // a review found that the document needs an update: it stays due until the next edition is approved
  if (input.outcome === 'no_change' && d.update_requested_at)
    throw new HttpError(
      409,
      `A review found that ${r.number} needs an update: the review stays due until the next edition is approved`,
      'DOCUMENT_UPDATE_REQUESTED',
      { number: r.number },
    );
  const comment = input.comment.trim();
  if (input.outcome === 'needs_update' && !comment) throw new HttpError(400, 'Please say what needs to change', 'COMMENT_REQUIRED');
  const now = nowIso();
  const approvedAt = currentApprovedAt(d);
  const wf = workflowOf(t);
  db().tx(() => {
    let next: string | null;
    if (input.outcome === 'no_change') {
      updateDocRow(r.id, { last_reviewed_at: now, last_reviewed_by: u.username, next_review_override: null, update_requested_at: null });
      next = reviewState(r, t, docRow(r.id), approvedAt).nextReviewAt;
    } else {
      // the review date does not move: the review stays due until the next edition is approved
      updateDocRow(r.id, { update_requested_at: d.update_requested_at ?? now });
      next = reviewState(r, t, docRow(r.id), approvedAt).nextReviewAt;
    }
    const id = newId('rrv_');
    const row: ReviewRow = {
      id,
      record_id: r.id,
      outcome: input.outcome,
      edition: d.current_edition,
      reviewer: u.username,
      comment,
      next_review_at: next,
      created_at: now,
    };
    db().run(
      'INSERT INTO record_reviews (id, record_id, outcome, edition, reviewer, comment, next_review_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      row.id,
      row.record_id,
      row.outcome,
      row.edition,
      row.reviewer,
      row.comment,
      row.next_review_at,
      row.created_at,
    );
    const edition = editionRow(r.id, d.current_edition!);
    audit({
      action: 'record.reviewed',
      entityType: 'record',
      entityId: r.id,
      summary: `${r.number} edition ${d.current_edition} reviewed: ${input.outcome === 'no_change' ? 'no change' : 'needs update'}${comment ? ` – ${comment.slice(0, 300)}` : ''}`,
      details: {
        number: r.number,
        reviewId: id,
        edition: d.current_edition,
        outcome: input.outcome,
        contentHash: edition?.content_hash ?? null,
        nextReviewAt: next,
        // seals the stored review (outcome, reviewer, comment, dates): see intactReviews
        metaHash: reviewMetaHash(row),
      },
    });
    if (input.outcome === 'needs_update' && r.status === 'published') startRevision(r, t, wf, `Review: ${comment}`);
  });
  return getRecord(r.id);
}

export const reviewSettingsInput = z
  .object({
    /** User name of the review owner; null: the document's owner */
    reviewOwner: z.string().trim().max(128).nullable().optional(),
    /** Months between reviews of this document (0 = none); null: the type's interval */
    intervalMonths: z.number().int().min(0).max(120).nullable().optional(),
    /** An earlier date for the next review (YYYY-MM-DD); null: none */
    nextReviewAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD')
      .nullable()
      .optional(),
  })
  .strict();

/** Whoever wrote the document: its owner, its creator, the authors and submitters of its editions and every author of a saved version. */
function wroteDocument(user: { id: string; username: string }, r: RecordRow): boolean {
  // former names of an imported account count as the same person (auth/aliases.ts)
  const same = (a: string | null | undefined) => sameIdentity(a, user);
  if (same(r.owner) || same(r.created_by) || same(r.submitted_by)) return true;
  if (
    db()
      .all<{ author: string }>('SELECT DISTINCT author FROM record_versions WHERE record_id = ?', r.id)
      .some((v) => same(v.author))
  )
    return true;
  return editionRows(r.id).some((e) => same(e.submitted_by) || parseJson<string[]>(e.authors, []).some(same));
}

/**
 * Review owner, interval and an earlier next review date of a document. Reviews are a control, so whoever
 * looks after the document cannot silence them: an earlier date (stricter) may be set by editors, the owner
 * and approvers; clearing it or moving it later, the review owner and the document's own interval need an
 * approver or administrator; no reviews (0) or an interval longer than the type's need an administrator. An
 * approver who owns or wrote the document cannot make themselves its review owner (four-eyes).
 */
export function updateReviewSettings(idOrNumber: string, input: z.infer<typeof reviewSettingsInput>): RecordDetail {
  const u = me();
  const { r, t } = requireDocument(idOrNumber);
  const approver = canApproveRecord(u, r);
  if (!canEditRecord(u, r) && !approver) forbid('change the review settings of this document', 'reviewSettings');
  if (r.status === 'withdrawn')
    throw new HttpError(409, `${r.number} is withdrawn: it is not reviewed any more`, 'RECORD_CLOSED', { number: r.number, status: statusParam(r.status) });
  const d = ensureDocRow(r.id);
  const patch: Parameters<typeof updateDocRow>[1] = {};
  const changes: Record<string, unknown> = {};
  if (input.reviewOwner !== undefined) {
    let owner: string | null = null;
    if (input.reviewOwner) {
      const target = findUserByName(input.reviewOwner);
      if (!target || !target.active) throw new HttpError(400, `User ${input.reviewOwner} not found`, 'USER_NOT_FOUND', { name: input.reviewOwner });
      owner = target.username.toLowerCase() === r.owner.toLowerCase() ? null : target.username;
    }
    if (owner !== d.review_owner) {
      if (!approver) forbid('choose the review owner of this document', 'reviewOwner');
      if (owner && owner.toLowerCase() === u.username.toLowerCase() && !isAdmin(u) && wroteDocument(u, r))
        forbid('make yourself the review owner of a document you own or wrote', 'reviewOwnerSelf');
      ((patch.review_owner = owner), (changes.reviewOwner = owner ?? r.owner));
    }
  }
  if (input.intervalMonths !== undefined && input.intervalMonths !== (d.review_interval_months === null ? null : Number(d.review_interval_months))) {
    if (!approver) forbid('change the review interval of this document', 'reviewInterval');
    const typeInterval = reviewState(r, t, d, null).typeIntervalMonths;
    const months = input.intervalMonths;
    if (months !== null && !isAdmin(u) && (months === 0 || (typeInterval > 0 && months > typeInterval)))
      forbid('turn off the reviews of this document or plan them less often than its type', 'reviewIntervalAdmin');
    ((patch.review_interval_months = months), (changes.intervalMonths = months));
  }
  if (input.nextReviewAt !== undefined) {
    let at: string | null = null;
    if (input.nextReviewAt) {
      const ts = Date.parse(`${input.nextReviewAt}T00:00:00.000Z`);
      if (Number.isNaN(ts)) throw new HttpError(400, 'Not a date', 'INVALID_INPUT');
      at = new Date(ts).toISOString();
      if (at.slice(0, 10) < nowIso().slice(0, 10)) throw new HttpError(400, 'The next review cannot be in the past', 'REVIEW_DATE_PAST');
      const interval = patch.review_interval_months !== undefined ? patch.review_interval_months : d.review_interval_months;
      const state = reviewState(r, t, { ...d, review_interval_months: interval ?? null, next_review_override: null }, currentApprovedAt(d));
      const regular = regularNextReview(currentApprovedAt(d), d.last_reviewed_at, state.intervalMonths);
      if (regular && at >= regular)
        throw new HttpError(400, `The next review can only be set earlier than planned (${regular.slice(0, 10)})`, 'REVIEW_DATE_LATER', {
          date: regular.slice(0, 10),
        });
    }
    if (at !== d.next_review_override) {
      // an earlier date makes the review stricter; dropping one or moving it later does not
      if (d.next_review_override && (!at || at > d.next_review_override) && !approver)
        forbid('drop or postpone the planned review date of this document', 'reviewDateLater');
      ((patch.next_review_override = at), (changes.nextReviewAt = at));
    }
  }
  if (!Object.keys(patch).length) return getRecord(r.id);
  db().tx(() => {
    updateDocRow(r.id, patch);
    audit({
      action: 'record.review_settings_changed',
      entityType: 'record',
      entityId: r.id,
      summary: `Review settings of ${r.number} changed (${Object.keys(changes).join(', ')})`,
      details: { number: r.number, ...changes },
    });
  });
  return getRecord(r.id);
}

// ---------- reminders ----------

/** Active users of the review owner (else the owner; else the administrators). */
function reviewRecipients(owner: string, all: UserInfo[]): UserInfo[] {
  const named = all.filter((u) => u.username.toLowerCase() === owner.toLowerCase());
  return named.length ? named : all.filter((u) => u.roles.includes('admin'));
}

function reminderText(
  l: Locale,
  r: Pick<RecordRow, 'number' | 'title'>,
  edition: string,
  dueAt: string,
  phase: 'before' | 'overdue' | 'expired',
  days: number,
) {
  const vars = { number: r.number, title: titleName(r.title), edition, date: formatDateTime(l, dueAt) };
  return {
    title: phase === 'before' ? t(l, 'documentReview.titleBefore', { ...vars, count: days }) : t(l, 'documentReview.titleOverdue', vars),
    body: [
      phase === 'before' ? t(l, 'documentReview.bodyBefore', { ...vars, title: r.title }) : t(l, 'documentReview.bodyOverdue', { ...vars, title: r.title }),
      t(l, 'documentReview.howTo'),
    ].join('\n'),
  };
}

const claim = (recordId: string, key: string): boolean =>
  db().run('INSERT INTO record_review_reminders (record_id, reminder_key, sent_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', recordId, key, nowIso())
    .changes === 1;

/**
 * Review reminders to the review owner, with the schedule of the credentials register reminders (Settings →
 * credentials reminders: days before, overdue every N days): before the date the reminder of the smallest
 * threshold reached is sent once; after it, every N days. Each reminder is claimed under a key with the due
 * date, so it goes out at most once (also across restarts) and a new date re-arms the thresholds.
 */
export function checkDocumentReviews(now = Date.now()): number {
  if (!vault().unlocked) return 0;
  const settings = reminderSettings();
  if (!settings.enabled) return 0;
  const cfg = { daysBefore: settings.daysBefore, overdueEveryDays: settings.overdueEveryDays };
  const states = documentStates(now, settings.dueSoonDays);
  let sent = 0;
  let all: UserInfo[] | null = null;
  for (const [recordId, s] of states) {
    if (!s.edition || !s.review.nextReviewAt) continue;
    const due: CredentialDue = { kind: 'review', dueAt: s.review.nextReviewAt, daysLeft: s.review.daysLeft ?? 0, status: 'ok' };
    const plan = plannedReminder(due, cfg, now);
    if (!plan || !claim(recordId, plan.key)) continue;
    // smaller thresholds already passed count as sent (no burst of older reminders)
    if (plan.phase === 'before') for (const d of cfg.daysBefore.filter((x) => x > plan.days)) claim(recordId, `review:${due.dueAt.slice(0, 10)}:before:${d}`);
    const r = db().get<RecordRow>('SELECT * FROM records WHERE id = ?', recordId);
    if (!r) continue;
    all ??= listUsers().filter((u) => u.active);
    const users = reviewRecipients(s.review.owner, all);
    try {
      notify({
        event: 'document.review',
        text: (l) => reminderText(l, r, s.edition!, due.dueAt, plan.phase, plan.days),
        link: `/records/${encodeURIComponent(r.id)}?tab=changelog`,
        recipients: users,
        inAppKey: `document:${r.id}:${plan.key}`,
        externalKey: `document:${r.id}:${plan.key}`,
        data: { recordId: r.id, number: r.number, edition: s.edition, nextReviewAt: due.dueAt, phase: plan.phase },
      });
      audit({
        action: 'record.review_reminder_sent',
        entityType: 'record',
        entityId: r.id,
        actor: 'system',
        summary: `Review reminder for ${r.number} (edition ${s.edition}, due ${due.dueAt.slice(0, 10)}) sent to ${users.map((x) => x.username).join(', ') || 'nobody'}`,
        details: { number: r.number, edition: s.edition, reminder: plan.key, nextReviewAt: due.dueAt, users: users.map((x) => x.username) },
      });
      sent++;
    } catch (err) {
      logger.warn({ err, recordId: r.id }, 'document review reminder could not be sent');
    }
  }
  return sent;
}

// ---------- start page, summaries ----------

const ATTENTION_ROLES = [...new Set([...RECORD_EDITOR_ROLES, ...RECORD_APPROVER_ROLES, 'auditor' as const])];

/**
 * The start page's "Reviews due" tile: documents due soon or overdue. Records are readable by everyone, but
 * the tile is for people who look after documents – editors, approvers, auditors, and whoever owns or
 * reviews a document; null for the rest (no tile).
 */
export function reviewAttention(now = Date.now()): { overdue: number; dueSoon: number } | null {
  const u = currentUser();
  if (!u) return null;
  // documents the user may see (#131)
  const states = new Map(
    [...documentStates(now)].filter(([id]) => {
      const r = db().get<{ id: string; type_id: string; fields: string; owner: string }>('SELECT id, type_id, fields, owner FROM records WHERE id = ?', id);
      return !!r && canReadRecordRow(u, r);
    }),
  );
  const mine = (s: { review: { owner: string } }, recordId: string) =>
    s.review.owner.toLowerCase() === u.username.toLowerCase() ||
    db().get<{ owner: string }>('SELECT owner FROM records WHERE id = ?', recordId)?.owner.toLowerCase() === u.username.toLowerCase();
  const broad = u.roles.some((x) => ATTENTION_ROLES.includes(x));
  if (!broad && ![...states].some(([id, s]) => mine(s, id))) return null;
  let overdue = 0;
  let dueSoon = 0;
  for (const [id, s] of states) {
    if (!broad && !mine(s, id)) continue;
    if (s.review.status === 'overdue') overdue++;
    else if (s.review.status === 'dueSoon') dueSoon++;
  }
  return { overdue, dueSoon };
}

/** Documents whose review is due soon or overdue and that the user reviews (review owner, else owner). */
export function reviewsDueFor(
  u: AuthUser,
  now = Date.now(),
): { id: string; number: string; title: string; edition: string; status: 'dueSoon' | 'overdue'; nextReviewAt: string }[] {
  const out: { id: string; number: string; title: string; edition: string; status: 'dueSoon' | 'overdue'; nextReviewAt: string }[] = [];
  for (const [id, s] of documentStates(now)) {
    if (s.review.status !== 'dueSoon' && s.review.status !== 'overdue') continue;
    if (s.review.owner.toLowerCase() !== u.username.toLowerCase()) continue;
    const r = db().get<{ number: string; title: string }>('SELECT number, title FROM records WHERE id = ?', id);
    if (r) out.push({ id, number: r.number, title: r.title, edition: s.edition ?? '', status: s.review.status, nextReviewAt: s.review.nextReviewAt! });
  }
  return out.sort((a, b) => a.nextReviewAt.localeCompare(b.nextReviewAt));
}

export { addMonths };
