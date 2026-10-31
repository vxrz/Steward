import { z } from 'zod';
import {
  APPLICATION_ROLES,
  CIA_DIMENSIONS,
  SERVICE_CRITICALITIES,
  tagInput,
  type AclEntry,
  type ApplicationDetail,
  type ApplicationIntegration,
  type ApplicationRole,
  type ApplicationServiceRef,
  type ApplicationSummary,
  type CiaDimension,
  type DocumentApplicationRef,
  type PlatformPermission,
  type ServiceApplication,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentUser, type AuthUser } from '../auth/context.js';
import { platformPermissions } from '../auth/permissions.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { canCreateServices, canEditService, forbid, me, canViewCatalogue } from '../records/access.js';
import { addLink, httpUrl, listBacklinks, listLinks, removeLink, updateLink, type LinkInput, type LinkUpdate } from '../records/links.js';
import { requireEditable, touch } from '../records/service.js';
import {
  auditNeedChanges,
  checkLevel,
  currentScale,
  emptyRating,
  levelLabel,
  protectionNeedOf,
  protectionNeeds,
  ratingsOf,
  requireValidScale,
  type OverrideInput,
  type RatingInput,
} from './cia.js';
import { documentCounts, readableDocuments } from './documents.js';
import { scopeOf } from './scope.js';
import { componentCounts, componentsOf, stackRollup } from './components.js';
import { systemCounts, systemLinksOf } from './systems.js';
import { credentialsBelongingTo, credentialsLinkingTo, toCredential, type CredentialRow } from '../credentials/service.js';
import { assertKnownSubjects } from '../auth/subjects.js';

/**
 * Applications of the service catalogue (#84): name, description, vendor, version, URL, owners, criticality, tags,
 * CMDB entry, links; the Steward platforms mapped to them (integrations – a platform belongs to at most one
 * application), the services that consist of them (with a role), their CIA rating, and the living documents that
 * apply to them. Like services: everyone who can sign in reads them; designers, administrators and the owners
 * (user:/team:) change them; they are archived, never deleted.
 */

interface ApplicationRow {
  id: string;
  name: string;
  description: string;
  vendor: string;
  version: string;
  url: string;
  owners: string;
  criticality: string | null;
  cmdb_system: string | null;
  cmdb_id: string | null;
  cmdb_url: string | null;
  tags: string;
  archived: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

export const APPLICATION_LIMITS = { name: 160, description: 64 * 1024, vendor: 120, version: 60, roleText: 80, scope: 50 } as const;

const ownerSubject = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(user|team):[^\s].{0,119}$/, 'Use user:<name> or team:<name>');

export const applicationInput = z
  .object({
    name: z.string().trim().min(1).max(APPLICATION_LIMITS.name),
    description: z.string().max(APPLICATION_LIMITS.description).default(''),
    vendor: z.string().trim().max(APPLICATION_LIMITS.vendor).default(''),
    version: z.string().trim().max(APPLICATION_LIMITS.version).default(''),
    url: z.union([httpUrl, z.literal('')]).default(''),
    owners: z.array(ownerSubject).max(20).default([]),
    criticality: z.enum(SERVICE_CRITICALITIES).nullable().default(null),
    cmdb: z
      .object({ system: z.string().trim().max(80).default(''), id: z.string().trim().max(120).default(''), url: z.union([httpUrl, z.literal('')]).default('') })
      .strict()
      .nullable()
      .default(null),
    tags: z
      .array(tagInput({ lower: true }))
      .max(30)
      .default([]),
  })
  .strict();
export type ApplicationInput = z.infer<typeof applicationInput>;

export const serviceApplicationInput = z
  .object({
    role: z.enum(APPLICATION_ROLES).nullable().default(null),
    roleText: z.string().trim().max(APPLICATION_LIMITS.roleText).default(''),
  })
  .strict();
export type ServiceApplicationInput = z.infer<typeof serviceApplicationInput>;

export const platformMappingInput = z.object({ platformId: z.string().trim().min(1).max(200) }).strict();

export const scopeInput = z.object({ applicationIds: z.array(z.string().trim().min(1).max(100)).max(APPLICATION_LIMITS.scope) }).strict();

// ---------- reading ----------

function row(id: string): ApplicationRow {
  const r = db().get<ApplicationRow>('SELECT * FROM applications WHERE id = ?', id);
  if (!r) throw new HttpError(404, `Application ${id} not found`, 'APPLICATION_NOT_FOUND', { id });
  // a team-owned item is unknown to those who may not see it (#131); jobs (no user) see everything
  const u = currentUser();
  if (u && !canViewCatalogue(u, { kind: 'application', id: r.id, owners: parseJson<string[]>(r.owners, []) }))
    throw new HttpError(404, `Application ${id} not found`, 'APPLICATION_NOT_FOUND', { id });
  return r;
}

