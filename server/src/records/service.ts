import { z } from 'zod';
import {
  ACCESS_RECORD_TYPE,
  ACCESS_TYPE_ID,
  DEFAULT_RECORD_TYPES,
  DOCUMENT_RECORD_TYPE,
  EDITION_KINDS,
  isEditableStatus,
  normalizeTag,
  RECORD_WORKFLOWS,
  splitTag,
  tagInput,
  tagsMatch,
  type DocumentInfo,
  type EditionKind,
  type RecordActionInfo,
  type RecordDetail,
  type RecordEvent,
  type RecordFieldDef,
  type RecordPermissions,
  type RecordSummary,
  type RecordVersion,
  type RecordWorkflow,
  type ReviewStatus,
  INCIDENT_RECORD_TYPE,
} from '@sm/shared';
import { db } from '../db.js';
import { audit, authenticRows, importedHistoryFor } from '../audit.js';
import { currentActor, type AuthUser, currentUser } from '../auth/context.js';
import { findUserByName, getUser } from '../auth/users.js';
import { resolveLocale, t as tr, type MessageKey } from '../i18n/index.js';
import { getSettings } from '../settings.js';
import { isAdmin } from '../auth/permissions.js';
import { canDocumentAccessOn, isSubjectOf, isSystem } from '../compliance/access.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { likeEscape } from '../database/sql.js';
import {
  canApproveRecord,
  canCommentRecord,
  canCreateRecords,
  canEditRecord,
  canReadRecordRow,
  fieldParam,
  forbid,
  fourEyesReason,
  me,
  statusParam,
  type ActionReason,
} from './access.js';
import { attachmentRows, contentHash, recordRow, requireRecordRow, toAttachment, versionHash, type Content, type RecordRow } from './model.js';
import { requireType, toType, typeRow, type TypeRow } from './types.js';
import { addLink, listBacklinks, listLinks, type LinkInput } from './links.js';
import { emit } from '../events.js';
import { scopeOf } from '../catalogue/scope.js';
import {
  DOC_LIMITS,
  docRow,
  documentStates,
  editionRow,
  editionRows,
  editionMetaHash,
  ensureDocRow,
  intactEditions,
  isDocument,
  nextEditions,
  parseEdition,
  reviewState,
  reviewsOf,
  toEditionSummary,
  updateDocRow,
  type DocRow,
  type EditionRow,
} from './document-model.js';
import { assignCreatorTeams } from '../auth/policy.js';

/**
 * Records: numbered, versioned documents with a workflow (change requests,
 * decision records). The content (title, body, fields, attached files) can
 * only change in the draft status; leaving it freezes the content and records
 * its hash. "New revision" goes back to draft for rework. Every change is
 * audited with the content hash.
 */

export const LIMITS = {
  title: 300,
  body: 256 * 1024,
  field: 20000,
  tags: 30,
  tag: 161,
  comment: 4000,
};

export const workflowOf = (t: Pick<TypeRow, 'workflow'>): RecordWorkflow => RECORD_WORKFLOWS[t.workflow] ?? RECORD_WORKFLOWS.change;

const tagList = z.array(tagInput({ lower: true })).max(LIMITS.tags);
export const cleanTags = (tags: string[]): string[] => [...new Set(tagList.parse(tags).map((t) => t.toLowerCase()))].sort();

/** Fields as stored: only keys the type defines, values checked by kind, empty values dropped. */
export function cleanFields(
  defs: RecordFieldDef[],
  input: Record<string, unknown>,
  o: { dropUnknown?: boolean; typeKey?: string } = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  const byKey = new Map(defs.map((d) => [d.key, d]));
  for (const [k, raw] of Object.entries(input ?? {})) {
    const def = byKey.get(k);
    if (!def) {
      if (o.dropUnknown) continue;
      throw new HttpError(400, `Unknown field "${k}" for this record type`, 'RECORD_FIELD_UNKNOWN', { field: k });
    }
    if (raw === null || raw === undefined) continue;
    const field = fieldParam(o.typeKey, def);
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean')
      throw new HttpError(400, `Field "${def.label}" must be text`, 'RECORD_FIELD_TEXT', { field });
    const v = String(raw).trim();
    if (!v) continue;
    if (v.length > LIMITS.field)
      throw new HttpError(400, `Field "${def.label}" is too long (at most ${LIMITS.field} characters)`, 'RECORD_FIELD_TOO_LONG', { field, max: LIMITS.field });
    if (def.kind === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v))
      throw new HttpError(400, `Field "${def.label}" must be a date (YYYY-MM-DD)`, 'RECORD_FIELD_DATE', { field });
    if (def.kind === 'datetime' && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.test(v) || Number.isNaN(Date.parse(v)))) {
      throw new HttpError(400, `Field "${def.label}" must be a date and time (e.g. 2026-11-03T18:00)`, 'RECORD_FIELD_DATETIME', { field });
    }
    if (def.kind === 'select' && !(def.options ?? []).includes(v))
      throw new HttpError(400, `Field "${def.label}" must be one of ${(def.options ?? []).join(', ')}`, 'RECORD_FIELD_OPTION', {
        field,
        options: (def.options ?? []).join(', '),
      });
    if ((def.kind === 'text' || def.kind === 'select') && v.includes('\n'))
      throw new HttpError(400, `Field "${def.label}" must be a single line`, 'RECORD_FIELD_SINGLE_LINE', { field });
    out[k] = v;
  }
  return out;
}

// ---------- read ----------

interface Listed extends RecordRow {
  type_key: string;
  type_name: string;
  workflow: RecordSummary['workflow'];
}

const toSummary = (r: Listed, doc?: { edition: string | null; reviewStatus: ReviewStatus; nextReviewAt: string | null }): RecordSummary => ({
  id: r.id,
  number: r.number,
  typeId: r.type_id,
  typeKey: r.type_key,
  typeName: r.type_name,
  workflow: r.workflow,
  title: r.title,
  status: r.status,
  tags: parseJson<string[]>(r.tags, []),
  owner: r.owner,
  revision: Number(r.revision),
  version: Number(r.version),
  createdAt: r.created_at,
  createdBy: r.created_by,
  updatedAt: r.updated_at,
  updatedBy: r.updated_by,
  ...(r.workflow === 'document' ? { edition: doc?.edition ?? null, reviewStatus: doc?.reviewStatus ?? 'none', nextReviewAt: doc?.nextReviewAt ?? null } : {}),
});

const SELECT = 'SELECT r.*, t.key AS type_key, t.name AS type_name, t.workflow AS workflow FROM records r JOIN record_types t ON t.id = r.type_id';

export interface ListFilter {
  type?: string;
  status?: string[];
  tag?: string;
  q?: string;
  owner?: string;
  /** Only records of types with this workflow */
  workflow?: string;
  /** Living documents: only these review statuses */
  review?: ReviewStatus[];
  limit?: number;
}

