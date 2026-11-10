import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BACKUP_OPTIONAL_PARTS, BACKUP_PARTS } from '@sm/shared';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * What a backup holds (0.16.0, docs/BACKUPS.md#contents): an administrator may leave out run artifacts, archived
 * reports and evidence packs – never the database, the vault, the audit anchor or the manifest. What was left out is in
 * the manifest, in the file's header (`steward backup info`), in the run's steps and in the restore test.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';

let s: TestServer;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-backup-contents-'));
const PASSPHRASE = 'contents passphrase of some length';

const refused = (method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> =>
  s.api(method, url, body).then(
    () => {
      throw new Error(`${method} ${url} was not refused`);
    },
    (e: { status: number; body: any }) => e,
  );

async function waitIdle(): Promise<any> {
  const { backupIdle } = await import('../src/backup/service.js');
  await backupIdle();
  return s.api('GET', '/backups');
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('the parts of a backup', () => {
  it('are classified by their place in the data folder', async () => {
    const { partOf } = await import('../src/backup/contents.js');
    expect(partOf('vault.json')).toBe('vault');
    expect(partOf('audit-anchor.json')).toBe('auditAnchor');
    expect(partOf('audit-archives/2026.zip')).toBe('auditArchives');
    expect(partOf('artifacts/run_1/shot.png')).toBe('artifacts');
    expect(partOf('reports/run_1/r.pdf')).toBe('reports');
    expect(partOf('evidence-packs/p.zip')).toBe('evidencePacks');
    expect(partOf('records/a/b.pdf')).toBe('records');
    expect(partOf('docs/x.pdf')).toBe('documents');
    expect(partOf('branding/logo.png')).toBe('branding');
    // a file named like a folder is not in it; anything else is "other"
    expect(partOf('artifacts')).toBe('other');
    expect(partOf('something-new/file')).toBe('other');
  });

  it('only optional parts can be left out – a required one is refused, never dropped', async () => {
    const { checkExclude } = await import('../src/backup/contents.js');
    expect(checkExclude(['reports', 'artifacts', 'reports'])).toEqual(['artifacts', 'reports']);
    for (const required of BACKUP_PARTS.filter((p) => !(BACKUP_OPTIONAL_PARTS as readonly string[]).includes(p)))
      expect(() => checkExclude([required]), required).toThrow(expect.objectContaining({ code: 'BACKUP_PART_REQUIRED' }));
    expect(() => checkExclude(['manifest'])).toThrow(expect.objectContaining({ code: 'BACKUP_PART_UNKNOWN' }));
    const settings = (await s.api('GET', '/backups')).settings;
    expect(settings.exclude).toEqual([]);
    for (const part of ['database', 'vault', 'auditAnchor']) {
      const r = await refused('PUT', '/backups/settings', { ...settings, exclude: [part] });
      expect(r.body.code, part).toBe('BACKUP_PART_REQUIRED');
    }
    expect((await refused('PUT', '/backups/settings', { ...settings, exclude: ['vault.json'] })).body.code).toBe('BACKUP_PART_UNKNOWN');
  });

  it('are listed with their size for administrators', async () => {
    fs.mkdirSync(path.join(s.dataDir, 'artifacts', 'run_contents'), { recursive: true });
    fs.writeFileSync(path.join(s.dataDir, 'artifacts', 'run_contents', 'screenshot.png'), Buffer.alloc(2048, 1));
    fs.mkdirSync(path.join(s.dataDir, 'reports', 'run_contents'), { recursive: true });
    fs.writeFileSync(path.join(s.dataDir, 'reports', 'run_contents', 'report.pdf'), Buffer.alloc(1000, 2));
    const c = await s.api('GET', '/backups/contents');
    expect(c.parts.map((p: any) => p.id)).toEqual([...BACKUP_PARTS]);
    const by = Object.fromEntries(c.parts.map((p: any) => [p.id, p]));
    expect(by.artifacts).toMatchObject({ path: 'artifacts/', required: false, excluded: false, files: 1, bytes: 2048 });
    expect(by.reports).toMatchObject({ required: false, files: 1, bytes: 1000 });
    expect(by.vault).toMatchObject({ path: 'vault.json', required: true, files: 1 });
    expect(by.database).toMatchObject({ required: true, files: 1 });
    expect(by.database.bytes).toBeGreaterThan(0);
    await s.api('POST', '/users', { username: 'otto', roles: ['operator'], password: 'Otto-password-123' });
    const otto = await s.as('otto', 'Otto-password-123');
    await expect(otto('GET', '/backups/contents')).rejects.toMatchObject({ status: 403 });
  });
});

describe('a backup that leaves parts out', () => {
  it('says so in its manifest, its header, its steps and the restore test', async () => {
    const p = await s.api('POST', '/platforms', {
      name: 'Contents bucket',
      kind: 'generic',
      baseUrl: `${s.base.replace(/\/$/, '')}/mock/s3/steward-contents`,
      config: { auth: { type: 'aws_sigv4', aws: { region: 'eu-central-1', service: 's3' } }, variables: {}, http: { proxy: 'none' } },
      secrets: { accessKeyId: 'AKIADEMOEXAMPLE', secretAccessKey: 'demoSecretKey' },
    });
    const st = await s.api('PUT', '/backups/passphrase', { passphrase: PASSPHRASE });
    const saved = await s.api('PUT', '/backups/settings', { ...st.settings, platformId: p.id, exclude: ['reports', 'artifacts'] });
    expect(saved.settings.exclude).toEqual(['artifacts', 'reports']);
    // a client from before 0.16.0 sends no "exclude": what is set stays
    const { exclude: _x, ...old } = saved.settings;
    expect((await s.api('PUT', '/backups/settings', old)).settings.exclude).toEqual(['artifacts', 'reports']);
    const [a] = await s.api('GET', '/audit?action=backup.settings_updated&limit=1');
    expect(a.summary).toContain('leaving out artifacts, reports');
    expect((await s.api('GET', '/backups/contents')).parts.filter((x: any) => x.excluded).map((x: any) => x.id)).toEqual(['artifacts', 'reports']);

    await s.api('POST', '/backups/run', {});
    const run = (await waitIdle()).lastBackup;
    expect(run.status, JSON.stringify(run.steps)).toBe('succeeded');
    expect(run.steps.map((x: any) => x.name)).toEqual(['archive', 'contents', 'encrypt', 'upload', 'retention']);
    expect(run.steps[1].message).toBe('Left out by the backup settings: artifacts/ (1 files, 2048 bytes), reports/ (1 files, 1000 bytes)');

    const { mockS3Objects } = await import('../src/mock/mockS3.js');
    const file = path.join(tmp, 'b.smbackup');
    fs.writeFileSync(file, mockS3Objects('steward-contents').get(run.objectKey)!.body);
    const { readHeader } = await import('../src/backup/crypto.js');
    expect((await readHeader(file)).header.info).toMatchObject({ excluded: 'artifacts/,reports/' });
    const { runBackupCli } = await import('../src/cli/backup.js');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await runBackupCli(['info', file], 'backup')).toBe(0);
      expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('Left out by the backup settings (a restore lacks them): artifacts/, reports/');
    } finally {
      log.mockRestore();
    }
    const pf = path.join(tmp, 'pass.txt');
    fs.writeFileSync(pf, `${PASSPHRASE}\n`);
    const zip = path.join(tmp, 'b.zip');
    expect(await runBackupCli(['decrypt', file, '--out', zip, '--passphrase-file', pf], 'backup')).toBe(0);
    const { ZipReader } = await import('../src/compliance/zip.js');
    const z = await ZipReader.open(zip, { zip64: true });
    const names = z.entries.map((e) => e.name);
    expect(names).toContain('data/vault.json');
    expect(names).toContain('manifest.json');
    expect(names.some((n) => n.startsWith('database/'))).toBe(true);
    expect(names.some((n) => n.startsWith('data/artifacts/') || n.startsWith('data/reports/'))).toBe(false);
    const manifest = JSON.parse((await z.read(z.find('manifest.json')!)).toString('utf8'));
    expect(manifest.excluded).toEqual([
      { part: 'artifacts', path: 'artifacts/', files: 1, bytes: 2048 },
      { part: 'reports', path: 'reports/', files: 1, bytes: 1000 },
    ]);

    // the restore test passes – and says what a restore from this backup lacks
    const pg = (await s.api('GET', '/backups')).database === 'postgres';
    await s.api('POST', '/backups/restore-test', {});
    const tested = (await waitIdle()).lastRestoreTest;
    expect(tested.status, JSON.stringify(tested.steps)).toBe('succeeded');
    expect(tested.steps.map((x: any) => x.name)).toEqual(
      ['download', 'decrypt', 'manifest', 'checksums', 'contents', 'database', 'audit'].filter((n) => !pg || n !== 'audit'),
    );
    expect(tested.steps.find((x: any) => x.name === 'contents').message).toMatch(
      /a restore from this backup lacks them: artifacts\/ \(1 files, 2048 bytes\), reports\//,
    );

    // all parts again: nothing left out, no contents step
    await s.api('PUT', '/backups/settings', { ...saved.settings, exclude: [] });
    await s.api('POST', '/backups/run', {});
    const full = (await waitIdle()).lastBackup;
    expect(full.steps.map((x: any) => x.name)).toEqual(['archive', 'encrypt', 'upload', 'retention']);
  });
});
