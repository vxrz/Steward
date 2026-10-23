/**
 * Files in the data folder (run evidence, PDF reports, platform documents, monitor examples) are
 * addressed through pathInside: ids and file names from requests can never leave their folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathInside } from '../src/util.js';
import { setup, startTestServer, type TestServer } from './helpers.js';

describe('pathInside', () => {
  const base = path.resolve('/srv/steward/reports');

  it('builds paths from plain names below the base folder', () => {
    expect(pathInside(base, 'run_AbC-12_x', 'rpt_9.pdf')).toBe(path.join(base, 'run_AbC-12_x', 'rpt_9.pdf'));
    expect(pathInside('/srv/steward/reports/', 'summary', 'a.b.pdf')).toBe(path.join(base, 'summary', 'a.b.pdf'));
  });

  it('refuses separators, dot segments, hidden names, empty names and the base itself', () => {
    const bad = ['..', '.', '', '../x', 'a/../../x', 'a\\..\\x', '/etc/passwd', 'C:\\x', '.env', 'a b', 'a\0b', 'x'.repeat(256)];
    for (const seg of bad) {
      expect(() => pathInside(base, seg), JSON.stringify(seg)).toThrow(expect.objectContaining({ statusCode: 400 }));
      expect(() => pathInside(base, 'run_1', seg), JSON.stringify(seg)).toThrow(expect.objectContaining({ statusCode: 400 }));
    }
    expect(() => pathInside(base)).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
});

describe('routes that read or write files reject traversal', () => {
  let s: TestServer;
  const status = async (p: Promise<unknown>) => {
    try {
      await p;
      return 200;
    } catch (e) {
      return (e as { status: number }).status;
    }
  };

  beforeAll(async () => {
    s = await startTestServer();
    await setup(s);
  });
  afterAll(async () => {
    await s?.app.close();
  });

  it('monitor examples, run ids, report ids and document ids', async () => {
    const outside = path.join(s.dataDir, '..', 'steward-outside.yaml');
    for (const name of ['..%2Fsteward-outside.yaml', '..%2F..%2Fsteward-outside.yaml', '.hidden.yaml', '..yaml']) {
      expect(await status(s.api('POST', `/monitors/examples/${name}`))).toBe(400);
    }
    for (const id of ['..%2F..%2Fx', '..', '%2Fetc%2Fpasswd']) {
      expect([400, 404]).toContain(await status(s.api('POST', `/runs/${id}/resume`)));
      expect([400, 404]).toContain(await status(s.api('POST', `/runs/${id}/reports`, {})));
      expect([400, 404]).toContain(await status(s.api('GET', `/reports/${id}/download`)));
      expect([400, 404]).toContain(await status(s.api('GET', `/docs/${id}/file`)));
    }
    expect(fs.existsSync(outside)).toBe(false);
    expect(fs.readdirSync(path.join(s.dataDir, 'reports'))).toEqual([]);
  });
});
