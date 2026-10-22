import type { RecordAttachment, SignatureInfo, SignedPdfDetails } from '@sm/shared';
import { db } from '../db.js';
import { audit, authenticRows } from '../audit.js';
import { isAdmin } from '../auth/permissions.js';
import { HttpError, newId, parseJson, sha256 } from '../util.js';
import { canApproveRecords, canEditRecord, forbid, me } from './access.js';
import { attachmentRows, requireRecordRow, toAttachment, type AttachmentRow, type RecordRow } from './model.js';
import { touch, workflowOf } from './service.js';
import { requireType } from './types.js';
import { insertAttachment, MAX_ATTACHMENT_BYTES, safeFilename, writeAttachmentFile } from './attachments.js';

/**
 * Signed copies of generated record PDFs.
 *
 * Signing a PDF appends an incremental update: the bytes of the original file
 * stay unchanged at the start of the signed one. A signed upload is accepted
 * when its first <size of a generated PDF> bytes have that PDF's SHA-256 – a
 * PDF Steward generated for this record's current, frozen revision, with an
 * authentic record.pdf_generated entry in the audit log – and the appended
 * part contains at least one signature dictionary, each with a signature
 * value (/Contents) and a byte range that covers its revision of the file.
 *
 * Only the structure is checked: the signer name (as the signing tool
 * claims it), signing time and byte ranges are read from the signature
 * dictionaries, but the signatures are NOT validated cryptographically (no
 * certificate chain, no PAdES validation). Use a PDF reader or a validation
 * service for that.
 */

const MAX_SIGNATURES = 50;
/** How far around a /ByteRange the signature dictionary is looked for (the /Contents placeholder is a few KB to some 100 KB). */
const DICT_WINDOW = 512 * 1024;
/** Stored PDFs per record: generated ones, signed copies, and the bytes of both together. */
export const PDF_LIMITS = { generated: 100, signed: 30, bytes: 300 * 1024 * 1024 };

/** PDF literal string body (between the outer parentheses) → bytes. */
function literalBytes(s: string): Buffer {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c !== '\\') {
      out.push(c.charCodeAt(0) & 0xff);
      continue;
    }
    const n = s[++i];
    if (n === undefined) break;
    const map: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
    if (n in map) out.push(map[n]!);
    else if (/[0-7]/.test(n)) {
      let oct = n;
      while (oct.length < 3 && /[0-7]/.test(s[i + 1] ?? '')) oct += s[++i];
      out.push(parseInt(oct, 8) & 0xff);
    } else if (n === '\r' || n === '\n') {
      if (n === '\r' && s[i + 1] === '\n') i++;
    } else out.push(n.charCodeAt(0) & 0xff);
  }
  return Buffer.from(out);
}

/** Text string bytes → JS string (UTF-16BE with BOM, UTF-8 with BOM, else PDFDocEncoding ≈ Latin-1). */
function decodeText(b: Buffer): string {
  if (b[0] === 0xfe && b[1] === 0xff) {
    const swapped = Buffer.alloc(b.length - 2);
    for (let i = 2; i + 1 < b.length; i += 2) {
      swapped[i - 2] = b[i + 1]!;
      swapped[i - 1] = b[i]!;
    }
    return swapped.toString('utf16le');
  }
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.subarray(3).toString('utf8');
  return b.toString('latin1');
}

