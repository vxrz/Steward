import { describe, expect, it } from 'vitest';
import { sharedSerializers } from '../src/serializers.js';

const shared = { 'Thing#': { $id: 'Thing', type: 'object', properties: { name: { type: 'string' } } } };
const route = (schema: unknown, method = 'GET', httpStatus = '200') => ({ method, url: '/api/v1/things', httpStatus, schema });
const page = () => ({
  type: 'object',
  properties: { items: { type: 'array', items: { $ref: 'Thing#' } }, nextCursor: { type: ['string', 'null'] } },
});

describe('response serializers (start-up time)', () => {
  it('builds one serializer per distinct schema, also across plugin contexts and for the HEAD route of a GET', () => {
    const options = {};
    const a = sharedSerializers(shared, options);
    const schema = page();
    const get = a(route(schema));
    expect(a(route(schema, 'HEAD'))).toBe(get); // the same object, which the build has changed in place
    expect(a(route(page(), 'GET'))).toBe(get); // an equal schema of another route
    expect(sharedSerializers(shared, options)(route(page()))).toBe(get); // a new compiler of another context
    expect(get({ items: [{ name: 'a', secret: 'x' }], nextCursor: null })).toBe('{"items":[{"name":"a"}],"nextCursor":null}');
  });

  it('builds anew for another status, other shared schemas or another schema', () => {
    const options = {};
    const a = sharedSerializers(shared, options);
    const get = a(route(page()));
    expect(a(route(page(), 'GET', '404'))).not.toBe(get);
    expect(sharedSerializers({ 'Thing#': { ...shared['Thing#'] } }, options)(route(page()))).not.toBe(get);
    expect(a(route({ type: 'object', properties: { items: { type: 'array' } } }))).not.toBe(get);
  });
});
