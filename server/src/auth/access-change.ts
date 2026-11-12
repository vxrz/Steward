import type { FastifyRequest } from 'fastify';
import { audit } from '../audit.js';
import { currentUser, type AuthUser } from './context.js';
import { requireStepUpNow } from './named-grants.js';
import type { StepUpRule } from './step-up.js';

/**
 * Access changes (ADR 0033 part 5): one widening check, one confirmation and one audit family for every change of who
 * may see or do what – shares and the Restricted scope (auth/shares.ts), module access (ADR 0034) and what follows.
 *
 * - **Widening** is any change after which a subject holds a right it did not hold: a new share, a higher level, a new
 *   action right, a later end date, Restricted switched off, a module opened. Narrowing never asks.
 * - A widening asks for the step-up `grantAccess` (control point `access.grant`, a baseline that cannot be switched
 *   off). API tokens cannot confirm: `SESSION_REQUIRED`. The route asks before its handler (`accessGrantRule`), the
 *   service again before it writes anything (`requireAccessGrant`), so paths without the route rule never widen
 *   unconfirmed. Jobs without a signed-in user are not asked (they only narrow, e.g. expired shares).
 * - Every change is audited in the `access.` family (`auditAccessChange`); entries written after a confirmation carry
 *   its proof (`details.assurance`, audit.ts), so they appear in the assurance report and – through the audit log
 *   excerpt – in evidence packs. The audit log lists the family with the filter `access.`.
 */

/** Who holds which rights: subject (`user:`, `team:`, `role:`, or a pseudo subject such as `scope`) → rights. */
export type Grants = ReadonlyMap<string, ReadonlySet<string>>;

/** A subject and the rights it gains through a change. */
export interface Gain {
  subject: string;
  rights: string[];
}

/** The rights each subject holds after a change that it did not hold before (empty: the change only narrows or keeps). */
export function gainedRights(before: Grants, after: Grants): Gain[] {
  const out: Gain[] = [];
  for (const [subject, rights] of after) {
    const had = before.get(subject);
    const gained = [...rights].filter((r) => !had?.has(r)).sort();
    if (gained.length) out.push({ subject, rights: gained });
  }
  return out.sort((a, b) => a.subject.localeCompare(b.subject));
}

/** Whether a change gives anyone a right they did not have. */
export const widens = (before: Grants, after: Grants): boolean => gainedRights(before, after).length > 0;

/** The audit actions of the access family. Others of the family (`access.module_access_changed` …) keep the prefix. */
export const ACCESS_AUDIT = {
  shareAdded: 'access.share_added',
  shareChanged: 'access.share_changed',
  shareRemoved: 'access.share_removed',
  shareExpired: 'access.share_expired',
  scopeChanged: 'access.scope_changed',
} as const;
export type AccessAuditAction = (typeof ACCESS_AUDIT)[keyof typeof ACCESS_AUDIT] | `access.${string}`;

/**
 * The confirmation of a widening, asked in the service before anything is written: returns when the request is
 * confirmed (by the route's rule or earlier in it), else throws 403 STEP_UP_REQUIRED – SESSION_REQUIRED for API tokens,
 * ASSURANCE_MFA_REQUIRED when the policy wants a second factor – answered like the step-up hook, so the web app asks
 * and retries. Without a signed-in user (a job) nothing is asked.
 */
export function requireAccessGrant(u: AuthUser | null = currentUser()): void {
  if (u) requireStepUpNow('access.grant', u, 'grantAccess');
}

/**
 * The route's step-up rule (`config.stepUp`) of a change that may widen access: asks before the handler when
 * `widensAccess` says so. When it throws – an unknown item, a caller the route refuses, a body it rejects – the route
 * answers itself, and the service asks again before it writes (requireAccessGrant).
 */
export function accessGrantRule(widensAccess: (req: FastifyRequest) => boolean, who?: StepUpRule['who']): StepUpRule {
  return {
    action: 'grantAccess',
    ...(who ? { who } : {}),
    when: (req) => {
      try {
        return widensAccess(req);
      } catch {
        return false; // the route answers (404, 403, 400)
      }
    },
  };
}

/** One entry of the access family, on the item whose access changed (inside the change's transaction). */
export interface AccessChangeEntry {
  action: AccessAuditAction;
  /** The kind of the item (process, service, module …) and its id */
  entityType: string;
  entityId: string;
  summary: string;
  /** What changed – by convention `before`, `after`, `granted` (the gains) and `removed` where they apply */
  details: Record<string, unknown>;
  /** `system` for a job (an expired share); default: who is signed in */
  actor?: string;
}

/** Writes an entry of the access family (the step-up's proof is attached by audit.ts). */
export function auditAccessChange(e: AccessChangeEntry): void {
  audit({
    ...(e.actor ? { actor: e.actor } : {}),
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    summary: e.summary.slice(0, 500),
    details: e.details,
  });
}
