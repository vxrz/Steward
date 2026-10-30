import crypto from 'node:crypto';
import fs from 'node:fs';
import { promisify } from 'node:util';

/**
 * The encrypted backup file (#117): the backup ZIP, encrypted with AES-256-GCM in chunks under a key derived from the
 * backup passphrase (scrypt). Readable offline with the passphrase alone (`npm run backup -- decrypt`).
 *
 *   "STEWARD-BACKUP-1\n"                magic
 *   uint32 BE length, JSON header       {v, alg, kdf: {name, N, r, p, salt}, keyId, noncePrefix, chunkBytes, createdAt, …}
 *   frames                              uint32 BE plaintext length, ciphertext, 16-byte tag
 *
 * Frame i uses the nonce noncePrefix (8 random bytes per file) ‖ uint32 i and authenticates SHA-256(magic ‖ header) ‖
 * uint32 i ‖ final flag as additional data: changing the header, re-ordering, dropping or appending frames and cutting
 * the file short are all detected (the last frame is marked final, nothing may follow it).
 */

export const MAGIC = Buffer.from('STEWARD-BACKUP-1\n', 'ascii');
export const CHUNK_BYTES = 4 * 1024 * 1024;
const TAG = 16;
const MAX_HEADER = 64 * 1024;

export interface KdfParams {
  name: 'scrypt';
  N: number;
  r: number;
  p: number;
  /** base64 */
  salt: string;
}

/** scrypt cost of new backup keys (2^17 ≈ 128 MiB, like the vault). */
export const BACKUP_KDF = { N: 2 ** 17, r: 8, p: 1 };
export const BACKUP_PASSPHRASE_MIN = 16;

export interface BackupHeader {
  v: 1;
  alg: 'AES-256-GCM';
  kdf: KdfParams;
  /** First 16 hex characters of SHA-256 of the key: tells which passphrase a file needs */
  keyId: string;
  noncePrefix: string;
  chunkBytes: number;
  createdAt: string;
  /** Free information (instance, version, database) – not secret, authenticated with every frame */
  info?: Record<string, string>;
}

const scryptAsync = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, o: crypto.ScryptOptions) => Promise<Buffer>;

export async function deriveBackupKey(passphrase: string, kdf: KdfParams): Promise<Buffer> {
  if (kdf.name !== 'scrypt' || kdf.N > 2 ** 20 || kdf.r > 32 || kdf.p > 16) throw new Error('Unsupported key derivation in the backup file');
  return scryptAsync(passphrase, Buffer.from(kdf.salt, 'base64'), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 1024 * 1024 * 1024 });
}

export const keyIdOf = (key: Buffer): string => crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);

export function newKdf(): KdfParams {
  return { name: 'scrypt', ...BACKUP_KDF, salt: crypto.randomBytes(16).toString('base64') };
}

function aad(headerHash: Buffer, i: number, final: boolean): Buffer {
  const b = Buffer.alloc(37);
  headerHash.copy(b, 0);
  b.writeUInt32BE(i, 32);
  b[36] = final ? 1 : 0;
  return b;
}

function nonce(prefix: Buffer, i: number): Buffer {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0);
  n.writeUInt32BE(i, 8);
  return n;
}

/** Encrypts `input` into `output` (created exclusively, 0600). Returns size and SHA-256 of the encrypted file. */
export async function encryptFile(
  input: string,
  output: string,
  key: Buffer,
  o: { kdf: KdfParams; info?: Record<string, string>; chunkBytes?: number; now?: Date },
): Promise<{ bytes: number; sha256: string; header: BackupHeader }> {
  const chunkBytes = o.chunkBytes ?? CHUNK_BYTES;
  const prefix = crypto.randomBytes(8);
  const header: BackupHeader = {
    v: 1,
    alg: 'AES-256-GCM',
    kdf: o.kdf,
    keyId: keyIdOf(key),
    noncePrefix: prefix.toString('base64'),
    chunkBytes,
    createdAt: (o.now ?? new Date()).toISOString(),
    ...(o.info ? { info: o.info } : {}),
  };
  const headerJson = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(headerJson.length);
  const headerHash = crypto.createHash('sha256').update(MAGIC).update(headerJson).digest();
  const src = await fs.promises.open(input, 'r');
  const dst = await fs.promises.open(output, 'wx', 0o600);
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const write = async (b: Buffer) => {
    hash.update(b);
    bytes += b.length;
    await dst.write(b);
  };
  try {
    await write(MAGIC);
    await write(len);
    await write(headerJson);
    const size = (await src.stat()).size;
    let pos = 0;
    for (let i = 0, final = false; !final; i++) {
      const n = Math.min(chunkBytes, size - pos);
      const plain = Buffer.alloc(n);
      if (n) {
        const { bytesRead } = await src.read(plain, 0, n, pos);
        if (bytesRead !== n) throw new Error('The backup archive changed while it was encrypted');
      }
      pos += n;
      final = pos >= size;
      const c = crypto.createCipheriv('aes-256-gcm', key, nonce(prefix, i), { authTagLength: TAG });
      c.setAAD(aad(headerHash, i, final));
      const enc = Buffer.concat([c.update(plain), c.final()]);
      const frameLen = Buffer.alloc(4);
      frameLen.writeUInt32BE(n);
      await write(Buffer.concat([frameLen, enc, c.getAuthTag()]));
    }
  } catch (e) {
    await dst.close().catch(() => undefined);
    await src.close().catch(() => undefined);
    await fs.promises.rm(output, { force: true });
    throw e;
  }
  await dst.close();
  await src.close();
  return { bytes, sha256: hash.digest('hex'), header };
}

