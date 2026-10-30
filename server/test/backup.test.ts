import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

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

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  mockBase = `${s.base.replace(/\/$/, '')}/mock`;
});
afterAll(async () => {
  await s?.app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
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

    await s.api('POST', '/backups/restore-test', {});
    const tested = (await waitIdle()).lastRestoreTest;
    expect(tested.status, JSON.stringify(tested.steps)).toBe('succeeded');
    // SQLite: integrity check and the audit chain of the snapshot; PostgreSQL: pg_restore reads the dump
    const pg = done.database === 'postgres';
    expect(tested.steps.map((x: any) => [x.name, x.ok])).toEqual([
      ['download', true],
      ['decrypt', true],
      ['manifest', true],
      ['checksums', true],
      ['database', true],
      ...(pg ? [] : [['audit', true]]),
    ]);
    expect(tested.steps.find((x: any) => x.name === 'database').message).toMatch(pg ? /pg_restore reads the dump/ : /integrity check: ok/);
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

  it('records runs in the audit log', async () => {
    const entries = await s.api('GET', '/audit?entityType=backup&limit=200');
    const actions = entries.map((e: any) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['backup.key_set', 'backup.settings_updated', 'backup.created', 'backup.restore_tested']));
  });
});
