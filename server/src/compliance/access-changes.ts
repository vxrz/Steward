import { z } from 'zod';
import { ACCESS_CHANGE_KINDS, ACCESS_TYPE_ID, type AccessChange, type AccessChangeKind, type AccessChangeOrigin } from '@sm/shared';
import { db } from '../db.js';
import { currentUser, runAs, type AuthUser } from '../auth/context.js';
import { HttpError, parseJson } from '../util.js';
import { likeEscape } from '../database/sql.js';
import { requireType } from '../records/types.js';
import { createRecord, currentContentHash, frozenIntact, transition } from '../records/service.js';
import { canReadRecordRow } from '../records/access.js';
import { addAttachment } from '../records/attachments.js';
import { addLink } from '../records/links.js';
import type { RecordRow } from '../records/model.js';
import { isSubjectOf, me, SYSTEM_USER, visiblePlatformName } from './access.js';

/**
 * Access change entries are records of the built-in type "Access change" (id rty_ac, workflow
 * draft → documented → verified): they get numbers, versions, freezing with a content hash,
 * four-eyes verification, PDFs, links and attachments from the records feature. This module reads
 * their structured fields and creates them for runs and the reconciliation.
 */

export const FINAL_STATUSES = ['documented', 'verified'];

/** Rights as stored in a record field: one per line. */
export function splitRights(text: string | undefined | null): string[] {
  if (!text) return [];
  return uniqueRights(text.split(/\r?\n/));
}

