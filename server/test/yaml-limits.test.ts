import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * YAML importers (security review round 3, GOV-14): the duplicate-key check of the YAML library is
 * quadratic in the number of keys of a mapping (40 000 keys took 20 seconds). Every importer caps
 * the text before parsing and checks duplicate keys in linear time. The time bounds are generous:
 * the quadratic check needs several seconds for these documents, the linear one milliseconds.
 */

let s: TestServer;
const keys = (n: number, indent = '') => Array.from({ length: n }, (_, i) => `${indent}k${i}: 1`).join('\n');
const timed = async <T>(fn: () => Promise<T>): Promise<{ ms: number; result: T | { status: number } }> => {
  const t = Date.now();
  const result = await fn().catch((e: { status: number }) => ({ status: e.status }));
  return { ms: Date.now() - t, result };
};

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
});
afterAll(async () => {
  await s?.app.close();
});

describe('YAML importers', () => {
  it('parse many keys in linear time and still reject duplicate keys', async () => {
    const { parseYaml } = await import('../src/yaml-safe.js');
    const t = Date.now();
    const v = parseYaml(`m:\n${keys(30000, '  ')}\n`, { maxBytes: 2 * 1024 * 1024 }) as { m: Record<string, number> };
    expect(Object.keys(v.m)).toHaveLength(30000);
    expect(Date.now() - t).toBeLessThan(3000);
    expect(() => parseYaml('a: 1\nb: 2\na: 3\n', { maxBytes: 1024 })).toThrow(/unique/);
    expect(() => parseYaml('x: {a: 1, a: 2}\n', { maxBytes: 1024 })).toThrow(/unique/);
    expect(() => parseYaml('a: 1\n', { maxBytes: 2 })).toThrow(/too large/);
    expect(() => parseYaml(`${keys(200)}\n`, { maxBytes: 1024 * 1024, maxKeys: 100 })).toThrow(/too many/);
  });

  it('the control catalogue import refuses large YAML files before parsing them', async () => {
    const content = `controls:\n  - ref: A\n    title: t\n    x:\n${keys(40000, '      ')}\n`;
    expect(Buffer.byteLength(content)).toBeGreaterThan(256 * 1024);
    const { ms, result } = await timed(() => s.api('POST', '/compliance/catalogues/import', { key: 'BIG', filename: 'big.yaml', content }));
    expect(result).toMatchObject({ status: 413 });
    expect(ms).toBeLessThan(3000);
  });

  it('process, dashboard, monitor, specification, record and Git sync imports are fast with many keys', async () => {
    const doc = `name: Many keys\nsteps: []\nx:\n${keys(30000, '  ')}\n`;
    const calls: [string, () => Promise<unknown>][] = [
      ['process', () => s.api('POST', '/processes/validate', { text: doc })],
      ['dashboard', () => s.api('POST', '/dashboards', { text: doc })],
      ['monitor', () => s.api('POST', '/monitors/import', { yaml: `kind: monitor\n${doc}` })],
      [
        'records',
        () =>
          s.api('POST', '/records/import', {
            dryRun: true,
            files: [{ filename: 'a.md', content: `---\ntitle: x\nx:\n${keys(1500, '  ')}\n---\nbody\n` }],
          }),
      ],
    ];
    const pf = await s.api('POST', '/platforms', { name: 'Spec test', kind: 'rest', baseUrl: 'https://api.example.com' });
    calls.push([
      'specification',
      () => s.api('POST', `/platforms/${pf.id}/specs`, { content: `openapi: 3.0.0\ninfo:\n  title: t\npaths: {}\nx:\n${keys(30000, '  ')}\n` }),
    ]);
    for (const [name, call] of calls) {
      const { ms } = await timed(call);
      expect(ms, name).toBeLessThan(3000);
    }
    // Git sync files are at most 256 KB
    const { parseData } = await import('../src/sync/items.js');
    const t = Date.now();
    expect(Object.keys((parseData(`x:\n${keys(18000, '  ')}\n`, 'x.yaml') as { x: object }).x)).toHaveLength(18000);
    expect(Date.now() - t).toBeLessThan(3000);
    expect(() => parseData('a: 1\na: 2\n', 'x.yaml')).toThrow(/unique/);
  }, 60_000);
});
