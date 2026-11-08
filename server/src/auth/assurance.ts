import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ASSURANCE_LIMITS,
  CONTROL_POINTS,
  applyChanges,
  baselineRule,
  claimsShowMfa,
  controlPoint,
  controlPointOfAction,
  effectiveRule,
  instanceRule,
  normalizePolicy,
  policyChanges,
  splitPolicyChange,
  strictestRule,
  type AssuranceMethod,
  type AssurancePendingChange,
  type AssurancePolicy,
  type AssurancePolicyInput,
  type AssurancePolicySaved,
  type AssurancePolicyVersion,
  type AssurancePolicyView,
  type PolicyChange,
  type StepUpAction,
  type StepUpStatus,
} from '@sm/shared';
import { db } from '../db.js';
import { audit, authenticRows } from '../audit.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { currentStore, type AuthUser, type SessionMeta } from './context.js';
import { IDENTITY_CHECKS, sameIdentity } from './aliases.js';
import { applicableRule, sessionRef, stepUpRefusal, stepUpStatus, stepUpWindowMs } from './step-up.js';
import { currentPolicy, currentPolicyInfo, fourEyesRequired, pointRule, policyAsOf, writePolicy } from './assurance-policy.js';
import { listOverrides } from './assurance-overrides.js';

export { currentPolicy, effectiveMcpMode, fourEyesRequired, mayDecideInTeams, pointRule, policyAsOf } from './assurance-policy.js';

/**
 * Enforcement of the assurance policy (#210, docs/ASSURANCE.md): the one place that decides whether a control point
 * needs a fresh confirmation of the signed-in person (step-up) or a second person (four-eyes), and that records how
 * each event met the rule – the proof goes into the audit entries the request writes (audit.ts withAssurance), so it
 * lies in the HMAC chain under the signed checkpoints.
 *
 *  - requireStepUp(points, user, action): the step-up of routes (`config.stepUp`, mapped to their control point) and
 *    of the points an administrator can turn on (approving records, decisions in access checks and person reviews,
 *    verifying manual steps, closing firewall changes). With the default policy it asks exactly what 0.4.0 asked.
 *  - checkFourEyes(point, requesters, approver): requester ≠ approver by identity – the user, former names of moved
 *    accounts, and another account linked to the same single sign-on identity (aliases.ts sameIdentity).
 *  - savePolicy / approveChange / rejectChange: tightening applies at once, loosening waits for a second administrator.
 */

// ---------- proofs ----------

export interface AssuranceProof {
  /** Random id of the event (one request can write several audit entries that carry it) */
  ref: string;
  point: string;
  /** The policy version in force */
  policyVersion: number;
  rule: { stepUp: boolean; maxAgeMinutes: number | null; mfa: boolean; fourEyes: boolean };
  actor: string;
  at: string;
  /** A reference of the session (step-up.ts sessionRef), not its id */
  session?: string;
  stepUp?: {
    method: AssuranceMethod;
    /** When the session last confirmed (ISO) */
    confirmedAt?: string;
    /** Single sign-on: the provider's auth_time (ISO), amr and acr */
    authTime?: string;
    amr?: string[];
    acr?: string;
    provider?: string;
    mfa: boolean;
  };
  fourEyes?: { required: boolean; requesters: string[]; approver: string; checks: readonly string[] };
  /** Decided in a Microsoft Teams card (ADR 0013): no Steward session, the person known by their Entra tid + oid */
  via?: 'teams';
}

type Bag = { proofs: Record<string, unknown>[]; consumed: boolean };

function bag(): Bag | null {
  const s = currentStore();
  if (!s) return null;
  return (s.assurance ??= { proofs: [], consumed: false });
}

function proofFor(point: string, u: AuthUser, rule: AssuranceProof['rule']): AssuranceProof | null {
  const b = bag();
  if (!b) return null;
  const found = (b.proofs as unknown as AssuranceProof[]).find((p) => p.point === point);
  if (found) {
    found.rule = { ...found.rule, fourEyes: found.rule.fourEyes || rule.fourEyes };
    return found;
  }
  const p: AssuranceProof = {
    ref: crypto.randomBytes(8).toString('hex'),
    point,
    policyVersion: currentPolicy().version,
    rule,
    actor: u.username,
    at: nowIso(),
    ...(u.session ? { session: sessionRef(u.session.id) } : {}),
  };
  b.proofs.push(p as unknown as Record<string, unknown>);
  return p;
}

