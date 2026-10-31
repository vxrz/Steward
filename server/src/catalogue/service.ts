import { z } from 'zod';
import {
  SERVICE_CONTACT_ROLES,
  SERVICE_CRITICALITIES,
  tagInput,
  type ServiceContact,
  type ServiceDetail,
  type ServiceDocument,
  type ServiceProtectionNeed,
  type ServiceSummary,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentUser, type AuthUser } from '../auth/context.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { canCreateServices, canEditService, forbid, me, canViewCatalogue } from '../records/access.js';
import { addLink, httpUrl, listBacklinks, listLinks, removeLink, targetVisible, updateLink, type LinkInput, type LinkUpdate } from '../records/links.js';
import { documentCounts, readableDocuments } from './documents.js';
import { scopesOf } from './scope.js';
import { protectionNeedOf, protectionNeeds } from './cia.js';
import { serviceApplications } from './applications.js';
import { assertKnownSubjects } from '../auth/subjects.js';
import { assignCreatorTeams } from '../auth/policy.js';

/**
 * A deliberately small service catalogue ("lightweight CMDB"): name,
 * description, contacts (business owner, IT operations), responsible Steward
 * users/teams, criticality, a reference to the entry in the real CMDB
 * (ServiceNow, …), tags and links to platforms, monitors, processes,
 * dashboards and records. Services are archived, never deleted, so links and
 * the audit trail stay meaningful.
 */

interface ServiceRow {
  id: string;
  name: string;
  description: string;
  contacts: string;
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

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => v || undefined);

export const serviceInput = z
  .object({
    name: z.string().trim().min(1).max(160),
    description: z
      .string()
      .max(64 * 1024)
      .default(''),
    contacts: z
      .array(z.object({ role: z.enum(SERVICE_CONTACT_ROLES), email: z.string().trim().max(200).email(), name: optionalText(120) }).strict())
      .max(20)
      .default([]),
    owners: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^(user|team):[^\s].{0,119}$/, 'Use user:<name> or team:<name>'),
      )
      .max(20)
      .default([]),
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
export type ServiceInput = z.infer<typeof serviceInput>;

function cmdbOf(r: ServiceRow): ServiceSummary['cmdb'] {
  if (!r.cmdb_system && !r.cmdb_id && !r.cmdb_url) return null;
  return { system: r.cmdb_system ?? '', id: r.cmdb_id ?? '', url: r.cmdb_url ?? '' };
}

function toSummary(
  r: ServiceRow,
  links: number,
  docs: { documents: number; overdue: number },
  apps: { count: number; need: ServiceProtectionNeed },
): ServiceSummary {
  return {
    id: r.id,
    name: r.name,
    criticality: (r.criticality as ServiceSummary['criticality']) ?? null,
    contacts: parseJson<ServiceContact[]>(r.contacts, []),
    owners: parseJson<string[]>(r.owners, []),
    tags: parseJson<string[]>(r.tags, []),
    cmdb: cmdbOf(r),
    archived: !!r.archived,
    linkCount: links,
    documentCount: docs.documents,
    overdueDocuments: docs.overdue,
    applicationCount: apps.count,
    protectionNeed: apps.need,
    updatedAt: r.updated_at,
  };
}

function row(id: string): ServiceRow {
  const r = db().get<ServiceRow>('SELECT * FROM services WHERE id = ?', id);
  if (!r) throw new HttpError(404, `Service ${id} not found`, 'SERVICE_NOT_FOUND', { id });
  // a team-owned item is unknown to those who may not see it (#131); jobs (no user) see everything
  const u = currentUser();
  if (u && !canViewCatalogue(u, { kind: 'service', id: r.id, owners: parseJson<string[]>(r.owners, []) }))
    throw new HttpError(404, `Service ${id} not found`, 'SERVICE_NOT_FOUND', { id });
  return r;
}

// ---------- living documents of a service ----------

/** Record ids linked to a service: the records that link to it and the records it links to. */
function linkedRecordIds(serviceId: string): { toService: Set<string>; fromService: Set<string> } {
  const toService = db()
    .all<{ id: string }>("SELECT from_id AS id FROM item_links WHERE from_kind = 'record' AND to_kind = 'service' AND to_id = ?", serviceId)
    .map((x) => x.id);
  const fromService = db()
    .all<{ id: string }>("SELECT to_id AS id FROM item_links WHERE from_kind = 'service' AND from_id = ? AND to_kind = 'record'", serviceId)
    .map((x) => x.id);
  return { toService: new Set(toService), fromService: new Set(fromService) };
}

/**
 * The living documents (workflow "document") linked to a service either way, ordered by number, each with the
 * applications it applies to. Documents the user may not read are left out entirely – they are neither listed nor
 * counted anywhere.
 */
export function serviceDocuments(serviceId: string, u: AuthUser | null): ServiceDocument[] {
  if (!u) return [];
  const { toService, fromService } = linkedRecordIds(serviceId);
  const docs = readableDocuments([...toService, ...fromService], u);
  const scopes = scopesOf(docs.map((d) => d.id));
  return docs.map((d) => ({
    ...d,
    linkedFrom: [...(toService.has(d.id) ? (['record'] as const) : []), ...(fromService.has(d.id) ? (['service'] as const) : [])],
    applications: scopes.get(d.id) ?? [],
  }));
}

