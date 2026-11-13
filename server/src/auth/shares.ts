import {
  PLANT_SHARE_KINDS,
  ROLES,
  SHARE_ACTIONS,
  SHARE_LEVELS,
  SHARE_LIMIT,
  latestShareEnd,
  levelIncludes,
  shareInputSchema,
  type OwnedKind,
  moduleOfItemKind,
  type ResourceShare,
  type ShareInput,
  type ShareLevel,
} from '@sm/shared';
import { db } from '../db.js';
import { HttpError, nowIso } from '../util.js';
import { currentActor, type AuthUser } from './context.js';
import { assertKnownSubjects } from './subjects.js';
import { findUserByName, toAuthUser } from './users.js';
import { heldShare, managesShares, memberships, moduleOnly, owningTeams, plantOnly, type HeldShare, type OwningTeam, type ShareModel } from './policy.js';
import { subjectUsesModule } from '../modules/access.js';
import { isRestricted, shareActive, sharesChanged, sharesOf, toShare, type ShareRow } from './share-store.js';
import { ACCESS_AUDIT, auditAccessChange, gainedRights, requireAccessGrant, type Gain } from './access-change.js';

export { isRestricted, shareActive, sharesChanged, sharesFor, sharesOf, withShareState } from './share-store.js';

/**
 * Shares and the Restricted scope (ADR 0033): the store, the widening check and the audit of every change.
 *
 * - **Deciding** reads shares in bulk per request (auth/share-store.ts) and merges them in `decide()` (auth/policy.ts)
 *   for kinds that pass their `ShareModel`; `heldShare()` says what someone holds in share terms.
 * - **Changing** – `setShares()`, `setRestricted()` – needs Manage (decision 3: Edit may not re-share); nobody shares a
 *   level or action right they do not hold (administrators excepted); a change that gives anyone a right they did not
 *   have asks for the step-up `grantAccess` (auth/access-change.ts) before anything is written; narrowing never asks.
 * - **Audit:** `access.share_added|share_changed|share_removed|share_expired|scope_changed` on the item.
 * - **End dates** are optional and at most a year ahead; an ended share stops at once (deciding checks the date) and
 *   is removed by the job (`expireShares`, audited), its Manage holders are reminded 7 days before (auth/share-jobs.ts).
 * - **Kinds** declare what the job and the later Access tab need (`ShareKindDef`) in their feature manifest
 *   (`shareKinds`, features/define.ts); the composition root registers them.
 */

// ---------- kinds ----------

/** What the shares core needs to know of a kind that is switched to shares (declared in its feature manifest). */
export interface ShareKindDef<P extends string = string> {
  kind: OwnedKind;
  /** How the kind's rights follow from a share (auth/policy.ts) */
  model: ShareModel<P>;
  /** The item's name for messages and audit summaries; undefined when it no longer exists */
  name: (id: string) => string | undefined;
  /** The in-app path of the item */
  link: (id: string) => string;
  /** The rights `u` has on the item – the kind's own access function, shares included; [] when they may not see it */
  rights: (u: AuthUser, id: string) => readonly P[];
  /**
   * The shares its owner or responsible fields imply (ADR 0033 part 2): computed from the field, never stored; the
   * Access tab shows them read-only. Default: none
   */
  implied?: (id: string) => { subject: string; level: ShareLevel; as: 'owner' | 'responsible' }[];
  /** The teams that scope the item (default: its owning teams; an application without its own: its services') */
  teams?: (id: string) => OwningTeam[];
  /** Who may switch Restricted (decision 15): administrators (the default) or the item's Manage holders as well */
  restrictBy?: 'admin' | 'manage';
}

const KINDS = new Map<OwnedKind, ShareKindDef>();

/** Registers a kind (features/index.ts, from the manifests' `shareKinds`). */
export function registerShareKind(def: ShareKindDef): void {
  KINDS.set(def.kind, def);
}

/** The registered definition of a kind, if it is switched to shares. */
export const shareKind = (kind: OwnedKind): ShareKindDef | undefined => KINDS.get(kind);

/** What `u` holds on an item of a registered kind in share terms (`'all'` for administrators). */
export function heldOn(def: ShareKindDef, u: AuthUser, id: string): HeldShare | 'all' {
  return heldShare(u, def.model, def.rights(u, id));
}

/** The item for audit summaries: `service "Order intake"`, or the kind and id when the kind cannot name it. */
const labelOf = (kind: OwnedKind, id: string): string => {
  const name = KINDS.get(kind)?.name(id);
  return name === undefined ? `${kind} ${id}` : `${kind} "${name}"`;
};

