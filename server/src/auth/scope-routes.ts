import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  OWNED_KINDS,
  PLANT_SHARE_KINDS,
  SUPPLIER_CONTACT_CHOICES,
  boundedRecord,
  moduleOfItemKind,
  type AccessExplanation,
  type AccessReason,
  type AclEntry,
  type OwnedKind,
  type PlatformPermission,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { HttpError, parseJson } from '../util.js';
import { canCreateRecords, canCreateServices, canReadRecordRow } from '../records/access.js';
import { canCreateCredentials, credentialAccess } from '../credentials/service.js';
import { monitorAccess } from '../monitors/model.js';
import { dashboardAccess } from '../dashboards/service.js';
import { canCreateTickets, ticketAccess } from '../tickets/service.js';
import { siteAccess } from '../plant/access.js';
import { plantEnabled } from '../plant/settings.js';
import { catalogueEntryAccess } from '../plant/catalogue-access.js';
import { moduleUseOf } from '../modules/access.js';
import { ACCESS, me } from './access.js';
import { capabilities, isAdmin } from './permissions.js';
import {
  SHARED_CATALOGUE_KINDS,
  catalogueAccess,
  catalogueTeams,
  contractAccess,
  identityAccess,
  newResourceTeams,
  owningTeams,
  plantOnly,
  platformAccess,
  processAccess,
  recordAccess,
  setOwningTeams,
  withOwningTeams,
  type CatalogueKind,
  type OwningTeam,
} from './policy.js';
import { findUserByName, listUsers, toAuthUser } from './users.js';
import { protectOpening } from '../suppliers/shared.js';
import { canManageSuppliers, contractPlatformNamesOutsiders, contractScopeTeams } from '../suppliers/service.js';
import { uncoveredSubjects } from './named-grants.js';
import { isRestricted } from './share-store.js';
import type { AuthUser } from './context.js';
import { bookRights, bookRow } from '../costs/price-books.js';
import { calculatorRights } from '../costs/calculators.js';

