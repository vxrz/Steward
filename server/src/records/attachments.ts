import fs from 'node:fs';
import path from 'node:path';
import type { RecordAttachment } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentActor } from '../auth/context.js';
import { HttpError, newId, nowIso, sha256 } from '../util.js';
import { me } from './access.js';
import { attachmentFile, attachmentRows, recordsDir, requireRecordRow, toAttachment, type AttachmentRow } from './model.js';
import { requireEditable, touch } from './service.js';

/**
 * Attachments of records: documents and e-mails that belong to the content
 * (frozen with it), PDFs Steward generated and signed copies uploaded back.
 *
 * Uploads are untrusted: the extension must be on the allow-list and the
 * bytes must look like that kind of file (magic numbers, text without NUL
 * bytes). Files are written once, read-only, under <data>/records/<id>/ and
 * always downloaded as attachments, never shown inline.
 */

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS = 50;

type Family = 'pdf' | 'image' | 'ole' | 'zip' | 'text' | 'eml';

/** Allowed extensions, what the content must look like, and the type it is served with. */
const ALLOWED: Record<string, { family: Family; mime: string }> = {
  pdf: { family: 'pdf', mime: 'application/pdf' },
  png: { family: 'image', mime: 'image/png' },
  jpg: { family: 'image', mime: 'image/jpeg' },
  jpeg: { family: 'image', mime: 'image/jpeg' },
  gif: { family: 'image', mime: 'image/gif' },
  webp: { family: 'image', mime: 'image/webp' },
  eml: { family: 'eml', mime: 'message/rfc822' },
  msg: { family: 'ole', mime: 'application/vnd.ms-outlook' },
  doc: { family: 'ole', mime: 'application/msword' },
  xls: { family: 'ole', mime: 'application/vnd.ms-excel' },
  ppt: { family: 'ole', mime: 'application/vnd.ms-powerpoint' },
  docx: { family: 'zip', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  xlsx: { family: 'zip', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  pptx: { family: 'zip', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  odt: { family: 'zip', mime: 'application/vnd.oasis.opendocument.text' },
  ods: { family: 'zip', mime: 'application/vnd.oasis.opendocument.spreadsheet' },
  odp: { family: 'zip', mime: 'application/vnd.oasis.opendocument.presentation' },
  txt: { family: 'text', mime: 'text/plain' },
  md: { family: 'text', mime: 'text/markdown' },
  csv: { family: 'text', mime: 'text/csv' },
};
export const ATTACHMENT_EXTENSIONS = Object.keys(ALLOWED).map((e) => '.' + e);

const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

function looksLike(family: Family, data: Buffer): boolean {
  const head = data.subarray(0, 16);
  switch (family) {
    case 'pdf':
      return data.subarray(0, 1024).includes('%PDF-');
    case 'image':
      return (
        head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
        (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) ||
        head.subarray(0, 4).toString('latin1') === 'GIF8' ||
        (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP')
      );
    case 'ole':
      return head.subarray(0, 8).equals(OLE);
    case 'zip':
      return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
    case 'text':
      return !data.includes(0) && isUtf8(data);
    case 'eml': {
      if (data.includes(0)) return false;
      // RFC 5322 header fields at the start (From:, Subject:, Received: …)
      const start = data.subarray(0, 8192).toString('latin1');
      return (
        /^(?:[\x21-\x39\x3b-\x7e]+:[^\r\n]*\r?\n(?:[ \t][^\r\n]*\r?\n)*){2,}/.test(start) &&
        /^(from|subject|date|to|received|message-id|mime-version|return-path):/im.test(start)
      );
    }
  }
}

function isUtf8(data: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data);
    return true;
  } catch {
    return false;
  }
}

/** Kind of an uploaded file by name and content, or an error that says what is wrong. */
export function sniff(filename: string, data: Buffer): { ext: string; mime: string } {
  const ext = path.extname(filename).slice(1).toLowerCase();
  const allowed = ALLOWED[ext];
  if (!allowed)
    throw new HttpError(415, `Files of type .${ext || '?'} cannot be attached. Allowed: ${ATTACHMENT_EXTENSIONS.join(', ')}`, 'UNSUPPORTED_FILE', {
      ext: ext || '?',
      allowed: ATTACHMENT_EXTENSIONS.join(', '),
    });
  if (!data.length) throw new HttpError(400, 'The file is empty', 'FILE_EMPTY');
  if (!looksLike(allowed.family, data))
    throw new HttpError(415, `The content of ${filename} does not look like a .${ext} file`, 'CONTENT_MISMATCH', { file: filename, ext });
  return { ext, mime: allowed.mime };
}

/** Readable but harmless file name: no paths, no control characters, at most 150 characters. */
export function safeFilename(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/'));
  const clean = base
    // eslint-disable-next-line no-control-regex -- control characters are replaced on purpose
    .replace(/[\u0000-\u001f\u007f"<>|:*?/\\]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (!clean) return 'file';
  if (clean.length <= 150) return clean;
  const ext = path.extname(clean).slice(0, 12);
  return clean.slice(0, 150 - ext.length) + ext;
}

/** Writes the file once, read-only, and returns its relative path. */
export function writeAttachmentFile(recordId: string, attId: string, filename: string, data: Buffer): string {
  const rel = `${recordId}/${attId}-${filename.replace(/[^A-Za-z0-9._-]/g, '_')}`;
  const file = path.join(recordsDir(), ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, data, { flag: 'wx' });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o400);
  return rel;
}

export function insertAttachment(a: Omit<AttachmentRow, 'created_at' | 'created_by'>): AttachmentRow {
  const row: AttachmentRow = { ...a, created_at: nowIso(), created_by: currentActor() };
  db().run(
    'INSERT INTO record_attachments (id, record_id, kind, filename, mime, size, sha256, path, revision, details, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    row.id,
    row.record_id,
    row.kind,
    row.filename,
    row.mime,
    row.size,
    row.sha256,
    row.path,
    row.revision,
    row.details,
    row.created_at,
    row.created_by,
  );
  return row;
}

/** Adds a document to a draft record (part of its content). */
export function addAttachment(recordId: string, filename: string, data: Buffer): RecordAttachment {
  const { r } = requireEditable(recordId, 'add attachments to this record', { draftOnly: true });
  if (data.length > MAX_ATTACHMENT_BYTES)
    throw new HttpError(413, `The file is too large (at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB)`, 'FILE_TOO_LARGE', {
      maxMb: MAX_ATTACHMENT_BYTES / 1024 / 1024,
    });
  const name = safeFilename(filename);
  const { mime } = sniff(name, data);
  if (attachmentRows(r.id, 'file').length >= MAX_ATTACHMENTS)
    throw new HttpError(400, `At most ${MAX_ATTACHMENTS} attachments per record`, 'ATTACHMENT_LIMIT', { max: MAX_ATTACHMENTS });
  const id = newId('rat_');
  const hash = sha256(data);
  const rel = writeAttachmentFile(r.id, id, name, data);
  try {
    let row!: AttachmentRow;
    db().tx(() => {
      row = insertAttachment({
        id,
        record_id: r.id,
        kind: 'file',
        filename: name,
        mime,
        size: data.length,
        sha256: hash,
        path: rel,
        revision: Number(r.revision),
        details: null,
      });
      touch(r.id);
      audit({
        action: 'record.attachment_added',
        entityType: 'record',
        entityId: r.id,
        summary: `${name} attached to ${r.number} (${data.length} bytes, sha256 ${hash.slice(0, 16)}…)`,
        details: { number: r.number, attachmentId: id, filename: name, size: data.length, sha256: hash, mime },
      });
    });
    return toAttachment(row);
  } catch (e) {
    removeFile(rel);
    throw e;
  }
}

function removeFile(rel: string): void {
  const file = path.join(recordsDir(), ...rel.split('/'));
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* already gone */
  }
  fs.rmSync(file, { force: true });
}

/** Removes a document from a draft. Generated and signed PDFs are never removed. */
export function removeAttachment(recordId: string, attId: string): void {
  const { r } = requireEditable(recordId, 'remove attachments of this record', { draftOnly: true });
  const a = db().get<AttachmentRow>('SELECT * FROM record_attachments WHERE id = ? AND record_id = ?', attId, r.id);
  if (!a) throw new HttpError(404, 'Attachment not found', 'ATTACHMENT_NOT_FOUND');
  if (a.kind !== 'file') throw new HttpError(409, 'Generated and signed PDFs are kept for the record and cannot be removed', 'ATTACHMENT_KEPT');
  db().tx(() => {
    db().run('DELETE FROM record_attachments WHERE id = ?', a.id);
    touch(r.id);
    audit({
      action: 'record.attachment_removed',
      entityType: 'record',
      entityId: r.id,
      summary: `${a.filename} removed from ${r.number}`,
      details: { number: r.number, attachmentId: a.id, filename: a.filename, sha256: a.sha256 },
    });
  });
  removeFile(a.path);
}

/** File of an attachment for download (any signed-in user may read records). */
export function attachmentForDownload(recordId: string, attId: string): { row: AttachmentRow; data: Buffer } {
  me();
  const r = requireRecordRow(recordId);
  const a = db().get<AttachmentRow>('SELECT * FROM record_attachments WHERE id = ? AND record_id = ?', attId, r.id);
  if (!a) throw new HttpError(404, 'Attachment not found', 'ATTACHMENT_NOT_FOUND');
  let data: Buffer;
  try {
    data = fs.readFileSync(attachmentFile(a));
  } catch {
    throw new HttpError(404, 'The file of this attachment is missing in the data folder', 'ATTACHMENT_FILE_MISSING');
  }
  if (sha256(data) !== a.sha256)
    throw new HttpError(409, `The stored file of ${a.filename} does not match its recorded SHA-256 – it was changed outside Steward`, 'ATTACHMENT_TAMPERED', {
      file: a.filename,
    });
  return { row: a, data };
}

/** Content-Disposition with an ASCII fallback and the UTF-8 name (RFC 6266 / 5987). */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