export function uniqueRights(list: unknown[]): string[] {
  const seen = new Map<string, string>();
  for (const raw of list) {
    const v = String(raw ?? '').trim();
    if (v && !seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

const lower = (l: string[]) => new Set(l.map((x) => x.toLowerCase()));
/** a − b, case-insensitive. */
export const minus = (a: string[], b: string[]): string[] => {
  const bs = lower(b);
  return a.filter((x) => !bs.has(x.toLowerCase()));
};

export function accessTypeId(): string {
  return requireType(ACCESS_TYPE_ID).id;
}

const KIND_LABEL: Record<string, string> = {
  grant: 'Access granted',
  revoke: 'Access revoked',
  modify: 'Access changed',
  onboarding: 'Onboarding',
  offboarding: 'Offboarding',
};

export function entryTitle(kind: string, subject: string, granted: string[], revoked: string[]): string {
  const parts = [granted.length ? `+ ${granted.join(', ')}` : '', revoked.length ? `− ${revoked.join(', ')}` : ''].filter(Boolean).join(' ');
  const t = `${KIND_LABEL[kind] ?? kind}: ${subject}${parts ? ` (${parts})` : ''}`;
  return t.length > 300 ? `${t.slice(0, 299)}…` : t;
}

/** Frozen content that no longer matches the authentic audit entry that froze it (changed in the database). */
export function entryTampered(r: RecordRow): boolean {
  if (r.status === 'draft') return false;
  return !frozenIntact(r, currentContentHash(r, requireType(r.type_id)));
}

const lastAuthor = (r: RecordRow): string =>
  db().get<{ author: string }>('SELECT author FROM record_versions WHERE record_id = ? AND version = ?', r.id, r.version)?.author ?? r.created_by;

export function toAccessChange(r: RecordRow, u: AuthUser | null = currentUser()): AccessChange {
  const f = parseJson<Record<string, string>>(r.fields, {});
  const before = splitRights(f.rightsBefore);
  const after = splitRights(f.rightsAfter);
  return {
    recordId: r.id,
    number: r.number,
    title: r.title,
    status: r.status,
    platformId: f.platform ?? '',
    platformName: f.platform ? visiblePlatformName(u, f.platform) : null,
    subjectId: f.subjectId ?? '',
    subjectName: f.subjectName ?? '',
    subjectType: f.subjectType ?? '',
    kind: (f.changeKind as AccessChangeKind) ?? '',
    rightsBefore: before,
    rightsAfter: after,
    granted: minus(after, before),
    revoked: minus(before, after),
    reason: f.reason ?? '',
    requestedBy: f.requestedBy ?? '',
    requestRef: f.requestRef ?? '',
    approvedBy: f.approvedBy ?? '',
    performedBy: f.performedBy ?? '',
    performedAt: f.performedAt ?? '',
    origin: (f.origin as AccessChangeOrigin) ?? 'manual',
    afterTheFact: f.origin === 'reconciliation',
    runId: f.runId || null,
    findingId: f.findingId || null,
    frozenHash: r.frozen_hash,
    tampered: entryTampered(r),
    documentedBy: FINAL_STATUSES.includes(r.status) ? r.submitted_by : null,
    lastEditedBy: lastAuthor(r),
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
  };
}

export interface AccessChangeFilter {
  platformId?: string;
  subject?: string;
  status?: string[];
  kind?: string;
  /** performedAt range (ISO) */
  from?: string;
  to?: string;
  limit?: number;
}

function entryRows(platformId?: string): RecordRow[] {
  const where = ['type_id = ?'];
  const params: unknown[] = [accessTypeId()];
  if (platformId) {
    // fields is a JSON object; narrow with LIKE, then compare exactly after parsing
    where.push("lower(fields) LIKE lower(?) ESCAPE '\\'");
    params.push(`%${likeEscape(JSON.stringify(platformId))}%`);
  }
  return db().all<RecordRow>(`SELECT * FROM records WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT 20000`, ...params);
}

/** Access change entries, newest first – those the user may read (administrators, auditors, approvers, the owner, who has a right on the platform). */
export function listAccessChanges(f: AccessChangeFilter = {}): AccessChange[] {
  const u = me();
  const q = f.subject?.trim().toLowerCase();
  const out: AccessChange[] = [];
  for (const r of entryRows(f.platformId)) {
    if (!canReadRecordRow(u, r)) continue;
    const a = toAccessChange(r, u);
    if (f.platformId && a.platformId !== f.platformId) continue;
    if (f.status?.length && !f.status.includes(a.status)) continue;
    if (f.kind && a.kind !== f.kind) continue;
    if (q && !a.subjectId.toLowerCase().includes(q) && !a.subjectName.toLowerCase().includes(q)) continue;
    if (f.from && (!a.performedAt || Date.parse(a.performedAt) < Date.parse(f.from))) continue;
    if (f.to && (!a.performedAt || Date.parse(a.performedAt) > Date.parse(f.to))) continue;
    out.push(a);
    if (out.length >= (f.limit ?? 5000)) break;
  }
  return out.sort((a, b) => (b.performedAt || b.createdAt).localeCompare(a.performedAt || a.createdAt));
}

export function getAccessChange(idOrNumber: string): AccessChange {
  const u = me();
  const r = db().get<RecordRow>('SELECT * FROM records WHERE (id = ? OR number = ?) AND type_id = ?', idOrNumber, idOrNumber.toUpperCase(), accessTypeId());
  if (!r || !canReadRecordRow(u, r)) throw new HttpError(404, `Access change ${idOrNumber} not found`, 'ACCESS_CHANGE_NOT_FOUND', { id: idOrNumber });
  return toAccessChange(r, u);
}

/**
 * Whether a documented entry counts as documentation for the reconciliation: its content is intact
 * (GOV-13), and the person who documented it – for an entry of a run: who started the run – is not
 * the subject of the change (nobody documents their own access, GOV-1).
 */
export function entryCounts(a: AccessChange): boolean {
  if (!FINAL_STATUSES.includes(a.status) || a.tampered) return false;
  if (isSubjectOf(a.documentedBy, a)) return false;
  // entries of older versions name the run's starter as "user (run …)"
  return !(a.origin === 'run' && isSubjectOf(a.performedBy.replace(/ \(run [^)]*\)$/, ''), a));
}

/** Documented (or verified) entries of a platform performed in a time window that count (entryCounts) – for the reconciliation (no permission filter). */
export function documentedEntries(platformId: string, fromMs: number, toMs: number): AccessChange[] {
  return entryRows(platformId)
    .filter((r) => FINAL_STATUSES.includes(r.status))
    .filter((r) => {
      const f = parseJson<Record<string, string>>(r.fields, {});
      const t = Date.parse(f.performedAt ?? '');
      return f.platform === platformId && Number.isFinite(t) && t > fromMs && t <= toMs;
    })
    .map((r) => toAccessChange(r, null))
    .filter(entryCounts);
}

/** Whether the entry of a record (by id) counts as documentation (see entryCounts). */
export function recordCounts(recordId: string): boolean {
  const r = db().get<RecordRow>('SELECT * FROM records WHERE id = ? AND type_id = ?', recordId, accessTypeId());
  return !!r && entryCounts(toAccessChange(r, null));
}

// ---------- create ----------

export const accessChangeInput = z
  .object({
    platformId: z.string().min(1).max(100),
    subjectId: z.string().trim().min(1).max(300),
    subjectName: z.string().trim().max(300).optional(),
    subjectType: z.enum(['user', 'technical']).optional(),
    kind: z.enum(ACCESS_CHANGE_KINDS),
    rightsBefore: z.array(z.string().max(300)).max(500).default([]),
    rightsAfter: z.array(z.string().max(300)).max(500).default([]),
    reason: z.string().trim().min(1).max(4000),
    requestedBy: z.string().trim().max(200).optional(),
    requestRef: z.string().trim().max(500).optional(),
    approvedBy: z.string().trim().max(200).optional(),
    performedBy: z.string().trim().min(1).max(200),
    performedAt: z.string().datetime({ offset: true }),
    body: z
      .string()
      .max(64 * 1024)
      .optional(),
    tags: z.array(z.string()).max(30).optional(),
  })
  .strict();
export type AccessChangeCreate = z.infer<typeof accessChangeInput> & { origin?: AccessChangeOrigin; runId?: string; findingId?: string };

/** One right per line, within the size limit of a record field (a very long list ends with "… (n more)"). */
function rightsText(list: string[]): string {
  const rights = uniqueRights(list);
  let text = '';
  for (let n = 0; n < rights.length; n++) {
    const next = text ? `${text}\n${rights[n]}` : rights[n]!;
    if (next.length > 19000) return `${text}\n… (${rights.length - n} more)`;
    text = next;
  }
  return text;
}

export function entryFields(i: AccessChangeCreate): Record<string, string> {
  return {
    platform: i.platformId,
    subjectId: i.subjectId,
    subjectName: i.subjectName ?? '',
    subjectType: i.subjectType ?? '',
    changeKind: i.kind,
    rightsBefore: rightsText(i.rightsBefore),
    rightsAfter: rightsText(i.rightsAfter),
    reason: i.reason,
    requestedBy: i.requestedBy ?? '',
    requestRef: i.requestRef ?? '',
    approvedBy: i.approvedBy ?? '',
    performedBy: i.performedBy,
    performedAt: new Date(i.performedAt).toISOString(),
    origin: i.origin ?? 'manual',
    runId: i.runId ?? '',
    findingId: i.findingId ?? '',
  };
}

/**
 * Creates an access change entry as the current user (records permissions apply), optionally with
 * links and attachments, and documents it (freezes it) right away when asked.
 */
export function createAccessChange(
  i: AccessChangeCreate,
  o: {
    document?: boolean;
    comment?: string;
    links?: ({ kind: 'run' | 'platform' | 'record'; id: string; note: string } | { url: string; label: string; note: string })[];
    attachments?: { filename: string; data: Buffer }[];
  } = {},
): AccessChange {
  if (!db().get('SELECT 1 FROM platforms WHERE id = ?', i.platformId))
    throw new HttpError(400, `Platform ${i.platformId} not found`, 'PLATFORM_NOT_FOUND', { id: i.platformId });
  const before = uniqueRights(i.rightsBefore);
  const after = uniqueRights(i.rightsAfter);
  const granted = minus(after, before);
  const revoked = minus(before, after);
  const rec = createRecord({
    type: ACCESS_TYPE_ID,
    title: entryTitle(i.kind, i.subjectName || i.subjectId, granted, revoked),
    body: i.body,
    fields: entryFields(i),
    tags: i.tags,
    // origin, run and finding are Steward's to set (the generic records API refuses them)
    internal: true,
  });
  for (const l of o.links ?? []) {
    try {
      addLink('record', rec.id, 'url' in l ? { url: l.url, label: l.label, note: l.note } : { kind: l.kind, id: l.id, note: l.note }, rec.number);
    } catch (e) {
      // a link the creator may not see (e.g. a run of a restricted process) is left out, the entry still counts
      if (!(e instanceof HttpError) || e.statusCode >= 500) throw e;
    }
  }
  for (const a of o.attachments ?? []) addAttachment(rec.id, a.filename, a.data);
  if (o.document) transition(rec.id, { action: 'document', comment: o.comment });
  return getAccessChange(rec.id);
}

export { SYSTEM_USER };
export const asSystem = <T>(fn: () => T): T => runAs(SYSTEM_USER, fn);