/**
 * Owning teams of resources and why someone has access (#131).
 *   GET  /api/owning-teams/:kind/:id          the owning teams (whoever can see the resource)
 *   PUT  /api/owning-teams/:kind/:id          set them (administrators; adding a team is confirmed with a step-up)
 *   GET  /api/access/explain?kind&id&user     the rights of a user and where they come from (administrators and
 *                                             auditors for anyone, everybody for themselves)
 *   POST /api/access/named-outside            which named users and teams are outside an item's owning teams (#195)
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

const CATALOGUE_TABLES = { service: 'services', application: 'applications', system: 'systems', supplier: 'suppliers' } as const;
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
  // plant registry sites (#218): only while the module is on
  if (kind === 'site') return plantEnabled() ? db().get<ResourceRow>('SELECT id, name, acl FROM plant_sites WHERE id = ?', id) : undefined;
  // data contracts (#221)
  if (kind === 'contract') return db().get<ResourceRow>('SELECT id, name FROM data_contracts WHERE id = ?', id);
  // platform identities (0.13.0, ADR 0009): name and access list; the platform decides who sees them
  if (kind === 'platform_identity')
    return db().get<ResourceRow & { platform_id?: string }>('SELECT id, name, acl, platform_id FROM platform_identities WHERE id = ?', id);
  // price books and calculators (0.21.0, ADR 0035): their own rules (costs/price-books.ts, costs/calculators.ts)
  if (kind === 'cost_price_book') return db().get<ResourceRow>('SELECT id, name FROM cost_price_books WHERE id = ?', id);
  if (kind === 'cost_calculator') return db().get<ResourceRow>('SELECT id, name FROM cost_calculators WHERE id = ?', id);
  // the plant catalogues (0.21.0, #293): only while the module is on
  if (kind === 'device_profile') return plantEnabled() ? db().get<ResourceRow>('SELECT id, name FROM plant_profiles WHERE id = ?', id) : undefined;
  if (kind === 'kpi_definition') return plantEnabled() ? db().get<ResourceRow>('SELECT id, name FROM plant_kpis WHERE id = ?', id) : undefined;
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
  if (kind === 'site') return siteAccess(u, { id: r.id, acl: r.acl ?? '[]' });
  if (kind === 'contract') return contractAccess(u, { id: r.id });
  if (kind === 'platform_identity') {
    // who sees the platform sees its identities (ADR 0009); `use` as identityAccess decides it
    const pid = (r as ResourceRow & { platform_id?: string }).platform_id ?? '';
    const p = db().get<{ id: string; acl: string }>('SELECT id, acl FROM platforms WHERE id = ?', pid);
    if (!p) return { permissions: [], reasons: [] };
    const platform = { id: p.id, acl: parseJson<AclEntry<PlatformPermission>[]>(p.acl, []) };
    const seen = platformAccess(u, platform);
    if (!seen.permissions.length) return { permissions: [], reasons: [] };
    const isDefault = !!db().get('SELECT 1 FROM platform_identities WHERE id = ? AND is_default = 1', r.id);
    const d = identityAccess(u, platform, { id: r.id, default: isDefault, acl: parseJson(r.acl, []) });
    return d.permissions.length ? d : { permissions: ['view'], reasons: seen.reasons };
  }
  if (kind === 'cost_price_book') {
    const row = bookRow(r.id);
    const b = row ? bookRights(row, u) : { view: false, edit: false, manage: false };
    return { permissions: [...(b.view ? ['view'] : []), ...(b.edit ? ['edit'] : []), ...(b.manage ? ['manage'] : [])], reasons: [] };
  }
  if (kind === 'cost_calculator') {
    const c = calculatorRights({ id: r.id }, u);
    return { permissions: [...(c.view ? ['view'] : []), ...(c.edit ? ['edit'] : [])], reasons: [] };
  }
  if (kind === 'device_profile' || kind === 'kpi_definition') return catalogueEntryAccess(u, kind, r.id);
  if (!isCatalogue(kind)) return { permissions: [], reasons: [] };
  const d = catalogueAccess(u, { kind, id: r.id, owners: parseJson<string[]>(r.owners, []) });
  // Manage (its shares, owners from outside) on the kinds switched to shares (ADR 0033)
  const manage = d.manage && SHARED_CATALOGUE_KINDS.has(kind);
  return { permissions: [...(d.view ? ['view'] : []), ...(d.edit ? ['edit'] : []), ...(manage ? ['manage'] : [])], reasons: d.reasons };
}

/** Whether `u` may see a resource of any kind that can have owning teams (the held messages re-check this at release). */
export function canSeeResource(kind: OwnedKind, id: string, u: AuthUser | null): boolean {
  const r = resource(kind, id);
  return !!r && access(kind, r, u).permissions.length > 0;
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
  site: ['Site not found', 'PLANT_SITE_NOT_FOUND'],
  contract: ['Data contract not found', 'DATA_CONTRACT_NOT_FOUND'],
  platform_identity: ['Identity not found', 'IDENTITY_NOT_FOUND'],
  supplier: ['Supplier not found', 'SUPPLIER_NOT_FOUND'],
  cost_price_book: ['Price book not found', 'COST_PRICE_BOOK_NOT_FOUND'],
  cost_calculator: ['Calculator not found', 'COST_CALCULATOR_NOT_FOUND'],
  device_profile: ['Device profile not found', 'PLANT_PROFILE_NOT_FOUND'],
  kpi_definition: ['KPI definition not found', 'PLANT_KPI_NOT_FOUND'],
};
const notFound = (kind: OwnedKind, id: string) => new HttpError(404, NOT_FOUND[kind][0], NOT_FOUND[kind][1], { id });
/** 404 for an item of a kind, like one that does not exist (the Access tab's routes, auth/share-routes.ts). */
export const resourceNotFound = notFound;

/** The resource, if the caller may see it (404 otherwise, like one that does not exist). */
function visible(kind: OwnedKind, id: string): ResourceRow {
  const r = resource(kind, id);
  if (!r || !access(kind, r, me()).permissions.length) throw notFound(kind, id);
  return r;
}

const teamIds = z.object({ teamIds: z.array(z.string().max(64)).max(50) });
/** POST /access/named-outside (#195): an item (or a supplier's contract) and the users and teams a form names */
const namedOutsideInput = z.object({
  kind: z.union([kindParam, z.literal('supplierContract')]),
  id: z.string().max(100).optional(),
  supplierId: z.string().max(64).optional(),
  subjects: z.array(z.string().max(200)).max(50),
  /** A platform to be added to the contract (`supplierContract` with `id`): who it gives the contract to from outside its teams (0.19.0) */
  platformId: z.string().max(64).optional(),
});
/** A supplier's company-wide contacts that cannot be scoped when it is opened: the administrator's choice (ADR 0031) */
const supplierContactChoices = z.object({ contacts: boundedRecord(z.enum(SUPPLIER_CONTACT_CHOICES), 100).optional() });