const ownersOf = (r: Pick<ApplicationRow, 'owners'>) => parseJson<string[]>(r.owners, []);
export const canEditApplication = (u: AuthUser | null, r: Pick<ApplicationRow, 'id' | 'owners'>): boolean =>
  canEditService(u, { kind: 'application', id: r.id, owners: ownersOf(r) });

function requireEditableApplication(id: string, what: string): ApplicationRow {
  const r = row(id);
  if (!canEditApplication(currentUser(), r)) forbid(what, 'changeApplication');
  return r;
}

function cmdbOf(r: ApplicationRow): ApplicationSummary['cmdb'] {
  if (!r.cmdb_system && !r.cmdb_id && !r.cmdb_url) return null;
  return { system: r.cmdb_system ?? '', id: r.cmdb_id ?? '', url: r.cmdb_url ?? '' };
}

type PlatformRow = { id: string; name: string; kind: string; environment: string; acl: string };
const platformRights = (u: AuthUser | null, p: Pick<PlatformRow, 'id' | 'acl'>) =>
  platformPermissions(u, { id: p.id, acl: parseJson<AclEntry<PlatformPermission>[]>(p.acl, []) });
const platformVisible = (u: AuthUser | null, p: Pick<PlatformRow, 'id' | 'acl'>) => platformRights(u, p).length > 0;
/**
 * Mapping a platform to an application (or removing it) decides which application – and whose CIA rating – the
 * platform's evidence names: it needs the manage right on the platform (administrators have it everywhere), on top of
 * the right to edit the application.
 */
const platformManaged = (u: AuthUser | null, p: Pick<PlatformRow, 'id' | 'acl'>) => platformRights(u, p).includes('manage');

/** The platforms mapped to these applications, by application; platforms the user may not see are named only as not visible. */
export function integrationsOf(appIds: string[], u: AuthUser | null = currentUser()): Map<string, ApplicationIntegration[]> {
  const out = new Map<string, ApplicationIntegration[]>();
  if (!appIds.length) return out;
  const rows = db().all<{
    application_id: string;
    platform_id: string;
    created_at: string;
    created_by: string;
    name: string;
    kind: string;
    environment: string;
    acl: string;
  }>(
    `SELECT ap.application_id, ap.platform_id, ap.created_at, ap.created_by, p.name, p.kind, p.environment, p.acl
     FROM application_platforms ap JOIN platforms p ON p.id = ap.platform_id ORDER BY p.name`,
  );
  const wanted = new Set(appIds);
  for (const r of rows) {
    if (!wanted.has(r.application_id)) continue;
    const visible = platformVisible(u, { id: r.platform_id, acl: r.acl });
    const i: ApplicationIntegration = visible
      ? {
          visible,
          platformId: r.platform_id,
          name: r.name,
          kind: r.kind,
          environment: r.environment || null,
          path: `/platforms/${r.platform_id}`,
          mappedAt: r.created_at,
          mappedBy: r.created_by,
          canManage: platformManaged(u, { id: r.platform_id, acl: r.acl }),
        }
      : { visible, platformId: null, name: '', kind: null, environment: null, path: null, mappedAt: r.created_at, mappedBy: r.created_by, canManage: false };
    out.set(r.application_id, [...(out.get(r.application_id) ?? []), i]);
  }
  return out;
}

type MemberRow = { service_id: string; application_id: string; role: string | null; role_text: string; created_at: string; created_by: string };

function servicesOf(): Map<string, ApplicationServiceRef[]> {
  const out = new Map<string, ApplicationServiceRef[]>();
  for (const r of db().all<MemberRow & { name: string; archived: number }>(
    'SELECT sa.*, s.name, s.archived FROM service_applications sa JOIN services s ON s.id = sa.service_id ORDER BY s.name',
  )) {
    out.set(r.application_id, [
      ...(out.get(r.application_id) ?? []),
      { id: r.service_id, name: r.name, archived: !!r.archived, role: (r.role as ApplicationRole | null) ?? null, roleText: r.role_text },
    ]);
  }
  return out;
}

function scopedRecordIds(appId: string): string[] {
  return db()
    .all<{ id: string }>('SELECT record_id AS id FROM record_applications WHERE application_id = ?', appId)
    .map((r) => r.id);
}

