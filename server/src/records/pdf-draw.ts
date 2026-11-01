import {
  inlineText,
  parseMarkdown,
  type MdBlock,
  type RecordAttachment,
  type RecordDetail,
  type RecordEditionSummary,
  type RecordSigner,
  type ReportLang,
} from '@sm/shared';
import { COLORS, ReportWriter, type Tone } from '../reports/pdf/engine.js';
import { translator, type Translator } from '../reports/i18n.js';
import { PRODUCT, chrome, langTag, type BrandingInput } from '../reports/common.js';
import { HttpError } from '../util.js';
import { recordTexts } from './pdf-i18n.js';

/**
 * Drawing the PDF of a record (#13): from data collected beforehand (collectRecordPdf in pdf.ts), without reading
 * the database – so it can run in the PDF worker (reports/pdf/pool.ts).
 */

type Texts = ReturnType<typeof recordTexts>;

export interface RecordPdfModel {
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
  /** The branding of the record's team, if it has one (#136) */
  brand: BrandingInput;
  /** "Display name (username)" of everyone named in the PDF */
  people: Record<string, string>;
  /** Link types of the external links */
  linkTypes: Record<string, { key: string; name: string; builtin: boolean }>;
  /** The most recent audit entries of the record (at most 41, newest first) */
  audit: { seq: number; ts: string; actor: string; action: string; summary: string; hash: string }[];
}

// ---------- Markdown ----------

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

/**
 * Living documents: the "Document control" section – every approved edition up to the one shown (with kind,
 * approval, authors and change summary) and the review status (last review, next review, owner, interval).
 */
function documentControl(
  w: ReportWriter,
  rec: RecordDetail,
  R: Texts,
  tr: Translator,
  section: (title: string) => void,
  personLabel: (username: string) => string,
): void {
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

export async function drawRecordPdf(o: RecordPdfModel): Promise<{ pdf: Buffer; texts: string[] }> {
  const { rec } = o;
  const personLabel = (username: string): string => o.people[username] ?? username;
  const tr: Translator = translator(o.lang, o.timeZone);
  const R: Texts = recordTexts(o.lang);
  const { t } = R;
  const typeName = R.typeName(rec.typeKey, rec.typeName);
  const brand = o.brand;
  const branding = brand.branding;
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

  documentControl(w, rec, R, tr, section, personLabel);

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
    const lt = key ? o.linkTypes[key] : undefined;
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
  const entries = o.audit;
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
