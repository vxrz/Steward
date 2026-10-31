import { z } from 'zod';
import {
  DEFAULT_TICKET_SETTINGS,
  TICKET_LIMITS,
  TICKET_LINK_KINDS,
  TICKET_SOURCE_KEY_RE,
  TICKET_STATUSES,
  isTicketOpen,
  type ItemLink,
  type TicketDetail,
  type TicketEvent,
  type TicketEventKind,
  type TicketPermission,
  type TicketReference,
  type TicketSettings,
  type TicketSource,
  type TicketStatus,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentUser, type AuthUser } from '../auth/context.js';
import { isAdmin, matches } from '../auth/permissions.js';
import { listTeams, listUsers } from '../auth/users.js';
import { readSetting, writeSetting } from '../settings.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { likeEscape } from '../database/sql.js';
import { addLink, httpUrl, listLinks, removeLink, targetVisible } from '../records/links.js';
import { me } from '../auth/access.js';
import { assignCreatorTeams, teamScoped } from '../auth/policy.js';

/**
 * Ticket references: Steward documents that a ticket exists in another system
 * (a ServiceNow incident a user reported, a ticket with a platform vendor), who
 * looks after it on our side, its status and a link to it. It is not a
 * ticketing tool: no workflow, no approvals, no freezing – the status can be
 * set to anything at any time; every change is in the entry's history and the
 * audit log.
 *
 * Access:
 *   - read: everyone who can sign in.
 *   - create: administrators, designers, operators.
 *   - edit (fields, status, "checked"): those roles plus the responsible
 *     people (users and team members listed under "responsible").
 *   - delete: administrators.
 *
 * Affected items (services, platforms, credentials, records, …) are stored in
 * the generic link model (records/links.ts, from_kind = 'ticket'): a reader
 * sees a linked item's name only when they may see the item.
 */

const DAY = 86400000;
export const TICKET_EDITOR_ROLES = ['admin', 'designer', 'operator'];

