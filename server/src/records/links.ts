import { z } from 'zod';
import { LINK_KINDS, type Backlink, type ItemLink, type LinkKind, type LinkTarget, type PlatformPermission, type AclEntry } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentActor, currentUser } from '../auth/context.js';
import { platformPermissions } from '../auth/permissions.js';
import { permissionsFor } from '../processes/service.js';
import { monitorRow, permissionsOfRow } from '../monitors/model.js';
import { likeEscape } from '../database/sql.js';
import { credentialPermissions, credentialsLinkingTo, type CredentialRow } from '../credentials/service.js';
import { canReadRecordRow } from './access.js';
import { checkLinkType, linkTypeByKey, linkTypeKey } from './link-types.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';

/**
 * Generic links from a record or service to an internal item ({ kind, id })
 * or an external http(s) URL (CMDB entry, ticket, wiki page; optionally typed: runbook, repository, …,
 * see link-types.ts). A link is shown
 * with the target's name only when the current user may see the target, so a
 * link never discloses a process or platform the reader has no access to.
 *
 * New kinds: add the kind to LINK_KINDS in shared/src/records.ts and register
 * a resolver with registerLinkKind(). Credentials register entries link the
 * other way round too (their "used by" links): those show up as backlinks.
 */

/** Items that hold links: records, services, applications and ticket references (tickets/service.ts: the items a ticket affects). */
export type LinkSource = 'record' | 'service' | 'application' | 'ticket';

export interface LinkResolver {
  /** Name and UI path of a visible target, or null (missing or not visible) */
  resolve(id: string): { label: string; path: string; detail?: string; edition?: string | null } | null;
  /** Visible targets matching a search text (for the link picker) */
  search(q: string, limit: number): LinkTarget[];
}

const like = (q: string) => `%${likeEscape(q.trim().toLowerCase())}%`;

const RESOLVERS = new Map<string, LinkResolver>();
export function registerLinkKind(kind: string, r: LinkResolver): void {
  RESOLVERS.set(kind, r);
}

registerLinkKind('process', {
  resolve(id) {
    const p = db().get<{ name: string }>('SELECT name FROM processes WHERE id = ?', id);
    if (!p || !permissionsFor(id).includes('view')) return null;
    return { label: p.name, path: `/processes/${id}` };
  },
  search(q, limit) {
    return db()
      .all<{ id: string; name: string }>(
        "SELECT id, name FROM processes WHERE archived = 0 AND (lower(name) LIKE ? ESCAPE '\\' OR lower(id) LIKE ? ESCAPE '\\') ORDER BY name",
        like(q),
        like(q),
      )
      .filter((p) => permissionsFor(p.id).includes('view'))
      .slice(0, limit)
      .map((p) => ({ kind: 'process' as const, id: p.id, label: p.name, detail: p.id }));
  },
});

registerLinkKind('run', {
  resolve(id) {
    const r = db().get<{ process_id: string; process_name: string; started_at: string; status: string }>(
      'SELECT process_id, process_name, started_at, status FROM runs WHERE id = ?',
      id,
    );
    if (!r || !permissionsFor(r.process_id).includes('view')) return null;
    return { label: `${r.process_name} · ${id}`, path: `/runs/${id}`, detail: `${r.status} · ${r.started_at}` };
  },
  search(q, limit) {
    return db()
      .all<{ id: string; process_id: string; process_name: string; started_at: string; status: string }>(
        "SELECT id, process_id, process_name, started_at, status FROM runs WHERE lower(id) LIKE ? ESCAPE '\\' OR lower(process_name) LIKE ? ESCAPE '\\' ORDER BY started_at DESC LIMIT 200",
        like(q),
        like(q),
      )
      .filter((r) => permissionsFor(r.process_id).includes('view'))
      .slice(0, limit)
      .map((r) => ({ kind: 'run' as const, id: r.id, label: `${r.process_name} · ${r.id}`, detail: `${r.status} · ${r.started_at}` }));
  },
});

registerLinkKind('monitor', {
  resolve(id) {
    const m = monitorRow(id);
    if (!m || !permissionsOfRow(m).includes('view')) return null;
    return { label: m.name, path: `/monitors/${m.id}`, detail: m.key };
  },
  search(q, limit) {
    return db()
      .all<{ id: string }>("SELECT id FROM monitors WHERE lower(name) LIKE ? ESCAPE '\\' OR lower(key) LIKE ? ESCAPE '\\' ORDER BY name", like(q), like(q))
      .map((r) => monitorRow(r.id))
      .filter((m): m is NonNullable<typeof m> => !!m && permissionsOfRow(m).includes('view'))
      .slice(0, limit)
      .map((m) => ({ kind: 'monitor' as const, id: m.id, label: m.name, detail: m.key }));
  },
});