// ---------- the widening check ----------

/** The state of a resource that decides who reaches it through shares. */
export interface ShareState {
  restricted: boolean;
  shares: readonly ResourceShare[];
}

/** Whether end date `a` is later than `b` (null: no end). */
const later = (a: string | null, b: string | null): boolean => (a === null ? b !== null : b !== null && Date.parse(a) > Date.parse(b));

/**
 * The rights a change of shares or scope gives anyone that they did not have (ADR 0033 part 5): a new share, a higher
 * level, a new action right, a later end date (`extended`), Restricted switched off (`scope`: role defaults). A share
 * that has ended counts as none. Empty: the change narrows or keeps.
 */
export function shareGains(before: ShareState, after: ShareState, now: number = Date.now()): Gain[] {
  const grants = (st: ShareState) => {
    const out = new Map<string, Set<string>>();
    for (const s of st.shares) {
      if (!shareActive(s, now)) continue;
      const rights = out.get(s.subject) ?? new Set<string>();
      for (const l of SHARE_LEVELS) if (levelIncludes(s.level, l)) rights.add(l);
      for (const a of s.actions) rights.add(a);
      out.set(s.subject, rights);
    }
    // switching Restricted off gives the role defaults back (as emptying an access list did)
    if (!st.restricted) out.set('scope', new Set(['roleDefaults']));
    return out;
  };
  const gains = gainedRights(grants(before), grants(after));
  const had = new Map(before.shares.filter((s) => shareActive(s, now)).map((s) => [s.subject, s]));
  for (const s of after.shares) {
    const old = had.get(s.subject);
    if (!old || !shareActive(s, now) || !later(s.expiresAt, old.expiresAt)) continue;
    const g = gains.find((x) => x.subject === s.subject);
    if (g) g.rights.push('extended');
    else gains.push({ subject: s.subject, rights: ['extended'] });
  }
  return gains.sort((a, b) => a.subject.localeCompare(b.subject));
}

// ---------- validation ----------

const forbidden = () => new HttpError(403, 'Only who manages this item may change its shares', 'FORBIDDEN', { context: 'right_manage' });

/** A status viewer (role status, nothing that works in Steward): the status pages only. */
function statusOnly(u: AuthUser): boolean {
  return u.roles.includes('status') && u.roles.every((r) => r === 'status') && [...memberships(u).values()].every((m) => !m.roles.length);
}

/**
 * A share never widens route access (ADR 0033 security notes): status viewers get none, plant viewers only on the
 * plant registry's kinds; `role:admin` and `role:status` mean nothing as share subjects. A share of a module's item
 * goes only to a user or team that uses the module (ADR 0034 decision 15): giving module access stays an
 * administrator's decision, so the refusal says why (`context: 'module'`).
 */
function assertSuitable(kind: OwnedKind, subject: string): void {
  const [type, name] = [subject.slice(0, subject.indexOf(':')), subject.slice(subject.indexOf(':') + 1)];
  const unsuitable = () => new HttpError(400, `${subject} cannot be given a share of this item`, 'SHARE_SUBJECT_UNSUITABLE', { subject });
  const plantKind = PLANT_SHARE_KINDS.includes(kind);
  if (type === 'role') {
    if (name === 'admin' || name === 'status' || (name === 'plant' && !plantKind)) throw unsuitable();
    return;
  }
  const module = moduleOfItemKind(kind);
  if (module && (type === 'user' || type === 'team') && !subjectUsesModule(subject, module))
    throw new HttpError(400, `${subject} does not use the module of this item – an administrator can give them access to it`, 'SHARE_SUBJECT_UNSUITABLE', {
      subject,
      context: 'module',
      module,
    });
  if (type !== 'user') return;
  const info = findUserByName(name);
  if (!info) return; // a former name (alias): assertKnownSubjects decided
  const u = toAuthUser(info);
  // a status viewer who is also a plant registry user (the former "plant" and "status" pair, ADR 0034) is a plant viewer
  if ((statusOnly(u) && !moduleOnly(u)) || (!plantKind && plantOnly(u))) throw unsuitable();
}