export interface TicketRow {
  id: string;
  source: string;
  external_number: string;
  external_url: string | null;
  title: string;
  note: string;
  vendor: string;
  responsible: string;
  status: TicketStatus;
  opened_at: string;
  resolved_at: string | null;
  last_checked_at: string | null;
  reminder_days: number | null;
  version: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

// ---------- settings ----------

const SETTINGS_KEY = 'tickets.settings';

export function ticketSettings(): TicketSettings {
  const s = readSetting<Partial<TicketSettings>>(SETTINGS_KEY, {});
  return {
    sources: Array.isArray(s.sources) && s.sources.length ? s.sources : DEFAULT_TICKET_SETTINGS.sources,
    reminderDays: typeof s.reminderDays === 'number' && s.reminderDays > 0 ? s.reminderDays : null,
  };
}

export const ticketSettingsSchema = z
  .object({
    sources: z
      .array(
        z
          .object({
            key: z.string().trim().regex(TICKET_SOURCE_KEY_RE, 'lower-case letters, digits and dashes, e.g. vendor-siemens'),
            label: z.string().trim().min(1).max(80),
            vendor: z.boolean().default(false),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    reminderDays: z.number().int().min(1).max(365).nullable(),
  })
  .strict();

export function saveTicketSettings(input: z.infer<typeof ticketSettingsSchema>): TicketSettings {
  const u = me();
  if (!isAdmin(u)) throw new HttpError(403, 'You are not allowed to change the ticket reference settings', 'TICKET_SETTINGS_ADMIN_ONLY');
  const keys = input.sources.map((s) => s.key);
  if (new Set(keys).size !== keys.length) throw new HttpError(400, 'Each source needs its own key', 'TICKET_SOURCE_KEY_DUPLICATE');
  // a source that entries use cannot disappear (their source would lose its meaning)
  const used = db()
    .all<{ source: string }>('SELECT DISTINCT source FROM ticket_refs')
    .map((r) => r.source)
    .filter((k) => !keys.includes(k));
  if (used.length) throw new HttpError(409, `Ticket references use the source(s) ${used.join(', ')} – keep them (you can rename them)`, 'TICKET_SOURCE_IN_USE');
  const before = ticketSettings();
  const next: TicketSettings = { sources: input.sources, reminderDays: input.reminderDays };
  writeSetting(SETTINGS_KEY, next);
  audit({
    action: 'ticket.settings_changed',
    entityType: 'settings',
    entityId: 'tickets',
    summary: `Ticket reference settings changed (${next.sources.length} sources; reminder ${next.reminderDays ? `after ${next.reminderDays} days without a check` : 'off by default'})`,
    details: { from: before, to: next },
  });
  return ticketSettings();
}

const sourceOf = (key: string, settings = ticketSettings()): TicketSource => settings.sources.find((s) => s.key === key) ?? { key, label: key, vendor: false };

// ---------- permissions ----------

const isEditorRole = (u: AuthUser | null) => !!u && u.roles.some((r) => TICKET_EDITOR_ROLES.includes(r));
export const isResponsible = (u: AuthUser | null, r: Pick<TicketRow, 'responsible'>): boolean =>
  !!u && parseJson<string[]>(r.responsible, []).some((s) => matches(u, s));
export const canCreateTickets = (u: AuthUser | null = currentUser()): boolean => isEditorRole(u);

export function ticketPermissions(u: AuthUser | null, r: Pick<TicketRow, 'id' | 'responsible'>): TicketPermission[] {
  return ticketAccess(u, r).permissions.filter((p): p is TicketPermission => p !== 'view');
}

/**
 * Everybody signed in sees a ticket reference; editors by role and its responsibles change it, administrators delete
 * it. With owning teams (#131): members of those teams, its responsibles, administrators and auditors only.
 */
export function ticketAccess(u: AuthUser | null, r: Pick<TicketRow, 'id' | 'responsible'>) {
  const responsible = isResponsible(u, r);
  const byRole = (role: string): ('view' | 'edit')[] => (TICKET_EDITOR_ROLES.includes(role) ? ['view', 'edit'] : ['view']);
  return teamScoped<'view' | 'edit' | 'delete'>(
    u,
    { kind: 'ticket', id: r.id },
    {
      all: ['view', 'edit', 'delete'],
      byRole,
      personal: responsible ? { permissions: ['view', 'edit'] } : null,
      auditor: ['view'],
      unscoped: () => (!u ? [] : ['view', ...(isEditorRole(u) || responsible ? (['edit'] as const) : []), ...(isAdmin(u) ? (['delete'] as const) : [])]),
    },
  );
}

/** Ticket references the current user may see (jobs without a user see all). */
export const ticketVisible = (r: Pick<TicketRow, 'id' | 'responsible'>): boolean => {
  const u = currentUser();
  return !u || ticketAccess(u, r).permissions.includes('view');
};

// ---------- mapping ----------

const ageDays = (r: Pick<TicketRow, 'opened_at' | 'resolved_at'>, now: number) =>
  Math.max(0, Math.floor(((r.resolved_at ? Date.parse(r.resolved_at) : now) - Date.parse(r.opened_at)) / DAY));

export function effectiveReminderDays(r: Pick<TicketRow, 'reminder_days'>, settings = ticketSettings()): number | null {
  if (r.reminder_days === 0) return null;
  const d = r.reminder_days ?? settings.reminderDays;
  return d && d > 0 ? Number(d) : null;
}

export function toTicket(r: TicketRow, u: AuthUser | null = currentUser(), now = Date.now(), settings = ticketSettings(), links?: ItemLink[]): TicketReference {
  const src = sourceOf(r.source, settings);
  return {
    id: r.id,
    source: r.source,
    sourceLabel: src.label,
    vendorSource: src.vendor,
    externalNumber: r.external_number,
    externalUrl: r.external_url,
    title: r.title,
    note: r.note,
    vendor: r.vendor,
    responsible: parseJson(r.responsible, []),
    status: r.status,
    openedAt: r.opened_at,
    resolvedAt: r.resolved_at,
    lastCheckedAt: r.last_checked_at,
    reminderDays: r.reminder_days === null || r.reminder_days === undefined ? null : Number(r.reminder_days),
    effectiveReminderDays: effectiveReminderDays(r, settings),
    ageDays: ageDays(r, now),
    links: links ?? listLinks('ticket', r.id),
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
    version: Number(r.version),
    permissions: ticketPermissions(u, r),
    responsibleMe: isResponsible(u, r),
  };
}

// ---------- input ----------

const dateish = z
  .string()
  .trim()
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)), 'enter a date (YYYY-MM-DD) or an ISO timestamp')
  .transform((s) => new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s).toISOString());

const subjectSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(user|team):[^\s].{0,119}$/, 'use user:<name> or team:<name>');

export const ticketInputSchema = z
  .object({
    source: z.string().trim().min(1).max(40),
    externalNumber: z.string().trim().min(1).max(TICKET_LIMITS.number),
    externalUrl: z
      .union([httpUrl, z.literal('')])
      .nullable()
      .optional(),
    title: z.string().trim().min(1).max(TICKET_LIMITS.title),
    note: z.string().max(TICKET_LIMITS.note).default(''),
    vendor: z.string().trim().max(TICKET_LIMITS.vendor).default(''),
    responsible: z.array(subjectSchema).max(TICKET_LIMITS.responsible).default([]),
    status: z.enum(TICKET_STATUSES).default('open'),
    openedAt: dateish.optional(),
    resolvedAt: dateish.nullable().optional(),
    /** Days without a check before a reminder: null = the default, 0 = never */
    reminderDays: z.number().int().min(0).max(365).nullable().default(null),
    links: z
      .array(z.object({ kind: z.enum(TICKET_LINK_KINDS), id: z.string().trim().min(1).max(200) }).strict())
      .max(TICKET_LIMITS.links)
      .default([]),
    /** Optional comment for the history when the status changes */
    comment: z.string().max(TICKET_LIMITS.comment).default(''),
    /** Optimistic locking on update */
    version: z.number().int().optional(),
  })
  .strict();
export type TicketInput = z.infer<typeof ticketInputSchema>;

/** Responsible users and teams must exist (they get the reminders and see the entry under "mine"). */
function checkSubjects(list: string[]): void {
  if (!list.length) return;
  const users = new Set(listUsers().map((u) => u.username.toLowerCase()));
  const teams = new Set(listTeams().map((t) => t.name.toLowerCase()));
  for (const s of list) {
    const [kind, name] = [s.slice(0, s.indexOf(':')), s.slice(s.indexOf(':') + 1)];
    if (kind === 'user' && !users.has(name)) throw new HttpError(400, `User ${name} not found`, 'TICKET_RESPONSIBLE_UNKNOWN');
    if (kind === 'team' && !teams.has(name)) throw new HttpError(400, `Team ${name} not found`, 'TICKET_RESPONSIBLE_UNKNOWN');
  }
}

function checkSource(key: string, unchanged?: string): void {
  if (key === unchanged) return;
  if (!ticketSettings().sources.some((s) => s.key === key))
    throw new HttpError(400, `Unknown source "${key}" – an administrator manages the sources`, 'TICKET_SOURCE_UNKNOWN');
}

function checkDuplicate(source: string, number: string, exceptId?: string): void {
  const dup = db().get<{ id: string }>(
    'SELECT id FROM ticket_refs WHERE source = ? AND lower(external_number) = lower(?) AND id <> ?',
    source,
    number,
    exceptId ?? '',
  );
  if (dup) throw new HttpError(409, `A ticket reference for ${number} exists already`, 'TICKET_DUPLICATE');
}

