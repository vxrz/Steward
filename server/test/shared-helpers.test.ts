import { describe, expect, it } from 'vitest';
import { csvCell, csvTable } from '../src/csv.js';
import { isEmailAddress } from '@sm/shared';

/** The helpers merged in #18: one CSV writer, one e-mail address rule. */
describe('CSV', () => {
  it('defuses formulas, quotes always or only where needed, joins lists', () => {
    for (const v of ['=HYPERLINK("x")', '+1', '-1', '@SUM(A1)', '\tx', '\rx']) {
      expect(csvCell(v)).toMatch(/^"'/);
      expect(csvCell(v, 'needed')).toMatch(/^"?'/);
    }
    expect(csvCell('plain')).toBe('"plain"');
    expect(csvCell('plain', 'needed')).toBe('plain');
    expect(csvCell('a;b', 'needed')).toBe('"a;b"');
    expect(csvCell(['a', 'b'], 'needed')).toBe('"a; b"');
    expect(csvCell({ k: 1 })).toBe('"{""k"":1}"');
    expect(csvCell(null, 'needed')).toBe('');
    expect(csvCell(3, 'needed')).toBe('3');
  });

  it('writes a file with CRLF lines and, for Excel, a byte order mark', () => {
    expect(csvTable(['a', 'b'], [[1, 'x']])).toBe('a,b\r\n"1","x"\r\n');
    expect(csvTable(['a'], [['y']], { quote: 'needed', bom: true })).toBe('﻿a\r\ny\r\n');
  });
});

describe('e-mail addresses', () => {
  it('accepts ordinary and international addresses', () => {
    for (const a of ['dana@example.com', 'first.last+tag@sub.example.co.uk', 'jürgen@beispiel.de', "o'neil@example.org"]) expect(isEmailAddress(a)).toBe(true);
  });
  it('refuses what is not one address', () => {
    for (const a of [
      '',
      'dana',
      'dana@example',
      '@example.com',
      'a b@example.com',
      'a@b.com,c@d.com',
      'Dana <dana@example.com>',
      'a@b@c.com',
      'a@example.com.',
      `${'a'.repeat(250)}@x.de`,
    ])
      expect(isEmailAddress(a)).toBe(false);
  });
});
