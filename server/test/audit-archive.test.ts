import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, loginCookie, setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Growth of the audit log (0.4.0, audit-archive.ts): incremental verification from the newest signed checkpoint and the
 * full one (also in the background), archives of closed epochs (signed, verified offline, uploaded encrypted to the
 * backup target), the retention that deletes archived entries while the chain still verifies, the attacks on it, and
 * an evidence pack over an archived period.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';

let s: TestServer;
const DAY = 86_400_000;
/** "Now" for the archiving: the next month, so this month's epochs are closed */
const LATER = Date.now() + 40 * DAY;
const PASSPHRASE = 'correct horse battery staple 42';

const db = async () => (await import('../src/db.js')).db();
const refused = (p: Promise<unknown>): Promise<{ status: number; body: any }> =>
  p.then(
    () => {
      throw new Error('not refused');
    },
    (e: { status: number; body: any }) => e,
  );
async function add(n: number, action = 'test.entry'): Promise<void> {
  const { audit } = await import('../src/audit.js');
  for (let i = 0; i < n; i++) audit({ action, entityType: 'test', summary: `test entry ${i}` });
}
const maxSeq = async () => Number((await db()).get<{ m: number }>('SELECT MAX(seq) AS m FROM audit_log')!.m);
const archiveDir = () => path.join(s.dataDir, 'audit-archives');
let pem = '';
let pemFile = '';

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  pem = (await s.api('GET', '/audit/anchoring')).publicKeyPem;
  pemFile = path.join(s.dataDir, 'public-key.pem');
  fs.writeFileSync(pemFile, pem);
});

describe('incremental and full verification', () => {
  it('checks the entries after the newest signed checkpoint, and finds a change after it', async () => {
    await add(20);
    const cp = await s.api('POST', '/audit/checkpoint');
    await add(5);
    const r = await s.api('GET', '/audit/verify');
    expect(r).toMatchObject({ ok: true, mode: 'incremental', fromSeq: cp.seq });
    // it checked the 5 entries after the checkpoint and whatever background work (demo feeders, jobs) wrote until
    // it ran, but nothing up to the checkpoint and not its own entry, which is written after the check
    const verified = Number((await db()).get<{ m: number }>("SELECT MAX(seq) AS m FROM audit_log WHERE action = 'audit.verified' AND seq > ?", cp.seq)!.m);
    expect(r.checked).toBeGreaterThanOrEqual(5);
    expect(r.checked).toBeLessThanOrEqual(verified - cp.seq - 1);
    expect(r.message).toMatch(new RegExp(`checked from the signed checkpoint at entry #${cp.seq}`));
    // (that verification signed a checkpoint: change an entry after it)
    await add(3);
    const target = (await maxSeq()) - 1;
    const d = await db();
    const before = d.get<{ summary: string }>('SELECT summary FROM audit_log WHERE seq = ?', target)!.summary;
    d.run("UPDATE audit_log SET summary = 'tampered' WHERE seq = ?", target);
    try {
      const bad = await s.api('GET', '/audit/verify');
      expect(bad).toMatchObject({ ok: false, mode: 'incremental', firstBadSeq: target });
    } finally {
      d.run('UPDATE audit_log SET summary = ? WHERE seq = ?', before, target);
    }
    expect((await s.api('GET', '/audit/verify')).ok).toBe(true);
  });

  it('a change before the checkpoint is found by the full verification, which stays on until it passes', async () => {
    await s.api('POST', '/audit/checkpoint');
    const d = await db();
    const before = d.get<{ summary: string }>('SELECT summary FROM audit_log WHERE seq = 3')!.summary;
    d.run("UPDATE audit_log SET summary = 'tampered' WHERE seq = 3");
    try {
      // incremental: starts after the checkpoint and does not see it
      expect(await s.api('GET', '/audit/verify')).toMatchObject({ ok: true, mode: 'incremental' });
      const full = await s.api('GET', '/audit/verify?full=true');
      expect(full).toMatchObject({ ok: false, mode: 'full', firstBadSeq: 3 });
      // until a full verification passes, every verification is a full one, and no checkpoint is signed
      expect(await s.api('GET', '/audit/verify')).toMatchObject({ ok: false, mode: 'full', firstBadSeq: 3 });
      expect((await refused(s.api('POST', '/audit/checkpoint'))).status).toBe(409);
      const { token } = await s.api('POST', '/me/tokens', { name: 'verify', scope: 'read' });
      const v1 = await fetch(`${s.base}/api/v1/audit/verify`, { headers: { authorization: `Bearer ${token}` } });
      expect(await v1.json()).toMatchObject({ ok: false, mode: 'full', firstBadSeq: 3 });
    } finally {
      d.run('UPDATE audit_log SET summary = ? WHERE seq = 3', before);
    }
    expect(await s.api('GET', '/audit/verify')).toMatchObject({ ok: true, mode: 'full' });
    expect(await s.api('GET', '/audit/verify')).toMatchObject({ ok: true, mode: 'incremental' });
  });

  it('runs a full verification in the background with progress, by administrators', async () => {
    const audrey = await s.as('audrey', 'Demo-password-1');
    expect((await refused(audrey('POST', '/audit/verify/full'))).status).toBe(403);
    const started = await s.api('POST', '/audit/verify/full');
    expect(started.verification.running).toMatchObject({ by: 'admin' });
    const { runningFullVerification } = await import('../src/audit-archive.js');
    const r = await runningFullVerification();
    expect(r).toMatchObject({ ok: true, mode: 'full' });
    const st = await audrey('GET', '/audit/archive');
    expect(st.verification.running).toBeNull();
    expect(st.verification.full).toMatchObject({ ok: true, mode: 'full', by: 'admin', fromSeq: 1 });
    expect(st.verification.full.checked).toBeGreaterThan(30);
    expect(st.verification.incremental).toMatchObject({ ok: true, mode: 'incremental' });
    const [entry] = await s.api('GET', '/audit?action=audit.verified&limit=1');
    expect(entry.summary).toMatch(/^Audit chain verified in full: All \d+ entries are intact/);
    // the progress callback reaches the total
    const { verifyWithAnchors } = await import('../src/audit-anchor.js');
    const seen: [number, number][] = [];
    await verifyWithAnchors([], { mode: 'full', onProgress: (c, t) => seen.push([c, t]) });
    expect(seen.at(-1)![0]).toBe(seen.at(-1)![1]);
  });
});

