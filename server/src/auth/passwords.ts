import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { PASSWORD_RULES } from '@sm/shared';
import { HttpError } from '../util.js';
import { config, env } from '../config.js';
import { logger } from '../log.js';

/**
 * Local passwords (ASVS 5.0 V6.2, NIST SP 800-63B): a length rule instead of composition rules, any Unicode characters
 * (compared in Unicode NFKC form), and a check against a bundled list of common passwords – nothing is sent anywhere.
 * Stored as scrypt hashes with the OWASP minimum cost; older, cheaper hashes keep working and are replaced at the next
 * successful sign-in (users.ts).
 */

/**
 * scrypt cost of new hashes: N=2^17, r=8, p=1 – the OWASP Password Storage Cheat Sheet minimum, and the cost of the
 * vault's key. About 128 MiB of memory per hash, outside the JavaScript heap (the libuv thread pool); at most
 * SM_PASSWORD_HASH_CONCURRENCY run at the same time (default 2, so about 256 MiB at peak).
 */
const N = 2 ** 17;
/**
 * The cost new hashes get: N, except inside the server test runner (vitest sets VITEST), where a hash at 2^17 costs
 * about 0.4 s of CPU and the suite creates hundreds of accounts; there 2^12 unless a test asks for the real cost with
 * STEWARD_TEST_REAL_PASSWORD_COST=1 (passwords.test.ts). Stored hashes always name their own cost, so either verifies.
 */
const newN = (): number => (process.env.VITEST && process.env.STEWARD_TEST_REAL_PASSWORD_COST !== '1' ? 2 ** 12 : N);
const R = 8;
const P = 1;
/** Hashes up to N=2^18 can be checked (128 × r × N bytes, plus room). */
const MAXMEM = 512 * 1024 * 1024;
/** Marks a hash of the NFKC form of the password (0.11.0); older hashes are of the password exactly as typed. */
const NFKC_FLAG = 'nfkc';

const scryptAsync = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, o: crypto.ScryptOptions) => Promise<Buffer>;

/** The form of a password that is hashed and checked: Unicode NFKC (the same password typed on another keyboard matches). */
export const normalizePassword = (password: string): string => password.normalize('NFKC');

const format = (n: number, salt: Buffer, hash: Buffer) => ['scrypt', n, R, P, salt.toString('base64'), hash.toString('base64'), NFKC_FLAG].join('$');

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const n = newN();
  return format(n, salt, crypto.scryptSync(normalizePassword(password), salt, 64, { N: n, r: R, p: P, maxmem: MAXMEM }));
}

/** Like hashPassword, off the event loop and within the hashing limit. */
export async function hashPasswordAsync(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const n = newN();
  return format(n, salt, await limited(() => scryptAsync(normalizePassword(password), salt, 64, { N: n, r: R, p: P, maxmem: MAXMEM })));
}

/**
 * At most this many password hashes are computed at the same time (each one runs on the libuv
 * thread pool, not on the event loop); further sign-ins wait in a short queue and are refused
 * with 503 when it is full – a flood of sign-ins cannot starve the server.
 */
export const HASH_CONCURRENCY = env.SM_PASSWORD_HASH_CONCURRENCY;
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
  const [alg, n, r, p, salt, hash, flags] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return null;
  const s = { N: Number(n), r: Number(r), p: Number(p), salt: Buffer.from(salt, 'base64'), hash: Buffer.from(hash, 'base64'), nfkc: flags === NFKC_FLAG };
  // a stored hash names its own cost: only sensible values are computed (a changed row cannot make a sign-in hang)
  if (!Number.isInteger(s.N) || s.N < 2 ** 10 || s.N > 2 ** 18 || (s.N & (s.N - 1)) !== 0) return null;
  if (!Number.isInteger(s.r) || s.r < 1 || s.r > 16 || !Number.isInteger(s.p) || s.p < 1 || s.p > 4) return null;
  return s;
}

/** Whether a stored hash is older or cheaper than new ones: it is replaced at the next successful sign-in. */
export function needsRehash(stored: string): boolean {
  const s = parse(stored);
  return !!s && (!s.nfkc || s.N < newN() || s.r < R || s.p < P);
}

