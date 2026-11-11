import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/** The platform list carries each platform's latest connection test (v0.3.1), taken from the audit log. */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
});

const list = async () => (await s.api('GET', '/platforms')) as { id: string; name: string; lastTest: { at: string; ok: boolean } | null }[];

describe('last connection test', () => {
  it('is null until tested, then the result and time of the latest test', async () => {
    const before = await list();
    const p = before.find((x) => x.name === 'Web probe (demo)')!;
    expect(p.lastTest).toBeNull();
    const r = (await s.api('POST', `/platforms/${p.id}/test`, {})) as { ok: boolean };
    const after = (await list()).find((x) => x.id === p.id)!;
    expect(after.lastTest).toEqual({ at: expect.any(String), ok: r.ok });
    expect(Date.now() - Date.parse(after.lastTest!.at)).toBeLessThan(60_000);
  });

  it('a failed test shows as failed', async () => {
    const created = (await s.api('POST', '/platforms', {
      name: 'Unreachable',
      kind: 'generic',
      baseUrl: 'http://127.0.0.1:9',
      config: { auth: { type: 'none' } },
    })) as {
      id: string;
    };
    const r = (await s.api('POST', `/platforms/${created.id}/test`, {})) as { ok: boolean };
    expect(r.ok).toBe(false);
    expect((await list()).find((x) => x.id === created.id)!.lastTest).toMatchObject({ ok: false });
  });
});

describe('platform list performance (security review 0.19.0 M3)', () => {
  it('finds the latest test by an indexed lookup per platform, not by reading every test ever written', async () => {
    const { db } = await import('../src/db.js');
    const d = db();
    if (d.dialect !== 'sqlite') return; // (PostgreSQL plans by table statistics; the expression index is the same)
    const { LAST_TESTS_SQL, lastConnectionTests } = await import('../src/platforms/service.js');
    expect(lastConnectionTests().size).toBeGreaterThan(0);
    const plan = d.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${LAST_TESTS_SQL}`).map((r) => r.detail);
    // the subquery searches audit_target for each platform; no step reads the whole audit log
    expect(plan.some((p) => /SEARCH t USING (COVERING )?INDEX audit_target/.test(p))).toBe(true);
    expect(plan.filter((p) => /SCAN (a|t)\b/.test(p))).toEqual([]);
  });
});
