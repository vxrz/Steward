import { z } from 'zod';
import {
  PERSON_REVIEW_DECISIONS,
  PERSON_REVIEW_LIMITS,
  type AccessCheckSource,
  type EvidenceItem,
  type PersonReview,
  type PersonReviewItem,
  type PersonReviewSource,
  type PersonReviewStatus,
  type PersonReviewSummary,
} from '@sm/shared';
import { db } from '../db.js';
import { likeEscape } from '../database/sql.js';
import { audit } from '../audit.js';
import { currentUser, type AuthUser } from '../auth/context.js';
import { isAdmin } from '../auth/permissions.js';
import { findUserByName } from '../auth/users.js';
import { canonicalJson, HttpError, newId, nowIso, parseJson, sha256 } from '../util.js';
import { canCreateChecks, canReadCheck, identitiesOf, readsEverything, same, visiblePlatformName } from './access.js';
import { readCheckSource } from './reconciliation.js';

/**
 * Person access reviews (#118): one colleague's rights on several platforms at once – for a leaver, a mover or a
 * periodic review of a privileged person. The reviewer names the person's identities (e-mail addresses, user names)
 * and the access checks to read (each a platform with its source and scope). Steward reads each source now (its
 * latest snapshot when the live read fails), keeps only the person's rights and freezes them into the review.
 *
 *   open       the reviewer decides per right: keep or remove (with a comment)
 *   submitted  with four-eyes: a second person (approver or administrator, not the reviewer, not the person) approves
 *   approved   sealed: SHA-256 over the review and every decision, in the audit log
 *   closed     "Check removals" read the sources again and every right to remove is gone
 */

const has = (u: AuthUser | null, roles: string[]) => !!u && u.roles.some((r) => roles.includes(r));

export const reviewInput = z
  .object({
    title: z.string().trim().min(1).max(PERSON_REVIEW_LIMITS.title),
    /** A Steward user (their identities are suggested), or none for someone without an account */
    personUser: z.string().trim().max(128).nullable().optional(),
    personName: z.string().trim().min(1).max(200),
    identifiers: z.array(z.string().trim().min(1).max(320)).min(1).max(PERSON_REVIEW_LIMITS.identifiers),
    checkIds: z.array(z.string().trim().min(1).max(100)).min(1).max(PERSON_REVIEW_LIMITS.checks),
    fourEyes: z.boolean().default(true),
  })
  .strict();

export const decisionsInput = z
  .object({
    decisions: z
      .array(
        z
          .object({
            itemId: z.string().min(1).max(100),
            decision: z.enum(PERSON_REVIEW_DECISIONS).nullable(),
            comment: z.string().max(PERSON_REVIEW_LIMITS.comment).default(''),
          })
          .strict(),
      )
      .min(1)
      .max(PERSON_REVIEW_LIMITS.items),
  })
  .strict();

interface ReviewRow {
  id: string;
  title: string;
  person_user: string | null;
  person_name: string;
  identifiers: string;
  sources: string;
  status: PersonReviewStatus;
  four_eyes: number;
  created_by: string;
  created_at: string;
  submitted_by: string | null;
  submitted_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  approval_comment: string;
  closed_at: string | null;
  seal_hash: string | null;
}

interface ItemRow {
  id: string;
  review_id: string;
  seq: number;
  check_id: string;
  subject_id: string;
  subject_name: string;
  subject_type: string | null;
  right_name: string;
  decision: 'keep' | 'remove' | null;
  comment: string;
  decided_by: string | null;
  decided_at: string | null;
  recheck: 'gone' | 'present' | null;
  rechecked_at: string | null;
}

const me = (): AuthUser => {
  const u = currentUser();
  if (!u) throw new HttpError(401, 'Not signed in', 'NOT_SIGNED_IN');
  return u;
};

const norm = (s: string) => s.trim().toLowerCase();

/** The person's own identities: nobody reviews or approves their own access. */
function isThePerson(u: AuthUser, r: Pick<ReviewRow, 'person_user' | 'identifiers'>): boolean {
  if (same(r.person_user, u.username)) return true;
  const mine = new Set(identitiesOf(u.username));
  return parseJson<string[]>(r.identifiers, []).some((x) => mine.has(norm(x)));
}

const mayRead = (u: AuthUser, r: ReviewRow) => readsEverything(u) || same(r.created_by, u.username) || has(u, ['approver']);
const mayDecide = (u: AuthUser, r: ReviewRow) => r.status === 'open' && (same(r.created_by, u.username) || isAdmin(u)) && !isThePerson(u, r);
const mayApprove = (u: AuthUser, r: ReviewRow) =>
  r.status === 'submitted' && (has(u, ['approver']) || isAdmin(u)) && !same(r.submitted_by, u.username) && !isThePerson(u, r);

