import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * The retention cleanup works in small batches (0.4.0): at most DELETE_BATCH rows per statement and a turn for the
 * event loop in between, so deleting many runs with large logs does not block requests. (What it deletes: ops.test.ts.)
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';

let s: TestServer;
const db = async () => (await import('../src/db.js')).db();

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
});

describe('retention cleanup in batches', () => {
  it('deletes old runs with large logs and read notifications in batches, yielding to the event loop', async () => {
    const d = await db();
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const { DELETE_BATCH } = await import('../src/maintenance.js');
    const RUNS = 120;
    const LOGS = DELETE_BATCH * 4 + 7;
    d.tx(() => {
      for (let i = 0; i < RUNS; i++) {
        d.run(
          `INSERT INTO runs (id, process_id, process_name, process_version, definition_hash, status, trigger, actor, inputs, bindings, started_at, finished_at)
           VALUES (?, 'prc_x', 'X', 1, 'h', 'succeeded', 'manual', 'admin', '{}', '{}', ?, ?)`,
          `run_old_${i}`,
          old,
          old,
        );
        d.run("INSERT INTO run_logs (run_id, ts, level, message) VALUES (?, ?, 'info', 'x')", `run_old_${i}`, old);
      }
      for (let i = 0; i < LOGS; i++) d.run("INSERT INTO run_logs (run_id, ts, level, message) VALUES ('run_old_0', ?, 'info', 'line')", old);
      const user = d.get<{ id: string }>("SELECT id FROM users WHERE username = 'admin'")!.id;
      for (let i = 0; i < DELETE_BATCH + 3; i++)
        d.run("INSERT INTO notifications (id, user_id, ts, event, title, body, read) VALUES (?, ?, ?, 'x', 't', 'b', 1)", `ntf_old_${i}`, user, old);
    });
    await s.api('PUT', '/settings', { retentionRunDays: 30, retentionNotificationDays: 7 });

    // the event loop keeps turning while the cleanup runs
    let turns = 0;
    let on = true;
    const spin = () => {
      turns++;
      if (on) setImmediate(spin);
    };
    setImmediate(spin);
    const { runCleanup } = await import('../src/maintenance.js');
    const r = await runCleanup({ manual: true });
    on = false;
    expect(r).toMatchObject({ runsDeleted: RUNS, notificationsDeleted: DELETE_BATCH + 3 });
    expect(turns).toBeGreaterThan(RUNS);
    expect(Number(d.get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE id LIKE 'run_old_%'")!.n)).toBe(0);
    expect(Number(d.get<{ n: number }>("SELECT COUNT(*) AS n FROM run_logs WHERE run_id LIKE 'run_old_%'")!.n)).toBe(0);
    // one at a time
    const again = runCleanup();
    await expect(runCleanup()).rejects.toThrow(/already running/);
    await again;
  });
});