/** Value of a string entry (/Name (…) or /Name <hex>) in a dictionary's source text. */
export function stringEntry(dict: string, key: string): string | null {
  if (!/^[A-Za-z]+$/.test(key)) throw new Error(`stringEntry: invalid PDF name "${key}"`);
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- key is a fixed PDF name (letters only, checked above)
  const re = new RegExp(`/${key}\\s*(\\(|<(?!<))`);
  const m = re.exec(dict);
  if (!m) return null;
  let i = m.index + m[0].length;
  if (m[1] === '<') {
    const end = dict.indexOf('>', i);
    if (end < 0) return null;
    const hex = dict.slice(i, Math.min(end, i + 4096)).replace(/\s+/g, '');
    if (!/^[0-9a-fA-F]*$/.test(hex)) return null;
    return decodeText(Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex')).slice(0, 500);
  }
  let depth = 1;
  let body = '';
  // values are cut to 500 characters: no need to read more than a few KB of a (possibly huge) string
  const stop = Math.min(dict.length, i + 4096);
  for (; i < stop && depth > 0; i++) {
    const c = dict[i]!;
    if (c === '\\') {
      body += c + (dict[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) break;
    }
    body += c;
  }
  return decodeText(literalBytes(body)).slice(0, 500);
}

/** PDF date (D:YYYYMMDDHHmmSS+hh'mm') → ISO 8601, or null. */
export function pdfDate(s: string | null): string | null {
  if (!s) return null;
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(Z|[+-]\d{2}'?\d{2}'?)?/.exec(s.trim());
  if (!m) return null;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', se = '00', tz] = m;
  let zone = 'Z';
  if (tz && tz !== 'Z') zone = `${tz.slice(0, 3)}:${tz.slice(3).replace(/'/g, '').padEnd(2, '0').slice(0, 2)}`;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${se}${zone}`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Signature dictionaries in a PDF: objects with /ByteRange (signature values
 * carry the byte range they cover). The /Contents placeholder is skipped.
 */
export function findSignatures(data: Buffer, from = 0): SignatureInfo[] {
  const text = data.toString('latin1');
  const out: SignatureInfo[] = [];
  // the fields that refer to a signature value (/V <n> 0 R), indexed in one pass
  let fieldRefs: Map<string, number> | null = null;
  const fieldRef = (objNo: string): number | undefined => {
    if (!fieldRefs) {
      fieldRefs = new Map();
      const re = /\/V\s+(\d+)\s+0\s+R/g;
      re.lastIndex = from;
      for (let m = re.exec(text); m; m = re.exec(text)) if (!fieldRefs.has(m[1]!)) fieldRefs.set(m[1]!, m.index);
    }
    return fieldRefs.get(objNo);
  };
  let at = text.indexOf('/ByteRange', from);
  while (at >= 0 && out.length < MAX_SIGNATURES) {
    // the object around it, looked for in a bounded window (no scan to the start or end of the file per signature)
    const winStart = Math.max(0, at - DICT_WINDOW);
    const before = text.slice(winStart, at);
    const start = before.lastIndexOf(' obj');
    const objStart = start >= 0 ? winStart + before.lastIndexOf('\n', start) + 1 : Math.max(0, at - 2000);
    const endInWin = text.slice(at, at + DICT_WINDOW).indexOf('endobj');
    const end = endInWin > 0 ? at + endInWin : Math.min(text.length, at + 4000);
    // the dictionary text without the (long) hex signature value
    const raw = text.slice(objStart, end);
    const contents = /\/Contents\s*<([0-9a-fA-F\s]*)>/.exec(raw);
    const dict = contents ? raw.slice(0, contents.index) + '/Contents <…>' + raw.slice(contents.index + contents[0].length) : raw;
    const hasContents = !!contents && /[0-9a-fA-F]/.test(contents[1]!);
    const br = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(dict);
    let byteRangeOk = false;
    if (br) {
      const [a, b, c, d] = br.slice(1).map(Number) as [number, number, number, number];
      const coversRevision =
        c + d === data.length ||
        data
          .subarray(Math.max(0, c + d - 8), c + d)
          .toString('latin1')
          .includes('%%EOF');
      byteRangeOk = hasContents && a === 0 && b > 0 && c > b && c + d <= data.length && data[b] === 0x3c && data[c - 1] === 0x3e && coversRevision;
    }
    const objNo = /^(\d+)\s+\d+\s+obj/.exec(text.slice(objStart, objStart + 40))?.[1];
    let field: string | null = null;
    if (objNo) {
      // the signature field (or merged widget) refers to the value with /V <n> 0 R
      const pos = fieldRef(objNo);
      if (pos !== undefined) {
        const fwStart = Math.max(0, pos - DICT_WINDOW);
        const fs = text.slice(fwStart, pos).lastIndexOf(' obj');
        const fe = text.slice(pos, pos + DICT_WINDOW).indexOf('endobj');
        if (fs >= 0 && fe > 0) field = stringEntry(text.slice(fwStart + fs, pos + fe), 'T');
      }
    }
    out.push({
      name: stringEntry(dict, 'Name'),
      signedAt: pdfDate(stringEntry(dict, 'M')),
      reason: stringEntry(dict, 'Reason'),
      location: stringEntry(dict, 'Location'),
      subFilter: /\/SubFilter\s*\/([A-Za-z0-9.#_-]+)/.exec(dict)?.[1] ?? null,
      field,
      byteRangeOk,
    });
    at = text.indexOf('/ByteRange', end);
  }
  return out;
}

/** Generated PDF of the record that the upload starts with, or null. */
function derivedFrom(recordId: string, data: Buffer): AttachmentRow | null {
  for (const g of attachmentRows(recordId, 'generated')) {
    const size = Number(g.size);
    if (size >= data.length) continue;
    if (
      !data
        .subarray(Math.max(0, size - 8), size)
        .toString('latin1')
        .includes('%%EOF')
    )
      continue;
    if (sha256(data.subarray(0, size)) !== g.sha256) continue;
    // Only an authentic audit entry counts: a row added to the database by hand must not make a file verify.
    const { rows } = authenticRows(
      `action = 'record.pdf_generated' AND entity_id = ? AND ${db().jsonText('details', 'sha256')} = ? AND seq >= 1`,
      [recordId, g.sha256],
      { limit: 5 },
    );
    if (rows.length) return { ...g, details: rows[0]!.details };
  }
  return null;
}

/**
 * Why a generated PDF may not be signed (yet): only a PDF of the current
 * revision, generated while its content was frozen, with the frozen content
 * hash (from its authentic audit entry). Null when it may.
 */
function notSignable(r: RecordRow, g: AttachmentRow): string | null {
  const wf = workflowOf(requireType(r.type_id));
  const d = parseJson<{ revision?: number; status?: string; contentHash?: string } | null>(g.details, null);
  if (!d || d.status === undefined || d.status === wf.initial)
    return `${g.filename} was generated from a draft: generate the PDF again once the content is frozen and sign that one`;
  if (Number(d.revision) !== Number(r.revision) || r.status === wf.initial || !r.frozen_hash || d.contentHash !== r.frozen_hash)
    return `${g.filename} shows an older revision of ${r.number}: generate the PDF of the current revision and sign that one`;
  return null;
}

export interface SignedCheck {
  ok: boolean;
  message: string;
  /** Error code when not ok and more specific than the defaults */
  code?: string;
  generated: AttachmentRow | null;
  signatures: SignatureInfo[];
  exactCopy: boolean;
}

/** Checks a signed upload without storing it. */
export function checkSignedPdf(recordId: string, data: Buffer): SignedCheck {
  const none = { generated: null, signatures: [], exactCopy: false };
  const r = requireRecordRow(recordId);
  if (!data.subarray(0, 1024).includes('%PDF-')) return { ok: false, message: 'This is not a PDF file', ...none };
  const exact = attachmentRows(recordId, 'generated').find((g) => g.sha256 === sha256(data));
  if (exact)
    return { ok: false, message: 'This is the unsigned PDF exactly as Steward generated it – sign it first', ...none, generated: exact, exactCopy: true };
  const g = derivedFrom(recordId, data);
  if (!g)
    return {
      ok: false,
      message:
        'This PDF is not derived from a PDF Steward generated for this record: its first bytes do not match any of them. Sign a PDF generated here and upload the signed file unchanged.',
      ...none,
    };
  const stale = notSignable(r, g);
  if (stale) return { ok: false, message: stale, generated: g, signatures: [], exactCopy: false, code: 'PDF_NOT_CURRENT' };
  const signatures = findSignatures(data, Number(g.size));
  if (!signatures.length)
    return {
      ok: false,
      message: 'The file starts with a PDF generated for this record, but no signature was added',
      generated: g,
      signatures,
      exactCopy: false,
    };
  if (signatures.some((x) => !x.byteRangeOk))
    return {
      ok: false,
      message:
        'A signature in this file has no signature value or a byte range that does not cover its revision of the file – upload the file exactly as the signing tool saved it',
      generated: g,
      signatures,
      exactCopy: false,
      code: 'PDF_BAD_SIGNATURE',
    };
  return { ok: true, message: `Derived from ${g.filename}; ${signatures.length} signature(s) found`, generated: g, signatures, exactCopy: false };
}

/**
 * Stores a signed copy. `plain`: administrators may attach a PDF that does not
 * pass the check (e.g. signed on paper and scanned) as a plain, unverified attachment.
 */
export function uploadSignedPdf(
  recordId: string,
  filename: string,
  data: Buffer,
  o: { plain?: boolean } = {},
): RecordAttachment & { check: Omit<SignedCheck, 'generated'> } {
  const u = me();
  const r = requireRecordRow(recordId);
  if (!canEditRecord(u, r) && !canApproveRecords(u)) forbid('upload signed PDFs');
  if (o.plain && !isAdmin(u)) forbid('attach unverified PDFs');
  if (data.length > MAX_ATTACHMENT_BYTES) throw new HttpError(413, `The file is too large (at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB)`);
  checkPdfLimits(r.id, 'signed', data.length);
  const check = checkSignedPdf(r.id, data);
  if (!check.ok && !o.plain)
    throw new HttpError(422, check.message, check.code ?? (check.exactCopy ? 'PDF_NOT_SIGNED' : check.generated ? 'PDF_NO_SIGNATURE' : 'PDF_NOT_DERIVED'));
  if (o.plain && !data.subarray(0, 1024).includes('%PDF-')) throw new HttpError(415, 'This is not a PDF file');
  const hash = sha256(data);
  if (attachmentRows(r.id).some((a) => a.sha256 === hash)) throw new HttpError(409, 'This file is attached to the record already');
  const name = safeFilename(filename.toLowerCase().endsWith('.pdf') ? filename : `${filename}.pdf`);
  const id = newId('rsig_');
  const details: SignedPdfDetails = check.ok
    ? {
        derivedFrom: check.generated!.id,
        derivedFromFilename: check.generated!.filename,
        originalSha256: check.generated!.sha256,
        originalSize: Number(check.generated!.size),
        signatures: check.signatures,
        validation: 'structure',
      }
    : { derivedFrom: '', derivedFromFilename: '', originalSha256: '', originalSize: 0, signatures: findSignatures(data), validation: 'none', plain: true };
  const rel = writeAttachmentFile(r.id, id, name, data);
  let row!: AttachmentRow;
  db().tx(() => {
    row = insertAttachment({
      id,
      record_id: r.id,
      kind: 'signed',
      filename: name,
      mime: 'application/pdf',
      size: data.length,
      sha256: hash,
      path: rel,
      revision: Number(r.revision),
      details: JSON.stringify(details),
    });
    touch(r.id);
    audit({
      action: check.ok ? 'record.signed_pdf_uploaded' : 'record.unverified_pdf_attached',
      entityType: 'record',
      entityId: r.id,
      summary: check.ok
        ? `Signed PDF ${name} uploaded to ${r.number}: derived from ${check.generated!.filename}, ${check.signatures.length} signature(s) (claimed signers: ${check.signatures.map((s) => s.name ?? '?').join(', ')}) – structure checked, not cryptographically validated`
        : `PDF ${name} attached to ${r.number} without verification by an administrator: ${check.message}`,
      details: { number: r.number, attachmentId: id, filename: name, sha256: hash, size: data.length, ...details },
    });
  });
  const { generated: _g, ...rest } = check;
  return { ...toAttachment(row), check: rest };
}

/** Refuses another stored PDF when the record has as many as PDF_LIMITS allows (disk space). */
export function checkPdfLimits(recordId: string, kind: 'generated' | 'signed', size: number): void {
  const rows = db().all<{ kind: string; n: number; bytes: number | null }>(
    "SELECT kind, COUNT(*) AS n, SUM(size) AS bytes FROM record_attachments WHERE record_id = ? AND kind IN ('generated', 'signed') GROUP BY kind",
    recordId,
  );
  const n = Number(rows.find((x) => x.kind === kind)?.n ?? 0);
  const bytes = rows.reduce((sum, x) => sum + Number(x.bytes ?? 0), 0);
  if (n >= PDF_LIMITS[kind]) throw new HttpError(409, `At most ${PDF_LIMITS[kind]} ${kind} PDFs per record`, 'PDF_LIMIT');
  if (bytes + size > PDF_LIMITS.bytes) throw new HttpError(409, `The PDFs of this record take ${PDF_LIMITS.bytes / 1024 / 1024} MB at most`, 'PDF_LIMIT');
}
