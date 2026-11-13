import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  OWNED_KINDS,
  SHARE_ACTIONS,
  accessPreviewSchema,
  accessScopeSchema,
  latestShareEnd,
  sharesInputSchema,
  type AccessPreview,
  type OwnedKind,
  type ResourceAccessView,
  type ShareInput,
} from '@sm/shared';
import { HttpError } from '../util.js';
import { ACCESS, me } from './access.js';
import type { AuthUser } from './context.js';
import { isAdmin, subjectsOf } from './permissions.js';
import { managesShares, owningTeams } from './policy.js';
import { heldOn, isRestricted, previewShares, setRestricted, setShares, shareKind, sharesOf, sharesWiden, type ShareKindDef } from './shares.js';
import { accessGrantRule } from './access-change.js';
import { subjectExists } from './subjects.js';
import { uncoveredSubjects } from './named-grants.js';
import { resourceNotFound } from './scope-routes.js';

/**
 * The Access tab of an item (ADR 0033 part 7, #290): one API for every kind that is switched to shares (registered
 * with its `ShareKindDef`, auth/shares.ts). Session only: share lists name people and are read and changed in the app
 * (`/api/v1` gains nothing in phase 1).
 *   GET  /api/access/:kind/:id/shares    scope, owning teams, shares, implied shares, what the reader may change
 *   PUT  /api/access/:kind/:id/shares    replace the shares (Manage; a widening asks for the step-up)
 *   PUT  /api/access/:kind/:id/scope     switch Restricted (administrators; switching it off asks for the step-up)
 *   POST /api/access/:kind/:id/preview   who would gain and who would lose what, nothing stored
 *
 * Team scope: an item the reader may not see answers 404 like a missing one. The share list is for Manage holders,
 * administrators and auditors; a share whose subject the reader may not see (a Manage holder who may not list users
 * and teams – viewers – sees only their own subjects) is counted, not named, and kept when the list is saved.
 */

const kindParam = z.enum(OWNED_KINDS);
const resourceForbidden = () => new HttpError(403, 'Only who manages this item may change its access', 'FORBIDDEN', { context: 'right_manage' });

/** The kind's definition and the item, if the reader may see it (404 otherwise, also for a kind without shares). */
function target(req: FastifyRequest): { def: ShareKindDef; id: string; u: AuthUser } {
  const p = req.params as { kind?: string; id?: string };
  const kind = kindParam.parse(p.kind);
  const id = String(p.id ?? '');
  const def = shareKind(kind);
  const u = me();
  if (!def || def.name(id) === undefined || !def.rights(u, id).length) throw resourceNotFound(kind, id);
  return { def, id, u };
}

/** Whether `u` may read every subject: who may list users and teams (GET /api/subjects), administrators and auditors. */
export const seesAllSubjects = (u: AuthUser): boolean => u.roles.some((r) => r !== 'viewer' && r !== 'plant' && r !== 'status');

/** Whether a share's subject may be named to `u` (else it is counted only). */
const subjectVisible = (u: AuthUser, subject: string): boolean => seesAllSubjects(u) || subjectsOf(u).has(subject.toLowerCase());

/** The list a reader sends, with the shares they may not see kept as they are (the reader cannot name them). */
export function withHiddenShares(kind: OwnedKind, id: string, u: AuthUser, input: readonly ShareInput[]): ShareInput[] {
  const sent = new Set(input.map((s) => s.subject.trim().toLowerCase()));
  const kept = sharesOf(kind, id)
    .filter((s) => !subjectVisible(u, s.subject) && !sent.has(s.subject))
    .map((s) => ({ subject: s.subject, level: s.level, actions: [...s.actions], expiresAt: s.expiresAt }));
  return [...input, ...kept];
}

