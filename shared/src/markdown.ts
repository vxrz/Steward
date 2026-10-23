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
/** Wider tables are not tables (they would not be readable anyway). */
export const MD_MAX_TABLE_COLUMNS = 50;
/** Table cells per document (short rows are padded to the header width): later rows stay text. */
export const MD_MAX_TABLE_CELLS = 20000;

/*
 * Parsing time must stay linear in the input: the parser runs on the server
 * (PDF) and in the browser on text anyone with edit rights wrote. Patterns
 * that backtrack (lazy groups next to optional whitespace, unclosed
 * delimiters scanned again from every position) are written as plain loops
 * or remember what they already scanned.
 */
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const BULLET = /^( {0,3})([-*+])([ \t]+|$)(.*)$/;
const ORDERED = /^( {0,3})(\d{1,9})([.)])([ \t]+|$)(.*)$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
// no two adjacent ` *` (would backtrack quadratically on long runs of spaces)
const TABLE_SEP = /^ *(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/;

const isBlank = (l: string) => /^\s*$/.test(l);
/** `line` without up to `n` leading spaces. */
function stripSpaces(line: string, n: number): string {
  let k = 0;
  while (k < n && line[k] === ' ') k++;
  return line.slice(k);
}
const expandTabs = (l: string) => l.replace(/\t/g, '    ');
const isSpaceOrTab = (c: string | undefined) => c === ' ' || c === '\t';

/** Opening code fence: `^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$` as a loop. */
function fenceOpen(line: string): { marker: string; lang: string } | null {
  let i = 0;
  while (i < 3 && line[i] === ' ') i++;
  const ch = line[i];
  if (ch !== '`' && ch !== '~') return null;
  let j = i;
  while (line[j] === ch) j++;
  if (j - i < 3) return null;
  const rest = line.slice(j);
  if (rest.includes('`')) return null;
  return { marker: line.slice(i, j), lang: /^\s*([^`\s]*)/.exec(rest)![1]! };
}

/** Closing code fence: `^ {0,3}`{n,}\s*$` (or ~) as a loop. */
function fenceClose(line: string, ch: string, n: number): boolean {
  let i = 0;
  while (i < 3 && line[i] === ' ') i++;
  let j = i;
  while (line[j] === ch) j++;
  return j - i >= n && isBlank(line.slice(j));
}

/** ATX heading: `^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$` as a loop (level and text). */
function atxHeading(line: string): { level: number; text: string } | null {
  let i = 0;
  while (i < 3 && line[i] === ' ') i++;
  let j = i;
  while (line[j] === '#') j++;
  const level = j - i;
  if (level < 1 || level > 6) return null;
  const rest = line.slice(j);
  if (rest && !isSpaceOrTab(rest[0])) return null;
  if (/[\u2028\u2029]/.test(rest)) return null; // `.` does not match them
  let k = 0;
  while (isSpaceOrTab(rest[k])) k++;
  let end = rest.length;
  while (end > k && isSpaceOrTab(rest[end - 1])) end--;
  if (end <= k) return { level, text: '' };
  // an optional closing sequence: spaces, #s (then the trailing spaces already cut)
  let h = end;
  while (h > k && rest[h - 1] === '#') h--;
  if (h < end && h > k && isSpaceOrTab(rest[h - 1])) {
    end = h;
    while (end > k && isSpaceOrTab(rest[end - 1])) end--;
  }
  return { level, text: rest.slice(k, end) };
}

/** Safe link target, or null (javascript:, data:, relative paths … are dropped). */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (/^https?:\/\/[^\s]+$/i.test(href)) return href;
  if (/^mailto:[^\s]+@[^\s]+$/i.test(href)) return href;
  return null;
}

// ---------- inline ----------

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|~<>]/;

/**
 * What one parseInline call learned about its text, so that no position is
 * scanned again and again (unclosed `[`, `*` or backticks would otherwise
 * make parsing quadratic): the backtick runs, the positions from which a
 * closing delimiter is known not to exist, and the matching `]` of each `[`.
 */
interface Scan {
  src: string;
  tickStarts?: number[];
  /** Longest backtick run from run k on */
  tickMax?: number[];
  noClose?: Map<string, Uint8Array>;
  bracketFrom?: number;
  bracketVisited?: Uint8Array;
  bracketMatch?: Int32Array;
}

/** Length of the run of `ch` at position i. */
function runAt(src: string, i: number, ch: string): number {
  let j = i;
  while (src[j] === ch) j++;
  return j - i;
}

/** src.indexOf(run, from) for a run of n backticks, answering "none" without scanning when no later run is long enough. */
function findTicks(scan: Scan, n: number, from: number): number {
  const { src } = scan;
  if (!scan.tickStarts) {
    const starts: number[] = [];
    const lens: number[] = [];
    for (let i = src.indexOf('`'); i >= 0;) {
      const len = runAt(src, i, '`');
      starts.push(i);
      lens.push(len);
      i = src.indexOf('`', i + len);
    }
    const max = new Array<number>(lens.length);
    for (let k = lens.length - 1, m = 0; k >= 0; k--) max[k] = m = Math.max(m, lens[k]!);
    scan.tickStarts = starts;
    scan.tickMax = max;
  }
  const starts = scan.tickStarts;
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid]! < from) lo = mid + 1;
    else hi = mid;
  }
  // `from` is never inside a run (it follows a whole run), so every match starts in a run at or after it
  if (src[from] !== '`' && (lo >= starts.length || scan.tickMax![lo]! < n)) return -1;
  return src.indexOf('`'.repeat(n), from);
}

