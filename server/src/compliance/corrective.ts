import {
  CA_LIMITS,
  CA_OPEN_STATUSES,
  caActionInput,
  caActionUpdate,
  caEffectivenessInput,
  caFindingInput,
  caFindingUpdate,
  type CaAction,
  type CaControlRef,
  type CaFinding,
  type CaFindingList,
  type CaFindingSummary,
  type CaSeverity,
  type CaSource,
  type CaSourceRef,
  type CaStatus,
} from '@sm/shared';
import type { z } from 'zod';
import { db } from '../db.js';
import { audit } from '../audit.js';
import type { AuthUser } from '../auth/context.js';
import { hasRole, isAdmin, matches } from '../auth/permissions.js';
import { assertKnownSubjects } from '../auth/subjects.js';
import { findUserByName } from '../auth/users.js';
import { checkFourEyes, fourEyesRequired } from '../auth/assurance.js';
import { canEditService, canReadRecordRow, canViewCatalogue } from '../records/access.js';
import { instanceTimeZone, localDate } from '../duties/periods.js';
import { likeEscape } from '../database/sql.js';
import { resolveSupplierLink, supplierVisible } from '../suppliers/links.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { forbid, me, readsEverything, same } from './access.js';
import { backToInProgress, noteParticipants, participantNames, participantsOf, takesPart } from './corrective-participants.js';

/**
 * The register of corrective actions (ISO/IEC 27001 clause 10.2, ADR 0029 part 3, docs/COMPLIANCE.md#corrective-actions):
 * findings with their actions and the effectiveness check by a second person (control point correctiveAction.verify).
 * Suggestions and their sources: corrective-sources.ts; reminders and the dataset: corrective-jobs.ts.
 *
 * Who may do what (ADR 0029, _Permissions and audit_):
 * - see findings: administrators, auditors, designers, approvers, the owner of a finding or of one of its actions, and
 *   whoever may edit the affected service;
 * - record and change findings: designers, administrators and whoever may edit the affected service; the owners of an
 *   action mark it done;
 * - check the effectiveness: approvers, designers, administrators – not anyone who took part in the fix: the finding's
 *   owners, the owners of its actions (a team: its members), who marked an action done, who removed or changed one after
 *   it was implemented – kept for good (corrective-participants.ts; four-eyes required by default);
 * - cancel a finding: administrators, with a reason.
 *
 * A finding of an incident review reads the review's measures as its actions (ADR 0029 decision 5): they stay in
 * record_measures with their reminders and /api/v1/measures; adding an action there adds a measure to the review, and
 * the review's rules for its measures apply.
 */

export interface FindingRow {
  id: string;
  number: string;
  title: string;
  description: string;
  source: CaSource;
  source_kind: string | null;
  source_id: string | null;
  source_label: string;
  service_id: string | null;
  supplier_id: string | null;
  control_ids: string;
  record_id: string | null;
  severity: CaSeverity;
  owner: string | null;
  due_date: string | null;
  cause: string;
  status: CaStatus;
  eff_method: string | null;
  eff_result: string | null;
  eff_note: string | null;
  eff_checked_by: string | null;
  eff_checked_at: string | null;
  grc_ref: string;
  grc_url: string;
  cancel_reason: string;
  suggestion_id: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  closed_at: string | null;
  closed_by: string | null;
  /** Everyone who took part in the fix (JSON list of subjects, only ever grows: corrective-participants.ts) */
  fix_participants: string;
}

