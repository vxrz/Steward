/**
 * A small CommonMark-like Markdown parser that produces a syntax tree instead
 * of HTML. The web UI renders the tree as React elements and the PDF engine
 * draws it, so raw HTML in Markdown is never interpreted anywhere: `<script>`
 * stays the literal text "<script>". Links are kept only for http(s) and
 * mailto targets.
 *
 * Supported: ATX and setext headings, paragraphs, bullet/numbered/task lists
 * (nested by indentation), fenced and indented code, block quotes, tables
 * (GFM pipes), horizontal rules; inline code, strong, emphasis, strikethrough,
 * links, autolinks and hard line breaks.
 */

export type MdInline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; c: MdInline[] }
  | { t: 'em'; c: MdInline[] }
  | { t: 'del'; c: MdInline[] }
  | { t: 'link'; href: string; c: MdInline[] }
  | { t: 'br' };

export interface MdListItem {
  /** Task list item: true = [x], false = [ ], undefined = no checkbox */
  checked?: boolean;
  blocks: MdBlock[];
}

export type MdAlign = 'left' | 'center' | 'right' | null;

export type MdBlock =
  | { t: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; c: MdInline[] }
  | { t: 'paragraph'; c: MdInline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'quote'; blocks: MdBlock[] }
  | { t: 'list'; ordered: boolean; start: number; items: MdListItem[] }
  | { t: 'table'; align: MdAlign[]; head: MdInline[][]; rows: MdInline[][][] }
  | { t: 'hr' };

/** Inputs above this size are cut (callers validate sizes before; this keeps parsing bounded). */
export const MD_MAX_CHARS = 512 * 1024;
const MAX_DEPTH = 12;

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const BULLET = /^( {0,3})([-*+])([ \t]+|$)(.*)$/;
const ORDERED = /^( {0,3})(\d{1,9})([.)])([ \t]+|$)(.*)$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const TABLE_SEP = /^ *\|? *:?-+:? *(\| *:?-+:? *)*\|? *$/;

const isBlank = (l: string) => /^\s*$/.test(l);
const expandTabs = (l: string) => l.replace(/\t/g, '    ');

/** Safe link target, or null (javascript:, data:, relative paths … are dropped). */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (/^https?:\/\/[^\s]+$/i.test(href)) return href;
  if (/^mailto:[^\s]+@[^\s]+$/i.test(href)) return href;
  return null;
}

// ---------- inline ----------

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|~<>]/;

export function parseInline(src: string, depth = 0): MdInline[] {
  const out: MdInline[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ t: 'text', v: text });
    text = '';
  };
  const push = (n: MdInline) => {
    flush();
    out.push(n);
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '\\' && i + 1 < src.length) {
      const next = src[i + 1]!;
      if (next === '\n') {
        push({ t: 'br' });
        i += 2;
        continue;
      }
      if (ESCAPABLE.test(next)) {
        text += next;
        i += 2;
        continue;
      }
    }
    if (ch === '\n') {
      // two trailing spaces = hard break; otherwise a soft break (a space)
      if (/ {2,}$/.test(text)) {
        text = text.replace(/ +$/, '');
        push({ t: 'br' });
      } else text = text.replace(/ +$/, '') + ' ';
      i++;
      continue;
    }
    if (ch === '`') {
      const run = /^`+/.exec(src.slice(i))![0];
      const end = src.indexOf(run, i + run.length);
      if (end > 0) {
        let code = src.slice(i + run.length, end).replace(/\n/g, ' ');
        if (/^ .* $/.test(code)) code = code.slice(1, -1);
        push({ t: 'code', v: code });
        i = end + run.length;
        continue;
      }
      text += run;
      i += run.length;
      continue;
    }
    if (depth < MAX_DEPTH && (ch === '*' || ch === '_' || ch === '~')) {
      const double = src[i + 1] === ch;
      const marker = double ? ch + ch : ch;
      if (ch === '~' && !double) {
        text += ch;
        i++;
        continue;
      }
      // intraword underscores (snake_case) are not emphasis
      const prev = i > 0 ? src[i - 1]! : ' ';
      const after = src[i + marker.length] ?? ' ';
      if (!(ch === '_' && /\w/.test(prev)) && !/\s/.test(after)) {
        const close = findClose(src, i + marker.length, marker);
        if (close > 0) {
          const inner = parseInline(src.slice(i + marker.length, close), depth + 1);
          push(ch === '~' ? { t: 'del', c: inner } : double ? { t: 'strong', c: inner } : { t: 'em', c: inner });
          i = close + marker.length;
          continue;
        }
      }
      text += marker;
      i += marker.length;
      continue;
    }
    if (ch === '[' && depth < MAX_DEPTH) {
      const link = parseLink(src, i);
      if (link) {
        const href = safeHref(link.href);
        const label = parseInline(link.label, depth + 1);
        if (href) push({ t: 'link', href, c: label.length ? label : [{ t: 'text', v: href }] });
        else {
          flush();
          out.push(...label);
        }
        i = link.end;
        continue;
      }
    }
    if (ch === '<') {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(src.slice(i));
      const href = m ? safeHref(m[1]!) : null;
      if (m && href) {
        push({ t: 'link', href, c: [{ t: 'text', v: m[1]!.replace(/^mailto:/i, '') }] });
        i += m[0].length;
        continue;
      }
    }
    if ((ch === 'h' || ch === 'H') && /\W|^$/.test(i > 0 ? src[i - 1]! : '')) {
      const m = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"*_~]/i.exec(src.slice(i));
      if (m) {
        push({ t: 'link', href: m[0], c: [{ t: 'text', v: m[0] }] });
        i += m[0].length;
        continue;
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

function findClose(src: string, from: number, marker: string): number {
  let i = from;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') {
      const run = /^`+/.exec(src.slice(i))![0];
      const end = src.indexOf(run, i + run.length);
      i = end > 0 ? end + run.length : i + run.length;
      continue;
    }
    if (src.startsWith(marker, i) && !/\s/.test(src[i - 1] ?? ' ')) {
      // "**" must not be read as the closing "*" of an emphasis (and vice versa)
      const longer = src[i + marker.length] === marker[0] && marker.length === 1;
      if (!longer && !(marker[0] === '_' && /\w/.test(src[i + marker.length] ?? ''))) return i;
      if (longer) {
        i += 2;
        continue;
      }
    }
    i++;
  }
  return -1;
}

