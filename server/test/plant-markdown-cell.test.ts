import { describe, expect, it } from 'vitest';
import { markdownCell } from '../src/plant/collections-documents.js';

describe('the generated gateway configuration document', () => {
  it('keeps a value in its Markdown table cell, also with backslashes and pipes', () => {
    expect(markdownCell('a|b')).toBe('a\\|b');
    // a trailing backslash must not escape the pipe that is added for it
    expect(markdownCell('C:\\data\\')).toBe('C:\\\\data\\\\');
    expect(markdownCell('a\\|b')).toBe('a\\\\\\|b');
    expect(markdownCell('one\r\ntwo\nthree')).toBe('one two three');
    // every pipe in the result is escaped by an odd number of backslashes
    for (const v of ['x\\|y', '\\\\|', '|\\', 'plain']) {
      const out = markdownCell(v);
      for (const m of out.matchAll(/(\\*)\|/g)) expect(m[1]!.length % 2).toBe(1);
    }
  });
});
