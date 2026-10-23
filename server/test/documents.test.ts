import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DOCUMENT_TYPE_ID, RECORD_WORKFLOWS } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Living documents (workflow "document"): editions (1.0, 1.1, 2.0) frozen on approval, the document
 * changelog, periodic reviews with reminders, withdrawing – and that the other workflows are unchanged.
 */

const mails = vi.hoisted(() => [] as { to: string; subject: string; text: string }[]);
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: async (m: { to: string; subject: string; text: string }) => {
        mails.push(m);
      },
      close: () => undefined,
    }),
  },
}));

let s: TestServer;
const PW = 'Demo-password-1';
const DAY = 86400000;
let dana: Client, olivia: Client, adam: Client, audrey: Client, vera: Client;

const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => ({ status: 200, text: '' }),
    (e: { status: number; message: string }) => ({ status: e.status, text: e.message }),
  );
const status = async (p: Promise<unknown>) => (await errorOf(p)).status;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [dana, olivia, adam, audrey, vera] = await Promise.all(['dana', 'olivia', 'adam', 'audrey', 'vera'].map((u) => s.as(u, PW)));
});
afterAll(async () => {
  await s?.app.close();
});

const CR_FIELDS = { reason: 'r', risk: 'low', rollbackPlan: 'p', plannedStart: '2026-11-03T18:00', plannedEnd: '2026-11-03T19:00' };
const newCr = (title = 'A change') => dana('POST', '/records', { type: 'CR', title, fields: CR_FIELDS });

/** A DOC approved as edition 1.0 (dana writes, adam approves). */
async function publishedDoc(title = 'Authorization concept', body = '## Purpose and scope\n\nWho may do what on the plant gateway.\n') {
  const rec = await dana('POST', '/records', { type: 'DOC', title, body });
  await dana('POST', `/records/${rec.id}/transition`, { action: 'submit', changeSummary: 'First edition' });
  return adam('POST', `/records/${rec.id}/transition`, { action: 'approve', comment: 'Fine' });
}

describe('the built-in type', () => {
  it('DOC – Service documentation with the document workflow, a 12-month review and a template', async () => {
    const types = await vera('GET', '/record-types');
    const doc = types.find((t: any) => t.key === 'DOC');
    expect(doc).toMatchObject({ id: DOCUMENT_TYPE_ID, name: 'Service documentation', workflow: 'document', reviewIntervalMonths: 12, builtin: true });
    for (const h of ['## Purpose and scope', '## Responsibilities', '## Content', '## Related documents']) expect(doc.template).toContain(h);
    // other workflows have no review interval
    expect(types.find((t: any) => t.key === 'CR').reviewIntervalMonths).toBeNull();
  });

  it('administrators set the review interval of document types only', async () => {
    const created = await s.api('POST', '/record-types', { key: 'AUTHZ', name: 'Authorization concept', workflow: 'document', reviewIntervalMonths: 24 });
    expect(created.reviewIntervalMonths).toBe(24);
    const plain = await s.api('POST', '/record-types', { key: 'NOTE', name: 'Note', workflow: 'decision', reviewIntervalMonths: 6 });
    expect(plain.reviewIntervalMonths).toBeNull();
    const { id: _id, builtin: _b, recordCount: _c, createdAt: _ca, updatedAt: _ua, ...input } = created;
    const changed = await s.api('PUT', `/record-types/${created.id}`, { ...input, reviewIntervalMonths: 0 });
    expect(changed.reviewIntervalMonths).toBe(0);
    expect(await status(dana('PUT', `/record-types/${created.id}`, { ...input, reviewIntervalMonths: 3 }))).toBe(403);
    expect(await status(s.api('PUT', `/record-types/${created.id}`, { ...input, reviewIntervalMonths: 500 }))).toBe(400);
    const audit = await s.api('GET', `/audit?entityType=record_type&entityId=${created.id}`);
    expect(audit.find((a: any) => a.action === 'record_type.updated').details).toMatchObject({ reviewIntervalMonths: 0, previousReviewIntervalMonths: 24 });
  });
});