// ---------- step-up ----------

/** Whether the session's last confirmation shows multi-factor authentication (the provider said so, or amr / acr). */
export function sessionMfa(s: SessionMeta | undefined, policy: AssurancePolicy = currentPolicy()): boolean {
  if (!s || !s.stepUpMethod?.startsWith('sso')) return false;
  if (s.stepUpMethod === 'sso+mfa') return true;
  return claimsShowMfa(policy.mfa, s.stepUpDetail ?? {});
}

type Refusal = { status: number; body: Record<string, unknown> };

/**
 * The step-up of control points (the strictest rule of all of them): undefined when the request may go on – with the
 * proof noted for its audit entries – or the refusal. An unknown point asks as 0.4.0 did (fail closed).
 */
export function requireStepUp(points: string[], u: AuthUser, action: StepUpAction): Refusal | undefined {
  const policy = currentPolicy();
  const defs = points.map((k) => controlPoint(k)).filter((p) => !!p);
  if (!defs.length) return stepUpRefusal(u, action);
  const rules = defs.map((d) => effectiveRule(d, policy));
  const rule = strictestRule(rules);
  const ruleOf = (i: number) => ({ ...strictestRule([rules[i]!]), fourEyes: rules[i]!.fourEyes });
  if (!rule.stepUp) {
    defs.forEach((d, i) => {
      const p = proofFor(d.key, u, ruleOf(i));
      if (p && !p.stepUp) p.stepUp = { method: 'notRequired', mfa: false };
    });
    return undefined;
  }
  const maxAgeMs = rule.maxAgeMinutes ? Math.min(rule.maxAgeMinutes * 60_000, stepUpWindowMs()) : stepUpWindowMs();
  const refused = stepUpRefusal(u, action, { maxAgeMs, mfa: rule.mfa });
  if (refused) return refused;
  const s = u.session!;
  const mfa = s.method !== 'emergency' && sessionMfa(s, policy);
  if (rule.mfa && s.method !== 'emergency' && !mfa) {
    // a single sign-on session confirms again, asking the provider for a second factor; a password cannot be one
    if (s.method === 'sso') return stepUpRefusal(u, action, { maxAgeMs, mfa: true, fresh: true });
    audit({
      action: 'assurance.mfa_refused',
      entityType: 'user',
      entityId: u.id,
      summary: `${u.username} was refused (${defs.map((d) => d.key).join(', ')}): it needs a confirmation with multi-factor authentication, the session was opened with a password`,
      details: { points: defs.map((d) => d.key), method: s.method, session: sessionRef(s.id), policyVersion: policy.version },
    });
    return {
      status: 403,
      body: {
        error: 'This needs a confirmation with multi-factor authentication: sign in with single sign-on and confirm with a second factor',
        code: 'ASSURANCE_MFA_REQUIRED',
        params: { context: 'password' },
      },
    };
  }
  const d = s.stepUpDetail ?? null;
  defs.forEach((def, i) => {
    const p = proofFor(def.key, u, ruleOf(i));
    if (!p) return;
    p.stepUp =
      s.method === 'emergency'
        ? { method: 'emergency', mfa: false }
        : {
            method: (s.stepUpMethod === 'sso+mfa' || (s.stepUpMethod === 'sso' && mfa) ? 'sso+mfa' : (s.stepUpMethod ?? 'password')) as AssuranceMethod,
            ...(s.stepUpAt !== null ? { confirmedAt: new Date(s.stepUpAt).toISOString() } : {}),
            ...(d?.authTime !== undefined ? { authTime: new Date(d.authTime * 1000).toISOString() } : {}),
            ...(d?.amr ? { amr: d.amr } : {}),
            ...(d?.acr ? { acr: d.acr } : {}),
            ...(d?.provider ? { provider: d.provider } : {}),
            mfa,
          };
  });
  return undefined;
}

/** The control points of a route's step-up rule for this request. */
function pointsOf(req: FastifyRequest, rule: { action: StepUpAction; points?: (req: FastifyRequest) => string[] }): string[] {
  if (rule.points) return rule.points(req);
  const p = controlPointOfAction(rule.action);
  // an action without a point: asked as before (requireStepUp fails closed)
  return [p?.key ?? `action:${rule.action}`];
}