interface ActionRow {
  id: string;
  finding_id: string;
  title: string;
  owners: string;
  due_date: string;
  note: string;
  done_at: string | null;
  done_by: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

/** An action as the register counts it: its own (ca_actions) or a measure of the incident review (record_measures). */
interface Work {
  owners: string[];
  dueDate: string;
  doneAt: string | null;
  doneBy: string | null;
}

interface ServiceRef {
  id: string;
  name: string;
  owners: string[];
}

export const CORRECTIVE_POINT = 'correctiveAction.verify';
const READS_ALL = ['admin', 'auditor', 'designer', 'approver'];
const CHECKERS = ['admin', 'designer', 'approver'];
const FINAL: readonly CaStatus[] = ['closed', 'cancelled'];

/** Today in the instance's time zone (YYYY-MM-DD): dates are calendar dates, as for cost plans. */
export function caToday(now = Date.now()): string {
  const p = localDate(now, instanceTimeZone());
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

// ---------- context: services, actions and measures, loaded once per request ----------

export class CaContext {
  private services?: Map<string, ServiceRef>;
  private suppliers?: Map<string, { id: string; name: string; owners: string }>;
  private work?: Map<string, Work[]>;
  private controls = new Map<string, CaControlRef | null>();
  readonly day = caToday();

  service(id: string | null): ServiceRef | undefined {
    if (!id) return undefined;
    this.services ??= new Map(
      db()
        .all<{ id: string; name: string; owners: string }>('SELECT id, name, owners FROM services')
        .map((s) => [s.id, { id: s.id, name: s.name, owners: parseJson<string[]>(s.owners, []) }]),
    );
    return this.services.get(id);
  }

  /** The name of a supplier the reader may see (team scope like systems); null otherwise. */
  supplierName(id: string | null): string | null {
    if (!id) return null;
    this.suppliers ??= new Map(
      db()
        .all<{ id: string; name: string; owners: string }>('SELECT id, name, owners FROM suppliers')
        .map((s) => [s.id, s]),
    );
    const s = this.suppliers.get(id);
    return s && supplierVisible(s) ? s.name : null;
  }

  /** The actions of a finding as the register counts them (own actions, or the measures of its incident review). */
  workOf(f: Pick<FindingRow, 'id' | 'record_id'>): Work[] {
    if (!this.work) {
      this.work = new Map();
      const add = (key: string, w: Work) => {
        const l = this.work!.get(key);
        if (l) l.push(w);
        else this.work!.set(key, [w]);
      };
      for (const a of db().all<{ finding_id: string; owners: string; due_date: string; done_at: string | null; done_by: string | null }>(
        'SELECT finding_id, owners, due_date, done_at, done_by FROM ca_actions',
      ))
        add(a.finding_id, { owners: parseJson<string[]>(a.owners, []), dueDate: a.due_date, doneAt: a.done_at, doneBy: a.done_by });
      for (const m of db().all<{ record_id: string; owners: string; due_date: string; done_at: string | null; done_by: string | null }>(
        'SELECT record_id, owners, due_date, done_at, done_by FROM record_measures WHERE record_id IN (SELECT record_id FROM ca_findings WHERE record_id IS NOT NULL)',
      ))
        add(`record:${m.record_id}`, { owners: parseJson<string[]>(m.owners, []), dueDate: m.due_date, doneAt: m.done_at, doneBy: m.done_by });
    }
    return this.work.get(f.record_id ? `record:${f.record_id}` : f.id) ?? [];
  }

  controlRefs(ids: string[]): CaControlRef[] {
    const missing = ids.filter((id) => !this.controls.has(id));
    for (let i = 0; i < missing.length; i += 200) {
      const chunk = missing.slice(i, i + 200);
      const rows = db().all<{ id: string; ref: string; title: string; key: string }>(
        `SELECT c.id, c.ref, c.title, k.key FROM controls c JOIN control_catalogues k ON k.id = c.catalogue_id WHERE c.id IN (${chunk.map(() => '?').join(', ')})`,
        ...chunk,
      );
      const found = new Map(rows.map((r) => [r.id, { id: r.id, ref: r.ref, title: r.title, catalogueKey: r.key }]));
      for (const id of chunk) this.controls.set(id, found.get(id) ?? null);
    }
    return ids.map((id) => this.controls.get(id)).filter((c): c is CaControlRef => !!c);
  }
}

// ---------- rights ----------

const editsService = (u: AuthUser, s: ServiceRef | undefined) => !!s && canEditService(u, { kind: 'service', id: s.id, owners: s.owners });

/** Record findings at all: designers, administrators and whoever may edit a service. */
export function canRecordFindings(u: AuthUser): boolean {
  if (hasRole(u, ['admin', 'designer'])) return true;
  return db()
    .all<{ id: string; owners: string }>('SELECT id, owners FROM services WHERE archived = 0')
    .some((s) => canEditService(u, { kind: 'service', id: s.id, owners: parseJson<string[]>(s.owners, []) }));
}

export function canReadFinding(u: AuthUser, f: FindingRow, ctx: CaContext): boolean {
  if (hasRole(u, READS_ALL) || same(f.owner, u.username)) return true;
  if (ctx.workOf(f).some((w) => w.owners.some((s) => matches(u, s)))) return true;
  return editsService(u, ctx.service(f.service_id));
}

/** Change a finding and its actions: designers, administrators, the service's editors – while it is not closed or cancelled. */
export function canEditFinding(u: AuthUser, f: FindingRow, ctx: CaContext): boolean {
  if (FINAL.includes(f.status)) return false;
  return hasRole(u, ['admin', 'designer']) || editsService(u, ctx.service(f.service_id));
}

/** Who takes part in the fix now: the finding's owner, the owners of its actions (subjects), who marked an action done. */
function currentPart(f: FindingRow, ctx: CaContext): string[] {
  const out: string[] = [];
  if (f.owner) out.push(f.owner);
  for (const w of ctx.workOf(f)) {
    out.push(...w.owners);
    if (w.doneBy) out.push(w.doneBy);
  }
  return out;
}

/** Everyone who took part in the fix: kept on the finding for good, and who takes part now (subjects). */
const partOfFix = (f: FindingRow, ctx: CaContext): string[] => participantsOf(f.fix_participants, currentPart(f, ctx));

// ---------- reading ----------

const findingRow = (idOrNumber: string): FindingRow | undefined =>
  db().get<FindingRow>('SELECT * FROM ca_findings WHERE id = ? OR number = ?', idOrNumber, idOrNumber);

/** A finding the signed-in person may read; 404 otherwise (as if it did not exist). */
export function readableFinding(idOrNumber: string, ctx = new CaContext(), u = me()): FindingRow {
  const f = findingRow(idOrNumber);
  if (!f || !canReadFinding(u, f, ctx)) throw new HttpError(404, `Finding ${idOrNumber} not found`, 'CA_FINDING_NOT_FOUND', { id: idOrNumber });
  return f;
}

function toSummary(f: FindingRow, ctx: CaContext, u: AuthUser): CaFindingSummary {
  const work = ctx.workOf(f);
  const open = work.filter((w) => !w.doneAt);
  const s = ctx.service(f.service_id);
  const active = f.status === 'open' || f.status === 'inProgress';
  return {
    id: f.id,
    number: f.number,
    title: f.title,
    source: f.source,
    severity: f.severity,
    status: f.status,
    serviceId: f.service_id,
    serviceName: s && canViewCatalogue(u, { kind: 'service', id: s.id, owners: s.owners }) ? s.name : null,
    supplierId: f.supplier_id,
    supplierName: ctx.supplierName(f.supplier_id),
    owner: f.owner,
    dueDate: f.due_date,
    overdue: active && ((!!f.due_date && f.due_date < ctx.day) || open.some((w) => w.dueDate < ctx.day)),
    actionsOpen: open.length,
    actionsTotal: work.length,
    controls: ctx.controlRefs(parseJson<string[]>(f.control_ids, [])),
    createdAt: f.created_at,
    updatedAt: f.updated_at,
    closedAt: f.closed_at,
  };
}

/** What a finding or suggestion came from, as the reader may see it. */
export function sourceRef(kind: string | null, id: string | null, label: string, u: AuthUser): CaSourceRef | null {
  if (!kind) return null;
  if (kind === 'url') return { kind, id: null, label: label || id || '', path: id && /^https?:\/\//i.test(id) ? id : null, visible: true };
  if (!id) return { kind, id: null, label, path: null, visible: true };
  if (kind === 'duty') {
    const d = db().get<{ service_id: string }>('SELECT service_id FROM service_duties WHERE id = ?', id);
    const s = d && db().get<{ id: string; owners: string }>('SELECT id, owners FROM services WHERE id = ?', d.service_id);
    const visible = !!s && canViewCatalogue(u, { kind: 'service', id: s.id, owners: parseJson<string[]>(s.owners, []) });
    return { kind, id: visible ? id : null, label, path: visible ? `/duties/${id}` : null, visible };
  }
  if (kind === 'record') {
    const r = db().get<{ id: string; type_id: string; fields: string; owner: string }>('SELECT id, type_id, fields, owner FROM records WHERE id = ?', id);
    const visible = !!r && canReadRecordRow(u, r);
    return { kind, id: visible ? id : null, label, path: visible ? `/records/${id}` : null, visible };
  }
  if (kind === 'personReview') {
    const visible = readsEverything(u) || hasRole(u, ['approver', 'designer']);
    return { kind, id: visible ? id : null, label, path: visible ? `/compliance/person-reviews/${id}` : null, visible };
  }
  if (kind === 'supplier') {
    const r = db().get<{ id: string; owners: string }>('SELECT id, owners FROM suppliers WHERE id = ?', id);
    const visible = !!r && canViewCatalogue(u, { kind: 'supplier', id: r.id, owners: parseJson<string[]>(r.owners, []) });
    return { kind, id: visible ? id : null, label, path: visible ? `/suppliers/${id}` : null, visible };
  }
  if (kind === 'accessCheck') {
    const visible = readsEverything(u) || hasRole(u, ['designer', 'operator']);
    return { kind, id: visible ? id : null, label, path: visible ? `/compliance/reconciliation?check=${encodeURIComponent(id)}` : null, visible };
  }
  return { kind, id, label, path: null, visible: true };
}

export interface FindingFilter {
  state?: 'open' | 'closed' | 'all';
  status?: CaStatus[];
  source?: CaSource[];
  severity?: CaSeverity[];
  serviceId?: string;
  supplierId?: string;
  controlId?: string;
  overdue?: boolean;
  /** user:<name> / team:<name> or "me": the finding's owner or an action's owner */
  owner?: string;
  q?: string;
}

/** The findings the signed-in person may read, newest first. */
export function listFindingSummaries(f: FindingFilter = {}, ctx = new CaContext(), u = me()): CaFindingSummary[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.status?.length) {
    where.push(`status IN (${f.status.map(() => '?').join(', ')})`);
    args.push(...f.status);
  } else if (f.state === 'open' || f.state === 'closed') {
    const st = f.state === 'open' ? CA_OPEN_STATUSES : FINAL;
    where.push(`status IN (${st.map(() => '?').join(', ')})`);
    args.push(...st);
  }
  if (f.source?.length) {
    where.push(`source IN (${f.source.map(() => '?').join(', ')})`);
    args.push(...f.source);
  }
  if (f.severity?.length) {
    where.push(`severity IN (${f.severity.map(() => '?').join(', ')})`);
    args.push(...f.severity);
  }
  if (f.serviceId) {
    where.push('service_id = ?');
    args.push(f.serviceId);
  }
  if (f.supplierId) {
    where.push('supplier_id = ?');
    args.push(f.supplierId);
  }
  if (f.controlId) {
    where.push(`lower(control_ids) LIKE lower(?) ESCAPE '\\'`);
    args.push(`%${likeEscape(JSON.stringify(f.controlId))}%`);
  }
  if (f.q?.trim()) {
    where.push(`(lower(title) LIKE lower(?) ESCAPE '\\' OR lower(number) LIKE lower(?) ESCAPE '\\')`);
    const like = `%${likeEscape(f.q.trim())}%`;
    args.push(like, like);
  }
  const rows = db().all<FindingRow>(
    `SELECT * FROM ca_findings ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, number DESC`,
    ...args,
  );
  const owner = f.owner === 'me' ? `user:${u.username.toLowerCase()}` : f.owner?.toLowerCase();
  return rows
    .filter((r) => !f.controlId || parseJson<string[]>(r.control_ids, []).includes(f.controlId))
    .filter((r) => canReadFinding(u, r, ctx))
    .filter((r) => !owner || owner === `user:${(r.owner ?? '').toLowerCase()}` || ctx.workOf(r).some((w) => w.owners.includes(owner)))
    .map((r) => toSummary(r, ctx, u))
    .filter((s) => f.overdue === undefined || s.overdue === f.overdue);
}

/** The register as the signed-in person sees it; `pending` counts the suggestions they may see (corrective-sources.ts). */
export function listFindings(f: FindingFilter, pending: (u: AuthUser) => number): CaFindingList {
  const u = me();
  return {
    items: listFindingSummaries(f, new CaContext(), u),
    canCreate: canRecordFindings(u),
    pendingSuggestions: pending(u),
    canManage: isAdmin(u),
  };
}

function actionsOf(f: FindingRow, u: AuthUser, ctx: CaContext): { items: CaAction[]; record: CaFinding['record'] } {
  const editable = canEditFinding(u, f, ctx);
  if (f.record_id) {
    const r = db().get<{ id: string; number: string; title: string; type_id: string; fields: string; owner: string; created_by: string }>(
      'SELECT id, number, title, type_id, fields, owner, created_by FROM records WHERE id = ?',
      f.record_id,
    );
    const visible = !!r && canReadRecordRow(u, r);
    if (!r || !visible) return { items: [], record: { id: f.record_id, number: r && visible ? r.number : '', title: '', visible: false } };
    // the review's rules for its measures (records/reviews.ts canEditMeasures)
    const editsMeasures = !FINAL.includes(f.status) && (hasRole(u, ['admin', 'designer']) || same(r.owner, u.username) || same(r.created_by, u.username));
    const items = db()
      .all<ActionRow & { record_id: string }>('SELECT * FROM record_measures WHERE record_id = ? ORDER BY due_date, created_at', r.id)
      .map((m) => toAction(m, ctx, u, editsMeasures, f, true));
    return { items, record: { id: r.id, number: r.number, title: r.title, visible: true } };
  }
  const items = db()
    .all<ActionRow>('SELECT * FROM ca_actions WHERE finding_id = ? ORDER BY due_date, created_at', f.id)
    .map((a) => toAction(a, ctx, u, editable, f, false));
  return { items, record: null };
}

function toAction(a: ActionRow, ctx: CaContext, u: AuthUser, canEdit: boolean, f: FindingRow, measure: boolean): CaAction {
  const owners = parseJson<string[]>(a.owners, []);
  return {
    id: a.id,
    title: a.title,
    owners,
    dueDate: a.due_date,
    note: a.note,
    doneAt: a.done_at,
    doneBy: a.done_by,
    overdue: !a.done_at && a.due_date < ctx.day,
    measure,
    createdAt: a.created_at,
    createdBy: a.created_by,
    canEdit,
    canMarkDone: !FINAL.includes(f.status) && (canEdit || owners.some((s) => matches(u, s))),
  };
}

export function toFinding(f: FindingRow, ctx = new CaContext(), u = me()): CaFinding {
  const { items, record } = actionsOf(f, u, ctx);
  const checker = hasRole(u, CHECKERS);
  const fourEyes = fourEyesRequired(CORRECTIVE_POINT);
  const ownPart = fourEyes && takesPart(u, partOfFix(f, ctx));
  const verifyBlocked = !checker ? null : f.status !== 'implemented' ? 'notImplemented' : ownPart ? 'ownPart' : null;
  const editable = canEditFinding(u, f, ctx);
  return {
    ...toSummary(f, ctx, u),
    description: f.description,
    cause: f.cause,
    sourceRef: sourceRef(f.source_kind, f.source_id, f.source_label, u),
    record,
    grcRef: f.grc_ref,
    grcUrl: f.grc_url,
    effectiveness:
      f.eff_checked_at && f.eff_result
        ? {
            method: f.eff_method ?? '',
            result: f.eff_result === 'effective' ? 'effective' : 'notEffective',
            note: f.eff_note ?? '',
            checkedBy: f.eff_checked_by ?? '',
            checkedAt: f.eff_checked_at,
          }
        : null,
    cancelReason: f.cancel_reason,
    suggestionId: f.suggestion_id,
    actions: items,
    createdBy: f.created_by,
    updatedBy: f.updated_by,
    closedBy: f.closed_by,
    permissions: {
      edit: editable,
      // an incident finding's actions are the review's measures: the review's editors add them
      addActions: f.record_id ? !FINAL.includes(f.status) && !!record?.visible && items.length < CA_LIMITS.actionsPerFinding && measureEditor(u, f) : editable,
      cancel: isAdmin(u) && !FINAL.includes(f.status),
      verify: checker && verifyBlocked === null,
      verifyBlocked,
      fourEyes,
    },
  };
}

function measureEditor(u: AuthUser, f: FindingRow): boolean {
  const r = f.record_id ? db().get<{ owner: string; created_by: string }>('SELECT owner, created_by FROM records WHERE id = ?', f.record_id) : undefined;
  return !!r && (hasRole(u, ['admin', 'designer']) || same(r.owner, u.username) || same(r.created_by, u.username));
}

export function getFinding(idOrNumber: string): CaFinding {
  const ctx = new CaContext();
  return toFinding(readableFinding(idOrNumber, ctx), ctx);
}

// ---------- recording and changing ----------

function checkService(u: AuthUser, serviceId: string | null, ctx: CaContext): void {
  if (!serviceId) return;
  const s = ctx.service(serviceId);
  if (!s || !canViewCatalogue(u, { kind: 'service', id: s.id, owners: s.owners }))
    throw new HttpError(400, `Service ${serviceId} not found`, 'CA_SERVICE_UNKNOWN', { id: serviceId });
}

function checkControls(ids: string[], ctx: CaContext): void {
  const found = new Set(ctx.controlRefs(ids).map((c) => c.id));
  const missing = ids.find((id) => !found.has(id));
  if (missing) throw new HttpError(400, `Control ${missing} not found`, 'CA_CONTROL_UNKNOWN', { id: missing });
}

function checkOwner(owner: string | null): string | null {
  if (!owner) return null;
  const user = findUserByName(owner);
  if (!user) throw new HttpError(400, `User "${owner}" does not exist`, 'USER_UNKNOWN', { name: owner });
  return user.username;
}

function nextNumber(day: string): string {
  const prefix = `CA-${day.slice(0, 4)}-`;
  const last = db().get<{ number: string }>(
    `SELECT number FROM ca_findings WHERE lower(number) LIKE lower(?) ESCAPE '\\' ORDER BY LENGTH(number) DESC, number DESC LIMIT 1`,
    `${likeEscape(prefix)}%`,
  );
  const n = last ? Number(last.number.slice(prefix.length)) || 0 : 0;
  return `${prefix}${String(n + 1).padStart(4, '0')}`;
}

/** What a new finding is, before it is stored (by hand, or from a confirmed suggestion). */
export interface NewFinding {
  title: string;
  description: string;
  severity: CaSeverity;
  serviceId: string | null;
  /** A supplier the person may see (checked here); null: none */
  supplierId: string | null;
  controlIds: string[];
  owner: string | null;
  dueDate: string | null;
  cause: string;
  grcRef: string;
  grcUrl: string;
  source: CaSource;
  sourceKind: string | null;
  sourceId: string | null;
  sourceLabel: string;
  recordId: string | null;
  suggestionId: string | null;
}

/** Stores a finding (in the caller's transaction for a confirmed suggestion); checks the rights and the limit. */
export function insertFinding(n: NewFinding, ctx = new CaContext(), u = me()): FindingRow {
  if (!hasRole(u, ['admin', 'designer']) && !editsService(u, ctx.service(n.serviceId)))
    forbid('record findings of corrective actions (designers, administrators and the editors of the service)', 'recordCorrective');
  checkService(u, n.serviceId, ctx);
  const supplierId = resolveSupplierLink(n.supplierId, null);
  checkControls(n.controlIds, ctx);
  const owner = checkOwner(n.owner);
  if (Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM ca_findings')!.n) >= CA_LIMITS.findings)
    throw new HttpError(400, `At most ${CA_LIMITS.findings} findings`, 'CA_FINDING_LIMIT', { max: CA_LIMITS.findings });
  const id = newId('caf_');
  const now = nowIso();
  // who takes part from the start: the owner, and for an incident review the owners of its measures and who did them
  const measures = n.recordId
    ? db().all<{ owners: string; done_by: string | null }>('SELECT owners, done_by FROM record_measures WHERE record_id = ?', n.recordId)
    : [];
  db().tx(() => {
    const number = nextNumber(ctx.day);
    db().run(
      `INSERT INTO ca_findings (id, number, title, description, source, source_kind, source_id, source_label, service_id, supplier_id, control_ids, record_id,
         severity, owner, due_date, cause, status, grc_ref, grc_url, suggestion_id, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
      id,
      number,
      n.title,
      n.description,
      n.source,
      n.sourceKind,
      n.sourceId,
      n.sourceLabel,
      n.serviceId,
      supplierId,
      JSON.stringify(n.controlIds),
      n.recordId,
      n.severity,
      owner,
      n.dueDate,
      n.cause,
      n.grcRef,
      n.grcUrl,
      n.suggestionId,
      now,
      u.username,
      now,
      u.username,
    );
    noteParticipants(id, [owner, ...measures.flatMap((m) => [...parseJson<string[]>(m.owners, []), m.done_by])]);
    audit({
      action: 'corrective.finding_created',
      entityType: 'corrective_finding',
      entityId: id,
      summary: `Finding ${number} "${n.title}" recorded (${n.severity}, source ${n.source})`,
      details: {
        number,
        source: n.source,
        severity: n.severity,
        serviceId: n.serviceId,
        supplierId,
        controlIds: n.controlIds,
        owner,
        dueDate: n.dueDate,
        recordId: n.recordId,
        suggestionId: n.suggestionId,
      },
    });
  });
  return db().get<FindingRow>('SELECT * FROM ca_findings WHERE id = ?', id)!;
}

export function createFinding(input: z.input<typeof caFindingInput>): CaFinding {
  const v = caFindingInput.parse(input);
  const ctx = new CaContext();
  const f = insertFinding(
    {
      ...v,
      sourceKind: v.sourceUrl || v.sourceLabel ? 'url' : null,
      sourceId: v.sourceUrl || null,
      sourceLabel: v.sourceLabel,
      recordId: null,
      suggestionId: null,
    },
    ctx,
  );
  return toFinding(f, new CaContext());
}

const FIELD_COLUMNS = {
  title: 'title',
  description: 'description',
  severity: 'severity',
  serviceId: 'service_id',
  supplierId: 'supplier_id',
  owner: 'owner',
  dueDate: 'due_date',
  cause: 'cause',
  grcRef: 'grc_ref',
  grcUrl: 'grc_url',
} as const;

export function updateFinding(id: string, input: z.input<typeof caFindingUpdate>): CaFinding {
  const u = me();
  const v = caFindingUpdate.parse(input);
  const ctx = new CaContext();
  const f = readableFinding(id, ctx, u);
  if (FINAL.includes(f.status)) throw new HttpError(409, `Finding ${f.number} is ${f.status}`, 'CA_FINDING_FINAL', { number: f.number, status: f.status });
  if (!canEditFinding(u, f, ctx)) forbid('change this finding', 'editCorrective');
  if (v.serviceId !== undefined && v.serviceId !== f.service_id) {
    checkService(u, v.serviceId, ctx);
    // moving a finding to another service: also an editor there (or a designer or administrator)
    if (!hasRole(u, ['admin', 'designer']) && !editsService(u, ctx.service(v.serviceId))) forbid('move this finding to that service', 'editCorrective');
  }
  // a supplier the person may see (a linked one they may not see stays while the field is not sent)
  if (v.supplierId !== undefined && v.supplierId !== f.supplier_id) v.supplierId = resolveSupplierLink(v.supplierId, f.supplier_id);
  if (v.controlIds) checkControls(v.controlIds, ctx);
  if (v.owner !== undefined) v.owner = checkOwner(v.owner);
  if (v.status && v.status !== f.status && v.status === 'implemented') {
    const work = ctx.workOf(f);
    if (!work.length) throw new HttpError(409, 'Add an action before the finding is implemented', 'CA_NO_ACTIONS');
    const open = work.filter((w) => !w.doneAt).length;
    if (open) throw new HttpError(409, `${open} action(s) are not done yet`, 'CA_ACTIONS_OPEN', { count: open });
  }
  const sets: string[] = [];
  const args: unknown[] = [];
  const changed: string[] = [];
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [key, col] of Object.entries(FIELD_COLUMNS) as [keyof typeof FIELD_COLUMNS, string][]) {
    const val = v[key];
    if (val === undefined || val === (f as unknown as Record<string, unknown>)[col]) continue;
    sets.push(`${col} = ?`);
    args.push(val);
    changed.push(key);
    before[key] = (f as unknown as Record<string, unknown>)[col];
    after[key] = val;
  }
  if (v.controlIds && JSON.stringify(v.controlIds) !== JSON.stringify(parseJson<string[]>(f.control_ids, []))) {
    sets.push('control_ids = ?');
    args.push(JSON.stringify(v.controlIds));
    changed.push('controlIds');
    before.controlIds = parseJson<string[]>(f.control_ids, []);
    after.controlIds = v.controlIds;
  }
  const ownerChanged = changed.includes('owner');
  // a new owner of an implemented finding: the fix goes back to "in progress" (security review 0.17.0, M2)
  if (ownerChanged && f.status === 'implemented' && (!v.status || v.status === 'implemented')) v.status = 'inProgress';
  if (v.status && v.status !== f.status) {
    sets.push('status = ?');
    args.push(v.status);
    changed.push('status');
    before.status = f.status;
    after.status = v.status;
  }
  if (!sets.length) return toFinding(f, ctx, u);
  const now = nowIso();
  db().tx(() => {
    db().run(`UPDATE ca_findings SET ${sets.join(', ')}, updated_at = ?, updated_by = ? WHERE id = ?`, ...args, now, u.username, f.id);
    // who takes part: every owner it has had (and who changed the owner of an implemented one), and everyone in the fix
    // as it stands when it is implemented
    if (ownerChanged) noteParticipants(f.id, [f.owner, v.owner, f.status === 'implemented' ? u.username : null]);
    if (after.status === 'implemented') noteParticipants(f.id, currentPart({ ...f, owner: v.owner === undefined ? f.owner : v.owner }, ctx));
    audit({
      action: 'corrective.finding_changed',
      entityType: 'corrective_finding',
      entityId: f.id,
      summary: `Finding ${f.number} changed: ${changed.join(', ')}${after.status ? ` (status ${f.status} → ${String(after.status)})` : ''}`,
      details: { number: f.number, fields: changed, before, after },
    });
  });
  return getFinding(f.id);
}

/** Moves a finding back to "in progress" (an action reopened or added after it was implemented), or on from "open". */
function touchStatus(f: FindingRow, to: 'inProgress', why: string, u: AuthUser): void {
  // as stored now: a measure of the incident review may have moved it already (corrective-participants.ts)
  const status = db().get<{ status: CaStatus }>('SELECT status FROM ca_findings WHERE id = ?', f.id)?.status ?? f.status;
  if (status === to || FINAL.includes(status)) return;
  f = { ...f, status };
  db().run('UPDATE ca_findings SET status = ?, updated_at = ?, updated_by = ? WHERE id = ?', to, nowIso(), u.username, f.id);
  audit({
    action: 'corrective.finding_changed',
    entityType: 'corrective_finding',
    entityId: f.id,
    summary: `Finding ${f.number}: status ${f.status} → ${to} (${why})`,
    details: { number: f.number, fields: ['status'], before: { status: f.status }, after: { status: to }, why },
  });
}

// ---------- actions ----------

function editableFinding(id: string, u: AuthUser, ctx: CaContext): FindingRow {
  const f = readableFinding(id, ctx, u);
  if (FINAL.includes(f.status)) throw new HttpError(409, `Finding ${f.number} is ${f.status}`, 'CA_FINDING_FINAL', { number: f.number, status: f.status });
  return f;
}

export async function addAction(findingId: string, input: z.input<typeof caActionInput>): Promise<CaFinding> {
  const u = me();
  const v = caActionInput.parse(input);
  const ctx = new CaContext();
  const f = editableFinding(findingId, u, ctx);
  if (ctx.workOf(f).length >= CA_LIMITS.actionsPerFinding)
    throw new HttpError(400, `At most ${CA_LIMITS.actionsPerFinding} actions per finding`, 'CA_ACTION_LIMIT', { max: CA_LIMITS.actionsPerFinding });
  if (f.record_id) {
    // an incident finding: the action is a measure of the review (the review's rules apply)
    const { addMeasure } = await import('../records/reviews.js');
    addMeasure(f.record_id, { title: v.title, owners: v.owners, dueDate: v.dueDate, note: v.note, done: v.done });
    const m = db().get<{ id: string }>(
      'SELECT id FROM record_measures WHERE record_id = ? AND created_by = ? ORDER BY created_at DESC, id DESC LIMIT 1',
      f.record_id,
      u.username,
    );
    db().tx(() => {
      audit({
        action: 'corrective.action_added',
        entityType: 'corrective_finding',
        entityId: f.id,
        summary: `Action "${v.title}" added to ${f.number} as a measure of its incident review (due ${v.dueDate})`,
        details: { number: f.number, measureId: m?.id ?? null, recordId: f.record_id, owners: v.owners, dueDate: v.dueDate },
      });
      if (!v.done) touchStatus(f, 'inProgress', 'an action was added', u);
    });
    return getFinding(f.id);
  }
  if (!canEditFinding(u, f, ctx)) forbid('change the actions of this finding', 'editCorrective');
  assertKnownSubjects(v.owners);
  const now = nowIso();
  const id = newId('caa_');
  db().tx(() => {
    db().run(
      `INSERT INTO ca_actions (id, finding_id, title, owners, due_date, note, done_at, done_by, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      f.id,
      v.title,
      JSON.stringify(v.owners),
      v.dueDate,
      v.note,
      v.done ? now : null,
      v.done ? u.username : null,
      now,
      u.username,
      now,
      u.username,
    );
    audit({
      action: 'corrective.action_added',
      entityType: 'corrective_finding',
      entityId: f.id,
      summary: `Action "${v.title}" added to ${f.number} (due ${v.dueDate})`,
      details: { number: f.number, actionId: id, owners: v.owners, dueDate: v.dueDate, done: !!v.done },
    });
    noteParticipants(f.id, [...v.owners, v.done ? u.username : null, f.status === 'implemented' ? u.username : null]);
    if (!v.done) touchStatus(f, 'inProgress', 'an action was added', u);
  });
  return getFinding(f.id);
}

export async function updateAction(findingId: string, actionId: string, input: z.input<typeof caActionUpdate>): Promise<CaFinding> {
  const u = me();
  const v = caActionUpdate.parse(input);
  const ctx = new CaContext();
  const f = editableFinding(findingId, u, ctx);
  if (f.record_id) {
    const m = db().get<ActionRow>('SELECT * FROM record_measures WHERE id = ? AND record_id = ?', actionId, f.record_id);
    if (!m) throw new HttpError(404, `Action ${actionId} not found`, 'CA_ACTION_NOT_FOUND', { id: actionId });
    const { updateMeasure } = await import('../records/reviews.js');
    updateMeasure(f.record_id, actionId, v);
    auditActionChange(f, m, v, u, true);
    return getFinding(f.id);
  }
  const a = db().get<ActionRow>('SELECT * FROM ca_actions WHERE id = ? AND finding_id = ?', actionId, f.id);
  if (!a) throw new HttpError(404, `Action ${actionId} not found`, 'CA_ACTION_NOT_FOUND', { id: actionId });
  const editor = canEditFinding(u, f, ctx);
  // the owners of an action who are not editors mark it done (or not) and change its note
  const onlyOwnerFields = Object.keys(v).every((k) => k === 'done' || k === 'note');
  if (!editor && !(parseJson<string[]>(a.owners, []).some((s) => matches(u, s)) && onlyOwnerFields)) forbid('change this action', 'editCorrective');
  if (v.owners) assertKnownSubjects(v.owners, parseJson<string[]>(a.owners, []));
  const now = nowIso();
  const done = v.done === undefined ? !!a.done_at : v.done;
  const ownersBefore = parseJson<string[]>(a.owners, []);
  const ownersChanged =
    !!v.owners && JSON.stringify(v.owners.map((x) => x.toLowerCase()).sort()) !== JSON.stringify(ownersBefore.map((x) => x.toLowerCase()).sort());
  db().tx(() => {
    // who takes part: every owner the action has had, who marked it done, and who changed it after the finding was implemented
    noteParticipants(f.id, [
      ...ownersBefore,
      ...(v.owners ?? []),
      a.done_by,
      done ? (a.done_by ?? u.username) : null,
      f.status === 'implemented' ? u.username : null,
    ]);
    if (ownersChanged) touchStatus(f, 'inProgress', "an action's owners changed", u);
    db().run(
      'UPDATE ca_actions SET title = ?, owners = ?, due_date = ?, note = ?, done_at = ?, done_by = ?, updated_at = ?, updated_by = ? WHERE id = ?',
      v.title ?? a.title,
      JSON.stringify(v.owners ?? parseJson<string[]>(a.owners, [])),
      v.dueDate ?? a.due_date,
      v.note ?? a.note,
      done ? (a.done_at ?? now) : null,
      done ? (a.done_by ?? u.username) : null,
      now,
      u.username,
      a.id,
    );
    auditActionChange(f, a, v, u, false);
  });
  return getFinding(f.id);
}

function auditActionChange(f: FindingRow, a: ActionRow, v: z.infer<typeof caActionUpdate>, u: AuthUser, measure: boolean): void {
  const wasDone = !!a.done_at;
  const done = v.done === undefined ? wasDone : v.done;
  const what = done !== wasDone ? (done ? 'done' : 'reopened') : 'changed';
  db().tx(() => {
    audit({
      action: what === 'done' ? 'corrective.action_done' : 'corrective.action_changed',
      entityType: 'corrective_finding',
      entityId: f.id,
      summary: `Action "${v.title ?? a.title}" of ${f.number} ${what === 'done' ? 'marked done' : what === 'reopened' ? 'reopened' : 'changed'}${measure ? ' (a measure of its incident review)' : ''}`,
      details: { number: f.number, [measure ? 'measureId' : 'actionId']: a.id, fields: Object.keys(v), reopened: what === 'reopened' },
    });
    if (what === 'reopened' && f.status === 'implemented') touchStatus(f, 'inProgress', 'an action was reopened', u);
  });
}

export async function deleteAction(findingId: string, actionId: string): Promise<CaFinding> {
  const u = me();
  const ctx = new CaContext();
  const f = editableFinding(findingId, u, ctx);
  if (f.record_id) {
    const m = db().get<ActionRow>('SELECT * FROM record_measures WHERE id = ? AND record_id = ?', actionId, f.record_id);
    if (!m) throw new HttpError(404, `Action ${actionId} not found`, 'CA_ACTION_NOT_FOUND', { id: actionId });
    const { deleteMeasure } = await import('../records/reviews.js');
    deleteMeasure(f.record_id, actionId);
    audit({
      action: 'corrective.action_removed',
      entityType: 'corrective_finding',
      entityId: f.id,
      summary: `Action "${m.title}" removed from ${f.number} (a measure of its incident review)`,
      details: { number: f.number, measureId: m.id, recordId: f.record_id },
    });
    return getFinding(f.id);
  }
  if (!canEditFinding(u, f, ctx)) forbid('change the actions of this finding', 'editCorrective');
  const a = db().get<ActionRow>('SELECT * FROM ca_actions WHERE id = ? AND finding_id = ?', actionId, f.id);
  if (!a) throw new HttpError(404, `Action ${actionId} not found`, 'CA_ACTION_NOT_FOUND', { id: actionId });
  db().tx(() => {
    db().run('DELETE FROM ca_actions WHERE id = ?', a.id);
    db().run('DELETE FROM ca_action_reminders WHERE action_id = ?', a.id);
    audit({
      action: 'corrective.action_removed',
      entityType: 'corrective_finding',
      entityId: f.id,
      summary: `Action "${a.title}" removed from ${f.number}`,
      details: { number: f.number, actionId: a.id },
    });
    // the action's people stay part of the fix; removing one from an implemented finding sends it back to "in progress"
    noteParticipants(f.id, [...parseJson<string[]>(a.owners, []), a.done_by, f.status === 'implemented' ? u.username : null]);
    if (f.status === 'implemented') backToInProgress(f.id, 'an action was removed', u.username);
  });
  return getFinding(f.id);
}

// ---------- effectiveness and cancelling ----------

/**
 * The effectiveness check (control point correctiveAction.verify): approvers, designers and administrators confirm
 * whether the fix worked – never anyone who took part in the fix (corrective-participants.ts) while four-eyes is
 * required (the default). Effective closes the finding; not effective sends it back to "in progress".
 */
export function checkEffectiveness(id: string, input: z.input<typeof caEffectivenessInput>): CaFinding {
  const u = me();
  const v = caEffectivenessInput.parse(input);
  const ctx = new CaContext();
  const f = readableFinding(id, ctx, u);
  if (!hasRole(u, CHECKERS)) forbid('check the effectiveness of corrective actions (approvers, designers, administrators)', 'verifyCorrective');
  if (f.status !== 'implemented')
    throw new HttpError(409, `Finding ${f.number} is not implemented yet`, 'CA_NOT_IMPLEMENTED', { number: f.number, status: f.status });
  // everyone who took part, kept for good: a member of an owning team counts as an owner
  const part = partOfFix(f, ctx);
  const fe = checkFourEyes(CORRECTIVE_POINT, [...participantNames(part), ...(takesPart(u, part) ? [u.username] : [])], u);
  if (!fe.ok)
    throw new HttpError(
      403,
      "A second person checks the effectiveness: not anyone who took part in the fix – the finding's owners, the owners of its actions (also as a team member), who marked an action done or changed one after it was implemented",
      'CA_FOUR_EYES',
    );
  const now = nowIso();
  const effective = v.result === 'effective';
  db().tx(() => {
    db().run(
      `UPDATE ca_findings SET status = ?, eff_method = ?, eff_result = ?, eff_note = ?, eff_checked_by = ?, eff_checked_at = ?,
         closed_at = ?, closed_by = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
      effective ? 'closed' : 'inProgress',
      v.method,
      v.result,
      v.note,
      u.username,
      now,
      effective ? now : null,
      effective ? u.username : null,
      now,
      u.username,
      f.id,
    );
    audit({
      action: 'corrective.effectiveness_checked',
      entityType: 'corrective_finding',
      entityId: f.id,
      summary: `Effectiveness of ${f.number} checked: ${effective ? 'effective' : 'not effective'} (${v.method.slice(0, 200)})`,
      details: { number: f.number, result: v.result, method: v.method, note: v.note, fourEyes: fe.required },
    });
    if (effective)
      audit({
        action: 'corrective.finding_closed',
        entityType: 'corrective_finding',
        entityId: f.id,
        summary: `Finding ${f.number} closed: the fix worked`,
        details: { number: f.number },
      });
  });
  return getFinding(f.id);
}

export function cancelFinding(id: string, reason: string): CaFinding {
  const u = me();
  const ctx = new CaContext();
  const f = readableFinding(id, ctx, u);
  if (!isAdmin(u)) forbid('cancel findings (administrators)', 'manageCorrective');
  if (FINAL.includes(f.status)) throw new HttpError(409, `Finding ${f.number} is ${f.status}`, 'CA_FINDING_FINAL', { number: f.number, status: f.status });
  const now = nowIso();
  db().tx(() => {
    db().run(
      "UPDATE ca_findings SET status = 'cancelled', cancel_reason = ?, closed_at = ?, closed_by = ?, updated_at = ?, updated_by = ? WHERE id = ?",
      reason,
      now,
      u.username,
      now,
      u.username,
      f.id,
    );
    audit({
      action: 'corrective.finding_cancelled',
      entityType: 'corrective_finding',
      entityId: f.id,
      summary: `Finding ${f.number} cancelled: ${reason.slice(0, 300)}`,
      details: { number: f.number, reason, status: f.status },
    });
  });
  return getFinding(f.id);
}

// ---------- evidence ----------

/** The findings that name one of these controls, as the reader may see them (evidence packs, the Controls page). */
export function findingsOfControls(controlIds: string[], u: AuthUser): CaFinding[] {
  const ids = new Set(controlIds);
  const ctx = new CaContext();
  return db()
    .all<FindingRow>("SELECT * FROM ca_findings WHERE control_ids <> '[]' ORDER BY number")
    .filter((f) => parseJson<string[]>(f.control_ids, []).some((c) => ids.has(c)) && canReadFinding(u, f, ctx))
    .map((f) => toFinding(f, ctx, u));
}