/**
 * Whether new owning teams grant access: adding a team gives its members their roles on the resource, and removing
 * every team opens it to the whole instance (security review 0.18.0, M4/M5). Confirmed like other grants (step-up
 * `grantAccess`, the baseline control point access.grant).
 */
export function teamsGrantAccess(kind: OwnedKind, id: string, after: readonly string[]): boolean {
  const before = owningTeams(kind, ownedResource(kind, id)?.id ?? '').map((t) => t.id);
  return after.some((t) => !before.includes(t)) || (before.length > 0 && after.length === 0);
}

/** PUT /owning-teams/:kind/:id: the change grants access (teamsGrantAccess). */
function addsTeam(req: FastifyRequest): boolean {
  const p = req.params as { kind?: string; id?: string };
  const kind = kindParam.safeParse(p.kind);
  const b = teamIds.safeParse(req.body);
  if (!kind.success || !b.success) return false;
  return teamsGrantAccess(kind.data, String(p.id ?? ''), b.data.teamIds);
}

const bulkInput = z.object({
  teamIds: z.array(z.string().max(64)).max(50),
  /** set: exactly these teams; add / remove: these teams beside the ones there are */
  mode: z.enum(['set', 'add', 'remove']).default('set'),
  resources: z
    .array(z.object({ kind: kindParam, id: z.string().max(100) }))
    .max(500)
    .default([]),
  /** all resources of a service: the service, its applications, linked records and ticket references, credentials belonging to them */
  service: z.string().max(64).optional(),
  preview: z.boolean().default(false),
});
type BulkInput = z.infer<typeof bulkInput>;

/** The resources a bulk change covers (de-duplicated; unknown ones left out). */
function bulkResources(b: BulkInput): { kind: OwnedKind; r: ResourceRow }[] {
  const refs: { kind: OwnedKind; id: string }[] = [...b.resources];
  if (b.service) {
    const s = ownedResource('service', b.service);
    if (!s) throw notFound('service', b.service);
    refs.push({ kind: 'service', id: s.id });
    const apps = db()
      .all<{ id: string }>('SELECT application_id AS id FROM service_applications WHERE service_id = ?', s.id)
      .map((x) => x.id);
    for (const a of apps) refs.push({ kind: 'application', id: a });
    for (const [kind, id] of [['service', s.id], ...apps.map((a) => ['application', a])] as [string, string][]) {
      for (const x of db().all<{ id: string }>(
        `SELECT from_id AS id FROM item_links WHERE from_kind = 'record' AND to_kind = ? AND to_id = ?
         UNION SELECT to_id AS id FROM item_links WHERE from_kind = ? AND from_id = ? AND to_kind = 'record'`,
        kind,
        id,
        kind,
        id,
      ))
        refs.push({ kind: 'record', id: x.id });
      for (const x of db().all<{ id: string }>("SELECT from_id AS id FROM item_links WHERE from_kind = 'ticket' AND to_kind = ? AND to_id = ?", kind, id))
        refs.push({ kind: 'ticket', id: x.id });
      for (const x of db().all<{ id: string }>('SELECT id FROM credentials WHERE belongs_kind = ? AND belongs_id = ?', kind, id))
        refs.push({ kind: 'credential', id: x.id });
    }
  }
  const seen = new Set<string>();
  const out: { kind: OwnedKind; r: ResourceRow }[] = [];
  for (const ref of refs) {
    const r = ownedResource(ref.kind, ref.id);
    if (!r || seen.has(`${ref.kind}:${r.id}`)) continue;
    seen.add(`${ref.kind}:${r.id}`);
    out.push({ kind: ref.kind, r });
  }
  return out;
}

/** The team ids a resource has after a bulk change. */
function nextTeamIds(before: readonly string[], b: BulkInput): string[] {
  if (b.mode === 'set') return [...new Set(b.teamIds)];
  if (b.mode === 'add') return [...new Set([...before, ...b.teamIds])];
  return before.filter((t) => !b.teamIds.includes(t));
}

function nextTeams(before: OwningTeam[], b: BulkInput, known: Map<string, string>): OwningTeam[] {
  const wanted = b.teamIds.map((id) => ({ id, name: known.get(id)! }));
  const list =
    b.mode === 'set'
      ? wanted
      : b.mode === 'add'
        ? [...before, ...wanted.filter((w) => !before.some((t) => t.id === w.id))]
        : before.filter((t) => !b.teamIds.includes(t.id));
  return list.sort((a, b2) => a.name.localeCompare(b2.name));
}