/** The Access tab of an item for `u`. */
export function accessView(def: ShareKindDef, id: string, u: AuthUser): ResourceAccessView {
  const held = heldOn(def, u, id);
  const canManage = managesShares(held);
  const restricted = isRestricted(def.kind, id);
  const teams = (def.teams ?? ((x: string) => owningTeams(def.kind, x)))(id);
  const readsList = canManage || isAdmin(u) || u.roles.includes('auditor');
  const all = readsList ? sharesOf(def.kind, id) : [];
  const shown = all.filter((s) => subjectVisible(u, s.subject));
  return {
    kind: def.kind,
    id,
    name: def.name(id) ?? id,
    scope: teams.length ? 'teams' : restricted ? 'restricted' : 'instance',
    owningTeams: teams.map((t) => ({ id: t.id, name: t.name })),
    restricted,
    shares: readsList ? shown.map((s) => ({ ...s, known: s.subject.startsWith('role:') || subjectExists(s.subject) })) : null,
    hidden: all.length - shown.length,
    implied: (def.implied?.(id) ?? []).map((x) => ({
      ...x,
      // outside the owning teams – or any subject on a Restricted item without teams: naming it was a widening
      outside: teams.length ? uncoveredSubjects(teams, [], [x.subject]).length > 0 : restricted,
    })),
    actions: [...SHARE_ACTIONS[def.kind]],
    held: held === 'all' ? 'all' : { level: held.level, actions: [...held.actions] },
    canManage,
    canRestrict: isAdmin(u) || (def.restrictBy === 'manage' && canManage),
    maxEnd: latestShareEnd().toISOString(),
  };
}

/** PUT …/shares: whether the list widens (the step-up rule; refusals are the route's). */
function sharesWidenOf(req: FastifyRequest): boolean {
  const { def, id, u } = target(req);
  return sharesWiden(def.kind, id, withHiddenShares(def.kind, id, u, sharesInputSchema.parse(req.body).shares));
}

/** PUT …/scope: switching Restricted off gives the instance roles their defaults back. */
function scopeWidens(req: FastifyRequest): boolean {
  const { def, id } = target(req);
  return !accessScopeSchema.parse(req.body).restricted && isRestricted(def.kind, id);
}

export async function shareRoutes(app: FastifyInstance): Promise<void> {
  app.get('/access/:kind/:id/shares', { config: { access: ACCESS.session } }, async (req): Promise<ResourceAccessView> => {
    const { def, id, u } = target(req);
    return accessView(def, id, u);
  });

  app.put(
    '/access/:kind/:id/shares',
    { config: { access: ACCESS.session, stepUp: accessGrantRule(sharesWidenOf) } },
    async (req): Promise<ResourceAccessView> => {
      const { def, id, u } = target(req);
      const input = sharesInputSchema.parse(req.body).shares;
      setShares({ kind: def.kind, id, held: heldOn(def, u, id), shares: withHiddenShares(def.kind, id, u, input) });
      return accessView(def, id, u);
    },
  );

  app.put('/access/:kind/:id/scope', { config: { access: ACCESS.session, stepUp: accessGrantRule(scopeWidens) } }, async (req): Promise<ResourceAccessView> => {
    const { def, id, u } = target(req);
    const { restricted } = accessScopeSchema.parse(req.body);
    const view = accessView(def, id, u);
    if (!view.canRestrict) throw resourceForbidden();
    setRestricted({ kind: def.kind, id, restricted, held: isAdmin(u) ? 'all' : heldOn(def, u, id) });
    return accessView(def, id, u);
  });

  app.post('/access/:kind/:id/preview', { config: { access: ACCESS.session } }, async (req): Promise<AccessPreview> => {
    const { def, id, u } = target(req);
    if (!managesShares(heldOn(def, u, id)) && !isAdmin(u)) throw resourceForbidden();
    const b = accessPreviewSchema.parse(req.body);
    return previewShares(def.kind, id, {
      ...(b.shares ? { shares: withHiddenShares(def.kind, id, u, b.shares) } : {}),
      ...(b.restricted === undefined ? {} : { restricted: b.restricted }),
    });
  });
}