function checkDates(openedAt: string, resolvedAt: string | null): void {
  if (Date.parse(openedAt) > Date.now() + DAY) throw new HttpError(400, 'The opening date cannot be in the future', 'TICKET_OPENED_IN_FUTURE');
  if (resolvedAt && Date.parse(resolvedAt) < Date.parse(openedAt))
    throw new HttpError(400, 'The ticket cannot be resolved before it was opened', 'TICKET_RESOLVED_BEFORE_OPENED');
}

/** resolved_at follows the status: set when it leaves the open statuses, cleared when it returns to them. */
function resolvedFor(
  status: TicketStatus,
  before: { status: TicketStatus; resolved_at: string | null } | null,
  given: string | null | undefined,
): string | null {
  if (isTicketOpen(status)) return null;
  if (given !== undefined && given !== null) return given;
  if (before && !isTicketOpen(before.status) && before.resolved_at) return before.resolved_at;
  return nowIso();
}

// ---------- queries ----------

export function ticketRow(id: string): TicketRow {
  const r = db().get<TicketRow>('SELECT * FROM ticket_refs WHERE id = ?', id);
  if (!r || !ticketVisible(r)) throw new HttpError(404, `Ticket reference ${id} not found`, 'TICKET_NOT_FOUND');
  return r;
}

function requireTicket(id: string, perm?: TicketPermission): TicketRow {
  const u = me();
  const r = ticketRow(id);
  if (perm && !ticketPermissions(u, r).includes(perm))
    throw new HttpError(
      403,
      perm === 'delete' ? 'Only administrators can delete ticket references' : 'You are not allowed to change this ticket reference',
      perm === 'delete' ? 'TICKET_DELETE_ADMIN_ONLY' : 'TICKET_EDIT_FORBIDDEN',
    );
  return r;
}

export interface TicketFilter {
  q?: string;
  status?: string[];
  /** open: the open statuses; closed: resolved and closed */
  state?: 'open' | 'closed' | 'all';
  source?: string[];
  vendor?: string;
  /** kind:id of an affected item */
  link?: string;
  /** "me", or user:<name> / team:<name> */
  responsible?: string;
  /** Opened at least this many days ago */
  minAgeDays?: number;
  /** vendor: waiting for a vendor (see waitingOnVendorSql) */
  waitingOn?: 'vendor';
}

/**
 * Tickets waiting for a vendor: status "waiting for vendor" (any source), or still "open" with a
 * source marked as vendor tickets. "Waiting for us" is ours to do, so it is not counted.
 */
function waitingOnVendorSql(settings: TicketSettings): { sql: string; params: string[] } {
  const keys = settings.sources.filter((s) => s.vendor).map((s) => s.key);
  if (!keys.length) return { sql: "status = 'waitingVendor'", params: [] };
  return { sql: `(status = 'waitingVendor' OR (status = 'open' AND source IN (${keys.map(() => '?').join(',')})))`, params: keys };
}

/** The ids of tickets that name an item as affected. */
function ticketIdsLinkingTo(kind: string, id: string): Set<string> {
  return new Set(
    db()
      .all<{ from_id: string }>("SELECT from_id FROM item_links WHERE from_kind = 'ticket' AND to_kind = ? AND to_id = ?", kind, id)
      .map((r) => r.from_id),
  );
}

/** Links of the listed tickets (resolved per reader: hidden items show as "not visible"). */
function linksByTicket(ids: string[]): Map<string, ItemLink[]> {
  return new Map(ids.map((id) => [id, listLinks('ticket', id)]));
}

