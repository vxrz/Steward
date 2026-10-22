import { z } from 'zod';
import {
  RECORD_WORKFLOWS,
  type RecordActionInfo,
  type RecordDetail,
  type RecordEvent,
  type RecordFieldDef,
  type RecordPermissions,
  type RecordSummary,
  type RecordVersion,
  type RecordWorkflow,
} from '@sm/shared';
import { db } from '../db.js';
import { audit, authenticRows } from '../audit.js';
import { currentActor, type AuthUser } from '../auth/context.js';
import { findUserByName } from '../auth/users.js';
import { isAdmin } from '../auth/permissions.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { likeEscape } from '../database/sql.js';
import { canApproveRecords, canCommentRecord, canCreateRecords, canEditRecord, forbid, fourEyesReason, me } from './access.js';
import { attachmentRows, contentHash, recordRow, requireRecordRow, toAttachment, versionHash, type Content, type RecordRow } from './model.js';
import { requireType, toType, typeRow, type TypeRow } from './types.js';
import { addLink, listBacklinks, listLinks } from './links.js';

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
  tag: 60,
  comment: 4000,
};

export const workflowOf = (t: Pick<TypeRow, 'workflow'>): RecordWorkflow => RECORD_WORKFLOWS[t.workflow] ?? RECORD_WORKFLOWS.change;

const tagList = z.array(z.string().trim().min(1).max(LIMITS.tag)).max(LIMITS.tags);
export const cleanTags = (tags: string[]): string[] => [...new Set(tagList.parse(tags).map((t) => t.toLowerCase()))].sort();