function parseLink(src: string, start: number): { label: string; href: string; end: number } | null {
  let depth = 0;
  let i = start;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0 || src[i + 1] !== '(') return null;
  const label = src.slice(start + 1, i);
  const rest = src.slice(i + 2);
  // the target may contain balanced parentheses (Wikipedia URLs)
  const m = /^\s*<?((?:[^\s()<>]|\([^\s()<>]*\))*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/.exec(rest);
  if (!m) return null;
  return { label, href: m[1]!, end: i + 2 + m[0].length };
}

// ---------- blocks ----------

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (s[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

/** Whether a line starts a block other than a paragraph (ends a paragraph). */
function interrupts(line: string): boolean {
  return FENCE.test(line) || ATX.test(line) || HR.test(line) || QUOTE.test(line) || BULLET.test(line) || /^ {0,3}1[.)]([ \t]|$)/.test(line);
}

export function parseMarkdown(input: string): MdBlock[] {
  const text = String(input ?? '').slice(0, MD_MAX_CHARS).replace(/\r\n?/g, '\n');
  return parseBlocks(text.split('\n').map(expandTabs), 0);
}

function parseBlocks(lines: string[], depth: number): MdBlock[] {
  const out: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }
    // fenced code
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const indent = /^ */.exec(line)![0].length;
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(lines[i]!)) {
        body.push(lines[i]!.replace(new RegExp(`^ {0,${indent}}`), ''));
        i++;
      }
      i++; // closing fence (or end of input)
      out.push({ t: 'code', lang: fence[2] ?? '', v: body.join('\n') });
      continue;
    }
    // indented code
    if (/^ {4}/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && (/^ {4}/.test(lines[i]!) || isBlank(lines[i]!))) body.push(lines[i++]!.slice(4));
      while (body.length && isBlank(body[body.length - 1]!)) body.pop();
      out.push({ t: 'code', lang: '', v: body.join('\n') });
      continue;
    }
    const atx = ATX.exec(line);
    if (atx) {
      out.push({ t: 'heading', level: atx[1]!.length as 1, c: parseInline(atx[2] ?? '', 0) });
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push({ t: 'hr' });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && !isBlank(lines[i]!)) {
        const q = QUOTE.exec(lines[i]!);
        if (q) inner.push(q[1]!);
        else if (interrupts(lines[i]!)) break;
        else inner.push(lines[i]!); // lazy continuation
        i++;
      }
      out.push({ t: 'quote', blocks: depth < MAX_DEPTH ? parseBlocks(inner, depth + 1) : [{ t: 'paragraph', c: [{ t: 'text', v: inner.join(' ') }] }] });
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      const res = parseList(lines, i, depth);
      out.push(res.block);
      i = res.next;
      continue;
    }
    // table: header row, separator row
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!) && lines[i + 1]!.includes('-')) {
      const head = splitRow(line);
      const align: MdAlign[] = splitRow(lines[i + 1]!).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
      if (align.length === head.length) {
        i += 2;
        const rows: MdInline[][][] = [];
        while (i < lines.length && !isBlank(lines[i]!) && lines[i]!.includes('|')) {
          const cells = splitRow(lines[i]!);
          rows.push(head.map((_, j) => parseInline(cells[j] ?? '', 0)));
          i++;
        }
        out.push({ t: 'table', align, head: head.map((h) => parseInline(h, 0)), rows });
        continue;
      }
    }
    // paragraph (or setext heading)
    const para: string[] = [line.trim()];
    i++;
    let setext: 1 | 2 | 0 = 0;
    while (i < lines.length && !isBlank(lines[i]!)) {
      const l = lines[i]!;
      const s = SETEXT.exec(l);
      if (s) {
        setext = s[1]![0] === '=' ? 1 : 2;
        i++;
        break;
      }
      if (interrupts(l)) break;
      para.push(l.replace(/^ +/, ''));
      i++;
    }
    const content = para.join('\n');
    out.push(setext ? { t: 'heading', level: setext, c: parseInline(content, 0) } : { t: 'paragraph', c: parseInline(content, 0) });
  }
  return out;
}

