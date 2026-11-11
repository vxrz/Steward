import type { FastifyRequest } from 'fastify';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { HttpError, parseJson } from '../util.js';
import { currentStore, currentUser } from './context.js';
import { aliasTarget, teamAliasTarget } from './aliases.js';
import { requireStepUp } from './assurance.js';
import type { StepUpRule } from './step-up.js';
import { catalogueTeams, newResourceTeams, type CatalogueKind, type OwningTeam } from './policy.js';

/**
 * Owners and responsible people from outside the owning teams (#195, docs/TEAMS.md#named-owners-and-responsibles).
 *
 * The editors of a team's item can name a `user:` or `team:` as its owner or responsible – a credential's owners, a
 * ticket reference's responsibles, the owners of a service, application, system, supplier or supplier contract, the
 * owner of a document, the owners of a measure, a duty or a corrective action. The named subject then sees the item and
 * changes it: a grant across teams without an administrator. It stays possible (a contact person in another team), but
 * it is as deliberate as changing an access list:
 *
 * - **Covered** subjects need nothing: a member of one of the item's owning teams, or one of those teams itself.
 * - An item **without owning teams** belongs to the whole instance: naming anyone there grants nothing new.
 * - Adding an uncovered subject asks for the step-up (control point access.grant, action `grantNamedAccess`) and is
 *   audited as an access change (`access.named_subjects_granted`: who was given what, on which item). Removing one
 *   never asks. API tokens cannot confirm, so they are refused (SESSION_REQUIRED, as for access lists).
 *
 * The routes ask before the handler runs (`namedGrantRule`, the step-up table of the route matrix); the services ask
 * again with the stored state (`requireNamedGrant`), so paths without such a rule – duplicates, imports, a request
 * whose body changed meaning between hook and handler – never grant without a confirmation.
 */

const norm = (s: string) => s.trim().toLowerCase();

/** A plain user name (records, findings) as a subject. */
export const userSubject = (name: string | null | undefined): string[] => (name && name.trim() ? [`user:${norm(name)}`] : []);

function teamIdOf(name: string): string | undefined {
  return db().get<{ id: string }>('SELECT id FROM teams WHERE lower(name) = ?', name)?.id ?? teamAliasTarget(name);
}

function userIdOf(name: string): string | undefined {
  return db().get<{ id: string }>('SELECT id FROM users WHERE lower(username) = ?', name)?.id ?? aliasTarget(name);
}

/**
 * The subjects of `after` that `before` does not have and that are not covered by `teams` (the item's owning teams).
 * Empty for an item without owning teams.
 */
export function uncoveredSubjects(teams: readonly OwningTeam[], before: readonly string[], after: readonly string[]): string[] {
  if (!teams.length) return [];
  const had = new Set(before.map(norm));
  const ids = new Set(teams.map((t) => t.id));
  const out: string[] = [];
  for (const raw of new Set(after.map(norm))) {
    if (!raw || had.has(raw)) continue;
    const m = /^(user|team):(.+)$/.exec(raw);
    if (!m) {
      out.push(raw);
      continue;
    }
    const name = m[2]!.trim();
    if (m[1] === 'team') {
      const id = teamIdOf(name);
      if (!id || !ids.has(id)) out.push(raw);
      continue;
    }
    const uid = userIdOf(name);
    const member = !!uid && !!db().get(`SELECT 1 FROM team_members WHERE user_id = ? AND team_id IN (${[...ids].map(() => '?').join(', ')})`, uid, ...ids);
    if (!member) out.push(raw);
  }
  return out.sort();
}

/** What a change names: the item, the field and the subjects before and after (for the step-up and the audit entry). */
export interface NamedGrant {
  /** The audit entry's entity type, e.g. credential, ticket, service, supplier_contract, record, duty, corrective_finding */
  entityType: string;
  /** null while it is created (the audit entry gets the new id) */
  entityId: string | null;
  /** The item for the summary, e.g. `credential "Payroll API key"` */
  label: string;
  /** The field, e.g. ownerSubjects, responsible, owners, owner */
  field: string;
  /** The item's owning teams (for a new item: those it gets) */
  teams: readonly OwningTeam[];
  before: readonly string[];
  after: readonly string[];
  /** What the named subjects may do then, e.g. view, edit */
  rights: readonly string[];
  /** More details for the audit entry, e.g. the contract of a supplier */
  details?: Record<string, unknown>;
}

