import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.js';
import { HttpError, newId, nowIso } from './util.js';

/**
 * The credential vault.
 *
 * Format 2 (current): a key-encryption key (KEK) is derived from the master
 * passphrase with scrypt and only wraps a set of random keys, stored in
 * vault.json:
 *   dek        AES-256-GCM data key for all secrets in the database
 *   audit      HMAC key of the audit chain
 *   integrity  HMAC key that authenticates non-secret settings (platform base URLs, …)
 *   sign       Ed25519 private key that signs audit checkpoints (the public key is
 *              stored in clear so it can be shown and exported while the vault is locked)
 * Changing the passphrase re-wraps these keys; optionally the data key is
 * replaced and every stored secret re-encrypted. The audit, integrity and
 * signing keys never change, so the audit chain stays verifiable.
 *
 * Format 1 (before this release): the scrypt output itself was the data key and
 * the audit key was derived from it. A format 1 vault is converted on its first
 * unlock: the old key becomes the data key, the audit key is derived exactly as
 * before (the chain stays valid), integrity and signing keys are new, scrypt gets
 * the current cost parameters and a fresh salt. The old file is kept as
 * vault.json.v1.bak.
 */
interface KdfParams {
  N: number;
  r: number;
  p: number;
}
interface VaultFileV1 extends KdfParams {
  version: 1;
  salt: string;
  check: string;
}
interface VaultFileV2 {
  version: 2;
  kdf: KdfParams & { alg: 'scrypt'; salt: string };
  /** Id of the data key (changes when it is rotated; mirrored in the database as settings "vault.keyId"). */
  keyId: string;
  /** AES-256-GCM(KEK) of the JSON-encoded keys (see VaultKeys) */
  wrapped: string;
  /** Ed25519 public key (base64 SPKI DER) of the audit checkpoint signing key */
  signingPublicKey: string;
  createdAt: string;
  updatedAt: string;
}
type VaultFile = VaultFileV1 | VaultFileV2;

interface VaultKeys {
  dek: string;
  audit: string;
  integrity: string;
  /** PKCS#8 DER, base64 */
  sign: string;
}

const CHECK_TEXT = 'service-manager-vault-v1';
/** scrypt cost for new and re-wrapped vaults (2^17 ≈ 128 MiB). Existing files keep their stored parameters until re-wrapped. */
export const KDF_DEFAULT: KdfParams = { N: 2 ** 17, r: 8, p: 1 };
export const PASSPHRASE_MIN_LENGTH = 12;

const scryptAsync = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, o: crypto.ScryptOptions) => Promise<Buffer>;

/** Runs off the event loop (libuv thread pool), so a slow derivation does not block other requests. */
async function derive(passphrase: string, salt: Buffer, p: KdfParams): Promise<Buffer> {
  return scryptAsync(passphrase, salt, 32, { N: p.N, r: p.r, p: p.p, maxmem: 512 * 1024 * 1024 });
}

