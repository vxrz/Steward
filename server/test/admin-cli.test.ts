import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, setup, startTestServer, type TestServer } from './helpers.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const TSX = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const PASSPHRASE = 'correct horse battery';

let s: TestServer;

function cliEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: '1', SM_DATA_DIR: s.dataDir, ...extra };
  delete env.SM_MASTER_PASSPHRASE;
  delete env.SM_MASTER_PASSPHRASE_FILE;
  delete env.SM_PUBLIC_URL;
  if (!extra.SM_PASSWORD_LOGIN) delete env.SM_PASSWORD_LOGIN;
  return env;
}
const CLI = path.join(ROOT, 'server/src/cli/admin.ts');

function admin(args: string[], input?: string, extraEnv: Record<string, string> = {}) {
  const r = spawnSync(TSX, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', input, env: cliEnv(extraEnv), timeout: 60000 });
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
    expect(admin(['emergency-access']).code).toBe(2);
    expect(admin(['emergency-access', 'admin', '--minutes', '0']).code).toBe(2);
    expect(admin(['emergency-access', 'admin', '--minutes', '1441']).code).toBe(2);
    expect(admin(['reset-password', 'admin', '--minutes', '5']).code).toBe(2);
    expect(admin(['password-login', 'some']).code).toBe(2);
    expect(admin(['--help']).stdout).toContain('emergency-access <username>');
  });

  it('grants emergency access through the running server (signed, over loopback) and refuses the other commands', async () => {
    const { writeInstanceFile, removeInstanceFile } = await import('../src/instance.js');
    writeInstanceFile(s.base);
    try {
      const pl = await adminAsync(['password-login', 'all', '--passphrase-stdin'], PASSPHRASE);
      expect(pl.code).toBe(1);
      expect(pl.stderr).toContain('stop it first');
      const wrong = await adminAsync(['emergency-access', 'admin', '--passphrase-stdin'], 'not the passphrase');
      expect(wrong.code).toBe(1);
      expect(wrong.stderr).toContain('wrong master passphrase');
      const notAdmin = await adminAsync(['emergency-access', 'bob', '--passphrase-stdin'], PASSPHRASE);
      expect(notAdmin.code).toBe(1);
      expect(notAdmin.stderr).toContain('not an administrator');
      const r = await adminAsync(['emergency-access', 'admin', '--minutes', '20', '--json', '--passphrase-stdin'], PASSPHRASE);
      expect(r.code, r.stderr).toBe(0);
      const out = JSON.parse(r.stdout) as { link: string; minutes: number; mode: string };
      expect(out.mode).toBe('running');
      expect(out.minutes).toBe(20);
      expect(out.link.startsWith(`${s.base}/emergency-access#code=`)).toBe(true);
      const code = out.link.split('#code=')[1];
      const res = await fetch(`${s.base}/api/auth/emergency`, {
        method: 'POST',
        headers: { 'x-sm-client': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      expect(res.status).toBe(200);
      const [entry] = await s.api('GET', '/audit?action=auth.emergency_access_granted&limit=1');
      expect(entry.actor).toMatch(/^cli:/);
    } finally {
      removeInstanceFile();
    }
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
    db().close();
  });

  it('switches password sign-in, grants emergency access with Steward stopped and shows it in list-admins', async () => {
    const { db, setDb, Db, databaseTarget } = await import('../src/db.js');
    // no single sign-on provider: password sign-in stays on
    const none = admin(['password-login', 'none', '--passphrase-stdin'], PASSPHRASE);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('no single sign-on provider');
    const env = admin(['password-login', 'all', '--passphrase-stdin'], PASSPHRASE, { SM_PASSWORD_LOGIN: 'none' });
    expect(env.code).toBe(1);
    expect(env.stderr).toContain('SM_PASSWORD_LOGIN');
    // with password sign-in off a password reset is pointless: the command says what to do instead
    const reset = admin(['reset-password', 'admin', '--passphrase-stdin'], PASSPHRASE, { SM_PASSWORD_LOGIN: 'none' });
    expect(reset.code).toBe(1);
    expect(reset.stderr).toContain('emergency-access admin');

    const g = admin(['emergency-access', 'admin', '--json', '--passphrase-stdin'], PASSPHRASE);
    expect(g.code, g.stderr).toBe(0);
    const out = JSON.parse(g.stdout) as { link: string; mode: string; minutes: number; expiresAt: string };
    expect(out.mode).toBe('stopped');
    expect(out.minutes).toBe(60);
    expect(out.link).toMatch(/\/emergency-access#code=[A-Za-z0-9_-]{43}$/);

    const list = admin(['list-admins', '--json', '--passphrase-stdin'], PASSPHRASE, { SM_PASSWORD_LOGIN: 'none' });
    expect(list.code, list.stderr).toBe(0);
    const l = JSON.parse(list.stdout) as { passwordLogin: string; admins: { username: string; signIn: string[]; emergencyUntil: string | null }[] };
    expect(l.passwordLogin).toBe('none');
    expect(l.admins[0]!.signIn).toEqual(['emergency']);
    expect(l.admins[0]!.emergencyUntil).toBe(out.expiresAt);
    const text = admin(['list-admins', '--passphrase-stdin'], PASSPHRASE);
    expect(text.stdout).toContain('emergency access open until');

    setDb(new Db(databaseTarget()));
    const grants = db().all<{ code_hash: string; issued_by: string }>(
      'SELECT code_hash, issued_by FROM emergency_access_grants WHERE used_at IS NULL AND revoked_at IS NULL',
    );
    expect(grants).toHaveLength(1);
    expect(grants[0]!.issued_by).toMatch(/^cli:/);
    // only the hash is stored
    expect(grants[0]!.code_hash).not.toContain(out.link.split('#code=')[1]);
    const audit = db().get<{ actor: string; summary: string }>(
      "SELECT actor, summary FROM audit_log WHERE action = 'auth.emergency_access_granted' ORDER BY seq DESC LIMIT 1",
    )!;
    expect(audit.actor).toMatch(/^cli:/);
    expect(audit.summary).toContain('"admin"');
  });
});