const platformVisible = (id: string, acl: string) =>
  platformPermissions(currentUser(), { id, acl: parseJson<AclEntry<PlatformPermission>[]>(acl, []) }).length > 0;
registerLinkKind('platform', {
  resolve(id) {
    const p = db().get<{ name: string; acl: string; environment: string }>('SELECT name, acl, environment FROM platforms WHERE id = ?', id);
    if (!p || !platformVisible(id, p.acl)) return null;
    return { label: p.name, path: `/platforms/${id}`, detail: p.environment || undefined };
  },
  search(q, limit) {
    return db()
      .all<{ id: string; name: string; acl: string; environment: string }>(
        "SELECT id, name, acl, environment FROM platforms WHERE lower(name) LIKE ? ESCAPE '\\' ORDER BY name",
        like(q),
      )
      .filter((p) => platformVisible(p.id, p.acl))
      .slice(0, limit)
      .map((p) => ({ kind: 'platform' as const, id: p.id, label: p.name, detail: p.environment || undefined }));
  },
});

registerLinkKind('dashboard', {
  resolve(id) {
    const d = db().get<{ name: string }>('SELECT name FROM dashboards WHERE id = ?', id);
    return d ? { label: d.name, path: `/dashboards/${id}` } : null;
  },
  search(q, limit) {
    return db()
      .all<{ id: string; name: string }>("SELECT id, name FROM dashboards WHERE lower(name) LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?", like(q), limit)
      .map((d) => ({ kind: 'dashboard' as const, id: d.id, label: d.name }));
  },
});

// records: who may read them (everyone, except access change entries: canReadRecordRow)
type RecordLinkRow = { id: string; number: string; title: string; status: string; type_id: string; fields: string; owner: string };
const recordVisible = (r: RecordLinkRow) => canReadRecordRow(currentUser(), r);
registerLinkKind('record', {
  resolve(id) {
    const r = db().get<RecordLinkRow>('SELECT id, number, title, status, type_id, fields, owner FROM records WHERE id = ?', id);
    if (!r || !recordVisible(r)) return null;
    // living documents: the edition valid now
    const edition = db().get<{ current_edition: string | null }>('SELECT current_edition FROM record_documents WHERE record_id = ?', id)?.current_edition;
    return {
      label: `${r.number} ${r.title}`,
      path: `/records/${id}`,
      detail: edition ? `${r.status} · ${edition}` : r.status,
      ...(edition ? { edition } : {}),
    };
  },
  search(q, limit) {
    return db()
      .all<RecordLinkRow>(
        "SELECT id, number, title, status, type_id, fields, owner FROM records WHERE lower(number) LIKE ? ESCAPE '\\' OR lower(title) LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT 500",
        like(q),
        like(q),
      )
      .filter(recordVisible)
      .slice(0, limit)
      .map((r) => ({ kind: 'record' as const, id: r.id, label: `${r.number} ${r.title}`, detail: r.status }));
  },
});

registerLinkKind('service', {
  resolve(id) {
    const s = db().get<{ name: string; archived: number }>('SELECT name, archived FROM services WHERE id = ?', id);
    return s ? { label: s.name, path: `/services/${id}`, detail: s.archived ? 'archived' : undefined } : null;
  },
  search(q, limit) {
    return db()
      .all<{ id: string; name: string }>(
        "SELECT id, name FROM services WHERE archived = 0 AND lower(name) LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?",
        like(q),
        limit,
      )
      .map((s) => ({ kind: 'service' as const, id: s.id, label: s.name }));
  },
});

// applications of the service catalogue: everyone reads them, like services
registerLinkKind('application', {
  resolve(id) {
    const a = db().get<{ name: string; archived: number; vendor: string }>('SELECT name, archived, vendor FROM applications WHERE id = ?', id);
    return a ? { label: a.name, path: `/applications/${id}`, detail: a.archived ? 'archived' : a.vendor || undefined } : null;
  },
  search(q, limit) {
    return db()
      .all<{ id: string; name: string; vendor: string }>(
        "SELECT id, name, vendor FROM applications WHERE archived = 0 AND lower(name) LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?",
        like(q),
        limit,
      )
      .map((a) => ({ kind: 'application' as const, id: a.id, label: a.name, detail: a.vendor || undefined }));
  },
});