function toSummary(
  r: ApplicationRow,
  x: {
    services: ApplicationServiceRef[];
    integrations: number;
    rating: ApplicationSummary['rating'];
    docs: { documents: number; overdue: number };
    components: number;
    systems: number;
  },
): ApplicationSummary {
  return {
    id: r.id,
    name: r.name,
    vendor: r.vendor,
    version: r.version,
    url: r.url,
    criticality: (r.criticality as ApplicationSummary['criticality']) ?? null,
    owners: ownersOf(r),
    tags: parseJson<string[]>(r.tags, []),
    cmdb: cmdbOf(r),
    archived: !!r.archived,
    services: x.services,
    integrationCount: x.integrations,
    rating: x.rating,
    documentCount: x.docs.documents,
    overdueDocuments: x.docs.overdue,
    componentCount: x.components,
    systemCount: x.systems,
    updatedAt: r.updated_at,
  };
}

/** An application with its description and creation (the public API's list). */
export type ApplicationEntry = ApplicationSummary & Pick<ApplicationDetail, 'description' | 'createdAt' | 'createdBy' | 'updatedBy'>;

export function listApplicationEntries(o: { archived?: boolean } = {}): ApplicationEntry[] {
  const u = me();
  const rows = db()
    .all<ApplicationRow>(`SELECT * FROM applications${o.archived ? '' : ' WHERE archived = 0'} ORDER BY name`)
    .filter((r) => canViewCatalogue(u, { kind: 'application', id: r.id, owners: parseJson<string[]>(r.owners, []) }));
  const services = servicesOf();
  const ratings = ratingsOf();
  const counts = new Map(
    db()
      .all<{ id: string; n: number }>('SELECT application_id AS id, COUNT(*) AS n FROM application_platforms GROUP BY application_id')
      .map((c) => [c.id, Number(c.n)]),
  );
  const docs = documentCounts(db().all<{ item: string; record: string }>('SELECT application_id AS item, record_id AS record FROM record_applications'), u);
  const components = componentCounts();
  const systems = systemCounts();
  return rows.map((r) => ({
    ...toSummary(r, {
      services: services.get(r.id) ?? [],
      integrations: counts.get(r.id) ?? 0,
      rating: ratings.get(r.id) ?? emptyRating(),
      docs: docs.get(r.id) ?? { documents: 0, overdue: 0 },
      components: components.get(r.id) ?? 0,
      systems: systems.get(r.id) ?? 0,
    }),
    description: r.description,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedBy: r.updated_by,
  }));
}

export function listApplications(o: { archived?: boolean } = {}): ApplicationSummary[] {
  return listApplicationEntries(o).map(({ description: _d, createdAt: _c, createdBy: _cb, updatedBy: _ub, ...s }) => s);
}

/** The living documents that apply to an application (404 for an unknown application). */
export function getApplicationDocuments(id: string) {
  const u = me();
  return readableDocuments(scopedRecordIds(row(id).id), u);
}

export function getApplication(id: string): ApplicationDetail {
  const u = me();
  const r = row(id);
  const integrations = integrationsOf([r.id], u).get(r.id) ?? [];
  const documents = readableDocuments(scopedRecordIds(r.id), u);
  const components = componentsOf(r.id);
  const systems = systemLinksOf(r.id);
  return {
    ...toSummary(r, {
      services: servicesOf().get(r.id) ?? [],
      integrations: integrations.length,
      rating: ratingsOf([r.id]).get(r.id) ?? emptyRating(),
      docs: { documents: documents.length, overdue: documents.filter((d) => d.reviewStatus === 'overdue').length },
      components: components.length,
      systems: systems.length,
    }),
    description: r.description,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedBy: r.updated_by,
    integrations,
    links: listLinks('application', r.id),
    backlinks: listBacklinks('application', r.id),
    documents,
    components,
    stack: stackRollup(components, systems),
    systems,
    credentials: applicationCredentials(r.id, components, u),
    canEdit: canEditApplication(u, r),
  };
}

/**
 * The credentials of an application: entries that belong to it or to one of its components (#143), then entries that
 * name it under "used by" (#125); each once, archived ones left out.
 */
function applicationCredentials(appId: string, components: { id: string; name: string }[], u: AuthUser): ApplicationDetail['credentials'] {
  const compName = new Map(components.map((c) => [c.id, c.name]));
  const rows: { r: CredentialRow; relation: 'belongsTo' | 'usedBy' }[] = [
    ...credentialsBelongingTo('application', [appId]).map((r) => ({ r, relation: 'belongsTo' as const })),
    ...credentialsBelongingTo('component', [...compName.keys()]).map((r) => ({ r, relation: 'belongsTo' as const })),
    ...credentialsLinkingTo('application', appId).map((r) => ({ r, relation: 'usedBy' as const })),
  ];
  const seen = new Set<string>();
  return rows
    .filter(({ r }) => !r.archived && (seen.has(r.id) ? false : (seen.add(r.id), true)))
    .map(({ r, relation }) => {
      const c = toCredential(r, u);
      return {
        id: c.id,
        name: c.name,
        type: c.type,
        status: c.status,
        nextDueAt: c.nextDueAt,
        roles: c.roles.map((x) => x.role),
        relation,
        componentName: relation === 'belongsTo' && r.belongs_kind === 'component' ? (compName.get(r.belongs_id ?? '') ?? null) : null,
      };
    });
}

