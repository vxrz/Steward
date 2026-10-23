import {
  DEFAULT_REVIEW_INTERVAL_MONTHS,
  EDITION_RE,
  type DocumentReviewState,
  type EditionKind,
  type RecordEdition,
  type RecordEditionSummary,
  type RecordFieldDef,
  type RecordReview,
  type ReviewOutcome,
  type ReviewStatus,
} from '@sm/shared';
import { db } from '../db.js';
import { authenticRows } from '../audit.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import { daysUntil, reminderSettings } from '../credentials/service.js';
import { contentHash, type RecordRow } from './model.js';
import { typeReviewInterval, type TypeRow } from './types.js';

/**
 * Living documents (workflow "document"): the stored state behind editions and periodic reviews.
 *
 * - An **edition** (1.0, 1.1, 2.0) is an approved state of a document. Approving copies the frozen content
 *   (title, text, fields, their definitions, the attached files) into record_editions together with its
 *   content hash, so it stays readable – and provable – while the next edition is drafted. Editions are
 *   never changed: there is no code path that updates a row of record_editions.
 * - A **review** confirms the current edition at a planned interval ("Reviewed – no change") or finds
 *   that it needs an update. The next review is due `interval` months after the approval of the current
 *   edition or the last review, whichever is later – or earlier, when someone set an earlier date.
 *
 * Due soon / overdue use the settings of the credentials register reminders (dueSoonDays), so both
 * registers behave the same.
 */

export interface DocRow {
  record_id: string;
  current_edition: string | null;
  pending_kind: EditionKind | null;
  pending_summary: string | null;
  review_owner: string | null;
  review_interval_months: number | null;
  next_review_override: string | null;
  last_reviewed_at: string | null;
  last_reviewed_by: string | null;
  update_requested_at: string | null;
  updated_at: string;
}

export interface EditionRow {
  record_id: string;
  major: number;
  minor: number;
  edition: string;
  kind: EditionKind;
  revision: number;
  version: number;
  title: string;
  body: string;
  fields: string;
  field_defs: string;
  attachments: string;
  content_hash: string;
  change_summary: string;
  authors: string;
  submitted_by: string | null;
  submitted_at: string | null;
  approved_by: string;
  approved_at: string;
}

export interface ReviewRow {
  id: string;
  record_id: string;
  outcome: ReviewOutcome;
  edition: string | null;
  reviewer: string;
  comment: string;
  next_review_at: string | null;
  created_at: string;
}

export const DOC_LIMITS = { changeSummary: 2000 };

export const isDocument = (t: Pick<TypeRow, 'workflow'>): boolean => t.workflow === 'document';

export const docRow = (recordId: string): DocRow | undefined => db().get<DocRow>('SELECT * FROM record_documents WHERE record_id = ?', recordId);

/** The document row of a record, created when missing. */
export function ensureDocRow(recordId: string): DocRow {
  db().run('INSERT INTO record_documents (record_id, updated_at) VALUES (?, ?) ON CONFLICT (record_id) DO NOTHING', recordId, nowIso());
  return docRow(recordId)!;
}

export function updateDocRow(recordId: string, patch: Partial<Omit<DocRow, 'record_id' | 'updated_at'>>): void {
  ensureDocRow(recordId);
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (!keys.length) return;
  db().run(
    `UPDATE record_documents SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE record_id = ?`,
    ...keys.map((k) => patch[k] ?? null),
    nowIso(),
    recordId,
  );
}

/** Editions, newest first. */
export const editionRows = (recordId: string): EditionRow[] =>
  db().all<EditionRow>('SELECT * FROM record_editions WHERE record_id = ? ORDER BY major DESC, minor DESC', recordId);

export function parseEdition(edition: string): { major: number; minor: number } {
  if (!EDITION_RE.test(edition)) throw new HttpError(400, `"${edition}" is not an edition (e.g. 1.0 or 2.1)`, 'EDITION_INVALID', { edition });
  const [major, minor] = edition.split('.').map(Number) as [number, number];
  return { major, minor };
}