describe('editions', () => {
  it('submit → reject → submit → approve freezes edition 1.0 (four-eyes)', async () => {
    const rec = await dana('POST', '/records', { type: 'DOC', title: 'Operations manual' });
    expect(rec.body).toContain('## Purpose and scope');
    expect(rec.document).toMatchObject({ currentEdition: null, editions: [], nextEdition: { minor: '1.0', major: '1.0' } });
    expect(rec.document.review.status).toBe('none');
    expect(rec.actions.map((a: any) => [a.action, a.needsEdition])).toEqual([
      ['submit', true],
      ['withdraw', false],
    ]);
    // a change summary is required
    expect((await errorOf(dana('POST', `/records/${rec.id}/transition`, { action: 'submit' }))).text).toContain('CHANGE_SUMMARY_REQUIRED');
    const sub = await dana('POST', `/records/${rec.id}/transition`, { action: 'submit', changeSummary: 'First draft' });
    expect(sub).toMatchObject({ status: 'in_review', frozen: true });
    expect(sub.document.pending).toEqual({ kind: 'major', changeSummary: 'First draft', edition: '1.0' });
    // four-eyes: the author cannot approve, viewers and operators neither
    expect(await status(dana('POST', `/records/${rec.id}/transition`, { action: 'approve' }))).toBe(403);
    expect(await status(olivia('POST', `/records/${rec.id}/transition`, { action: 'approve' }))).toBe(403);
    // reject needs a reason and goes back to draft (no edition yet)
    expect(await status(adam('POST', `/records/${rec.id}/transition`, { action: 'reject' }))).toBe(400);
    const rejected = await adam('POST', `/records/${rec.id}/transition`, { action: 'reject', comment: 'Add the escalation path' });
    expect(rejected).toMatchObject({ status: 'draft', frozen: false, document: { pending: null } });
    await dana('PUT', `/records/${rec.id}`, { body: '## Purpose and scope\n\nRun the gateway.\n\n## Escalation\n\nCall the on-call phone.\n' });
    await dana('POST', `/records/${rec.id}/transition`, { action: 'submit', changeSummary: 'First edition with the escalation path' });
    const ok = await adam('POST', `/records/${rec.id}/transition`, { action: 'approve', comment: 'Fine' });
    expect(ok).toMatchObject({ status: 'published', frozen: true, edition: '1.0', reviewStatus: 'current' });
    expect(ok.document.currentEdition).toBe('1.0');
    expect(ok.document.editions).toHaveLength(1);
    const e = ok.document.editions[0];
    expect(e).toMatchObject({
      edition: '1.0',
      kind: 'major',
      changeSummary: 'First edition with the escalation path',
      authors: ['dana'],
      approvedBy: 'adam',
      submittedBy: 'dana',
      current: true,
      intact: true,
      contentHash: ok.frozenHash,
    });
    // the next review: 12 months after the approval
    const next = new Date(e.approvedAt);
    next.setUTCMonth(next.getUTCMonth() + 12);
    expect(ok.document.review.nextReviewAt.slice(0, 10)).toBe(next.toISOString().slice(0, 10));
    const audit = await s.api('GET', `/audit?entityType=record&entityId=${rec.id}`);
    const approved = audit.find((a: any) => a.action === 'record.edition_approved');
    expect(approved).toMatchObject({ actor: 'adam' });
    expect(approved.details).toMatchObject({ edition: '1.0', kind: 'major', contentHash: ok.frozenHash, fourEyes: true, from: 'in_review', to: 'published' });
    expect(audit.find((a: any) => a.action === 'record.reject').details).toMatchObject({ unfrozen: true, to: 'draft' });
    expect((await s.api('GET', '/audit/verify')).ok).toBe(true);
    // published content is frozen
    expect((await errorOf(dana('PUT', `/records/${rec.id}`, { body: 'changed' }))).text).toContain('RECORD_FROZEN');
  });

  it('minor and major editions: 1.0 → 1.1 → 2.0; the current edition stays valid while revising', async () => {
    const pub = await publishedDoc('Backup concept', '## Content\n\nNightly backups.\n');
    const id = pub.id;
    const v10 = await vera('GET', `/records/${id}/editions/1.0`);
    // a new edition: revising starts from the current one; edition 1.0 stays current and readable
    const rev = await olivia('POST', `/records/${id}/revise`, { comment: 'Weekly restore test' });
    expect(rev).toMatchObject({ status: 'revising', frozen: false, edition: '1.0', body: v10.body });
    expect(rev.document.currentEdition).toBe('1.0');
    expect(rev.permissions.edit).toBe(true);
    await olivia('PUT', `/records/${id}`, { body: '## Content\n\nNightly backups, restore tested weekly.\n' });
    expect((await vera('GET', `/records/${id}/editions/1.0`)).body).toBe('## Content\n\nNightly backups.\n');
    // later editions name their kind
    expect((await errorOf(olivia('POST', `/records/${id}/transition`, { action: 'submit', changeSummary: 'Restore test' }))).text).toContain(
      'EDITION_KIND_REQUIRED',
    );
    expect(await status(olivia('POST', `/records/${id}/transition`, { action: 'submit', changeSummary: 'x', editionKind: 'huge' }))).toBe(400);
    const sub = await olivia('POST', `/records/${id}/transition`, { action: 'submit', changeSummary: 'Restore test added', editionKind: 'minor' });
    expect(sub.document.pending).toMatchObject({ kind: 'minor', edition: '1.1' });
    expect(sub.document.currentEdition).toBe('1.0');
    // rejecting a later edition goes back to revising, not to draft
    const rej = await adam('POST', `/records/${id}/transition`, { action: 'reject', comment: 'Say who tests' });
    expect(rej).toMatchObject({ status: 'revising', edition: '1.0' });
    await olivia('POST', `/records/${id}/transition`, { action: 'submit', changeSummary: 'Restore test added', editionKind: 'minor' });
    // olivia wrote this edition: she cannot approve it (and is no approver anyway); adam can
    const info = (await adam('GET', `/records/${id}`)).actions.find((a: any) => a.action === 'approve');
    expect(info).toMatchObject({ allowed: true });
    const v11 = await adam('POST', `/records/${id}/transition`, { action: 'approve' });
    expect(v11.document.currentEdition).toBe('1.1');
    expect(v11.document.editions.map((e: any) => [e.edition, e.kind, e.current, e.authors])).toEqual([
      ['1.1', 'minor', true, ['olivia']],
      ['1.0', 'major', false, ['dana']],
    ]);
    // 1.0 is unchanged
    const again = await vera('GET', `/records/${id}/editions/1.0`);
    expect(again).toMatchObject({ body: v10.body, contentHash: v10.contentHash, intact: true, current: false });
    // a major edition: 1.1 → 2.0
    await dana('POST', `/records/${id}/revise`, { comment: 'New backup system' });
    await dana('PUT', `/records/${id}`, { title: 'Backup concept (new system)' });
    await dana('POST', `/records/${id}/transition`, { action: 'submit', changeSummary: 'New backup system', editionKind: 'major' });
    const v20 = await adam('POST', `/records/${id}/transition`, { action: 'approve' });
    expect(v20.document.editions.map((e: any) => e.edition)).toEqual(['2.0', '1.1', '1.0']);
    expect(v20.document.nextEdition).toEqual({ minor: '2.1', major: '3.0' });
    // the changelog lists the editions; each has the version to diff against the previous one
    const log = await vera('GET', `/records/${id}/changelog`);
    expect(log.filter((r: any) => r.kind === 'edition').map((r: any) => [r.edition, r.approvedBy, r.text])).toEqual([
      ['2.0', 'adam', 'New backup system'],
      ['1.1', 'adam', 'Restore test added'],
      ['1.0', 'adam', 'First edition'],
    ]);
    const editions = await vera('GET', `/records/${id}/editions`);
    const ver = await vera('GET', `/records/${id}/versions/${editions[1].version}`);
    expect(ver.body).toBe((await vera('GET', `/records/${id}/editions/1.1`)).body);
    // unknown or malformed editions
    expect(await status(vera('GET', `/records/${id}/editions/9.9`))).toBe(404);
    expect(await status(vera('GET', `/records/${id}/editions/latest`))).toBe(400);
    // records of other workflows have none
    const cr = await newCr();
    expect(await vera('GET', `/records/${cr.id}/editions`)).toEqual([]);
    expect(await status(vera('GET', `/records/${cr.id}/editions/1.0`))).toBe(409);
  });

  it('frozen editions are immutable: a change in the database shows as not intact', async () => {
    const pub = await publishedDoc('Tamper target');
    const { db } = await import('../src/db.js');
    db().run("UPDATE record_editions SET body = 'forged' WHERE record_id = ?", pub.id);
    const e = await vera('GET', `/records/${pub.id}/editions/1.0`);
    expect(e.intact).toBe(false);
    expect((await vera('GET', `/records/${pub.id}`)).document.editions[0].intact).toBe(false);
  });

  it('withdraw needs a reason, may name the replacing document, and keeps every edition readable', async () => {
    const old = await publishedDoc('Old network concept');
    const replacement = await publishedDoc('Network concept 2027');
    expect(await status(dana('POST', `/records/${old.id}/transition`, { action: 'withdraw' }))).toBe(400);
    expect(await status(vera('POST', `/records/${old.id}/transition`, { action: 'withdraw', comment: 'x' }))).toBe(403);
    expect(await status(dana('POST', `/records/${old.id}/transition`, { action: 'withdraw', comment: 'x', supersededBy: 'DOC-1999-0001' }))).toBe(404);
    const w = await dana('POST', `/records/${old.id}/transition`, { action: 'withdraw', comment: 'Replaced', supersededBy: replacement.number });
    expect(w).toMatchObject({ status: 'withdrawn', supersededBy: { id: replacement.id }, reviewStatus: 'none' });
    expect(w.links.find((l: any) => l.targetId === replacement.id)).toMatchObject({ note: 'replaced by', edition: '1.0' });
    expect(w.actions).toEqual([]);
    expect(w.document.permissions.review).toBe(false);
    expect((await vera('GET', `/records/${old.id}/editions/1.0`)).current).toBe(true);
    const audit = await s.api('GET', `/audit?entityType=record&entityId=${old.id}&action=record.withdraw`);
    expect(audit[0].details).toMatchObject({ edition: '1.0', supersededBy: replacement.number });
  });

  it('withdrawing while the next edition is drafted drops the draft and keeps the current edition', async () => {
    const pub = await publishedDoc('Short-lived draft', '## Content\n\nOriginal.\n');
    await dana('POST', `/records/${pub.id}/revise`, { comment: 'Try something' });
    await dana('PUT', `/records/${pub.id}`, { body: '## Content\n\nExperimental.\n' });
    const w = await dana('POST', `/records/${pub.id}/transition`, { action: 'withdraw', comment: 'Not needed any more' });
    expect(w).toMatchObject({ status: 'withdrawn', body: '## Content\n\nOriginal.\n', tampered: false, frozen: true });
    expect(w.frozenHash).toBe(w.document.editions[0].contentHash);
  });
});

