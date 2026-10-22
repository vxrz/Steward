import { PDFDocument, internals, openImage, type PdfRef } from './pdfkit.js';
import { FONT_FILES, assetPath, ensureColorProfile } from './assets.js';

/**
 * Small layout engine on top of PDFKit for archival reports:
 * A4, PDF/A-2b (embedded fonts, sRGB output intent, XMP metadata), a branded
 * first-page header, compact headers and an integrity footer on every page,
 * tables that paginate with repeated headers, key/value boxes, banners and
 * empty AcroForm signature fields.
 *
 * Every string drawn is also recorded in `texts` (tests assert on it without
 * having to parse PDF content streams).
 */

export type Tone = 'default' | 'muted' | 'success' | 'danger' | 'warning' | 'info' | 'accent';

export interface Cell {
  text: string;
  tone?: Tone;
  bold?: boolean;
  mono?: boolean;
  /** Indentation level (step nesting) */
  indent?: number;
}
export type CellInput = string | number | null | undefined | Cell;

export interface Column {
  header: string;
  /** Relative width */
  width: number;
  mono?: boolean;
  align?: 'left' | 'right' | 'center';
}

export interface PdfMeta {
  title: string;
  author: string;
  subject: string;
  keywords: string[];
  creator: string;
  producer: string;
  /** BCP 47, e.g. en-GB */
  lang: string;
  createdAt: Date;
  /** Written to the Info dictionary and, described by a PDF/A extension schema, to XMP (stw:*) */
  custom: Record<string, string>;
}

export interface Chrome {
  logo: Buffer;
  companyName: string;
  /** Short title for the compact header of pages 2+ */
  shortTitle: string;
  classification: string;
  /** Prominent tags in every header, e.g. DRY RUN / INTERIM */
  tags: { text: string; tone: Tone }[];
  /** Footer lines per page (page numbers are 1-based) */
  footer: (page: number, total: number) => { left: string; right: string; lines: string[] };
}

export interface WriterOptions {
  accent: string;
  /** Default true; tests may switch compression off */
  compress?: boolean;
}

export const COLORS = {
  text: '#1f2933',
  muted: '#5f6b7a',
  light: '#8a94a3',
  border: '#d5dbe3',
  rowLine: '#e6e9ee',
  headBg: '#eef1f5',
  zebra: '#f8f9fb',
  success: '#2b8a3e',
  danger: '#c92a2a',
  warning: '#a65400',
  info: '#1864ab',
};

const BANNER: Record<'warning' | 'danger' | 'info' | 'success', { bg: string; bar: string }> = {
  warning: { bg: '#fff4d6', bar: '#f0a020' },
  danger: { bg: '#fdecec', bar: '#e03131' },
  info: { bg: '#e8f1fb', bar: '#1c7ed6' },
  success: { bg: '#e9f6ec', bar: '#2f9e44' },
};

export const XMP_NS = 'http://ns.uebelacker.io/steward/report/1.0/';
const XMP_PREFIX = 'stw';

const MARGIN = { top: 66, bottom: 76, left: 48, right: 48 };

const GLYPH_FALLBACK: Record<string, string> = {
  '✔': '✓',
  '✅': '✓',
  '☑': '✓',
  '✘': '✗',
  '✖': '✗',
  '❌': '✗',
  '☐': '–',
  '⚠': '!',
  '❗': '!',
  '•': '·',
};
const MAX_CELL_CHARS = 3000;