/** Records, newest change first. Every signed-in user may read records (access change entries: see canReadRecordRow). */
export function listRecords(f: ListFilter = {}): RecordSummary[] {
  const u = me();
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.type) {
    const t = typeRow(f.type);
    if (!t) return [];
    where.push('r.type_id = ?');
    params.push(t.id);
  }
  if (f.status?.length) {
    where.push(`r.status IN (${f.status.map(() => '?').join(', ')})`);
    params.push(...f.status);
  }
  if (f.owner) (where.push('lower(r.owner) = lower(?)'), params.push(f.owner));
  if (f.workflow) (where.push('t.workflow = ?'), params.push(f.workflow));
  // the review status is computed: only documents have one
  if (f.review?.length) where.push("t.workflow = 'document'");
  const docs = documentStates();
  if (f.q?.trim()) {
    const q = `%${likeEscape(f.q.trim().toLowerCase())}%`;
    where.push("(lower(r.number) LIKE ? ESCAPE '\\' OR lower(r.title) LIKE ? ESCAPE '\\' OR lower(r.body) LIKE ? ESCAPE '\\')");
    params.push(q, q, q);
  }
  const tag = f.tag?.trim().toLowerCase();
  if (tag) {
    // tags are stored as a sorted JSON array of lower-case strings: a quick pre-filter by the key, the exact match below
    where.push("lower(r.tags) LIKE ? ESCAPE '\\'");
    params.push(`%"${likeEscape(splitTag(normalizeTag(tag)).key)}%`);
  }
  const limit = Math.min(Math.max(f.limit ?? 500, 1), 10000);
  // records the user may not read are left out before the limit applies (pages of rows until the limit is reached)
  const page = Math.max(limit, 500);
  const out: RecordSummary[] = [];
  for (let offset = 0; out.length < limit; offset += page) {
    const rows = db().all<Listed>(
      `${SELECT}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY r.updated_at DESC, r.id DESC LIMIT ? OFFSET ?`,
      ...params,
      page,
      offset,
    );
    for (const r of rows) {
      if (!canReadRecordRow(u, r)) continue;
      const d = docs.get(r.id);
      const sum = toSummary(r, d && { edition: d.edition, reviewStatus: d.review.status, nextReviewAt: d.review.nextReviewAt });
      if (tag && !tagsMatch(sum.tags, tag)) continue;
      if (f.review?.length && !f.review.includes(sum.reviewStatus ?? 'none')) continue;
      out.push(sum);
      if (out.length >= limit) break;
    }
    if (rows.length < page) break;
  }
  return out;
}

/**
 * Everyone who wrote content of the record (four-eyes): the authors of all
 * its versions – a new revision starts as a copy of the earlier content, so
 * their authors stay authors – and everyone who attached or removed files
 * (attached files are content, too).
 */
function contentAuthors(r: RecordRow): string[] {
  const names = new Set<string>();
  if (db().get('SELECT 1 FROM record_types WHERE id = ? AND workflow = ?', r.type_id, 'document')) return editionAuthors(r);
  for (const a of db().all<{ author: string }>('SELECT DISTINCT author FROM record_versions WHERE record_id = ?', r.id)) names.add(a.author);
  for (const a of db().all<{ created_by: string }>("SELECT DISTINCT created_by FROM record_attachments WHERE record_id = ? AND kind = 'file'", r.id))
    names.add(a.created_by);
  for (const a of db().all<{ actor: string }>(
    "SELECT DISTINCT actor FROM audit_log WHERE entity_type = 'record' AND entity_id = ? AND action IN ('record.attachment_added', 'record.attachment_removed')",
    r.id,
  ))
    names.add(a.actor);
  // access change entries: whoever performed the change does not verify it; for an entry of a run, nor
  // does the person who started the run or approved it (entries of older versions name "user (run …)")
  if (db().get('SELECT 1 FROM record_types WHERE id = ? AND workflow = ?', r.type_id, 'access')) {
    const f = parseJson<Record<string, string>>(r.fields, {});
    const performer = f.performedBy?.trim().replace(/ \(run [^)]*\)$/, '');
    if (performer) names.add(performer);
    if (f.origin === 'run' && f.runId) {
      const run = db().get<{ actor: string }>('SELECT actor FROM runs WHERE id = ?', f.runId);
      if (run?.actor) names.add(run.actor);
      for (const t of db().all<{ decided_by: string | null }>("SELECT decided_by FROM run_tasks WHERE run_id = ? AND mode = 'approve'", f.runId))
        if (t.decided_by) names.add(t.decided_by);
    }
  }
  return [...names];
}

/**
 * Living documents: everyone who wrote content of the edition being drafted – the authors of the versions of
 * this revision (a new edition starts with a copy of the current one: whoever started it did not write it)
 * and whoever attached or removed files since the revision started. Owner, creator and submitter are
 * excluded by fourEyesReason anyway.
 */
export function editionAuthors(r: Pick<RecordRow, 'id' | 'revision'>): string[] {
  const names = new Set<string>();
  const versions = db().all<{ version: number; author: string; created_at: string }>(
    'SELECT version, author, created_at FROM record_versions WHERE record_id = ? AND revision = ? ORDER BY version',
    r.id,
    r.revision,
  );
  versions.forEach((v, i) => {
    if (i === 0 && Number(r.revision) > 1) return; // the copy of the current edition
    names.add(v.author);
  });
  const since = versions[0]?.created_at ?? '';
  for (const a of db().all<{ created_by: string }>(
    "SELECT DISTINCT created_by FROM record_attachments WHERE record_id = ? AND kind = 'file' AND revision = ?",
    r.id,
    r.revision,
  ))
    names.add(a.created_by);
  for (const a of db().all<{ actor: string }>(
    "SELECT DISTINCT actor FROM audit_log WHERE entity_type = 'record' AND entity_id = ? AND action IN ('record.attachment_added', 'record.attachment_removed') AND ts >= ?",
    r.id,
    since,
  ))
    names.add(a.actor);
  return [...names].sort();
}

const isAccessEntry = (r: Pick<RecordRow, 'type_id'>) => r.type_id === ACCESS_TYPE_ID;
const accessFields = (r: Pick<RecordRow, 'fields'>) => parseJson<Record<string, string>>(r.fields, {});
/** Entries a run created are Steward's evidence of what the run did: people neither change nor revise them (they document a correction instead). */
const isRunEntry = (r: Pick<RecordRow, 'type_id' | 'fields'>) => isAccessEntry(r) && accessFields(r).origin === 'run';

/** Fields of an access change entry only Steward sets: the origin (other than manual), the run and the finding. */
const RESERVED_ACCESS_FIELDS = ['origin', 'runId', 'findingId'];

/**
 * Access change entries: only people who may use the platform write them (GOV-1); the origin, run and
 * finding are set by Steward itself (automatic entries, documenting a finding) and never change afterwards.
 */
function checkAccessEntry(u: AuthUser, fields: Record<string, string>, cur: Record<string, string> | null, internal: boolean): void {
  for (const platform of new Set([fields.platform ?? '', ...(cur ? [cur.platform ?? ''] : [])]))
    if (!canDocumentAccessOn(u, platform)) forbid('document access changes of this platform', 'documentAccess');
  if (internal || isSystem(u)) return;
  const reserved = cur
    ? RESERVED_ACCESS_FIELDS.filter((k) => (fields[k] ?? '') !== (cur[k] ?? ''))
    : RESERVED_ACCESS_FIELDS.filter((k) => (k === 'origin' ? !!fields[k] && fields[k] !== 'manual' : !!fields[k]));
  if (reserved.length)
    throw new HttpError(400, `Only Steward sets ${reserved.join(', ')} of an access change entry`, 'ACCESS_FIELD_RESERVED', { fields: reserved.join(', ') });
}