/** The application a platform belongs to, or null (the platform page; the caller checked that the user may see the platform). */
export function applicationOfPlatform(platformId: string): { id: string; name: string; archived: boolean } | null {
  me();
  const a = db().get<{ id: string; name: string; archived: number }>(
    'SELECT a.id, a.name, a.archived FROM application_platforms ap JOIN applications a ON a.id = ap.application_id WHERE ap.platform_id = ?',
    platformId,
  );
  return a ? { id: a.id, name: a.name, archived: !!a.archived } : null;
}

// ---------- changing ----------

const dedupe = <T>(xs: T[]) => [...new Set(xs)];

function columns(input: ApplicationInput) {
  return {
    name: input.name,
    description: input.description,
    vendor: input.vendor,
    version: input.version,
    url: input.url,
    owners: JSON.stringify(dedupe(input.owners)),
    criticality: input.criticality,
    cmdb_system: input.cmdb?.system || null,
    cmdb_id: input.cmdb?.id || null,
    cmdb_url: input.cmdb?.url || null,
    tags: JSON.stringify(dedupe(input.tags).sort()),
  };
}

function nameTaken(name: string, except = ''): boolean {
  return !!db().get('SELECT 1 FROM applications WHERE lower(name) = lower(?) AND archived = 0 AND id <> ?', name, except);
}