export function parseInline(src: string, depth = 0): MdInline[] {
  const scan: Scan = { src };
  const out: MdInline[] = [];
  // text so far as pieces (spaces are always pieces of their own): reading the end of a
  // long concatenated string would copy it on every line break
  let text: string[] = [];
  const flush = () => {
    if (text.length) out.push({ t: 'text', v: text.join('') });
    text = [];
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
        text.push(next);
        i += 2;
        continue;
      }
    }
    if (ch === '\n') {
      // two trailing spaces = hard break; otherwise a soft break (a space)
      let spaces = 0;
      while (text[text.length - 1] === ' ') (text.pop(), spaces++);
      if (spaces >= 2) push({ t: 'br' });
      else text.push(' ');
      i++;
      continue;
    }
    if (ch === '`') {
      const n = runAt(src, i, '`');
      const end = findTicks(scan, n, i + n);
      if (end > 0) {
        let code = src.slice(i + n, end).replace(/\n/g, ' ');
        if (/^ .* $/.test(code)) code = code.slice(1, -1);
        push({ t: 'code', v: code });
        i = end + n;
        continue;
      }
      text.push(src.slice(i, i + n));
      i += n;
      continue;
    }
    if (depth < MAX_DEPTH && (ch === '*' || ch === '_' || ch === '~')) {
      const double = src[i + 1] === ch;
      const marker = double ? ch + ch : ch;
      if (ch === '~' && !double) {
        text.push(ch);
        i++;
        continue;
      }
      // intraword underscores (snake_case) are not emphasis
      const prev = i > 0 ? src[i - 1]! : ' ';
      const after = src[i + marker.length] ?? ' ';
      if (!(ch === '_' && /\w/.test(prev)) && !/\s/.test(after)) {
        const close = findClose(scan, i + marker.length, marker);
        if (close > 0) {
          const inner = parseInline(src.slice(i + marker.length, close), depth + 1);
          push(ch === '~' ? { t: 'del', c: inner } : double ? { t: 'strong', c: inner } : { t: 'em', c: inner });
          i = close + marker.length;
          continue;
        }
      }
      text.push(marker);
      i += marker.length;
      continue;
    }
    if (ch === '[' && depth < MAX_DEPTH) {
      const link = parseLink(scan, i);
      if (link) {
        const href = safeHref(link.href);
        const label = parseInline(link.label, depth + 1);
        if (href) push({ t: 'link', href, c: label.length ? label : [{ t: 'text', v: href }] });
        else {
          flush();
          for (const n of label) out.push(n); // no spread: labels can have more nodes than a call takes arguments
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
    text.push(ch);
    i++;
  }
  flush();
  return out;
}

/**
 * Position of the closing marker, or -1. The scan only depends on the
 * position it is at, so every position of a failed scan is remembered: a
 * later scan that reaches one of them fails at once (linear overall).
 */
function findClose(scan: Scan, from: number, marker: string): number {
  const { src } = scan;
  const failed = scan.noClose?.get(marker);
  const visited: number[] = [];
  let i = from;
  while (i < src.length) {
    if (failed?.[i]) break;
    visited.push(i);
    const ch = src[i]!;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') {
      const n = runAt(src, i, '`');
      const end = findTicks(scan, n, i + n);
      i = end > 0 ? end + n : i + n;
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
  let memo = failed;
  if (!memo) scan.noClose = (scan.noClose ?? new Map()).set(marker, (memo = new Uint8Array(src.length)));
  for (const p of visited) memo[p] = 1;
  return -1;
}

/**
 * Matching `]` of the `[` at `start`, or -1. One pass from the first `[`
 * pairs all brackets (a backslash skips the next character, as before); a
 * position that pass did not reach (other escape alignment) gets a pass of
 * its own.
 */
function closingBracket(scan: Scan, start: number): number {
  const { src } = scan;
  if (scan.bracketFrom === undefined || start < scan.bracketFrom || !scan.bracketVisited![start]) {
    const visited = new Uint8Array(src.length);
    const match = new Int32Array(src.length).fill(-1);
    const stack: number[] = [];
    for (let i = start; i < src.length; i++) {
      const ch = src[i];
      if (ch === '\\') {
        i++;
        continue;
      }
      visited[i] = 1;
      if (ch === '[') stack.push(i);
      else if (ch === ']' && stack.length) match[stack.pop()!] = i;
    }
    scan.bracketFrom = start;
    scan.bracketVisited = visited;
    scan.bracketMatch = match;
  }
  return scan.bracketMatch![start]!;
}

function parseLink(scan: Scan, start: number): { label: string; href: string; end: number } | null {
  const { src } = scan;
  const i = closingBracket(scan, start);
  if (i < 0 || src[i + 1] !== '(') return null;
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
  return !!fenceOpen(line) || !!atxHeading(line) || HR.test(line) || QUOTE.test(line) || BULLET.test(line) || /^ {0,3}1[.)]([ \t]|$)/.test(line);
}

export function parseMarkdown(input: string): MdBlock[] {
  const text = String(input ?? '')
    .slice(0, MD_MAX_CHARS)
    .replace(/\r\n?/g, '\n');
  return parseBlocks(text.split('\n').map(expandTabs), 0, { cells: 0 });
}

/** Per document: table cells produced so far. */
interface BlockCtx {
  cells: number;
}

function parseBlocks(lines: string[], depth: number, ctx: BlockCtx): MdBlock[] {
  const out: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }
    // fenced code
    const fence = fenceOpen(line);
    if (fence) {
      const { marker } = fence;
      const indent = /^ */.exec(line)![0].length;
      const body: string[] = [];
      i++;
      while (i < lines.length && !fenceClose(lines[i]!, marker[0]!, marker.length)) {
        body.push(stripSpaces(lines[i]!, indent));
        i++;
      }
      i++; // closing fence (or end of input)
      out.push({ t: 'code', lang: fence.lang, v: body.join('\n') });
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
    const atx = atxHeading(line);
    if (atx) {
      out.push({ t: 'heading', level: atx.level as 1, c: parseInline(atx.text, 0) });
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
      out.push({ t: 'quote', blocks: depth < MAX_DEPTH ? parseBlocks(inner, depth + 1, ctx) : [{ t: 'paragraph', c: [{ t: 'text', v: inner.join(' ') }] }] });
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      const res = parseList(lines, i, depth, ctx);
      out.push(res.block);
      i = res.next;
      continue;
    }
    // table: header row, separator row
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!) && lines[i + 1]!.includes('-')) {
      const head = splitRow(line);
      const align: MdAlign[] = splitRow(lines[i + 1]!).map((c) =>
        c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null,
      );
      if (align.length === head.length && head.length <= MD_MAX_TABLE_COLUMNS && ctx.cells + head.length <= MD_MAX_TABLE_CELLS) {
        i += 2;
        ctx.cells += head.length;
        const rows: MdInline[][][] = [];
        while (i < lines.length && !isBlank(lines[i]!) && lines[i]!.includes('|') && ctx.cells + head.length <= MD_MAX_TABLE_CELLS) {
          const cells = splitRow(lines[i]!);
          rows.push(head.map((_, j) => parseInline(cells[j] ?? '', 0)));
          ctx.cells += head.length;
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

function parseList(lines: string[], start: number, depth: number, ctx: BlockCtx): { block: MdBlock; next: number } {
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
    items.push({ checked, blocks: depth < MAX_DEPTH ? parseBlocks(body, depth + 1, ctx) : [{ t: 'paragraph', c: [{ t: 'text', v: body.join(' ') }] }] });
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