const mayRecheck = (u: AuthUser, r: ReviewRow) =>
  (r.status === 'approved' || r.status === 'closed') && (same(r.created_by, u.username) || isAdmin(u) || has(u, ['approver']));

function rowOf(id: string): ReviewRow {
  const r = db().get<ReviewRow>('SELECT * FROM person_reviews WHERE id = ?', id);
  if (!r) throw new HttpError(404, `Person review ${id} not found`, 'PERSON_REVIEW_NOT_FOUND', { id });
  return r;
}

function readable(id: string): { u: AuthUser; r: ReviewRow } {
  const u = me();
  const r = rowOf(id);
  if (!mayRead(u, r)) throw new HttpError(404, `Person review ${id} not found`, 'PERSON_REVIEW_NOT_FOUND', { id });
  return { u, r };
}

const itemsOf = (id: string) => db().all<ItemRow>('SELECT * FROM person_review_items WHERE review_id = ? ORDER BY seq', id);

function countsOf(items: ItemRow[]): PersonReview['counts'] {
  return {
    rights: items.length,
    keep: items.filter((i) => i.decision === 'keep').length,
    remove: items.filter((i) => i.decision === 'remove').length,
    open: items.filter((i) => !i.decision).length,
    gone: items.filter((i) => i.recheck === 'gone').length,
    present: items.filter((i) => i.recheck === 'present').length,
  };
}

const toItem = (i: ItemRow): PersonReviewItem => ({
  id: i.id,
  checkId: i.check_id,
  subjectId: i.subject_id,
  subjectName: i.subject_name,
  subjectType: i.subject_type,
  right: i.right_name,
  decision: i.decision,
  comment: i.comment,
  decidedBy: i.decided_by,
  decidedAt: i.decided_at,
  recheck: i.recheck,
  recheckedAt: i.rechecked_at,
});

function toReview(u: AuthUser, r: ReviewRow): PersonReview {
  const items = itemsOf(r.id);
  const sources = parseJson<PersonReviewSource[]>(r.sources, []).map((s) => ({ ...s, platformName: visiblePlatformName(u, s.platformId) ?? s.platformName }));
  return {
    id: r.id,
    title: r.title,
    personUser: r.person_user,
    personName: r.person_name,
    identifiers: parseJson<string[]>(r.identifiers, []),
    sources,
    items: items.map(toItem),
    status: r.status,
    fourEyes: !!r.four_eyes,
    createdBy: r.created_by,
    createdAt: r.created_at,
    submittedBy: r.submitted_by,
    submittedAt: r.submitted_at,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    approvalComment: r.approval_comment,
    closedAt: r.closed_at,
    sealHash: r.seal_hash,
    counts: countsOf(items),
    canDecide: mayDecide(u, r),
    canApprove: mayApprove(u, r),
    canRecheck: mayRecheck(u, r),
  };
}

/** The identities Steward knows for a Steward user: user name, e-mail and former names (imported accounts). */
export function suggestIdentifiers(username: string): { personName: string; identifiers: string[] } {
  const target = findUserByName(username);
  if (!target) throw new HttpError(404, `User ${username} not found`, 'USER_NOT_FOUND', { name: username });
  return { personName: target.displayName || target.username, identifiers: identitiesOf(target.username) };
}

export function listReviews(): PersonReviewSummary[] {
  const u = me();
  return db()
    .all<ReviewRow>('SELECT * FROM person_reviews ORDER BY created_at DESC LIMIT 500')
    .filter((r) => mayRead(u, r))
    .map((r) => {
      const items = itemsOf(r.id);
      return {
        id: r.id,
        title: r.title,
        personName: r.person_name,
        status: r.status,
        createdBy: r.created_by,
        createdAt: r.created_at,
        approvedAt: r.approved_at,
        counts: countsOf(items),
        platforms: parseJson<PersonReviewSource[]>(r.sources, []).length,
      };
    });
}

export function getReview(id: string): PersonReview {
  const { u, r } = readable(id);
  return toReview(u, r);
}

/** Subjects of a source that are the person: their id or name equals one of the identifiers (case-insensitive). */
function matches(ids: Set<string>, s: { id: string; name: string }): boolean {
  return ids.has(norm(s.id)) || (!!s.name && ids.has(norm(s.name)));
}