export async function scopeRoutes(app: FastifyInstance): Promise<void> {
  // a plant viewer (#218) sees the owning teams of the plant registry's kinds only (sites, device profiles, KPI definitions)
  app.get('/owning-teams/:kind/:id', { config: { access: ACCESS.plantViewer } }, async (req) => {
    const { kind, id } = params(req);
    if (!PLANT_SHARE_KINDS.includes(kind) && plantOnly(me())) throw notFound(kind, id);
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
        // opening a team-scoped supplier protects its contracts and contacts (ADR 0031 part 8; suppliers/shared.ts)
        const protectedWhat = kind === 'supplier' ? protectOpening(r.id, ids, supplierContactChoices.parse(req.body).contacts ?? {}) : null;
        setOwningTeams(kind, r.id, ids);
        const names = ids.map((t) => known.get(t)!);
        audit({
          action: 'access.owning_teams_changed',
          entityType: kind,
          entityId: r.id,
          summary: `Owning teams of ${kind} "${r.name}": ${names.length ? names.join(', ') : 'none (the whole instance)'}${before.length ? ` (were: ${before.map((t) => t.name).join(', ')})` : ''}`,
          details: { before: before.map((t) => t.name), after: names, ...(protectedWhat ? { protected: protectedWhat } : {}) },
        });
      });
      return { teams: owningTeams(kind, r.id), canChange: true };
    },
  );

  /**
   * Owning teams for many resources at once (#131), e.g. all resources of a service. With preview: who would gain or
   * lose visibility, nothing changed. Every change is audited per resource.
   */
  app.post(
    '/owning-teams/bulk',
    {
      config: {
        access: ACCESS.admin,
        stepUp: {
          action: 'grantAccess',
          who: 'manageUsers',
          when: (req: FastifyRequest) => {
            const b = bulkInput.safeParse(req.body);
            if (!b.success) return true;
            if (b.data.preview) return false;
            if (b.data.mode !== 'remove' && b.data.teamIds.length > 0) return true;
            // removing teams: a resource left without any is opened to the whole instance (security review 0.18.0, M4)
            return bulkResources(b.data).some(({ kind, r }) => {
              const before = owningTeams(kind, r.id).map((t) => t.id);
              return before.length > 0 && !nextTeamIds(before, b.data).length;
            });
          },
        },
      },
    },
    async (req) => {
      const b = bulkInput.parse(req.body);
      const known = new Map(
        db()
          .all<{ id: string; name: string }>('SELECT id, name FROM teams')
          .map((t) => [t.id, t.name]),
      );
      const unknown = b.teamIds.find((t) => !known.has(t));
      if (unknown) throw new HttpError(400, `Unknown team "${unknown}"`, 'TEAM_NOT_FOUND', { id: unknown });
      const items = bulkResources(b).map(({ kind, r }) => {
        const before = owningTeams(kind, r.id);
        return { kind, r, before, after: nextTeams(before, b, known) };
      });
      const changed = items.filter((x) => x.before.map((t) => t.id).join() !== x.after.map((t) => t.id).join());
      // who sees each resource now and afterwards (active users)
      const users = listUsers()
        .filter((u) => u.active)
        .map((u) => toAuthUser(u));
      const seers = (kind: OwnedKind, r: ResourceRow) => new Set(users.filter((u) => access(kind, r, u).permissions.length > 0).map((u) => u.username));
      const now = changed.map((x) => seers(x.kind, x.r));
      const later = withOwningTeams(
        (index) => {
          for (const x of changed) index.set(`${x.kind}:${x.r.id}`, x.after);
        },
        () => changed.map((x) => seers(x.kind, x.r)),
      );
      const resources = items.map((x) => {
        const i = changed.indexOf(x);
        const gains = i < 0 ? [] : [...later[i]!].filter((n) => !now[i]!.has(n)).sort();
        const loses = i < 0 ? [] : [...now[i]!].filter((n) => !later[i]!.has(n)).sort();
        return {
          kind: x.kind,
          id: x.r.id,
          name: x.r.name,
          before: x.before.map((t) => t.name),
          after: x.after.map((t) => t.name),
          changed: i >= 0,
          gains,
          loses,
        };
      });
      if (!b.preview && changed.length) {
        db().tx(() => {
          for (const x of changed) {
            // a supplier gets the same protections as through its own panel (ADR 0031 part 8; security review 0.18.0,
            // M4): its contracts and contacts stay with who saw them. A contact that needs the administrator's choice
            // (SUPPLIER_MERGE_CONTACT_CHOICE) stops the whole change – the supplier's own panel asks for it
            const protectedWhat =
              x.kind === 'supplier'
                ? protectOpening(
                    x.r.id,
                    x.after.map((t) => t.id),
                  )
                : null;
            setOwningTeams(
              x.kind,
              x.r.id,
              x.after.map((t) => t.id),
            );
            const names = x.after.map((t) => t.name);
            audit({
              action: 'access.owning_teams_changed',
              entityType: x.kind,
              entityId: x.r.id,
              summary: `Owning teams of ${x.kind} "${x.r.name}": ${names.length ? names.join(', ') : 'none (the whole instance)'}${x.before.length ? ` (were: ${x.before.map((t) => t.name).join(', ')})` : ''} – bulk change`,
              details: { before: x.before.map((t) => t.name), after: names, bulk: true, ...(protectedWhat ? { protected: protectedWhat } : {}) },
            });
          }
        });
      }
      return { applied: !b.preview && changed.length > 0, changed: changed.length, resources };
    },
  );

  /** Who may create a new item of a kind whose form names owners or responsibles (#195): as its create route. */
  const createsNamed = (kind: string, u: AuthUser): boolean => {
    if (kind === 'credential') return canCreateCredentials(u);
    if (kind === 'ticket') return canCreateTickets(u);
    if (kind === 'record') return canCreateRecords(u);
    if (kind === 'supplier') return canManageSuppliers(u);
    if (kind === 'service' || kind === 'application' || kind === 'system') return canCreateServices(u);
    return false;
  };

  /**
   * Which of these users and teams are outside the owning teams of an item (#195): the forms say so before saving
   * ("… is not in the owning teams and will see and change this item"); saving them asks for the step-up. Without `id`:
   * a new item, with the teams its creator's new resources get – for who may create one (L6). For whoever may change the item.
   */
  app.post('/access/named-outside', async (req): Promise<{ teams: string[]; outside: string[] }> => {
    const b = namedOutsideInput.parse(req.body);
    const u = me();
    let teams: OwningTeam[];
    if (b.kind === 'supplierContract' && b.id && b.platformId) {
      // covering a platform (security review 0.19.0 M1): its grantees from outside the contract's teams
      teams = contractScopeTeams(b.supplierId ?? '', b.id);
      return { teams: teams.map((t) => t.name), outside: contractPlatformNamesOutsiders(b.supplierId ?? '', b.id, b.platformId) };
    }
    if (b.kind === 'supplierContract') teams = contractScopeTeams(b.supplierId ?? '', b.id ?? null);
    else if (!b.id) {
      // a new item: for who may create one of that kind, as its form's route would (security review 0.19.0 L6)
      if (!createsNamed(b.kind, u)) throw new HttpError(403, 'You are not allowed to create this kind of item', 'FORBIDDEN');
      teams = b.kind === 'supplier' ? [] : newResourceTeams(u).teams;
    } else {
      const r = visible(b.kind, b.id);
      // the rights beyond seeing it: only who may change the item learns who is in its owning teams
      if (!access(b.kind, r, u).permissions.some((p) => p !== 'view')) throw notFound(b.kind, b.id);
      teams = isCatalogue(b.kind) ? catalogueTeams(b.kind, r.id) : owningTeams(b.kind, r.id);
      // a Restricted item (ADR 0033): every subject named is from outside
      if (isCatalogue(b.kind) && SHARED_CATALOGUE_KINDS.has(b.kind) && !teams.length && isRestricted(b.kind, r.id))
        return { teams: [], outside: uncoveredSubjects([], [], b.subjects, true) };
    }
    return { teams: teams.map((t) => t.name), outside: uncoveredSubjects(teams, [], b.subjects) };
  });

  // plant viewers ask about the plant registry's kinds only (the Access tab of a device profile, ADR 0033)
  app.get('/access/explain', { config: { access: ACCESS.plantViewer } }, async (req): Promise<AccessExplanation> => {
    const q = z.object({ kind: kindParam, id: z.string().max(100), user: z.string().max(64).optional() }).parse(req.query);
    const caller = me();
    if (!PLANT_SHARE_KINDS.includes(q.kind) && plantOnly(caller)) throw notFound(q.kind, q.id);
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
    // an item of a module (a site, a data contract): the module layer first (ADR 0034) – without it, no rights at all
    const mod = moduleOfItemKind(q.kind);
    const module = mod ? moduleUseOf(who, mod) : undefined;
    const permissions = module && !module.uses ? [] : d.permissions;
    return { kind: q.kind, id: r.id, user: who.username, owningTeams: teams, permissions, reasons: d.reasons, ...(module ? { module } : {}) };
  });
}