describe('periodic reviews', () => {
  it('owner, review owner, approvers and administrators review; the next review moves forward', async () => {
    const draft = await dana('POST', '/records', { type: 'DOC', title: 'Not yet published' });
    expect((await errorOf(dana('POST', `/records/${draft.id}/review`, { outcome: 'no_change' }))).text).toContain('DOCUMENT_NO_EDITION');
    const pub = await publishedDoc('Reviewed concept');
    const first = pub.document.review.nextReviewAt;
    expect((await vera('GET', `/records/${pub.id}`)).document.permissions).toMatchObject({ review: false, settings: false });
    expect((await dana('GET', `/records/${pub.id}`)).document.permissions).toMatchObject({ review: true, settings: true });
    expect(pub.document.permissions).toMatchObject({ review: true, settings: false }); // adam: an approver
    expect(await status(vera('POST', `/records/${pub.id}/review`, { outcome: 'no_change' }))).toBe(403);
    expect(await status(olivia('POST', `/records/${pub.id}/review`, { outcome: 'no_change' }))).toBe(403);
    expect(await status(audrey('POST', `/records/${pub.id}/review`, { outcome: 'no_change' }))).toBe(403);
    expect(await status(adam('POST', `/records/${pub.id}/review`, { outcome: 'maybe' }))).toBe(400);
    const r = await adam('POST', `/records/${pub.id}/review`, { outcome: 'no_change', comment: 'Still right' });
    expect(r.status).toBe('published');
    expect(r.document.review).toMatchObject({ lastReviewedBy: 'adam', status: 'current' });
    expect(r.document.review.nextReviewAt >= first).toBe(true);
    expect(r.document.reviews[0]).toMatchObject({ outcome: 'no_change', edition: '1.0', reviewer: 'adam', comment: 'Still right' });
    const log = await vera('GET', `/records/${pub.id}/changelog`);
    expect(log[0]).toMatchObject({ kind: 'review', outcome: 'no_change', people: ['adam'], text: 'Still right' });
    const audit = await s.api('GET', `/audit?entityType=record&entityId=${pub.id}&action=record.reviewed`);
    expect(audit[0].details).toMatchObject({ edition: '1.0', outcome: 'no_change', contentHash: pub.frozenHash });
    // the owner may review too
    expect((await dana('POST', `/records/${pub.id}/review`, { outcome: 'no_change' })).document.reviews).toHaveLength(2);
  });

  it('"needs update" starts the next edition; the review stays due until it is approved', async () => {
    const pub = await publishedDoc('Needs work');
    const { db } = await import('../src/db.js');
    // make the review overdue: approved 13 months ago
    const past = new Date(Date.now() - 400 * DAY).toISOString();
    db().run('UPDATE record_editions SET approved_at = ? WHERE record_id = ?', past, pub.id);
    expect((await vera('GET', `/records/${pub.id}`)).document.review.status).toBe('overdue');
    expect(await status(dana('POST', `/records/${pub.id}/review`, { outcome: 'needs_update' }))).toBe(400);
    const r = await dana('POST', `/records/${pub.id}/review`, { outcome: 'needs_update', comment: 'New contact persons' });
    expect(r).toMatchObject({ status: 'revising', edition: '1.0' });
    expect(r.document.review.status).toBe('overdue');
    expect(r.document.review.updateRequestedAt).toBeTruthy();
    // reviewing "no change" while revising is still possible (the edition is still valid) – but here: the new edition
    await dana('PUT', `/records/${pub.id}`, { body: '## Responsibilities\n\n- New contacts\n' });
    await dana('POST', `/records/${pub.id}/transition`, { action: 'submit', changeSummary: 'Contacts updated', editionKind: 'minor' });
    expect((await vera('GET', `/records/${pub.id}`)).document.review.status).toBe('overdue');
    const ok = await adam('POST', `/records/${pub.id}/transition`, { action: 'approve' });
    expect(ok.document.review).toMatchObject({ status: 'current', updateRequestedAt: null });
    expect(ok.document.currentEdition).toBe('1.1');
  });

  it('review settings: owner, interval override and an earlier date (editors only)', async () => {
    const pub = await publishedDoc('Settings target');
    const approvedAt = pub.document.editions[0].approvedAt;
    expect(await status(vera('PUT', `/records/${pub.id}/review-settings`, { intervalMonths: 6 }))).toBe(403);
    expect(await status(adam('PUT', `/records/${pub.id}/review-settings`, { intervalMonths: 6 }))).toBe(403);
    const six = await dana('PUT', `/records/${pub.id}/review-settings`, { intervalMonths: 6 });
    const d = new Date(approvedAt);
    d.setUTCMonth(d.getUTCMonth() + 6);
    expect(six.document.review).toMatchObject({ intervalMonths: 6, intervalOverride: 6, typeIntervalMonths: 12 });
    expect(six.document.review.nextReviewAt.slice(0, 10)).toBe(d.toISOString().slice(0, 10));
    // earlier than planned only, not in the past
    const soon = new Date(Date.now() + 10 * DAY).toISOString().slice(0, 10);
    const early = await dana('PUT', `/records/${pub.id}/review-settings`, { nextReviewAt: soon });
    expect(early.document.review).toMatchObject({ status: 'dueSoon', nextReviewOverride: `${soon}T00:00:00.000Z` });
    expect((await errorOf(dana('PUT', `/records/${pub.id}/review-settings`, { nextReviewAt: '2099-01-01' }))).text).toContain('REVIEW_DATE_LATER');
    expect((await errorOf(dana('PUT', `/records/${pub.id}/review-settings`, { nextReviewAt: '2001-01-01' }))).text).toContain('REVIEW_DATE_PAST');
    expect(await status(dana('PUT', `/records/${pub.id}/review-settings`, { nextReviewAt: 'soon' }))).toBe(400);
    // the review owner may review (and is reminded)
    expect(await status(dana('PUT', `/records/${pub.id}/review-settings`, { reviewOwner: 'nobody-here' }))).toBe(400);
    const owned = await dana('PUT', `/records/${pub.id}/review-settings`, { reviewOwner: 'olivia' });
    expect(owned.document.review).toMatchObject({ owner: 'olivia', ownerOverride: 'olivia' });
    const reviewed = await olivia('POST', `/records/${pub.id}/review`, { outcome: 'no_change', comment: 'ok' });
    // a review clears the earlier date
    expect(reviewed.document.review).toMatchObject({ nextReviewOverride: null, status: 'current' });
    // no interval: no review planned
    const none = await dana('PUT', `/records/${pub.id}/review-settings`, { intervalMonths: 0 });
    expect(none.document.review).toMatchObject({ status: 'none', nextReviewAt: null });
    const audit = await s.api('GET', `/audit?entityType=record&entityId=${pub.id}&action=record.review_settings_changed`);
    expect(audit.length).toBe(4);
    // not for other records
    const cr = await newCr();
    expect((await errorOf(dana('PUT', `/records/${cr.id}/review-settings`, { intervalMonths: 1 }))).text).toContain('NOT_A_DOCUMENT');
    expect(await status(adam('POST', `/records/${cr.id}/review`, { outcome: 'no_change' }))).toBe(409);
  });

  it('computes current / due soon / overdue like the credentials register', async () => {
    const { reviewState, addMonths } = await import('../src/records/document-model.js');
    const t = { workflow: 'document' as const, review_interval_months: 12 };
    const r = { owner: 'dana', status: 'published' };
    const approved = '2026-01-31T10:00:00.000Z';
    // the 31st becomes the last day of a shorter month
    expect(addMonths(approved, 1)).toBe('2026-02-28T10:00:00.000Z');
    const due = Date.parse(addMonths(approved, 12));
    const at = (ms: number) => reviewState(r, t, undefined, approved, ms, 30).status;
    expect(at(due - 31 * DAY)).toBe('current');
    expect(at(due - 30 * DAY)).toBe('dueSoon');
    expect(at(due)).toBe('overdue');
    expect(reviewState({ ...r, status: 'withdrawn' }, t, undefined, approved, due, 30).status).toBe('none');
    expect(reviewState(r, t, undefined, null, due, 30).status).toBe('none');
    expect(reviewState(r, { ...t, review_interval_months: 0 }, undefined, approved, due, 30).status).toBe('none');
    // the later of approval and last review counts
    const d = { last_reviewed_at: '2026-06-30T00:00:00.000Z', review_interval_months: null, next_review_override: null } as never;
    expect(reviewState(r, t, d, approved, due, 30).nextReviewAt).toBe('2027-06-30T00:00:00.000Z');
  });

  it('reminds the review owner once per threshold, then every N days when overdue', async () => {
    const { checkDocumentReviews } = await import('../src/records/documents.js');
    const { flushNotifications } = await import('../src/notifications/service.js');
    const { db } = await import('../src/db.js');
    const pub = await publishedDoc('Reminder target');
    await dana('PUT', `/records/${pub.id}/review-settings`, { reviewOwner: 'olivia' });
    const due = Date.parse(pub.document.review.nextReviewAt);
    const claims = () => db().get<{ n: number }>('SELECT COUNT(*) AS n FROM record_review_reminders WHERE record_id = ?', pub.id)!.n;
    const sentFor = (now: number) => {
      const before = claims();
      checkDocumentReviews(now);
      return claims() > before;
    };
    expect(sentFor(due - 40 * DAY)).toBe(false);
    expect(sentFor(due - 20 * DAY)).toBe(true); // 30 days before
    expect(sentFor(due - 20 * DAY)).toBe(false); // once
    expect(sentFor(due - 19 * DAY)).toBe(false);
    expect(sentFor(due - 10 * DAY)).toBe(true); // 14 days before
    expect(sentFor(due + 3600000)).toBe(true); // overdue
    expect(sentFor(due + DAY)).toBe(false);
    expect(sentFor(due + 7 * DAY + 3600000)).toBe(true); // every 7 days
    await flushNotifications();
    const inbox = await olivia('GET', '/notifications');
    const mine = inbox.items.filter((n: any) => n.event === 'document.review' && n.title.includes(pub.number));
    expect(mine.length).toBeGreaterThanOrEqual(3);
    expect(mine[0].link).toBe(`/records/${pub.id}?tab=changelog`);
    expect((await dana('GET', '/notifications')).items.filter((n: any) => n.event === 'document.review' && n.title.includes(pub.number))).toEqual([]);
    const audit = await s.api('GET', `/audit?entityType=record&entityId=${pub.id}&action=record.review_reminder_sent`);
    expect(audit.length).toBe(4);
    expect(audit[0]).toMatchObject({ actor: 'system' });
  });
});

