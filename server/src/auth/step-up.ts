import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { StepUpInfo, StepUpStatus } from '@sm/shared';
import { db } from '../db.js';
import { config } from '../config.js';
import { audit } from '../audit.js';
import { HttpError, nowIso } from '../util.js';
import type { AuthUser, SessionMeta } from './context.js';
import { getUser, verifyStepUpPassword, type SessionInfo } from './users.js';
import { getProvider } from './sso.js';

/**
 * Step-up re-authentication (OWASP ASVS 3.7.1, docs/SECURITY-HARDENING.md#step-up-re-authentication).
 *
 * A sensitive route says so in its config: `config: { stepUp: true }`, or a rule on the request for routes where only
 * some changes are sensitive (`stepUp: (req) => roles changed`). The authentication hook (app.ts) checks it before the
 * handler runs: the session must have confirmed its owner within SM_STEP_UP_MINUTES – the password again (password
 * sessions), a fresh sign-in at the identity provider (single sign-on sessions), or the sign-in itself. Otherwise the
 * answer is 403 STEP_UP_REQUIRED with the way to confirm; the web app asks, confirms and sends the same request again
 * (once). Nothing is stored and replayed on the server.
 *
 * - Emergency sessions count as confirmed for their (at most one hour) life: opening one needed the server's command line
 *   and the master passphrase, which is more than a password; they have no password or provider to confirm with.
 * - API tokens (no session) never do a step-up action: a token cannot confirm anything, so the hook refuses it
 *   (SESSION_REQUIRED) – for rules on the request, only when the request is a sensitive one.
 */

/** A route's step-up rule: always, or only when the request is a sensitive one (the body is parsed already). */
export type StepUpRule = true | ((req: FastifyRequest) => boolean);

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Needs a recent confirmation of the session's owner (step-up.ts) */
    stepUp?: StepUpRule;
  }
}

export const stepUpWindowMs = (): number => config.session.stepUpMs;
/** Clock difference between Steward and the identity provider that is tolerated for auth_time. */
export const CLOCK_SKEW_MS = 60_000;

/** Whether the rule applies to this request. A rule that fails (e.g. an unknown id) asks for the step-up: fail closed. */
export function stepUpApplies(req: FastifyRequest, rule: StepUpRule | undefined): boolean {
  if (!rule) return false;
  if (rule === true) return true;
  try {
    return rule(req);
  } catch {
    return true;
  }
}

export function steppedUpUntil(s: SessionMeta | undefined, now = Date.now()): number | null {
  if (!s) return null;
  if (s.method === 'emergency') return Number.MAX_SAFE_INTEGER;
  if (s.stepUpAt === null) return null;
  const until = s.stepUpAt + stepUpWindowMs();
  return until > now ? until : null;
}

/** How a session confirms its owner: by how it was opened (password, single sign-on, emergency). */
export function stepUpInfo(s: SessionMeta | undefined, account: Pick<SessionInfo, 'authSource'>): StepUpInfo {
  const windowMinutes = Math.round(stepUpWindowMs() / 60_000);
  if (!s) return { method: 'none', windowMinutes };
  if (s.method === 'emergency') return { method: 'emergency', windowMinutes };
  if (s.method === 'password') return { method: 'password', windowMinutes };
  try {
    const p = getProvider(account.authSource);
    if (p.enabled) return { method: 'sso', provider: { id: p.id, displayName: p.displayName }, mfa: p.stepUpMfa, windowMinutes };
  } catch {
    /* the provider is gone */
  }
  return { method: 'none', windowMinutes };
}

/**
 * The hook's decision (app.ts) for a route with a step-up rule that applies: undefined (go on) or the refusal to send.
 * `viaToken`: an API token, not a session.
 */
export function stepUpRefusal(viaToken: boolean, info: SessionInfo): { status: number; body: Record<string, unknown> } | undefined {
  if (viaToken) {
    return {
      status: 403,
      body: { error: 'API tokens cannot do this – sign in to the web UI and confirm it there', code: 'SESSION_REQUIRED', params: { context: 'stepUp' } },
    };
  }
  if (steppedUpUntil(info.session)) return undefined;
  const stepUp = stepUpInfo(info.session, info);
  return {
    status: 403,
    body: {
      error:
        stepUp.method === 'none'
          ? 'Confirm it is you first: sign in again – this session cannot confirm it'
          : `Confirm it is you first: ${stepUp.method === 'sso' ? `sign in again with ${stepUp.provider!.displayName}` : 'enter your password'}`,
      code: 'STEP_UP_REQUIRED',
      params: { context: stepUp.method, ...(stepUp.provider ? { provider: stepUp.provider.displayName } : {}) },
      stepUp,
    },
  };
}

function markSteppedUp(sessionId: string, method: string, at: number): void {
  db().run('UPDATE sessions SET step_up_at = ?, step_up_method = ? WHERE id = ?', new Date(at).toISOString(), method, sessionId);
}

/** The signed-in session of the request (not an API token). */
export function requireSession(u: AuthUser | null): AuthUser & { session: SessionMeta } {
  if (!u?.session) throw new HttpError(403, 'API tokens cannot do this – sign in to the web UI', 'SESSION_REQUIRED');
  return u as AuthUser & { session: SessionMeta };
}

// ---------- refused single sign-on confirmations, for the dialog of the session that asked ----------

const failures = new Map<string, { code: string; message: string; at: string }>();
const MAX_FAILURES = 1000;

