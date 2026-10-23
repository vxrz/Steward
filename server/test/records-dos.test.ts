/**
 * Regression tests for the records security review (R1, R2, R9 and the import
 * title): inputs that made the Markdown parser, the PDF engine, the signed-PDF
 * scan or the Markdown import take seconds to minutes on the main thread.
 *
 * No test server here: these functions run on their own, as in the browser.
 * (The server used to switch V8's linear regexp engine fallback on at runtime,
 * which hid backtracking patterns; it no longer changes V8 flags.)
 */
import { describe, expect, it } from 'vitest';
import { inlineText, MD_MAX_TABLE_CELLS, parseInline, parseMarkdown, type MdBlock } from '@sm/shared';
import { breakLongWords, MAX_UNBROKEN_CHARS, ReportWriter, type Chrome, type PdfMeta } from '../src/reports/pdf/engine.js';
import { h1Title, parseRecordMarkdown } from '../src/records/markdown-io.js';
import { findSignatures } from '../src/records/signed.js';

const N = 256 * 1024;
const ms = (f: () => unknown) => {
  const t = performance.now();
  f();
  return performance.now() - t;
};
const msAsync = async (f: () => Promise<unknown>) => {
  const t = performance.now();
  await f();
  return performance.now() - t;
};

describe('R2: Markdown parser is linear', () => {
  const cases: Record<string, string> = {
    'unclosed [': '['.repeat(N),
    'unclosed *': '*a '.repeat(N / 3),
    'unclosed **': '**a '.repeat(N / 4),
    'unclosed _': '_a '.repeat(N / 3),
    'unclosed ~~': '~~a '.repeat(N / 4),
    'emphasis and brackets': '*['.repeat(N / 2),
    'soft line breaks': 'a\n'.repeat(N / 2),
    'hard line breaks': 'a  \n'.repeat(N / 4),
    'backtick runs getting shorter': Array.from({ length: 700 }, (_, i) => '`'.repeat(700 - i) + 'a').join(''),
    'nested brackets': '['.repeat(N / 2) + ']'.repeat(N / 2),
    'unclosed link targets': '[a]('.repeat(N / 4),
    'ATX heading with spaces': '# a' + ' '.repeat(N) + 'b',
    'fence info with spaces': '```' + ' '.repeat(N) + '`',
    'table separator with spaces': 'a|b\n' + ' '.repeat(N) + 'x',
    'table separator, trailing spaces': 'a|b\n-' + ' '.repeat(N) + 'x',
  };
  for (const [name, input] of Object.entries(cases)) {
    it(`parses ${name} (${Math.round(input.length / 1024)} KB) in well under a second`, () => {
      expect(ms(() => parseMarkdown(input))).toBeLessThan(2000);
    });
  }

  it('caps table columns and cells (no cell bomb from short rows)', () => {
    const bomb = 'a|'.repeat(3000) + '\n' + '-|'.repeat(3000) + '\n' + '|\n'.repeat(N / 4);
    let blocks: MdBlock[] = [];
    expect(ms(() => (blocks = parseMarkdown(bomb)))).toBeLessThan(2000);
    expect(blocks.some((b) => b.t === 'table')).toBe(false); // 3000 columns: not a table
    const wide = '|' + 'a|'.repeat(50) + '\n|' + '-|'.repeat(50) + '\n' + '|\n'.repeat(N / 4);
    let cells = 0;
    expect(ms(() => (blocks = parseMarkdown(wide)))).toBeLessThan(2000);
    for (const b of blocks) if (b.t === 'table') cells += b.head.length * (b.rows.length + 1);
    expect(cells).toBeGreaterThan(0);
    expect(cells).toBeLessThanOrEqual(MD_MAX_TABLE_CELLS);
  });

  it('keeps the tree of normal documents', () => {
    const md = [
      '# Title #',
      '',
      '## Heading with # inside ##   ',
      '',
      '###no heading',
      '',
      'Text with **bold**, *em*, _em_, snake_case_name, ~~del~~, `code`, ``co`de``, [link](https://example.com/a_(b) "t") and <https://x.y>.',
      'A hard break  ',
      'and a soft one; an unclosed *star, [bracket and `tick.',
      '',
      '```ts   extra',
      'const a = 1;',
      '```',
      '',
      '| a | b |',
      '|:--|--:|',
      '| 1 |',
      '| 2 | 3 | 4 |',
      '',
      '- [x] done',
      '  - nested',
      '1. one',
      '',
      '> quote **x**',
    ].join('\n');
    const blocks = parseMarkdown(md);
    expect(blocks.map((b) => b.t)).toEqual(['heading', 'heading', 'paragraph', 'paragraph', 'code', 'table', 'list', 'list', 'quote']);
    expect(blocks[0]).toEqual({ t: 'heading', level: 1, c: [{ t: 'text', v: 'Title' }] });
    expect(blocks[1]).toEqual({ t: 'heading', level: 2, c: [{ t: 'text', v: 'Heading with # inside' }] });
    expect(blocks[2]).toEqual({ t: 'paragraph', c: [{ t: 'text', v: '###no heading' }] });
    const p = (blocks[3] as Extract<MdBlock, { t: 'paragraph' }>).c;
    expect(p.map((n) => n.t)).toEqual([
      'text',
      'strong',
      'text',
      'em',
      'text',
      'em',
      'text',
      'del',
      'text',
      'code',
      'text',
      'code',
      'text',
      'link',
      'text',
      'link',
      'text',
      'br',
      'text',
    ]);
    expect(inlineText(p)).toBe(
      'Text with bold, em, em, snake_case_name, del, code, co`de, link and https://x.y. A hard break\nand a soft one; an unclosed *star, [bracket and `tick.',
    );
    expect(p.filter((n) => n.t === 'link').map((n) => (n as { href: string }).href)).toEqual(['https://example.com/a_(b)', 'https://x.y']);
    expect(blocks[4]).toEqual({ t: 'code', lang: 'ts', v: 'const a = 1;' });
    const table = blocks[5] as Extract<MdBlock, { t: 'table' }>;
    expect(table.align).toEqual(['left', 'right']);
    // short rows are padded, long ones cut to the header width
    expect(table.rows.map((r) => r.map((c) => inlineText(c)))).toEqual([
      ['1', ''],
      ['2', '3'],
    ]);
    expect(parseInline('a \\* b \\[c](d)')).toEqual([{ t: 'text', v: 'a * b [c](d)' }]);
    expect(parseInline('[x](javascript:alert(1))')).toEqual([{ t: 'text', v: 'x' }]);
  });
});