// Credentials register entries: the register's read rules (viewers only see entries they own).
type CredentialLinkRow = Pick<CredentialRow, 'id' | 'name' | 'type' | 'environment' | 'owner_subjects' | 'archived'>;
const credentialVisible = (r: CredentialLinkRow) => credentialPermissions(currentUser(), r).includes('view');
const credentialDetail = (r: CredentialLinkRow) => [r.type, r.environment, r.archived ? 'archived' : ''].filter(Boolean).join(' · ') || undefined;
registerLinkKind('credential', {
  resolve(id) {
    const r = db().get<CredentialLinkRow>('SELECT id, name, type, environment, owner_subjects, archived FROM credentials WHERE id = ?', id);
    if (!r || !credentialVisible(r)) return null;
    return { label: r.name, path: `/credentials?open=${encodeURIComponent(r.id)}`, detail: credentialDetail(r) };
  },
  search(q, limit) {
    return db()
      .all<CredentialLinkRow>(
        "SELECT id, name, type, environment, owner_subjects, archived FROM credentials WHERE archived = 0 AND (lower(name) LIKE ? ESCAPE '\\' OR lower(id) LIKE ? ESCAPE '\\') ORDER BY name",
        like(q),
        like(q),
      )
      .filter(credentialVisible)
      .slice(0, limit)
      .map((r) => ({ kind: 'credential' as const, id: r.id, label: r.name, detail: credentialDetail(r) }));
  },
});

// ---------- input ----------

export const MAX_LINKS_PER_ITEM = 200;

export const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .url()
  .refine((u) => {
    try {
      return /^https?:$/.test(new URL(u).protocol);
    } catch {
      return false; // not a URL at all (reported by .url() as well)
    }
  }, 'Only http and https links are allowed');

export const linkInput = z.union([
  z.object({ kind: z.enum(LINK_KINDS), id: z.string().trim().min(1).max(200), note: z.string().trim().max(200).default('') }).strict(),
  z
    .object({
      url: httpUrl,
      label: z.string().trim().max(200).default(''),
      note: z.string().trim().max(200).default(''),
      /** Key of a link type (runbook, repository, …); null or missing: no type ("Other") */
      linkType: linkTypeKey.nullable().optional(),
    })
    .strict(),
]);
export type LinkInput = z.infer<typeof linkInput>;

/**
 * Changes to an existing link (Edit in the Links section): external links take label, note and type,
 * internal links only a note. The target (URL, item) never changes – that is a new link.
 */
export const linkUpdate = z
  .object({
    label: z.string().trim().max(200).optional(),
    note: z.string().trim().max(200).optional(),
    /** Key of a link type; null: no type ("Other"); missing: unchanged */
    linkType: linkTypeKey.nullable().optional(),
  })
  .strict();
export type LinkUpdate = z.infer<typeof linkUpdate>;

// ---------- read ----------

interface LinkRow {
  id: string;
  from_kind: string;
  from_id: string;
  to_kind: string | null;
  to_id: string | null;
  url: string | null;
  label: string;
  note: string;
  link_type: string | null;
  created_at: string;
  created_by: string;
}

function toLink(r: LinkRow): ItemLink {
  if (!r.to_kind) {
    return {
      id: r.id,
      kind: null,
      targetId: null,
      url: r.url,
      linkType: r.link_type ?? null,
      label: r.label || r.url || '',
      note: r.note,
      visible: true,
      path: null,
      createdAt: r.created_at,
      createdBy: r.created_by,
    };
  }
  const target = RESOLVERS.get(r.to_kind)?.resolve(r.to_id!) ?? null;
  return {
    id: r.id,
    kind: r.to_kind as LinkKind,
    // ids can carry names (process ids are slugs of the name): only for targets the reader may see
    targetId: target ? r.to_id : null,
    url: null,
    linkType: null,
    label: target?.label ?? '',
    note: r.note,
    visible: !!target,
    path: target?.path ?? null,
    ...(target?.edition ? { edition: target.edition } : {}),
    createdAt: r.created_at,
    createdBy: r.created_by,
  };
}

