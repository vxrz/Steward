import { z } from 'zod';
import {
  REPORT_LANGS,
  type RecordAttachment,
  type RecordDetail,
  type RecordPdfDetails,
  type RecordSigner,
  type ReportLang,
  emailAddressSchema,
} from '@sm/shared';
import { db } from '../db.js';
import { audit, queryAudit } from '../audit.js';
import { findUserByName } from '../auth/users.js';
import { drawPdf } from '../reports/pdf/pool.js';
import { brandingFor, brandingTeamOf } from '../reports/branding.js';
import { requestLang } from '../reports/service.js';
import { newId, nowIso, sha256 } from '../util.js';
import { canApproveRecord, canEditRecord, forbid, me } from './access.js';
import { requireRecordRow, toAttachment, type AttachmentRow } from './model.js';
import { getRecord, touch } from './service.js';
import { insertAttachment, writeAttachmentFile } from './attachments.js';
import type { RecordPdfModel } from './pdf-draw.js';
import { checkPdfLimits } from './signed.js';
import { editionAsRecord } from './documents.js';
import { linkTypeByKey } from './link-types.js';

/**
 * The record as an archival PDF/A-2b document for signing: header with logo,
 * number, title, status, revision/version and the content hash; the Markdown
 * text; fields, links, attached files with their hashes; approval history,
 * comments and an audit excerpt; and one signature block per external signer
 * with an empty AcroForm signature field (/FT /Sig widget, see
 * reports/pdf/engine.ts) that Acrobat and other readers can sign.
 *
 * The PDF is stored with the record and its SHA-256 goes into the audit log
 * (record.pdf_generated), so a signed copy can later be matched to it.
 */

export const MAX_SIGNERS = 8;

export const pdfInput = z
  .object({
    lang: z.enum(REPORT_LANGS).optional(),
    timeZone: z.string().max(64).optional(),
    signers: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(120),
            role: z.string().trim().max(120).default(''),
            email: emailAddressSchema({ max: 200 })
              .optional()
              .or(z.literal('').transform(() => undefined)),
          })
          .strict(),
      )
      .max(MAX_SIGNERS)
      .default([]),
  })
  .strict();
export type PdfInput = z.infer<typeof pdfInput>;

// ---------- document ----------

export interface RenderInput {
  rec: RecordDetail;
  pdfId: string;
  lang: ReportLang;
  timeZone?: string | null;
  signers: RecordSigner[];
  generatedBy: string;
  generatedAt: string;
  compress?: boolean;
  /** Living documents: the PDF shows this frozen edition (rec is the edition, see editionAsRecord) */
  edition?: string;
}

function personLabel(username: string): string {
  const u = findUserByName(username);
  return u && u.displayName && u.displayName !== username ? `${u.displayName} (${username})` : username;
}

/** Everything the PDF of a record shows, read from the database before drawing (#13). */
export function collectRecordPdf(o: RenderInput): RecordPdfModel {
  const { rec } = o;
  const doc = rec.document;
  const names = new Set<string>([o.generatedBy, rec.owner, rec.createdBy, rec.updatedBy, rec.submittedBy ?? '', ...rec.events.map((e) => e.actor)]);
  if (doc) {
    for (const e of doc.editions) for (const n of [...e.authors, e.approvedBy]) names.add(n);
    if (doc.reviews[0]) names.add(doc.reviews[0].reviewer);
    names.add(doc.review.owner);
  }
  names.delete('');
  const people = Object.fromEntries([...names].map((n) => [n, personLabel(n)]));
  const linkTypes: RecordPdfModel['linkTypes'] = {};
  for (const l of rec.links) {
    const lt = l.linkType ? linkTypeByKey(l.linkType) : undefined;
    if (lt) linkTypes[lt.key] = { key: lt.key, name: lt.name, builtin: lt.builtin };
  }
  const audit = queryAudit({ entityType: 'record', entityId: rec.id, limit: 41 }).map((a) => ({
    seq: a.seq,
    ts: a.ts,
    actor: a.actor,
    action: a.action,
    summary: a.summary,
    hash: a.hash,
  }));
  return { ...o, brand: brandingFor(brandingTeamOf('record', rec.id)), people, linkTypes, audit };
}

/** The PDF of a record: collected here, drawn in the PDF worker (reports/pdf/pool.ts). */
export async function renderRecordPdf(o: RenderInput): Promise<{ pdf: Buffer; texts: string[] }> {
  return drawPdf('record', collectRecordPdf(o));
}

/** Generates, stores and audits the PDF of a record. */
export async function generateRecordPdf(
  idOrNumber: string,
  input: PdfInput & { compress?: boolean; edition?: string },
): Promise<RecordAttachment & { texts: string[] }> {
  const u = me();
  const row = requireRecordRow(idOrNumber);
  if (!canEditRecord(u, row) && !canApproveRecord(u, row)) forbid('generate PDFs of records', 'generatePdf');
  checkPdfLimits(row.id, 'generated', 0);
  // living documents: a frozen edition instead of the current content
  const rec = input.edition ? editionAsRecord(getRecord(row.id), input.edition) : getRecord(row.id);
  // without a language in the request: the requester's profile language (as for run reports)
  const lang: ReportLang = requestLang(input.lang);
  const pdfId = newId('rpdf_');
  const generatedAt = nowIso();
  const { pdf, texts } = await renderRecordPdf({
    rec,
    pdfId,
    lang,
    timeZone: input.timeZone,
    signers: input.signers,
    generatedBy: u.username,
    generatedAt,
    compress: input.compress,
    edition: input.edition,
  });
  const hash = sha256(pdf);
  const date = generatedAt.slice(0, 10);
  const filename = input.edition
    ? `${rec.number}-e${input.edition}-${date}-${pdfId.slice(5, 11)}.pdf`
    : `${rec.number}-r${rec.revision}v${rec.version}-${date}-${pdfId.slice(5, 11)}.pdf`;
  const details: RecordPdfDetails = {
    lang,
    version: rec.version,
    revision: rec.revision,
    status: rec.status,
    contentHash: rec.frozenHash ?? rec.contentHash,
    signers: input.signers,
    ...(input.edition ? { edition: input.edition } : {}),
  };
  const rel = writeAttachmentFile(rec.id, pdfId, filename, pdf);
  let stored!: AttachmentRow;
  db().tx(() => {
    stored = insertAttachment({
      id: pdfId,
      record_id: rec.id,
      kind: 'generated',
      filename,
      mime: 'application/pdf',
      size: pdf.length,
      sha256: hash,
      path: rel,
      revision: rec.revision,
      details: JSON.stringify(details),
    });
    touch(rec.id);
    audit({
      action: 'record.pdf_generated',
      entityType: 'record',
      entityId: rec.id,
      summary: `PDF of ${rec.number}${input.edition ? ` edition ${input.edition}` : ''} (${lang}, ${input.signers.length} signature field(s)) generated – sha256 ${hash.slice(0, 16)}…`,
      details: {
        number: rec.number,
        pdfId,
        filename,
        sha256: hash,
        size: pdf.length,
        lang,
        revision: rec.revision,
        version: rec.version,
        status: rec.status,
        contentHash: details.contentHash,
        ...(input.edition ? { edition: input.edition } : {}),
        signers: input.signers.map((s) => ({ name: s.name, role: s.role })),
      },
    });
  });
  return { ...toAttachment(stored), texts };
}