export function encryptWith(key: Buffer, text: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

export function decryptWith(key: Buffer, blob: string): string {
  const [v, iv, tag, data] = blob.split(':');
  if (v !== 'v1' || !iv || !tag || data === undefined) throw new Error('Unsupported secret format');
  // Require the full 128-bit tag: without authTagLength, a shortened (forgeable) tag would be accepted.
  const tagBuf = Buffer.from(tag, 'base64');
  if (tagBuf.length !== 16) throw new Error('Unsupported secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'), { authTagLength: 16 });
  decipher.setAuthTag(tagBuf);
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

function newSigningKey(): { privateDer: string; publicDer: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateDer: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    publicDer: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

/** Short, human-comparable fingerprint of a public key (first 16 bytes of the SHA-256 of the SPKI DER). */
export function publicKeyFingerprint(spkiBase64: string): string {
  const h = crypto.createHash('sha256').update(Buffer.from(spkiBase64, 'base64')).digest('hex').slice(0, 32);
  return h.match(/.{4}/g)!.join(':');
}

/** PEM form of a base64 SPKI DER public key. */
export function publicKeyPem(spkiBase64: string): string {
  return `-----BEGIN PUBLIC KEY-----\n${spkiBase64.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----\n`;
}

/** Checks an Ed25519 signature made by Vault.sign with a public key (base64 SPKI DER or PEM). */
export function verifySignature(publicKey: string, data: Buffer | string, signatureBase64: string): boolean {
  try {
    const key = publicKey.includes('BEGIN PUBLIC KEY')
      ? crypto.createPublicKey(publicKey)
      : crypto.createPublicKey({ key: Buffer.from(publicKey.trim(), 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(data), key, Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}

function writeFileAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export interface VaultInfo {
  initialized: boolean;
  unlocked: boolean;
  format?: 1 | 2;
  kdf?: KdfParams;
  keyId?: string;
  signingPublicKey?: string;
  fingerprint?: string;
  updatedAt?: string;
}

/** Re-encrypts every stored secret with a new data key, in one database transaction (see vault-rotation.ts). */
export type Reencrypt = (convert: (blob: string) => string, newKeyId: string) => void;

export class Vault {
  private keys: { dek: Buffer; audit: Buffer; integrity: Buffer; sign: crypto.KeyObject; keyId: string } | null = null;
  /** The database's record of the data key id (injected, so the vault does not depend on the database). */
  keyIdStore?: { get(): string | undefined; set(id: string): void };
  /** Set when the last unlock converted a format 1 vault (the caller records it in the audit log). */
  migratedFromV1 = false;

  constructor(private file: string) {}

  private get nextFile(): string {
    return `${this.file}.next`;
  }

  get initialized(): boolean {
    return fs.existsSync(this.file);
  }
  get unlocked(): boolean {
    return this.keys !== null;
  }

  private read(file = this.file): VaultFile {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as VaultFile;
  }

  /** Public information (works while locked). */
  info(): VaultInfo {
    if (!this.initialized) return { initialized: false, unlocked: false };
    const vf = this.read();
    if (vf.version === 1) return { initialized: true, unlocked: this.unlocked, format: 1, kdf: { N: vf.N, r: vf.r, p: vf.p } };
    return {
      initialized: true,
      unlocked: this.unlocked,
      format: 2,
      kdf: { N: vf.kdf.N, r: vf.kdf.r, p: vf.kdf.p },
      keyId: vf.keyId,
      signingPublicKey: vf.signingPublicKey,
      fingerprint: publicKeyFingerprint(vf.signingPublicKey),
      updatedAt: vf.updatedAt,
    };
  }

  private async wrap(passphrase: string, keys: VaultKeys, keyId: string, publicDer: string, createdAt: string): Promise<VaultFileV2> {
    const salt = crypto.randomBytes(16);
    const kek = await derive(passphrase, salt, KDF_DEFAULT);
    return {
      version: 2,
      kdf: { alg: 'scrypt', salt: salt.toString('base64'), ...KDF_DEFAULT },
      keyId,
      wrapped: encryptWith(kek, JSON.stringify(keys)),
      signingPublicKey: publicDer,
      createdAt,
      updatedAt: nowIso(),
    };
  }

  private load(keys: VaultKeys, keyId: string): void {
    this.keys = {
      dek: Buffer.from(keys.dek, 'base64'),
      audit: Buffer.from(keys.audit, 'base64'),
      integrity: Buffer.from(keys.integrity, 'base64'),
      sign: crypto.createPrivateKey({ key: Buffer.from(keys.sign, 'base64'), format: 'der', type: 'pkcs8' }),
      keyId,
    };
  }

  static checkNewPassphrase(passphrase: string): void {
    if (passphrase.length < PASSPHRASE_MIN_LENGTH) {
      throw new HttpError(400, `The master passphrase must have at least ${PASSPHRASE_MIN_LENGTH} characters`, 'PASSPHRASE_TOO_SHORT');
    }
  }

  async setup(passphrase: string): Promise<void> {
    if (this.initialized) throw new HttpError(409, 'Vault already initialized');
    Vault.checkNewPassphrase(passphrase);
    const sign = newSigningKey();
    const keys: VaultKeys = {
      dek: crypto.randomBytes(32).toString('base64'),
      audit: crypto.randomBytes(32).toString('base64'),
      integrity: crypto.randomBytes(32).toString('base64'),
      sign: sign.privateDer,
    };
    const keyId = newId('vk_');
    const vf = await this.wrap(passphrase, keys, keyId, sign.publicDer, nowIso());
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, JSON.stringify(vf, null, 2));
    this.load(keys, keyId);
    this.keyIdStore?.set(keyId);
  }

  /** Opens a format 2 file with the passphrase; null when the passphrase does not fit. */
  private async open(vf: VaultFileV2, passphrase: string): Promise<VaultKeys | null> {
    const kek = await derive(passphrase, Buffer.from(vf.kdf.salt, 'base64'), vf.kdf);
    try {
      return JSON.parse(decryptWith(kek, vf.wrapped)) as VaultKeys;
    } catch {
      return null;
    }
  }

  async unlock(passphrase: string): Promise<void> {
    if (!this.initialized) throw new HttpError(409, 'Vault not initialized');
    this.migratedFromV1 = false;
    const vf = this.read();
    if (vf.version === 1) return this.unlockV1(vf, passphrase);
    let keys = await this.open(vf, passphrase);
    let current: VaultFileV2 = vf;
    const dbKeyId = this.keyIdStore?.get();
    // An interrupted passphrase change leaves vault.json.next behind (see changePassphrase).
    if (fs.existsSync(this.nextFile)) {
      const next = this.read(this.nextFile) as VaultFileV2;
      const dataMoved = next.keyId !== vf.keyId && dbKeyId === next.keyId;
      if (next.keyId !== vf.keyId && !dataMoved) {
        fs.rmSync(this.nextFile, { force: true }); // the re-encryption was rolled back: the database still uses the old data key
      } else {
        const nextKeys = await this.open(next, passphrase);
        if (nextKeys) {
          fs.renameSync(this.nextFile, this.file); // complete the change
          keys = nextKeys;
          current = next;
        } else if (keys && dataMoved) {
          throw new HttpError(409, 'A change of the master passphrase was interrupted – unlock with the new passphrase', 'VAULT_CHANGE_INTERRUPTED');
        } else if (keys) {
          fs.rmSync(this.nextFile, { force: true }); // a passphrase-only change that never completed
        }
      }
    }
    if (!keys) throw new HttpError(401, 'Wrong passphrase', 'WRONG_PASSPHRASE');
    if (dbKeyId !== undefined && dbKeyId !== current.keyId) {
      throw new HttpError(
        409,
        `The vault file does not belong to this database (data key ${current.keyId}, the database expects ${dbKeyId}) – restore the matching vault.json`,
        'VAULT_MISMATCH',
      );
    }
    this.load(keys, current.keyId);
    if (dbKeyId === undefined) this.keyIdStore?.set(current.keyId);
  }

  private async unlockV1(vf: VaultFileV1, passphrase: string): Promise<void> {
    const key = await derive(passphrase, Buffer.from(vf.salt, 'base64'), vf);
    try {
      if (decryptWith(key, vf.check) !== CHECK_TEXT) throw new Error();
    } catch {
      throw new HttpError(401, 'Wrong passphrase', 'WRONG_PASSPHRASE');
    }
    // Convert to format 2: the old key stays the data key (stored secrets remain readable) and the audit
    // key is derived exactly as before, so the existing audit chain stays valid.
    const sign = newSigningKey();
    const keys: VaultKeys = {
      dek: key.toString('base64'),
      audit: Buffer.from(crypto.hkdfSync('sha256', key, Buffer.alloc(0), 'audit-chain', 32)).toString('base64'),
      integrity: crypto.randomBytes(32).toString('base64'),
      sign: sign.privateDer,
    };
    const keyId = newId('vk_');
    const next = await this.wrap(passphrase, keys, keyId, sign.publicDer, nowIso());
    const backup = `${this.file}.v1.bak`;
    fs.copyFileSync(this.file, backup);
    if (process.platform !== 'win32') fs.chmodSync(backup, 0o600);
    writeFileAtomic(this.file, JSON.stringify(next, null, 2));
    this.load(keys, keyId);
    this.keyIdStore?.set(keyId);
    this.migratedFromV1 = true;
  }

  /**
   * Changes the master passphrase (requires the current one). With `reencrypt`, a new data
   * key is generated and every stored secret re-encrypted in one database transaction.
   * Crash-safe: the new file is written as vault.json.next first and only replaces vault.json
   * after the database commit; unlock() completes or discards an interrupted change.
   */
  async changePassphrase(current: string, next: string, reencrypt?: Reencrypt): Promise<{ keyId: string; rotated: boolean }> {
    const k = this.requireKeys();
    Vault.checkNewPassphrase(next);
    if (current === next) throw new HttpError(400, 'Choose a new passphrase', 'SAME_PASSPHRASE');
    const vf = this.read();
    if (vf.version !== 2) throw new HttpError(409, 'Unlock the vault once before changing the passphrase');
    const keys = await this.open(vf, current);
    if (!keys) throw new HttpError(400, 'The current passphrase is wrong', 'WRONG_PASSPHRASE');
    const rotate = !!reencrypt;
    const newDek = rotate ? crypto.randomBytes(32) : Buffer.from(keys.dek, 'base64');
    const keyId = rotate ? newId('vk_') : vf.keyId;
    const nextKeys: VaultKeys = { ...keys, dek: newDek.toString('base64') };
    const nextFile = await this.wrap(next, nextKeys, keyId, vf.signingPublicKey, vf.createdAt);
    writeFileAtomic(this.nextFile, JSON.stringify(nextFile, null, 2));
    try {
      reencrypt?.((blob) => encryptWith(newDek, decryptWith(k.dek, blob)), keyId);
    } catch (e) {
      fs.rmSync(this.nextFile, { force: true });
      throw e;
    }
    fs.renameSync(this.nextFile, this.file);
    this.load(nextKeys, keyId);
    return { keyId, rotated: rotate };
  }

  lock(): void {
    this.keys = null;
  }

  private requireKeys() {
    if (!this.keys) throw new HttpError(423, 'Vault is locked', 'VAULT_LOCKED');
    return this.keys;
  }

  encrypt(value: unknown): string {
    return encryptWith(this.requireKeys().dek, JSON.stringify(value));
  }

  decrypt<T = unknown>(blob: string): T {
    return JSON.parse(decryptWith(this.requireKeys().dek, blob)) as T;
  }

  /** HMAC key of the audit chain (stable across passphrase changes and data key rotation). */
  auditKey(): Buffer {
    return this.requireKeys().audit;
  }

  /** HMAC key that authenticates non-secret configuration (stable across rotation). */
  integrityKey(): Buffer {
    return this.requireKeys().integrity;
  }

  /** Ed25519 signature (base64). The private key never leaves the vault. */
  sign(data: Buffer | string): string {
    return crypto.sign(null, Buffer.from(data), this.requireKeys().sign).toString('base64');
  }

  /** The checkpoint signing public key (base64 SPKI DER); undefined before setup and for a format 1 file. */
  signingPublicKey(): string | undefined {
    if (!this.initialized) return undefined;
    const vf = this.read();
    return vf.version === 2 ? vf.signingPublicKey : undefined;
  }
}

let vaultInstance: Vault | undefined;
export function vault(): Vault {
  if (!vaultInstance) vaultInstance = new Vault(path.join(config.dataDir, 'vault.json'));
  return vaultInstance;
}
export function setVault(v: Vault): void {
  vaultInstance = v;
}
