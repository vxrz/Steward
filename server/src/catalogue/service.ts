import { z } from 'zod';
import { SERVICE_CONTACT_ROLES, SERVICE_CRITICALITIES, type ServiceContact, type ServiceDetail, type ServiceSummary } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentUser } from '../auth/context.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { canCreateServices, canEditService, forbid, me } from '../records/access.js';
import { addLink, httpUrl, listBacklinks, listLinks, removeLink, type LinkInput } from '../records/links.js';

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
    tags: z.array(z.string().trim().toLowerCase().min(1).max(60)).max(30).default([]),
  })
  .strict();
export type ServiceInput = z.infer<typeof serviceInput>;

const linkCount = (id: string) => Number(db().get<{ n: number }>("SELECT COUNT(*) AS n FROM item_links WHERE from_kind = 'service' AND from_id = ?", id)!.n);

function cmdbOf(r: ServiceRow): ServiceSummary['cmdb'] {
  if (!r.cmdb_system && !r.cmdb_id && !r.cmdb_url) return null;
  return { system: r.cmdb_system ?? '', id: r.cmdb_id ?? '', url: r.cmdb_url ?? '' };
}

function toSummary(r: ServiceRow, links?: number): ServiceSummary {
  return {
    id: r.id,
    name: r.name,
    criticality: (r.criticality as ServiceSummary['criticality']) ?? null,
    contacts: parseJson<ServiceContact[]>(r.contacts, []),
    owners: parseJson<string[]>(r.owners, []),
    tags: parseJson<string[]>(r.tags, []),
    cmdb: cmdbOf(r),
    archived: !!r.archived,
    linkCount: links ?? linkCount(r.id),
    updatedAt: r.updated_at,
  };
}

function row(id: string): ServiceRow {
  const r = db().get<ServiceRow>('SELECT * FROM services WHERE id = ?', id);
  if (!r) throw new HttpError(404, `Service ${id} not found`, 'SERVICE_NOT_FOUND', { id });
  return r;
}

export function listServices(o: { archived?: boolean } = {}): ServiceSummary[] {
  me();
  const counts = new Map(
    db()
      .all<{ id: string; n: number }>("SELECT from_id AS id, COUNT(*) AS n FROM item_links WHERE from_kind = 'service' GROUP BY from_id")
      .map((c) => [c.id, Number(c.n)]),
  );
  return db()
    .all<ServiceRow>(`SELECT * FROM services${o.archived ? '' : ' WHERE archived = 0'} ORDER BY name`)
    .map((r) => toSummary(r, counts.get(r.id) ?? 0));
}

export function getService(id: string): ServiceDetail {
  const u = me();
  const r = row(id);
  const s = toSummary(r);
  return {
    ...s,
    description: r.description,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedBy: r.updated_by,
    links: listLinks('service', r.id),
    backlinks: listBacklinks('service', r.id),
    canEdit: canEditService(u, s.owners),
  };
}

const dedupe = <T>(xs: T[], key: (x: T) => string) => [...new Map(xs.map((x) => [key(x), x])).values()];

export function createService(input: ServiceInput): ServiceDetail {
  const u = me();
  if (!canCreateServices(u)) forbid('create services', 'createServices');
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
  if (!canEditService(u, parseJson(cur.owners, []))) forbid('change this service', 'changeService');
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
  if (!canEditService(u, parseJson(cur.owners, []))) forbid('archive this service', 'changeService');
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
  if (!canEditService(currentUser(), parseJson(cur.owners, []))) forbid('change the links of this service', 'changeService');
  return addLink('service', id, input, `service "${cur.name}"`);
}

export function removeServiceLink(id: string, linkId: string): void {
  const cur = row(id);
  if (!canEditService(currentUser(), parseJson(cur.owners, []))) forbid('change the links of this service', 'changeService');
  removeLink('service', id, linkId, `service "${cur.name}"`);
}