/** An end date as stored (ISO): a day means its end (UTC); null: none. */
function endOf(v: string | null | undefined): string | null {
  if (v === null || v === undefined || v.trim() === '') return null;
  const t = v.trim();
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T23:59:59.999Z` : t);
  if (Number.isNaN(ms)) throw new HttpError(400, `"${t.slice(0, 40)}" is not a date`, 'SHARE_EXPIRY_INVALID', { max: latestShareEnd().toISOString() });
  return new Date(ms).toISOString();
}

/** The shares of a request, cleaned: subjects in lower case, one share per subject (the last wins), action rights of the kind. */
function cleanShares(kind: OwnedKind, input: readonly ShareInput[]): Omit<ResourceShare, 'createdBy' | 'createdAt'>[] {
  const offered = SHARE_ACTIONS[kind] as readonly string[];
  const out = new Map<string, Omit<ResourceShare, 'createdBy' | 'createdAt'>>();
  for (const raw of input) {
    const s = shareInputSchema.parse(raw);
    const subject = s.subject.trim().toLowerCase();
    const m = /^(user|team|role):(.+)$/.exec(subject);
    if (!m || (m[1] === 'role' && !(ROLES as readonly string[]).includes(m[2]!)))
      throw new HttpError(400, `Invalid subject "${subject}" – use user:<name>, team:<name> or role:<role>`, 'ACL_SUBJECT_INVALID', { subject });
    const unknown = s.actions.find((a) => !offered.includes(a));
    if (unknown) throw new HttpError(400, `A share of a ${kind} has no action right "${unknown}"`, 'SHARE_ACTION_UNKNOWN', { action: unknown });
    out.set(subject, { subject, level: s.level, actions: [...new Set(s.actions)].sort(), expiresAt: endOf(s.expiresAt) });
  }
  return [...out.values()].sort((a, b) => a.subject.localeCompare(b.subject));
}

const describe = (s: Pick<ResourceShare, 'level' | 'actions' | 'expiresAt'>): string =>
  `${s.level}${s.actions.length ? ` + ${s.actions.join(', ')}` : ''}${s.expiresAt ? ` until ${s.expiresAt.slice(0, 10)}` : ''}`;
const plain = (s: Pick<ResourceShare, 'level' | 'actions' | 'expiresAt'>) => ({ level: s.level, actions: [...s.actions], expiresAt: s.expiresAt });
const sameShare = (a: Pick<ResourceShare, 'level' | 'actions' | 'expiresAt'>, b: Pick<ResourceShare, 'level' | 'actions' | 'expiresAt'>) =>
  a.level === b.level && a.expiresAt === b.expiresAt && a.actions.join() === [...b.actions].sort().join();

/**
 * Whether replacing a resource's shares with `input` would give anyone a right – for a route's step-up rule
 * (`accessGrantRule(req => sharesWiden(…))`); throws on a list the service refuses (the route answers then).
 */
export function sharesWiden(kind: OwnedKind, id: string, input: readonly ShareInput[]): boolean {
  const restricted = isRestricted(kind, id);
  const next = cleanShares(kind, input).map((s) => ({ ...s, createdBy: '', createdAt: '' }));
  return shareGains({ restricted, shares: sharesOf(kind, id) }, { restricted, shares: next }).length > 0;
}

/**
 * What a change of shares or scope would give and take (the Access tab's preview, ADR 0033 part 7): per subject, the
 * rights it gains (a widening: the step-up) and the rights it loses (a narrowing: confirmed). `extended` is a later end
 * date, `shortened` an earlier one, `roleDefaults` the instance roles' defaults of the scope. Nothing is stored.
 */
export function previewShares(
  kind: OwnedKind,
  id: string,
  change: { shares?: readonly ShareInput[]; restricted?: boolean },
): { gains: Gain[]; losses: Gain[] } {
  const before: ShareState = { restricted: isRestricted(kind, id), shares: sharesOf(kind, id) };
  const after: ShareState = {
    restricted: change.restricted ?? before.restricted,
    shares: change.shares ? cleanShares(kind, change.shares).map((s) => ({ ...s, createdBy: '', createdAt: '' })) : before.shares,
  };
  const losses = shareGains(after, before).map((g) => ({ ...g, rights: g.rights.map((r) => (r === 'extended' ? 'shortened' : r)) }));
  return { gains: shareGains(before, after), losses };
}

// ---------- changing ----------

/** A change of a resource's shares: the whole new list. */
export interface ShareChange {
  kind: OwnedKind;
  id: string;
  /** What `heldShare()` / `heldOn()` say the author holds; only Manage changes shares */
  held: HeldShare | 'all';
  shares: readonly ShareInput[];
  /** The item for audit summaries, e.g. `service "Order intake"` (default: the kind's name for it) */
  label?: string;
}

/**
 * Replaces the shares of a resource (ADR 0033): needs Manage, never more than the author holds, and the step-up when
 * anyone gains a right. Writes and audits each added, changed and removed share in one transaction; shares that had
 * ended are removed first (audited as expired). Returns the shares now stored.
 */
export function setShares(c: ShareChange): ResourceShare[] {
  if (!managesShares(c.held)) throw forbidden();
  const now = Date.now();
  const next = cleanShares(c.kind, c.shares);
  const label = c.label ?? labelOf(c.kind, c.id);
  expireShares(now, { kind: c.kind, id: c.id });
  const before = sharesOf(c.kind, c.id);
  // the shares a reader may not see are kept beside the ones they send (share-routes.ts): the limit holds for the sum
  if (next.length > SHARE_LIMIT && next.length > before.length)
    throw new HttpError(400, `An item has at most ${SHARE_LIMIT} shares`, 'LIMIT_REACHED', { max: SHARE_LIMIT });
  const had = new Map(before.map((s) => [s.subject, s]));
  assertKnownSubjects(
    next.map((s) => s.subject),
    before.map((s) => s.subject),
  );
  for (const s of next) if (!had.has(s.subject)) assertSuitable(c.kind, s.subject);
  // an end date that is set or moved: in the future and at most a year ahead (decision 4)
  const max = latestShareEnd(now);
  for (const s of next) {
    if (s.expiresAt === null || s.expiresAt === had.get(s.subject)?.expiresAt) continue;
    const t = Date.parse(s.expiresAt);
    if (t <= now || t > max.getTime())
      throw new HttpError(
        400,
        `The end date of a share must be in the future and at most a year ahead (${max.toISOString().slice(0, 10)})`,
        'SHARE_EXPIRY_INVALID',
        {
          max: max.toISOString(),
        },
      );
  }
  const restricted = isRestricted(c.kind, c.id);
  const gains = shareGains({ restricted, shares: before }, { restricted, shares: next.map((s) => ({ ...s, createdBy: '', createdAt: '' })) }, now);
  // nobody shares more than they hold: every share that gives a right is within the author's own (ADR 0033 part 5)
  if (c.held !== 'all') {
    const held = c.held;
    for (const g of gains) {
      const s = next.find((x) => x.subject === g.subject)!;
      if (!held.level || !levelIncludes(held.level, s.level) || s.actions.some((a) => !held.actions.includes(a)))
        throw new HttpError(403, `You cannot share more than you hold yourself (${s.subject})`, 'SHARE_EXCEEDS_OWN_RIGHTS', { subject: s.subject });
    }
  }
  if (gains.length) requireAccessGrant();
  const d = db();
  const ts = nowIso();
  const actor = currentActor();
  d.tx(() => {
    for (const old of before) {
      if (next.some((s) => s.subject === old.subject)) continue;
      d.run('DELETE FROM resource_shares WHERE kind = ? AND resource_id = ? AND subject = ?', c.kind, c.id, old.subject);
      auditAccessChange({
        action: ACCESS_AUDIT.shareRemoved,
        entityType: c.kind,
        entityId: c.id,
        summary: `Share of ${label} with ${old.subject} removed (was ${describe(old)})`,
        details: { subject: old.subject, before: plain(old) },
      });
    }
    for (const s of next) {
      const old = had.get(s.subject);
      const granted = gains.find((g) => g.subject === s.subject)?.rights ?? [];
      if (!old) {
        d.run(
          'INSERT INTO resource_shares (kind, resource_id, subject, level, actions, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          c.kind,
          c.id,
          s.subject,
          s.level,
          JSON.stringify(s.actions),
          s.expiresAt,
          actor,
          ts,
        );
        auditAccessChange({
          action: ACCESS_AUDIT.shareAdded,
          entityType: c.kind,
          entityId: c.id,
          summary: `Shared ${label} with ${s.subject}: ${describe(s)}`,
          details: { subject: s.subject, after: plain(s), granted },
        });
      } else if (!sameShare(s, old)) {
        // a new end date arms the reminder again
        d.run(
          `UPDATE resource_shares SET level = ?, actions = ?, expires_at = ?${s.expiresAt !== old.expiresAt ? ', reminded_at = NULL' : ''} WHERE kind = ? AND resource_id = ? AND subject = ?`,
          s.level,
          JSON.stringify(s.actions),
          s.expiresAt,
          c.kind,
          c.id,
          s.subject,
        );
        auditAccessChange({
          action: ACCESS_AUDIT.shareChanged,
          entityType: c.kind,
          entityId: c.id,
          summary: `Share of ${label} with ${s.subject}: ${describe(old)} → ${describe(s)}`,
          details: { subject: s.subject, before: plain(old), after: plain(s), granted },
        });
      }
    }
  });
  sharesChanged();
  return sharesOf(c.kind, c.id);
}

/**
 * Switches a resource's scope to Restricted or back (ADR 0033 part 1, decision 15 – the kind decides who may: its Manage
 * holders, administrators). Switching it off gives the role defaults back and asks for the step-up; switching it on
 * narrows. Audited as `access.scope_changed`. Returns whether anything changed.
 */
export function setRestricted(c: { kind: OwnedKind; id: string; restricted: boolean; held: HeldShare | 'all'; label?: string }): boolean {
  if (!managesShares(c.held)) throw forbidden();
  const before = isRestricted(c.kind, c.id);
  if (before === c.restricted) return false;
  const label = c.label ?? labelOf(c.kind, c.id);
  if (!c.restricted) requireAccessGrant();
  const teams = owningTeams(c.kind, c.id).map((t) => t.name);
  db().tx(() => {
    if (c.restricted)
      db().run(
        'INSERT INTO resource_restrictions (kind, resource_id, created_by, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
        c.kind,
        c.id,
        currentActor(),
        nowIso(),
      );
    else db().run('DELETE FROM resource_restrictions WHERE kind = ? AND resource_id = ?', c.kind, c.id);
    auditAccessChange({
      action: ACCESS_AUDIT.scopeChanged,
      entityType: c.kind,
      entityId: c.id,
      summary: c.restricted
        ? `${label} is Restricted: instance roles give nothing on it, only its ${teams.length ? 'owning teams and ' : ''}shares`
        : `${label} is no longer Restricted: ${teams.length ? 'its owning teams' : 'the whole instance'} and its shares`,
      details: {
        before: before ? 'restricted' : 'open',
        after: c.restricted ? 'restricted' : 'open',
        owningTeams: teams,
        ...(c.restricted ? {} : { granted: [{ subject: 'scope', rights: ['roleDefaults'] }] }),
      },
    });
  });
  sharesChanged();
  return true;
}

/** Removes the shares and the scope of a deleted resource (no audit: the deletion is). */
export function forgetShares(kind: OwnedKind, id: string): void {
  db().tx(() => {
    db().run('DELETE FROM resource_shares WHERE kind = ? AND resource_id = ?', kind, id);
    db().run('DELETE FROM resource_restrictions WHERE kind = ? AND resource_id = ?', kind, id);
  });
  sharesChanged();
}

/**
 * Removes shares whose end date has passed – all of them, or those of one resource – each audited as
 * `access.share_expired` by the system (decision 4). Returns the number removed.
 */
export function expireShares(now: number = Date.now(), only?: { kind: OwnedKind; id: string }): number {
  const at = new Date(now).toISOString();
  const rows = only
    ? db().all<ShareRow>(
        'SELECT * FROM resource_shares WHERE kind = ? AND resource_id = ? AND expires_at IS NOT NULL AND expires_at <= ? ORDER BY subject',
        only.kind,
        only.id,
        at,
      )
    : db().all<ShareRow>('SELECT * FROM resource_shares WHERE expires_at IS NOT NULL AND expires_at <= ? ORDER BY kind, resource_id, subject LIMIT 1000', at);
  let removed = 0;
  for (const r of rows) {
    const s = toShare(r);
    const kind = r.kind as OwnedKind;
    db().tx(() => {
      const gone = db().run(
        'DELETE FROM resource_shares WHERE kind = ? AND resource_id = ? AND subject = ? AND expires_at = ?',
        kind,
        r.resource_id,
        r.subject,
        r.expires_at,
      ).changes;
      if (!gone) return;
      removed++;
      auditAccessChange({
        actor: 'system',
        action: ACCESS_AUDIT.shareExpired,
        entityType: kind,
        entityId: r.resource_id,
        summary: `Share of ${labelOf(kind, r.resource_id)} with ${s.subject} ended on ${s.expiresAt!.slice(0, 10)} and was removed (was ${describe(s)})`,
        details: { subject: s.subject, before: plain(s), removed: [s.subject] },
      });
    });
  }
  if (removed) sharesChanged();
  return removed;
}