export function editionRow(recordId: string, edition: string): EditionRow | undefined {
  const { major, minor } = parseEdition(edition);
  return db().get<EditionRow>('SELECT * FROM record_editions WHERE record_id = ? AND major = ? AND minor = ?', recordId, major, minor);
}

/** The numbers the next edition gets: the first one is 1.0; minor 1.0 → 1.1, major 1.x → 2.0. */
export function nextEditions(current: string | null): { minor: string; major: string } {
  if (!current) return { minor: '1.0', major: '1.0' };
  const { major, minor } = parseEdition(current);
  return { minor: `${major}.${minor + 1}`, major: `${major + 1}.0` };
}

/** Calendar months later (UTC); the 31st becomes the last day of a shorter month. */
export function addMonths(iso: string, months: number): string {
  const d = new Date(iso);
  const day = d.getUTCDate();
  const target = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()),
  );
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.toISOString();
}

/** Recomputes the content hash of a frozen edition from its stored content. */
export function editionHash(r: Pick<RecordRow, 'id' | 'number'>, typeKey: string, e: EditionRow): string {
  return contentHash(
    { id: r.id, number: r.number, revision: Number(e.revision), title: e.title, body: e.body, fields: e.fields },
    typeKey,
    parseJson<{ filename: string; sha256: string; size: number }[]>(e.attachments, []),
  );
}

/**
 * Whether the stored editions are what was approved: the stored content still has its hash, and the hash is
 * the one in the authentic (HMAC-chained) audit entry of the approval. Returns the editions that pass.
 */
export function intactEditions(r: Pick<RecordRow, 'id' | 'number'>, typeKey: string, rows: EditionRow[]): Set<string> {
  const ok = new Set<string>();
  if (!rows.length) return ok;
  const { rows: audited } = authenticRows("entity_type = 'record' AND entity_id = ? AND action = 'record.edition_approved'", [r.id], { limit: 1000 });
  const approved = new Map<string, string>();
  for (const a of audited) {
    const d = parseJson<{ edition?: string; contentHash?: string }>(a.details, {});
    if (d.edition && d.contentHash && !approved.has(d.edition)) approved.set(d.edition, d.contentHash);
  }
  for (const e of rows) {
    if (approved.get(e.edition) === e.content_hash && editionHash(r, typeKey, e) === e.content_hash) ok.add(e.edition);
  }
  return ok;
}

export function toEditionSummary(e: EditionRow, current: string | null, intact: boolean): RecordEditionSummary {
  return {
    edition: e.edition,
    major: Number(e.major),
    minor: Number(e.minor),
    kind: e.kind,
    revision: Number(e.revision),
    version: Number(e.version),
    title: e.title,
    contentHash: e.content_hash,
    changeSummary: e.change_summary,
    authors: parseJson<string[]>(e.authors, []),
    submittedBy: e.submitted_by,
    submittedAt: e.submitted_at,
    approvedBy: e.approved_by,
    approvedAt: e.approved_at,
    current: e.edition === current,
    intact,
  };
}

export function toEdition(e: EditionRow, current: string | null, intact: boolean): RecordEdition {
  return {
    ...toEditionSummary(e, current, intact),
    body: e.body,
    fields: parseJson<Record<string, string>>(e.fields, {}),
    fieldDefs: parseJson<RecordFieldDef[]>(e.field_defs, []),
    attachments: parseJson<RecordEdition['attachments']>(e.attachments, []),
  };
}

export const reviewRows = (recordId: string): ReviewRow[] =>
  db().all<ReviewRow>('SELECT * FROM record_reviews WHERE record_id = ? ORDER BY created_at DESC, id DESC', recordId);

export const toReview = (r: ReviewRow): RecordReview => ({
  id: r.id,
  outcome: r.outcome,
  edition: r.edition,
  reviewer: r.reviewer,
  comment: r.comment,
  createdAt: r.created_at,
  nextReviewAt: r.next_review_at,
});

const DAY = 86400000;