/** The subjects a grant adds from outside the owning teams (the routes' step-up rules). */
export const outsidersOf = (g: NamedGrant): string[] => uncoveredSubjects(g.teams, g.before, g.after);

/**
 * The owners of a service, application, system or supplier a change names: with the item's teams (an application's
 * own, else those of its services), or – for a new item – those it gets from its creator (a new supplier gets none).
 */
export function catalogueGrant(kind: CatalogueKind, cur: { id: string; owners: string } | undefined, name: string, owners: readonly string[]): NamedGrant {
  return {
    entityType: kind,
    entityId: cur?.id ?? null,
    label: `${kind} "${name}"`,
    field: 'owners',
    teams: cur ? catalogueTeams(kind, cur.id) : kind === 'supplier' ? [] : newResourceTeams(currentUser()).teams,
    before: cur ? parseJson<string[]>(cur.owners, []) : [],
    after: [...new Set(owners)],
    rights: ['view', 'edit'],
  };
}

/** A refused confirmation as an error the error handler answers like the step-up hook (the web app asks and retries). */
class StepUpRefused extends HttpError {
  constructor(
    status: number,
    message: string,
    code: string,
    params: Record<string, unknown> | undefined,
    readonly stepUp: unknown,
  ) {
    super(status, message, code, params as never);
  }
}

/** Whether this request confirmed the control point access.grant already (the route's rule or an earlier call). */
const grantConfirmed = (): boolean =>
  ((currentStore()?.assurance?.proofs ?? []) as { point?: string; stepUp?: unknown }[]).some((p) => p.point === 'access.grant' && !!p.stepUp);

/**
 * The step-up of a change that names uncovered subjects (see above): returns them (empty: nothing to confirm), or
 * throws 403 STEP_UP_REQUIRED (SESSION_REQUIRED for API tokens, ASSURANCE_MFA_REQUIRED when the policy wants a second
 * factor). Call it before anything is written. Jobs without a signed-in user are not asked (they name nobody).
 */
export function requireNamedGrant(g: NamedGrant): string[] {
  const added = uncoveredSubjects(g.teams, g.before, g.after);
  if (!added.length) return added;
  const u = currentUser();
  if (!u || grantConfirmed()) return added;
  const refusal = requireStepUp(['access.grant'], u, 'grantNamedAccess');
  if (!refusal) return added;
  const b = refusal.body as { error?: string; code?: string; params?: Record<string, unknown>; stepUp?: unknown };
  throw new StepUpRefused(refusal.status, String(b.error ?? 'Confirm it is you first'), String(b.code ?? 'STEP_UP_REQUIRED'), b.params, b.stepUp);
}

/**
 * The access change of a named grant (inside the change's transaction, after it): `access.named_subjects_granted` –
 * who was given what, on which item, outside which owning teams. The step-up's proof is attached (audit.ts).
 */
export function auditNamedGrant(g: NamedGrant & { entityId: string }, added: readonly string[]): void {
  if (!added.length) return;
  const teams = g.teams.map((t) => t.name);
  audit({
    action: 'access.named_subjects_granted',
    entityType: g.entityType,
    entityId: g.entityId,
    summary: `${added.join(', ')} named in ${g.field} of ${g.label} outside its owning teams (${teams.join(', ')}): may ${g.rights.join(', ')}`.slice(0, 500),
    details: { ...g.details, field: g.field, granted: [...added], rights: [...g.rights], owningTeams: teams },
  });
}

/**
 * The route's step-up rule (`config.stepUp`): asks before the handler when `compute` finds uncovered subjects in the
 * request. `who`: the callers the route serves (others get the route's own answer). When `compute` fails – an unknown
 * item, a caller who may not change it, a body the route refuses – the route answers itself; the service asks again
 * before it writes anything (requireNamedGrant), so nothing is granted unconfirmed.
 */
export function namedGrantRule(compute: (req: FastifyRequest) => string[], who?: (req: FastifyRequest) => boolean): StepUpRule {
  return {
    action: 'grantNamedAccess',
    ...(who ? { who } : {}),
    when: (req) => {
      try {
        return compute(req).length > 0;
      } catch {
        return false; // the route answers (404, 403, 400)
      }
    },
  };
}

/** A `who` for namedGrantRule: `check` throws when the route refuses the caller (404, 403) – the route answers them then. */
export const serves =
  (check: (req: FastifyRequest) => unknown) =>
  (req: FastifyRequest): boolean => {
    try {
      check(req);
      return true;
    } catch {
      return false; // the route answers with its own refusal
    }
  };
