import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { HttpError } from './util.js';

/**
 * Encrypts platform credentials at rest (AES-256-GCM).
 * The key is derived from a master passphrase (scrypt) and only kept in memory.
 */
interface VaultFile {
  version: 1;
  salt: string;
  N: number;
  r: number;
  p: number;
  check: string;
}

const CHECK_TEXT = 'service-manager-vault-v1';

export class Vault {
  private key: Buffer | null = null;
  constructor(private file: string) {}

  get initialized(): boolean {
    return fs.existsSync(this.file);
  }
  get unlocked(): boolean {
    return this.key !== null;
  }

  setup(passphrase: string): void {
    if (this.initialized) throw new HttpError(409, 'Vault already initialized');
    if (passphrase.length < 8) throw new HttpError(400, 'Passphrase must have at least 8 characters');
    const salt = crypto.randomBytes(16);
    const params = { N: 2 ** 15, r: 8, p: 1 };
    const key = derive(passphrase, salt, params);
    const vf: VaultFile = {
      version: 1,
      salt: salt.toString('base64'),
      ...params,
      check: encryptWith(key, CHECK_TEXT),
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(vf, null, 2), { mode: 0o600 });
    this.key = key;
  }

  unlock(passphrase: string): void {
    if (!this.initialized) throw new HttpError(409, 'Vault not initialized');
    const vf = JSON.parse(fs.readFileSync(this.file, 'utf8')) as VaultFile;
    const key = derive(passphrase, Buffer.from(vf.salt, 'base64'), vf);
    try {
      if (decryptWith(key, vf.check) !== CHECK_TEXT) throw new Error();
    } catch {
      throw new HttpError(401, 'Wrong passphrase', 'WRONG_PASSPHRASE');
    }
    this.key = key;
  }

  lock(): void {
    this.key = null;
  }

  private requireKey(): Buffer {
    if (!this.key) throw new HttpError(423, 'Vault is locked', 'VAULT_LOCKED');
    return this.key;
  }

  encrypt(value: unknown): string {
    return encryptWith(this.requireKey(), JSON.stringify(value));
  }

  decrypt<T = unknown>(blob: string): T {
    return JSON.parse(decryptWith(this.requireKey(), blob)) as T;
  }

  /** Separate key for signing the audit chain (HMAC). */
  auditKey(): Buffer {
    return Buffer.from(crypto.hkdfSync('sha256', this.requireKey(), Buffer.alloc(0), 'audit-chain', 32));
  }
}

function derive(passphrase: string, salt: Buffer, p: { N: number; r: number; p: number }): Buffer {
  return crypto.scryptSync(passphrase, salt, 32, { N: p.N, r: p.r, p: p.p, maxmem: 128 * 1024 * 1024 });
}

function encryptWith(key: Buffer, text: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

function decryptWith(key: Buffer, blob: string): string {
  const [v, iv, tag, data] = blob.split(':');
  if (v !== 'v1' || !iv || !tag || data === undefined) throw new Error('Unsupported secret format');
  // Require the full 128-bit tag: without authTagLength, a shortened (forgeable) tag would be accepted.
  const tagBuf = Buffer.from(tag, 'base64');
  if (tagBuf.length !== 16) throw new Error('Unsupported secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'), { authTagLength: 16 });
  decipher.setAuthTag(tagBuf);
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

let vaultInstance: Vault | undefined;
export function vault(): Vault {
  if (!vaultInstance) vaultInstance = new Vault(path.join(config.dataDir, 'vault.json'));
  return vaultInstance;
}
export function setVault(v: Vault): void {
  vaultInstance = v;
}
