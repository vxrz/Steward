import { db } from '../db.js';
import { audit } from '../audit.js';
import type { AuthUser } from '../auth/context.js';
import { matches } from '../auth/permissions.js';
import { samePerson } from '../auth/assurance.js';
import { nowIso, parseJson } from '../util.js';

/**
 * Who took part in the fix of a corrective action finding (security review 0.17.0, docs/COMPLIANCE.md#effectiveness-check).
 * The effectiveness check (control point correctiveAction.verify) excludes them all, so the list is kept for good on the
 * finding (`ca_findings.fix_participants`, a JSON list of subjects) and only ever grows:
 * - every owner the finding has had;
 * - every owner of its actions – users, teams (with the members the team had then; members at the time of the check are
 *   excluded as well) and roles – and of the measures of its incident review;
 * - who marked an action or measure done;
 * - who removed or changed an action (or measure) or the finding's owner after the finding was implemented.
 *
 * The rule for changes after "implemented": removing an action or measure, changing its owners, reopening it, adding an
 * open one, or changing the finding's owner sends the finding back to "in progress" – it is implemented again once its
 * actions are done, and the checker is a person who took no part. Kept free of corrective.ts, so the incident review's
 * measures (records/reviews.ts) report their changes here without an import cycle.
 */

const FINAL = ['closed', 'cancelled'];

const subjectOf = (s: string): string => (/^(user|team|role):/i.test(s) ? s.trim() : `user:${s.trim()}`);

/** The members a team has now (user names). */
function teamMembers(name: string): string[] {
  return db()
    .all<{ username: string }>(
      'SELECT u.username FROM users u JOIN team_members m ON m.user_id = u.id JOIN teams t ON t.id = m.team_id WHERE lower(t.name) = lower(?)',
      name,
    )
    .map((r) => r.username);
}

/** The subjects of a list, a team with its members of now; duplicates (any letter case) once. */
function expand(subjects: readonly (string | null | undefined)[]): string[] {
  const out = new Map<string, string>();
  const add = (s: string) => {
    if (!out.has(s.toLowerCase())) out.set(s.toLowerCase(), s);
  };
  for (const x of subjects) {
    if (!x?.trim()) continue;
    const s = subjectOf(x);
    add(s);
    if (/^team:/i.test(s)) for (const m of teamMembers(s.slice(5))) add(`user:${m}`);
  }
  return [...out.values()];
}

/** Adds subjects (users by name or user:/team:/role:) to the finding's participants – in the caller's transaction. */
export function noteParticipants(findingId: string, subjects: readonly (string | null | undefined)[]): void {
  const add = expand(subjects);
  if (!add.length) return;
  const r = db().get<{ fix_participants: string }>('SELECT fix_participants FROM ca_findings WHERE id = ?', findingId);
  if (!r) return;
  const list = parseJson<string[]>(r.fix_participants, []);
  const known = new Set(list.map((x) => x.toLowerCase()));
  const more = add.filter((x) => !known.has(x.toLowerCase()));
  if (more.length) db().run('UPDATE ca_findings SET fix_participants = ? WHERE id = ?', JSON.stringify([...list, ...more]), findingId);
}

/** The stored participants of a finding row, and those it has now (`current`), as one list of subjects. */
export function participantsOf(storedJson: string, current: readonly (string | null | undefined)[]): string[] {
  const out = new Map<string, string>();
  for (const s of [...parseJson<string[]>(storedJson, []), ...expand(current)]) if (!out.has(s.toLowerCase())) out.set(s.toLowerCase(), s);
  return [...out.values()];
}

/** Whether a person took part: a user by identity (former names, linked sign-in), a team by membership now, a role. */
export function takesPart(u: AuthUser, subjects: readonly string[]): boolean {
  return subjects.some((s) => (/^user:/i.test(s) ? samePerson(s.slice(5), u) : matches(u, s)));
}

/** The user names among the subjects (the requesters of the four-eyes proof), at most `max`. */
export const participantNames = (subjects: readonly string[], max = 50): string[] =>
  subjects
    .filter((s) => /^user:/i.test(s))
    .map((s) => s.slice(5))
    .slice(0, max);

/** Sends an implemented finding back to "in progress" (in the caller's transaction); false when it was not implemented. */
export function backToInProgress(findingId: string, why: string, actor: string): boolean {
  const f = db().get<{ number: string; status: string }>('SELECT number, status FROM ca_findings WHERE id = ?', findingId);
  if (!f || f.status !== 'implemented') return false;
  db().run("UPDATE ca_findings SET status = 'inProgress', updated_at = ?, updated_by = ? WHERE id = ? AND status = 'implemented'", nowIso(), actor, findingId);
  audit({
    action: 'corrective.finding_changed',
    entityType: 'corrective_finding',
    entityId: findingId,
    summary: `Finding ${f.number}: status implemented → inProgress (${why})`,
    details: { number: f.number, fields: ['status'], before: { status: 'implemented' }, after: { status: 'inProgress' }, why },
  });
  return true;
}

export interface MeasureChange {
  kind: 'added' | 'changed' | 'removed';
  /** The measure before the change (changed, removed) */
  before?: { owners: string[]; doneBy: string | null };
  /** The measure after the change (added, changed) */
  after?: { owners: string[]; doneBy: string | null };
  actor: string;
}

/**
 * A measure of an incident review was added, changed or removed (records/reviews.ts, in its transaction): the findings
 * of the review that are not closed note who took part, and one that was implemented goes back to "in progress" when the
 * change touches the fix (removed, owners changed, reopened, a new open measure).
 */
export function measureChanged(recordId: string, c: MeasureChange): void {
  const findings = db().all<{ id: string; status: string }>('SELECT id, status FROM ca_findings WHERE record_id = ?', recordId);
  const lower = (l: string[] | undefined) => (l ?? []).map((x) => x.toLowerCase()).sort();
  for (const f of findings) {
    if (FINAL.includes(f.status)) continue;
    const implemented = f.status === 'implemented';
    noteParticipants(f.id, [...(c.before?.owners ?? []), c.before?.doneBy, ...(c.after?.owners ?? []), c.after?.doneBy, implemented ? c.actor : null]);
    if (!implemented) continue;
    const ownersChanged = c.kind === 'changed' && JSON.stringify(lower(c.before?.owners)) !== JSON.stringify(lower(c.after?.owners));
    const reopened = c.kind === 'changed' && !!c.before?.doneBy && !c.after?.doneBy;
    const why =
      c.kind === 'removed'
        ? 'a measure of its incident review was removed'
        : c.kind === 'added' && !c.after?.doneBy
          ? 'a measure was added to its incident review'
          : ownersChanged
            ? 'the owners of a measure of its incident review changed'
            : reopened
              ? 'a measure of its incident review was reopened'
              : null;
    if (why) backToInProgress(f.id, why, c.actor);
  }
}
