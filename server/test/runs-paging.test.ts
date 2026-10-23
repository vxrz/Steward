import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

process.env.SM_GATUS_AUTOSTART = '0';

/** GET /api/runs pages with `limit` and `before` (the web app's "Load more"), also when many runs are hidden. */
let s: TestServer;
let vera: Client;
let dbm: typeof import('../src/db.js');
const BASE = Date.parse('2020-01-01T00:00:00Z');

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  vera = await s.as('vera', 'Demo-password-1');
  dbm = await import('../src/db.js');
});
afterAll(async () => {
  await s?.app.close();
});

describe('runs list paging', () => {
  it('continues with before= and leaves hidden runs out before the limit applies', async () => {
    const procs = await s.api('GET', '/processes');
    const [open, hidden] = [procs[0], procs[1]];
    await s.api('PUT', `/processes/${hidden.id}/access`, { acl: [{ subject: 'user:dana', permissions: ['view'] }] });
    const insert = (p: { id: string; name: string }, i: number) =>
      dbm.db().run(
        `INSERT INTO runs (id, process_id, process_name, process_version, definition_hash, status, dry_run, trigger, schedule_id, actor, inputs, bindings, started_at, finished_at, error, stats)
         VALUES (?, ?, ?, 1, 'x', 'succeeded', 1, 'manual', NULL, 'admin', '{}', '{}', ?, ?, NULL, '{}')`,
        `run_page_${crypto.randomUUID().slice(0, 8)}`,
        p.id,
        p.name,
        new Date(BASE - i * 60000).toISOString(),
        new Date(BASE - i * 60000 + 1000).toISOString(),
      );
    // 30 visible runs, each followed by 10 runs vera may not see (older than every demo run)
    for (let i = 0; i < 330; i++) insert(i % 11 === 0 ? open : hidden, i);
    const old = (r: { startedAt: string }) => Date.parse(r.startedAt) <= BASE;

    // the first page is full although most runs in between are hidden
    const seen: string[] = [];
    let before = new Date(BASE + 1).toISOString();
    for (let page = 0; page < 10; page++) {
      const rows = await vera('GET', `/runs?limit=7&before=${encodeURIComponent(before)}`);
      expect(rows.every((r: { processId: string }) => r.processId === open.id)).toBe(true);
      seen.push(...rows.filter(old).map((r: { id: string }) => r.id));
      if (rows.length < 7) break;
      expect(rows).toHaveLength(7);
      before = rows[rows.length - 1].startedAt;
    }
    expect(seen).toHaveLength(30);
    expect(new Set(seen).size).toBe(30);

    // the administrator sees both processes
    const all = await s.api('GET', `/runs?limit=50&before=${encodeURIComponent(new Date(BASE + 1).toISOString())}`);
    expect(all).toHaveLength(50);
    expect(all.some((r: { processId: string }) => r.processId === hidden.id)).toBe(true);
  });
});