describe('archives of closed epochs', () => {
  let first: any;
  let second: any;
  let keptSeq = 0;

  it('only administrators change the settings; retention and upload need archiving (and backups)', async () => {
    const audrey = await s.as('audrey', 'Demo-password-1');
    expect((await refused(audrey('PUT', '/audit/archive', { archive: true, upload: false, retentionDays: 0 }))).status).toBe(403);
    expect((await refused(s.api('PUT', '/audit/archive', { archive: false, upload: false, retentionDays: 365 }))).body.code).toBe('AUDIT_ARCHIVE_OFF');
    expect((await refused(s.api('PUT', '/audit/archive', { archive: true, upload: false, retentionDays: 5 }))).body.code).toBe('AUDIT_RETENTION_SHORT');
    expect((await refused(s.api('PUT', '/audit/archive', { archive: true, upload: true, retentionDays: 0 }))).body.code).toBe('AUDIT_UPLOAD_UNAVAILABLE');
    const st = await s.api('PUT', '/audit/archive', { archive: true, upload: false, retentionDays: 0 });
    expect(st.settings).toEqual({ archive: true, upload: false, retentionDays: 0 });
    const [e] = await s.api('GET', '/audit?action=audit.archive_settings_updated&limit=1');
    expect(e.summary).toMatch(/closed epochs are archived; entries are never deleted/);
  });

  it('writes a signed archive per closed month that verifies offline, and nothing for the open month', async () => {
    const { runArchiving } = await import('../src/audit-archive.js');
    expect((await runArchiving()).archived).toEqual([]);
    // evidence other content relies on (kept when the archived entries are deleted), and more than a delete batch
    const { audit } = await import('../src/audit.js');
    keptSeq = audit({ action: 'record.approved', entityType: 'record', entityId: 'rec_kept', summary: 'Approved (kept)' }).seq;
    await add(1200);
    const cp = await s.api('POST', '/audit/checkpoint');
    const r = await runArchiving({ now: LATER });
    expect(r.problems).toEqual([]);
    expect(r.archived).toHaveLength(1);
    first = r.archived[0];
    expect(first).toMatchObject({ firstSeq: 1, lastSeq: cp.seq, entries: cp.seq, fileMissing: false, prunedAt: null });
    expect(first.epochs).toBeGreaterThanOrEqual(3);
    expect(first.file).toMatch(/^steward-audit-\d{4}-\d{2}-000000001-\d{9}\.zip$/);
    const file = path.join(archiveDir(), first.file);
    expect(fs.existsSync(file)).toBe(true);

    const { verifyArchive } = await import('../src/audit-archive-verify.js');
    const v = await verifyArchive(file, { publicKey: pem });
    expect(v.problems).toEqual([]);
    expect(v).toMatchObject({ ok: true, trusted: true, trust: 'public-key', entries: cp.seq, signatureOk: true });
    expect(v.checkpoints.ok).toBe(v.checkpoints.count);
    expect(v.checkpoints.count).toBe(first.epochs);
    // the CLI: trusted key, the key in the archive (untrusted), a wrong fingerprint
    const { runAuditArchiveVerify, EXIT_UNTRUSTED } = await import('../src/cli/audit-archive-verify.js');
    expect(await runAuditArchiveVerify([file, '--public-key', pemFile, '--quiet'], 'test')).toBe(0);
    expect(await runAuditArchiveVerify([file, '--quiet'], 'test')).toBe(EXIT_UNTRUSTED);
    expect(await runAuditArchiveVerify([file, '--fingerprint', v.publicKey!.fingerprint, '--quiet'], 'test')).toBe(0);
    expect(await runAuditArchiveVerify([file, '--fingerprint', '00:11', '--quiet'], 'test')).toBe(1);
    expect(await runAuditArchiveVerify([path.join(archiveDir(), 'nope.zip')], 'test')).toBe(2);

    const [entry] = await s.api('GET', '/audit?action=audit.archived&limit=1');
    expect(entry).toMatchObject({ entityType: 'audit_archive', entityId: first.id });
    expect(entry.details).toMatchObject({ sha256: first.sha256, firstSeq: 1, lastSeq: cp.seq });
  });

  it('detects a changed archive: bytes, an entry with a recomputed file hash, a forged signature', async () => {
    const { verifyArchive } = await import('../src/audit-archive-verify.js');
    const { ZipReader, ZipWriter } = await import('../src/compliance/zip.js');
    const file = path.join(archiveDir(), first.file);
    const tmp = fs.mkdtempSync(path.join(s.dataDir, 'tamper-'));
    // a flipped byte
    const bytes = fs.readFileSync(file);
    bytes[200] = bytes[200]! ^ 0xff;
    fs.writeFileSync(path.join(tmp, 'flipped.zip'), bytes);
    expect((await verifyArchive(path.join(tmp, 'flipped.zip'), { publicKey: pem })).ok).toBe(false);
    // an entry changed and the manifest updated to match (the signature no longer does, the checkpoints neither)
    const zip = await ZipReader.open(file);
    const read = async (n: string) => (await zip.read(zip.find(n)!, 512 * 1024 * 1024)).toString('utf8');
    const lines = (await read('entries.jsonl')).split('\n');
    lines[4] = JSON.stringify({ ...JSON.parse(lines[4]!), summary: 'forged' });
    const crypto = await import('node:crypto');
    const forged = Buffer.from(lines.join('\n'));
    const manifest = JSON.parse(await read('manifest.json'));
    manifest.files.find((f: any) => f.path === 'entries.jsonl').sha256 = crypto.createHash('sha256').update(forged).digest('hex');
    manifest.files.find((f: any) => f.path === 'entries.jsonl').size = forged.length;
    const write = async (name: string, sig: string, key: string) => {
      const w = await ZipWriter.create(path.join(tmp, name));
      await w.add('entries.jsonl', forged, { compress: true });
      await w.add('checkpoints.json', Buffer.from(await read('checkpoints.json')));
      const mb = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
      await w.add('manifest.json', mb);
      await w.add(
        'manifest.sig',
        Buffer.from(
          sig === 'resign' ? crypto.sign(null, Buffer.concat([Buffer.from('steward-audit-archive-v1\n'), mb]), otherKey.privateKey).toString('base64') : sig,
        ),
      );
      await w.add('public-key.pem', Buffer.from(key));
      await w.finish();
      return path.join(tmp, name);
    };
    const otherKey = crypto.generateKeyPairSync('ed25519');
    const otherPem = otherKey.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const a = await verifyArchive(await write('changed.zip', await read('manifest.sig'), pem), { publicKey: pem });
    expect(a.ok).toBe(false);
    expect(a.problems).toEqual(expect.arrayContaining([expect.stringMatching(/manifest signature is invalid/), expect.stringMatching(/differ from what/)]));
    // re-signed with a key of the attacker's own, accepted as the archive's key: the checkpoints still give it away
    const b = await verifyArchive(await write('resigned.zip', 'resign', otherPem), { trustPackKey: true });
    expect(b.signatureOk).toBe(true);
    expect(b.ok).toBe(false);
    expect(b.problems).toEqual(expect.arrayContaining([expect.stringMatching(/end checkpoint #\d+ has an invalid signature/)]));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('continues with the next archive, which links to the first; uploads encrypted to the backup target', async () => {
    // the backup target (mock S3) and the passphrase
    const p = await s.api('POST', '/platforms', {
      name: 'Backup bucket',
      kind: 'generic',
      baseUrl: `${s.base.replace(/\/$/, '')}/mock/s3/steward-backups`,
      config: { auth: { type: 'aws_sigv4', aws: { region: 'eu-central-1', service: 's3' } }, variables: {}, http: { proxy: 'none' } },
      secrets: { accessKeyId: 'AKIADEMOEXAMPLE', secretAccessKey: 'demoSecretKey' },
    });
    const st = await s.api('PUT', '/backups/passphrase', { passphrase: PASSPHRASE });
    await s.api('PUT', '/backups/settings', { ...st.settings, platformId: p.id, prefix: 'prod/' });
    await s.api('PUT', '/audit/archive', { archive: true, upload: true, retentionDays: 0 });

    await add(10);
    const cp = await s.api('POST', '/audit/checkpoint');
    const { runArchiving } = await import('../src/audit-archive.js');
    const r = await runArchiving({ now: LATER });
    expect(r.problems).toEqual([]);
    expect(r.archived).toHaveLength(1);
    second = r.archived[0];
    expect(second).toMatchObject({ firstSeq: first.lastSeq + 1, lastSeq: cp.seq });
    expect(r.uploaded).toBe(2); // the first one too

    const { verifyArchive, continuityProblems } = await import('../src/audit-archive-verify.js');
    const files = [first, second].map((a) => path.join(archiveDir(), a.file));
    const results = await Promise.all(files.map((f) => verifyArchive(f, { publicKey: pem })));
    expect(results.map((x) => x.problems)).toEqual([[], []]);
    expect(continuityProblems(results)).toEqual([]);
    const { runAuditArchiveVerify } = await import('../src/cli/audit-archive-verify.js');
    expect(await runAuditArchiveVerify([...files, '--public-key', pemFile, '--quiet'], 'test')).toBe(0);
    // the uploaded copy is the archive, encrypted with the backup key
    const { mockS3Objects } = await import('../src/mock/mockS3.js');
    const key = `prod/audit-archives/${second.file}.smbackup`;
    const obj = mockS3Objects().get(key)!;
    expect(obj.body.subarray(0, 17).toString()).toBe('STEWARD-BACKUP-1\n');
    const enc = path.join(s.dataDir, 'downloaded.smbackup');
    fs.writeFileSync(enc, obj.body);
    const { decryptFile, deriveBackupKey, readHeader } = await import('../src/backup/crypto.js');
    const { header } = await readHeader(enc);
    await decryptFile(enc, path.join(s.dataDir, 'downloaded.zip'), await deriveBackupKey(PASSPHRASE, header.kdf));
    expect(fs.readFileSync(path.join(s.dataDir, 'downloaded.zip')).equals(fs.readFileSync(files[1]!))).toBe(true);
    const status = await s.api('GET', '/audit/archive');
    expect(status.archives.map((a: any) => a.remoteKey)).toEqual([key, `prod/audit-archives/${first.file}.smbackup`]);
    expect(status).toMatchObject({ canUpload: true, archivedThrough: { seq: cp.seq }, deletedThrough: null });
    expect(status.epochs.archived).toBe(first.epochs + second.epochs);
    expect(await s.api('GET', '/audit?action=audit.archive_uploaded&limit=10')).toHaveLength(2);
    // download for auditors (audited)
    const dl = await s.api('GET', `/audit/archives/${second.id}/file`);
    expect(dl.length).toBeGreaterThan(100);
    expect(await s.api('GET', '/audit?action=audit.archive_downloaded&limit=1')).toHaveLength(1);
  });

  it('retention deletes the archived entries in batches; the chain still verifies and evidence entries stay authentic', async () => {
    await s.api('PUT', '/audit/archive', { archive: true, upload: true, retentionDays: 30 });
    const { runArchiving } = await import('../src/audit-archive.js');
    const r = await runArchiving({ now: LATER });
    expect(r.problems).toEqual([]);
    expect(r.deleted).toBeGreaterThan(1200);
    const d = await db();
    // only the entries other evidence relies on stay in the deleted range
    const left = d.all<{ seq: number; action: string; entity_type: string }>('SELECT seq, action, entity_type FROM audit_log WHERE seq <= ?', second.lastSeq);
    expect(left.length).toBeGreaterThan(0);
    expect(
      left.every(
        (x) =>
          x.entity_type === 'record' ||
          ['audit.checkpoint', 'run.succeeded', 'run.failed', 'run.cancelled', 'report.generated'].includes(x.action) ||
          x.entity_type.startsWith('access_'),
      ),
    ).toBe(true);
    expect(left.map((x) => Number(x.seq))).toContain(keptSeq);
    const status = await s.api('GET', '/audit/archive');
    expect(status.deletedThrough.seq).toBe(second.lastSeq);
    expect(status.archives.every((a: any) => a.prunedAt && !a.pruning)).toBe(true);
    expect(status.entriesInDatabase).toBe(Number(d.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log')!.n));
    const started = await s.api('GET', '/audit?action=audit.entries_delete_started&limit=10');
    expect(started.map((e: any) => e.details.throughSeq)).toEqual([second.lastSeq, first.lastSeq]);
    expect(await s.api('GET', '/audit?action=audit.entries_deleted&limit=10')).toHaveLength(2);

    expect(await s.api('GET', '/audit/verify')).toMatchObject({ ok: true, mode: 'incremental', deletedThroughSeq: second.lastSeq });
    const full = await s.api('GET', '/audit/verify?full=true');
    expect(full).toMatchObject({ ok: true, mode: 'full', deletedThroughSeq: second.lastSeq });
    expect(full.message).toMatch(new RegExp(`entries #1–#${second.lastSeq} were archived and deleted`));
    // the entries kept in the deleted range are authentic (the record's approval, the checkpoints)
    const { authenticRows, verifyAudit, resetAuditMemory } = await import('../src/audit.js');
    expect(authenticRows("entity_type = 'record' AND entity_id = ?", ['rec_kept'])).toMatchObject({
      rows: [expect.objectContaining({ seq: keptSeq })],
      rejected: 0,
    });
    expect(authenticRows("action = 'audit.checkpoint'", [], { limit: 1000 }).rejected).toBe(0);
    // a copy of the database (a backup's snapshot) verifies the same way
    expect(verifyAudit({ source: d }).ok).toBe(true);

    // the export continues the signed checkpoint and verifies offline
    const bundle = await s.api('GET', '/audit/export?format=json');
    expect(bundle.startCheckpoint.seq).toBe(second.lastSeq);
    expect(bundle.entries[0].seq).toBe(second.lastSeq + 1);
    const { verifyExport } = await import('../src/cli/audit-verify-export.js');
    const x = verifyExport({
      entries: bundle.entries,
      checkpoints: [{ source: 'export', cp: bundle.checkpoint }],
      publicKey: pem,
      keySource: 'option',
      startCheckpoint: bundle.startCheckpoint,
    });
    expect(x.problems).toEqual([]);
    // moving an instance needs the whole log
    const mig = await refused(s.api('POST', '/migration/export', { passphrase: 'correct horse battery', transferPassphrase: 'a transfer passphrase 123' }));
    expect(mig.body.code).toBe('MIGRATION_AUDIT_DELETED');
    resetAuditMemory();
  });

  it('detects a changed kept entry, a hidden archive record and a deletion without its record', async () => {
    const d = await db();
    const { resetAuditMemory } = await import('../src/audit.js');
    const full = () => s.api('GET', '/audit/verify?full=true');
    // a kept entry in the deleted range was changed
    d.run("UPDATE audit_log SET summary = 'changed' WHERE seq = ?", keptSeq);
    expect(await full()).toMatchObject({ ok: false, firstBadSeq: keptSeq });
    d.run("UPDATE audit_log SET summary = 'Approved (kept)' WHERE seq = ?", keptSeq);
    expect((await full()).ok).toBe(true);

    // the archive records removed: the database no longer starts at #1
    const rows = d.all<Record<string, unknown>>('SELECT * FROM audit_archives');
    d.run('DELETE FROM audit_archives');
    resetAuditMemory();
    try {
      const r = await full();
      expect(r.ok).toBe(false);
    } finally {
      for (const row of rows) {
        const cols = Object.keys(row);
        d.run(`INSERT INTO audit_archives (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...Object.values(row));
      }
      resetAuditMemory();
    }
    expect((await full()).ok).toBe(true);

    // the signed checkpoint of the newest deleted archive was changed
    const newest = rows.sort((a, b) => Number(b.last_seq) - Number(a.last_seq))[0]!;
    const cp = JSON.parse(String(newest.checkpoint));
    d.run('UPDATE audit_archives SET checkpoint = ? WHERE id = ?', JSON.stringify({ ...cp, digest: 'f'.repeat(64) }), newest.id);
    resetAuditMemory();
    expect((await full()).message).toMatch(/no valid signed checkpoint/);
    d.run('UPDATE audit_archives SET checkpoint = ? WHERE id = ?', newest.checkpoint, newest.id);
    resetAuditMemory();

    // an attacker deletes the entries of a newer archive and marks it as deleted – without the record in the chain
    await s.api('PUT', '/audit/archive', { archive: true, upload: false, retentionDays: 0 });
    await add(30);
    await s.api('POST', '/audit/checkpoint');
    const { runArchiving } = await import('../src/audit-archive.js');
    const [third] = (await runArchiving({ now: LATER })).archived;
    expect(third).toBeTruthy();
    const saved = d.all<Record<string, unknown>>('SELECT * FROM audit_log WHERE seq >= ? AND seq <= ?', third!.firstSeq, third!.lastSeq);
    d.run('UPDATE audit_archives SET prune_started_at = ?, pruned_at = ? WHERE id = ?', new Date().toISOString(), new Date().toISOString(), third!.id);
    d.run('DELETE FROM audit_log WHERE seq >= ? AND seq <= ?', third!.firstSeq, third!.lastSeq);
    resetAuditMemory();
    try {
      const r = await full();
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/no authentic record of that deletion/);
    } finally {
      for (const row of saved) {
        const cols = Object.keys(row);
        d.run(`INSERT INTO audit_log (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...Object.values(row));
      }
      d.run('UPDATE audit_archives SET prune_started_at = NULL, pruned_at = NULL WHERE id = ?', third!.id);
      resetAuditMemory();
    }
    expect((await full()).ok).toBe(true);
  });

  it('an evidence pack over an archived period carries the archives and verifies offline', async () => {
    const hub = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'insights-hub').id;
    const p = await s.api('POST', '/compliance/evidence-packs', {
      scope: { platformId: hub },
      from: new Date(Date.now() - DAY).toISOString(),
      to: new Date(Date.now() + 60_000).toISOString(),
    });
    let pack: any;
    for (let i = 0; i < 600; i++) {
      pack = await s.api('GET', `/compliance/evidence-packs/${p.id}`);
      if (pack.status !== 'building') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(pack).toMatchObject({ status: 'ready', error: null });
    const res = await fetch(`${s.base}/api/compliance/evidence-packs/${p.id}/download`, {
      headers: { ...authHeaders(await loginCookie(s.base, 'admin', 'Admin-password-1')), 'x-sm-client': '1' },
    });
    expect(res.status).toBe(200);
    const file = path.join(s.dataDir, 'archived-pack.zip');
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    const { verifyPack } = await import('../src/compliance/evidence-verify.js');
    const { ZipReader } = await import('../src/compliance/zip.js');
    const zip = await ZipReader.open(file);
    expect(zip.entries.map((e) => e.name)).toEqual(expect.arrayContaining([`audit/archives/${first.file}`, `audit/archives/${second.file}`]));
    const excerpt = JSON.parse((await zip.read(zip.find('audit/audit-log-excerpt.json')!)).toString());
    expect(excerpt.startSeq).toBe(second.lastSeq + 1);
    expect(excerpt.archives.map((a: any) => a.file)).toEqual([first.file, second.file]);
    const r = await verifyPack(file, { publicKey: pem });
    expect(r.problems).toEqual([]);
    expect(r).toMatchObject({ ok: true, trusted: true, audit: { ok: true } });
    expect(r.audit!.archives).toEqual([expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true })]);
  });
});
