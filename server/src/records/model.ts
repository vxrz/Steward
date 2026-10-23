import path from 'node:path';
import type { RecordAttachment } from '@sm/shared';
import { config } from '../config.js';
import { db } from '../db.js';
import { currentUser } from '../auth/context.js';
import { canonicalJson, HttpError, parseJson, sha256 } from '../util.js';
import { canReadRecordRow } from './access.js';

/** Database rows of records and their attachments, and the content hashes. */

export interface RecordRow {
  id: string;
  type_id: string;
  number: string;
  title: string;
  status: string;
  body: string;
  fields: string;
  tags: string;
  owner: string;
  revision: number;
  version: number;
  frozen_hash: string | null;
  submitted_by: string | null;
  submitted_at: string | null;
  superseded_by: string | null;
  import_meta: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

export interface AttachmentRow {
  id: string;
  record_id: string;
  kind: 'file' | 'generated' | 'signed' | 'retired';
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  path: string;
  revision: number;
  details: string | null;
  created_at: string;
  created_by: string;
}

export const recordsDir = (): string => path.join(config.dataDir, 'records');
export const attachmentFile = (a: Pick<AttachmentRow, 'path'>): string => path.join(recordsDir(), ...a.path.split('/'));

export function recordRow(idOrNumber: string): RecordRow | undefined {
  return db().get<RecordRow>('SELECT * FROM records WHERE id = ? OR number = ?', idOrNumber, idOrNumber.toUpperCase());
}

/** A record the signed-in user may read (404 otherwise, so hidden access change entries cannot be probed). */
export function requireRecordRow(idOrNumber: string): RecordRow {
  const r = recordRow(idOrNumber);
  const u = currentUser();
  if (!r || (u && !canReadRecordRow(u, r))) throw new HttpError(404, `Record ${idOrNumber} not found`, 'RECORD_NOT_FOUND', { id: idOrNumber });
  return r;
}

export function attachmentRows(recordId: string, kind?: AttachmentRow['kind']): AttachmentRow[] {
  return kind
    ? db().all<AttachmentRow>('SELECT * FROM record_attachments WHERE record_id = ? AND kind = ? ORDER BY created_at, id', recordId, kind)
    : db().all<AttachmentRow>('SELECT * FROM record_attachments WHERE record_id = ? ORDER BY created_at, id', recordId);
}

export const toAttachment = (a: AttachmentRow): RecordAttachment => ({
  id: a.id,
  kind: a.kind,
  filename: a.filename,
  mime: a.mime,
  size: Number(a.size),
  sha256: a.sha256,
  revision: Number(a.revision),
  createdAt: a.created_at,
  createdBy: a.created_by,
  details: parseJson(a.details, null),
});

export interface Content {
  title: string;
  body: string;
  fields: Record<string, string>;
}

/** Hash of one version's text: title, body and fields (canonical JSON). */
export const versionHash = (c: Content): string => sha256(canonicalJson({ title: c.title, body: c.body, fields: c.fields }));

/**
 * Hash of a record's content as it is approved and signed: identity (id,
 * number, type, revision), title, body, fields and the SHA-256 of every
 * attached file. Links, tags and the owner are not content: they may change
 * after approval (every change is in the audit log).
 */
export function contentHash(
  r: Pick<RecordRow, 'id' | 'number' | 'revision' | 'title' | 'body' | 'fields'>,
  typeKey: string,
  files: Pick<AttachmentRow, 'filename' | 'sha256' | 'size'>[],
): string {
  return sha256(
    canonicalJson({
      record: r.id,
      number: r.number,
      type: typeKey,
      revision: Number(r.revision),
      title: r.title,
      body: r.body,
      fields: parseJson<Record<string, string>>(r.fields, {}),
      attachments: files
        .map((f) => ({ filename: f.filename, sha256: f.sha256, size: Number(f.size) }))
        .sort((a, b) => (a.sha256 + a.filename < b.sha256 + b.filename ? -1 : 1)),
    }),
  );
}
