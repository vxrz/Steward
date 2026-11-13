import { describe, expect, it } from 'vitest';
import { detailLines } from '../../web/src/pages/plant/views/flowText.js';

/**
 * A card of the data flow names its first entry and how many more (0.23.0, web/src/pages/plant/views/flowText.ts): a
 * collector that several collections share showed only the first one before.
 */
describe("a flow card's second line", () => {
  const more = (count: number) => `and ${count} more`;
  it('is the entry itself when there is one', () => {
    expect(detailLines('Sentron-Basic-Data', more)).toBe('Sentron-Basic-Data');
  });
  it('is the first entry and how many more when there are several', () => {
    expect(detailLines('electricity\npower\nenergy\nbasic', more)).toBe('electricity\nand 3 more');
  });
  it('clips the first entry for the exported picture and keeps the count', () => {
    const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
    expect(detailLines('x'.repeat(40) + '\nsecond', (n) => `(+${n})`, clip)).toBe(`${'x'.repeat(29)}…\n(+1)`);
    expect(detailLines('y'.repeat(40), more, clip)).toBe(`${'y'.repeat(35)}…`);
  });
});