function runEntryLocked(r: RecordRow): never {
  throw new HttpError(409, `${r.number} was documented automatically by a run – document a correction as a new entry instead`, 'ACCESS_RUN_ENTRY_LOCKED', {
    number: r.number,
  });
}

/** Audit actions of the transitions that leave the initial status (they freeze the content). */
const FREEZE_ACTIONS = [
  ...new Set(
    Object.values(RECORD_WORKFLOWS).flatMap((w) => w.transitions.filter((t) => t.from.some((f) => isEditableStatus(w, f))).map((t) => `record.${t.action}`)),
  ),
];

/**
 * Whether frozen content is still what was frozen. The frozen_hash column
 * alone does not prove it (someone who can write to the database could
 * change the content and the hash together), so the hash must also match
 * the authentic (HMAC-chained) audit entry that froze this revision: the
 * newest freezing or "new revision" entry of the record.
 */
export function frozenIntact(r: RecordRow, hash: string): boolean {
  if (!r.frozen_hash || hash !== r.frozen_hash) return false;
  const actions = [...FREEZE_ACTIONS, 'record.revised'];
  const { rows } = authenticRows(`entity_type = 'record' AND entity_id = ? AND action IN (${actions.map(() => '?').join(', ')})`, [r.id, ...actions], {
    limit: 20,
  });
  for (const row of rows) {
    if (row.action === 'record.revised') return false;
    const d = parseJson<{ contentHash?: string; revision?: number; frozen?: boolean }>(row.details, {});
    if (d.frozen !== true) continue; // e.g. cancelling a submitted record
    return d.contentHash === hash && Number(d.revision) === Number(r.revision);
  }
  return false;
}

/**
 * Field definitions to show a record with: for frozen content the snapshot
 * taken when it was frozen (labels and options may change later), else the
 * type's current ones; stored values without a definition are shown by key.
 */
export function fieldDefsOf(r: RecordRow, t: TypeRow, frozen: boolean): RecordFieldDef[] {
  const snapshot = frozen
    ? parseJson<RecordFieldDef[] | null>(
        db().get<{ field_defs: string | null }>('SELECT field_defs FROM record_versions WHERE record_id = ? AND version = ?', r.id, r.version)?.field_defs ??
          null,
        null,
      )
    : null;
  return withStoredFields(snapshot ?? toType(t, 0).fields, parseJson<Record<string, string>>(r.fields, {}));
}

/** Definitions plus a plain text definition for every stored value they do not cover. */
export function withStoredFields(defs: RecordFieldDef[], fields: Record<string, string>): RecordFieldDef[] {
  const known = new Set(defs.map((d) => d.key));
  const extra = Object.keys(fields)
    .filter((k) => !known.has(k))
    .map((k): RecordFieldDef => ({ key: k, label: k, kind: 'textarea' }));
  return extra.length ? [...defs, ...extra] : defs;
}

export function permissionsOf(u: AuthUser | null, r: RecordRow, wf: RecordWorkflow): RecordPermissions {
  const draft = isEditableStatus(wf, r.status);
  const accessLocked = isAccessEntry(r) && (!canDocumentAccessOn(u, accessFields(r).platform ?? '') || (isRunEntry(r) && !isSystem(u)));
  const edit = canEditRecord(u, r) && !accessLocked;
  return {
    edit: edit && draft,
    comment: canCommentRecord(u, r),
    revise: edit && wf.revisable.includes(r.status),
    attach: edit && draft,
    link: edit && !wf.terminal.includes(r.status),
    generatePdf: edit || canApproveRecord(u, r),
    uploadSigned: edit || canApproveRecord(u, r),
    attachPlainPdf: isAdmin(u),
  };
}

function actionsOf(u: AuthUser | null, r: RecordRow, wf: RecordWorkflow): RecordActionInfo[] {
  const out: RecordActionInfo[] = [];
  const edition = wf.key === 'document' ? (docRow(r.id)?.current_edition ?? null) : null;
  for (const t of wf.transitions) {
    if (!t.from.includes(r.status)) continue;
    let reason: ActionReason | undefined;
    if (!u) reason = { code: 'NOT_SIGNED_IN', message: 'Not signed in' };
    else if (t.approval) {
      if (!canApproveRecord(u, r)) reason = { code: 'RECORD_APPROVERS_ONLY', message: 'Only approvers and administrators can approve or reject records' };
      else reason = fourEyesReason(u, r, contentAuthors(r)) ?? undefined;
      // access change entries: nobody verifies a change of their own access
      if (!reason && isAccessEntry(r) && isSubjectOf(u.username, accessFields(r)))
        reason = { code: 'FOUR_EYES_SUBJECT', message: 'Four-eyes principle: the subject of an access change cannot verify it' };
    } else if (!canEditRecord(u, r)) reason = { code: 'RECORD_EDITORS_ONLY', message: 'Only designers, operators, administrators and the owner can do this' };
    else if (isAccessEntry(r) && !canDocumentAccessOn(u, accessFields(r).platform ?? ''))
      reason = { code: 'ACCESS_PLATFORM_REQUIRED', message: 'Only people who may use the platform document its access changes' };
    out.push({
      action: t.action,
      to: t.toWithEdition && edition ? t.toWithEdition : t.to,
      allowed: !reason,
      reason: reason?.message,
      reasonCode: reason?.code,
      approval: !!t.approval,
      commentRequired: !!t.commentRequired,
      needsRecord: !!t.needsRecord,
      optionalRecord: !!t.optionalRecord,
      needsEdition: wf.key === 'document' && t.action === 'submit',
    });
  }
  return out;
}

interface EventRow {
  id: string;
  kind: RecordEvent['kind'];
  action: string | null;
  from_status: string | null;
  to_status: string | null;
  actor: string;
  comment: string;
  content_hash: string | null;
  version: number | null;
  revision: number;
  created_at: string;
}

export const listEvents = (recordId: string): RecordEvent[] =>
  db()
    .all<EventRow>('SELECT * FROM record_events WHERE record_id = ? ORDER BY created_at, id', recordId)
    .map((e) => ({
      id: e.id,
      kind: e.kind,
      action: e.action,
      fromStatus: e.from_status,
      toStatus: e.to_status,
      actor: e.actor,
      comment: e.comment,
      contentHash: e.content_hash,
      version: e.version === null ? null : Number(e.version),
      revision: Number(e.revision),
      createdAt: e.created_at,
    }));

export function currentContentHash(r: RecordRow, t: Pick<TypeRow, 'key'>): string {
  return contentHash(r, t.key, attachmentRows(r.id, 'file'));
}

function importedHistoryOf(recordId: string): Pick<RecordDetail, 'importedHistory'> {
  const from = importedHistoryFor("entity_type = 'record' AND entity_id = ?", [recordId]);
  return from ? { importedHistory: from } : {};
}