export function createApplication(input: ApplicationInput): ApplicationDetail {
  const u = me();
  if (!canCreateServices(u)) forbid('create applications', 'createApplications');
  if (nameTaken(input.name)) throw new HttpError(409, `An application named "${input.name}" exists already`, 'APPLICATION_EXISTS', { name: input.name });
  assertKnownSubjects(input.owners);
  const id = newId('app_');
  const now = nowIso();
  const c = columns(input);
  db().tx(() => {
    db().run(
      `INSERT INTO applications (id, name, description, vendor, version, url, owners, criticality, cmdb_system, cmdb_id, cmdb_url, tags, archived, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      id,
      c.name,
      c.description,
      c.vendor,
      c.version,
      c.url,
      c.owners,
      c.criticality,
      c.cmdb_system,
      c.cmdb_id,
      c.cmdb_url,
      c.tags,
      now,
      u.username,
      now,
      u.username,
    );
    audit({
      action: 'application.created',
      entityType: 'application',
      entityId: id,
      summary: `Application "${input.name}" created`,
      details: { vendor: input.vendor, criticality: input.criticality, owners: dedupe(input.owners), cmdb: input.cmdb },
    });
  });
  return getApplication(id);
}

export function updateApplication(id: string, input: ApplicationInput): ApplicationDetail {
  const u = me();
  const cur = requireEditableApplication(id, 'change this application');
  if (nameTaken(input.name, id)) throw new HttpError(409, `An application named "${input.name}" exists already`, 'APPLICATION_EXISTS', { name: input.name });
  assertKnownSubjects(input.owners, ownersOf(cur));
  const next = columns(input);
  const changes = (Object.keys(next) as (keyof typeof next)[]).filter((k) => (next[k] ?? null) !== (cur[k] ?? null));
  if (!changes.length) return getApplication(id);
  db().tx(() => {
    db().run(
      'UPDATE applications SET name = ?, description = ?, vendor = ?, version = ?, url = ?, owners = ?, criticality = ?, cmdb_system = ?, cmdb_id = ?, cmdb_url = ?, tags = ?, updated_at = ?, updated_by = ? WHERE id = ?',
      next.name,
      next.description,
      next.vendor,
      next.version,
      next.url,
      next.owners,
      next.criticality,
      next.cmdb_system,
      next.cmdb_id,
      next.cmdb_url,
      next.tags,
      nowIso(),
      u.username,
      id,
    );
    audit({
      action: 'application.updated',
      entityType: 'application',
      entityId: id,
      summary: `Application "${input.name}" changed (${changes.join(', ')})`,
      details: { changes, ...(changes.includes('owners') ? { owners: { old: ownersOf(cur), new: dedupe(input.owners) } } : {}) },
    });
  });
  return getApplication(id);
}

/** The services an application is part of (their protection need depends on it). */
const servicesWith = (appId: string) =>
  db()
    .all<{ service_id: string }>('SELECT service_id FROM service_applications WHERE application_id = ?', appId)
    .map((r) => r.service_id);

export function setApplicationArchived(id: string, archived: boolean): ApplicationDetail {
  const u = me();
  const cur = requireEditableApplication(id, 'archive this application');
  if (!!cur.archived === archived) return getApplication(id);
  if (!archived && nameTaken(cur.name, id))
    throw new HttpError(409, `An application named "${cur.name}" exists already – rename one of them first`, 'APPLICATION_EXISTS', { name: cur.name });
  const needs = protectionNeeds(servicesWith(id));
  const scale = currentScale();
  db().tx(() => {
    db().run('UPDATE applications SET archived = ?, updated_at = ?, updated_by = ? WHERE id = ?', archived ? 1 : 0, nowIso(), u.username, id);
    audit({
      action: archived ? 'application.archived' : 'application.restored',
      entityType: 'application',
      entityId: id,
      summary: `Application "${cur.name}" ${archived ? 'archived' : 'restored'}`,
    });
    // services that no longer (or again) count this application: their own history says so
    auditNeedChanges(needs, scale, { kind: 'application', what: `${archived ? 'archiving' : 'restoring'} application "${cur.name}"`, applicationId: id });
  });
  return getApplication(id);
}

const touchApplication = (id: string, u: AuthUser) => db().run('UPDATE applications SET updated_at = ?, updated_by = ? WHERE id = ?', nowIso(), u.username, id);

/**
 * Sets, changes or removes the rating of dimensions (missing: unchanged; null: removed). Each dimension stores who
 * rated it and when; re-rating clears a "needs re-rating" flag of a scale change. Audited with old and new levels.
 */
export function rateApplication(id: string, input: RatingInput): ApplicationDetail {
  const u = me();
  const cur = requireEditableApplication(id, 'rate this application');
  const scale = currentScale();
  requireValidScale(scale);
  const before = ratingsOf([id]).get(id) ?? emptyRating();
  const changes: { dimension: CiaDimension; from: string | null; to: string | null; justification?: string }[] = [];
  for (const d of CIA_DIMENSIONS) {
    const v = input[d];
    if (v === undefined) continue;
    const old = before[d];
    if (v === null) {
      if (old) changes.push({ dimension: d, from: old.level, to: null });
      continue;
    }
    checkLevel(d, v.level, scale);
    if (old && old.level === v.level && old.justification === v.justification && !old.needsRerating && !old.previousLabel) continue;
    changes.push({ dimension: d, from: old?.level ?? null, to: v.level, justification: v.justification });
  }
  if (!changes.length) return getApplication(id);
  const now = nowIso();
  const needs = protectionNeeds(servicesWith(id));
  db().tx(() => {
    for (const c of changes) {
      db().run('DELETE FROM application_ratings WHERE application_id = ? AND dimension = ?', id, c.dimension);
      if (c.to)
        db().run(
          'INSERT INTO application_ratings (application_id, dimension, level, justification, rated_at, rated_by, needs_rerating, previous_label) VALUES (?, ?, ?, ?, ?, ?, 0, NULL)',
          id,
          c.dimension,
          c.to,
          c.justification ?? '',
          now,
          u.username,
        );
    }
    touchApplication(id, u);
    const label = (d: CiaDimension, k: string | null) => (k ? levelLabel(d, k, scale) : 'none');
    audit({
      action: 'application.rated',
      entityType: 'application',
      entityId: id,
      summary: `CIA rating of application "${cur.name}" changed: ${changes.map((c) => `${c.dimension} ${label(c.dimension, c.from)} → ${label(c.dimension, c.to)}`).join(', ')}`,
      details: { changes },
    });
    auditNeedChanges(needs, scale, { kind: 'application', what: `the CIA rating of application "${cur.name}"`, applicationId: id });
  });
  return getApplication(id);
}

export function addApplicationPlatform(id: string, platformId: string): ApplicationDetail {
  const u = me();
  const cur = requireEditableApplication(id, 'change the integrations of this application');
  if (cur.archived) throw new HttpError(409, `Application "${cur.name}" is archived`, 'APPLICATION_ARCHIVED', { name: cur.name });
  const p = db().get<PlatformRow>('SELECT id, name, kind, environment, acl FROM platforms WHERE id = ?', platformId);
  // only platforms the user can see (no probing for ids of hidden platforms)
  if (!p || !platformVisible(u, p)) throw new HttpError(404, `Platform ${platformId} not found`, 'PLATFORM_NOT_FOUND', { id: platformId });
  if (!platformManaged(u, p)) forbid('map this platform to an application (you need the manage right on the platform)', 'mapPlatform');
  const mapped = db().get<{ id: string; name: string }>(
    'SELECT a.id, a.name FROM application_platforms ap JOIN applications a ON a.id = ap.application_id WHERE ap.platform_id = ?',
    platformId,
  );
  if (mapped?.id === id) return getApplication(id);
  if (mapped)
    throw new HttpError(409, `Platform "${p.name}" belongs to application "${mapped.name}" already – remove it there first`, 'PLATFORM_MAPPED', {
      platform: p.name,
      application: mapped.name,
    });
  db().tx(() => {
    db().run(
      'INSERT INTO application_platforms (platform_id, application_id, created_at, created_by) VALUES (?, ?, ?, ?)',
      platformId,
      id,
      nowIso(),
      u.username,
    );
    touchApplication(id, u);
    audit({
      action: 'application.platform_added',
      entityType: 'application',
      entityId: id,
      summary: `Platform "${p.name}" mapped to application "${cur.name}"`,
      details: { platformId, platform: p.name },
    });
  });
  return getApplication(id);
}

export function removeApplicationPlatform(id: string, platformId: string): ApplicationDetail {
  const u = me();
  const cur = requireEditableApplication(id, 'change the integrations of this application');
  if (!db().get('SELECT 1 FROM application_platforms WHERE platform_id = ? AND application_id = ?', platformId, id))
    throw new HttpError(404, 'This platform is not mapped to the application', 'APPLICATION_PLATFORM_NOT_FOUND');
  // (a platform the user cannot see is named by its id only)
  const p = db().get<PlatformRow>('SELECT id, name, kind, environment, acl FROM platforms WHERE id = ?', platformId);
  if (p && !platformManaged(u, p)) forbid('remove this platform from the application (you need the manage right on the platform)', 'mapPlatform');
  const name = p && platformVisible(u, p) ? p.name : platformId;
  db().tx(() => {
    db().run('DELETE FROM application_platforms WHERE platform_id = ? AND application_id = ?', platformId, id);
    touchApplication(id, u);
    audit({
      action: 'application.platform_removed',
      entityType: 'application',
      entityId: id,
      summary: `Platform "${name}" removed from application "${cur.name}"`,
      details: { platformId },
    });
  });
  return getApplication(id);
}

export function addApplicationLink(id: string, input: LinkInput) {
  const cur = requireEditableApplication(id, 'change the links of this application');
  return addLink('application', id, input, `application "${cur.name}"`);
}

export function updateApplicationLink(id: string, linkId: string, input: LinkUpdate) {
  const cur = requireEditableApplication(id, 'change the links of this application');
  return updateLink('application', id, linkId, input, `application "${cur.name}"`).link;
}

export function removeApplicationLink(id: string, linkId: string): void {
  const cur = requireEditableApplication(id, 'change the links of this application');
  removeLink('application', id, linkId, `application "${cur.name}"`);
}

// ---------- services → applications ----------

/** The applications of a service with their role, rating and integrations. */
export function serviceApplications(serviceId: string, u: AuthUser | null = currentUser()): ServiceApplication[] {
  const rows = db().all<MemberRow & { name: string; archived: number; criticality: string | null }>(
    'SELECT sa.*, a.name, a.archived, a.criticality FROM service_applications sa JOIN applications a ON a.id = sa.application_id WHERE sa.service_id = ? ORDER BY a.name',
    serviceId,
  );
  const ids = rows.map((r) => r.application_id);
  const ratings = ratingsOf(ids);
  const integrations = integrationsOf(ids, u);
  return rows.map((r) => ({
    id: r.application_id,
    name: r.name,
    archived: !!r.archived,
    criticality: (r.criticality as ServiceApplication['criticality']) ?? null,
    role: (r.role as ApplicationRole | null) ?? null,
    roleText: r.role_text,
    rating: ratings.get(r.application_id) ?? emptyRating(),
    integrations: integrations.get(r.application_id) ?? [],
    addedAt: r.created_at,
    addedBy: r.created_by,
  }));
}

type ServiceRowLite = { id: string; name: string; owners: string };
function requireEditableService(serviceId: string, what: string): ServiceRowLite {
  const s = db().get<ServiceRowLite>('SELECT id, name, owners FROM services WHERE id = ?', serviceId);
  if (!s) throw new HttpError(404, `Service ${serviceId} not found`, 'SERVICE_NOT_FOUND', { id: serviceId });
  if (!canEditService(currentUser(), { kind: 'service', id: s.id, owners: parseJson<string[]>(s.owners, []) })) forbid(what, 'changeService');
  return s;
}

const roleOf = (input: ServiceApplicationInput) => ({ role: input.role, roleText: input.role === 'other' ? input.roleText : '' });

/** Adds an application to a service, or changes its role (service editors). */
export function setServiceApplication(serviceId: string, applicationId: string, input: ServiceApplicationInput): void {
  const u = me();
  const s = requireEditableService(serviceId, 'change the applications of this service');
  const a = row(applicationId);
  const { role, roleText } = roleOf(input);
  if (role === 'other' && !roleText) throw new HttpError(400, 'Describe the role (or choose primary or dependency)', 'APPLICATION_ROLE_TEXT');
  const cur = db().get<MemberRow>('SELECT * FROM service_applications WHERE service_id = ? AND application_id = ?', serviceId, applicationId);
  if (cur && (cur.role ?? null) === role && cur.role_text === roleText) return;
  if (!cur && a.archived) throw new HttpError(409, `Application "${a.name}" is archived`, 'APPLICATION_ARCHIVED', { name: a.name });
  const roleLabel = role === 'other' ? `"${roleText}"` : (role ?? 'no role');
  const needs = cur ? new Map() : protectionNeeds([serviceId]);
  const scale = currentScale();
  db().tx(() => {
    if (cur)
      db().run('UPDATE service_applications SET role = ?, role_text = ? WHERE service_id = ? AND application_id = ?', role, roleText, serviceId, applicationId);
    else
      db().run(
        'INSERT INTO service_applications (service_id, application_id, role, role_text, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)',
        serviceId,
        applicationId,
        role,
        roleText,
        nowIso(),
        u.username,
      );
    db().run('UPDATE services SET updated_at = ?, updated_by = ? WHERE id = ?', nowIso(), u.username, serviceId);
    audit({
      action: cur ? 'service.application_changed' : 'service.application_added',
      entityType: 'service',
      entityId: serviceId,
      summary: cur
        ? `Role of application "${a.name}" in service "${s.name}" changed to ${roleLabel}`
        : `Application "${a.name}" added to service "${s.name}" (${roleLabel})`,
      details: { applicationId, role, roleText, ...(cur ? { old: { role: cur.role ?? null, roleText: cur.role_text } } : {}) },
    });
    auditNeedChanges(needs, scale, { kind: 'membership', what: `adding application "${a.name}"`, applicationId });
  });
}

export function removeServiceApplication(serviceId: string, applicationId: string): void {
  const u = me();
  const s = requireEditableService(serviceId, 'change the applications of this service');
  const cur = db().get<MemberRow & { name: string }>(
    'SELECT sa.*, a.name FROM service_applications sa JOIN applications a ON a.id = sa.application_id WHERE sa.service_id = ? AND sa.application_id = ?',
    serviceId,
    applicationId,
  );
  if (!cur) throw new HttpError(404, 'This application is not part of the service', 'SERVICE_APPLICATION_NOT_FOUND');
  const needs = protectionNeeds([serviceId]);
  const scale = currentScale();
  db().tx(() => {
    db().run('DELETE FROM service_applications WHERE service_id = ? AND application_id = ?', serviceId, applicationId);
    db().run('UPDATE services SET updated_at = ?, updated_by = ? WHERE id = ?', nowIso(), u.username, serviceId);
    audit({
      action: 'service.application_removed',
      entityType: 'service',
      entityId: serviceId,
      summary: `Application "${cur.name}" removed from service "${s.name}"`,
      details: { applicationId, role: cur.role ?? null, roleText: cur.role_text },
    });
    auditNeedChanges(needs, scale, { kind: 'membership', what: `removing application "${cur.name}"`, applicationId });
  });
}

/**
 * Overrides dimensions of a service's derived protection need (missing: unchanged; null: removed), each with a reason
 * – e.g. a cumulation effect (many applications of normal need together need more) or a distribution effect (a
 * redundant setup needs less availability). Audited with the derived level at that moment.
 */
export function overrideProtectionNeed(serviceId: string, input: OverrideInput): void {
  const u = me();
  const s = requireEditableService(serviceId, 'change the protection need of this service');
  const scale = currentScale();
  requireValidScale(scale);
  const need = protectionNeedOf(serviceId);
  const derived = (d: CiaDimension) => need[d].derived;
  const before = new Map(
    db()
      .all<{ dimension: string; level: string; reason: string; needs_rerating: number }>(
        'SELECT dimension, level, reason, needs_rerating FROM service_protection_overrides WHERE service_id = ?',
        serviceId,
      )
      .map((r) => [r.dimension, r]),
  );
  const changes: { dimension: CiaDimension; from: string | null; to: string | null; reason?: string; derived: string | null }[] = [];
  for (const d of CIA_DIMENSIONS) {
    const v = input[d];
    if (v === undefined) continue;
    const old = before.get(d);
    if (v === null) {
      if (old) changes.push({ dimension: d, from: old.level, to: null, derived: derived(d) });
      continue;
    }
    checkLevel(d, v.level, scale);
    if (old && old.level === v.level && old.reason === v.reason && !old.needs_rerating) continue;
    changes.push({ dimension: d, from: old?.level ?? null, to: v.level, reason: v.reason, derived: derived(d) });
  }
  if (!changes.length) return;
  const now = nowIso();
  db().tx(() => {
    for (const c of changes) {
      db().run('DELETE FROM service_protection_overrides WHERE service_id = ? AND dimension = ?', serviceId, c.dimension);
      if (c.to)
        db().run(
          'INSERT INTO service_protection_overrides (service_id, dimension, level, reason, set_at, set_by, needs_rerating, previous_label) VALUES (?, ?, ?, ?, ?, ?, 0, NULL)',
          serviceId,
          c.dimension,
          c.to,
          c.reason ?? '',
          now,
          u.username,
        );
    }
    db().run('UPDATE services SET updated_at = ?, updated_by = ? WHERE id = ?', now, u.username, serviceId);
    const label = (d: CiaDimension, k: string | null) => (k ? levelLabel(d, k, scale) : 'derived');
    audit({
      action: 'service.protection_need_overridden',
      entityType: 'service',
      entityId: serviceId,
      summary: `Protection need of service "${s.name}" changed: ${changes.map((c) => `${c.dimension} ${label(c.dimension, c.from)} → ${label(c.dimension, c.to)}`).join(', ')}`,
      details: { changes },
    });
  });
}

// ---------- document scope ----------

/**
 * Sets the applications a living document applies to (whoever may edit the record; not for withdrawn documents).
 * Archived applications can stay but not be added. Audited on the record.
 */
export function setDocumentScope(recordId: string, applicationIds: string[]): DocumentApplicationRef[] {
  const { r, t } = requireEditable(recordId, 'change the scope of this document', { notTerminal: true });
  if (t.workflow !== 'document')
    throw new HttpError(400, `${r.number} is not a living document – only documents apply to applications`, 'RECORD_NOT_DOCUMENT', { number: r.number });
  const u = me();
  const before = scopeOf(r.id);
  const wanted = [...new Set(applicationIds)];
  const added = wanted.filter((id) => !before.some((b) => b.id === id));
  const removed = before.filter((b) => !wanted.includes(b.id));
  const names = new Map<string, string>(removed.map((x) => [x.id, x.name]));
  for (const id of added) {
    const a = db().get<{ name: string; archived: number }>('SELECT name, archived FROM applications WHERE id = ?', id);
    if (!a) throw new HttpError(404, `Application ${id} not found`, 'APPLICATION_NOT_FOUND', { id });
    if (a.archived) throw new HttpError(409, `Application "${a.name}" is archived`, 'APPLICATION_ARCHIVED', { name: a.name });
    names.set(id, a.name);
  }
  if (!added.length && !removed.length) return before;
  db().tx(() => {
    for (const x of removed) db().run('DELETE FROM record_applications WHERE record_id = ? AND application_id = ?', r.id, x.id);
    for (const id of added)
      db().run('INSERT INTO record_applications (record_id, application_id, created_at, created_by) VALUES (?, ?, ?, ?)', r.id, id, nowIso(), u.username);
    touch(r.id);
    audit({
      action: 'record.scope_changed',
      entityType: 'record',
      entityId: r.id,
      summary: `${r.number} applies to: ${scopeLabel(wanted, names, before)}`,
      details: { added, removed: removed.map((x) => x.id), applicationIds: wanted },
    });
    // … and on each application concerned: its documents changed without its owners (its history shows it)
    for (const [ids, action, verb] of [
      [added, 'application.document_added', 'now applies to'],
      [removed.map((x) => x.id), 'application.document_removed', 'no longer applies to'],
    ] as const)
      for (const id of ids)
        audit({
          action,
          entityType: 'application',
          entityId: id,
          summary: `${r.number} "${r.title}" ${verb} application "${names.get(id) ?? id}"`,
          details: { recordId: r.id, number: r.number },
        });
  });
  return scopeOf(r.id);
}

function scopeLabel(ids: string[], added: Map<string, string>, before: DocumentApplicationRef[]): string {
  if (!ids.length) return 'no application (the whole service)';
  return ids.map((id) => `"${added.get(id) ?? before.find((b) => b.id === id)?.name ?? id}"`).join(', ');
}
