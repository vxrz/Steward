import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Backups to S3 (#117): the encrypted file format, the retention rule, and end to end against the mock S3 – a backup
 * (multipart upload, signed with SigV4 and checked by the mock), the restore test, a changed copy in the bucket, the
 * retention rule removing older copies, and the offline CLI with the passphrase alone.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
// small parts, so the test exercises the multipart upload
process.env.SM_BACKUP_SINGLE_PUT_BYTES = '65536';
process.env.SM_BACKUP_PART_BYTES = '262144';

let s: TestServer;
let mockBase: string;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-backup-test-'));
const PASSPHRASE = 'correct horse battery staple 42';
/** The error answer of a request that must fail. */
const refused = (method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> =>
  s.api(method, url, body).then(
    () => {
      throw new Error(`${method} ${url} was not refused`);
    },
    (e: { status: number; body: any }) => e,
  );

/** PostgreSQL: a database of its own for the restore test, dropped afterwards. */
async function scratchDatabase(): Promise<{ tables(): Promise<number>; drop(): Promise<void> }> {
  const { default: pg } = await import('pg');
  const { PG_TEST_URL } = await import('./pg-env.js');
  const { overrideConfig, reloadConfig } = await import('../src/config.js');
  const name = `smt_restore_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
  const admin = new pg.Client({ connectionString: PG_TEST_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(PG_TEST_URL!);
  url.pathname = `/${name}`;
  overrideConfig({ SM_BACKUP_RESTORE_TEST_DATABASE_URL: url.toString() });
  return {
    async tables() {
      const c = new pg.Client({ connectionString: url.toString() });
      await c.connect();
      try {
        const r = await c.query("SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema')");
        return r.rows[0].n as number;
      } finally {
        await c.end();
      }
    },
    async drop() {
      reloadConfig();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  mockBase = `${s.base.replace(/\/$/, '')}/mock`;
});
afterAll(async () => {
  await s?.app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('S3 multipart uploads', () => {
  it('give a large archive larger parts, never more than 10,000', async () => {
    const { partSize, MAX_PARTS } = await import('../src/backup/s3.js');
    const MiB = 1024 * 1024;
    expect(partSize(100 * MiB, 16 * MiB)).toBe(16 * MiB);
    expect(partSize(16 * MiB * 10_000, 16 * MiB)).toBe(16 * MiB);
    const big = 500 * 1024 * MiB; // 500 GB
    expect(Math.ceil(big / partSize(big, 16 * MiB))).toBeLessThanOrEqual(MAX_PARTS);
    expect(partSize(big, 16 * MiB) % MiB).toBe(0);
  });
});

describe('the PostgreSQL restore test database', () => {
  it('is told apart from the live database by host, port and database name', async () => {
    const { databaseIdentity } = await import('../src/backup/archive.js');
    expect(databaseIdentity('postgres://a:x@DB.example:5432/steward')).toBe(databaseIdentity('postgres://b:y@db.example/steward?sslmode=require'));
    expect(databaseIdentity('postgres://a@db.example/steward')).not.toBe(databaseIdentity('postgres://a@db.example/steward_restore_test'));
    expect(databaseIdentity('postgres://a@db.example:5433/steward')).not.toBe(databaseIdentity('postgres://a@db.example:5432/steward'));
  });

  it('accepts only the unknown transaction_timeout of a newer pg_restore on PostgreSQL 16 or older', async () => {
    const { onlyTransactionTimeoutErrors } = await import('../src/backup/archive.js');
    const timeout =
      'pg_restore: error: could not execute query: ERROR:  unrecognized configuration parameter "transaction_timeout"\nCommand was: SET transaction_timeout = 0;\n';
    expect(onlyTransactionTimeoutErrors(`${timeout}pg_restore: warning: errors ignored on restore: 1\n`)).toBe(true);
    expect(onlyTransactionTimeoutErrors(timeout)).toBe(true);
    // another error next to it, a count that does not match, or no error at all: the restore failed
    const other = 'pg_restore: error: could not execute query: ERROR:  relation "runs" already exists\nCommand was: CREATE TABLE runs ();\n';
    expect(onlyTransactionTimeoutErrors(`${timeout}${other}pg_restore: warning: errors ignored on restore: 2\n`)).toBe(false);
    expect(onlyTransactionTimeoutErrors(`${timeout}pg_restore: warning: errors ignored on restore: 3\n`)).toBe(false);
    expect(onlyTransactionTimeoutErrors('pg_restore: error: connection to server failed\n')).toBe(false);
    expect(onlyTransactionTimeoutErrors('')).toBe(false);
  });
});

describe('encrypted backup file', () => {
  it('round-trips, and detects a wrong key, changed, re-ordered, cut-off and appended data', async () => {
    const { encryptFile, decryptFile, deriveBackupKey, newKdf, readHeader } = await import('../src/backup/crypto.js');
    const plain = path.join(tmp, 'plain.bin');
    fs.writeFileSync(plain, crypto.randomBytes(10_000));
    const kdf = { ...newKdf(), N: 2 ** 10 };
    const key = await deriveBackupKey('a passphrase of some length', kdf);
    const enc = path.join(tmp, 'plain.smbackup');
    const e = await encryptFile(plain, enc, key, { kdf, chunkBytes: 1000, info: { version: 'test' } });
    expect(e.sha256).toBe(crypto.createHash('sha256').update(fs.readFileSync(enc)).digest('hex'));
    const { header, dataStart } = await readHeader(enc);
    expect(header).toMatchObject({ v: 1, alg: 'AES-256-GCM', chunkBytes: 1000, keyId: e.header.keyId, info: { version: 'test' } });
    const out = (n: string) => path.join(tmp, n);
    await decryptFile(enc, out('ok.bin'), key);
    expect(fs.readFileSync(out('ok.bin')).equals(fs.readFileSync(plain))).toBe(true);
    // the wrong passphrase
    await expect(decryptFile(enc, out('wrong.bin'), await deriveBackupKey('another passphrase', kdf))).rejects.toThrow(/Wrong backup passphrase/);
    expect(fs.existsSync(out('wrong.bin'))).toBe(false);
    const bytes = fs.readFileSync(enc);
    const frame = 4 + 1000 + 16;
    const variants: [string, Buffer, RegExp][] = [
      ['changed', Buffer.from(bytes.map((b, i) => (i === dataStart + frame * 3 + 100 ? b ^ 1 : b))), /changed/],
      ['cut off', bytes.subarray(0, dataStart + frame * 9), /changed or cut off/],
      ['appended', Buffer.concat([bytes, bytes.subarray(dataStart, dataStart + frame)]), /changed/],
      [
        're-ordered',
        Buffer.concat([
          bytes.subarray(0, dataStart),
          bytes.subarray(dataStart + frame, dataStart + 2 * frame),
          bytes.subarray(dataStart, dataStart + frame),
          bytes.subarray(dataStart + 2 * frame),
        ]),
        /changed/,
      ],
      ['header changed', Buffer.from(bytes.toString('latin1').replace('"version":"test"', '"version":"tost"'), 'latin1'), /changed/],
    ];
    for (const [name, data, error] of variants) {
      const f = out(`${name}.smbackup`);
      fs.writeFileSync(f, data);
      await expect(decryptFile(f, out(`${name}.bin`), key), name).rejects.toThrow(error);
      expect(fs.existsSync(out(`${name}.bin`))).toBe(false);
    }
  });
});

describe('retention', () => {
  it('keeps the newest of 7 days, 4 weeks and 12 months – and never deletes everything when backups stop', async () => {
    const { retained, isoWeek } = await import('../src/backup/retention.js');
    expect(isoWeek(new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01');
    expect(isoWeek(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53');
    const start = Date.parse('2026-10-30T02:15:00Z');
    const daily = Array.from({ length: 500 }, (_, i) => new Date(start - i * 86400_000));
    const keep = retained(daily, (d) => d, { daily: 7, weekly: 4, monthly: 12 });
    const kept = [...keep.keys()].map((d) => d.toISOString().slice(0, 10)).sort();
    // 7 days, plus weekly and monthly ones further back (some coincide)
    expect(kept.length).toBeGreaterThanOrEqual(19);
    expect(kept.length).toBeLessThanOrEqual(23);
    expect(keep.get(daily[0]!)).toEqual(expect.arrayContaining(['newest', 'daily', 'weekly', 'monthly']));
    expect(kept[0]! >= '2025-11-01').toBe(true);
    // two backups on one day: only the newer counts for that day
    const twice = [new Date('2026-10-30T12:00:00Z'), new Date('2026-10-30T02:00:00Z'), new Date('2026-10-29T02:00:00Z')];
    expect([...retained(twice, (d) => d, { daily: 7, weekly: 0, monthly: 0 }).keys()]).toEqual([twice[0], twice[2]]);
    // backups stopped half a year ago: the last ones stay
    const old = Array.from({ length: 10 }, (_, i) => new Date(start - (180 + i) * 86400_000));
    expect(retained(old, (d) => d, { daily: 7, weekly: 0, monthly: 0 }).size).toBe(7);
  });
});

describe('backups to S3', () => {
  let storageId: string;

  async function waitIdle(): Promise<any> {
    const { backupIdle } = await import('../src/backup/service.js');
    await backupIdle();
    return s.api('GET', '/backups');
  }

  it('refuses storage that is not S3, a short passphrase, and enabling without key', async () => {
    const plain = await s.api('POST', '/platforms', {
      name: 'Not S3',
      kind: 'generic',
      baseUrl: `${mockBase}/test`,
      config: { auth: { type: 'none' }, variables: {}, http: { proxy: 'none' } },
    });
    const bad = await refused('PUT', '/backups/settings', { ...(await s.api('GET', '/backups')).settings, platformId: plain.id });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('BACKUP_NOT_S3');
    const p = await s.api('POST', '/platforms', {
      name: 'Backup bucket',
      kind: 'generic',
      baseUrl: `${mockBase}/s3/steward-backups`,
      config: { auth: { type: 'aws_sigv4', aws: { region: 'eu-central-1', service: 's3' } }, variables: {}, http: { proxy: 'none' } },
      secrets: { accessKeyId: 'AKIADEMOEXAMPLE', secretAccessKey: 'demoSecretKey' },
    });
    storageId = p.id;
    const noKey = await refused('PUT', '/backups/settings', { ...(await s.api('GET', '/backups')).settings, platformId: p.id, enabled: true });
    expect(noKey.body.code).toBe('BACKUP_NO_KEY');
    const short = await refused('PUT', '/backups/passphrase', { passphrase: 'too short' });
    expect(short.body.code).toBe('BACKUP_PASSPHRASE_SHORT');
    const cron = await refused('PUT', '/backups/settings', { ...(await s.api('GET', '/backups')).settings, cron: '0 0 2 * * *' });
    expect(cron.body.code).toBe('CRON_FIVE_FIELDS');
  });

  it('backs up, encrypted and signed, and the restore test checks the copy completely', async () => {
    const st = await s.api('PUT', '/backups/passphrase', { passphrase: PASSPHRASE });
    expect(st.key.keyId).toMatch(/^[0-9a-f]{16}$/);
    // the passphrase is not stored anywhere
    const stored = JSON.stringify((await import('../src/db.js')).db().all('SELECT * FROM settings'));
    expect(stored).not.toContain(PASSPHRASE);
    const saved = await s.api('PUT', '/backups/settings', { ...st.settings, enabled: true, platformId: storageId, prefix: 'prod/steward/' });
    expect(saved.nextBackupAt).toEqual(expect.any(String));
    fs.writeFileSync(path.join(s.dataDir, 'docs', 'marker.txt'), 'in the backup');
    // the instance lock of a running server (database/sqlite-lock.ts) stays out of the backup
    if ((await import('../src/config.js')).config.database.kind === 'sqlite') {
      fs.writeFileSync(path.join(s.dataDir, 'service-manager.db.lock'), '');
      fs.writeFileSync(path.join(s.dataDir, 'service-manager.db.lock.json'), '{}');
    }

    const started = await s.api('POST', '/backups/run', {});
    expect(started).toMatchObject({ kind: 'backup', status: 'running', trigger: 'manual' });
    const again = await refused('POST', '/backups/run', {});
    expect(again.body.code).toBe('BACKUP_BUSY');
    const done = await waitIdle();
    const run = done.lastBackup;
    expect(run.status, JSON.stringify(run.steps)).toBe('succeeded');
    expect(run.objectKey).toMatch(/^prod\/steward\/steward-\d{8}T\d{6}Z\.smbackup$/);
    expect(run.steps.map((x: any) => x.name)).toEqual(['archive', 'encrypt', 'upload', 'retention']);
    expect(run.steps[2].message).toMatch(/parts\)/);
    const { mockS3Objects } = await import('../src/mock/mockS3.js');
    const obj = mockS3Objects().get(run.objectKey)!;
    expect(crypto.createHash('sha256').update(obj.body).digest('hex')).toBe(run.sha256);
    expect(obj.meta['x-amz-meta-sha256']).toBe(run.sha256);
    expect(obj.body.subarray(0, 17).toString()).toBe('STEWARD-BACKUP-1\n');
    // encrypted: nothing of the content shows
    expect(obj.body.includes(Buffer.from('in the backup'))).toBe(false);
    expect(fs.readdirSync(path.join(s.dataDir, '.backup-work'))).toEqual([]);

    // PostgreSQL: the restore test restores into a scratch database of its own (SM_BACKUP_RESTORE_TEST_DATABASE_URL)
    const pg = done.database === 'postgres';
    const scratch = pg ? await scratchDatabase() : undefined;
    let tested: any;
    try {
      await s.api('POST', '/backups/restore-test', {});
      tested = (await waitIdle()).lastRestoreTest;
      expect(tested.status, JSON.stringify(tested.steps)).toBe('succeeded');
      // SQLite: integrity check and the audit chain of the snapshot; PostgreSQL: pg_restore reads the dump and restores
      // it into the scratch database, whose audit chain is checked the same way
      expect(tested.steps.map((x: any) => [x.name, x.ok])).toEqual([
        ['download', true],
        ['decrypt', true],
        ['manifest', true],
        ['checksums', true],
        ['database', true],
        ...(pg ? [['restore', true]] : []),
        ['audit', true],
      ]);
      expect(tested.steps.find((x: any) => x.name === 'database').message).toMatch(pg ? /pg_restore reads the dump/ : /integrity check: ok/);
      if (scratch) {
        expect(tested.steps.find((x: any) => x.name === 'restore').message).toMatch(
          /Restored into the restore test database .*: \d+ tables, schema version \d+/,
        );
        expect(tested.steps.find((x: any) => x.name === 'audit').message).toMatch(/Audit chain of the restored database/);
        // the restored schema is gone again
        expect(await scratch.tables()).toBe(0);
      }
    } finally {
      await scratch?.drop();
    }
    const list = await s.api('GET', '/backups/stored');
    expect(list).toEqual([expect.objectContaining({ key: run.objectKey, keptAs: expect.arrayContaining(['newest']) })]);

    // offline, with the passphrase alone
    const file = path.join(tmp, 'download.smbackup');
    fs.writeFileSync(file, obj.body);
    const { runBackupCli } = await import('../src/cli/backup.js');
    const pf = path.join(tmp, 'pass.txt');
    fs.writeFileSync(pf, `${PASSPHRASE}\n`);
    const zip = path.join(tmp, 'restored.zip');
    expect(await runBackupCli(['decrypt', file, '--out', zip, '--passphrase-file', pf], 'backup')).toBe(0);
    const { ZipReader } = await import('../src/compliance/zip.js');
    const z = await ZipReader.open(zip);
    expect((await z.read(z.find('data/docs/marker.txt')!)).toString()).toBe('in the backup');
    expect(z.find(pg ? 'database/steward.pgdump' : 'database/steward.db')).toBeTruthy();
    expect(z.find('data/vault.json')).toBeTruthy();
    expect(z.entries.some((e) => e.name.startsWith('data/.backup-work') || e.name.startsWith('data/service-manager.db'))).toBe(false);
    // the authenticated header says it is a backup (0.16.0); verify checks it
    const { deriveBackupKey, encryptFile, readHeader } = await import('../src/backup/crypto.js');
    const { header } = await readHeader(file);
    expect(header.info).toMatchObject({ content: 'backup' });
    expect(await runBackupCli(['verify', file, '--passphrase-file', pf], 'backup')).toBe(0);
    // a backup made before 0.16.0 names no content: still a backup
    const older = path.join(tmp, 'older.smbackup');
    await encryptFile(zip, older, await deriveBackupKey(PASSPHRASE, header.kdf), { kdf: header.kdf, info: { product: 'Steward', version: '0.15.0' } });
    expect((await readHeader(older)).header.info?.content).toBeUndefined();
    expect(await runBackupCli(['verify', older, '--passphrase-file', pf], 'backup')).toBe(0);
    fs.writeFileSync(pf, 'not the passphrase\n');
    expect(await runBackupCli(['verify', file, '--passphrase-file', pf], 'backup')).toBe(1);
  });

  it('notices a changed copy in the bucket and tells the administrators', async () => {
    const { mockS3Objects } = await import('../src/mock/mockS3.js');
    const key = (await s.api('GET', '/backups')).lastBackup.objectKey;
    const obj = mockS3Objects().get(key)!;
    const original = obj.body;
    obj.body = Buffer.from(original);
    obj.body[obj.body.length - 100] ^= 1;
    await s.api('POST', '/backups/restore-test', {});
    const t = (await waitIdle()).lastRestoreTest;
    expect(t.status).toBe('failed');
    expect(t.message).toMatch(/SHA-256 differs from the upload/);
    obj.body = original;
    let notes: any[] = [];
    for (let i = 0; i < 50 && !notes.some((n) => n.event === 'backup.failed'); i++) {
      notes = (await s.api('GET', '/notifications')).items;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(notes.find((n) => n.event === 'backup.failed')).toMatchObject({ title: expect.stringContaining('restore test failed'), link: '/settings/backups' });
  });

  it('removes older backups by the retention rule, only objects Steward named', async () => {
    const { mockS3Objects } = await import('../src/mock/mockS3.js');
    const objects = mockS3Objects();
    const day = 86400_000;
    const stamp = (d: Date) =>
      d
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}/, '');
    for (let i = 1; i <= 60; i++)
      objects.set(`prod/steward/steward-${stamp(new Date(Date.now() - i * day))}.smbackup`, { body: Buffer.from('old'), meta: {}, lastModified: new Date() });
    objects.set('prod/steward/notes.txt', { body: Buffer.from('not a backup'), meta: {}, lastModified: new Date() });
    objects.set('prod/steward/sub/steward-20200101T000000Z.smbackup', { body: Buffer.from('elsewhere'), meta: {}, lastModified: new Date() });
    await s.api('POST', '/backups/run', {});
    const run = (await waitIdle()).lastBackup;
    expect(run.status, JSON.stringify(run.steps)).toBe('succeeded');
    const left = [...objects.keys()].filter((k) => /^prod\/steward\/steward-/.test(k));
    // today's (two), 6 more days, weekly and monthly ones of the last two months
    expect(left.length).toBeLessThan(20);
    expect(run.deleted).toBe(62 - left.length);
    expect(objects.has('prod/steward/notes.txt')).toBe(true);
    expect(objects.has('prod/steward/sub/steward-20200101T000000Z.smbackup')).toBe(true);
    const stored = await s.api('GET', '/backups/stored');
    expect(stored.every((b: any) => b.keptAs.length > 0)).toBe(true);
  });

  it('fails when the platform was redirected, until an administrator confirms the target again (0.17.1)', async () => {
    const { mockS3Objects } = await import('../src/mock/mockS3.js');
    const { readSetting, writeSetting } = await import('../src/settings.js');
    const platform = await s.api('GET', `/platforms/${storageId}`);
    expect((await s.api('GET', '/backups')).targetChanged).toBe(false);
    expect((await s.api('GET', '/backups')).targetConfirmed).toMatchObject({ by: 'admin' });

    // a new access key id alone counts (the secret itself is never part of the fingerprint) …
    await s.api('PUT', `/platforms/${storageId}/secrets`, { accessKeyId: 'AKIAINVENTEDOTHER', secretAccessKey: 'another-secret-value' });
    expect((await s.api('GET', '/backups')).targetChanged).toBe(true);
    // … and setting the confirmed key again restores the target
    await s.api('PUT', `/platforms/${storageId}/secrets`, { accessKeyId: 'AKIADEMOEXAMPLE', secretAccessKey: 'demoSecretKey' });
    expect((await s.api('GET', '/backups')).targetChanged).toBe(false);

    // the platform now names another bucket: the backup fails before it makes or uploads anything …
    await s.api('PUT', `/platforms/${storageId}`, { baseUrl: `${mockBase}/s3/invented-other-backups`, credentials: 'keep' });
    expect((await s.api('GET', '/backups')).targetChanged).toBe(true);
    await s.api('POST', '/backups/run', {});
    const run = (await waitIdle()).lastBackup;
    expect(run).toMatchObject({ status: 'failed', objectKey: null, steps: [] });
    expect(run.message).toMatch(/S3 target of the backups changed/);
    // … as does the restore test (it would test copies that are not the backups) and an upload of an audit archive
    await s.api('POST', '/backups/restore-test', {});
    expect((await waitIdle()).lastRestoreTest.message).toMatch(/S3 target of the backups changed/);
    const { uploadToBackupTarget } = await import('../src/backup/service.js');
    const file = path.join(tmp, 'archive.jsonl');
    fs.writeFileSync(file, '{}\n');
    await expect(uploadToBackupTarget(file, 'audit-archives', 'invented')).rejects.toMatchObject({ code: 'BACKUP_TARGET_CHANGED' });
    expect(mockS3Objects('invented-other-backups').size).toBe(0);
    const [failed] = await s.api('GET', '/audit?action=backup.failed&limit=1');
    expect(failed.details).toMatchObject({ kind: 'backup', code: 'BACKUP_TARGET_CHANGED' });
    let notes: any[] = [];
    for (let i = 0; i < 50 && !notes.some((n) => n.event === 'backup.failed' && n.body.includes('S3 target')); i++) {
      notes = (await s.api('GET', '/notifications')).items;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(notes.some((n) => n.event === 'backup.failed' && n.body.includes('S3 target'))).toBe(true);

    // confirming it again: with a step-up
    const fresh = await s.as(ADMIN.username, ADMIN.password, { autoStepUp: false });
    await fresh('DELETE', '/auth/step-up');
    const noStepUp = await fresh('POST', '/backups/confirm-target', {}).then(
      () => null,
      (e: { status: number; body: any }) => e,
    );
    expect(noStepUp).toMatchObject({ status: 403, body: { code: 'STEP_UP_REQUIRED' } });
    expect(await s.api('POST', '/backups/confirm-target', {})).toMatchObject({ targetChanged: false });
    const [confirmed] = await s.api('GET', '/audit?action=backup.target_confirmed&limit=1');
    expect(confirmed).toMatchObject({
      actor: 'admin',
      details: { platformId: storageId, baseUrl: `${mockBase}/s3/invented-other-backups`, prefix: 'prod/steward/', changed: true },
    });

    // back to the real bucket; saving the settings confirms the target too
    await s.api('PUT', `/platforms/${storageId}`, { baseUrl: platform.baseUrl, credentials: 'keep' });
    expect((await s.api('GET', '/backups')).targetChanged).toBe(true);
    const st = await s.api('PUT', '/backups/settings', (await s.api('GET', '/backups')).settings);
    expect(st.targetChanged).toBe(false);

    // an installation updated from before 0.17.1 has no confirmed target: the first run records the target as it is
    const stored = readSetting<unknown>('backup.target', null);
    writeSetting('backup.target', null);
    expect((await s.api('GET', '/backups')).targetChanged).toBe(false);
    await s.api('POST', '/backups/run', {});
    expect((await waitIdle()).lastBackup.status).toBe('succeeded');
    const [adopted] = await s.api('GET', '/audit?action=backup.target_confirmed&limit=1');
    expect(adopted.details).toMatchObject({ platformId: storageId, adopted: true });
    expect(readSetting<{ fingerprint: string } | null>('backup.target', null)?.fingerprint).toBe((stored as { fingerprint: string }).fingerprint);
  });

  it('records runs in the audit log', async () => {
    const entries = await s.api('GET', '/audit?entityType=backup&limit=200');
    const actions = entries.map((e: any) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['backup.key_set', 'backup.settings_updated', 'backup.created', 'backup.restore_tested']));
  });
});