export function getRecord(idOrNumber: string): RecordDetail {
  const u = me();
  const r = requireRecordRow(idOrNumber);
  const t = requireType(r.type_id);
  const wf = workflowOf(t);
  const frozen = !isEditableStatus(wf, r.status);
  const hash = currentContentHash(r, t);
  const document = isDocument(t) ? documentInfo(u, r, t) : null;
  const docState = document
    ? { edition: document.currentEdition, reviewStatus: document.review.status, nextReviewAt: document.review.nextReviewAt }
    : undefined;
  return {
    ...toSummary({ ...r, type_key: t.key, type_name: t.name, workflow: t.workflow }, docState),
    body: r.body,
    fields: parseJson<Record<string, string>>(r.fields, {}),
    fieldDefs: fieldDefsOf(r, t, frozen),
    contentHash: hash,
    frozenHash: r.frozen_hash,
    frozen,
    tampered: frozen && !frozenIntact(r, hash),
    ...importedHistoryOf(r.id),
    submittedBy: r.submitted_by,
    submittedAt: r.submitted_at,
    supersededBy: supersededInfo(u, r),
    importMeta: parseJson<Record<string, unknown> | null>(r.import_meta, null),
    type: toType(t),
    actions: actionsOf(u, r, wf),
    permissions: permissionsOf(u, r, wf),
    attachments: attachmentRows(r.id).map(toAttachment),
    links: listLinks('record', r.id),
    backlinks: listBacklinks('record', r.id),
    events: listEvents(r.id),
    document,
  };
}

/**
 * The record that superseded or replaced this one – named only when the reader may read it (an access change
 * entry, say), else like a link to a hidden item: not visible, without its id, number or title.
 */
export function supersededInfo(u: AuthUser | null, r: Pick<RecordRow, 'superseded_by'>): RecordDetail['supersededBy'] {
  if (!r.superseded_by) return null;
  const sup = recordRow(r.superseded_by);
  if (!sup || !canReadRecordRow(u, sup)) return { visible: false, id: null, number: null, title: null };
  return { visible: true, id: sup.id, number: sup.number, title: sup.title };
}

/** May review the current edition of a document: its owner, its review owner, approvers and administrators. */
export function canReviewDocument(u: AuthUser | null, r: RecordRow, d: DocRow | undefined): boolean {
  if (!u) return false;
  const same = (a: string | null | undefined) => !!a && a.toLowerCase() === u.username.toLowerCase();
  return same(r.owner) || same(d?.review_owner) || canApproveRecord(u, r) || isAdmin(u);
}

/** Editions, reviews and the review status of a living document. */
export function documentInfo(u: AuthUser | null, r: RecordRow, t: TypeRow): DocumentInfo {
  const d = docRow(r.id);
  const rows = editionRows(r.id);
  const current = d?.current_edition ?? null;
  const intact = intactEditions(r, t.key, rows);
  const cur = rows.find((e) => e.edition === current);
  const pending =
    d?.pending_kind && r.status === 'in_review'
      ? {
          kind: d.pending_kind,
          changeSummary: d.pending_summary ?? '',
          edition: current ? nextEditions(current)[d.pending_kind] : '1.0',
        }
      : null;
  return {
    currentEdition: current,
    pending,
    nextEdition: nextEditions(current),
    editions: rows.map((e) => toEditionSummary(e, current, intact.has(e.edition))),
    reviews: reviewsOf(r.id),
    review: reviewState(r, t, d, cur?.approved_at ?? null),
    appliesTo: scopeOf(r.id),
    permissions: {
      review: !!current && ['published', 'revising'].includes(r.status) && canReviewDocument(u, r, d),
      scope: canEditRecord(u, r) && r.status !== 'withdrawn',
      settings: (canEditRecord(u, r) || canApproveRecord(u, r)) && r.status !== 'withdrawn',
      reviewOwner: canApproveRecord(u, r) && r.status !== 'withdrawn',
      reviewInterval: canApproveRecord(u, r) && r.status !== 'withdrawn',
      anyInterval: isAdmin(u) && r.status !== 'withdrawn',
    },
  };
}

interface VersionRow {
  version: number;
  revision: number;
  title: string;
  body: string;
  fields: string;
  hash: string;
  author: string;
  comment: string;
  created_at: string;
  field_defs: string | null;
}
const toVersion = (v: VersionRow): RecordVersion => ({
  version: Number(v.version),
  revision: Number(v.revision),
  title: v.title,
  body: v.body,
  fields: parseJson(v.fields, {}),
  hash: v.hash,
  author: v.author,
  comment: v.comment,
  createdAt: v.created_at,
  fieldDefs: parseJson<RecordFieldDef[] | null>(v.field_defs, null),
});

export function listVersions(idOrNumber: string): RecordVersion[] {
  me();
  const r = requireRecordRow(idOrNumber);
  return db().all<VersionRow>('SELECT * FROM record_versions WHERE record_id = ? ORDER BY version DESC', r.id).map(toVersion);
}

export function getVersion(idOrNumber: string, version: number): RecordVersion {
  me();
  const r = requireRecordRow(idOrNumber);
  const v = db().get<VersionRow>('SELECT * FROM record_versions WHERE record_id = ? AND version = ?', r.id, version);
  if (!v) throw new HttpError(404, `Version ${version} of ${r.number} not found`, 'RECORD_VERSION_NOT_FOUND', { version, number: r.number });
  return toVersion(v);
}

// ---------- write ----------

/** Next number for a prefix: PREFIX-YYYY-NNNN, counted per prefix and year. */
export function nextNumber(prefix: string, at = new Date()): string {
  const year = at.getUTCFullYear();
  return db().tx(() => {
    db().run(
      'INSERT INTO record_counters (prefix, year, seq) VALUES (?, ?, 1) ON CONFLICT (prefix, year) DO UPDATE SET seq = record_counters.seq + 1',
      prefix,
      year,
    );
    const n = Number(db().get<{ seq: number }>('SELECT seq FROM record_counters WHERE prefix = ? AND year = ?', prefix, year)!.seq);
    return `${prefix}-${year}-${String(n).padStart(4, '0')}`;
  });
}

function insertEvent(r: Pick<RecordRow, 'id' | 'revision'>, e: Omit<EventRow, 'id' | 'created_at' | 'revision' | 'actor'> & { revision?: number }): string {
  const id = newId('rev_');
  db().run(
    'INSERT INTO record_events (id, record_id, kind, action, from_status, to_status, actor, comment, content_hash, version, revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    r.id,
    e.kind,
    e.action,
    e.from_status,
    e.to_status,
    currentActor(),
    e.comment,
    e.content_hash,
    e.version,
    e.revision ?? r.revision,
    nowIso(),
  );
  return id;
}

function insertVersion(recordId: string, version: number, revision: number, c: Content, comment: string): string {
  const hash = versionHash(c);
  db().run(
    'INSERT INTO record_versions (record_id, version, revision, title, body, fields, hash, author, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    recordId,
    version,
    revision,
    c.title,
    c.body,
    JSON.stringify(c.fields),
    hash,
    currentActor(),
    comment,
    nowIso(),
  );
  return hash;
}

