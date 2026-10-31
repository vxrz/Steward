import crypto from 'node:crypto';
import { z } from 'zod';
import {
  STATUS_NOTICE_LEVELS,
  STATUS_PAGE_LIMITS,
  isTicketOpen,
  type MonitorStatus,
  type ServiceState,
  type StatusNoticeLevel,
  type StatusPage,
  type StatusPageView,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { runAs, type AuthUser } from '../auth/context.js';
import { isAdmin } from '../auth/permissions.js';
import { canCreateServices, forbid, me } from '../records/access.js';
import { SYSTEM_USER } from '../compliance/access.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { listMaintenance } from './maintenance.js';
import { listTickets } from '../tickets/service.js';
import { listObjectives } from '../scorecard/objectives.js';

/**
 * Service status pages (#26): a read-only view of some services for people outside the service team – the state from
 * the services' monitors, planned and running maintenance, and optionally the availability objectives and known issues
 * with vendors. Every signed-in user and every status viewer (role "status", which sees nothing else, see app.ts) can
 * read them; a page can also get a secret link that works without signing in. A page never names monitors, platforms
 * or tickets: it is built as Steward itself and says only what is meant for the audience.
 */

interface Row {
  id: string;
  title: string;
  description: string;
  service_ids: string;
  show_objectives: number;
  show_vendor_issues: number;
  notice: string;
  notice_level: StatusNoticeLevel;
  link_hash: string | null;
  link_created_at: string | null;
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
}

export const pageInput = z
  .object({
    title: z.string().trim().min(1).max(STATUS_PAGE_LIMITS.title),
    description: z.string().trim().max(STATUS_PAGE_LIMITS.description).default(''),
    serviceIds: z.array(z.string().min(1).max(100)).min(1).max(STATUS_PAGE_LIMITS.services),
    showObjectives: z.boolean().default(true),
    showVendorIssues: z.boolean().default(true),
    notice: z.string().trim().max(STATUS_PAGE_LIMITS.notice).default(''),
    noticeLevel: z.enum(STATUS_NOTICE_LEVELS).default('info'),
  })
  .strict();

const canEdit = (u: AuthUser) => canCreateServices(u) || isAdmin(u);
const hashOf = (token: string) => crypto.createHash('sha256').update(`status-page:${token}`).digest('hex');

function toPage(r: Row, u: AuthUser): StatusPage {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    serviceIds: parseJson<string[]>(r.service_ids, []),
    showObjectives: !!r.show_objectives,
    showVendorIssues: !!r.show_vendor_issues,
    notice: r.notice,
    noticeLevel: r.notice_level,
    publicLink: !!r.link_hash,
    publicLinkCreatedAt: r.link_created_at,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
    canEdit: canEdit(u),
  };
}

function rowOf(id: string): Row {
  const r = db().get<Row>('SELECT * FROM status_pages WHERE id = ?', id);
  if (!r) throw new HttpError(404, `Status page ${id} not found`, 'STATUS_PAGE_NOT_FOUND', { id });
  return r;
}

/** Every signed-in user and status viewer sees the list. */
export function listPages(): StatusPage[] {
  const u = me();
  return db()
    .all<Row>('SELECT * FROM status_pages ORDER BY title')
    .map((r) => toPage(r, u));
}

export function getPage(id: string): StatusPage {
  return toPage(rowOf(id), me());
}

function checkServices(ids: string[]): void {
  for (const id of new Set(ids))
    if (!db().get('SELECT 1 FROM services WHERE id = ?', id)) throw new HttpError(400, `Service ${id} not found`, 'SERVICE_NOT_FOUND', { id });
}

export function createPage(input: z.infer<typeof pageInput>): StatusPage {
  const u = me();
  if (!canEdit(u)) forbid('set up status pages', 'statusPages');
  checkServices(input.serviceIds);
  const id = newId('stp_');
  const now = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO status_pages (id, title, description, service_ids, show_objectives, show_vendor_issues, notice, notice_level, created_by, created_at, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.title,
      input.description,
      JSON.stringify([...new Set(input.serviceIds)]),
      input.showObjectives ? 1 : 0,
      input.showVendorIssues ? 1 : 0,
      input.notice,
      input.noticeLevel,
      u.username,
      now,
      u.username,
      now,
    );
    audit({
      action: 'status_page.created',
      entityType: 'status_page',
      entityId: id,
      summary: `Status page "${input.title}" created`,
      details: { services: input.serviceIds },
    });
  });
  return getPage(id);
}

