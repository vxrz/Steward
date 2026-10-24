import { z } from 'zod';
import {
  inlineText,
  parseMarkdown,
  REPORT_LANGS,
  type MdBlock,
  type RecordAttachment,
  type RecordDetail,
  type RecordEditionSummary,
  type RecordPdfDetails,
  type RecordSigner,
  type ReportLang,
} from '@sm/shared';
import { db } from '../db.js';
import { audit, queryAudit } from '../audit.js';
import { findUserByName } from '../auth/users.js';
import { COLORS, ReportWriter, type Tone } from '../reports/pdf/engine.js';
import { getBranding, logo } from '../reports/branding.js';
import { requestLang } from '../reports/service.js';
import { translator, type Translator } from '../reports/i18n.js';
import { PRODUCT, chrome, langTag } from '../reports/common.js';
import { HttpError, newId, nowIso, sha256 } from '../util.js';
import { canApproveRecords, canEditRecord, forbid, me } from './access.js';
import { requireRecordRow, toAttachment, type AttachmentRow } from './model.js';
import { getRecord, touch } from './service.js';
import { insertAttachment, writeAttachmentFile } from './attachments.js';
import { recordTexts } from './pdf-i18n.js';
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
            email: z
              .string()
              .trim()
              .max(200)
              .email()
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

type Texts = ReturnType<typeof recordTexts>;

function personLabel(username: string): string {
  const u = findUserByName(username);
  return u && u.displayName && u.displayName !== username ? `${u.displayName} (${username})` : username;
}

// ---------- Markdown ----------

function codeBlock(w: ReportWriter, code: string, indent: number): void {
  const lines = code.split('\n');
  const width = w.width - indent - 12;
  for (let i = 0; i < lines.length; i += 30) {
    const chunk = lines.slice(i, i + 30).join('\n') || ' ';
    const h = w.measure(chunk, width, 'mono', 7.4, 1) + 8;
    w.ensure(Math.min(h + 4, 400));
    const y = w.y;
    w.doc.rect(w.left + indent, y, w.width - indent, h).fill(COLORS.zebra);
    w.doc.rect(w.left + indent, y, 2, h).fill(COLORS.border);
    w.font('mono', 7.4).fillColor(COLORS.text);
    w.text(chunk, w.left + indent + 7, y + 4, { width, lineGap: 1 });
    w.y = Math.max(w.y, y + h) + 4;
  }
}

function drawBlocks(w: ReportWriter, blocks: MdBlock[], indent = 0, tone: 'default' | 'muted' = 'default'): void {
  for (const b of blocks) {
    switch (b.t) {
      case 'heading': {
        const text = inlineText(b.c);
        if (b.level <= 2 && indent === 0) w.subheading(text);
        else w.paragraph(text, { bold: true, size: b.level <= 3 ? 9.5 : 9, indent, tone });
        break;
      }
      case 'paragraph':
        w.paragraph(inlineText(b.c, { linkUrls: true }), { indent, tone });
        break;
      case 'list':
        b.items.forEach((it, i) => {
          const marker = b.ordered ? `${b.start + i}.` : '•';
          const box = it.checked === undefined ? '' : it.checked ? '[x] ' : '[ ] ';
          const [first, ...rest] = it.blocks;
          if (first?.t === 'paragraph') w.paragraph(`${marker}  ${box}${inlineText(first.c, { linkUrls: true })}`, { indent: indent + 8, tone });
          else {
            w.paragraph(`${marker}  ${box}`, { indent: indent + 8, tone });
            if (first) drawBlocks(w, [first], indent + 20, tone);
          }
          if (rest.length) drawBlocks(w, rest, indent + 20, tone);
        });
        break;
      case 'code':
        codeBlock(w, b.v, indent);
        break;
      case 'quote': {
        drawBlocks(w, b.blocks, indent + 12, 'muted');
        break;
      }
      case 'table': {
        const cols = b.head.map((h, i) => ({ header: inlineText(h) || ' ', width: 1, align: b.align[i] ?? undefined }));
        // Wide tables in Markdown are rare; more than 8 columns would not be readable on A4.
        const n = Math.min(cols.length, 8);
        w.table(
          cols.slice(0, n).map((c) => ({ ...c, align: c.align ?? 'left' })),
          b.rows.map((r) => r.slice(0, n).map((c) => inlineText(c, { linkUrls: true }))),
          { size: 7.6 },
        );
        break;
      }
      case 'hr':
        w.ensure(12);
        w.doc
          .moveTo(w.left + indent, w.y + 4)
          .lineTo(w.right, w.y + 4)
          .lineWidth(0.6)
          .stroke(COLORS.border);
        w.y += 10;
        break;
    }
  }
}

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