/**
 * Per service: the living documents linked to it (either way) that the user may read, and how many of them have an
 * overdue review. Each linked document is read (in chunks) and checked once, whatever the number of services.
 */
function serviceDocumentCounts(u: AuthUser): Map<string, { documents: number; overdue: number }> {
  return documentCounts(
    db().all<{ item: string; record: string }>(
      `SELECT to_id AS item, from_id AS record FROM item_links WHERE from_kind = 'record' AND to_kind = 'service'
       UNION SELECT from_id AS item, to_id AS record FROM item_links WHERE from_kind = 'service' AND to_kind = 'record'`,
    ),
    u,
  );
}

/**
 * Per service: the links the current user may see – external URLs, and internal links whose target they may
 * see, as on the service page (links to hidden or deleted items are not counted). One query for the links;
 * each distinct target is checked once (its resolver's permission check), not once per service.
 */
function visibleLinkCounts(serviceIds: Set<string>): Map<string, number> {
  const rows = db().all<{ id: string; to_kind: string | null; to_id: string | null }>(
    "SELECT from_id AS id, to_kind, to_id FROM item_links WHERE from_kind = 'service'",
  );
  const seen = new Map<string, boolean>();
  const visible = (kind: string, id: string) => {
    const key = `${kind}:${id}`;
    if (!seen.has(key)) seen.set(key, targetVisible(kind, id));
    return seen.get(key)!;
  };
  const out = new Map<string, number>();
  for (const l of rows) {
    if (!serviceIds.has(l.id)) continue;
    if (l.to_kind && !visible(l.to_kind, l.to_id ?? '')) continue;
    out.set(l.id, (out.get(l.id) ?? 0) + 1);
  }
  return out;
}

function listRows(o: { archived?: boolean }): { r: ServiceRow; s: ServiceSummary }[] {
  const u = me();
  const rows = db()
    .all<ServiceRow>(`SELECT * FROM services${o.archived ? '' : ' WHERE archived = 0'} ORDER BY name`)
    .filter((r) => canViewCatalogue(u, { kind: 'service', id: r.id, owners: parseJson<string[]>(r.owners, []) }));
  const links = visibleLinkCounts(new Set(rows.map((r) => r.id)));
  const docs = serviceDocumentCounts(u);
  const needs = protectionNeeds(rows.map((r) => r.id));
  const apps = new Map(
    db()
      .all<{ id: string; n: number }>('SELECT service_id AS id, COUNT(*) AS n FROM service_applications GROUP BY service_id')
      .map((x) => [x.id, Number(x.n)]),
  );
  return rows.map((r) => ({
    r,
    s: toSummary(r, links.get(r.id) ?? 0, docs.get(r.id) ?? { documents: 0, overdue: 0 }, { count: apps.get(r.id) ?? 0, need: needs.get(r.id)! }),
  }));
}

export function listServices(o: { archived?: boolean } = {}): ServiceSummary[] {
  return listRows(o).map((x) => x.s);
}

/** A service with its description and creation (the public API's list; the web app's list leaves the description out). */
export type ServiceEntry = ServiceSummary & Pick<ServiceDetail, 'description' | 'createdAt' | 'createdBy' | 'updatedBy'>;

export function listServiceEntries(o: { archived?: boolean } = {}): ServiceEntry[] {
  return listRows(o).map(({ r, s }) => ({ ...s, description: r.description, createdAt: r.created_at, createdBy: r.created_by, updatedBy: r.updated_by }));
}

/** The living documents of a service (404 for an unknown service). */
export function getServiceDocuments(id: string): ServiceDocument[] {
  const u = me();
  return serviceDocuments(row(id).id, u);
}

export function getService(id: string): ServiceDetail {
  const u = me();
  const r = row(id);
  const documents = serviceDocuments(r.id, u);
  const links = listLinks('service', r.id);
  const applications = serviceApplications(r.id, u);
  const s = toSummary(
    r,
    links.filter((l) => l.visible).length,
    { documents: documents.length, overdue: documents.filter((d) => d.reviewStatus === 'overdue').length },
    { count: applications.length, need: protectionNeedOf(r.id) },
  );
  return {
    ...s,
    description: r.description,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedBy: r.updated_by,
    links,
    backlinks: listBacklinks('service', r.id),
    documents,
    applications,
    canEdit: canEditService(u, { kind: 'service', id: r.id, owners: s.owners }),
  };
}

const dedupe = <T>(xs: T[], key: (x: T) => string) => [...new Map(xs.map((x) => [key(x), x])).values()];

