import crypto from 'node:crypto';

const N = 2 ** 15;
const R = 8;
const P = 1;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N, r: R, p: P, maxmem: 128 * 1024 * 1024 });
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 128 * 1024 * 1024,
  });
  return crypto.timingSafeEqual(actual, expected);
}

export function checkPasswordPolicy(password: string): string | null {
  if (password.length < 10) return 'Password must have at least 10 characters';
  if (!/[A-Za-z]/.test(password) || !/[^A-Za-z]/.test(password)) return 'Password must contain letters and at least one digit or symbol';
  return null;
}

export function temporaryPassword(): string {
  return crypto.randomBytes(9).toString('base64url') + '-7';
}
