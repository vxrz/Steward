import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type { AuditCheckpoint } from '@sm/shared';
import { HttpError } from '../util.js';

/**
 * The migration package (".smig"): one file that carries a whole Steward instance to another one.
 *
 *   "STEWARD-MIGRATION 1\n"
 *   <header JSON>\n               scrypt parameters and salt, AES-GCM nonce (not secret)
 *   <AES-256-GCM ciphertext>      a ZIP file (compliance/zip.ts) – see Manifest for its entries
 *   <16-byte GCM tag>
 *
 * The key comes from a transfer passphrase (scrypt N=2^17, r=8, p=1 → HKDF): the two instances have
 * different master passphrases, so the package cannot be bound to either. The magic line and the header
 * are authenticated as additional data. Inside, credentials are encrypted once more with a second key
 * from the same passphrase (re-encrypted with the target's vault on import), and the manifest is signed
 * with the source instance's Ed25519 key (the audit checkpoint key): the import shows its fingerprint
 * for confirmation and refuses a package whose content does not match the signed manifest.
 */

export const MAGIC = 'STEWARD-MIGRATION 1\n';
export const PACKAGE_FORMAT = 'steward-migration';
export const PACKAGE_VERSION = 1;
export const TRANSFER_PASSPHRASE_MIN = 12;
const KDF = { N: 2 ** 17, r: 8, p: 1 };
const HEADER_MAX = 4096;
const TAG_BYTES = 16;

export interface EnvelopeHeader {
  v: 1;
  kdf: { alg: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: 'aes-256-gcm';
  iv: string;
  createdAt: string;
}

/** A user of the source instance (no password hashes: local passwords never move). */
export interface PackageUser {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  roles: string[];
  active: boolean;
  /** 'local' or 'sso' */
  kind: 'local' | 'sso';
  /** Name of the single sign-on provider on the source */
  provider: string | null;
  teams: string[];
  lastLoginAt: string | null;
}

export interface PackageTeam {
  id: string;
  name: string;
  description: string;
  members: string[];
}

export interface Manifest {
  format: typeof PACKAGE_FORMAT;
  formatVersion: typeof PACKAGE_VERSION;
  /** Random id of this package (also in the source's instance.exported audit entry) */
  packageId: string;
  product: string;
  productVersion: string;
  createdAt: string;
  createdBy: string;
  source: {
    /** Fingerprint of the source's signing key – the source's identity */
    fingerprint: string;
    /** Ed25519 public key (base64 SPKI DER) that signed this manifest and the audit checkpoint */
    publicKey: string;
    database: 'sqlite' | 'postgres';
  };
  schema: { core: number; named: string[] };
  tables: { name: string; rows: number; sha256: string; columns: string[] }[];
  files: { path: string; size: number; sha256: string }[];
  audit: { entries: number; sha256: string; checkpoint: AuditCheckpoint };
  users: PackageUser[];
  teams: PackageTeam[];
  settings: { sha256: string; keys: string[] };
  /** Configuration integrity of each platform on the source ('ok': resealed with the target's key on import) */
  platformIntegrity: Record<string, 'ok' | 'mismatch' | 'unsealed'>;
}

export interface Signature {
  alg: 'ed25519';
  publicKey: string;
  /** base64 signature over manifestSigningInput(<the exact bytes of manifest.json>) */
  signature: string;
}

/** Domain separation: the instance key signs other things too (audit checkpoints, emergency grants). */
export const MANIFEST_SIGNATURE_PURPOSE = 'steward-migration-manifest-v1';

/** What the source's key signs: the purpose line, then the exact bytes of manifest.json. */
export const manifestSigningInput = (manifestBytes: Buffer): Buffer => Buffer.concat([Buffer.from(`${MANIFEST_SIGNATURE_PURPOSE}\n`, 'utf8'), manifestBytes]);

const scryptAsync = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, o: crypto.ScryptOptions) => Promise<Buffer>;

/** Two keys from the transfer passphrase: the envelope and the credentials inside. */
export async function deriveKeys(passphrase: string, salt: Buffer, kdf = KDF): Promise<{ envelope: Buffer; secrets: Buffer }> {
  if (kdf.N > 2 ** 20 || kdf.r > 16 || kdf.p > 4) throw new HttpError(400, 'Unsupported key derivation parameters in the package', 'MIGRATION_PACKAGE_INVALID');
  const master = await scryptAsync(passphrase, salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 512 * 1024 * 1024 });
  const hk = (info: string) => Buffer.from(crypto.hkdfSync('sha256', master, salt, info, 32));
  return { envelope: hk('steward-migration-envelope-v1'), secrets: hk('steward-migration-secrets-v1') };
}

export function checkTransferPassphrase(p: string): void {
  if (p.length < TRANSFER_PASSPHRASE_MIN) {
    throw new HttpError(400, `The transfer passphrase must have at least ${TRANSFER_PASSPHRASE_MIN} characters`, 'TRANSFER_PASSPHRASE_TOO_SHORT', {
      count: TRANSFER_PASSPHRASE_MIN,
    });
  }
}

