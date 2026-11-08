import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Local passwords (0.11.0, security review 0.10.0 S7; ASVS 5.0 V6.2.4/V6.2.5/V11.4.2, NIST SP 800-63B): a length rule
 * instead of composition rules, Unicode NFKC, the bundled list of common passwords, scrypt at the OWASP minimum, and old
 * hashes replaced at the next sign-in while they keep working.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

/** A hash as Steward wrote it before 0.11: scrypt N=2^15, r=8, p=1, of the password exactly as typed. */
function legacyHash(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 2 ** 15, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  return ['scrypt', 2 ** 15, 8, 1, salt.toString('base64'), hash.toString('base64')].join('$');
}

// started before any module of the server is imported: the configuration reads SM_DATA_DIR when it loads
let s: TestServer;
beforeAll(async () => {
  s = await startTestServer();
});
afterAll(async () => {
  await s?.app.close();
});

describe('the password rule', () => {
  it('counts characters of the NFKC form: at least 12, at most 256, any characters, no composition rules', async () => {
    const { passwordProblem } = await import('../src/auth/passwords.js');
    expect(passwordProblem('short-pw-11')).toBe('tooShort');
    // letters only, digits only, spaces: fine when long enough (no composition rules any more)
    expect(passwordProblem('correcthorsebattery')).toBeNull();
    expect(passwordProblem('four words make a pass')).toBeNull();
    expect(passwordProblem('Grüße aus Köln')).toBeNull();
    // emoji count as one character each (code points), not as UTF-16 units
    expect(passwordProblem('🔑'.repeat(11))).toBe('tooShort'); // 22 UTF-16 units, 11 characters
    expect(passwordProblem('🔑🌳🌲🌵🌷🌻🚪🧱🪟🔒🎈🎉')).toBeNull();
    expect(passwordProblem('x'.repeat(257))).toBe('tooLong');
    expect(passwordProblem(Array.from({ length: 256 }, (_, i) => String.fromCharCode(97 + ((i * 7) % 26))).join(''))).toBeNull(); // 256 characters
  });

  it('refuses common passwords from the bundled list, whatever their case or width', async () => {
    const { passwordProblem, checkPasswordPolicy } = await import('../src/auth/passwords.js');
    expect(passwordProblem('password1234')).toBe('tooCommon');
    expect(passwordProblem('PassWord1234')).toBe('tooCommon');
    // full-width letters and digits are the same password in NFKC form
    expect(passwordProblem('ｐａｓｓｗｏｒｄ１２３４')).toBe('tooCommon');
    // one character or a short block repeated, a run of consecutive characters
    for (const trivial of ['aaaaaaaaaaaa', 'abcabcabcabc', '121212121212', 'abcdefghijkl', 'zyxwvutsrqpo'])
      expect(passwordProblem(trivial), trivial).toBe('tooCommon');
    expect(() => checkPasswordPolicy('Password1234')).toThrow(
      expect.objectContaining({ code: 'PASSWORD_POLICY', params: expect.objectContaining({ context: 'tooCommon' }) }),
    );
  });

  it('the bundled list is gzip, one entry per line, NFKC and lower case, sorted, unique, all within the length rule', async () => {
    const { COMMON_PASSWORDS_FILE } = await import('../src/auth/passwords.js');
    const { PASSWORD_RULES, passwordLength } = await import('@sm/shared');
    const file = path.join(import.meta.dirname, '..', 'assets', COMMON_PASSWORDS_FILE);
    const lines = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').split('\n');
    expect(lines.pop()).toBe('');
    expect(lines.length).toBeGreaterThan(0);
    expect([...new Set(lines)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(lines);
    for (const l of lines) {
      expect(l).toBe(l.normalize('NFKC').toLowerCase().trim());
      expect(passwordLength(l)).toBeGreaterThanOrEqual(PASSWORD_RULES.minLength);
      expect(passwordLength(l)).toBeLessThanOrEqual(PASSWORD_RULES.maxLength);
    }
  });
});

describe('password hashes', () => {
  it('new hashes use scrypt N=2^17, r=8, p=1 of the NFKC form; old ones still verify and are marked for an upgrade', async () => {
    const { hashPassword, needsRehash, verifyPassword, verifyPasswordAsync } = await import('../src/auth/passwords.js');
    const h = hashPassword('ｃｏｒｒｅｃｔ horse battery');
    expect(h).toMatch(/^scrypt\$131072\$8\$1\$[^$]+\$[^$]+\$nfkc$/);
    expect(needsRehash(h)).toBe(false);
    expect(await verifyPasswordAsync('correct horse battery', h)).toBe(true);
    expect(verifyPassword('correct horse batterY', h)).toBe(false);
    const old = legacyHash('Old-password-1');
    expect(needsRehash(old)).toBe(true);
    expect(await verifyPasswordAsync('Old-password-1', old)).toBe(true);
    expect(await verifyPasswordAsync('Old-password-2', old)).toBe(false);
    // a stored hash cannot ask for an absurd cost
    expect(await verifyPasswordAsync('x', 'scrypt$1099511627776$8$1$AAAA$AAAA$nfkc')).toBe(false);
    expect(needsRehash('!none')).toBe(false);
  });
});

describe('passwords on a server', () => {
  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: { status?: number; body?: { code?: string; params?: Record<string, unknown> } }) => ({ status: e.status, ...e.body }),
    );

  it('refuses a common administrator password at the set-up, before it sets up the vault', async () => {
    const r = await fetch(`${s.base}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sm-client': '1' },
      body: JSON.stringify({ passphrase: 'correct horse battery', username: 'admin', password: 'password1234' }),
    });
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ code: 'PASSWORD_POLICY', params: { context: 'tooCommon' } });
    expect((await (await fetch(`${s.base}/api/auth/status`)).json()).initialized).toBe(false);
    await setup(s);
  });

  it('refuses common and short passwords for new accounts and password changes; tells the client why', async () => {
    expect(await refusal(s.api('POST', '/users', { username: 'cora', roles: ['viewer'], password: 'Password1234' }))).toMatchObject({
      status: 400,
      code: 'PASSWORD_POLICY',
      params: { context: 'tooCommon', min: 12, max: 256 },
    });
    expect(await refusal(s.api('POST', '/users', { username: 'cora', roles: ['viewer'], password: 'Short-pw-1' }))).toMatchObject({
      code: 'PASSWORD_POLICY',
      params: { context: 'tooShort' },
    });
    // a long password of letters only is fine now
    await s.api('POST', '/users', { username: 'cora', roles: ['viewer'], password: 'lettersonlypassphrase' });
    expect(await refusal(s.api('POST', '/auth/password', { current: ADMIN.password, next: 'qwerty123456' }))).toMatchObject({
      code: 'PASSWORD_POLICY',
      params: { context: 'tooCommon' },
    });
    // the same password in another Unicode form is not a new one
    expect(await refusal(s.api('POST', '/auth/password', { current: ADMIN.password, next: 'Ａdmin-password-1' }))).toMatchObject({ code: 'SAME_PASSWORD' });
  });

  it('upgrades a hash from before 0.11 at the next sign-in; the password keeps working', async () => {
    const { db } = await import('../src/db.js');
    const users = await import('../src/auth/users.js');
    const { needsRehash } = await import('../src/auth/passwords.js');
    // a password with a character NFKC changes (ﬁ ligature): before 0.11 it was hashed as typed
    const typed = 'Old-ﬁle-password-1';
    const u = users.createUser({ username: 'olaf', roles: ['viewer'], password: 'Temporary-pass-1', mustChangePassword: false }).user;
    db().run('UPDATE users SET password_hash = ? WHERE id = ?', legacyHash(typed), u.id);
    const stored = () => db().get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', u.id)!.password_hash;
    expect(needsRehash(stored())).toBe(true);
    await s.as('olaf', typed);
    expect(stored()).toMatch(/^scrypt\$131072\$8\$1\$.+\$nfkc$/);
    expect(needsRehash(stored())).toBe(false);
    // the same password signs in after the upgrade – also typed with the plain letters
    await s.as('olaf', typed);
    await s.as('olaf', 'Old-file-password-1');
    // a wrong password changes nothing
    const before = stored();
    const wrong = await fetch(`${s.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sm-client': '1' },
      body: JSON.stringify({ username: 'olaf', password: 'Not-the-password-1' }),
    });
    expect(wrong.status).toBe(401);
    expect(stored()).toBe(before);
  });

  it('one-time passwords (reset by an administrator, the recovery command) get the new hashes too', async () => {
    const { db } = await import('../src/db.js');
    const users = await import('../src/auth/users.js');
    const id = users.findUserByName('cora')!.id;
    const temp = (await s.api('POST', `/users/${id}/reset-password`)).temporaryPassword as string;
    expect(temp.length).toBeGreaterThanOrEqual(12);
    const hash = () => db().get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', id)!.password_hash;
    expect(hash()).toMatch(/^scrypt\$131072\$8\$1\$.+\$nfkc$/);
    users.recoverAccount(id, { actor: 'cli' });
    expect(hash()).toMatch(/^scrypt\$131072\$8\$1\$.+\$nfkc$/);
  });
});