/** Fields as stored: only keys the type defines, values checked by kind, empty values dropped. */
export function cleanFields(defs: RecordFieldDef[], input: Record<string, unknown>, o: { dropUnknown?: boolean } = {}): Record<string, string> {
  const out: Record<string, string> = {};
  const byKey = new Map(defs.map((d) => [d.key, d]));
  for (const [k, raw] of Object.entries(input ?? {})) {
    const def = byKey.get(k);
    if (!def) {
      if (o.dropUnknown) continue;
      throw new HttpError(400, `Unknown field "${k}" for this record type`);
    }
    if (raw === null || raw === undefined) continue;
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') throw new HttpError(400, `Field "${def.label}" must be text`);
    const v = String(raw).trim();
    if (!v) continue;
    if (v.length > LIMITS.field) throw new HttpError(400, `Field "${def.label}" is too long (at most ${LIMITS.field} characters)`);
    if (def.kind === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, `Field "${def.label}" must be a date (YYYY-MM-DD)`);
    if (def.kind === 'datetime' && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.test(v) || Number.isNaN(Date.parse(v)))) {
      throw new HttpError(400, `Field "${def.label}" must be a date and time (e.g. 2026-11-03T18:00)`);
    }
    if (def.kind === 'select' && !(def.options ?? []).includes(v))
      throw new HttpError(400, `Field "${def.label}" must be one of ${(def.options ?? []).join(', ')}`);
    if ((def.kind === 'text' || def.kind === 'select') && v.includes('\n')) throw new HttpError(400, `Field "${def.label}" must be a single line`);
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

const toSummary = (r: Listed): RecordSummary => ({
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
});

const SELECT = 'SELECT r.*, t.key AS type_key, t.name AS type_name, t.workflow AS workflow FROM records r JOIN record_types t ON t.id = r.type_id';

export interface ListFilter {
  type?: string;
  status?: string[];
  tag?: string;
  q?: string;
  owner?: string;
  limit?: number;
}

/** Records, newest change first. Every signed-in user may read records. */
export function listRecords(f: ListFilter = {}): RecordSummary[] {
  me();
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
  if (f.q?.trim()) {
    const q = `%${likeEscape(f.q.trim().toLowerCase())}%`;
    where.push("(lower(r.number) LIKE ? ESCAPE '\\' OR lower(r.title) LIKE ? ESCAPE '\\' OR lower(r.body) LIKE ? ESCAPE '\\')");
    params.push(q, q, q);
  }
  const tag = f.tag?.trim().toLowerCase();
  if (tag) {
    // tags are stored as a sorted JSON array of lower-case strings
    where.push("lower(r.tags) LIKE ? ESCAPE '\\'");
    params.push(`%${likeEscape(JSON.stringify(tag))}%`);
  }
  const limit = Math.min(Math.max(f.limit ?? 500, 1), 10000);
  const rows = db().all<Listed>(
    `${SELECT}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY r.updated_at DESC, r.id DESC LIMIT ?`,
    ...params,
    limit,
  );
  return rows.map(toSummary).filter((r) => !tag || r.tags.includes(tag));
}

/**
 * Everyone who wrote content of the record (four-eyes): the authors of all
 * its versions – a new revision starts as a copy of the earlier content, so
 * their authors stay authors – and everyone who attached or removed files
 * (attached files are content, too).
 */
function contentAuthors(r: RecordRow): string[] {
  const names = new Set<string>();
  for (const a of db().all<{ author: string }>('SELECT DISTINCT author FROM record_versions WHERE record_id = ?', r.id)) names.add(a.author);
  for (const a of db().all<{ created_by: string }>("SELECT DISTINCT created_by FROM record_attachments WHERE record_id = ? AND kind = 'file'", r.id))
    names.add(a.created_by);
  for (const a of db().all<{ actor: string }>(
    "SELECT DISTINCT actor FROM audit_log WHERE entity_type = 'record' AND entity_id = ? AND action IN ('record.attachment_added', 'record.attachment_removed')",
    r.id,
  ))
    names.add(a.actor);
  return [...names];
}

/** Audit actions of the transitions that leave the initial status (they freeze the content). */
const FREEZE_ACTIONS = [
  ...new Set(Object.values(RECORD_WORKFLOWS).flatMap((w) => w.transitions.filter((t) => t.from.includes(w.initial)).map((t) => `record.${t.action}`))),
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
  const draft = r.status === wf.initial;
  const edit = canEditRecord(u, r);
  return {
    edit: edit && draft,
    comment: canCommentRecord(u, r),
    revise: edit && wf.revisable.includes(r.status),
    attach: edit && draft,
    link: edit && !wf.terminal.includes(r.status),
    generatePdf: edit || canApproveRecords(u),
    uploadSigned: edit || canApproveRecords(u),
    attachPlainPdf: isAdmin(u),
  };
}

function actionsOf(u: AuthUser | null, r: RecordRow, wf: RecordWorkflow): RecordActionInfo[] {
  const out: RecordActionInfo[] = [];
  for (const t of wf.transitions) {
    if (!t.from.includes(r.status)) continue;
    let reason: string | undefined;
    if (!u) reason = 'Not signed in';
    else if (t.approval) {
      if (!canApproveRecords(u)) reason = 'Only approvers and administrators can approve or reject records';
      else reason = fourEyesReason(u, r, contentAuthors(r)) ?? undefined;
    } else if (!canEditRecord(u, r)) reason = 'Only designers, operators, administrators and the owner can do this';
    out.push({
      action: t.action,
      to: t.to,
      allowed: !reason,
      reason,
      approval: !!t.approval,
      commentRequired: !!t.commentRequired,
      needsRecord: !!t.needsRecord,
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

export function getRecord(idOrNumber: string): RecordDetail {
  const u = me();
  const r = requireRecordRow(idOrNumber);
  const t = requireType(r.type_id);
  const wf = workflowOf(t);
  const sup = r.superseded_by ? recordRow(r.superseded_by) : undefined;
  const frozen = r.status !== wf.initial;
  const hash = currentContentHash(r, t);
  return {
    ...toSummary({ ...r, type_key: t.key, type_name: t.name, workflow: t.workflow }),
    body: r.body,
    fields: parseJson<Record<string, string>>(r.fields, {}),
    fieldDefs: fieldDefsOf(r, t, frozen),
    contentHash: hash,
    frozenHash: r.frozen_hash,
    frozen,
    tampered: frozen && !frozenIntact(r, hash),
    submittedBy: r.submitted_by,
    submittedAt: r.submitted_at,
    supersededBy: sup ? { id: sup.id, number: sup.number, title: sup.title } : null,
    importMeta: parseJson<Record<string, unknown> | null>(r.import_meta, null),
    type: toType(t),
    actions: actionsOf(u, r, wf),
    permissions: permissionsOf(u, r, wf),
    attachments: attachmentRows(r.id).map(toAttachment),
    links: listLinks('record', r.id),
    backlinks: listBacklinks('record', r.id),
    events: listEvents(r.id),
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
  if (!v) throw new HttpError(404, `Version ${version} of ${r.number} not found`);
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
}

export function createRecord(input: CreateInput): RecordDetail {
  const u = me();
  if (!canCreateRecords(u)) forbid('create records');
  const t = requireType(input.type);
  if (t.archived) throw new HttpError(409, `The record type ${t.key} is archived`);
  const title = input.title.trim();
  if (!title || title.length > LIMITS.title) throw new HttpError(400, `The title is required (at most ${LIMITS.title} characters)`);
  const body = input.body ?? t.template;
  if (body.length > LIMITS.body) throw new HttpError(400, `The text is too long (at most ${LIMITS.body / 1024} KiB)`);
  const fields = cleanFields(toType(t, 0).fields, input.fields ?? {}, { dropUnknown: input.lenientFields });
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
    insertEvent(
      { id, revision: 1 },
      { kind: input.importMeta ? 'imported' : 'created', action: null, from_status: null, to_status: wf.initial, comment: '', content_hash: hash, version: 1 },
    );
    audit({
      action: input.importMeta ? 'record.imported' : 'record.created',
      entityType: 'record',
      entityId: id,
      summary: `${t.name} ${number} "${title}" ${input.importMeta ? 'imported' : 'created'}`,
      details: { number, type: t.key, versionHash: hash, ...(input.importMeta ? { import: input.importMeta } : {}) },
    });
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
  if (!canEditRecord(u, r)) forbid('change this record');
  if (input.baseVersion !== undefined && input.baseVersion !== Number(r.version)) {
    throw new HttpError(409, `${r.number} was changed in the meantime (version ${r.version}) – reload and apply your changes again`, 'RECORD_CHANGED');
  }
  const cur: Content = { title: r.title, body: r.body, fields: parseJson(r.fields, {}) };
  const next: Content = {
    title: input.title !== undefined ? input.title.trim() : cur.title,
    body: input.body !== undefined ? input.body : cur.body,
    fields: input.fields !== undefined ? cleanFields(toType(t, 0).fields, input.fields) : cur.fields,
  };
  if (!next.title || next.title.length > LIMITS.title) throw new HttpError(400, `The title is required (at most ${LIMITS.title} characters)`);
  if (next.body.length > LIMITS.body) throw new HttpError(400, `The text is too long (at most ${LIMITS.body / 1024} KiB)`);
  const contentChanged = versionHash(next) !== versionHash(cur);
  if (contentChanged && r.status !== wf.initial) {
    throw new HttpError(409, `${r.number} is ${r.status}: its content is frozen. Start a new revision to change it.`, 'RECORD_FROZEN');
  }
  const tags = input.tags !== undefined ? cleanTags(input.tags) : parseJson<string[]>(r.tags, []);
  const tagsChanged = JSON.stringify(tags) !== r.tags;
  let owner = r.owner;
  if (input.owner !== undefined && input.owner.trim().toLowerCase() !== r.owner.toLowerCase()) {
    if (!isAdmin(u) && r.owner.toLowerCase() !== u.username.toLowerCase()) forbid('hand this record over to someone else');
    const target = findUserByName(input.owner.trim());
    if (!target || !target.active) throw new HttpError(400, `User ${input.owner} not found`);
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

export interface TransitionInput {
  action: string;
  comment?: string;
  /** Id or number of the superseding record */
  supersededBy?: string;
}

export function transition(idOrNumber: string, input: TransitionInput): RecordDetail {
  const u = me();
  const r = requireRecordRow(idOrNumber);
  const t = requireType(r.type_id);
  const wf = workflowOf(t);
  const def = wf.transitions.find((x) => x.action === input.action);
  if (!def) throw new HttpError(400, `Unknown action "${input.action}" for ${t.name}`);
  if (!def.from.includes(r.status))
    throw new HttpError(409, `${r.number} is ${r.status}: "${input.action}" is not possible (allowed from ${def.from.join(', ')})`, 'INVALID_TRANSITION');
  const info = actionsOf(u, r, wf).find((a) => a.action === def.action)!;
  if (!info.allowed) throw new HttpError(403, info.reason ?? 'Not allowed', def.approval && canApproveRecords(u) ? 'FOUR_EYES' : 'FORBIDDEN');
  const comment = (input.comment ?? '').trim();
  if (comment.length > LIMITS.comment) throw new HttpError(400, `The comment is too long (at most ${LIMITS.comment} characters)`);
  if (def.commentRequired && !comment) throw new HttpError(400, 'Please give a reason in the comment');
  const leavingDraft = r.status === wf.initial;
  if (leavingDraft) {
    const fields = parseJson<Record<string, string>>(r.fields, {});
    const missing = toType(t, 0).fields.filter((f) => f.required && !fields[f.key]?.trim());
    if (missing.length && def.to !== 'cancelled')
      throw new HttpError(400, `Fill in the required fields first: ${missing.map((f) => f.label).join(', ')}`, 'RECORD_INCOMPLETE');
  }
  let superseding: RecordRow | undefined;
  if (def.needsRecord) {
    if (!input.supersededBy) throw new HttpError(400, 'Name the record that supersedes this one');
    superseding = recordRow(input.supersededBy);
    if (!superseding) throw new HttpError(404, `Record ${input.supersededBy} not found`);
    if (superseding.id === r.id) throw new HttpError(400, 'A record cannot supersede itself');
  }
  const hash = currentContentHash(r, t);
  if (!leavingDraft && !frozenIntact(r, hash)) {
    // The frozen content no longer matches the hash recorded (and audited) when it was frozen: changed outside Steward. Stop rather than approve it.
    throw new HttpError(409, `The content of ${r.number} does not match the hash recorded when it was frozen – check the audit log`, 'RECORD_TAMPERED');
  }
  const now = nowIso();
  db().tx(() => {
    db().run(
      `UPDATE records SET status = ?, frozen_hash = ?, submitted_by = ?, submitted_at = ?, superseded_by = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
      def.to,
      leavingDraft ? hash : r.frozen_hash,
      leavingDraft && def.to !== 'cancelled' ? u.username : r.submitted_by,
      leavingDraft && def.to !== 'cancelled' ? now : r.submitted_at,
      superseding ? superseding.id : r.superseded_by,
      now,
      u.username,
      r.id,
    );
    // the field definitions as they are now belong to the frozen content (labels and options may change later)
    if (leavingDraft)
      db().run('UPDATE record_versions SET field_defs = ? WHERE record_id = ? AND version = ?', JSON.stringify(toType(t, 0).fields), r.id, r.version);
    insertEvent(r, {
      kind: 'transition',
      action: def.action,
      from_status: r.status,
      to_status: def.to,
      comment,
      content_hash: hash,
      version: Number(r.version),
    });
    audit({
      action: `record.${def.action}`,
      entityType: 'record',
      entityId: r.id,
      summary: `${r.number} ${r.status} → ${def.to}${comment ? `: ${comment}` : ''}`,
      details: {
        number: r.number,
        from: r.status,
        to: def.to,
        revision: Number(r.revision),
        version: Number(r.version),
        contentHash: hash,
        ...(leavingDraft ? { frozen: true } : {}),
        ...(def.approval ? { fourEyes: true } : {}),
        ...(superseding ? { supersededBy: superseding.number } : {}),
      },
    });
    if (
      superseding &&
      !db().get("SELECT 1 FROM item_links WHERE from_kind = 'record' AND from_id = ? AND to_kind = 'record' AND to_id = ?", r.id, superseding.id)
    ) {
      addLink('record', r.id, { kind: 'record', id: superseding.id, note: 'superseded by' }, r.number);
    }
  });
  return getRecord(r.id);
}

/** Back to draft for rework: a new revision; the frozen content stays in the version history and the audit log. */
export function revise(idOrNumber: string, comment: string): RecordDetail {
  const u = me();
  const r = requireRecordRow(idOrNumber);
  const t = requireType(r.type_id);
  const wf = workflowOf(t);
  if (!canEditRecord(u, r)) forbid('start a new revision of this record');
  if (!wf.revisable.includes(r.status))
    throw new HttpError(409, `${r.number} is ${r.status}: a new revision is only possible when it is ${wf.revisable.join(' or ')}`, 'INVALID_TRANSITION');
  const why = comment.trim();
  if (!why) throw new HttpError(400, 'Please say why a new revision is needed');
  if (why.length > LIMITS.comment) throw new HttpError(400, `The comment is too long (at most ${LIMITS.comment} characters)`);
  const revision = Number(r.revision) + 1;
  const previousHash = r.frozen_hash;
  db().tx(() => {
    const version = Number(r.version) + 1;
    // The new revision starts with a copy of the frozen content (a version of its own, so authorship per revision is clear).
    const hash = insertVersion(r.id, version, revision, { title: r.title, body: r.body, fields: parseJson(r.fields, {}) }, `Revision ${revision}: ${why}`);
    db().run(
      'UPDATE records SET status = ?, revision = ?, version = ?, frozen_hash = NULL, submitted_by = NULL, submitted_at = NULL, updated_at = ?, updated_by = ? WHERE id = ?',
      wf.initial,
      revision,
      version,
      nowIso(),
      u.username,
      r.id,
    );
    insertEvent(
      { id: r.id, revision },
      { kind: 'revision', action: 'revise', from_status: r.status, to_status: wf.initial, comment: why, content_hash: previousHash, version },
    );
    audit({
      action: 'record.revised',
      entityType: 'record',
      entityId: r.id,
      summary: `${r.number} back to ${wf.initial} as revision ${revision}: ${why}`,
      details: { number: r.number, from: r.status, revision, version, previousContentHash: previousHash, versionHash: hash },
    });
  });
  return getRecord(r.id);
}

export function addComment(idOrNumber: string, text: string): RecordDetail {
  const u = me();
  const r = requireRecordRow(idOrNumber);
  if (!canCommentRecord(u, r)) forbid('comment on records');
  const comment = text.trim();
  if (!comment) throw new HttpError(400, 'The comment is empty');
  if (comment.length > LIMITS.comment) throw new HttpError(400, `The comment is too long (at most ${LIMITS.comment} characters)`);
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
  if (!canEditRecord(u, r)) forbid(what);
  if (o.draftOnly && r.status !== wf.initial)
    throw new HttpError(409, `${r.number} is ${r.status}: its content is frozen. Start a new revision to change it.`, 'RECORD_FROZEN');
  if (o.notTerminal && wf.terminal.includes(r.status)) throw new HttpError(409, `${r.number} is ${r.status}: it cannot change any more.`, 'RECORD_CLOSED');
  return { r, t, wf };
}

export function touch(recordId: string): void {
  db().run('UPDATE records SET updated_at = ?, updated_by = ? WHERE id = ?', nowIso(), currentActor(), recordId);
}
