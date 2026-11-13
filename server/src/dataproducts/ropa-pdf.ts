import type { ReportLang } from '@sm/shared';
import { ReportWriter } from '../reports/pdf/engine.js';
import { translator } from '../reports/i18n.js';
import { PRODUCT, chrome, langTag, type BrandingInput } from '../reports/common.js';

/**
 * The PDF/A of the GDPR Art. 30 view (ADR 0036 part 17, decision 29): one block per data object with personal data –
 * the words of the CSV (ropa.ts ropaRows), drawn in the PDF worker from collected data (no database). A working view
 * for the data protection officer, not the register itself – the disclaimer says so.
 */

export interface RopaPdfModel {
  lang: ReportLang;
  timeZone?: string | null;
  generatedAt: string;
  generatedBy: string;
  title: string;
  subtitle: string;
  disclaimer: string;
  /** The filter the view was read with, in words ('' : everything the reader may see) */
  filter: string;
  head: string[];
  rows: string[][];
}

export async function drawRopaPdf(m: RopaPdfModel, brand: BrandingInput, o: { compress?: boolean } = {}): Promise<Buffer> {
  const tr = translator(m.lang, m.timeZone);
  const branding = brand.branding;
  const w = new ReportWriter(
    {
      title: m.title,
      author: m.generatedBy,
      subject: m.subtitle,
      keywords: [PRODUCT.split(' ')[0]!, m.title, 'GDPR Art. 30'],
      creator: PRODUCT,
      producer: `${PRODUCT} (PDFKit)`,
      lang: langTag(m.lang),
      createdAt: new Date(m.generatedAt),
      custom: { generatedBy: m.generatedBy, objects: String(m.rows.length) },
    },
    chrome(tr, brand, {
      shortTitle: m.title,
      classification: branding.classification,
      tags: [],
      lines: () => [`${tr.dateTime(m.generatedAt)} · ${m.generatedBy}`],
    }),
    { accent: branding.accentColor, compress: o.compress },
  );
  w.cover({ title: m.title, subtitle: m.subtitle, meta: [tr.dateTime(m.generatedAt), m.generatedBy, ...(m.filter ? [m.filter] : [])] });
  w.paragraph(m.disclaimer, { tone: 'muted', size: 8 });
  m.rows.forEach((row, i) => {
    w.section(`${i + 1}. ${row[0] ?? ''}`);
    w.keyValues(
      m.head.slice(1).map((label, j) => ({
        label,
        value: row[j + 1] || '–',
        span: (j >= 3 ? 2 : 1) as 1 | 2,
        ...(j === 0 ? { mono: true } : {}),
      })),
    );
  });
  if (!m.rows.length) w.paragraph('–');
  return w.finish();
}
