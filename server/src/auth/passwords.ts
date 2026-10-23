import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError } from '../util.js';

const N = 2 ** 15;
const R = 8;
const P = 1;
const MAXMEM = 256 * 1024 * 1024;

const scryptAsync = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, o: crypto.ScryptOptions) => Promise<Buffer>;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N, r: R, p: P, maxmem: MAXMEM });
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

/**
 * At most this many password hashes are computed at the same time (each one runs on the libuv
 * thread pool, not on the event loop); further sign-ins wait in a short queue and are refused
 * with 503 when it is full – a flood of sign-ins cannot starve the server.
 */
export const HASH_CONCURRENCY = Math.max(1, Number(process.env.SM_PASSWORD_HASH_CONCURRENCY) || 2);
const QUEUE_MAX = 64;
let active = 0;
const queue: (() => void)[] = [];

async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= HASH_CONCURRENCY) {
    if (queue.length >= QUEUE_MAX) throw new HttpError(503, 'Too many sign-ins at the same time – try again in a moment', 'BUSY');
    await new Promise<void>((resolve) => queue.push(resolve));
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    queue.shift()?.();
  }
}

function parse(stored: string) {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return null;
  return { N: Number(n), r: Number(r), p: Number(p), salt: Buffer.from(salt, 'base64'), hash: Buffer.from(hash, 'base64') };
}

/** Constant-time check, off the event loop. */
export async function verifyPasswordAsync(password: string, stored: string): Promise<boolean> {
  const s = parse(stored);
  if (!s) return false;
  const actual = await limited(() => scryptAsync(password, s.salt, s.hash.length, { N: s.N, r: s.r, p: s.p, maxmem: MAXMEM }));
  return crypto.timingSafeEqual(actual, s.hash);
}

/** Synchronous variant (kept for scripts and tests). */
export function verifyPassword(password: string, stored: string): boolean {
  const s = parse(stored);
  if (!s) return false;
  const actual = crypto.scryptSync(password, s.salt, s.hash.length, { N: s.N, r: s.r, p: s.p, maxmem: MAXMEM });
  return crypto.timingSafeEqual(actual, s.hash);
}

/** One hash for unknown user names, computed once: the check costs the same as for a real account. */
let dummy: string | undefined;
export function dummyHash(): string {
  return (dummy ??= hashPassword(crypto.randomBytes(16).toString('hex')));
}

export function checkPasswordPolicy(password: string): string | null {
  if (password.length < 10) return 'Password must have at least 10 characters';
  if (password.length > 1024) return 'Password must have at most 1024 characters';
  if (!/[A-Za-z]/.test(password) || !/[^A-Za-z]/.test(password)) return 'Password must contain letters and at least one digit or symbol';
  return null;
}

export function temporaryPassword(): string {
  return crypto.randomBytes(9).toString('base64url') + '-7';
}