export function createService(input: ServiceInput): ServiceDetail {
  const u = me();
  if (!canCreateServices(u)) forbid('create services', 'createServices');
  assertKnownSubjects(input.owners);
  if (db().get('SELECT 1 FROM services WHERE lower(name) = lower(?) AND archived = 0', input.name))
    throw new HttpError(409, `A service named "${input.name}" exists already`, 'SERVICE_EXISTS', { name: input.name });
  const id = newId('svc_');
  const now = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO services (id, name, description, contacts, owners, criticality, cmdb_system, cmdb_id, cmdb_url, tags, archived, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      id,
      input.name,
      input.description,
      JSON.stringify(dedupe(input.contacts, (c) => `${c.role}:${c.email.toLowerCase()}`)),
      JSON.stringify([...new Set(input.owners)]),
      input.criticality,
      input.cmdb?.system || null,
      input.cmdb?.id || null,
      input.cmdb?.url || null,
      JSON.stringify([...new Set(input.tags)].sort()),
      now,
      u.username,
      now,
      u.username,
    );
    assignCreatorTeams('service', id, currentUser());
    audit({
      action: 'service.created',
      entityType: 'service',
      entityId: id,
      summary: `Service "${input.name}" created`,
      details: { criticality: input.criticality, cmdb: input.cmdb },
    });
  });
  return getService(id);
}

export function updateService(id: string, input: ServiceInput): ServiceDetail {
  const u = me();
  const cur = row(id);
  if (!canEditService(u, { kind: 'service', id: cur.id, owners: parseJson(cur.owners, []) })) forbid('change this service', 'changeService');
  assertKnownSubjects(input.owners, parseJson<string[]>(cur.owners, []));
  if (db().get('SELECT 1 FROM services WHERE lower(name) = lower(?) AND archived = 0 AND id <> ?', input.name, id))
    throw new HttpError(409, `A service named "${input.name}" exists already`, 'SERVICE_EXISTS', { name: input.name });
  const next = {
    name: input.name,
    description: input.description,
    contacts: JSON.stringify(dedupe(input.contacts, (c) => `${c.role}:${c.email.toLowerCase()}`)),
    owners: JSON.stringify([...new Set(input.owners)]),
    criticality: input.criticality,
    cmdb_system: input.cmdb?.system || null,
    cmdb_id: input.cmdb?.id || null,
    cmdb_url: input.cmdb?.url || null,
    tags: JSON.stringify([...new Set(input.tags)].sort()),
  };
  const changes = (Object.keys(next) as (keyof typeof next)[]).filter((k) => (next[k] ?? null) !== (cur[k] ?? null));
  if (!changes.length) return getService(id);
  db().tx(() => {
    db().run(
      'UPDATE services SET name = ?, description = ?, contacts = ?, owners = ?, criticality = ?, cmdb_system = ?, cmdb_id = ?, cmdb_url = ?, tags = ?, updated_at = ?, updated_by = ? WHERE id = ?',
      next.name,
      next.description,
      next.contacts,
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
      action: 'service.updated',
      entityType: 'service',
      entityId: id,
      summary: `Service "${input.name}" changed (${changes.join(', ')})`,
      details: { changes },
    });
  });
  return getService(id);
}

export function setArchived(id: string, archived: boolean): ServiceDetail {
  const u = me();
  const cur = row(id);
  if (!canEditService(u, { kind: 'service', id: cur.id, owners: parseJson(cur.owners, []) })) forbid('archive this service', 'changeService');
  if (!!cur.archived === archived) return getService(id);
  if (!archived && db().get('SELECT 1 FROM services WHERE lower(name) = lower(?) AND archived = 0 AND id <> ?', cur.name, id)) {
    throw new HttpError(409, `A service named "${cur.name}" exists already – rename one of them first`, 'SERVICE_EXISTS', { name: cur.name });
  }
  db().tx(() => {
    db().run('UPDATE services SET archived = ?, updated_at = ?, updated_by = ? WHERE id = ?', archived ? 1 : 0, nowIso(), u.username, id);
    audit({
      action: archived ? 'service.archived' : 'service.restored',
      entityType: 'service',
      entityId: id,
      summary: `Service "${cur.name}" ${archived ? 'archived' : 'restored'}`,
    });
  });
  return getService(id);
}

export function addServiceLink(id: string, input: LinkInput) {
  const cur = row(id);
  if (!canEditService(currentUser(), { kind: 'service', id: cur.id, owners: parseJson(cur.owners, []) }))
    forbid('change the links of this service', 'changeService');
  return addLink('service', id, input, `service "${cur.name}"`);
}

export function updateServiceLink(id: string, linkId: string, input: LinkUpdate) {
  const cur = row(id);
  if (!canEditService(currentUser(), { kind: 'service', id: cur.id, owners: parseJson(cur.owners, []) }))
    forbid('change the links of this service', 'changeService');
  return updateLink('service', id, linkId, input, `service "${cur.name}"`).link;
}

export function removeServiceLink(id: string, linkId: string): void {
  const cur = row(id);
  if (!canEditService(currentUser(), { kind: 'service', id: cur.id, owners: parseJson(cur.owners, []) }))
    forbid('change the links of this service', 'changeService');
  removeLink('service', id, linkId, `service "${cur.name}"`);
}
