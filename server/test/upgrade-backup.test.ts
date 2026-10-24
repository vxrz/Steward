import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { PG_TEST_URL } from './pg-env.js';

// The data folder of this file's test server must be known before config.ts loads (dynamic imports below).
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-upgrade-backup-'));
const serverDir = path.join(root, 'server');
process.env.SM_DATA_DIR = serverDir;

const FIXTURE = path.join(__dirname, 'fixtures', 'upgrade', 'v0.1.0');
const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'manifest.json'), 'utf8')) as {
  passphrase: string;
  admin: { username: string; password: string };
  counts: { auditEntries: number };
};
const posix = process.platform !== 'win32';

const { Db, listUpgradeBackups, openAppDb, setDb, APP_VERSION_KEY, PENDING_UPGRADES_KEY } = await import('../src/db.js');
const { config } = await import('../src/config.js');
type DbT = InstanceType<typeof Db>;

/**
 * Brings a copied fixture database to the current schema without a copy, and forgets that start (app
 * version, pending upgrade record) – so each test sees "real data at today's schema" and only its own
 * extra migrations are pending, however many migrations later releases add (upgrade.test.ts covers the
 * migration from the release itself).
 */
function toCurrentSchema(file: string): void {
  new Db({ kind: 'sqlite', file }, { backup: { dir: path.join(path.dirname(file), 'unused-backups'), keep: 0 } }).close();
  const raw = new DatabaseSync(file);
  try {
    raw.prepare('DELETE FROM settings WHERE key IN (?, ?)').run(APP_VERSION_KEY, PENDING_UPGRADES_KEY);
  } finally {
    raw.close();
  }
}

let n = 0;
/** A copy of the v0.1.0 fixture's data folder, its database at the current schema (see toCurrentSchema). */
function fixtureCopy(): { dir: string; file: string; backups: string } {
  const dir = path.join(root, `copy${n++}`);
  fs.cpSync(path.join(FIXTURE, 'datadir'), dir, { recursive: true });
  const file = path.join(dir, 'service-manager.db');
  toCurrentSchema(file);
  return { dir, file, backups: path.join(dir, 'backups') };
}
const extra = (name: string, sql = `CREATE TABLE ${name} (id TEXT PRIMARY KEY)`) => ({ name, sql });
const opened: DbT[] = [];
function open(file: string, opts: ConstructorParameters<typeof Db>[1] = {}): DbT {
  const d = new Db({ kind: 'sqlite', file }, { appVersion: '9.9.9', ...opts });
  opened.push(d);
  return d;
}
const setting = (d: DbT, key: string) => {
  const r = d.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
  return r ? JSON.parse(r.value) : undefined;
};