/** The step-up hook (app.ts, inside the request context): undefined (go on) or the refusal to send. */
export function stepUpCheck(req: FastifyRequest): Refusal | undefined {
  const a = applicableRule(req);
  if (!a) return undefined;
  let points: string[];
  try {
    points = pointsOf(req, a.rule);
  } catch (e) {
    // "not found": the route answers itself; anything else asks (fail closed)
    if ((e as HttpError).statusCode === 404) return undefined;
    points = [`action:${a.rule.action}`];
  }
  if (!points.length) return undefined;
  // the dialog names what is confirmed: the point's own action when the request decides the point
  const action = a.rule.points ? (controlPoint(points[0]!)?.actions[0] ?? a.rule.action) : a.rule.action;
  const refusal = requireStepUp(points, a.u, action);
  if (!refusal) (req as unknown as { smAssurance?: Bag | null }).smAssurance = bag();
  return refusal;
}

/**
 * After the response (app.ts): a confirmed step-up whose route wrote no audit entry of its own is recorded on its own
 * (`assurance.confirmed`), so every confirmed event is in the log.
 */
export function recordUnwrittenProofs(req: FastifyRequest, reply: FastifyReply): void {
  const b = (req as unknown as { smAssurance?: Bag | null }).smAssurance;
  if (!b || b.consumed || reply.statusCode >= 400) return;
  const proofs = (b.proofs as unknown as AssuranceProof[]).filter((p) => p.stepUp && p.stepUp.method !== 'notRequired');
  if (!proofs.length) return;
  b.consumed = true;
  const first = proofs[0]!;
  audit({
    actor: first.actor,
    action: 'assurance.confirmed',
    entityType: 'assurance',
    entityId: first.point,
    summary: `${first.actor} confirmed ${proofs.map((p) => p.point).join(', ')} (${first.stepUp!.method})`,
    details: { assurance: proofs },
  });
}

/** The strictest step-up rule of what a dialog confirms (SSO step-up: ask for MFA; GET /auth/step-up?action=). */
export function stepUpRuleForActions(actions: StepUpAction[]): { maxAgeMs: number; mfa: boolean } {
  const policy = currentPolicy();
  const rules = actions.map((a) => controlPointOfAction(a)).flatMap((p) => (p ? [effectiveRule(p, policy)] : []));
  const r = strictestRule(rules);
  return { maxAgeMs: r.maxAgeMinutes ? Math.min(r.maxAgeMinutes * 60_000, stepUpWindowMs()) : stepUpWindowMs(), mfa: r.stepUp && r.mfa };
}

/** What the single sign-on step-up asks the provider for (sso.ts startStepUp). */
export function ssoMfaAsk(actions: StepUpAction[]): { required: boolean; amrValues: string[]; acrValues: string[] } {
  const m = currentPolicy().mfa;
  return { required: stepUpRuleForActions(actions).mfa, amrValues: m.amrValues.map((x) => x.toLowerCase()), acrValues: m.acrValues };
}

/** GET /auth/step-up: the session's state – for an action, under that action's rule (age, MFA). */
export function assuranceStepUpStatus(u: AuthUser & { session: SessionMeta }, action?: StepUpAction): StepUpStatus {
  if (!action) return stepUpStatus(u);
  const r = stepUpRuleForActions([action]);
  const s = stepUpStatus(u, r.maxAgeMs);
  if (r.mfa && u.session.method !== 'emergency' && !sessionMfa(u.session)) return { ...s, until: null, confirmedWith: null, mfa: true };
  return s;
}

// ---------- four-eyes ----------

/** Records the four-eyes part of an event (who asked, who decided) for the request's audit entries. */
export function noteFourEyes(
  point: string,
  requesters: (string | null | undefined)[],
  approver: AuthUser,
  opts: { itemRequires?: boolean; via?: 'teams' } = {},
): void {
  const rule = pointRule(point, { fourEyes: !!opts.itemRequires });
  const p = proofFor(point, approver, { stepUp: rule.stepUp, maxAgeMinutes: rule.maxAgeMinutes, mfa: rule.mfa, fourEyes: rule.fourEyes });
  if (!p) return;
  if (opts.via) p.via = opts.via;
  p.fourEyes = {
    required: rule.fourEyes,
    requesters: [...new Set(requesters.filter((x): x is string => !!x))],
    approver: approver.username,
    checks: IDENTITY_CHECKS,
  };
}

