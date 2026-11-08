import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { Db } from '../src/db.js';
import { overrideConfig, reloadConfig } from '../src/config.js';
import { reclaimFreePages, sqliteSpace, vacuumAtStart } from '../src/database/sqlite-space.js';
import { snapshotSqlite } from '../src/database/sqlite-snapshot.js';

/** SQLite: the nightly snapshot off the event loop, and deleted space given back (O8 of the 0.10 review). */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-sqlite-space-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => path.join(dir, `db${n++}.db`);
const open: Db[] = [];
afterAll(() => open.forEach((d) => d.close()));
const db = (f: string) => {
  const d = new Db({ kind: 'sqlite', file: f }, { quiet: true });
  open.push(d);
  return d;
};
/** ~40 MB of rows in a table of its own. */
function fill(d: Db): void {
  d.exec('CREATE TABLE filler (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
  const chunk = 'x'.repeat(4000);
  d.tx(() => {
    for (let i = 0; i < 10_000; i++) d.run('INSERT INTO filler (v) VALUES (?)', chunk);
  });
}

describe('incremental auto-vacuum', () => {
  it('is on for new databases (SM_SQLITE_AUTO_VACUUM), not for older ones', () => {
    expect(sqliteSpace(db(file()))?.autoVacuum).toBe('incremental');
    overrideConfig({ SM_SQLITE_AUTO_VACUUM: false });
    try {
      expect(sqliteSpace(db(file()))?.autoVacuum).toBe('none');
    } finally {
      reloadConfig();
    }
    // a database written by 0.10: the fixture
    const old = file();
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'upgrade', 'v0.10.0', 'datadir', 'service-manager.db'), old);
    const d = new Db({ kind: 'sqlite', file: old }, { migrate: false });
    try {
      expect(sqliteSpace(d)?.autoVacuum).toBe('none');
    } finally {
      d.close();
    }
  });

  it('gives deleted space back in steps after the clean-up, with turns for the event loop', async () => {
    const f = file();
    const d = db(f);
    fill(d);
    const full = fs.statSync(f).size;
    d.run('DELETE FROM filler');
    d.compact();
    expect(sqliteSpace(d)!.freePages).toBeGreaterThan(5000);
    let turns = 0;
    const r = await reclaimFreePages(d, { turn: async () => void turns++ });
    expect(r!.freedBytes).toBeGreaterThan(30 * 1024 * 1024);
    expect(turns).toBeGreaterThan(2); // 8 MB a step
    expect(sqliteSpace(d)!.freePages).toBe(0);
    expect(fs.statSync(f).size).toBeLessThan(full / 4);
  });

  it('converts an older database once with SM_SQLITE_VACUUM_AT_START (full VACUUM)', async () => {
    const f = file();
    overrideConfig({ SM_SQLITE_AUTO_VACUUM: false });
    let d: Db;
    try {
      d = db(f);
    } finally {
      reloadConfig();
    }
    fill(d);
    d.run('DELETE FROM filler');
    d.compact();
    const full = fs.statSync(f).size;
    // without the conversion the clean-up cannot give anything back
    expect((await reclaimFreePages(d))!.freedBytes).toBe(0);
    vacuumAtStart(d);
    expect(sqliteSpace(d)).toMatchObject({ autoVacuum: 'incremental', freePages: 0 });
    expect(fs.statSync(f).size).toBeLessThan(full / 4);
  });
});

describe('the backup snapshot', () => {
  it('is made in a worker thread: the event loop and writes go on meanwhile, and the copy is consistent', async () => {
    const f = file();
    const d = db(f);
    fill(d);
    d.exec('CREATE TABLE counter (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)');
    const out = path.join(dir, 'snapshot.db');
    fs.closeSync(fs.openSync(out, 'wx', 0o600));
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
      d.run('INSERT INTO counter (n) VALUES (?)', ticks); // the app's own connection keeps writing
    }, 1);
    let fellBack = false;
    try {
      const r = await snapshotSqlite(f, out, () => (fellBack = true));
      expect(r).toEqual({ inWorker: true });
    } finally {
      clearInterval(timer);
    }
    expect(fellBack).toBe(false);
    expect(ticks).toBeGreaterThan(0);
    const copy = new DatabaseSync(out, { readOnly: true });
    try {
      expect((copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok');
      expect((copy.prepare('SELECT COUNT(*) AS c FROM filler').get() as { c: number }).c).toBe(10_000);
      // a snapshot of one moment: some or none of the counter rows, never more than were written
      expect((copy.prepare('SELECT COUNT(*) AS c FROM counter').get() as { c: number }).c).toBeLessThanOrEqual(ticks);
    } finally {
      copy.close();
    }
  });

  it('reports a failure (the target is not empty)', async () => {
    const f = file();
    db(f);
    const out = path.join(dir, 'not-empty.db');
    fs.writeFileSync(out, 'something');
    await expect(snapshotSqlite(f, out, () => undefined)).rejects.toThrow(/database snapshot failed/);
  });
});