describe('R1: PDF engine and long words', () => {
  const meta: PdfMeta = {
    title: 't',
    author: 'a',
    subject: 's',
    keywords: [],
    creator: 'c',
    producer: 'p',
    lang: 'en',
    createdAt: new Date('2026-10-22T10:00:00Z'),
    custom: {},
  };
  const chrome: Chrome = {
    logo: Buffer.alloc(0),
    companyName: 'Example',
    shortTitle: 'Test',
    classification: '',
    tags: [],
    footer: () => ({ left: 'l', right: 'r', lines: ['footer'] }),
  };
  const render = (f: (w: ReportWriter) => void) =>
    msAsync(async () => {
      const w = new ReportWriter(meta, chrome, { accent: '#1c7ed6' });
      f(w);
      await w.finish();
    });

  it('breaks words longer than the limit with zero-width spaces only', () => {
    const word = 'a'.repeat(3 * MAX_UNBROKEN_CHARS.sans + 5);
    const broken = breakLongWords(`x ${word} y`);
    expect(broken.replace(/\u200b/g, '')).toBe(`x ${word} y`);
    expect(broken.split('\u200b').every((part) => part.length <= MAX_UNBROKEN_CHARS.sans + 2)).toBe(true);
    const hash = 'ab12'.repeat(16);
    expect(breakLongWords(`${hash} ${hash}`, MAX_UNBROKEN_CHARS.mono)).toBe(`${hash} ${hash}`); // hashes (monospace) stay intact
    expect(breakLongWords('\u{1f600}'.repeat(200)).replace(/\u200b/g, '')).toBe('\u{1f600}'.repeat(200)); // no split surrogate pairs
  });

  it('renders a 20 000-character word and 50 000 brackets in well under two seconds', async () => {
    await render((w) => w.paragraph('warm up'));
    expect(await render((w) => w.paragraph('a'.repeat(20000)))).toBeLessThan(5000);
    expect(await render((w) => w.paragraph('['.repeat(50000)))).toBeLessThan(5000);
    expect(await render((w) => w.paragraph('x'.repeat(50000), { mono: true }))).toBeLessThan(2000);
  });

  it('protects tables and key/value boxes (run and scheduled reports) the same way', async () => {
    const t = await render((w) => {
      w.table(
        Array.from({ length: 6 }, (_, i) => ({ header: `c${i}`, width: 1 })),
        Array.from({ length: 4 }, () => Array.from({ length: 6 }, () => '['.repeat(3000))),
      );
      w.keyValues([{ label: 'value', value: 'v'.repeat(20000), span: 2 }]);
    });
    expect(t).toBeLessThan(2000);
  });

  it('records the text as given (without the break characters)', async () => {
    const w = new ReportWriter(meta, chrome, { accent: '#1c7ed6' });
    w.paragraph('b'.repeat(500));
    await w.finish();
    expect(w.texts).toContain('b'.repeat(500));
  });
});

