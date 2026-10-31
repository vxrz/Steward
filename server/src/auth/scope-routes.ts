import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { OWNED_KINDS, type AccessExplanation, type AccessReason, type OwnedKind } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { HttpError, parseJson } from '../util.js';
import { canReadRecordRow } from '../records/access.js';
import { credentialAccess } from '../credentials/service.js';
import { monitorAccess } from '../monitors/model.js';
import { dashboardAccess } from '../dashboards/service.js';
import { ticketAccess } from '../tickets/service.js';
import { ACCESS, me } from './access.js';
import { capabilities, isAdmin } from './permissions.js';
import { catalogueAccess, catalogueTeams, owningTeams, platformAccess, processAccess, recordAccess, setOwningTeams, type CatalogueKind } from './policy.js';
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
  acl?: string;
  owners?: string;
  type_id?: string;
  fields?: string;
  owner_subjects?: string;
  archived?: number;
  responsible?: string;
}

const CATALOGUE_TABLES = { service: 'services', application: 'applications', system: 'systems' } as const;
const isCatalogue = (kind: OwnedKind): kind is CatalogueKind => kind in CATALOGUE_TABLES;

/** The resource of a kind (any kind that can have owning teams). Records by id or number. */
export function ownedResource(kind: OwnedKind, id: string): ResourceRow | undefined {
  if (kind === 'process') return db().get<ResourceRow>('SELECT id, name, owner, acl FROM processes WHERE id = ?', id);
  if (kind === 'platform') return db().get<ResourceRow>('SELECT id, name, acl FROM platforms WHERE id = ?', id);
  if (kind === 'record')
    return db().get<ResourceRow>("SELECT id, number || ' ' || title AS name, owner, type_id, fields FROM records WHERE id = ? OR number = ?", id, id);
  if (kind === 'credential') return db().get<ResourceRow>('SELECT id, name, owner_subjects, archived FROM credentials WHERE id = ?', id);
  if (kind === 'monitor') return db().get<ResourceRow>('SELECT id, name, owner, acl FROM monitors WHERE id = ?', id);
  if (kind === 'dashboard') return db().get<ResourceRow>('SELECT id, name, owner FROM dashboards WHERE id = ?', id);
  if (kind === 'ticket') return db().get<ResourceRow>("SELECT id, external_number || ' ' || title AS name, responsible FROM ticket_refs WHERE id = ?", id);
  return db().get<ResourceRow>(`SELECT id, name, owners FROM ${CATALOGUE_TABLES[kind]} WHERE id = ?`, id);
}
const resource = ownedResource;

function access(kind: OwnedKind, r: ResourceRow, u: AuthUser | null): { permissions: string[]; reasons: AccessReason[] } {
  if (kind === 'process') return processAccess(u, { id: r.id, owner: r.owner ?? null, acl: parseJson(r.acl, []) });
  if (kind === 'platform') return platformAccess(u, { id: r.id, acl: parseJson(r.acl, []) });
  if (kind === 'record') {
    // access change entries are read more narrowly (records/access.ts)
    if (!canReadRecordRow(u, { id: r.id, owner: r.owner ?? '', type_id: r.type_id ?? '', fields: r.fields ?? '{}' })) return { permissions: [], reasons: [] };
    const d = recordAccess(u, { id: r.id, owner: r.owner ?? '' });
    return { permissions: (['view', 'edit', 'approve'] as const).filter((p) => d[p]), reasons: d.reasons };
  }
  if (kind === 'credential') return credentialAccess(u, { id: r.id, owner_subjects: r.owner_subjects ?? '[]', archived: r.archived ?? 0 });
  if (kind === 'monitor') return monitorAccess(u, { id: r.id, owner: r.owner ?? '', acl: parseJson(r.acl, []) });
  if (kind === 'dashboard') return dashboardAccess(u, { id: r.id, owner: r.owner ?? null });
  if (kind === 'ticket') return ticketAccess(u, { id: r.id, responsible: r.responsible ?? '[]' });
  if (!isCatalogue(kind)) return { permissions: [], reasons: [] };
  const d = catalogueAccess(u, { kind, id: r.id, owners: parseJson<string[]>(r.owners, []) });
  return { permissions: [...(d.view ? ['view'] : []), ...(d.edit ? ['edit'] : [])], reasons: d.reasons };
}

const NOT_FOUND: Record<OwnedKind, [string, string]> = {
  process: ['Process not found', 'PROCESS_NOT_FOUND'],
  platform: ['Platform not found', 'PLATFORM_NOT_FOUND'],
  service: ['Service not found', 'SERVICE_NOT_FOUND'],
  application: ['Application not found', 'APPLICATION_NOT_FOUND'],
  system: ['System not found', 'SYSTEM_NOT_FOUND'],
  record: ['Record not found', 'RECORD_NOT_FOUND'],
  credential: ['Credential not found', 'CREDENTIAL_NOT_FOUND'],
  monitor: ['Monitor not found', 'MONITOR_NOT_FOUND'],
  dashboard: ['Dashboard not found', 'DASHBOARD_NOT_FOUND'],
  ticket: ['Ticket reference not found', 'TICKET_NOT_FOUND'],
};
const notFound = (kind: OwnedKind, id: string) => new HttpError(404, NOT_FOUND[kind][0], NOT_FOUND[kind][1], { id });

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
  const before = new Set(owningTeams(kind.data, ownedResource(kind.data, String(p.id ?? ''))?.id ?? '').map((t) => t.id));
  return b.data.teamIds.some((t) => !before.has(t));
}

export async function scopeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/owning-teams/:kind/:id', async (req) => {
    const { kind, id } = params(req);
    const r = visible(kind, id);
    return { teams: owningTeams(kind, r.id), canChange: isAdmin(me()) };
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
      const before = owningTeams(kind, r.id);
      db().tx(() => {
        setOwningTeams(kind, r.id, ids);
        const names = ids.map((t) => known.get(t)!);
        audit({
          action: 'access.owning_teams_changed',
          entityType: kind,
          entityId: r.id,
          summary: `Owning teams of ${kind} "${r.name}": ${names.length ? names.join(', ') : 'none (the whole instance)'}${before.length ? ` (were: ${before.map((t) => t.name).join(', ')})` : ''}`,
          details: { before: before.map((t) => t.name), after: names },
        });
      });
      return { teams: owningTeams(kind, r.id), canChange: true };
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
    const teams = isCatalogue(q.kind) ? catalogueTeams(q.kind, r.id) : owningTeams(q.kind, r.id);
    return { kind: q.kind, id: r.id, user: who.username, owningTeams: teams, permissions: d.permissions, reasons: d.reasons };
  });
}