/** Due-soon / overdue status of a review date. */
export function reviewStatusOf(next: string | null, now: number, dueSoonDays: number): ReviewStatus {
  if (!next) return 'none';
  const t = Date.parse(next);
  return t <= now ? 'overdue' : t - now <= dueSoonDays * DAY ? 'dueSoon' : 'current';
}

/** The regular next review: interval months after the approval of the current edition or the last review (the later). */
export function regularNextReview(approvedAt: string | null, lastReviewedAt: string | null, intervalMonths: number): string | null {
  if (!approvedAt || intervalMonths <= 0) return null;
  const base = lastReviewedAt && lastReviewedAt > approvedAt ? lastReviewedAt : approvedAt;
  return addMonths(base, intervalMonths);
}

export function reviewState(
  r: Pick<RecordRow, 'owner' | 'status'>,
  t: Pick<TypeRow, 'workflow' | 'review_interval_months'>,
  d: DocRow | undefined,
  currentApprovedAt: string | null,
  now = Date.now(),
  dueSoonDays = reminderSettings().dueSoonDays,
): DocumentReviewState {
  const typeInterval = typeReviewInterval(t) ?? DEFAULT_REVIEW_INTERVAL_MONTHS;
  const override = d?.review_interval_months === null || d?.review_interval_months === undefined ? null : Number(d.review_interval_months);
  const interval = override ?? typeInterval;
  let next: string | null = null;
  if (currentApprovedAt && r.status !== 'withdrawn') {
    next = regularNextReview(currentApprovedAt, d?.last_reviewed_at ?? null, interval);
    const earlier = d?.next_review_override ?? null;
    if (earlier && (!next || earlier < next)) next = earlier;
  }
  return {
    status: reviewStatusOf(next, now, dueSoonDays),
    intervalMonths: interval,
    intervalOverride: override,
    typeIntervalMonths: typeInterval,
    owner: d?.review_owner || r.owner,
    ownerOverride: d?.review_owner || null,
    lastReviewedAt: d?.last_reviewed_at ?? null,
    lastReviewedBy: d?.last_reviewed_by ?? null,
    nextReviewAt: next,
    nextReviewOverride: d?.next_review_override ?? null,
    daysLeft: next ? daysUntil(Date.parse(next), now) : null,
    updateRequestedAt: d?.update_requested_at ?? null,
  };
}

/** The approval time of the current edition of a document (null before the first one). */
export function currentApprovedAt(d: DocRow | undefined): string | null {
  if (!d?.current_edition) return null;
  const { major, minor } = parseEdition(d.current_edition);
  return (
    db().get<{ approved_at: string }>('SELECT approved_at FROM record_editions WHERE record_id = ? AND major = ? AND minor = ?', d.record_id, major, minor)
      ?.approved_at ?? null
  );
}

/**
 * Edition and review status of every document in one go (lists, tiles, summaries): record id → state.
 * Only records of document types have a row.
 */
export function documentStates(
  now = Date.now(),
  dueSoonDays = reminderSettings().dueSoonDays,
): Map<string, { edition: string | null; review: DocumentReviewState; typeId: string }> {
  const rows = db().all<
    DocRow & { approved_at: string | null; owner: string; status: string; type_id: string; workflow: string; type_interval: number | null }
  >(
    `SELECT d.*, e.approved_at AS approved_at, r.owner AS owner, r.status AS status, r.type_id AS type_id, t.workflow AS workflow, t.review_interval_months AS type_interval
     FROM record_documents d JOIN records r ON r.id = d.record_id JOIN record_types t ON t.id = r.type_id
     LEFT JOIN record_editions e ON e.record_id = d.record_id AND e.edition = d.current_edition`,
  );
  const out = new Map<string, { edition: string | null; review: DocumentReviewState; typeId: string }>();
  for (const x of rows) {
    if (x.workflow !== 'document') continue;
    const review = reviewState(
      { owner: x.owner, status: x.status },
      { workflow: 'document', review_interval_months: x.type_interval },
      x,
      x.approved_at,
      now,
      dueSoonDays,
    );
    out.set(x.record_id, { edition: x.current_edition, review, typeId: x.type_id });
  }
  return out;
}