/**
 * Living documents: the "Document control" section – every approved edition up to the one shown (with kind,
 * approval, authors and change summary) and the review status (last review, next review, owner, interval).
 */
function documentControl(w: ReportWriter, rec: RecordDetail, R: Texts, tr: Translator, section: (title: string) => void): void {
  const doc = rec.document;
  if (!doc) return;
  const { t } = R;
  section(t('documentControl'));
  w.paragraph(t('documentControlIntro'), { tone: 'muted', size: 8 });
  w.table(
    [
      { header: t('edition'), width: 0.9 },
      { header: t('kind'), width: 0.9 },
      { header: t('approvedAt'), width: 1.9 },
      { header: t('authors'), width: 1.9 },
      { header: t('approvedBy'), width: 1.6 },
      { header: t('changeSummary'), width: 3.6 },
      { header: t('hash'), width: 1.5, mono: true },
    ],
    doc.editions.map((e: RecordEditionSummary) => [
      { text: e.edition, bold: e.current },
      t(e.kind === 'minor' ? 'kind_minor' : 'kind_major'),
      tr.dateTime(e.approvedAt),
      e.authors.map(personLabel).join(', ') || '–',
      personLabel(e.approvedBy),
      e.changeSummary || '–',
      e.intact ? e.contentHash.slice(0, 16) + '…' : `${e.contentHash.slice(0, 16)}… (${t('notIntact')})`,
    ]),
    { empty: t('editionNone'), size: 7.4 },
  );
  const last = doc.reviews[0];
  const r = doc.review;
  w.keyValues([
    {
      label: t('lastReview'),
      value: last
        ? `${tr.dateTime(last.createdAt)} · ${personLabel(last.reviewer)} · ${t(last.outcome === 'no_change' ? 'review_no_change' : 'review_needs_update')}${last.edition ? ` (${t('editionNo', { edition: last.edition })})` : ''}${last.intact ? '' : ` · ${t('notIntact')}`}`
        : '–',
      tone: last && !last.intact ? ('danger' as const) : ('default' as const),
      span: 2,
    },
    ...(last?.comment ? [{ label: t('comment'), value: last.comment, span: 2 as const }] : []),
    {
      label: t('nextReview'),
      value: r.nextReviewAt ? `${tr.date(r.nextReviewAt)} (${t(`reviewStatus_${r.status}`)})` : '–',
      tone: r.status === 'overdue' ? 'danger' : r.status === 'dueSoon' ? 'warning' : 'default',
    },
    { label: t('reviewInterval'), value: r.intervalMonths > 0 ? t('reviewIntervalMonths', { n: r.intervalMonths }) : t('reviewNone') },
    { label: t('reviewOwner'), value: personLabel(r.owner) },
  ]);
}