export interface CreateInput {
  type: string;
  title: string;
  body?: string;
  fields?: Record<string, unknown>;
  tags?: string[];
  importMeta?: Record<string, unknown>;
  /** Fields the type does not know are dropped instead of rejected (import) */
  lenientFields?: boolean;
  /** Steward's own compliance code (automatic entries of runs, documenting a finding): may set the reserved fields of access change entries */
  internal?: boolean;
  /** Links the new record starts with (e.g. the service a new document is written for); added in the same transaction */
  links?: LinkInput[];
}

/**
 * The body a new record starts with when none is given (API, MCP): the template of its type; for a built-in
 * type with its unchanged English template, the template in the creator's language (profile, else the
 * default language). The web UI sends the template in its own language.
 */
function templateFor(t: TypeRow, u: AuthUser): string {
  const def = [...DEFAULT_RECORD_TYPES, ACCESS_RECORD_TYPE, DOCUMENT_RECORD_TYPE, INCIDENT_RECORD_TYPE].find((d) => d.key === t.key);
  if (!t.builtin || !def || def.template !== t.template) return t.template;
  let locale: string | null | undefined;
  try {
    locale = getUser(u.id).locale;
  } catch {
    locale = null;
  }
  return tr(resolveLocale(locale, getSettings().defaultLocale), `recordTemplates.${t.key}` as MessageKey);
}

export function createRecord(input: CreateInput): RecordDetail {
  const u = me();
  if (!canCreateRecords(u)) forbid('create records', 'createRecords');
  const t = requireType(input.type);
  if (t.archived) throw new HttpError(409, `The record type ${t.key} is archived`, 'RECORD_TYPE_ARCHIVED', { type: t.key });
  const title = input.title.trim();
  if (!title || title.length > LIMITS.title)
    throw new HttpError(400, `The title is required (at most ${LIMITS.title} characters)`, 'TITLE_REQUIRED', { max: LIMITS.title });
  const body = input.body ?? templateFor(t, u);
  if (body.length > LIMITS.body)
    throw new HttpError(400, `The text is too long (at most ${LIMITS.body / 1024} KiB)`, 'TEXT_TOO_LONG', { maxKib: LIMITS.body / 1024 });
  const fields = cleanFields(toType(t, 0).fields, input.fields ?? {}, { dropUnknown: input.lenientFields, typeKey: t.key });
  if (t.id === ACCESS_TYPE_ID) checkAccessEntry(u, fields, null, !!input.internal);
  const tags = cleanTags(input.tags ?? []);
  const wf = workflowOf(t);
  const id = newId('rec_');
  const now = nowIso();
  db().tx(() => {
    const number = nextNumber(t.key);
    db().run(
      `INSERT INTO records (id, type_id, number, title, status, body, fields, tags, owner, revision, version, import_meta, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?)`,
      id,
      t.id,
      number,
      title,
      wf.initial,
      body,
      JSON.stringify(fields),
      JSON.stringify(tags),
      u.username,
      input.importMeta ? JSON.stringify(input.importMeta) : null,
      now,
      u.username,
      now,
      u.username,
    );
    const hash = insertVersion(id, 1, 1, { title, body, fields }, input.importMeta ? 'Imported' : 'Created');
    if (isDocument(t)) ensureDocRow(id);
    insertEvent(
      { id, revision: 1 },
      { kind: input.importMeta ? 'imported' : 'created', action: null, from_status: null, to_status: wf.initial, comment: '', content_hash: hash, version: 1 },
    );
    assignCreatorTeams('record', id, currentUser());
    audit({
      action: input.importMeta ? 'record.imported' : 'record.created',
      entityType: 'record',
      entityId: id,
      summary: `${t.name} ${number} "${title}" ${input.importMeta ? 'imported' : 'created'}`,
      details: { number, type: t.key, versionHash: hash, ...(input.importMeta ? { import: input.importMeta } : {}) },
    });
    // same checks as adding them later (visible targets only, no duplicates); any refusal rolls the record back
    for (const l of input.links ?? []) addLink('record', id, l, number);
  });
  return getRecord(id);
}

export interface UpdateInput {
  title?: string;
  body?: string;
  fields?: Record<string, unknown>;
  tags?: string[];
  owner?: string;
  comment?: string;
  /** Optimistic concurrency: the version the change is based on */
  baseVersion?: number;
}

export function updateRecord(idOrNumber: string, input: UpdateInput): RecordDetail {
  const u = me();
  const r = requireRecordRow(idOrNumber);
  const t = requireType(r.type_id);
  const wf = workflowOf(t);
  if (!canEditRecord(u, r)) forbid('change this record', 'changeRecord');
  if (isRunEntry(r) && !isSystem(u)) runEntryLocked(r);
  if (input.baseVersion !== undefined && input.baseVersion !== Number(r.version)) {
    throw new HttpError(409, `${r.number} was changed in the meantime (version ${r.version}) – reload and apply your changes again`, 'RECORD_CHANGED', {
      number: r.number,
      version: Number(r.version),
    });
  }
  const cur: Content = { title: r.title, body: r.body, fields: parseJson(r.fields, {}) };
  const next: Content = {
    title: input.title !== undefined ? input.title.trim() : cur.title,
    body: input.body !== undefined ? input.body : cur.body,
    fields: input.fields !== undefined ? cleanFields(toType(t, 0).fields, input.fields, { typeKey: t.key }) : cur.fields,
  };
  if (!next.title || next.title.length > LIMITS.title)
    throw new HttpError(400, `The title is required (at most ${LIMITS.title} characters)`, 'TITLE_REQUIRED', { max: LIMITS.title });
  if (next.body.length > LIMITS.body)
    throw new HttpError(400, `The text is too long (at most ${LIMITS.body / 1024} KiB)`, 'TEXT_TOO_LONG', { maxKib: LIMITS.body / 1024 });
  if (isAccessEntry(r)) checkAccessEntry(u, next.fields, cur.fields, false);
  const contentChanged = versionHash(next) !== versionHash(cur);
  if (contentChanged && !isEditableStatus(wf, r.status)) {
    throw new HttpError(409, `${r.number} is ${r.status}: its content is frozen. Start a new revision to change it.`, 'RECORD_FROZEN', {
      number: r.number,
      status: statusParam(r.status),
    });
  }
  const tags = input.tags !== undefined ? cleanTags(input.tags) : parseJson<string[]>(r.tags, []);
  const tagsChanged = JSON.stringify(tags) !== r.tags;
  let owner = r.owner;
  if (input.owner !== undefined && input.owner.trim().toLowerCase() !== r.owner.toLowerCase()) {
    if (!isAdmin(u) && r.owner.toLowerCase() !== u.username.toLowerCase()) forbid('hand this record over to someone else', 'handOverRecord');
    // four-eyes is checked against the owner when deciding: a hand-over while the approval is pending would let the submitting owner pass it to someone else and approve
    if (awaitsApproval(wf, r.status))
      throw new HttpError(
        409,
        `${r.number} is ${r.status} and waits for an approval: hand it over before submitting it or after the decision`,
        'RECORD_OWNER_LOCKED',
        {
          number: r.number,
          status: statusParam(r.status),
        },
      );
    const target = findUserByName(input.owner.trim());
    if (!target || !target.active) throw new HttpError(400, `User ${input.owner} not found`, 'USER_NOT_FOUND', { name: input.owner });
    owner = target.username;
  }
  const ownerChanged = owner !== r.owner;
  if (!contentChanged && !tagsChanged && !ownerChanged) return getRecord(r.id);
  const comment = (input.comment ?? '').trim().slice(0, LIMITS.comment);
  db().tx(() => {
    const version = contentChanged ? Number(r.version) + 1 : Number(r.version);
    let hash: string | undefined;
    if (contentChanged) hash = insertVersion(r.id, version, Number(r.revision), next, comment);
    db().run(
      'UPDATE records SET title = ?, body = ?, fields = ?, tags = ?, owner = ?, version = ?, updated_at = ?, updated_by = ? WHERE id = ?',
      next.title,
      next.body,
      JSON.stringify(next.fields),
      JSON.stringify(tags),
      owner,
      version,
      nowIso(),
      u.username,
      r.id,
    );
    const what = [contentChanged && `version ${version}`, tagsChanged && 'tags', ownerChanged && `owner ${r.owner} → ${owner}`].filter(Boolean).join(', ');
    audit({
      action: 'record.updated',
      entityType: 'record',
      entityId: r.id,
      summary: `${r.number} changed (${what})${comment ? `: ${comment}` : ''}`,
      details: {
        number: r.number,
        version,
        ...(hash ? { versionHash: hash } : {}),
        ...(tagsChanged ? { tags } : {}),
        ...(ownerChanged ? { owner, previousOwner: r.owner } : {}),
      },
    });
  });
  return getRecord(r.id);
}