export function listTickets(f: TicketFilter = {}, now = Date.now()): TicketReference[] {
  const u = me();
  const settings = ticketSettings();
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.status?.length) {
    where.push(`status IN (${f.status.map(() => '?').join(',')})`);
    params.push(...f.status);
  } else if (f.state === 'open' || f.state === 'closed') {
    where.push(`status ${f.state === 'open' ? '' : 'NOT '}IN ('open', 'waitingVendor', 'waitingUs')`);
  }
  if (f.source?.length) {
    where.push(`source IN (${f.source.map(() => '?').join(',')})`);
    params.push(...f.source);
  }
  if (f.vendor?.trim()) {
    where.push('lower(vendor) = lower(?)');
    params.push(f.vendor.trim());
  }
  if (f.q?.trim()) {
    const like = `%${likeEscape(f.q.trim().toLowerCase())}%`;
    where.push(
      "(lower(title) LIKE ? ESCAPE '\\' OR lower(external_number) LIKE ? ESCAPE '\\' OR lower(vendor) LIKE ? ESCAPE '\\' OR lower(note) LIKE ? ESCAPE '\\')",
    );
    params.push(like, like, like, like);
  }
  if (f.minAgeDays !== undefined) {
    where.push('opened_at <= ?');
    params.push(new Date(now - f.minAgeDays * DAY).toISOString());
  }
  if (f.waitingOn === 'vendor') {
    const w = waitingOnVendorSql(settings);
    where.push(w.sql);
    params.push(...w.params);
  }
  let rows = db()
    .all<TicketRow>(`SELECT * FROM ticket_refs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY opened_at DESC, id`, ...params)
    .filter(ticketVisible);
  if (f.link) {
    const i = f.link.indexOf(':');
    const kind = f.link.slice(0, i);
    const id = f.link.slice(i + 1);
    // no probing which hidden items have tickets
    if (i < 1 || !targetVisible(kind, id)) return [];
    const ids = ticketIdsLinkingTo(kind, id);
    rows = rows.filter((r) => ids.has(r.id));
  }
  if (f.responsible) {
    const who = f.responsible.trim().toLowerCase();
    rows = rows.filter((r) => (who === 'me' ? isResponsible(u, r) : parseJson<string[]>(r.responsible, []).includes(who)));
  }
  const links = linksByTicket(rows.map((r) => r.id));
  return rows.map((r) => toTicket(r, u, now, settings, links.get(r.id)));
}

/** Whether a user may read a ticket reference (the same rule as GET /ticket-references/:id: signed in, and it exists). */
export function ticketReadable(u: AuthUser | null, id: string): boolean {
  return !!u && !!db().get<{ id: string }>('SELECT id FROM ticket_refs WHERE id = ?', id);
}

export function getTicket(id: string): TicketDetail {
  const u = me();
  const r = ticketRow(id);
  return { ...toTicket(r, u), events: ticketEvents(id) };
}

export function ticketEvents(id: string): TicketEvent[] {
  return db()
    .all<{
      id: number;
      ts: string;
      actor: string;
      kind: TicketEventKind;
      from_status: TicketStatus | null;
      to_status: TicketStatus | null;
      comment: string;
      details: string;
    }>('SELECT * FROM ticket_ref_events WHERE ticket_id = ? ORDER BY id DESC LIMIT 500', id)
    .map((e) => ({
      id: Number(e.id),
      ts: e.ts,
      actor: e.actor,
      kind: e.kind,
      fromStatus: e.from_status,
      toStatus: e.to_status,
      comment: e.comment,
      details: parseJson(e.details, {}),
    }));
}

export function addTicketEvent(
  ticketId: string,
  kind: TicketEventKind,
  actor: string,
  o: { from?: TicketStatus | null; to?: TicketStatus | null; comment?: string; details?: Record<string, unknown>; ts?: string } = {},
): void {
  db().run(
    'INSERT INTO ticket_ref_events (ticket_id, ts, actor, kind, from_status, to_status, comment, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ticketId,
    o.ts ?? nowIso(),
    actor,
    kind,
    o.from ?? null,
    o.to ?? null,
    (o.comment ?? '').slice(0, TICKET_LIMITS.comment),
    JSON.stringify(o.details ?? {}),
  );
}