/** Constant-time check, off the event loop. */
export async function verifyPasswordAsync(password: string, stored: string): Promise<boolean> {
  const s = parse(stored);
  if (!s) return false;
  const typed = s.nfkc ? normalizePassword(password) : password;
  const actual = await limited(() => scryptAsync(typed, s.salt, s.hash.length, { N: s.N, r: s.r, p: s.p, maxmem: MAXMEM }));
  return crypto.timingSafeEqual(actual, s.hash);
}

/** Synchronous variant (kept for scripts and tests). */
export function verifyPassword(password: string, stored: string): boolean {
  const s = parse(stored);
  if (!s) return false;
  const typed = s.nfkc ? normalizePassword(password) : password;
  const actual = crypto.scryptSync(typed, s.salt, s.hash.length, { N: s.N, r: s.r, p: s.p, maxmem: MAXMEM });
  return crypto.timingSafeEqual(actual, s.hash);
}

/** One hash for unknown user names, computed once: the check costs the same as for a real account. */
let dummy: string | undefined;
export function dummyHash(): string {
  return (dummy ??= hashPassword(crypto.randomBytes(16).toString('hex')));
}

// ---------- the password rule ----------

/**
 * The bundled list of common passwords, below SM_ASSETS_DIR: one password per line in NFKC form and lower case, sorted,
 * gzip-compressed, only entries the length rule would let through (scripts/common-passwords.mjs builds it from a
 * published list; NOTICE names the source). Read once, at the first password that is set – never at sign-in.
 */
export const COMMON_PASSWORDS_FILE = path.join('passwords', 'common-passwords.txt.gz');
let common: Set<string> | undefined;

function commonPasswords(): Set<string> {
  if (common) return common;
  const file = path.join(config.assetsDir, COMMON_PASSWORDS_FILE);
  try {
    common = new Set(
      zlib
        .gunzipSync(fs.readFileSync(file))
        .toString('utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    );
  } catch (err) {
    // a broken installation must not keep everyone from changing a password: the length rule still applies
    logger.error({ err, file }, 'could not read the list of common passwords – new passwords are checked by their length only');
    common = new Set();
  }
  return common;
}

/** Tests: read the list again at the next check. */
export function resetCommonPasswords(): void {
  common = undefined;
}

/** A short block repeated ("aaaaaaaaaaaa", "abcabcabcabc") or a run of consecutive characters ("abcdefghijkl", "zyxwvutsrqpo"). */
function trivial(chars: string[]): boolean {
  for (let len = 1; len <= 4; len++) {
    if (chars.length % len === 0 && chars.every((c, i) => c === chars[i % len])) return true;
  }
  const codes = chars.map((c) => c.codePointAt(0)!);
  const step = codes[1]! - codes[0]!;
  return Math.abs(step) === 1 && codes.every((c, i) => i === 0 || c - codes[i - 1]! === step);
}

export type PasswordProblem = 'tooShort' | 'tooLong' | 'tooCommon';

/** What is wrong with a new password (null: nothing): its length (in characters of the NFKC form), or it is common. */
export function passwordProblem(password: string): PasswordProblem | null {
  const normal = normalizePassword(password);
  const chars = [...normal];
  if (chars.length < PASSWORD_RULES.minLength) return 'tooShort';
  if (chars.length > PASSWORD_RULES.maxLength) return 'tooLong';
  // case-insensitive: "Password1234" is as common as "password1234"
  if (trivial(chars) || commonPasswords().has(normal.toLowerCase())) return 'tooCommon';
  return null;
}

const PROBLEM_TEXT: Record<PasswordProblem, string> = {
  tooShort: `The password must have at least ${PASSWORD_RULES.minLength} characters`,
  tooLong: `The password must have at most ${PASSWORD_RULES.maxLength} characters`,
  tooCommon: 'This password is too common – choose another one',
};

/** 400 PASSWORD_POLICY with the reason as `context` (the web app shows a translated text for it). */
export function checkPasswordPolicy(password: string): void {
  const problem = passwordProblem(password);
  if (problem)
    throw new HttpError(400, PROBLEM_TEXT[problem], 'PASSWORD_POLICY', {
      context: problem,
      min: PASSWORD_RULES.minLength,
      max: PASSWORD_RULES.maxLength,
    });
}

/** A one-time password (16 characters, 72 random bits): it must be changed at the first sign-in. */
export function temporaryPassword(): string {
  return crypto.randomBytes(9).toString('base64url') + '-7';
}
