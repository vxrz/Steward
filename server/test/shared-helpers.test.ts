import { describe, expect, it } from 'vitest';
import { csvCell, csvTable } from '../src/csv.js';
import { canonicalLocale, isEmailAddress, pickFormatLocale } from '@sm/shared';

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
      // control characters (escape sequences, NUL) are not part of an address
      'da\u001bna@example.com',
      'dana@exa\u0000mple.com',
    ])
      expect(isEmailAddress(a)).toBe(false);
  });
});

/** Browser locales that are not BCP 47 tags must not reach Intl (it throws a RangeError). */
describe('format locale', () => {
  it('maps POSIX forms and drops what Intl cannot parse', () => {
    expect(canonicalLocale('en-US@posix')).toBe('en-US');
    expect(canonicalLocale('de_AT.UTF-8')).toBe('de-AT');
    expect(canonicalLocale('en-gb')).toBe('en-GB');
    for (const t of ['C', '', '  ', '@posix', null, undefined]) expect(canonicalLocale(t)).toBeNull();
  });

  it('takes the first valid preference in the UI language, else the UI language', () => {
    expect(pickFormatLocale(['en-US@posix'], 'en')).toBe('en-US');
    expect(pickFormatLocale(['C', 'de_CH'], 'de')).toBe('de-CH');
    expect(pickFormatLocale(['C'], 'en')).toBe('en');
    expect(pickFormatLocale(['fr-FR', 'en-GB'], 'en')).toBe('en-GB');
    expect(pickFormatLocale([], 'de')).toBe('de');
    for (const p of [['en-US@posix'], ['C'], ['x-y_z.UTF-8']]) expect(() => new Intl.NumberFormat(pickFormatLocale(p, 'en')).format(1)).not.toThrow();
  });
});
