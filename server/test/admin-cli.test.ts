import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, setup, startTestServer, type TestServer } from './helpers.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const TSX = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const PASSPHRASE = 'correct horse battery';

let s: TestServer;

function cliEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: '1', SM_DATA_DIR: s.dataDir };
  delete env.SM_MASTER_PASSPHRASE;
  delete env.SM_MASTER_PASSPHRASE_FILE;
  return env;
}
const CLI = path.join(ROOT, 'server/src/cli/admin.ts');

function admin(args: string[], input?: string) {
  const r = spawnSync(TSX, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', input, env: cliEnv(), timeout: 60000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Without blocking this process (the in-process server must answer the CLI). */
function adminAsync(args: string[], input: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(TSX, [CLI, ...args], { cwd: ROOT, env: cliEnv() });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => resolve({ code, stdout, stderr }));
    p.stdin.end(input);
  });
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const bob = await s.api('POST', '/users', { username: 'bob', roles: ['operator'], password: 'Bob-password-123' });
  await s.api('PUT', `/users/${bob.user.id}`, { active: false });
});
afterAll(async () => {
  await s.app.close().catch(() => undefined);
});

describe('admin recovery CLI', () => {
  it('prints help and rejects bad usage with exit 2', () => {
    const h = admin(['--help']);
    expect(h.code).toBe(0);
    expect(h.stdout).toContain('reset-password <username>');
    expect(admin([]).code).toBe(2);
    const u = admin(['reset-pasword', 'admin']);
    expect(u.code).toBe(2);
    expect(u.stderr).toContain("unknown command 'reset-pasword'");
    expect(admin(['reset-password']).code).toBe(2);
    expect(admin(['list-admins', '--activate']).code).toBe(2);
  });

  it('refuses while Steward is running on the data folder', async () => {
    const { writeInstanceFile, removeInstanceFile } = await import('../src/instance.js');
    writeInstanceFile(s.base);
    try {
      const r = await adminAsync(['reset-password', 'admin', '--passphrase-stdin'], PASSPHRASE);
      expect(r.code, r.stdout + r.stderr).toBe(1);
      expect(r.stderr).toContain('stop it first');
    } finally {
      removeInstanceFile();
    }
  });

  it('resets a password with the master passphrase, signs out sessions and audits it', async () => {
    // stop the in-process server (PostgreSQL: releases its lock on the schema)
    await s.app.close();
    const { db, setDb, Db, databaseTarget } = await import('../src/db.js');
    db().close();

    const wrong = admin(['reset-password', 'admin', '--passphrase-stdin'], 'not the passphrase');
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain('wrong master passphrase');

    const list = admin(['list-admins', '--json', '--passphrase-stdin'], PASSPHRASE);
    expect(list.code).toBe(0);
    expect(JSON.parse(list.stdout).admins.map((a: { username: string }) => a.username)).toEqual([ADMIN.username]);

    expect(admin(['reset-password', 'nobody', '--passphrase-stdin'], PASSPHRASE).code).toBe(1);
    const inactive = admin(['reset-password', 'bob', '--passphrase-stdin'], PASSPHRASE);
    expect(inactive.code).toBe(1);
    expect(inactive.stderr).toContain('--activate');

    const r = admin(['reset-password', 'admin', '--json', '--passphrase-stdin'], PASSPHRASE);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { ok: boolean; temporaryPassword: string };
    expect(out.ok).toBe(true);
    const bob = admin(['reset-password', 'bob', '--activate', '--passphrase-stdin'], PASSPHRASE);
    expect(bob.code, bob.stderr).toBe(0);
    expect(bob.stdout).toContain('reactivated');

    setDb(new Db(databaseTarget()));
    const { verifyPassword } = await import('../src/auth/passwords.js');
    const row = db().get<{ id: string; password_hash: string; must_change_password: number }>('SELECT * FROM users WHERE username = ?', ADMIN.username)!;
    expect(verifyPassword(out.temporaryPassword, row.password_hash)).toBe(true);
    expect(verifyPassword(ADMIN.password, row.password_hash)).toBe(false);
    expect(Number(row.must_change_password)).toBe(1);
    expect(db().get<{ n: number }>('SELECT count(*) AS n FROM sessions WHERE user_id = ?', row.id)!.n).toBe(0);
    expect(Number(db().get<{ active: number }>('SELECT active FROM users WHERE username = ?', 'bob')!.active)).toBe(1);

    const entries = db().all<{ actor: string; summary: string; seq: number; prev_hash: string; hash: string }>(
      "SELECT actor, summary, seq, prev_hash, hash FROM audit_log WHERE action = 'user.password_reset' ORDER BY seq",
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]!.actor).toMatch(/^cli:/);
    expect(entries[0]!.summary).toContain('recovery command');
    // the CLI continued the hash chain
    const before = db().get<{ hash: string }>('SELECT hash FROM audit_log WHERE seq = ?', Number(entries[0]!.seq) - 1)!;
    expect(entries[0]!.prev_hash).toBe(before.hash);
  });
});