export function listLinks(from: LinkSource, id: string): ItemLink[] {
  return db().all<LinkRow>('SELECT * FROM item_links WHERE from_kind = ? AND from_id = ? ORDER BY created_at, id', from, id).map(toLink);
}

/** Whether the current user may see an item (services: everyone; records: everyone but access change entries). */
export function targetVisible(kind: string, id: string): boolean {
  return !!RESOLVERS.get(kind)?.resolve(id);
}

/**
 * Records and services that link to an item, and credentials register entries
 * that name it under "used by". Sources the user may not see are left out.
 */
export function listBacklinks(kind: string, id: string): Backlink[] {
  const rows = db().all<LinkRow>('SELECT * FROM item_links WHERE to_kind = ? AND to_id = ? ORDER BY created_at, id', kind, id);
  const out: Backlink[] = [];
  for (const r of rows) {
    const src = RESOLVERS.get(r.from_kind)?.resolve(r.from_id);
    if (!src) continue;
    out.push({ linkId: r.id, kind: r.from_kind as Backlink['kind'], id: r.from_id, label: src.label, note: r.note, path: src.path });
  }
  for (const c of credentialsLinkingTo(kind, id)) {
    out.push({ linkId: `credential:${c.id}`, kind: 'credential', id: c.id, label: c.name, note: '', path: `/credentials?open=${encodeURIComponent(c.id)}` });
  }
  return out;
}

export function searchTargets(kind: LinkKind, q: string, limit = 20): LinkTarget[] {
  const r = RESOLVERS.get(kind);
  if (!r) throw new HttpError(400, `Unknown link kind ${kind}`, 'LINK_KIND_UNKNOWN', { kind });
  return r.search(q.slice(0, 100), Math.min(Math.max(limit, 1), 50));
}

/** Label of a link target for audit summaries (never the label of an invisible item). */
export function describeTarget(kind: string, id: string): string | null {
  return RESOLVERS.get(kind)?.resolve(id)?.label ?? null;
}

// ---------- write ----------

/** Adds a link (the caller checked that the user may change the source). */
export function addLink(from: LinkSource, fromId: string, input: LinkInput, entityLabel: string): ItemLink {
  const count = db().get<{ n: number }>('SELECT COUNT(*) AS n FROM item_links WHERE from_kind = ? AND from_id = ?', from, fromId)!.n;
  if (Number(count) >= MAX_LINKS_PER_ITEM) throw new HttpError(400, `At most ${MAX_LINKS_PER_ITEM} links per item`, 'LINK_LIMIT', { max: MAX_LINKS_PER_ITEM });
  const id = newId('lnk_');
  const now = nowIso();
  const actor = currentActor();
  if ('kind' in input) {
    if (input.kind === from && input.id === fromId) throw new HttpError(400, 'An item cannot link to itself', 'LINK_SELF');
    // Only targets the user can see can be linked (no probing for ids of hidden items).
    const target = RESOLVERS.get(input.kind)?.resolve(input.id);
    if (!target) throw new HttpError(404, `${input.kind} ${input.id} not found`, 'LINK_TARGET_NOT_FOUND', { kind: input.kind, id: input.id });
    if (db().get('SELECT 1 FROM item_links WHERE from_kind = ? AND from_id = ? AND to_kind = ? AND to_id = ?', from, fromId, input.kind, input.id)) {
      throw new HttpError(409, 'This link exists already', 'LINK_EXISTS');
    }
    db().tx(() => {
      db().run(
        'INSERT INTO item_links (id, from_kind, from_id, to_kind, to_id, url, label, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)',
        id,
        from,
        fromId,
        input.kind,
        input.id,
        '',
        input.note,
        now,
        actor,
      );
      audit({
        action: `${from}.link_added`,
        entityType: from,
        entityId: fromId,
        summary: `Link from ${entityLabel} to ${input.kind} "${target.label}" added`,
        details: { linkId: id, kind: input.kind, targetId: input.id, note: input.note },
      });
    });
  } else {
    const linkType = checkLinkType(input.linkType);
    db().tx(() => {
      db().run(
        'INSERT INTO item_links (id, from_kind, from_id, to_kind, to_id, url, label, note, link_type, created_at, created_by) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)',
        id,
        from,
        fromId,
        input.url,
        input.label,
        input.note,
        linkType,
        now,
        actor,
      );
      audit({
        action: `${from}.link_added`,
        entityType: from,
        entityId: fromId,
        summary: `External link from ${entityLabel} added${linkType ? ` (${linkTypeByKey(linkType)?.name ?? linkType})` : ''}: ${input.url}`,
        details: { linkId: id, url: input.url, label: input.label, note: input.note, linkType },
      });
    });
  }
  return toLink(db().get<LinkRow>('SELECT * FROM item_links WHERE id = ?', id)!);
}