/** Distinct vendors of earlier entries (suggestions in the form). */
/** The start page's "Waiting on vendors" tile (everyone who can sign in reads ticket references). */
export function vendorAttention(now = Date.now()): { open: number; oldestDays: number | null } {
  me();
  const w = waitingOnVendorSql(ticketSettings());
  const r = db().get<{ n: number; oldest: string | null }>(`SELECT COUNT(*) AS n, MIN(opened_at) AS oldest FROM ticket_refs WHERE ${w.sql}`, ...w.params);
  const open = Number(r?.n ?? 0);
  return { open, oldestDays: open && r?.oldest ? ageDays({ opened_at: r.oldest, resolved_at: null }, now) : null };
}

export function vendorSuggestions(): string[] {
  me();
  return db()
    .all<{ vendor: string }>("SELECT DISTINCT vendor FROM ticket_refs WHERE vendor <> '' ORDER BY vendor")
    .map((r) => r.vendor)
    .slice(0, 200);
}

/** Open tickets per affected item of a kind, e.g. open vendor tickets per service (only items the user may see). */
export function openCounts(kind: string, vendorOnly: boolean): Record<string, number> {
  me();
  const settings = ticketSettings();
  const vendorSources = new Set(settings.sources.filter((s) => s.vendor).map((s) => s.key));
  const rows = db().all<{ to_id: string; source: string }>(
    `SELECT l.to_id, t.source FROM item_links l JOIN ticket_refs t ON t.id = l.from_id
     WHERE l.from_kind = 'ticket' AND l.to_kind = ? AND t.status IN ('open', 'waitingVendor', 'waitingUs')`,
    kind,
  );
  const out: Record<string, number> = {};
  const visible = new Map<string, boolean>();
  for (const r of rows) {
    if (vendorOnly && !vendorSources.has(r.source)) continue;
    if (!visible.has(r.to_id)) visible.set(r.to_id, targetVisible(kind, r.to_id));
    if (!visible.get(r.to_id)) continue;
    out[r.to_id] = (out[r.to_id] ?? 0) + 1;
  }
  return out;
}

// ---------- changes ----------

/** Adds and removes affected-item links; links the user cannot see are kept as they are. */
function syncLinks(ticketId: string, wanted: TicketInput['links'], label: string): string[] {
  const current = listLinks('ticket', ticketId);
  const key = (k: string, id: string) => `${k}:${id}`;
  const want = new Set(wanted.map((l) => key(l.kind, l.id)));
  const have = new Set(current.filter((l) => l.visible && l.kind && l.targetId).map((l) => key(l.kind!, l.targetId!)));
  const changed: string[] = [];
  for (const l of current) {
    if (!l.visible || !l.kind || !l.targetId) continue;
    if (!want.has(key(l.kind, l.targetId))) {
      removeLink('ticket', ticketId, l.id, label);
      changed.push(`-${key(l.kind, l.targetId)}`);
    }
  }
  for (const l of wanted) {
    if (have.has(key(l.kind, l.id))) continue;
    // addLink answers 404 for an item the user cannot see (like a missing one) and 409 for a link that exists (hidden ones too)
    try {
      addLink('ticket', ticketId, { kind: l.kind, id: l.id, note: '' }, label);
    } catch (e) {
      if (e instanceof HttpError && e.statusCode === 409) continue;
      throw e;
    }
    have.add(key(l.kind, l.id));
    changed.push(`+${key(l.kind, l.id)}`);
  }
  return changed;
}

const labelOf = (r: { source: string; external_number: string }) => `ticket reference ${r.external_number}`;

