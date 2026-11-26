import { describe, expect, it } from 'vitest';
import { nullTypeFirst } from '../src/api/index.js';

describe('OpenAPI document: nullable types', () => {
  it('writes "null" first in every type list, whatever order the schema compiler produced', () => {
    const doc = {
      components: {
        schemas: {
          A: { type: ['string', 'null'] },
          B: { type: 'object', properties: { n: { type: ['number', 'null'] }, s: { type: ['null', 'string'] } } },
          C: { anyOf: [{ type: ['boolean', 'integer', 'null'] }, { type: 'string' }] },
        },
      },
    };
    nullTypeFirst(doc);
    expect(doc.components.schemas.A.type).toEqual(['null', 'string']);
    expect(doc.components.schemas.B.properties.n.type).toEqual(['null', 'number']);
    expect(doc.components.schemas.B.properties.s.type).toEqual(['null', 'string']);
    expect(doc.components.schemas.C.anyOf[0]!.type).toEqual(['null', 'boolean', 'integer']);
    expect(doc.components.schemas.C.anyOf[1]!.type).toBe('string');
    expect(doc.components.schemas.B.type).toBe('object');
  });
});
