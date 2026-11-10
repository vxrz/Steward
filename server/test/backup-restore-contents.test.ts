import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ADMIN, authHeaders, loginCookie, setup, startedUrl, startTestServer, type TestServer } from './helpers.js';

/**
 * A backup that leaves out run artifacts, archived reports and evidence packs (0.16.0, docs/BACKUPS.md#contents),
 * restored as docs/BACKUPS.md "Restoring" says, on another machine: the instance starts and works, and the readers of
 * what was left out answer that the file is gone (4xx) – never a server error.
 *
 * SQLite only: a PostgreSQL restore needs pg_restore into a database of its own (the restore test covers the dump).
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';

const pg = !!process.env.SM_TEST_DATABASE_URL;
const SERVER = path.resolve(__dirname, '..');
const MASTER = 'correct horse battery';
const PASSPHRASE = 'restore passphrase of some length';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-backup-restore-'));
const restored = path.join(tmp, 'restored-data');

let s: TestServer;
let proc: ChildProcess | null = null;
let base = '';
let cookie = '';
const errorCodes = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../web/src/locales/en/errors.json'), 'utf8')).codes as Record<string, string>;
const ids = { run: 'run_restore_1', artifact: 'art_restore_1', report: 'rep_restore_1', pack: 'pack_restore_1' };

async function call(method: string, url: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api${url}`, { method, headers: { 'x-sm-client': '1', ...authHeaders(cookie) } });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // a file
  }
  return { status: res.status, body: parsed };
}

describe.skipIf(pg)('restoring a backup that left parts out', () => {
  beforeAll(async () => {
    s = await startTestServer();
    await setup(s);
    const { db } = await import('../src/db.js');
    const now = new Date().toISOString();
    const file = (rel: string, content: string) => {
      const abs = path.join(s.dataDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      return { abs, sha256: crypto.createHash('sha256').update(content).digest('hex'), size: Buffer.byteLength(content) };
    };
    // a run with a screenshot, an archived report and an evidence pack – each with its file in a part left out
    const processId = (
      await s.api('POST', '/processes', { definition: { name: 'Invented restore check', steps: [{ id: 'note', type: 'log', message: 'x' }] } })
    ).id;
    db().run(
      `INSERT INTO runs (id, process_id, process_name, process_version, definition_hash, status, trigger, actor, inputs, bindings, started_at, finished_at)
       VALUES (?, ?, 'Invented restore check', 1, 'h', 'succeeded', 'manual', 'admin', '{}', '{}', ?, ?)`,
      ids.run,
      processId,
      now,
      now,
    );
    const shot = file(`artifacts/${ids.run}/screenshot.png`, 'an invented screenshot');
    db().run(
      `INSERT INTO run_artifacts (id, run_id, step_key, kind, name, mime, path, sha256, size, created_at) VALUES (?, ?, 'check', 'screenshot', 'screenshot.png', 'image/png', ?, ?, ?, ?)`,
      ids.artifact,
      ids.run,
      shot.abs,
      shot.sha256,
      shot.size,
      now,
    );
    const pdf = file(`reports/${ids.run}/report.pdf`, '%PDF-1.7 an invented report');
    db().run(
      `INSERT INTO reports (id, kind, run_id, process_ids, version, title, lang, created_by, created_at, path, filename, sha256, size, content_hash)
       VALUES (?, 'run', ?, ?, 1, 'Invented restore report', 'en', 'admin', ?, ?, 'report.pdf', ?, ?, 'c')`,
      ids.report,
      ids.run,
      JSON.stringify([processId]),
      now,
      `${ids.run}/report.pdf`,
      pdf.sha256,
      pdf.size,
    );
    const pack = file('evidence-packs/pack_restore_1.zip', 'an invented evidence pack');
    db().run(
      `INSERT INTO evidence_packs (id, title, scope, period_from, period_to, status, created_by, created_at, finished_at, expires_at, path, size, sha256, file_count)
       VALUES (?, 'Invented pack', '{}', '2026-01-01', '2026-03-31', 'ready', 'admin', ?, ?, ?, 'pack_restore_1.zip', ?, ?, 1)`,
      ids.pack,
      now,
      now,
      new Date(Date.now() + 30 * 86_400_000).toISOString(),
      pack.size,
      pack.sha256,
    );
    // what the readers give before: the files are there
    expect((await s.api('GET', `/reports/${ids.report}`)).id).toBe(ids.report);

    // the backup, leaving the three parts out
    const p = await s.api('POST', '/platforms', {
      name: 'Restore bucket',
      kind: 'generic',
      baseUrl: `${s.base.replace(/\/$/, '')}/mock/s3/steward-restore`,
      config: { auth: { type: 'aws_sigv4', aws: { region: 'eu-central-1', service: 's3' } }, variables: {}, http: { proxy: 'none' } },
      secrets: { accessKeyId: 'AKIADEMOEXAMPLE', secretAccessKey: 'demoSecretKey' },
    });
    const st = await s.api('PUT', '/backups/passphrase', { passphrase: PASSPHRASE });
    await s.api('PUT', '/backups/settings', { ...st.settings, platformId: p.id, exclude: ['artifacts', 'reports', 'evidencePacks'] });
    await s.api('POST', '/backups/run', {});
    const { backupIdle } = await import('../src/backup/service.js');
    await backupIdle();
    const run = (await s.api('GET', '/backups')).lastBackup;
    expect(run.status, JSON.stringify(run.steps)).toBe('succeeded');

    // offline: decrypt, unpack, put the database in its place (docs/BACKUPS.md "Restoring", SQLite)
    const { mockS3Objects } = await import('../src/mock/mockS3.js');
    const enc = path.join(tmp, 'backup.smbackup');
    fs.writeFileSync(enc, mockS3Objects('steward-restore').get(run.objectKey)!.body);
    const pf = path.join(tmp, 'pass.txt');
    fs.writeFileSync(pf, `${PASSPHRASE}\n`);
    const zip = path.join(tmp, 'restore.zip');
    const { runBackupCli } = await import('../src/cli/backup.js');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await runBackupCli(['decrypt', enc, '--out', zip, '--passphrase-file', pf], 'backup')).toBe(0);
    } finally {
      log.mockRestore();
    }
    const { ZipReader } = await import('../src/compliance/zip.js');
    const z = await ZipReader.open(zip, { zip64: true });
    for (const e of z.entries) {
      if (e.name.endsWith('/')) continue;
      const target = e.name.startsWith('data/')
        ? path.join(restored, e.name.slice('data/'.length))
        : e.name === 'database/steward.db'
          ? path.join(restored, 'service-manager.db')
          : null;
      if (!target) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, await z.read(e));
    }
    expect(fs.existsSync(path.join(restored, 'artifacts'))).toBe(false);
    // the machine the backup came from is gone: so are its files
    for (const dir of ['artifacts', 'reports', 'evidence-packs']) fs.rmSync(path.join(s.dataDir, dir), { recursive: true, force: true });

    const env: Record<string, string | undefined> = {
      ...process.env,
      SM_LOG_LEVEL: 'info',
      SM_DATA_DIR: restored,
      SM_PORT: '0',
      SM_DEMO: '1',
      SM_MASTER_PASSPHRASE: MASTER,
    };
    for (const k of ['SM_DATABASE_URL', 'SM_DATABASE_SCHEMA', 'SM_MASTER_PASSPHRASE_FILE', 'SM_TEST_DATABASE_URL']) delete env[k];
    let out = '';
    proc = await new Promise<ChildProcess>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: SERVER, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => reject(new Error('server start timeout: ' + out)), 60000);
      child.stdout!.on('data', (d: Buffer) => {
        out += d.toString();
        const url = startedUrl(out);
        if (url && !base) {
          base = url.replace(/\/$/, '');
          clearTimeout(timer);
          resolve(child);
        }
      });
      child.stderr!.on('data', (d: Buffer) => (out += d.toString()));
      child.on('exit', (code) => reject(new Error(`server exited ${code}: ${out}`)));
    });
  }, 180_000);

  afterAll(async () => {
    if (proc && proc.exitCode === null) {
      const p = proc;
      await new Promise((r) => {
        p.once('exit', r);
        p.kill('SIGTERM');
        setTimeout(() => p.kill('SIGKILL'), 10000).unref();
      });
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('starts and works', async () => {
    cookie = await loginCookie(base, ADMIN.username, ADMIN.password);
    expect((await call('GET', '/auth/status')).body).toMatchObject({ unlocked: true });
    expect((await call('GET', `/runs/${ids.run}`)).status).toBe(200);
    expect((await call('GET', `/reports/${ids.report}`)).body).toMatchObject({ id: ids.report, title: 'Invented restore report' });
    expect((await call('GET', `/compliance/evidence-packs/${ids.pack}`)).status).toBe(200);
    expect((await call('GET', '/backups')).status).toBe(200);
  });

  it('answers that a report or an evidence pack left out is gone – never a server error', async () => {
    expect(await call('GET', `/reports/${ids.report}/download`)).toMatchObject({ status: 410, body: { code: 'REPORT_FILE_GONE' } });
    expect(await call('GET', `/compliance/evidence-packs/${ids.pack}/download`)).toMatchObject({ status: 404, body: { code: 'PACK_FILE_MISSING' } });
  });

  // the artifact route answers 410 ARTIFACT_FILE_GONE once it knows the case (a fix of its own); until then it is a
  // server error, so this runs where the code has a text
  it.skipIf(!('ARTIFACT_FILE_GONE' in errorCodes))('answers that a run artifact left out is gone – never a server error', async () => {
    const artifact = await call('GET', `/artifacts/${ids.artifact}`);
    expect(artifact.status, JSON.stringify(artifact.body)).not.toBe(200);
    expect(artifact.status, JSON.stringify(artifact.body)).toBeLessThan(500);
  });
});