export async function createReview(input: z.infer<typeof reviewInput>): Promise<PersonReview> {
  const u = me();
  if (!canCreateChecks(u)) throw new HttpError(403, 'Only designers and administrators start person reviews', 'FORBIDDEN');
  const identifiers = [...new Set(input.identifiers.map(norm))];
  if (input.personUser && !findUserByName(input.personUser))
    throw new HttpError(400, `User ${input.personUser} not found`, 'USER_NOT_FOUND', { name: input.personUser });
  const draft = { person_user: input.personUser ?? null, identifiers: JSON.stringify(identifiers) };
  if (isThePerson(u, draft)) throw new HttpError(403, 'Nobody reviews their own access', 'PERSON_REVIEW_SELF');
  const checks = [...new Set(input.checkIds)].map((id) => {
    const c = db().get<{ id: string; name: string; platform_id: string; owner: string; source: AccessCheckSource; dataset_key: string | null }>(
      'SELECT id, name, platform_id, owner, source, dataset_key FROM access_checks WHERE id = ?',
      id,
    );
    if (!c || !canReadCheck(u, c)) throw new HttpError(404, `Access check ${id} not found`, 'ACCESS_CHECK_NOT_FOUND', { id });
    return c;
  });
  const idSet = new Set(identifiers);
  const sources: PersonReviewSource[] = [];
  const found: Omit<ItemRow, 'id' | 'review_id' | 'seq' | 'decision' | 'comment' | 'decided_by' | 'decided_at' | 'recheck' | 'rechecked_at'>[] = [];
  for (const c of checks) {
    const base = {
      checkId: c.id,
      checkName: c.name,
      platformId: c.platform_id,
      platformName: visiblePlatformName(u, c.platform_id),
      source: c.source,
      scope: c.source === 'dataset' ? null : c.dataset_key,
    };
    try {
      const got = await readCheckSource(c.id);
      const mine = got.subjects.filter((s) => matches(idSet, s));
      for (const s of mine) {
        const rights = s.rights.length ? s.rights : ['(no rights)'];
        for (const right of rights)
          found.push({ check_id: c.id, subject_id: s.id, subject_name: s.name ?? '', subject_type: s.type ?? null, right_name: right });
      }
      sources.push({ ...base, origin: got.origin, readAt: got.takenAt, error: got.error, matched: mine.length });
    } catch (e) {
      sources.push({ ...base, origin: 'failed', readAt: null, error: (e as Error).message.slice(0, 300), matched: 0 });
    }
  }
  if (found.length > PERSON_REVIEW_LIMITS.items)
    throw new HttpError(400, `More than ${PERSON_REVIEW_LIMITS.items} rights – narrow the checks`, 'PERSON_REVIEW_TOO_LARGE', {
      max: PERSON_REVIEW_LIMITS.items,
    });
  const id = newId('prv');
  const now = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO person_reviews (id, title, person_user, person_name, identifiers, sources, status, four_eyes, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      id,
      input.title,
      input.personUser ?? null,
      input.personName,
      JSON.stringify(identifiers),
      JSON.stringify(sources),
      input.fourEyes ? 1 : 0,
      u.username,
      now,
    );
    found.forEach((f, n) =>
      db().run(
        `INSERT INTO person_review_items (id, review_id, seq, check_id, subject_id, subject_name, subject_type, right_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        newId('pri'),
        id,
        n + 1,
        f.check_id,
        f.subject_id,
        f.subject_name,
        f.subject_type,
        f.right_name,
      ),
    );
    audit({
      action: 'compliance.person_review_started',
      entityType: 'person_review',
      entityId: id,
      summary: `Person review "${input.title}" of ${input.personName}: ${found.length} right(s) on ${sources.filter((s) => s.matched).length} of ${sources.length} platform source(s)`,
      details: {
        personUser: input.personUser ?? null,
        identifiers,
        sources: sources.map((s) => ({ checkId: s.checkId, origin: s.origin, matched: s.matched, error: s.error })),
      },
    });
  });
  return getReview(id);
}

export function decide(id: string, input: z.infer<typeof decisionsInput>): PersonReview {
  const { u, r } = readable(id);
  if (!mayDecide(u, r))
    throw new HttpError(
      403,
      r.status !== 'open' ? 'The review is no longer open' : 'Only the reviewer decides – and nobody about their own access',
      'PERSON_REVIEW_DECIDE',
    );
  const items = new Map(itemsOf(id).map((i) => [i.id, i]));
  const now = nowIso();
  db().tx(() => {
    for (const d of input.decisions) {
      if (!items.has(d.itemId)) throw new HttpError(404, `Item ${d.itemId} is not part of this review`, 'PERSON_REVIEW_ITEM', { id: d.itemId });
      if (d.decision === 'remove' && !d.comment.trim()) throw new HttpError(400, 'Say why a right is to be removed', 'PERSON_REVIEW_COMMENT');
      db().run(
        'UPDATE person_review_items SET decision = ?, comment = ?, decided_by = ?, decided_at = ? WHERE id = ? AND review_id = ?',
        d.decision,
        d.comment.trim(),
        d.decision ? u.username : null,
        d.decision ? now : null,
        d.itemId,
        id,
      );
    }
  });
  return toReview(u, rowOf(id));
}

const sealOf = (r: ReviewRow, items: ItemRow[]) =>
  sha256(
    canonicalJson({
      id: r.id,
      title: r.title,
      personUser: r.person_user,
      personName: r.person_name,
      identifiers: parseJson<string[]>(r.identifiers, []),
      sources: parseJson<PersonReviewSource[]>(r.sources, []).map((s) => ({ checkId: s.checkId, origin: s.origin, readAt: s.readAt })),
      createdBy: r.created_by,
      submittedBy: r.submitted_by,
      approvedBy: r.approved_by,
      approvedAt: r.approved_at,
      items: items.map((i) => ({
        checkId: i.check_id,
        subjectId: i.subject_id,
        right: i.right_name,
        decision: i.decision,
        comment: i.comment,
        decidedBy: i.decided_by,
        decidedAt: i.decided_at,
      })),
    }),
  );

function seal(id: string, by: string, comment: string): void {
  const now = nowIso();
  db().run("UPDATE person_reviews SET status = 'approved', approved_by = ?, approved_at = ?, approval_comment = ? WHERE id = ?", by, now, comment, id);
  const r = rowOf(id);
  const items = itemsOf(id);
  const hash = sealOf(r, items);
  db().run('UPDATE person_reviews SET seal_hash = ? WHERE id = ?', hash, id);
  const c = countsOf(items);
  audit({
    action: 'compliance.person_review_approved',
    entityType: 'person_review',
    entityId: id,
    summary: `Person review "${r.title}" of ${r.person_name} approved by ${by}: ${c.keep} kept, ${c.remove} to remove (seal ${hash.slice(0, 12)}…)`,
    details: { hash, keep: c.keep, remove: c.remove, comment },
  });
}

/** Done deciding: with four-eyes it waits for a second person, otherwise it is sealed at once. */
export function submit(id: string): PersonReview {
  const { u, r } = readable(id);
  if (!mayDecide(u, r)) throw new HttpError(403, 'Only the reviewer submits an open review', 'PERSON_REVIEW_DECIDE');
  const open = itemsOf(id).filter((i) => !i.decision).length;
  if (open) throw new HttpError(400, `${open} right(s) are not decided yet`, 'PERSON_REVIEW_UNDECIDED', { count: open });
  db().tx(() => {
    db().run("UPDATE person_reviews SET status = 'submitted', submitted_by = ?, submitted_at = ? WHERE id = ?", u.username, nowIso(), id);
    audit({
      action: 'compliance.person_review_submitted',
      entityType: 'person_review',
      entityId: id,
      summary: `Person review "${r.title}" of ${r.person_name} submitted${r.four_eyes ? ' for approval' : ''}`,
    });
    if (!r.four_eyes) seal(id, u.username, '');
  });
  return toReview(u, rowOf(id));
}

/** The second person approves (sealed) or sends the review back to the reviewer. */
export function approve(id: string, input: { approve: boolean; comment: string }): PersonReview {
  const { u, r } = readable(id);
  if (!mayApprove(u, r))
    throw new HttpError(
      403,
      r.status !== 'submitted'
        ? 'The review is not waiting for approval'
        : 'An approver or administrator other than the reviewer – and not the person reviewed – approves',
      'PERSON_REVIEW_APPROVE',
    );
  db().tx(() => {
    if (input.approve) seal(id, u.username, input.comment.trim());
    else {
      if (!input.comment.trim()) throw new HttpError(400, 'Say why the review goes back', 'PERSON_REVIEW_COMMENT');
      db().run("UPDATE person_reviews SET status = 'open', submitted_by = NULL, submitted_at = NULL WHERE id = ?", id);
      audit({
        action: 'compliance.person_review_returned',
        entityType: 'person_review',
        entityId: id,
        summary: `Person review "${r.title}" of ${r.person_name} sent back by ${u.username}: ${input.comment.trim()}`.slice(0, 1000),
      });
    }
  });
  return toReview(u, rowOf(id));
}

/**
 * After approval: reads the sources of the rights to remove again (live only – a snapshot proves nothing new) and
 * marks each right gone or present. When every right to remove is gone, the review is closed.
 */
export async function recheck(id: string): Promise<PersonReview> {
  const { u, r } = readable(id);
  if (r.status !== 'approved' && r.status !== 'closed') throw new HttpError(409, 'Removals are checked after approval', 'PERSON_REVIEW_NOT_APPROVED');
  if (!mayRecheck(u, r)) throw new HttpError(403, 'Only the reviewer, an approver or an administrator checks removals', 'FORBIDDEN');
  const items = itemsOf(id).filter((i) => i.decision === 'remove');
  const now = nowIso();
  const results = new Map<string, 'gone' | 'present'>();
  const problems: string[] = [];
  for (const checkId of [...new Set(items.map((i) => i.check_id))]) {
    let got;
    try {
      got = await readCheckSource(checkId);
    } catch (e) {
      problems.push(`${checkId}: ${(e as Error).message.slice(0, 200)}`);
      continue;
    }
    if (got.origin !== 'live') {
      problems.push(`${checkId}: ${got.error ?? 'could not be read live'}`);
      continue;
    }
    for (const i of items.filter((x) => x.check_id === checkId)) {
      const s = got.subjects.find((x) => norm(x.id) === norm(i.subject_id));
      const present = !!s && (i.right_name === '(no rights)' || s.rights.some((x) => norm(x) === norm(i.right_name)));
      results.set(i.id, present ? 'present' : 'gone');
    }
  }
  db().tx(() => {
    for (const [itemId, v] of results) db().run('UPDATE person_review_items SET recheck = ?, rechecked_at = ? WHERE id = ?', v, now, itemId);
    const after = itemsOf(id).filter((i) => i.decision === 'remove');
    const allGone = after.every((i) => i.recheck === 'gone');
    if (allGone && r.status === 'approved') db().run("UPDATE person_reviews SET status = 'closed', closed_at = ? WHERE id = ?", now, id);
    const gone = after.filter((i) => i.recheck === 'gone').length;
    audit({
      action: 'compliance.person_review_rechecked',
      entityType: 'person_review',
      entityId: id,
      summary: `Removals of person review "${r.title}" checked: ${gone} of ${after.length} gone${problems.length ? `, ${problems.length} source(s) not readable` : ''}${allGone && r.status === 'approved' ? ' – review closed' : ''}`,
      details: { gone, total: after.length, problems },
    });
  });
  return toReview(u, rowOf(id));
}

/** Seal check of an approved review (evidence packs, auditors): recomputed from the stored rows. */
export function verifySeal(id: string): { ok: boolean; hash: string | null; computed: string | null } {
  const { r } = readable(id);
  if (!r.seal_hash) return { ok: false, hash: null, computed: null };
  const computed = sealOf(r, itemsOf(id));
  return { ok: computed === r.seal_hash, hash: r.seal_hash, computed };
}

/**
 * Evidence of an access check (controls, evidence packs): the approved or closed person reviews that read it, approved
 * in the period, that the reader may see.
 */
export function personReviewEvidence(checkId: string, p: { from: string; to: string }, u: AuthUser | null, via: EvidenceItem['via']): EvidenceItem[] {
  if (!u) return [];
  return db()
    .all<ReviewRow>(
      `SELECT * FROM person_reviews WHERE status IN ('approved', 'closed') AND approved_at >= ? AND approved_at <= ? AND lower(sources) LIKE lower(?) ESCAPE '\\' ORDER BY approved_at DESC LIMIT 500`,
      p.from,
      p.to,
      `%${likeEscape(JSON.stringify(checkId))}%`,
    )
    .filter((r) => mayRead(u, r) && parseJson<PersonReviewSource[]>(r.sources, []).some((s) => s.checkId === checkId))
    .map((r) => {
      const c = countsOf(itemsOf(r.id));
      return {
        kind: 'personReview' as const,
        id: r.id,
        label: `${r.title} (${r.person_name})`,
        at: r.approved_at!,
        path: `/compliance/person-reviews/${r.id}`,
        status: r.status,
        detail: `${c.rights} right(s), ${c.remove} to remove, ${c.gone} removed`,
        via,
      };
    });
}