export function createTicket(b: TicketInput): TicketDetail {
  const u = me();
  if (!canCreateTickets(u)) throw new HttpError(403, 'You are not allowed to add ticket references', 'TICKET_CREATE_FORBIDDEN');
  checkSource(b.source);
  checkSubjects(b.responsible);
  checkDuplicate(b.source, b.externalNumber);
  const openedAt = b.openedAt ?? nowIso();
  const resolvedAt = resolvedFor(b.status, null, b.resolvedAt);
  checkDates(openedAt, resolvedAt);
  const id = newId('tkt_');
  const now = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO ticket_refs (id, source, external_number, external_url, title, note, vendor, responsible, status, opened_at, resolved_at, last_checked_at, reminder_days, version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, ?, ?, ?, ?)`,
      id,
      b.source,
      b.externalNumber,
      b.externalUrl || null,
      b.title,
      b.note,
      b.vendor,
      JSON.stringify([...new Set(b.responsible)]),
      b.status,
      openedAt,
      resolvedAt,
      b.reminderDays,
      now,
      u.username,
      now,
      u.username,
    );
    addTicketEvent(id, 'created', u.username, { to: b.status, comment: b.comment, details: { source: b.source, number: b.externalNumber } });
    assignCreatorTeams('ticket', id, currentUser());
    audit({
      action: 'ticket.created',
      entityType: 'ticket',
      entityId: id,
      summary: `Ticket reference ${b.externalNumber} (${sourceOf(b.source).label}) added: "${b.title}" – ${b.status}`,
      details: {
        source: b.source,
        externalNumber: b.externalNumber,
        externalUrl: b.externalUrl || null,
        vendor: b.vendor,
        responsible: b.responsible,
        status: b.status,
        openedAt,
        reminderDays: b.reminderDays,
      },
    });
    syncLinks(id, b.links, labelOf({ source: b.source, external_number: b.externalNumber }));
  });
  return getTicket(id);
}

export function updateTicket(id: string, b: TicketInput): TicketDetail {
  const u = me();
  const before = requireTicket(id, 'edit');
  if (b.version !== undefined && b.version !== Number(before.version))
    throw new HttpError(409, 'The entry was changed by someone else meanwhile – reload it and try again', 'TICKET_CHANGED');
  checkSource(b.source, before.source);
  const responsible = [...new Set(b.responsible)];
  checkSubjects(responsible.filter((s) => !parseJson<string[]>(before.responsible, []).includes(s)));
  // responsible people without an editor role must not edit themselves out (they would lock themselves out)
  if (!isEditorRole(u) && !isResponsible(u, { responsible: JSON.stringify(responsible) }))
    throw new HttpError(400, 'You edit this entry as one of the responsible people: keep yourself (or your team) in the list', 'TICKET_RESPONSIBLE_REQUIRED');
  checkDuplicate(b.source, b.externalNumber, id);
  const openedAt = b.openedAt ?? before.opened_at;
  const resolvedAt = resolvedFor(b.status, before, b.resolvedAt);
  checkDates(openedAt, resolvedAt);
  const next: Record<string, unknown> = {
    source: b.source,
    external_number: b.externalNumber,
    external_url: b.externalUrl || null,
    title: b.title,
    note: b.note,
    vendor: b.vendor,
    responsible: JSON.stringify(responsible),
    status: b.status,
    opened_at: openedAt,
    resolved_at: resolvedAt,
    reminder_days: b.reminderDays,
  };
  const cur = before as unknown as Record<string, unknown>;
  const changed = Object.keys(next).filter((k) => String(cur[k] ?? '') !== String(next[k] ?? ''));
  const statusChanged = b.status !== before.status;
  const now = nowIso();
  db().tx(() => {
    if (changed.length) {
      const r = db().run(
        `UPDATE ticket_refs SET ${changed.map((c) => `${c} = ?`).join(', ')}${statusChanged ? ', last_checked_at = ?' : ''}, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ? AND version = ?`,
        ...changed.map((c) => next[c]),
        ...(statusChanged ? [now] : []),
        now,
        u.username,
        id,
        before.version,
      );
      if (!r.changes) throw new HttpError(409, 'The entry was changed by someone else meanwhile – reload it and try again', 'TICKET_CHANGED');
    }
    const fields = changed.filter((c) => c !== 'status');
    if (fields.length) addTicketEvent(id, 'updated', u.username, { details: { fields } });
    if (statusChanged) addTicketEvent(id, 'status', u.username, { from: before.status, to: b.status, comment: b.comment });
    const linkChanges = syncLinks(id, b.links, labelOf({ source: b.source, external_number: b.externalNumber }));
    if (linkChanges.length && !changed.length)
      db().run('UPDATE ticket_refs SET version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?', now, u.username, id);
    if (changed.length)
      audit({
        action: statusChanged ? 'ticket.status_changed' : 'ticket.updated',
        entityType: 'ticket',
        entityId: id,
        summary: `Ticket reference ${b.externalNumber} changed (${changed.join(', ')})${statusChanged ? `: ${before.status} → ${b.status}` : ''}`,
        details: {
          changes: Object.fromEntries(changed.map((c) => [c, { from: cur[c] ?? null, to: next[c] ?? null }])),
          ...(statusChanged && b.comment ? { comment: b.comment } : {}),
        },
      });
  });
  return getTicket(id);
}

export const statusSchema = z
  .object({ status: z.enum(TICKET_STATUSES), comment: z.string().max(TICKET_LIMITS.comment).default(''), resolvedAt: dateish.nullable().optional() })
  .strict();

/** Quick status change (counts as a check). */
export function setStatus(id: string, b: z.infer<typeof statusSchema>): TicketDetail {
  const u = me();
  const before = requireTicket(id, 'edit');
  if (b.status === before.status) return markChecked(id, { comment: b.comment });
  const resolvedAt = resolvedFor(b.status, before, b.resolvedAt);
  checkDates(before.opened_at, resolvedAt);
  const now = nowIso();
  db().tx(() => {
    db().run(
      'UPDATE ticket_refs SET status = ?, resolved_at = ?, last_checked_at = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?',
      b.status,
      resolvedAt,
      now,
      now,
      u.username,
      id,
    );
    addTicketEvent(id, 'status', u.username, { from: before.status, to: b.status, comment: b.comment });
    audit({
      action: 'ticket.status_changed',
      entityType: 'ticket',
      entityId: id,
      summary: `Ticket reference ${before.external_number}: ${before.status} → ${b.status}`,
      details: { from: before.status, to: b.status, resolvedAt, comment: b.comment || undefined },
    });
  });
  return getTicket(id);
}

export const checkedSchema = z.object({ comment: z.string().max(TICKET_LIMITS.comment).default('') }).strict();

/** "Checked today": the ticket was looked at in the other system and nothing changed (resets the reminder). */
export function markChecked(id: string, b: z.infer<typeof checkedSchema>): TicketDetail {
  const u = me();
  const r = requireTicket(id, 'edit');
  const now = nowIso();
  db().tx(() => {
    db().run('UPDATE ticket_refs SET last_checked_at = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?', now, now, u.username, id);
    addTicketEvent(id, 'checked', u.username, { comment: b.comment });
    audit({
      action: 'ticket.checked',
      entityType: 'ticket',
      entityId: id,
      summary: `Ticket reference ${r.external_number} checked (${r.status})`,
      details: { status: r.status, comment: b.comment || undefined },
    });
  });
  return getTicket(id);
}

export function deleteTicket(id: string): void {
  const r = requireTicket(id, 'delete');
  db().tx(() => {
    db().run("DELETE FROM item_links WHERE from_kind = 'ticket' AND from_id = ?", id);
    for (const t of ['ticket_ref_events', 'ticket_ref_reminders']) db().run(`DELETE FROM ${t} WHERE ticket_id = ?`, id);
    db().run('DELETE FROM ticket_refs WHERE id = ?', id);
    audit({
      action: 'ticket.deleted',
      entityType: 'ticket',
      entityId: id,
      summary: `Ticket reference ${r.external_number} deleted: "${r.title}"`,
      details: { source: r.source, externalNumber: r.external_number, title: r.title, status: r.status },
    });
  });
}