/** Statuses in which a record waits for an approval (submitted, proposed, documented, in review). */
export const awaitsApproval = (wf: RecordWorkflow, status: string): boolean => wf.transitions.some((t) => t.approval && t.from.includes(status));

export interface TransitionInput {
  action: string;
  comment?: string;
  /** Id or number of the superseding record (decisions) or of the replacing document (withdrawing a document) */
  supersededBy?: string;
  /** Submitting a living document: minor (editorial, 1.0 → 1.1) or major (substantive, 1.x → 2.0) */
  editionKind?: EditionKind;
  /** Submitting a living document: what changed in this edition (required) */
  changeSummary?: string;
  /** Optional: the content hash the person saw (approvals); a different current hash is refused, so nobody decides on content they did not see */
  contentHash?: string;
}

export function transition(idOrNumber: string, input: TransitionInput): RecordDetail {
  const u = me();
  const r = requireRecordRow(idOrNumber);
  const t = requireType(r.type_id);
  const wf = workflowOf(t);
  const def = wf.transitions.find((x) => x.action === input.action);
  if (!def) throw new HttpError(400, `Unknown action "${input.action}" for ${t.name}`, 'RECORD_ACTION_UNKNOWN', { action: input.action });
  if (!def.from.includes(r.status))
    throw new HttpError(409, `${r.number} is ${r.status}: "${input.action}" is not possible (allowed from ${def.from.join(', ')})`, 'INVALID_TRANSITION', {
      number: r.number,
      status: statusParam(r.status),
    });
  const info = actionsOf(u, r, wf).find((a) => a.action === def.action)!;
  if (!info.allowed) throw new HttpError(403, info.reason ?? 'Not allowed', info.reasonCode ?? 'FORBIDDEN');
  const comment = (input.comment ?? '').trim();
  if (comment.length > LIMITS.comment)
    throw new HttpError(400, `The comment is too long (at most ${LIMITS.comment} characters)`, 'COMMENT_TOO_LONG', { max: LIMITS.comment });
  if (def.commentRequired && !comment) throw new HttpError(400, 'Please give a reason in the comment', 'COMMENT_REQUIRED');
  const leavingDraft = isEditableStatus(wf, r.status);
  if (leavingDraft) {
    const fields = parseJson<Record<string, string>>(r.fields, {});
    const missing = toType(t, 0).fields.filter((f) => f.required && !fields[f.key]?.trim());
    if (missing.length && def.to !== 'cancelled' && def.to !== 'withdrawn')
      throw new HttpError(400, `Fill in the required fields first: ${missing.map((f) => f.label).join(', ')}`, 'RECORD_INCOMPLETE', {
        fields: missing.map((f) => fieldParam(t.key, f)),
      });
  }
  const isDoc = isDocument(t);
  const doc = isDoc ? ensureDocRow(r.id) : undefined;
  const to = def.toWithEdition && doc?.current_edition ? def.toWithEdition : def.to;
  // back into an editable status (a rejected document): the content can change again
  const unfreezing = !leavingDraft && isEditableStatus(wf, to);
  // living documents: submitting names the kind of the edition and what changed
  let edition: { kind: EditionKind; summary: string } | undefined;
  if (isDoc && def.action === 'submit') {
    const summary = (input.changeSummary ?? '').trim();
    if (!summary) throw new HttpError(400, 'Summarise what changed in this edition', 'CHANGE_SUMMARY_REQUIRED');
    if (summary.length > DOC_LIMITS.changeSummary)
      throw new HttpError(400, `The change summary is too long (at most ${DOC_LIMITS.changeSummary} characters)`, 'CHANGE_SUMMARY_TOO_LONG', {
        max: DOC_LIMITS.changeSummary,
      });
    if (input.editionKind !== undefined && !EDITION_KINDS.includes(input.editionKind))
      throw new HttpError(400, 'The edition is minor or major', 'EDITION_KIND_REQUIRED');
    if (doc?.current_edition && !input.editionKind)
      throw new HttpError(400, 'Say whether this is a minor (editorial) or a major (substantive) edition', 'EDITION_KIND_REQUIRED');
    // the first edition is always 1.0
    edition = { kind: doc?.current_edition ? input.editionKind! : 'major', summary };
  }
  let superseding: RecordRow | undefined;
  if (def.needsRecord || (def.optionalRecord && input.supersededBy)) {
    if (!input.supersededBy) throw new HttpError(400, 'Name the record that supersedes this one', 'SUPERSEDED_BY_REQUIRED');
    superseding = recordRow(input.supersededBy);
    if (!superseding || !canReadRecordRow(u, superseding))
      throw new HttpError(404, `Record ${input.supersededBy} not found`, 'RECORD_NOT_FOUND', { id: input.supersededBy });
    if (superseding.id === r.id) throw new HttpError(400, 'A record cannot supersede itself', 'SUPERSEDE_SELF');
    // a document is replaced by a document, a decision superseded by a decision
    if (requireType(superseding.type_id).workflow !== t.workflow)
      throw new HttpError(
        400,
        `${superseding.number} cannot ${isDocument(t) ? 'replace' : 'supersede'} ${r.number}: it must have the same workflow (${t.workflow})`,
        'SUPERSEDED_BY_WORKFLOW',
        { number: superseding.number, workflow: t.workflow },
      );
  }
  let hash = currentContentHash(r, t);
  if (!leavingDraft && !frozenIntact(r, hash)) {
    // The frozen content no longer matches the hash recorded (and audited) when it was frozen: changed outside Steward. Stop rather than approve it.
    throw new HttpError(409, `The content of ${r.number} does not match the hash recorded when it was frozen – check the audit log`, 'RECORD_TAMPERED', {
      number: r.number,
    });
  }
  if (input.contentHash !== undefined && input.contentHash !== hash)
    throw new HttpError(409, `${r.number} was changed in the meantime – reload it and check the content before you decide`, 'RECORD_CHANGED', {
      number: r.number,
      version: Number(r.version),
    });
  const now = nowIso();
  let approved: EditionRow | undefined;
  let row = r;
  db().tx(() => {
    // withdrawing a document while its next edition is drafted: the draft is dropped, the document keeps the current edition
    if (isDoc && to === 'withdrawn' && r.status === 'revising' && doc?.current_edition) {
      const cur = editionRow(r.id, doc.current_edition);
      if (cur) {
        row = restoreEdition(r, cur, `Draft of the next edition discarded: ${comment}`.slice(0, LIMITS.comment));
        hash = currentContentHash(row, t);
      }
    }
    db().run(
      `UPDATE records SET status = ?, frozen_hash = ?, submitted_by = ?, submitted_at = ?, superseded_by = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
      to,
      unfreezing ? null : leavingDraft ? hash : row.frozen_hash,
      unfreezing ? null : leavingDraft && def.to !== 'cancelled' && def.to !== 'withdrawn' ? u.username : row.submitted_by,
      unfreezing ? null : leavingDraft && def.to !== 'cancelled' && def.to !== 'withdrawn' ? now : row.submitted_at,
      superseding ? superseding.id : row.superseded_by,
      now,
      u.username,
      r.id,
    );
    // the field definitions as they are now belong to the frozen content (labels and options may change later)
    if (leavingDraft)
      db().run('UPDATE record_versions SET field_defs = ? WHERE record_id = ? AND version = ?', JSON.stringify(toType(t, 0).fields), r.id, row.version);
    if (edition) updateDocRow(r.id, { pending_kind: edition.kind, pending_summary: edition.summary });
    if (isDoc && unfreezing) updateDocRow(r.id, { pending_kind: null, pending_summary: null });
    if (isDoc && def.action === 'approve') approved = approveEdition(row, t, doc!, hash, now, u.username);
    insertEvent(row, {
      kind: 'transition',
      action: def.action,
      from_status: r.status,
      to_status: to,
      comment,
      content_hash: hash,
      version: Number(row.version),
    });
    audit({
      action: approved ? 'record.edition_approved' : `record.${def.action}`,
      entityType: 'record',
      entityId: r.id,
      summary: approved
        ? `${r.number} edition ${approved.edition} (${approved.kind}) approved – ${r.status} → ${to}${comment ? `: ${comment}` : ''}`
        : `${r.number} ${r.status} → ${to}${edition ? ` (${edition.kind} edition ${nextEditions(doc?.current_edition ?? null)[edition.kind]})` : ''}${comment ? `: ${comment}` : ''}`,
      details: {
        number: r.number,
        from: r.status,
        to,
        revision: Number(row.revision),
        version: Number(row.version),
        contentHash: hash,
        ...(leavingDraft ? { frozen: true } : {}),
        ...(unfreezing ? { unfrozen: true } : {}),
        ...(def.approval ? { fourEyes: true } : {}),
        ...(superseding ? { supersededBy: superseding.number } : {}),
        ...(edition
          ? { editionKind: edition.kind, edition: nextEditions(doc?.current_edition ?? null)[edition.kind], changeSummary: edition.summary.slice(0, 500) }
          : {}),
        ...(approved
          ? {
              edition: approved.edition,
              kind: approved.kind,
              previousEdition: doc?.current_edition ?? null,
              authors: JSON.parse(approved.authors) as string[],
              approvedBy: approved.approved_by,
              // seals the edition's metadata (summary, authors, submitter, approver, dates): see intactEditions
              metaHash: editionMetaHash(approved),
            }
          : {}),
        ...(isDoc && to === 'withdrawn' ? { edition: doc?.current_edition ?? null } : {}),
      },
    });
    if (
      superseding &&
      !db().get("SELECT 1 FROM item_links WHERE from_kind = 'record' AND from_id = ? AND to_kind = 'record' AND to_id = ?", r.id, superseding.id)
    ) {
      addLink('record', r.id, { kind: 'record', id: superseding.id, note: isDoc ? 'replaced by' : 'superseded by' }, r.number);
    }
  });
  emit('record.transitioned', { recordId: r.id, typeId: r.type_id, action: def.action, to });
  return getRecord(r.id);
}

/**
 * Freezes the approved content of a document as its next edition (in the caller's transaction): the number
 * follows the kind chosen at submit, the edition becomes the current one, and the next review is counted
 * from now (an earlier date and an open "needs update" are cleared).
 */
function approveEdition(r: RecordRow, t: TypeRow, doc: DocRow, hash: string, at: string, approver: string): EditionRow {
  const kind: EditionKind = doc.current_edition ? (doc.pending_kind ?? 'major') : 'major';
  const number = doc.current_edition ? nextEditions(doc.current_edition)[kind] : '1.0';
  const { major, minor } = parseEdition(number);
  const files = attachmentRows(r.id, 'file').map((a) => ({ id: a.id, filename: a.filename, size: Number(a.size), sha256: a.sha256 }));
  const defs =
    db().get<{ field_defs: string | null }>('SELECT field_defs FROM record_versions WHERE record_id = ? AND version = ?', r.id, r.version)?.field_defs ??
    JSON.stringify(toType(t, 0).fields);
  const e: EditionRow = {
    record_id: r.id,
    major,
    minor,
    edition: number,
    kind,
    revision: Number(r.revision),
    version: Number(r.version),
    title: r.title,
    body: r.body,
    fields: r.fields,
    field_defs: defs,
    attachments: JSON.stringify(files),
    content_hash: hash,
    change_summary: doc.pending_summary ?? '',
    authors: JSON.stringify(editionAuthors(r)),
    submitted_by: r.submitted_by,
    submitted_at: r.submitted_at,
    approved_by: approver,
    approved_at: at,
  };
  db().run(
    `INSERT INTO record_editions (record_id, major, minor, edition, kind, revision, version, title, body, fields, field_defs, attachments, content_hash,
       change_summary, authors, submitted_by, submitted_at, approved_by, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    e.record_id,
    e.major,
    e.minor,
    e.edition,
    e.kind,
    e.revision,
    e.version,
    e.title,
    e.body,
    e.fields,
    e.field_defs,
    e.attachments,
    e.content_hash,
    e.change_summary,
    e.authors,
    e.submitted_by,
    e.submitted_at,
    e.approved_by,
    e.approved_at,
  );
  updateDocRow(r.id, { current_edition: number, pending_kind: null, pending_summary: null, next_review_override: null, update_requested_at: null });
  return e;
}

/**
 * A document's content back to an edition (withdrawing while the next edition is drafted): title, text,
 * fields and files of the edition, at its revision – so the content hash is the edition's again. Files
 * added for the dropped draft are retired (kept, no longer content); files of the edition come back.
 */
function restoreEdition(r: RecordRow, e: EditionRow, comment: string): RecordRow {
  const keep = new Set(parseJson<{ id: string }[]>(e.attachments, []).map((a) => a.id));
  for (const a of db().all<{ id: string; kind: string }>("SELECT id, kind FROM record_attachments WHERE record_id = ? AND kind IN ('file', 'retired')", r.id)) {
    const kind = keep.has(a.id) ? 'file' : 'retired';
    if (kind !== a.kind) db().run('UPDATE record_attachments SET kind = ? WHERE id = ?', kind, a.id);
  }
  const version = Number(r.version) + 1;
  insertVersion(r.id, version, Number(e.revision), { title: e.title, body: e.body, fields: parseJson(e.fields, {}) }, comment);
  db().run(
    'UPDATE records SET title = ?, body = ?, fields = ?, revision = ?, version = ? WHERE id = ?',
    e.title,
    e.body,
    e.fields,
    Number(e.revision),
    version,
    r.id,
  );
  db().run('UPDATE record_versions SET field_defs = ? WHERE record_id = ? AND version = ?', e.field_defs, r.id, version);
  return db().get<RecordRow>('SELECT * FROM records WHERE id = ?', r.id)!;
}

/** Back to draft for rework: a new revision; the frozen content stays in the version history and the audit log. */
export function revise(idOrNumber: string, comment: string): RecordDetail {
  const u = me();
  const r = requireRecordRow(idOrNumber);
  const t = requireType(r.type_id);
  const wf = workflowOf(t);
  if (!canEditRecord(u, r)) forbid('start a new revision of this record', 'reviseRecord');
  if (isRunEntry(r) && !isSystem(u)) runEntryLocked(r);
  if (isAccessEntry(r) && !canDocumentAccessOn(u, accessFields(r).platform ?? '')) forbid('document access changes of this platform', 'documentAccess');
  startRevision(r, t, wf, comment);
  return getRecord(r.id);
}

/**
 * Starts a new revision (the caller checked the permissions): a copy of the frozen content as a new version
 * in the editable status. For a living document this is the draft of its next edition; the current edition
 * stays valid until the next one is approved.
 */
export function startRevision(r: RecordRow, t: TypeRow, wf: RecordWorkflow, comment: string): void {
  const u = me();
  if (!wf.revisable.includes(r.status))
    throw new HttpError(409, `${r.number} is ${r.status}: a new revision is only possible when it is ${wf.revisable.join(' or ')}`, 'INVALID_TRANSITION', {
      number: r.number,
      status: statusParam(r.status),
    });
  const why = comment.trim();
  if (!why) throw new HttpError(400, 'Please say why a new revision is needed', 'COMMENT_REQUIRED');
  if (why.length > LIMITS.comment)
    throw new HttpError(400, `The comment is too long (at most ${LIMITS.comment} characters)`, 'COMMENT_TOO_LONG', { max: LIMITS.comment });
  const revision = Number(r.revision) + 1;
  const previousHash = r.frozen_hash;
  const to = wf.reviseTo ?? wf.initial;
  const edition = isDocument(t) ? (docRow(r.id)?.current_edition ?? null) : null;
  db().tx(() => {
    const version = Number(r.version) + 1;
    // The new revision starts with a copy of the frozen content (a version of its own, so authorship per revision is clear).
    const label = edition ? `Draft of the next edition (from ${edition})` : `Revision ${revision}`;
    const hash = insertVersion(r.id, version, revision, { title: r.title, body: r.body, fields: parseJson(r.fields, {}) }, `${label}: ${why}`);
    db().run(
      'UPDATE records SET status = ?, revision = ?, version = ?, frozen_hash = NULL, submitted_by = NULL, submitted_at = NULL, updated_at = ?, updated_by = ? WHERE id = ?',
      to,
      revision,
      version,
      nowIso(),
      u.username,
      r.id,
    );
    insertEvent(
      { id: r.id, revision },
      { kind: 'revision', action: 'revise', from_status: r.status, to_status: to, comment: why, content_hash: previousHash, version },
    );
    audit({
      action: 'record.revised',
      entityType: 'record',
      entityId: r.id,
      summary: edition
        ? `${r.number}: next edition drafted from edition ${edition} (${to}): ${why}`
        : `${r.number} back to ${to} as revision ${revision}: ${why}`,
      details: {
        number: r.number,
        from: r.status,
        to,
        revision,
        version,
        previousContentHash: previousHash,
        versionHash: hash,
        ...(edition ? { edition } : {}),
      },
    });
  });
  emit('record.transitioned', { recordId: r.id, typeId: r.type_id, action: 'revise', to });
}

export function addComment(idOrNumber: string, text: string): RecordDetail {
  const u = me();
  const r = requireRecordRow(idOrNumber);
  if (!canCommentRecord(u, r)) forbid('comment on records', 'commentRecord');
  const comment = text.trim();
  if (!comment) throw new HttpError(400, 'The comment is empty', 'COMMENT_EMPTY');
  if (comment.length > LIMITS.comment)
    throw new HttpError(400, `The comment is too long (at most ${LIMITS.comment} characters)`, 'COMMENT_TOO_LONG', { max: LIMITS.comment });
  db().tx(() => {
    const id = insertEvent(r, { kind: 'comment', action: null, from_status: null, to_status: null, comment, content_hash: null, version: Number(r.version) });
    audit({
      action: 'record.commented',
      entityType: 'record',
      entityId: r.id,
      summary: `Comment on ${r.number}: ${comment.slice(0, 300)}`,
      details: { number: r.number, eventId: id },
    });
  });
  return getRecord(r.id);
}

/** The record if the user may change it (for attachments and links). */
export function requireEditable(
  idOrNumber: string,
  what: string,
  o: { draftOnly?: boolean; notTerminal?: boolean } = {},
): { r: RecordRow; t: TypeRow; wf: RecordWorkflow } {
  const u = me();
  const r = requireRecordRow(idOrNumber);
  const t = requireType(r.type_id);
  const wf = workflowOf(t);
  if (!canEditRecord(u, r)) forbid(what, 'changeRecord');
  if (o.draftOnly && isAccessEntry(r)) {
    if (isRunEntry(r) && !isSystem(u)) runEntryLocked(r);
    if (!canDocumentAccessOn(u, accessFields(r).platform ?? '')) forbid('document access changes of this platform', 'documentAccess');
  }
  if (o.draftOnly && !isEditableStatus(wf, r.status))
    throw new HttpError(409, `${r.number} is ${r.status}: its content is frozen. Start a new revision to change it.`, 'RECORD_FROZEN', {
      number: r.number,
      status: statusParam(r.status),
    });
  if (o.notTerminal && wf.terminal.includes(r.status))
    throw new HttpError(409, `${r.number} is ${r.status}: it cannot change any more.`, 'RECORD_CLOSED', { number: r.number, status: statusParam(r.status) });
  return { r, t, wf };
}

export function touch(recordId: string): void {
  db().run('UPDATE records SET updated_at = ?, updated_by = ? WHERE id = ?', nowIso(), currentActor(), recordId);
}
