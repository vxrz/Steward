import { beforeAll, describe, expect, it } from 'vitest';
import { startTestServer } from './helpers.js';

/**
 * The field paths of "changed in Steward since the last import" (ADR 0020, phase 2) come from imported files: a key
 * that could reach an object's prototype is never a path, and following one finds nothing.
 */
let steward: typeof import('../src/plant/changesets/steward.js');

beforeAll(async () => {
  await startTestServer();
  steward = await import('../src/plant/changesets/steward.js');
});

describe('plant field paths', () => {
  it('leaves keys that reach the prototype out of the paths that differ', () => {
    const file = JSON.parse('{"model": "SP-200", "__proto__": {"polluted": true}, "constructor": {"x": 1}}');
    const steward_ = { model: 'SP-100' };
    expect(steward.differingPaths(steward_, file)).toEqual([['model']]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('finds nothing along a path through such a key', () => {
    const o = JSON.parse('{"__proto__": {"a": 1}, "data": {"constructor": 2, "b": 3}}');
    expect(steward.valueAt(o, ['__proto__', 'a'])).toBeUndefined();
    expect(steward.valueAt(o, ['data', 'constructor'])).toBeUndefined();
    expect(steward.valueAt(o, ['data', 'b'])).toBe(3);
    expect(steward.valueAt(o, [])).toBe(o);
  });
});