/**
 * Four-eyes at a control point: whether a second person is required (the policy, or the item itself) and whether
 * `approver` is one – not any of the requesters by identity. Noted for the audit entries when it holds.
 */
export function checkFourEyes(
  point: string,
  requesters: (string | null | undefined)[],
  approver: AuthUser,
  opts: { itemRequires?: boolean } = {},
): { required: boolean; ok: boolean } {
  const required = fourEyesRequired(point, !!opts.itemRequires);
  const same = requesters.some((n) => sameIdentity(n, approver));
  if (required && same) return { required, ok: false };
  noteFourEyes(point, requesters, approver, opts);
  return { required, ok: true };
}

/** Whether two recorded names are the same person (user, former names, linked single sign-on identity). */
export const samePerson = sameIdentity;

// ---------- changing the policy ----------

interface ChangeRow {
  id: string;
  status: AssurancePendingChange['status'];
  requested_by: string;
  requested_by_id: string;
  requested_at: string;
  expires_at: string;
  base_version: number;
  changes: string;
  comment: string;
  decided_by: string | null;
  decided_at: string | null;
}

const isAdmin = (u: AuthUser | null): boolean => !!u?.roles.includes('admin');

/** Pending changes older than 7 days expire (also run as a job, features/auth.ts). */
export function expirePolicyChanges(now = nowIso()): number {
  const rows = db().all<ChangeRow>("SELECT * FROM assurance_policy_changes WHERE status = 'pending' AND expires_at <= ?", now);
  for (const r of rows) {
    db().tx(() => {
      if (!db().run("UPDATE assurance_policy_changes SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'", now, r.id).changes) return;
      audit({
        actor: 'system',
        action: 'assurance.policy_change_expired',
        entityType: 'assurance_policy',
        entityId: r.id,
        summary: `The loosening of the assurance policy that ${r.requested_by} asked for expired: no second administrator approved it within ${ASSURANCE_LIMITS.pendingDays} days`,
        details: { changeId: r.id, requestedBy: r.requested_by, changes: parseJson(r.changes, []) },
      });
    });
  }
  return rows.length;
}

function pendingRow(): ChangeRow | undefined {
  expirePolicyChanges();
  return db().get<ChangeRow>("SELECT * FROM assurance_policy_changes WHERE status = 'pending' ORDER BY requested_at DESC LIMIT 1");
}

function approveBlocked(u: AuthUser | null, r: ChangeRow): string | null {
  if (!isAdmin(u)) return 'Only administrators approve changes of the assurance policy';
  if (u!.id === r.requested_by_id || sameIdentity(r.requested_by, u!)) return 'Another administrator approves the loosening you asked for (four-eyes)';
  return null;
}

function toPending(r: ChangeRow, u: AuthUser | null): AssurancePendingChange {
  const blocked = r.status === 'pending' ? approveBlocked(u, r) : 'decided';
  return {
    id: r.id,
    status: r.status,
    requestedBy: r.requested_by,
    requestedAt: r.requested_at,
    expiresAt: r.expires_at,
    comment: r.comment,
    changes: parseJson<PolicyChange[]>(r.changes, []),
    baseVersion: Number(r.base_version),
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    canApprove: r.status === 'pending' && !blocked,
    canReject: r.status === 'pending' && isAdmin(u),
    approveBlocked: r.status === 'pending' ? blocked : null,
  };
}

/** The pending change, for System status (who asked, until when). */
export function pendingPolicyChange(): { id: string; requestedBy: string; expiresAt: string } | null {
  const r = pendingRow();
  return r ? { id: r.id, requestedBy: r.requested_by, expiresAt: r.expires_at } : null;
}

const describe = (c: PolicyChange) => `${c.point} ${c.field}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`;