describe('lists, links and permissions', () => {
  it('filters by workflow and review status', async () => {
    const all = await vera('GET', '/records?workflow=document');
    expect(all.length).toBeGreaterThan(3);
    expect(all.every((r: any) => r.workflow === 'document' && 'reviewStatus' in r)).toBe(true);
    const overdue = await vera('GET', '/records?review=overdue');
    expect(overdue.every((r: any) => r.reviewStatus === 'overdue')).toBe(true);
    const current = await vera('GET', '/records?review=current,dueSoon');
    expect(current.length).toBeGreaterThan(0);
    expect(current.every((r: any) => ['current', 'dueSoon'].includes(r.reviewStatus) && r.edition)).toBe(true);
    expect(await status(vera('GET', '/records?review=late'))).toBe(400);
    expect(await status(vera('GET', '/records?workflow=story'))).toBe(400);
    // other records carry no review status
    await newCr();
    expect((await vera('GET', '/records?type=CR'))[0].reviewStatus).toBeUndefined();
  });

  it('a link to a document shows its current edition', async () => {
    const pub = await publishedDoc('Linked concept');
    const cr = await dana('POST', '/records', { type: 'CR', title: 'Uses the concept' });
    const link = await dana('POST', `/records/${cr.id}/links`, { kind: 'record', id: pub.id });
    expect(link).toMatchObject({ edition: '1.0' });
    const back = await vera('GET', `/backlinks?kind=record&id=${pub.id}`);
    expect(back.length).toBe(1);
  });

  it('leaves the other workflows unchanged', () => {
    // the transitions of change, decision and access records are exactly what they were
    expect(RECORD_WORKFLOWS.change.transitions.map((t) => `${t.action}:${t.from.join('|')}>${t.to}`)).toEqual([
      'submit:draft>submitted',
      'approve:submitted>approved',
      'reject:submitted>rejected',
      'implement:approved>implemented',
      'close:implemented>closed',
      'cancel:draft|submitted>cancelled',
    ]);
    for (const w of ['change', 'decision', 'access'] as const) {
      expect(RECORD_WORKFLOWS[w].editable, w).toBeUndefined();
      expect(RECORD_WORKFLOWS[w].reviseTo, w).toBeUndefined();
      expect(
        RECORD_WORKFLOWS[w].transitions.some((t) => t.toWithEdition || t.optionalRecord),
        w,
      ).toBe(false);
    }
  });

  it('a change request still approves, rejects and revises as before', async () => {
    const cr = await newCr('Regression');
    expect(cr.document).toBeNull();
    expect(cr.actions.every((a: any) => a.needsEdition === false)).toBe(true);
    await dana('POST', `/records/${cr.id}/transition`, { action: 'submit', changeSummary: 'ignored for change requests' });
    const rej = await adam('POST', `/records/${cr.id}/transition`, { action: 'reject', comment: 'No' });
    expect(rej).toMatchObject({ status: 'rejected', frozen: true });
    const rev = await dana('POST', `/records/${cr.id}/revise`, { comment: 'again' });
    expect(rev).toMatchObject({ status: 'draft', revision: 2 });
    await dana('POST', `/records/${cr.id}/transition`, { action: 'submit' });
    const ok = await adam('POST', `/records/${cr.id}/transition`, { action: 'approve' });
    expect(ok.status).toBe('approved');
    const audit = await s.api('GET', `/audit?entityType=record&entityId=${cr.id}`);
    expect(audit.map((a: any) => a.action)).toEqual(expect.arrayContaining(['record.approve', 'record.reject', 'record.revised']));
    expect(audit.some((a: any) => a.action === 'record.edition_approved')).toBe(false);
  });
});