/**
 * Changes label, note and type of a link (the caller checked that the user may change the source).
 * Same rules as for new links: an unknown type is refused, an archived one cannot be newly chosen
 * (a link keeps the archived type it has). Links to items the user cannot see cannot be edited (404, no
 * hint at the hidden item; they can still be removed). An edit that changes nothing writes nothing.
 */
export function updateLink(from: LinkSource, fromId: string, linkId: string, input: LinkUpdate, entityLabel: string): { link: ItemLink; changed: boolean } {
  const r = db().get<LinkRow>('SELECT * FROM item_links WHERE id = ? AND from_kind = ? AND from_id = ?', linkId, from, fromId);
  if (!r) throw new HttpError(404, 'Link not found', 'LINK_NOT_FOUND');
  type Values = { label: string; note: string; linkType: string | null };
  const before: Values = { label: r.label, note: r.note, linkType: r.link_type ?? null };
  const after: Values = { ...before, ...(input.note !== undefined ? { note: input.note } : {}) };
  let target: string | null = null;
  if (r.to_kind) {
    if (input.label !== undefined || input.linkType !== undefined)
      throw new HttpError(400, 'Internal links only have a note (no label or type)', 'LINK_INTERNAL_FIELDS');
    target = RESOLVERS.get(r.to_kind)?.resolve(r.to_id!)?.label ?? null;
    if (target === null) throw new HttpError(404, 'Link not found', 'LINK_NOT_FOUND');
  } else {
    if (input.label !== undefined) after.label = input.label;
    // keeping the type the link has is fine (also an archived one); a different one must be known and not archived
    if (input.linkType !== undefined && (input.linkType ?? null) !== before.linkType) after.linkType = checkLinkType(input.linkType);
  }
  const changes = (Object.keys(after) as (keyof Values)[]).filter((k) => after[k] !== before[k]);
  if (!changes.length) return { link: toLink(r), changed: false };
  const pick = (v: Values) => Object.fromEntries(changes.map((k) => [k, v[k]]));
  const typeName = (key: string | null) => (key ? (linkTypeByKey(key)?.name ?? key) : 'none');
  db().tx(() => {
    db().run('UPDATE item_links SET label = ?, note = ?, link_type = ? WHERE id = ?', after.label, after.note, after.linkType, linkId);
    audit({
      action: `${from}.link_updated`,
      entityType: from,
      entityId: fromId,
      summary: r.to_kind
        ? `Link from ${entityLabel} to ${r.to_kind} "${target}" changed (${changes.join(', ')})`
        : `External link from ${entityLabel} changed (${changes.join(', ')}${
            changes.includes('linkType') ? `: ${typeName(before.linkType)} → ${typeName(after.linkType)}` : ''
          }): ${r.url}`,
      details: {
        linkId,
        ...(r.to_kind ? { kind: r.to_kind, targetId: r.to_id } : { url: r.url }),
        changes,
        old: pick(before),
        new: pick(after),
      },
    });
  });
  return { link: toLink(db().get<LinkRow>('SELECT * FROM item_links WHERE id = ?', linkId)!), changed: true };
}

export function removeLink(from: LinkSource, fromId: string, linkId: string, entityLabel: string): void {
  const r = db().get<LinkRow>('SELECT * FROM item_links WHERE id = ? AND from_kind = ? AND from_id = ?', linkId, from, fromId);
  if (!r) throw new HttpError(404, 'Link not found', 'LINK_NOT_FOUND');
  db().tx(() => {
    db().run('DELETE FROM item_links WHERE id = ?', linkId);
    audit({
      action: `${from}.link_removed`,
      entityType: from,
      entityId: fromId,
      summary: `Link from ${entityLabel} to ${r.to_kind ? `${r.to_kind} ${r.to_id}` : r.url} removed`,
      details: { linkId, kind: r.to_kind, targetId: r.to_id, url: r.url, ...(r.to_kind ? {} : { linkType: r.link_type ?? null }) },
    });
  });
}