/** Writes a new version of the policy and audits it with before and after. */
function applyPolicy(next: AssurancePolicy, meta: { by: string; approvedBy?: string; changeId?: string; comment?: string }): PolicyChange[] {
  const before = currentPolicy();
  const after = normalizePolicy({ ...next, version: before.version + 1 });
  const changes = policyChanges(before, after);
  if (!changes.length) return [];
  const at = nowIso();
  writePolicy(after, at);
  audit({
    action: 'assurance.policy_changed',
    entityType: 'assurance_policy',
    entityId: String(after.version),
    summary:
      `Assurance policy version ${after.version}${meta.approvedBy ? ` (asked for by ${meta.by}, approved by ${meta.approvedBy})` : ''}: ${changes.map(describe).join('; ')}`.slice(
        0,
        1900,
      ),
    details: {
      version: after.version,
      before,
      after,
      changes,
      requestedBy: meta.by,
      ...(meta.approvedBy ? { approvedBy: meta.approvedBy } : {}),
      ...(meta.changeId ? { changeId: meta.changeId } : {}),
      ...(meta.comment ? { comment: meta.comment } : {}),
    },
  });
  return changes;
}

function requireAdmin(u: AuthUser | null): AuthUser {
  if (!isAdmin(u)) throw new HttpError(403, 'Only administrators change the assurance policy', 'FORBIDDEN', { context: 'assurancePolicy' });
  return u!;
}

/**
 * A new policy from Settings → Assurance policy: what makes the rules stricter applies at once; what loosens them
 * (never below the baseline) waits for a second administrator – one such request at a time, for 7 days.
 */
