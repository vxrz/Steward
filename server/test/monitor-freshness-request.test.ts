import { describe, expect, it } from 'vitest';
import { checkSchema, definitionIssues, monitorDefinitionSchema } from '@sm/shared';

/** The platform freshness check with method, headers and body (#233): only with the platform source, a body only with POST. */

describe('platform freshness request', () => {
  it('platform freshness: method, headers and body only with the platform source, a body only with POST', () => {
    const fresh = (extra: Record<string, unknown>) =>
      definitionIssues(
        monitorDefinitionSchema.parse({
          name: 'x',
          checks: [{ id: 'f', name: 'f', type: 'freshness', platform: 'p', mode: 'maxAge', maxAgeSeconds: 60, ...extra }],
        }),
      ).map((i) => `${i.path.split('.').pop()}: ${i.message}`);
    const platform = { source: 'platform', path: '/search', timestamp: 'hits[0].ts' };
    expect(fresh({ ...platform, method: 'POST', headers: { 'content-type': 'application/json' }, body: { query: { match_all: {} } } })).toEqual([]);
    expect(fresh({ ...platform, body: { a: 1 } })).toEqual(['body: a body is only sent with POST']);
    // header names and the body's size: rules of the schema (save, import and Check now)
    const parsed = (extra: Record<string, unknown>) => {
      const r = checkSchema.safeParse({ id: 'f', name: 'f', type: 'freshness', platform: 'p', ...platform, method: 'POST', ...extra });
      return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    };
    expect(parsed({ headers: { 'bad header': 'x', Host: 'elsewhere.invalid' } })).toEqual([
      'headers: "bad header" is not a valid header name',
      'headers: the header Host is set by the connection',
    ]);
    expect(parsed({ body: 'x'.repeat(70000) })).toEqual(['body: the body may have at most 65536 characters']);
    expect(fresh({ source: 'insightsHub', assetId: 'a', aspect: 'b', variables: ['v'], method: 'POST' })).toEqual([
      'method: only the platform source sends a request of its own',
    ]);
    expect(checkSchema.safeParse({ id: 'f', name: 'f', type: 'freshness', platform: 'p', source: 'platform', method: 'DELETE' }).success).toBe(false);
  });
});