export function updatePage(id: string, input: z.infer<typeof pageInput>): StatusPage {
  const u = me();
  if (!canEdit(u)) forbid('change status pages', 'statusPages');
  const before = rowOf(id);
  checkServices(input.serviceIds);
  db().tx(() => {
    db().run(
      `UPDATE status_pages SET title = ?, description = ?, service_ids = ?, show_objectives = ?, show_vendor_issues = ?, notice = ?, notice_level = ?,
         updated_by = ?, updated_at = ? WHERE id = ?`,
      input.title,
      input.description,
      JSON.stringify([...new Set(input.serviceIds)]),
      input.showObjectives ? 1 : 0,
      input.showVendorIssues ? 1 : 0,
      input.notice,
      input.noticeLevel,
      u.username,
      nowIso(),
      id,
    );
    audit({
      action: 'status_page.changed',
      entityType: 'status_page',
      entityId: id,
      summary: `Status page "${input.title}" changed${input.notice !== before.notice ? ` – notice: ${input.notice ? input.notice.slice(0, 200) : '(none)'}` : ''}`,
      details: { services: input.serviceIds, noticeLevel: input.noticeLevel },
    });
  });
  return getPage(id);
}

export function deletePage(id: string): void {
  const u = me();
  if (!canEdit(u)) forbid('delete status pages', 'statusPages');
  const r = rowOf(id);
  db().tx(() => {
    db().run('DELETE FROM status_pages WHERE id = ?', id);
    audit({ action: 'status_page.deleted', entityType: 'status_page', entityId: id, summary: `Status page "${r.title}" deleted` });
  });
}

/** A new secret link (replaces an old one); the token is returned once and only its hash is kept. */
export function createLink(id: string): { token: string; page: StatusPage } {
  const u = me();
  if (!canEdit(u)) forbid('share status pages', 'statusPages');
  const r = rowOf(id);
  const token = crypto.randomBytes(24).toString('base64url');
  db().tx(() => {
    db().run(
      'UPDATE status_pages SET link_hash = ?, link_created_at = ?, updated_by = ?, updated_at = ? WHERE id = ?',
      hashOf(token),
      nowIso(),
      u.username,
      nowIso(),
      id,
    );
    audit({
      action: 'status_page.link_created',
      entityType: 'status_page',
      entityId: id,
      summary: `Link without sign-in for status page "${r.title}" ${r.link_hash ? 'replaced' : 'created'}`,
    });
  });
  return { token, page: getPage(id) };
}

export function revokeLink(id: string): StatusPage {
  const u = me();
  if (!canEdit(u)) forbid('share status pages', 'statusPages');
  const r = rowOf(id);
  if (r.link_hash)
    db().tx(() => {
      db().run('UPDATE status_pages SET link_hash = NULL, link_created_at = NULL, updated_by = ?, updated_at = ? WHERE id = ?', u.username, nowIso(), id);
      audit({
        action: 'status_page.link_revoked',
        entityType: 'status_page',
        entityId: id,
        summary: `Link without sign-in for status page "${r.title}" revoked`,
      });
    });
  return getPage(id);
}

// ---------- the view ----------

const STATE_OF: Record<MonitorStatus, ServiceState> = {
  down: 'outage',
  degraded: 'degraded',
  maintenance: 'maintenance',
  up: 'operational',
  unknown: 'unknown',
  blocked: 'unknown',
};
const RANK: ServiceState[] = ['outage', 'degraded', 'maintenance', 'unknown', 'operational'];
const worst = (list: ServiceState[]): ServiceState => (list.length ? RANK.find((s) => list.includes(s))! : 'unknown');