/** Characters PDFKit cannot place sensibly (tabs, other control characters). */
export function clean(s: unknown): string {
  return String(s ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

const xmlEsc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
/** PDFKit writes Title/Author/Subject/Keywords unescaped into XMP; keep them XML-safe and identical to the Info dictionary (PDF/A). */
const metaSafe = (s: string) => clean(s).replace(/\n/g, ' ').replace(/&/g, '+').replace(/</g, '‹').replace(/>/g, '›').slice(0, 500);

function mix(hex: string, white: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(c + (255 - c) * white));
  return '#' + ch.map((c) => c.toString(16).padStart(2, '0')).join('');
}

export class ReportWriter {
  readonly doc: PDFKit.PDFDocument;
  readonly texts: string[] = [];
  readonly accent: string;
  readonly accentTint: string;
  private sigFields: PdfRef[] = [];
  private chunks: Buffer[] = [];
  private chrome: Chrome;

  constructor(meta: PdfMeta, chrome: Chrome, opts: WriterOptions) {
    ensureColorProfile();
    this.chrome = chrome;
    this.accent = /^#[0-9a-f]{6}$/i.test(opts.accent) ? opts.accent : '#1c7ed6';
    this.accentTint = mix(this.accent, 0.93);
    this.doc = new PDFDocument({
      size: 'A4',
      margins: MARGIN,
      pdfVersion: '1.7',
      subset: 'PDF/A-2b',
      lang: meta.lang,
      displayTitle: true,
      bufferPages: true,
      autoFirstPage: true,
      compress: opts.compress ?? true,
      // Never touch the (non-embedded) standard fonts: start with an embedded one.
      font: assetPath(FONT_FILES.sans),
      info: {
        Title: metaSafe(meta.title),
        Author: metaSafe(meta.author),
        Subject: metaSafe(meta.subject),
        Keywords: metaSafe(meta.keywords.join(', ')),
        Creator: metaSafe(meta.creator),
        Producer: metaSafe(meta.producer),
        CreationDate: meta.createdAt,
        ModDate: meta.createdAt,
        ...Object.fromEntries(Object.entries(meta.custom).map(([k, v]) => [k, metaSafe(v)])),
      } as PDFKit.DocumentInfo,
    });
    this.doc.on('data', (c: Buffer) => this.chunks.push(c));
    this.doc.registerFont('sans', assetPath(FONT_FILES.sans));
    this.doc.registerFont('bold', assetPath(FONT_FILES.sansBold));
    this.doc.registerFont('mono', assetPath(FONT_FILES.mono));
    this.appendCustomXmp(meta);
    this.doc.font('sans').fontSize(9).fillColor(COLORS.text);
  }

  private appendCustomXmp(meta: PdfMeta): void {
    const props = Object.keys(meta.custom);
    if (!props.length) return;
    const schemaProps = props
      .map(
        (p) => `<rdf:li rdf:parseType="Resource"><pdfaProperty:name>${xmlEsc(p)}</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>${xmlEsc(p)} of the Steward report</pdfaProperty:description></rdf:li>`,
      )
      .join('');
    this.doc.appendXML(`
        <rdf:Description rdf:about="" xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#" xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">
            <pdfaExtension:schemas><rdf:Bag><rdf:li rdf:parseType="Resource">
                <pdfaSchema:schema>Steward report</pdfaSchema:schema>
                <pdfaSchema:namespaceURI>${XMP_NS}</pdfaSchema:namespaceURI>
                <pdfaSchema:prefix>${XMP_PREFIX}</pdfaSchema:prefix>
                <pdfaSchema:property><rdf:Seq>${schemaProps}</rdf:Seq></pdfaSchema:property>
            </rdf:li></rdf:Bag></pdfaExtension:schemas>
        </rdf:Description>
        <rdf:Description rdf:about="" xmlns:${XMP_PREFIX}="${XMP_NS}">
            ${props.map((p) => `<${XMP_PREFIX}:${p}>${xmlEsc(clean(meta.custom[p]))}</${XMP_PREFIX}:${p}>`).join('\n            ')}
        </rdf:Description>`);
  }

  private logoImg?: { width: number; height: number };
  /** The logo is opened once so it is embedded once, however many pages show it. */
  private logoImage(): { width: number; height: number } {
    this.logoImg ??= openImage(this.doc, this.chrome.logo);
    return this.logoImg;
  }

  // ---------- geometry ----------

  get left(): number {
    return MARGIN.left;
  }
  get width(): number {
    return this.doc.page.width - MARGIN.left - MARGIN.right;
  }
  get right(): number {
    return this.doc.page.width - MARGIN.right;
  }
  get bottom(): number {
    return this.doc.page.height - MARGIN.bottom;
  }
  get y(): number {
    return this.doc.y;
  }
  set y(v: number) {
    this.doc.y = v;
  }

  addPage(): void {
    this.doc.addPage();
    this.doc.x = this.left;
    this.doc.y = MARGIN.top;
  }

  /** Starts a new page when less than `h` points are left. */
  ensure(h: number): void {
    if (this.y + h > this.bottom) this.addPage();
  }

  space(h: number): void {
    this.y = Math.min(this.y + h, this.bottom);
  }

  // ---------- primitives ----------

  font(kind: 'sans' | 'bold' | 'mono', size: number): PDFKit.PDFDocument {
    return this.doc.font(kind).fontSize(size);
  }

  color(tone: Tone = 'default'): string {
    switch (tone) {
      case 'muted':
        return COLORS.muted;
      case 'success':
        return COLORS.success;
      case 'danger':
        return COLORS.danger;
      case 'warning':
        return COLORS.warning;
      case 'info':
        return COLORS.info;
      case 'accent':
        return this.accent;
      default:
        return COLORS.text;
    }
  }

  /**
   * Replaces characters the current (embedded) font has no glyph for: a few
   * look-alikes (✔ → ✓), anything else becomes "?" instead of an empty box.
   */
  private glyphSafe(s: string): string {
    const f = (this.doc as unknown as { _font?: { font?: { hasGlyphForCodePoint(cp: number): boolean } } })._font?.font;
    // eslint-disable-next-line no-control-regex -- an ASCII-only check, control characters included
    if (!f || /^[\x00-\x7f]*$/.test(s)) return s;
    let out = '';
    for (const ch of s) {
      const cp = ch.codePointAt(0)!;
      if (cp < 0x80 || cp === 0xad || f.hasGlyphForCodePoint(cp)) out += ch;
      else if (/[\u{fe0f}\u{200d}]/u.test(ch)) continue; // emoji variation selectors / joiners
      else {
        const alt = GLYPH_FALLBACK[ch];
        out += alt && [...alt].every((c) => f.hasGlyphForCodePoint(c.codePointAt(0)!)) ? alt : '?';
      }
    }
    return out;
  }

  /** Draws text at a position (recorded for tests). */
  text(s: string, x: number, y: number, opts: PDFKit.Mixins.TextOptions = {}): void {
    const t = clean(s);
    this.texts.push(t);
    this.doc.text(this.glyphSafe(t), x, y, opts);
  }

  /** Font size at which the longest word of `s` fits into `width` (labels in narrow columns, e.g. German compounds). */
  fitSize(s: string, width: number, kind: 'sans' | 'bold' | 'mono', size: number, min = 5.2): number {
    this.font(kind, size);
    const longest = Math.max(0, ...clean(s).split(/\s+/).map((w) => this.doc.widthOfString(this.glyphSafe(w))));
    return longest > width ? Math.max(min, Math.floor((size * width * 10) / longest) / 10) : size;
  }

  measure(s: string, width: number, kind: 'sans' | 'bold' | 'mono', size: number, lineGap = 1): number {
    this.font(kind, size);
    return this.doc.heightOfString(this.glyphSafe(clean(s)) || ' ', { width, lineGap });
  }

  // ---------- blocks ----------

  /** Branded header of the first page: logo, company, title, classification, tags. */
  cover(o: { title: string; subtitle: string; meta: string[] }): void {
    const top = 34;
    const logoH = 42;
    let logoW: number;
    try {
      const img = this.logoImage();
      logoW = Math.min(150, (img.width / img.height) * logoH);
      this.doc.image(img as never, this.left, top, { fit: [logoW, logoH], valign: 'center' });
    } catch {
      logoW = 0;
    }
    const textX = this.left + (logoW ? logoW + 12 : 0);
    this.font('bold', 12).fillColor(COLORS.text);
    this.text(this.chrome.companyName, textX, top + 6, { width: 260, lineBreak: false, ellipsis: true, height: 16 });
    this.font('sans', 8).fillColor(COLORS.muted);
    this.text(o.meta[0] ?? '', textX, top + 24, { width: 260, lineBreak: false, ellipsis: true, height: 12 });
    // classification + tags (right aligned)
    let ry = top + 4;
    const pill = (label: string, tone: Tone, filled: boolean) => {
      this.font('bold', 7.5);
      const w = this.doc.widthOfString(label.toUpperCase()) + 14;
      const x = this.right - w;
      const c = tone === 'default' ? COLORS.muted : this.color(tone);
      if (filled) this.doc.roundedRect(x, ry, w, 15, 7.5).fill(c);
      else this.doc.roundedRect(x, ry, w, 15, 7.5).lineWidth(0.8).stroke(c);
      this.doc.fillColor(filled ? '#ffffff' : c);
      this.text(label.toUpperCase(), x, ry + 4, { width: w, align: 'center', lineBreak: false });
      ry += 19;
    };
    if (this.chrome.classification) pill(this.chrome.classification, 'default', false);
    for (const t of this.chrome.tags) pill(t.text, t.tone, true);
    for (const line of o.meta.slice(1)) {
      this.font('sans', 7.5).fillColor(COLORS.muted);
      this.text(line, this.right - 220, ry + 1, { width: 220, align: 'right', lineBreak: false });
      ry += 11;
    }
    const lineY = Math.max(top + logoH + 10, ry + 4);
    this.doc.moveTo(this.left, lineY).lineTo(this.right, lineY).lineWidth(2).stroke(this.accent);
    this.y = lineY + 16;
    this.font('bold', 20).fillColor(COLORS.text);
    this.text(o.title, this.left, this.y, { width: this.width });
    this.y += 2;
    this.font('sans', 12).fillColor(COLORS.muted);
    this.text(o.subtitle, this.left, this.y, { width: this.width });
    this.y += 10;
  }

  section(title: string): void {
    this.ensure(70);
    this.y += 10;
    const y = this.y;
    this.doc.rect(this.left, y + 1, 3, 13).fill(this.accent);
    this.font('bold', 12.5).fillColor(COLORS.text);
    this.text(title, this.left + 10, y, { width: this.width - 10 });
    this.y = Math.max(this.y, y + 16) + 6;
    this.doc.fillColor(COLORS.text);
  }

  subheading(title: string, tone: Tone = 'default'): void {
    this.ensure(72); // keep the heading with what follows
    this.y += 4;
    this.font('bold', 10).fillColor(this.color(tone));
    this.text(title, this.left, this.y, { width: this.width });
    this.y += 3;
    this.doc.fillColor(COLORS.text);
  }

  /** Flowing text (continues on the next page when needed). */
  paragraph(s: string, o: { tone?: Tone; size?: number; mono?: boolean; bold?: boolean; indent?: number } = {}): void {
    const t = clean(s);
    if (!t) return;
    const size = o.size ?? 9;
    const indent = o.indent ?? 0;
    this.font(o.mono ? 'mono' : o.bold ? 'bold' : 'sans', size).fillColor(this.color(o.tone));
    this.ensure(Math.min(this.measure(t, this.width - indent, o.mono ? 'mono' : o.bold ? 'bold' : 'sans', size, 1.5), 3 * size));
    this.font(o.mono ? 'mono' : o.bold ? 'bold' : 'sans', size).fillColor(this.color(o.tone));
    this.text(t, this.left + indent, this.y, { width: this.width - indent, lineGap: 1.5 });
    this.y += 4;
    this.doc.fillColor(COLORS.text);
  }

  /** Markdown subset used by report steps: headings, bullet lists, bold/italics/code markers removed. */
  markdown(md: string): void {
    const plain = (s: string) => s.replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1');
    let para: string[] = [];
    const flush = () => {
      if (para.length) this.paragraph(plain(para.join(' ')));
      para = [];
    };
    for (const line of clean(md).split('\n')) {
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      const li = /^\s*[-*]\s+(.*)$/.exec(line);
      if (h) {
        flush();
        this.paragraph(plain(h[2]!), { bold: true, size: 9.5 });
      } else if (li) {
        flush();
        this.paragraph('•  ' + plain(li[1]!), { indent: 8 });
      } else if (!line.trim()) flush();
      else para.push(line.trim());
    }
    flush();
  }

  banner(title: string, body: string, tone: 'warning' | 'danger' | 'info' | 'success'): void {
    const pad = 9;
    const w = this.width - 2 * pad - 4;
    const h = this.measure(title, w, 'bold', 10) + (body ? this.measure(body, w, 'sans', 8.5, 1.5) + 3 : 0) + 2 * pad;
    this.ensure(h + 6);
    const y = this.y;
    const c = BANNER[tone];
    this.doc.rect(this.left, y, this.width, h).fill(c.bg);
    this.doc.rect(this.left, y, 4, h).fill(c.bar);
    this.font('bold', 10).fillColor(tone === 'warning' ? COLORS.warning : tone === 'danger' ? COLORS.danger : tone === 'success' ? COLORS.success : COLORS.info);
    this.text(title, this.left + 4 + pad, y + pad, { width: w });
    if (body) {
      this.font('sans', 8.5).fillColor(COLORS.text);
      this.text(body, this.left + 4 + pad, this.y + 3, { width: w, lineGap: 1.5 });
    }
    this.y = y + h + 8;
    this.doc.fillColor(COLORS.text);
  }

  /** Key/value grid on a tinted background. Items with span 2 use the full width. */
  keyValues(items: { label: string; value: string; mono?: boolean; span?: 1 | 2; tone?: Tone }[]): void {
    const pad = 10;
    const gap = 16;
    const colW = (this.width - 2 * pad - gap) / 2;
    const rows: (typeof items)[] = [];
    for (let i = 0; i < items.length; ) {
      const a = items[i]!;
      if (a.span === 2 || !items[i + 1] || items[i + 1]!.span === 2) {
        rows.push([a]);
        i++;
      } else {
        rows.push([a, items[i + 1]!]);
        i += 2;
      }
    }
    const cellH = (it: (typeof items)[number], w: number) => this.measure(it.label, w, 'sans', 7) + 1 + this.measure(it.value || '–', w, it.mono ? 'mono' : 'sans', it.mono ? 7.5 : 9);
    const widthsOf = (row: typeof items) => (row.length === 1 ? [this.width - 2 * pad] : [colW, colW]);
    const heights = rows.map((row) => Math.max(...row.map((it, j) => cellH(it, widthsOf(row)[j]!))) + 7);
    const total = heights.reduce((a, b) => a + b, 0) + 2 * pad;
    if (total < (this.bottom - MARGIN.top) / 2) this.ensure(total); // small boxes are kept on one page
    rows.forEach((row, ri) => {
      const widths = widthsOf(row);
      const h = heights[ri]!;
      const top = ri === 0 ? pad - 2 : 0;
      const bottom = ri === rows.length - 1 ? pad - 4 : 0;
      this.ensure(h + top + bottom);
      const y0 = this.y;
      this.doc.rect(this.left, y0, this.width, h + top + bottom).fill(this.accentTint);
      row.forEach((it, j) => {
        const x = this.left + pad + (j === 1 ? colW + gap : 0);
        this.font('sans', 7).fillColor(COLORS.muted);
        this.text(it.label.toUpperCase(), x, y0 + top, { width: widths[j]!, characterSpacing: 0.3 });
        this.font(it.mono ? 'mono' : 'sans', it.mono ? 7.5 : 9).fillColor(this.color(it.tone));
        this.text(it.value || '–', x, this.y + 1, { width: widths[j]!, lineGap: 1 });
      });
      this.y = y0 + h + top + bottom;
    });
    this.y += 8;
    this.doc.fillColor(COLORS.text);
  }

  /** A row of figures ("results at a glance"). */
  stats(tiles: { label: string; value: string; tone?: Tone }[]): void {
    if (!tiles.length) return;
    const gap = 6;
    const perRow = tiles.length <= 7 ? tiles.length : Math.ceil(tiles.length / Math.ceil(tiles.length / 7));
    const w = (this.width - gap * (perRow - 1)) / perRow;
    for (let i = 0; i < tiles.length; i += perRow) {
      const chunk = tiles.slice(i, i + perRow);
      const labelSize = Math.min(...chunk.map((t) => this.fitSize(t.label, w - 12, 'sans', 7)));
      const labelSizes = chunk.map(() => labelSize); // one size per row looks calmer
      const labelH = Math.max(...chunk.map((t, j) => this.measure(t.label, w - 12, 'sans', labelSizes[j]!)));
      const h = 26 + labelH + 6;
      this.ensure(h + 6);
      const y = this.y;
      chunk.forEach((t, j) => {
        const x = this.left + j * (w + gap);
        this.doc.roundedRect(x, y, w, h, 3).lineWidth(0.7).stroke(COLORS.border);
        this.font('bold', 15).fillColor(this.color(t.tone));
        this.text(t.value, x + 6, y + 6, { width: w - 12, lineBreak: false });
        this.font('sans', labelSizes[j]!).fillColor(COLORS.muted);
        this.text(t.label, x + 6, y + 26, { width: w - 12 });
      });
      this.y = y + h + 8;
    }
    this.doc.fillColor(COLORS.text);
  }

  /** Table with wrapping cells; long tables continue on the next page with the header repeated. */
  table(columns: Column[], rows: CellInput[][], o: { size?: number; empty?: string; zebra?: boolean } = {}): void {
    const size = o.size ?? 7.8;
    const padX = 4;
    const padY = 3.5;
    const total = columns.reduce((s, c) => s + c.width, 0);
    const widths = columns.map((c) => (c.width / total) * this.width);
    const xs = widths.map((_, i) => this.left + widths.slice(0, i).reduce((s, w) => s + w, 0));
    const headSizes = columns.map((c, i) => this.fitSize(c.header, widths[i]! - 2 * padX, 'bold', size - 0.5));
    const headH = Math.max(...columns.map((c, i) => this.measure(c.header, widths[i]! - 2 * padX, 'bold', headSizes[i]!))) + 2 * padY;

    const drawHeader = () => {
      const y = this.y;
      this.doc.rect(this.left, y, this.width, headH).fill(COLORS.headBg);
      columns.forEach((c, i) => {
        this.font('bold', headSizes[i]!).fillColor(COLORS.muted);
        this.text(c.header, xs[i]! + padX, y + padY, { width: widths[i]! - 2 * padX, align: c.align ?? 'left' });
      });
      this.doc.moveTo(this.left, y + headH).lineTo(this.right, y + headH).lineWidth(0.8).stroke(COLORS.border);
      this.y = y + headH;
    };

    const norm = (c: CellInput, col: Column): Cell => {
      const cell: Cell = c && typeof c === 'object' ? c : { text: c === null || c === undefined ? '' : String(c) };
      let text = clean(cell.text);
      if (text.length > MAX_CELL_CHARS) text = text.slice(0, MAX_CELL_CHARS) + ' …';
      return { ...cell, text, mono: cell.mono ?? col.mono };
    };

    this.ensure(headH + 18);
    drawHeader();
    if (!rows.length) {
      this.font('sans', size).fillColor(COLORS.muted);
      this.text(o.empty ?? '–', this.left + padX, this.y + padY, { width: this.width - 2 * padX });
      this.y += 2;
      this.doc.moveTo(this.left, this.y).lineTo(this.right, this.y).lineWidth(0.5).stroke(COLORS.rowLine);
      this.y += 8;
      this.doc.fillColor(COLORS.text);
      return;
    }
    const maxRowH = this.bottom - MARGIN.top - headH - 4;
    rows.forEach((raw, ri) => {
      const cells = columns.map((col, i) => norm(raw[i], col));
      const kinds = cells.map((c) => (c.mono ? 'mono' : c.bold ? 'bold' : 'sans') as 'mono' | 'bold' | 'sans');
      const sizes = cells.map((c) => (c.mono ? size - 0.6 : size));
      const indents = cells.map((c) => Math.min(c.indent ?? 0, 6) * 8);
      let h = Math.max(...cells.map((c, i) => this.measure(c.text || ' ', widths[i]! - 2 * padX - indents[i]!, kinds[i]!, sizes[i]!))) + 2 * padY;
      h = Math.min(h, maxRowH);
      if (this.y + h > this.bottom) {
        this.addPage();
        drawHeader();
      }
      const y = this.y;
      if (o.zebra !== false && ri % 2 === 1) this.doc.rect(this.left, y, this.width, h).fill(COLORS.zebra);
      cells.forEach((c, i) => {
        this.font(kinds[i]!, sizes[i]!).fillColor(this.color(c.tone));
        this.text(c.text, xs[i]! + padX + indents[i]!, y + padY, {
          width: widths[i]! - 2 * padX - indents[i]!,
          height: h - 2 * padY + 1,
          ellipsis: true,
          align: columns[i]!.align ?? 'left',
          lineGap: 1,
        });
      });
      this.doc.moveTo(this.left, y + h).lineTo(this.right, y + h).lineWidth(0.5).stroke(COLORS.rowLine);
      this.y = y + h;
    });
    this.y += 8;
    this.doc.fillColor(COLORS.text);
  }

  /** Image thumbnails in a grid (two per row) with captions. */
  images(items: { data: Buffer; caption: string }[]): void {
    const gap = 14;
    const w = (this.width - gap) / 2;
    const imgH = 150;
    for (let i = 0; i < items.length; i += 2) {
      const pair = items.slice(i, i + 2);
      const capH = Math.max(...pair.map((p) => this.measure(p.caption, w, 'sans', 7)));
      this.ensure(imgH + capH + 14);
      const y = this.y;
      pair.forEach((p, j) => {
        const x = this.left + j * (w + gap);
        this.doc.rect(x, y, w, imgH).lineWidth(0.6).stroke(COLORS.border);
        try {
          this.doc.image(p.data, x + 3, y + 3, { fit: [w - 6, imgH - 6], align: 'center', valign: 'center' });
        } catch {
          this.font('sans', 8).fillColor(COLORS.muted);
          this.text('(image could not be embedded)', x + 6, y + imgH / 2 - 4, { width: w - 12, align: 'center' });
        }
        this.font('sans', 7).fillColor(COLORS.muted);
        this.text(p.caption, x, y + imgH + 4, { width: w });
      });
      this.y = y + imgH + capH + 14;
    }
    this.doc.fillColor(COLORS.text);
  }

  /**
   * Sign-off blocks (one per role): name, role, date and signature lines plus an
   * empty digital signature field (AcroForm /Sig widget) that can be signed later
   * in a PDF reader. PDF/A-2b allows unsigned signature fields as long as the
   * widget has an appearance stream and is printable.
   */
  signatureBlocks(blocks: { title: string; name?: string; role?: string; date?: string; fieldName: string; fieldHint: string }[], labels: { name: string; role: string; date: string; signature: string; digital: string }): void {
    const gap = 12;
    const n = blocks.length;
    const w = (this.width - gap * (n - 1)) / n;
    const h = 196;
    this.ensure(h + 8);
    const y = this.y;
    blocks.forEach((b, i) => {
      const x = this.left + i * (w + gap);
      this.doc.roundedRect(x, y, w, h, 3).lineWidth(0.8).stroke(COLORS.border);
      this.doc.rect(x, y, w, 20).fill(this.accentTint);
      this.font('bold', 9).fillColor(COLORS.text);
      this.text(b.title, x + 8, y + 6, { width: w - 16, lineBreak: false, ellipsis: true, height: 12 });
      let ly = y + 30;
      const line = (label: string, value?: string) => {
        this.font('sans', 6.8).fillColor(COLORS.muted);
        this.text(label.toUpperCase(), x + 8, ly, { width: w - 16, lineBreak: false, characterSpacing: 0.3 });
        if (value) {
          this.font('sans', 8.5).fillColor(COLORS.text);
          this.text(value, x + 8, ly + 9, { width: w - 16, lineBreak: false, ellipsis: true, height: 11 });
        }
        this.doc.moveTo(x + 8, ly + 21).lineTo(x + w - 8, ly + 21).lineWidth(0.5).stroke(COLORS.light);
        ly += 29;
      };
      line(labels.name, b.name);
      line(labels.role, b.role);
      line(labels.date, b.date);
      // handwritten signature line
      this.font('sans', 6.8).fillColor(COLORS.muted);
      this.text(labels.signature.toUpperCase(), x + 8, ly, { width: w - 16, lineBreak: false, characterSpacing: 0.3 });
      const fy = ly + 10;
      const fh = h - (fy - y) - 22;
      this.doc.rect(x + 8, fy, w - 16, fh).lineWidth(0.6).dash(2, { space: 2 }).stroke(COLORS.light).undash();
      this.signatureField(b.fieldName, b.fieldHint, x + 8, fy, w - 16, fh);
      this.font('sans', 6.3).fillColor(COLORS.light);
      this.text(labels.digital, x + 8, fy + fh + 3, { width: w - 16, height: 16, ellipsis: true });
    });
    this.y = y + h + 8;
    this.doc.fillColor(COLORS.text);
  }

  private signatureField(name: string, tooltip: string, x: number, y: number, w: number, h: number): void {
    const d = internals(this.doc);
    // PDF/A: every widget needs a real appearance stream (an empty one is not a stream); "q Q" draws nothing.
    const ap = d.ref({ Type: 'XObject', Subtype: 'Form', BBox: [0, 0, w, h], Resources: {} });
    ap.end('q Q');
    const H = this.doc.page.height;
    const widget = d.ref({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Sig',
      T: new String(name),
      TU: new String(clean(tooltip)),
      F: 4, // Print
      Rect: [x, H - y - h, x + w, H - y],
      P: d.page.dictionary,
      AP: { N: ap },
    });
    widget.end();
    d.page.annotations.push(widget);
    this.sigFields.push(widget);
  }

  // ---------- finishing ----------

  private drawChrome(): void {
    const range = this.doc.bufferedPageRange();
    const total = range.count;
    for (let i = range.start; i < range.start + total; i++) {
      this.doc.switchToPage(i);
      const page = this.doc.page;
      const savedBottom = page.margins.bottom;
      const savedTop = page.margins.top;
      page.margins.bottom = 0;
      page.margins.top = 0;
      const pageNo = i - range.start + 1;
      if (pageNo > 1) {
        const y = 26;
        let x = this.left;
        try {
          const img = this.logoImage();
          this.doc.image(img as never, x, y - 2, { fit: [40, 16], valign: 'center' });
          x += Math.min(40, (img.width / img.height) * 16) + 6;
        } catch {
          /* no logo */
        }
        this.font('bold', 8).fillColor(COLORS.text);
        this.text(this.chrome.companyName, x, y + 2, { width: 180, lineBreak: false, ellipsis: true, height: 10 });
        const tags = [this.chrome.classification, ...this.chrome.tags.map((t) => t.text)].filter(Boolean).map((t) => t.toUpperCase()).join('  ·  ');
        this.font('sans', 7.5).fillColor(COLORS.muted);
        this.text(`${tags ? tags + '   ·   ' : ''}${this.chrome.shortTitle}`, this.right - 320, y + 2.5, { width: 320, align: 'right', lineBreak: false, ellipsis: true, height: 10 });
        this.doc.moveTo(this.left, y + 18).lineTo(this.right, y + 18).lineWidth(0.8).stroke(this.accent);
      }
      const f = this.chrome.footer(pageNo, total);
      const fy = page.height - 62;
      this.doc.moveTo(this.left, fy).lineTo(this.right, fy).lineWidth(0.6).stroke(COLORS.border);
      this.font('bold', 7).fillColor(COLORS.text);
      this.text(f.left, this.left, fy + 6, { width: this.width - 90, lineBreak: false, ellipsis: true, height: 9 });
      this.font('bold', 7).fillColor(COLORS.text);
      this.text(f.right, this.right - 90, fy + 6, { width: 90, align: 'right', lineBreak: false });
      let ly = fy + 17;
      for (const l of f.lines) {
        this.font('sans', 6.3).fillColor(COLORS.muted);
        this.text(l, this.left, ly, { width: this.width, lineBreak: false, ellipsis: true, height: 8 });
        ly += 9;
      }
      page.margins.bottom = savedBottom;
      page.margins.top = savedTop;
    }
  }

  /** Draws headers/footers, adds the signature form and returns the PDF bytes. */
  async finish(): Promise<Buffer> {
    this.drawChrome();
    if (this.sigFields.length) {
      const d = internals(this.doc);
      // SigFlags 1 = SignaturesExist. No NeedAppearances (forbidden in PDF/A); PDFKit's own form code is bypassed.
      const form = d.ref({ Fields: this.sigFields, SigFlags: 1 });
      form.end();
      d._root.data.AcroForm = form;
      d.endAcroForm = () => this.doc;
    }
    return new Promise<Buffer>((resolve, reject) => {
      this.doc.on('end', () => resolve(Buffer.concat(this.chunks)));
      this.doc.on('error', reject);
      this.doc.end();
    });
  }
}