/** Reads the header of an encrypted backup file (without the key). */
export async function readHeader(file: string): Promise<{ header: BackupHeader; dataStart: number; headerHash: Buffer }> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const head = Buffer.alloc(MAGIC.length + 4);
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    if (bytesRead < head.length || !head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not a Steward backup file');
    const n = head.readUInt32BE(MAGIC.length);
    if (n > MAX_HEADER) throw new Error('Broken backup file (header too large)');
    const json = Buffer.alloc(n);
    if ((await fh.read(json, 0, n, head.length)).bytesRead !== n) throw new Error('Broken backup file (header cut off)');
    const header = JSON.parse(json.toString('utf8')) as BackupHeader;
    if (header.v !== 1 || header.alg !== 'AES-256-GCM') throw new Error(`Unsupported backup format (version ${String(header.v)})`);
    if (!Number.isInteger(header.chunkBytes) || header.chunkBytes < 1 || header.chunkBytes > 64 * 1024 * 1024)
      throw new Error('Broken backup file (chunk size)');
    if (Buffer.from(header.noncePrefix, 'base64').length !== 8) throw new Error('Broken backup file (nonce)');
    return { header, dataStart: head.length + n, headerHash: crypto.createHash('sha256').update(MAGIC).update(json).digest() };
  } finally {
    await fh.close();
  }
}

/**
 * Decrypts a backup file into `output` (created exclusively, 0600). Fails – and removes the output – when the key is
 * wrong or anything in the file was changed, re-ordered or cut off.
 */
export async function decryptFile(input: string, output: string, key: Buffer): Promise<{ header: BackupHeader; bytes: number }> {
  const { header, dataStart, headerHash } = await readHeader(input);
  if (keyIdOf(key) !== header.keyId) throw new Error(`Wrong backup passphrase or key (the file needs key ${header.keyId})`);
  const prefix = Buffer.from(header.noncePrefix, 'base64');
  const src = await fs.promises.open(input, 'r');
  const dst = await fs.promises.open(output, 'wx', 0o600);
  let bytes = 0;
  try {
    const size = (await src.stat()).size;
    let pos = dataStart;
    for (let i = 0; ; i++) {
      const lenBuf = Buffer.alloc(4);
      if ((await src.read(lenBuf, 0, 4, pos)).bytesRead !== 4) throw new Error('The backup file is cut off');
      const n = lenBuf.readUInt32BE(0);
      if (n > header.chunkBytes) throw new Error('Broken backup file (frame too large)');
      const frame = Buffer.alloc(n + TAG);
      if ((await src.read(frame, 0, n + TAG, pos + 4)).bytesRead !== n + TAG) throw new Error('The backup file is cut off');
      pos += 4 + n + TAG;
      const final = pos >= size;
      const d = crypto.createDecipheriv('aes-256-gcm', key, nonce(prefix, i), { authTagLength: TAG });
      d.setAAD(aad(headerHash, i, final));
      d.setAuthTag(frame.subarray(n));
      let plain: Buffer;
      try {
        plain = Buffer.concat([d.update(frame.subarray(0, n)), d.final()]);
      } catch {
        throw new Error(final ? 'The backup file was changed or cut off (authentication failed)' : 'The backup file was changed (authentication failed)');
      }
      await dst.write(plain);
      bytes += n;
      if (final) break;
    }
  } catch (e) {
    await dst.close().catch(() => undefined);
    await src.close().catch(() => undefined);
    await fs.promises.rm(output, { force: true });
    throw e;
  }
  await dst.close();
  await src.close();
  return { header, bytes };
}

export async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