function monitorStates(serviceId: string): ServiceState[] {
  return db()
    .all<{ status: MonitorStatus | null }>(
      `SELECT s.status FROM item_links l JOIN monitors m ON m.id = l.to_id LEFT JOIN monitor_state s ON s.monitor_id = m.id
       WHERE l.from_kind = 'service' AND l.from_id = ? AND l.to_kind = 'monitor' AND m.enabled = 1 AND m.is_template = 0`,
      serviceId,
    )
    .map((r) => STATE_OF[r.status ?? 'unknown'] ?? 'unknown');
}

function build(r: Row, now = Date.now()): StatusPageView {
  // built as Steward itself (it reads everything), but only these fields leave
  return runAs(SYSTEM_USER, () => {
    const services: StatusPageView['services'] = [];
    for (const id of parseJson<string[]>(r.service_ids, [])) {
      const s = db().get<{ name: string; archived: number }>('SELECT name, archived FROM services WHERE id = ?', id);
      if (!s || s.archived) continue;
      const states = monitorStates(id);
      const maintenance = listMaintenance(
        { target: `service:${id}`, from: new Date(now).toISOString(), to: new Date(now + 14 * 86_400_000).toISOString() },
        now,
      )
        .occurrences.slice(0, 10)
        .map((o) => ({ title: o.title, startsAt: o.startsAt, endsAt: o.endsAt, active: o.active }));
      const counts: Partial<Record<ServiceState, number>> = {};
      for (const x of states) counts[x] = (counts[x] ?? 0) + 1;
      let state = worst(states);
      if (state === 'operational' && maintenance.some((m) => m.active)) state = 'maintenance';
      const objectives = r.show_objectives
        ? listObjectives({ serviceId: id }, now).map((o) => {
            const w = o.windows.find((x) => x.window === 'd30') ?? o.windows[0];
            return {
              name: o.name,
              window: w?.window ?? 'd30',
              value: w?.value ?? null,
              target: w?.target ?? 0,
              met: w?.value == null ? null : w.value >= w.target,
            };
          })
        : [];
      const vendorIssues = r.show_vendor_issues
        ? listTickets({ link: `service:${id}`, state: 'open' }, now)
            .filter((t) => isTicketOpen(t.status) && (t.status === 'waitingVendor' || t.vendorSource) && t.vendor.trim())
            .map((t) => ({ vendor: t.vendor.trim(), since: t.openedAt }))
        : [];
      services.push({ name: s.name, state, monitors: counts, maintenance, objectives, vendorIssues });
    }
    const all = services.map((s) => s.state);
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      notice: r.notice,
      noticeLevel: r.notice_level,
      state: services.length ? worst(all.filter((x) => x !== 'unknown').length ? all.filter((x) => x !== 'unknown') : all) : 'unknown',
      generatedAt: new Date(now).toISOString(),
      services,
    };
  });
}

/** For signed-in users and status viewers. */
export function viewPage(id: string): StatusPageView {
  me();
  return build(rowOf(id));
}

const linkViews = new Map<string, number>();

/** Without signing in: the page whose secret link this is; anything else answers like a missing page. */
export function viewByToken(token: string, ip: string): StatusPageView {
  const r = /^[A-Za-z0-9_-]{20,64}$/.test(token) ? db().get<Row>('SELECT * FROM status_pages WHERE link_hash = ?', hashOf(token)) : undefined;
  if (!r) throw new HttpError(404, 'Status page not found', 'STATUS_PAGE_NOT_FOUND', { id: '' });
  // who opened the link, without filling the audit log: once per page and address per hour
  const key = `${r.id}|${ip}`;
  const last = linkViews.get(key);
  if (last === undefined || Date.now() - last > 3_600_000) {
    linkViews.set(key, Date.now());
    if (linkViews.size > 10_000) linkViews.clear();
    audit({
      actor: 'anonymous',
      action: 'status_page.viewed_by_link',
      entityType: 'status_page',
      entityId: r.id,
      summary: `Status page "${r.title}" opened with its link`,
      details: { ip },
    });
  }
  return build(r);
}