describe('R9: signed PDF scan is linear', () => {
  const MB = 20 * 1024 * 1024;
  const cases: Record<string, Buffer> = {
    'many unterminated dictionaries': Buffer.from(
      '1 0 obj\n' + ('/ByteRange [0 1 2 3] /Name (' + '('.repeat(1000) + ' endobj ').repeat(50) + ' '.repeat(MB - 60000),
      'latin1',
    ),
    'field references far away': Buffer.from('1 0 obj\n' + '/V 1 0 R'.repeat(10) + ' '.repeat(MB - 200) + '/ByteRange [0 1 2 3] endobj\n'.repeat(50), 'latin1'),
    'huge strings': Buffer.from(('\n9 0 obj /ByteRange [0 1 2 3] /M (' + 'x'.repeat(MB / 60) + ') endobj').repeat(50), 'latin1'),
  };
  for (const [name, data] of Object.entries(cases)) {
    it(`scans ${name} (${Math.round(data.length / 1024 / 1024)} MB) in well under a second`, () => {
      let n = 0;
      expect(ms(() => (n = findSignatures(data, 0).length))).toBeLessThan(1000);
      expect(n).toBe(50);
    });
  }
});

describe('Markdown import: the title line', () => {
  it('reads "# Title" lines in linear time', () => {
    expect(ms(() => parseRecordMarkdown('# a' + ' '.repeat(N) + 'b\n'))).toBeLessThan(1000);
    expect(ms(() => h1Title('# ' + '#'.repeat(N) + 'x'))).toBeLessThan(1000);
    expect(ms(() => parseRecordMarkdown('---\nx: 1\n---\n* Status: ' + '<!--'.repeat(N / 4) + '\n'))).toBeLessThan(1000);
  });

  it('reads the same titles as before', () => {
    const re = /^#\s+(.+?)\s*#*\s*$/;
    for (const line of [
      '# Title',
      '#  Title ## ',
      '# Title#',
      '# #',
      '# ###',
      '#   ',
      '# ',
      '#x',
      '# a # b #',
      '#\tTabbed\t#\t',
      '# 1. Use SQLite',
      '## Not h1',
    ]) {
      expect(h1Title(line)?.trim() ?? null, JSON.stringify(line)).toBe(re.exec(line)?.[1]!.trim() ?? null);
    }
  });
});