export function recordStepUpFailure(sessionId: string, code: string, message: string): void {
  if (failures.size >= MAX_FAILURES && !failures.has(sessionId)) failures.delete(failures.keys().next().value!);
  failures.set(sessionId, { code, message: message.slice(0, 300), at: nowIso() });
}

export function stepUpStatus(u: AuthUser & { session: SessionMeta }): StepUpStatus {
  const info = stepUpInfo(u.session, getUser(u.id));
  const until = steppedUpUntil(u.session);
  const failure = failures.get(u.session.id);
  return {
    ...info,
    // an emergency session is confirmed while it lasts
    until: u.session.method === 'emergency' ? (u.emergency?.expiresAt ?? null) : until === null ? null : new Date(until).toISOString(),
    confirmedWith: u.session.method === 'emergency' ? 'emergency' : until ? u.session.stepUpMethod : null,
    ...(failure ? { failure } : {}),
  };
}

// ---------- password ----------

export async function passwordStepUp(u: AuthUser & { session: SessionMeta }, password: string, ip: string | undefined): Promise<StepUpStatus> {
  if (u.session.method !== 'password') {
    throw new HttpError(
      400,
      u.session.method === 'sso' ? 'This session was opened with single sign-on – confirm it with your sign-in provider' : 'This session needs no confirmation',
      'STEP_UP_METHOD',
      { method: u.session.method },
    );
  }
  try {
    await verifyStepUpPassword(u.id, password, { ip });
  } catch (e) {
    if ((e as HttpError).code === 'STEP_UP_WRONG_PASSWORD') {
      audit({
        action: 'auth.step_up_failed',
        entityType: 'user',
        entityId: u.id,
        summary: `Confirmation of ${u.username} refused: wrong password (attempt ${(e as { attempt?: number }).attempt ?? 1})`,
        details: { method: 'password', reason: 'wrong_password', ip },
      });
    }
    throw e;
  }
  const at = Date.now();
  markSteppedUp(u.session.id, 'password', at);
  audit({
    action: 'auth.step_up',
    entityType: 'user',
    entityId: u.id,
    summary: `${u.username} confirmed it is them with the password (valid ${Math.round(stepUpWindowMs() / 60_000)} min)`,
    details: { method: 'password', ip },
  });
  return stepUpStatus({ ...u, session: { ...u.session, stepUpAt: at, stepUpMethod: 'password' } });
}

/** Ends the confirmation early (the person is done, like `sudo -k`). */
export function endStepUp(u: AuthUser & { session: SessionMeta }): void {
  if (u.session.method === 'emergency' || u.session.stepUpAt === null) return;
  db().run('UPDATE sessions SET step_up_at = NULL, step_up_method = NULL WHERE id = ?', u.session.id);
  audit({ action: 'auth.step_up_ended', entityType: 'user', entityId: u.id, summary: `${u.username} ended the confirmation of their session` });
}

// ---------- single sign-on: the callback hands a one-time ticket to the browser that holds the session ----------

interface Ticket {
  sessionId: string;
  userId: string;
  method: 'sso' | 'sso+mfa';
  at: number;
  provider: string;
  expires: number;
}
const tickets = new Map<string, Ticket>();
const TICKET_TTL_MS = 2 * 60_000;
const MAX_TICKETS = 1000;

/**
 * After the callback checked the identity provider's answer (sso.ts finishStepUp). The callback request carries no
 * session (the SameSite=Strict cookie is not sent on the redirect from the provider), so the confirmation only counts
 * once the browser that holds the session redeems the ticket: a sign-in finished in another browser confirms nothing.
 */
export function issueStepUpTicket(t: Omit<Ticket, 'expires'>): string {
  const now = Date.now();
  for (const [k, v] of tickets) if (v.expires < now) tickets.delete(k);
  while (tickets.size >= MAX_TICKETS) tickets.delete(tickets.keys().next().value!);
  const id = crypto.randomBytes(32).toString('base64url');
  tickets.set(id, { ...t, expires: now + TICKET_TTL_MS });
  return id;
}

export function redeemStepUpTicket(u: AuthUser & { session: SessionMeta }, ticket: string): StepUpStatus {
  const t = tickets.get(ticket);
  if (!t || t.expires < Date.now() || t.sessionId !== u.session.id || t.userId !== u.id) {
    recordStepUpFailure(u.session.id, 'STEP_UP_TICKET', 'The confirmation belongs to another session or expired');
    audit({
      action: 'auth.step_up_failed',
      entityType: 'user',
      entityId: u.id,
      summary: `Confirmation of ${u.username} refused: the single sign-on was finished for another session or too late`,
      details: { method: 'sso', reason: 'ticket' },
    });
    throw new HttpError(403, 'The confirmation belongs to another session or expired – try again', 'STEP_UP_TICKET');
  }
  tickets.delete(ticket);
  markSteppedUp(u.session.id, t.method, t.at);
  failures.delete(u.session.id);
  audit({
    action: 'auth.step_up',
    entityType: 'user',
    entityId: u.id,
    summary: `${u.username} confirmed it is them with a fresh sign-in at ${t.provider}${t.method === 'sso+mfa' ? ' (multi-factor)' : ''}`,
    details: { method: t.method, provider: t.provider },
  });
  return stepUpStatus({ ...u, session: { ...u.session, stepUpAt: t.at, stepUpMethod: t.method } });
}
