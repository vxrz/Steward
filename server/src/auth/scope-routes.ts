import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { OWNED_KINDS, type AccessExplanation, type OwnedKind } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import { ACCESS, me } from './access.js';
import { capabilities, isAdmin } from './permissions.js';
import { owningTeams, platformAccess, processAccess } from './policy.js';
import { findUserByName, toAuthUser } from './users.js';
import type { AuthUser } from './context.js';

/**
 * Owning teams of resources and why someone has access (#131).
 *   GET  /api/owning-teams/:kind/:id          the owning teams (whoever can see the resource)
 *   PUT  /api/owning-teams/:kind/:id          set them (administrators; adding a team is confirmed with a step-up)
 *   GET  /api/access/explain?kind&id&user     the rights of a user and where they come from (administrators and
 *                                             auditors for anyone, everybody for themselves)
 */

const kindParam = z.enum(OWNED_KINDS);
const params = (req: FastifyRequest) => {
  const p = req.params as { kind?: string; id?: string };
  return { kind: kindParam.parse(p.kind), id: String(p.id ?? '') };
};

interface ResourceRow {
  id: string;
  name: string;
  owner?: string | null;
  acl: string;
}

function resource(kind: OwnedKind, id: string): ResourceRow | undefined {
  return kind === 'process'
    ? db().get<ResourceRow>('SELECT id, name, owner, acl FROM processes WHERE id = ?', id)
    : db().get<ResourceRow>('SELECT id, name, acl FROM platforms WHERE id = ?', id);
}

function access(kind: OwnedKind, r: ResourceRow, u: AuthUser | null) {
  return kind === 'process'
    ? processAccess(u, { id: r.id, owner: r.owner ?? null, acl: parseJson(r.acl, []) })
    : platformAccess(u, { id: r.id, acl: parseJson(r.acl, []) });
}

const notFound = (kind: OwnedKind, id: string) =>
  kind === 'process'
    ? new HttpError(404, 'Process not found', 'PROCESS_NOT_FOUND', { id })
    : new HttpError(404, `Platform ${id} not found`, 'PLATFORM_NOT_FOUND', { id });

/** The resource, if the caller may see it (404 otherwise, like one that does not exist). */
function visible(kind: OwnedKind, id: string): ResourceRow {
  const r = resource(kind, id);
  if (!r || !access(kind, r, me()).permissions.length) throw notFound(kind, id);
  return r;
}

const teamIds = z.object({ teamIds: z.array(z.string().max(64)).max(50) });

/** Adding an owning team gives its members their roles on the resource: confirmed like other grants. */
function addsTeam(req: FastifyRequest): boolean {
  const p = req.params as { kind?: string; id?: string };
  const kind = kindParam.safeParse(p.kind);
  const b = teamIds.safeParse(req.body);
  if (!kind.success || !b.success) return false;
  const before = new Set(owningTeams(kind.data, String(p.id ?? '')).map((t) => t.id));
  return b.data.teamIds.some((t) => !before.has(t));
}

export async function scopeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/owning-teams/:kind/:id', async (req) => {
    const { kind, id } = params(req);
    visible(kind, id);
    return { teams: owningTeams(kind, id), canChange: isAdmin(me()) };
  });

  app.put(
    '/owning-teams/:kind/:id',
    { config: { access: ACCESS.admin, stepUp: { action: 'grantAccess', who: 'manageUsers', when: addsTeam } } },
    async (req) => {
      const { kind, id } = params(req);
      const r = resource(kind, id);
      if (!r) throw notFound(kind, id);
      const ids = [...new Set(teamIds.parse(req.body).teamIds)];
      const known = new Map(
        db()
          .all<{ id: string; name: string }>('SELECT id, name FROM teams')
          .map((t) => [t.id, t.name]),
      );
      const unknown = ids.find((t) => !known.has(t));
      if (unknown) throw new HttpError(400, `Unknown team "${unknown}"`, 'TEAM_NOT_FOUND', { id: unknown });
      const before = owningTeams(kind, id);
      db().tx(() => {
        db().run('DELETE FROM resource_teams WHERE kind = ? AND resource_id = ?', kind, id);
        const ts = nowIso();
        for (const t of ids) db().run('INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES (?, ?, ?, ?)', kind, id, t, ts);
        const names = ids.map((t) => known.get(t)!);
        audit({
          action: 'access.owning_teams_changed',
          entityType: kind,
          entityId: id,
          summary: `Owning teams of ${kind} "${r.name}": ${names.length ? names.join(', ') : 'none (the whole instance)'}${before.length ? ` (were: ${before.map((t) => t.name).join(', ')})` : ''}`,
          details: { before: before.map((t) => t.name), after: names },
        });
      });
      return { teams: owningTeams(kind, id), canChange: true };
    },
  );

  app.get('/access/explain', async (req): Promise<AccessExplanation> => {
    const q = z.object({ kind: kindParam, id: z.string().max(64), user: z.string().max(64).optional() }).parse(req.query);
    const caller = me();
    const r = visible(q.kind, q.id);
    let who = caller;
    if (q.user && q.user.toLowerCase() !== caller.username.toLowerCase()) {
      // someone else's rights: administrators and auditors (as for access reviews)
      if (!isAdmin(caller) && !capabilities(caller).viewAudit) throw new HttpError(403, 'You are not allowed to see the rights of others', 'FORBIDDEN');
      const u = findUserByName(q.user);
      if (!u) throw new HttpError(404, `Unknown user "${q.user}"`, 'USER_NOT_FOUND', { name: q.user });
      who = toAuthUser(u);
    }
    const d = access(q.kind, r, who);
    return { kind: q.kind, id: q.id, user: who.username, owningTeams: owningTeams(q.kind, q.id), permissions: d.permissions, reasons: d.reasons };
  });
}
