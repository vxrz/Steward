import { z } from 'zod';

/**
 * Length limits for zod input schemas (GHSA-mrhx-c7xc-m3w5).
 *
 * Zod checks every element of an array and keeps one issue per failing element. Since zod 4.6.6 an
 * array stops at its `.max()` before it looks at any element – but only when the length check comes
 * first (`z.array(x).max(n)`, optionally after `.min()`; not after a `.refine()`). A record has no such
 * limit, so `boundedRecord` counts the keys before any value is checked. server/src/bodyShape.ts limits
 * the shape of every request body as a second line of defence; server/test/zod-limits.test.ts checks
 * that every input array and record has a limit.
 */

/** A record (string keys) with at most `maxKeys` entries; the count is checked before the values. */
export function boundedRecord<V extends z.ZodType>(value: V, maxKeys: number, message = `Too big: expected object to have <=${maxKeys} entries`) {
  return z
    .preprocess(
      (input, ctx) => {
        if (input !== null && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length > maxKeys) {
          ctx.addIssue({ code: 'too_big', origin: 'object', maximum: maxKeys, inclusive: true, input, message });
        }
        return input;
      },
      z.record(z.string(), value),
    )
    .meta({ maxProperties: maxKeys });
}

/** Values of one repeated query parameter of the public API (`?status=a&status=b`). */
export const QUERY_LIST_MAX = 50;
