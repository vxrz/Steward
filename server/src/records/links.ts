import { z } from 'zod';
import { LINK_KINDS, type Backlink, type ItemLink, type LinkKind, type LinkTarget, type PlatformPermission, type AclEntry } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentActor, currentUser } from '../auth/context.js';
import { platformPermissions } from '../auth/permissions.js';
import { permissionsFor } from '../processes/service.js';
import { monitorRow, permissionsOfRow } from '../monitors/model.js';
import { likeEscape } from '../database/sql.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';

/**
 * Generic links from a record or service to an internal item ({ kind, id })
 * or an external http(s) URL (CMDB entry, ticket, wiki page). A link is shown
 * with the target's name only when the current user may see the target, so a
 * link never discloses a process or platform the reader has no access to.
 *
 * New kinds (e.g. credentials): add the kind to LINK_KINDS in
 * shared/src/records.ts and register a resolver with registerLinkKind().
 */

export type LinkSource = 'record' | 'service';

export interface LinkResolver {
  /** Name and UI path of a visible target, or null (missing or not visible) */
  resolve(id: string): { label: string; path: string; detail?: string } | null;
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
      .all<{ id: string; name: string }>("SELECT id, name FROM processes WHERE archived = 0 AND (lower(name) LIKE ? ESCAPE '\\' OR lower(id) LIKE ? ESCAPE '\\') ORDER BY name", like(q), like(q))
      .filter((p) => permissionsFor(p.id).includes('view'))
      .slice(0, limit)
      .map((p) => ({ kind: 'process' as const, id: p.id, label: p.name, detail: p.id }));
  },
});