afterAll(() => {
  for (const d of opened) d.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('automatic backup before migrating (SQLite)', () => {
  it('is not made for a new, empty database – which stays empty', () => {
    const dir = path.join(root, 'fresh');
    fs.mkdirSync(dir);
    const d = open(path.join(dir, 'service-manager.db'), { backup: { dir: path.join(dir, 'backups'), keep: 3 } });
    expect(d.upgrade).toBeUndefined();
    expect(fs.existsSync(path.join(dir, 'backups'))).toBe(false);
    expect(d.get<{ n: number }>('SELECT COUNT(*) AS n FROM settings')!.n).toBe(0);
  });

  it('is not made when there is nothing to migrate', () => {
    const c = fixtureCopy();
    const d = open(c.file, { backup: { dir: c.backups, keep: 3 }, appVersion: '0.1.0' });
    expect(d.upgrade).toBeUndefined();
    expect(listUpgradeBackups(c.backups)).toEqual([]);
    // the version is recorded for the next start
    expect(setting(d, APP_VERSION_KEY)).toBe('0.1.0');
    d.close();
    // a new app version without schema changes: an upgrade without a copy
    const again = open(c.file, { backup: { dir: c.backups, keep: 3 }, appVersion: '0.1.1' });
    expect(again.upgrade).toMatchObject({ fromVersion: '0.1.0', toVersion: '0.1.1', migrations: [], backup: null });
    expect(listUpgradeBackups(c.backups)).toEqual([]);
  });

  it('copies the database before pending migrations, private to the owner', () => {
    const c = fixtureCopy();
    const d = open(c.file, { backup: { dir: c.backups, keep: 3 }, extraMigrations: [extra('upgrade_test_a')] });
    const [backup] = listUpgradeBackups(c.backups);
    expect(path.basename(backup!)).toMatch(/^pre-9\.9\.9-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.db$/);
    if (posix) {
      expect(fs.statSync(backup!).mode & 0o777).toBe(0o600);
      expect(fs.statSync(c.backups).mode & 0o777).toBe(0o700);
    }
    // a complete, consistent copy from before the migration
    const copy = new DatabaseSync(backup!, { readOnly: true });
    try {
      expect((copy.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n).toBe(manifest.counts.auditEntries);
      expect(copy.prepare("SELECT name FROM sqlite_master WHERE name = 'upgrade_test_a'").get()).toBeUndefined();
      expect(copy.prepare("SELECT name FROM schema_migrations WHERE name = 'upgrade_test_a'").get()).toBeUndefined();
    } finally {
      copy.close();
    }
    expect(d.get("SELECT name FROM sqlite_master WHERE name = 'upgrade_test_a'")).toBeTruthy();
    expect(d.upgrade).toMatchObject({ fromVersion: null, toVersion: '9.9.9', migrations: ['upgrade_test_a'], backup });
    expect(d.upgrade!.toSchema.named).toBe(d.upgrade!.fromSchema.named + 1);
    // kept in the database until the audit entry is written (vault open)
    expect(setting(d, PENDING_UPGRADES_KEY)).toEqual([d.upgrade]);
  });

  it('keeps the newest 3 copies and leaves other files alone', () => {
    const c = fixtureCopy();
    fs.mkdirSync(c.backups, { mode: 0o700 });
    fs.writeFileSync(path.join(c.backups, 'my-own-copy.db'), 'x');
    const made: string[] = [];
    for (const name of ['upgrade_test_r1', 'upgrade_test_r2', 'upgrade_test_r3', 'upgrade_test_r4']) {
      const d = open(c.file, { backup: { dir: c.backups, keep: 3 }, extraMigrations: made.map((_, i) => extra(`upgrade_test_r${i + 1}`)).concat(extra(name)) });
      made.push(d.upgrade!.backup!);
      d.close();
    }
    expect(new Set(made).size).toBe(4);
    expect(listUpgradeBackups(c.backups)).toEqual([made[3], made[2], made[1]]);
    expect(fs.existsSync(made[0]!)).toBe(false);
    expect(fs.existsSync(path.join(c.backups, 'my-own-copy.db'))).toBe(true);
  });

  it('is turned off with 0 (SM_UPGRADE_BACKUPS=0)', () => {
    const c = fixtureCopy();
    const d = open(c.file, { backup: { dir: c.backups, keep: 0 }, extraMigrations: [extra('upgrade_test_off')] });
    expect(d.upgrade).toMatchObject({ migrations: ['upgrade_test_off'], backup: null });
    expect(fs.existsSync(c.backups)).toBe(false);
  });

  it('stops the start with the backup path when a migration fails', () => {
    const c = fixtureCopy();
    let message = '';
    try {
      open(c.file, {
        backup: { dir: c.backups, keep: 3 },
        extraMigrations: [extra('upgrade_test_ok'), extra('upgrade_test_bad', 'CREATE TABLE audit_log (x TEXT)')],
      });
    } catch (e) {
      message = (e as Error).message;
    }
    const [backup] = listUpgradeBackups(c.backups);
    expect(backup).toBeTruthy();
    expect(message).toContain('Database upgrade failed: migration "upgrade_test_bad" did not apply');
    expect(message).toContain('already exists');
    expect(message).toContain(`A copy of the database from before the upgrade is at ${backup}`);
    expect(message).toContain('1 migration(s) before it were applied (upgrade_test_ok)');
    // the failed migration was rolled back
    const d = open(c.file, { migrate: false });
    expect(d.get("SELECT name FROM schema_migrations WHERE name = 'upgrade_test_bad'")).toBeUndefined();
    expect(d.get("SELECT name FROM schema_migrations WHERE name = 'upgrade_test_ok'")).toBeTruthy();
  });

  it('names the missing copy when backups are off and a migration fails', () => {
    const c = fixtureCopy();
    expect(() => open(c.file, { backup: { dir: c.backups, keep: 0 }, extraMigrations: [extra('upgrade_test_bad2', 'CREATE TABLE runs (x TEXT)')] })).toThrow(
      /the database was not changed\.\nNo automatic copy was made \(SM_UPGRADE_BACKUPS=0\)/,
    );
  });

  it('does not migrate when the copy cannot be written', () => {
    const c = fixtureCopy();
    fs.writeFileSync(c.backups, 'a file where the folder should be');
    expect(() => open(c.file, { backup: { dir: c.backups, keep: 3 }, extraMigrations: [extra('upgrade_test_nospace')] })).toThrow(
      /Database upgrade stopped: could not back up the database to .*backups before migrating/,
    );
    const d = open(c.file, { migrate: false });
    expect(d.get("SELECT name FROM sqlite_master WHERE name = 'upgrade_test_nospace'")).toBeUndefined();
  });
});

describe.skipIf(!PG_TEST_URL)('before migrating on PostgreSQL', () => {
  it('makes no copy of its own (pg_dump is recommended in the log and the docs)', () => {
    const target = { kind: 'postgres' as const, url: PG_TEST_URL!, schema: `${process.env.SM_TEST_SCHEMA_PREFIX ?? 'smt_adhoc'}_upgb${process.pid}` };
    const backups = path.join(root, 'pg-backups');
    new Db(target, { appVersion: '1.0.0' }).close();
    const first = new Db(target, { appVersion: '1.0.0' });
    expect(first.upgrade).toBeUndefined();
    first.close();
    const d = new Db(target, { appVersion: '1.1.0', backup: { dir: backups, keep: 3 }, extraMigrations: [extra('upgrade_test_pg')] });
    try {
      expect(d.upgrade).toMatchObject({ fromVersion: '1.0.0', toVersion: '1.1.0', migrations: ['upgrade_test_pg'], backup: null });
      expect(fs.existsSync(backups)).toBe(false);
    } finally {
      d.close();
    }
    const failing = () => new Db(target, { extraMigrations: [extra('upgrade_test_pg'), extra('upgrade_test_pg_bad', 'CREATE TABLE runs (x TEXT)')] });
    expect(failing).toThrow(/restore the pg_dump backup made before the upgrade/);
  });
});

describe('system.upgraded audit entry', () => {
  it('is written once the vault is unlocked, after the migrations', async () => {
    fs.cpSync(path.join(FIXTURE, 'datadir'), serverDir, { recursive: true });
    const file = path.join(serverDir, 'service-manager.db');
    toCurrentSchema(file);
    // the app's own start-up path, with one more migration than the current schema
    setDb(openAppDb({ kind: 'sqlite', file }, { extraMigrations: [extra('upgrade_test_audit')] }));
    const { startTestServer } = await import('./helpers.js');
    const s = await startTestServer({ dataDir: serverDir });
    try {
      const backups = listUpgradeBackups(path.join(serverDir, 'backups'));
      expect(backups).toHaveLength(1);
      await s.api('POST', '/auth/login', manifest.admin);
      await s.api('POST', '/vault/unlock', { passphrase: manifest.passphrase });
      const entries = await s.api('GET', '/audit?action=system.upgraded');
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ actor: 'system', entityType: 'system' });
      expect(entries[0].seq).toBeGreaterThan(manifest.counts.auditEntries);
      expect(entries[0].details).toMatchObject({ toVersion: config.version, migrations: ['upgrade_test_audit'], backup: backups[0] });
      expect(entries[0].summary).toContain(`backup before migrating: ${backups[0]}`);
      const { db } = await import('../src/db.js');
      expect(db().get('SELECT 1 FROM settings WHERE key = ?', PENDING_UPGRADES_KEY)).toBeUndefined();
      // the web app's notice for administrators names the same copy
      const { notice } = await s.api('GET', '/system/update-notice');
      expect(notice).toMatchObject({ toVersion: config.version, migrations: ['upgrade_test_audit'], backups: [backups[0]], noBackupReason: null });
      expect((await s.api('GET', '/audit/verify')).ok).toBe(true);
    } finally {
      await s.app.close();
    }
  });
});