export function savePolicy(input: AssurancePolicyInput & { points: NonNullable<AssurancePolicyInput['points']> }, user: AuthUser | null): AssurancePolicySaved {
  const u = requireAdmin(user);
  const current = currentPolicy();
  const next = normalizePolicy({ version: current.version, points: input.points, mfa: input.mfa ?? current.mfa });
  const window = Math.round(stepUpWindowMs() / 60_000);
  for (const [key, r] of Object.entries(next.points))
    if (r.maxAgeMinutes !== undefined && r.maxAgeMinutes !== null && r.maxAgeMinutes > window)
      throw new HttpError(
        400,
        `A confirmation lasts at most ${window} minutes (SM_STEP_UP_MINUTES): "${key}" asks for ${r.maxAgeMinutes}`,
        'ASSURANCE_MAX_AGE',
        {
          max: window,
          point: key,
        },
      );
  const { now, tightened, loosened } = splitPolicyChange(current, next);
  const open = loosened.length ? pendingRow() : undefined;
  if (open)
    throw new HttpError(
      409,
      `${open.requested_by} asked to loosen the policy already – that request is approved or rejected first`,
      'ASSURANCE_CHANGE_PENDING',
      {
        user: open.requested_by,
      },
    );
  const comment = (input.comment ?? '').trim().slice(0, ASSURANCE_LIMITS.comment);
  let pending: AssurancePendingChange | null = null;
  let applied: PolicyChange[] = [];
  db().tx(() => {
    if (tightened.length) applied = applyPolicy(now, { by: u.username, comment });
    if (loosened.length) {
      const id = newId('apc_');
      const at = nowIso();
      const expires = new Date(Date.now() + ASSURANCE_LIMITS.pendingDays * 86_400_000).toISOString();
      db().run(
        `INSERT INTO assurance_policy_changes (id, status, requested_by, requested_by_id, requested_at, expires_at, base_version, changes, comment)
         VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
        id,
        u.username,
        u.id,
        at,
        expires,
        currentPolicy().version,
        JSON.stringify(loosened),
        comment,
      );
      audit({
        action: 'assurance.policy_change_requested',
        entityType: 'assurance_policy',
        entityId: id,
        summary:
          `${u.username} asked to loosen the assurance policy (a second administrator approves it within ${ASSURANCE_LIMITS.pendingDays} days): ${loosened.map(describe).join('; ')}`.slice(
            0,
            1900,
          ),
        details: { changeId: id, changes: loosened, baseVersion: currentPolicy().version, expiresAt: expires, ...(comment ? { comment } : {}) },
      });
      pending = toPending(db().get<ChangeRow>('SELECT * FROM assurance_policy_changes WHERE id = ?', id)!, u);
    }
  });
  return { view: policyView(u), applied, pending };
}

function requirePending(id: string): ChangeRow {
  expirePolicyChanges();
  const r = db().get<ChangeRow>('SELECT * FROM assurance_policy_changes WHERE id = ?', id);
  if (!r) throw new HttpError(404, `Policy change ${id} not found`, 'ASSURANCE_CHANGE_NOT_FOUND', { id });
  if (r.status !== 'pending') throw new HttpError(409, `The policy change was ${r.status} already`, 'ASSURANCE_CHANGE_DECIDED', { status: r.status });
  return r;
}

/** A second administrator approves a loosening: it takes effect now (on top of whatever changed since). */
export function approveChange(id: string, user: AuthUser | null): AssurancePolicyView {
  const u = requireAdmin(user);
  const r = requirePending(id);
  const blocked = approveBlocked(u, r);
  if (blocked) throw new HttpError(403, blocked, 'FOUR_EYES_POLICY');
  const changes = parseJson<PolicyChange[]>(r.changes, []);
  db().tx(() => {
    if (
      !db().run(
        "UPDATE assurance_policy_changes SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
        u.username,
        nowIso(),
        id,
      ).changes
    )
      throw new HttpError(409, 'The policy change was decided in the meantime', 'ASSURANCE_CHANGE_DECIDED');
    noteFourEyes('assurance.policy', [r.requested_by], u);
    applyPolicy(applyChanges(currentPolicy(), changes), { by: r.requested_by, approvedBy: u.username, changeId: id, comment: r.comment });
  });
  return policyView(u);
}

/** Another administrator rejects the loosening, or the one who asked withdraws it. Nothing changes. */
export function rejectChange(id: string, user: AuthUser | null, comment = ''): AssurancePolicyView {
  const u = requireAdmin(user);
  const r = requirePending(id);
  const own = u.id === r.requested_by_id || sameIdentity(r.requested_by, u);
  const status = own ? 'withdrawn' : 'rejected';
  db().tx(() => {
    db().run('UPDATE assurance_policy_changes SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?', status, u.username, nowIso(), id);
    audit({
      action: own ? 'assurance.policy_change_withdrawn' : 'assurance.policy_change_rejected',
      entityType: 'assurance_policy',
      entityId: id,
      summary: own
        ? `${u.username} withdrew their request to loosen the assurance policy`
        : `${u.username} rejected the loosening of the assurance policy that ${r.requested_by} asked for${comment.trim() ? `: ${comment.trim()}` : ''}`.slice(
            0,
            1900,
          ),
      details: {
        changeId: id,
        requestedBy: r.requested_by,
        changes: parseJson(r.changes, []),
        ...(comment.trim() ? { comment: comment.trim().slice(0, 1000) } : {}),
      },
    });
  });
  return policyView(u);
}

// ---------- reading ----------

export function policyView(u: AuthUser | null): AssurancePolicyView {
  const { policy, since } = currentPolicyInfo();
  const rules: AssurancePolicyView['rules'] = {};
  for (const p of CONTROL_POINTS) rules[p.key] = { baseline: baselineRule(p), instance: instanceRule(p, policy), defaults: instanceRule(p, { points: {} }) };
  const pending = pendingRow();
  return {
    policy,
    rules,
    windowMinutes: Math.round(stepUpWindowMs() / 60_000),
    pending: pending ? toPending(pending, u) : null,
    overrides: listOverrides(policy),
    since,
    canChange: isAdmin(u),
  };
}

/** Every version of the policy from the audit log (oldest first), with what changed and who approved a loosening. */
export function policyHistory(opts: { from?: string; to?: string } = {}): AssurancePolicyVersion[] {
  const where = ['action = ?'];
  const params: unknown[] = ['assurance.policy_changed'];
  if (opts.from) (where.push('ts >= ?'), params.push(new Date(opts.from).toISOString()));
  if (opts.to) (where.push('ts <= ?'), params.push(new Date(opts.to).toISOString()));
  const { rows } = authenticRows(where.join(' AND '), params, { ascending: true, limit: 5000, ownOnly: true });
  return rows.map((r) => {
    const d = parseJson<{ version?: number; changes?: PolicyChange[]; approvedBy?: string; requestedBy?: string }>(r.details, {});
    return {
      version: Number(d.version ?? 0),
      at: r.ts,
      by: d.requestedBy ?? r.actor,
      approvedBy: d.approvedBy ?? null,
      changes: d.changes ?? [],
      seq: Number(r.seq),
    };
  });
}

/** GET …/as-of: the policy in force at a time (from the audit log). */
export function policyAt(at: string): { at: string; policy: AssurancePolicy; since: string | null } {
  const r = policyAsOf(at);
  return { at: new Date(at).toISOString(), policy: r.policy, since: r.since };
}