function parseList(lines: string[], start: number, depth: number): { block: MdBlock; next: number } {
  const first = BULLET.exec(lines[start]!) ?? ORDERED.exec(lines[start]!)!;
  const isOrdered = !BULLET.test(lines[start]!);
  const marker = isOrdered ? first[3]! : first[2]!;
  const items: MdListItem[] = [];
  let i = start;
  let startNo = isOrdered ? Number(first[2]) : 1;
  if (!Number.isFinite(startNo)) startNo = 1;
  while (i < lines.length) {
    const line = lines[i]!;
    const m = isOrdered ? ORDERED.exec(line) : BULLET.exec(line);
    if (!m || (isOrdered ? m[3] : m[2]) !== marker) break;
    const lead = m[1]!.length;
    const markerText = isOrdered ? m[2]! + m[3]! : m[2]!;
    const gap = (isOrdered ? m[4]! : m[3]!).length;
    const content = isOrdered ? m[5]! : m[4]!;
    const indent = lead + markerText.length + Math.min(Math.max(gap, 1), 4);
    const body: string[] = [content];
    i++;
    let sawBlank = false;
    while (i < lines.length) {
      const l = lines[i]!;
      if (isBlank(l)) {
        sawBlank = true;
        body.push('');
        i++;
        continue;
      }
      const ind = /^ */.exec(l)![0].length;
      if (ind >= indent) {
        body.push(l.slice(indent));
        sawBlank = false;
        i++;
        continue;
      }
      // a new item of this list, or the end of the list
      if (sawBlank || BULLET.test(l) || ORDERED.test(l) || interrupts(l)) break;
      body.push(l.trim()); // lazy continuation of the paragraph
      i++;
    }
    while (body.length && isBlank(body[body.length - 1]!)) body.pop();
    let checked: boolean | undefined;
    const task = /^\[([ xX])\][ \t]+/.exec(body[0] ?? '');
    if (task) {
      checked = task[1] !== ' ';
      body[0] = body[0]!.slice(task[0].length);
    }
    items.push({ checked, blocks: depth < MAX_DEPTH ? parseBlocks(body, depth + 1) : [{ t: 'paragraph', c: [{ t: 'text', v: body.join(' ') }] }] });
    // a blank line followed by something that is not an item ends the list
    if (i < lines.length && isBlank(lines[i - 1] ?? '') && !(isOrdered ? ORDERED : BULLET).test(lines[i]!)) break;
  }
  return { block: { t: 'list', ordered: isOrdered, start: startNo, items }, next: i };
}

// ---------- helpers ----------

/** Plain text of inline nodes (links as "text (url)" when they differ). */
export function inlineText(nodes: MdInline[], o: { linkUrls?: boolean } = {}): string {
  let s = '';
  for (const n of nodes) {
    if (n.t === 'text' || n.t === 'code') s += n.v;
    else if (n.t === 'br') s += '\n';
    else if (n.t === 'link') {
      const label = inlineText(n.c, o);
      s += o.linkUrls && label !== n.href && label !== n.href.replace(/^mailto:/i, '') ? `${label} (${n.href})` : label;
    } else s += inlineText(n.c, o);
  }
  return s;
}

/** Headings of a document (level and plain text), e.g. to find the sections of a template. */
export function markdownHeadings(md: string): { level: number; text: string }[] {
  return parseMarkdown(md)
    .filter((b): b is Extract<MdBlock, { t: 'heading' }> => b.t === 'heading')
    .map((b) => ({ level: b.level, text: inlineText(b.c) }));
}
