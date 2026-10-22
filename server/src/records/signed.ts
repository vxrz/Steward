import type { RecordAttachment, SignatureInfo, SignedPdfDetails } from '@sm/shared';
import { db } from '../db.js';
import { audit, authenticRows } from '../audit.js';
import { isAdmin } from '../auth/permissions.js';
import { HttpError, newId, sha256 } from '../util.js';
import { canApproveRecords, canEditRecord, forbid, me } from './access.js';
import { attachmentRows, requireRecordRow, toAttachment, type AttachmentRow } from './model.js';
import { touch } from './service.js';
import { insertAttachment, MAX_ATTACHMENT_BYTES, safeFilename, writeAttachmentFile } from './attachments.js';

/**
 * Signed copies of generated record PDFs.
 *
 * Signing a PDF appends an incremental update: the bytes of the original file
 * stay unchanged at the start of the signed one. A signed upload is accepted
 * when its first <size of a generated PDF> bytes have that PDF's SHA-256 – a
 * PDF Steward generated for this record, with an authentic
 * record.pdf_generated entry in the audit log – and the appended part
 * contains at least one signature dictionary.
 *
 * Only the structure is checked: signer name, signing time and byte ranges
 * are read from the signature dictionaries, but the signatures are NOT
 * validated cryptographically (no certificate chain, no PAdES validation).
 * Use a PDF reader or a validation service for that.
 */

const MAX_SIGNATURES = 50;

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
  const re = new RegExp(`/${key}\\s*(\\(|<(?!<))`);
  const m = re.exec(dict);
  if (!m) return null;
  let i = m.index + m[0].length;
  if (m[1] === '<') {
    const end = dict.indexOf('>', i);
    if (end < 0) return null;
    const hex = dict.slice(i, end).replace(/\s+/g, '');
    if (!/^[0-9a-fA-F]*$/.test(hex)) return null;
    return decodeText(Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex')).slice(0, 500);
  }
  let depth = 1;
  let body = '';
  for (; i < dict.length && depth > 0; i++) {
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
  let at = text.indexOf('/ByteRange', from);
  while (at >= 0 && out.length < MAX_SIGNATURES) {
    const start = text.lastIndexOf(' obj', at);
    const objStart = start >= 0 ? text.lastIndexOf('\n', start) + 1 : Math.max(0, at - 2000);
    const endObj = text.indexOf('endobj', at);
    const end = endObj > 0 ? endObj : Math.min(text.length, at + 4000);
    // the dictionary text without the (long) hex signature value
    const dict = text.slice(objStart, end).replace(/\/Contents\s*<[0-9a-fA-F\s]*>/, '/Contents <…>');
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
      byteRangeOk = a === 0 && b > 0 && c > b && c + d <= data.length && data[b] === 0x3c && data[c - 1] === 0x3e && coversRevision;
    }
    const objNo = /^(\d+)\s+\d+\s+obj/.exec(text.slice(objStart, objStart + 40))?.[1];
    let field: string | null = null;
    if (objNo) {
      // the signature field (or merged widget) refers to the value with /V <n> 0 R
      const ref = new RegExp(`/V\\s+${objNo}\\s+0\\s+R`).exec(text.slice(from));
      if (ref) {
        const pos = from + ref.index;
        const fs = text.lastIndexOf(' obj', pos);
        const fe = text.indexOf('endobj', pos);
        if (fs >= 0 && fe > 0) field = stringEntry(text.slice(fs, fe), 'T');
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
    if (rows.length) return g;
  }
  return null;
}

export interface SignedCheck {
  ok: boolean;
  message: string;
  generated: AttachmentRow | null;
  signatures: SignatureInfo[];
  exactCopy: boolean;
}

/** Checks a signed upload without storing it. */
export function checkSignedPdf(recordId: string, data: Buffer): SignedCheck {
  const none = { generated: null, signatures: [], exactCopy: false };
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
  const signatures = findSignatures(data, Number(g.size));
  if (!signatures.length)
    return {
      ok: false,
      message: 'The file starts with a PDF generated for this record, but no signature was added',
      generated: g,
      signatures,
      exactCopy: false,
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
  const check = checkSignedPdf(r.id, data);
  if (!check.ok && !o.plain)
    throw new HttpError(422, check.message, check.exactCopy ? 'PDF_NOT_SIGNED' : check.generated ? 'PDF_NO_SIGNATURE' : 'PDF_NOT_DERIVED');
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
        ? `Signed PDF ${name} uploaded to ${r.number}: derived from ${check.generated!.filename}, ${check.signatures.length} signature(s) (${check.signatures.map((s) => s.name ?? '?').join(', ')}) – structure checked, not cryptographically validated`
        : `PDF ${name} attached to ${r.number} without verification by an administrator: ${check.message}`,
      details: { number: r.number, attachmentId: id, filename: name, sha256: hash, size: data.length, ...details },
    });
  });
  const { generated: _g, ...rest } = check;
  return { ...toAttachment(row), check: rest };
}