export async function renderRecordPdf(o: RenderInput): Promise<{ pdf: Buffer; texts: string[] }> {
  const { rec } = o;
  const tr: Translator = translator(o.lang, o.timeZone);
  const R: Texts = recordTexts(o.lang);
  const { t } = R;
  const typeName = R.typeName(rec.typeKey, rec.typeName);
  const branding = getBranding();
  const brand = { branding, logo: logo().data };
  const hash = rec.frozenHash ?? rec.contentHash;
  const tampered = rec.tampered;
  const draft = !rec.frozen;
  const tags: { text: string; tone: Tone }[] = draft
    ? [{ text: R.t('draftTag'), tone: 'warning' as const }]
    : [
        {
          text: R.status(rec.status),
          tone: (['approved', 'accepted', 'implemented', 'closed', 'published'].includes(rec.status)
            ? 'success'
            : rec.status === 'rejected'
              ? 'danger'
              : 'info') as 'success',
        },
      ];
  // living documents: the edition shown (the frozen one, or the draft of the next one)
  const doc = rec.document;
  const shownEdition = o.edition ?? (doc && !draft && rec.status !== 'in_review' ? doc.currentEdition : null);
  const editionLabel = !doc
    ? ''
    : shownEdition
      ? t('editionNo', { edition: shownEdition })
      : doc.pending
        ? t('editionDraft', { edition: doc.pending.edition })
        : draft || rec.status === 'in_review'
          ? t('editionDraft', { edition: doc.currentEdition ? doc.nextEdition.minor : '1.0' })
          : t('editionNone');
  if (shownEdition) tags.unshift({ text: t('editionNo', { edition: shownEdition }), tone: 'info' });
  const footerVars = {
    number: rec.number,
    revision: rec.revision,
    version: rec.version,
    date: tr.dateTime(o.generatedAt),
    user: personLabel(o.generatedBy),
    pdfId: o.pdfId,
  };

  const w = new ReportWriter(
    {
      title: `${rec.number} ${rec.title}`,
      author: personLabel(o.generatedBy),
      subject: `${typeName} ${rec.number} – ${R.status(rec.status)} – ${t('revisionVersion', { revision: rec.revision, version: rec.version })}`,
      keywords: [PRODUCT.split(' ')[0]!, typeName, rec.number, rec.status, ...rec.tags.slice(0, 10)],
      creator: PRODUCT,
      producer: `${PRODUCT} (PDFKit)`,
      lang: langTag(o.lang),
      createdAt: new Date(o.generatedAt),
      custom: {
        reportId: o.pdfId,
        reportKind: 'record',
        recordId: rec.id,
        recordNumber: rec.number,
        recordType: rec.typeKey,
        recordStatus: rec.status,
        recordRevision: String(rec.revision),
        recordVersion: String(rec.version),
        contentHash: hash,
        contentFrozen: String(!draft),
        signers: String(o.signers.length),
        generatedBy: o.generatedBy,
        generatedAt: o.generatedAt,
      },
    },
    chrome(tr, brand, {
      shortTitle: `${rec.number} · ${rec.title}`,
      classification: branding.classification,
      tags,
      lines: () => [t('footerRecord', footerVars), t('footerHash', { hash }), t('footerVerify', { pdfId: o.pdfId })],
    }),
    { accent: branding.accentColor, compress: o.compress },
  );

  w.cover({
    title: typeName,
    subtitle: `${rec.number} – ${rec.title}`,
    meta: [
      tr.t('generatedWith', { product: PRODUCT }),
      t('recordNo', { number: rec.number }),
      ...(doc ? [editionLabel] : []),
      t('revisionVersion', { revision: rec.revision, version: rec.version }),
      tr.dateTime(o.generatedAt),
    ],
  });
  if (tampered) w.banner(t('tamperedTitle'), t('tamperedBody'), 'danger');
  if (draft) w.banner(t('draftTitle'), t('draftBody'), 'warning');
  if (o.edition && doc && doc.currentEdition !== o.edition)
    w.banner(t('editionOldTitle', { edition: o.edition }), t('editionOldBody', { current: doc.currentEdition ?? '–' }), 'info');

  let n = 0;
  const section = (title: string) => w.section(`${++n}. ${title}`);

  section(t('summary'));
  w.keyValues([
    { label: t('number'), value: rec.number, mono: true },
    { label: t('type'), value: `${typeName} (${rec.typeKey})` },
    { label: t('status'), value: R.status(rec.status), tone: draft ? 'warning' : 'default' },
    { label: t('revision') + ' / ' + t('version'), value: `${rec.revision} / ${rec.version}` },
    ...(rec.document ? [{ label: t('edition'), value: editionLabel, tone: draft ? ('warning' as const) : ('default' as const) }] : []),
    { label: t('owner'), value: personLabel(rec.owner) },
    { label: t('created'), value: `${tr.dateTime(rec.createdAt)} · ${personLabel(rec.createdBy)}` },
    { label: t('updated'), value: `${tr.dateTime(rec.updatedAt)} · ${personLabel(rec.updatedBy)}` },
    { label: t('submitted'), value: rec.submittedAt ? `${tr.dateTime(rec.submittedAt)} · ${personLabel(rec.submittedBy ?? '')}` : '–' },
    ...(rec.supersededBy
      ? [
          {
            label: t('supersededBy'),
            value: rec.supersededBy.visible ? `${rec.supersededBy.number} ${rec.supersededBy.title}` : t('notVisible'),
            span: 2 as const,
          },
        ]
      : []),
    { label: t('contentHash'), value: hash, mono: true, span: 2, tone: tampered ? 'danger' : 'default' },
  ]);
  w.paragraph(draft ? t('draftHashNote') : t('frozenHashNote'), { tone: 'muted', size: 7.8 });

  documentControl(w, rec, R, tr, section);

  // the definitions frozen with the content: labels and options as they were approved
  if (rec.fieldDefs.length) {
    section(t('fields'));
    w.keyValues(
      rec.fieldDefs.map((f) => {
        const raw = rec.fields[f.key] ?? '';
        const value = !raw
          ? '–'
          : f.kind === 'datetime'
            ? tr.dateTime(raw)
            : f.kind === 'date'
              ? tr.date(raw + 'T12:00:00Z')
              : f.kind === 'select'
                ? R.option(rec.typeKey, f, raw)
                : raw;
        return { label: R.fieldLabel(rec.typeKey, f), value, span: f.kind === 'textarea' ? (2 as const) : (1 as const) };
      }),
    );
  }

  section(t('content'));
  const blocks = parseMarkdown(rec.body);
  if (blocks.length) drawBlocks(w, blocks);
  else w.paragraph(t('noContent'), { tone: 'muted' });

  const files = rec.attachments.filter((a: RecordAttachment) => a.kind === 'file');
  section(t('attachments'));
  w.paragraph(t('attachmentsIntro'), { tone: 'muted', size: 8 });
  w.table(
    [
      { header: t('file'), width: 3.2 },
      { header: t('size'), width: 1, align: 'right' },
      { header: t('sha256'), width: 5.2, mono: true },
    ],
    files.map((f) => [f.filename, tr.bytes(f.size), f.sha256]),
    { empty: t('none'), size: 7.4 },
  );

  // external links: "external · Runbook" (built-in types translated, administrators' own as named)
  const linkTypeLabel = (key: string | null) => {
    const lt = key ? linkTypeByKey(key) : undefined;
    return lt ? `${t('external')} · ${lt.builtin ? R.linkType(lt.key) : lt.name}` : t('external');
  };
  section(t('links'));
  w.table(
    [
      { header: t('linkKind'), width: 1.3 },
      { header: t('linkTarget'), width: 5.5 },
      { header: t('linkNote'), width: 2.2 },
    ],
    rec.links.map((l) => [
      l.kind ?? linkTypeLabel(l.linkType),
      l.kind ? (l.visible ? l.label : t('notVisible')) : `${l.label && l.label !== l.url ? l.label + ' – ' : ''}${l.url}`,
      l.note,
    ]),
    { empty: t('none') },
  );

  section(t('history'));
  w.table(
    [
      { header: t('time'), width: 2.1 },
      { header: t('person'), width: 1.8 },
      { header: t('event'), width: 2.2 },
      { header: t('comment'), width: 3.8 },
      { header: t('hash'), width: 1.7, mono: true },
    ],
    rec.events.map((e) => {
      const ev =
        e.kind === 'transition'
          ? `${R.action(e.action ?? '')} (${R.status(e.fromStatus ?? '')} → ${R.status(e.toStatus ?? '')})`
          : e.kind === 'revision'
            ? t('ev_revision', { revision: e.revision })
            : e.kind === 'comment'
              ? t('ev_comment')
              : t(e.kind === 'imported' ? 'ev_imported' : 'ev_created');
      return [
        tr.dateTime(e.createdAt),
        personLabel(e.actor),
        { text: ev, bold: e.kind === 'transition' },
        e.comment || '–',
        e.contentHash ? e.contentHash.slice(0, 16) + '…' : '–',
      ];
    }),
    { empty: t('none'), size: 7.4 },
  );

  // audit excerpt: the most recent entries of this record, oldest first
  const entries = queryAudit({ entityType: 'record', entityId: rec.id, limit: 41 });
  const shown = entries.slice(0, 40).reverse();
  section(t('auditExcerpt'));
  w.paragraph(t('auditIntro'), { tone: 'muted', size: 8 });
  w.table(
    [
      { header: t('seq'), width: 0.7, align: 'right' },
      { header: t('time'), width: 2 },
      { header: t('actor'), width: 1.3 },
      { header: t('action'), width: 2.1, mono: true },
      { header: t('summaryCol'), width: 4 },
      { header: t('hash'), width: 1.8, mono: true },
    ],
    shown.map((a) => [String(a.seq), tr.dateTime(a.ts), a.actor, a.action, a.summary, a.hash.slice(0, 16) + '…']),
    { size: 7.2, empty: t('none') },
  );
  if (entries.length > 40) w.paragraph(t('auditTruncated', { n: entries.length - 40 }), { tone: 'muted', size: 8 });

  if (o.signers.length) {
    w.ensure(270);
    section(t('signatures'));
    w.paragraph(t('signaturesIntro'), { tone: 'muted', size: 8 });
    const perRow = o.signers.length === 3 ? 3 : 2;
    for (let i = 0; i < o.signers.length; i += perRow) {
      const row = o.signers.slice(i, i + perRow);
      w.signatureBlocks(
        row.map((s, j) => {
          const no = i + j + 1;
          return {
            title: s.role || t('signer', { n: no }),
            name: s.email ? `${s.name} <${s.email}>` : s.name,
            role: s.role,
            fieldName: `Signature_${no}_${
              (s.role || s.name)
                .replace(/[^A-Za-z0-9]+/g, '_')
                .replace(/^_+|_+$/g, '')
                .slice(0, 40) || 'Signer'
            }`,
            fieldHint: `${s.role ? s.role + ': ' : ''}${s.name} – ${rec.number} (${o.pdfId})`,
          };
        }),
        { name: tr.t('name'), role: tr.t('role'), date: tr.t('date'), signature: tr.t('signature'), digital: tr.t('digitalSignature') },
      );
    }
  }

  // never a cut copy for signing
  if (w.truncated) throw new HttpError(413, `${rec.number} is too large for a PDF – shorten its text or fields`, 'RECORD_TOO_LARGE', { number: rec.number });
  const pdf = await w.finish();
  return { pdf, texts: w.texts };
}

/** Generates, stores and audits the PDF of a record. */
export async function generateRecordPdf(
  idOrNumber: string,
  input: PdfInput & { compress?: boolean; edition?: string },
): Promise<RecordAttachment & { texts: string[] }> {
  const u = me();
  const row = requireRecordRow(idOrNumber);
  if (!canEditRecord(u, row) && !canApproveRecords(u)) forbid('generate PDFs of records', 'generatePdf');
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