/** Encrypts the ZIP file `zip` into the package `out` (created exclusively, 0600). Returns the keys used. */
export async function sealPackage(zip: string, out: string, passphrase: string, keys?: { salt: Buffer; secrets: Buffer; envelope: Buffer }): Promise<void> {
  const salt = keys?.salt ?? crypto.randomBytes(16);
  const k = keys ?? { ...(await deriveKeys(passphrase, salt)), salt };
  const iv = crypto.randomBytes(12);
  const header: EnvelopeHeader = {
    v: 1,
    kdf: { alg: 'scrypt', ...KDF, salt: salt.toString('base64') },
    cipher: 'aes-256-gcm',
    iv: iv.toString('base64'),
    createdAt: new Date().toISOString(),
  };
  const head = Buffer.from(MAGIC + JSON.stringify(header) + '\n', 'utf8');
  const cipher = crypto.createCipheriv('aes-256-gcm', k.envelope, iv);
  cipher.setAAD(head);
  const fd = fs.openSync(out, 'wx', 0o600);
  const ws = fs.createWriteStream('', { fd });
  try {
    ws.write(head);
    await pipeline(fs.createReadStream(zip), cipher, ws, { end: false });
    await new Promise<void>((resolve, reject) => ws.end(cipher.getAuthTag(), (e?: Error | null) => (e ? reject(e) : resolve())));
  } catch (e) {
    ws.destroy();
    fs.rmSync(out, { force: true });
    throw e;
  }
}

/** Prepares the keys for a package before its content is written (the credentials inside need the secrets key). */
export async function newPackageKeys(passphrase: string): Promise<{ salt: Buffer; secrets: Buffer; envelope: Buffer }> {
  checkTransferPassphrase(passphrase);
  const salt = crypto.randomBytes(16);
  return { salt, ...(await deriveKeys(passphrase, salt)) };
}

function readHeader(file: string): { header: EnvelopeHeader; headBytes: Buffer; size: number } {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(HEADER_MAX, size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    const magic = Buffer.from(MAGIC);
    if (buf.length < magic.length || !buf.subarray(0, magic.length).equals(magic)) {
      throw new HttpError(400, 'This is not a Steward migration package', 'MIGRATION_PACKAGE_INVALID');
    }
    const nl = buf.indexOf(0x0a, magic.length);
    if (nl < 0) throw new HttpError(400, 'The package header is damaged', 'MIGRATION_PACKAGE_INVALID');
    let header: EnvelopeHeader;
    try {
      header = JSON.parse(buf.subarray(magic.length, nl).toString('utf8')) as EnvelopeHeader;
    } catch {
      throw new HttpError(400, 'The package header is damaged', 'MIGRATION_PACKAGE_INVALID');
    }
    if (
      header.v !== 1 ||
      header.cipher !== 'aes-256-gcm' ||
      header.kdf?.alg !== 'scrypt' ||
      typeof header.iv !== 'string' ||
      typeof header.kdf.salt !== 'string'
    ) {
      throw new HttpError(400, 'Unsupported package format', 'MIGRATION_PACKAGE_INVALID');
    }
    const headBytes = buf.subarray(0, nl + 1);
    if (size < headBytes.length + TAG_BYTES) throw new HttpError(400, 'The package is incomplete', 'MIGRATION_PACKAGE_INVALID');
    return { header, headBytes: Buffer.from(headBytes), size };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Decrypts a package into the ZIP file `zipOut` (created exclusively). A wrong passphrase and a changed
 * package look the same (the GCM tag does not match): the partial output is removed.
 */
export async function openPackage(file: string, passphrase: string, zipOut: string): Promise<{ secrets: Buffer }> {
  const { header, headBytes, size } = readHeader(file);
  const salt = Buffer.from(header.kdf.salt, 'base64');
  const keys = await deriveKeys(passphrase, salt, { N: header.kdf.N, r: header.kdf.r, p: header.kdf.p });
  const fd = fs.openSync(file, 'r');
  const tag = Buffer.alloc(TAG_BYTES);
  try {
    fs.readSync(fd, tag, 0, TAG_BYTES, size - TAG_BYTES);
  } finally {
    fs.closeSync(fd);
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', keys.envelope, Buffer.from(header.iv, 'base64'), { authTagLength: TAG_BYTES });
  decipher.setAAD(headBytes);
  decipher.setAuthTag(tag);
  const out = fs.openSync(zipOut, 'wx', 0o600);
  try {
    const end = size - TAG_BYTES - 1;
    const src = end >= headBytes.length ? fs.createReadStream(file, { start: headBytes.length, end }) : fs.createReadStream(file, { start: 0, end: -1 });
    await pipeline(src, decipher, fs.createWriteStream('', { fd: out }));
  } catch {
    fs.rmSync(zipOut, { force: true });
    throw new HttpError(400, 'Wrong transfer passphrase, or the package was changed or is incomplete', 'MIGRATION_PACKAGE_UNREADABLE');
  }
  return { secrets: keys.secrets };
}

/** A private working folder for a package (in the data folder, 0700), removed by the caller. */
export function workDir(dataDir: string): string {
  const base = path.join(dataDir, 'migration-work');
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  // leftovers of an interrupted export or import (a stopped server): they hold encrypted credentials
  for (const e of fs.readdirSync(base, { withFileTypes: true })) {
    const p = path.join(base, e.name);
    try {
      if (e.isDirectory() && Date.now() - fs.statSync(p).mtimeMs > 24 * 3600_000) fs.rmSync(p, { recursive: true, force: true });
    } catch {
      /* in use or gone */
    }
  }
  return fs.mkdtempSync(path.join(base, 'pkg-'));
}

export const sha256File = async (file: string): Promise<string> => {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
};