registerLinkKind('run', {
  resolve(id) {
    const r = db().get<{ process_id: string; process_name: string; started_at: string; status: string }>('SELECT process_id, process_name, started_at, status FROM runs WHERE id = ?', id);
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

const platformVisible = (acl: string) => platformPermissions(currentUser(), { acl: parseJson<AclEntry<PlatformPermission>[]>(acl, []) }).length > 0;
registerLinkKind('platform', {
  resolve(id) {
    const p = db().get<{ name: string; acl: string; environment: string }>('SELECT name, acl, environment FROM platforms WHERE id = ?', id);
    if (!p || !platformVisible(p.acl)) return null;
    return { label: p.name, path: `/platforms/${id}`, detail: p.environment || undefined };
  },
  search(q, limit) {
    return db()
      .all<{ id: string; name: string; acl: string; environment: string }>("SELECT id, name, acl, environment FROM platforms WHERE lower(name) LIKE ? ESCAPE '\\' ORDER BY name", like(q))
      .filter((p) => platformVisible(p.acl))
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

registerLinkKind('record', {
  resolve(id) {
    const r = db().get<{ number: string; title: string; status: string }>('SELECT number, title, status FROM records WHERE id = ?', id);
    return r ? { label: `${r.number} ${r.title}`, path: `/records/${id}`, detail: r.status } : null;
  },
  search(q, limit) {
    return db()
      .all<{ id: string; number: string; title: string; status: string }>(
        "SELECT id, number, title, status FROM records WHERE lower(number) LIKE ? ESCAPE '\\' OR lower(title) LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT ?",
        like(q),
        like(q),
        limit,
      )
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
      .all<{ id: string; name: string }>("SELECT id, name FROM services WHERE archived = 0 AND lower(name) LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?", like(q), limit)
      .map((s) => ({ kind: 'service' as const, id: s.id, label: s.name }));
  },
});

// ---------- input ----------

export const MAX_LINKS_PER_ITEM = 200;

export const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .url()
  .refine((u) => /^https?:$/.test(new URL(u).protocol), 'Only http and https links are allowed');

export const linkInput = z.union([
  z.object({ kind: z.enum(LINK_KINDS), id: z.string().trim().min(1).max(200), note: z.string().trim().max(200).default('') }).strict(),
  z.object({ url: httpUrl, label: z.string().trim().max(200).default(''), note: z.string().trim().max(200).default('') }).strict(),
]);
export type LinkInput = z.infer<typeof linkInput>;

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
  created_at: string;
  created_by: string;
}

function toLink(r: LinkRow): ItemLink {
  if (!r.to_kind) {
    return { id: r.id, kind: null, targetId: null, url: r.url, label: r.label || r.url || '', note: r.note, visible: true, path: null, createdAt: r.created_at, createdBy: r.created_by };
  }
  const target = RESOLVERS.get(r.to_kind)?.resolve(r.to_id!) ?? null;
  return {
    id: r.id,
    kind: r.to_kind as LinkKind,
    targetId: r.to_id,
    url: null,
    label: target?.label ?? '',
    note: r.note,
    visible: !!target,
    path: target?.path ?? null,
    createdAt: r.created_at,
    createdBy: r.created_by,
  };
}

export function listLinks(from: LinkSource, id: string): ItemLink[] {
  return db().all<LinkRow>('SELECT * FROM item_links WHERE from_kind = ? AND from_id = ? ORDER BY created_at, id', from, id).map(toLink);
}

/** Records and services that link to an item. */
export function listBacklinks(kind: string, id: string): Backlink[] {
  const rows = db().all<LinkRow>('SELECT * FROM item_links WHERE to_kind = ? AND to_id = ? ORDER BY created_at, id', kind, id);
  const out: Backlink[] = [];
  for (const r of rows) {
    const src = RESOLVERS.get(r.from_kind)?.resolve(r.from_id);
    if (!src) continue;
    out.push({ linkId: r.id, kind: r.from_kind as 'record' | 'service', id: r.from_id, label: src.label, note: r.note, path: src.path });
  }
  return out;
}

export function searchTargets(kind: LinkKind, q: string, limit = 20): LinkTarget[] {
  const r = RESOLVERS.get(kind);
  if (!r) throw new HttpError(400, `Unknown link kind ${kind}`);
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
  if (Number(count) >= MAX_LINKS_PER_ITEM) throw new HttpError(400, `At most ${MAX_LINKS_PER_ITEM} links per item`);
  const id = newId('lnk_');
  const now = nowIso();
  const actor = currentActor();
  if ('kind' in input) {
    if (input.kind === from && input.id === fromId) throw new HttpError(400, 'An item cannot link to itself');
    // Only targets the user can see can be linked (no probing for ids of hidden items).
    const target = RESOLVERS.get(input.kind)?.resolve(input.id);
    if (!target) throw new HttpError(404, `${input.kind} ${input.id} not found`);
    if (db().get('SELECT 1 FROM item_links WHERE from_kind = ? AND from_id = ? AND to_kind = ? AND to_id = ?', from, fromId, input.kind, input.id)) {
      throw new HttpError(409, 'This link exists already');
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
      audit({ action: `${from}.link_added`, entityType: from, entityId: fromId, summary: `Link from ${entityLabel} to ${input.kind} "${target.label}" added`, details: { linkId: id, kind: input.kind, targetId: input.id, note: input.note } });
    });
  } else {
    db().tx(() => {
      db().run(
        'INSERT INTO item_links (id, from_kind, from_id, to_kind, to_id, url, label, note, created_at, created_by) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)',
        id,
        from,
        fromId,
        input.url,
        input.label,
        input.note,
        now,
        actor,
      );
      audit({ action: `${from}.link_added`, entityType: from, entityId: fromId, summary: `External link from ${entityLabel} added: ${input.url}`, details: { linkId: id, url: input.url, label: input.label, note: input.note } });
    });
  }
  return toLink(db().get<LinkRow>('SELECT * FROM item_links WHERE id = ?', id)!);
}

export function removeLink(from: LinkSource, fromId: string, linkId: string, entityLabel: string): void {
  const r = db().get<LinkRow>('SELECT * FROM item_links WHERE id = ? AND from_kind = ? AND from_id = ?', linkId, from, fromId);
  if (!r) throw new HttpError(404, 'Link not found');
  db().tx(() => {
    db().run('DELETE FROM item_links WHERE id = ?', linkId);
    audit({
      action: `${from}.link_removed`,
      entityType: from,
      entityId: fromId,
      summary: `Link from ${entityLabel} to ${r.to_kind ? `${r.to_kind} ${r.to_id}` : r.url} removed`,
      details: { linkId, kind: r.to_kind, targetId: r.to_id, url: r.url },
    });
  });
}
