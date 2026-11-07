import crypto from 'node:crypto';

/**
 * OpenSSH signatures (the SSHSIG format of `ssh-keygen -Y sign`, OpenSSH 8.1 or newer) checked with
 * Node's crypto – no new dependency, no ssh-keygen at run time.
 *
 * Format (PROTOCOL.sshsig in the OpenSSH sources):
 *
 *   armour    -----BEGIN SSH SIGNATURE----- / base64 / -----END SSH SIGNATURE-----
 *   blob      "SSHSIG" uint32(1) string(publickey) string(namespace) string(reserved) string(hash_algorithm) string(signature)
 *   signed    "SSHSIG" string(namespace) string(reserved) string(hash_algorithm) string(H(message))
 *
 * Keys: `ssh-ed25519` and `sk-ssh-ed25519@openssh.com` (a FIDO hardware key; PROTOCOL.u2f). A
 * hardware key's Ed25519 signature is over SHA256(application) ‖ flags ‖ uint32(counter) ‖
 * SHA256(signed), and Steward requires the user-presence flag. Other key types are refused.
 *
 * Every length is checked against the remaining bytes; nothing is trusted from the signature
 * except as input to the verification against a key the caller names.
 */

export const SSHSIG_ARMOUR_BEGIN = '-----BEGIN SSH SIGNATURE-----';
export const SSHSIG_ARMOUR_END = '-----END SSH SIGNATURE-----';
export const SSH_ED25519 = 'ssh-ed25519';
export const SK_SSH_ED25519 = 'sk-ssh-ed25519@openssh.com';
export type SshKeyType = typeof SSH_ED25519 | typeof SK_SSH_ED25519;
/** FIDO flag: the user touched the key. */
export const SK_USER_PRESENT = 0x01;
/** Armoured signatures are small (a few hundred bytes); anything far larger is not one. */
const MAX_ARMOUR_BYTES = 16 * 1024;

export class SshSigError extends Error {
  constructor(
    message: string,
    readonly code: 'SSHSIG_FORMAT' | 'SSHSIG_KEY_TYPE' | 'SSHSIG_NAMESPACE' | 'SSHSIG_HASH' | 'SSHSIG_USER_PRESENCE' | 'SSHSIG_INVALID' = 'SSHSIG_FORMAT',
  ) {
    super(message);
  }
}

/** A reader of SSH wire data (RFC 4251 section 5): uint32 big endian, string = uint32 length + bytes. */
class Wire {
  private at = 0;
  constructor(private readonly buf: Buffer) {}
  get done(): boolean {
    return this.at === this.buf.length;
  }
  bytes(n: number): Buffer {
    if (n < 0 || this.at + n > this.buf.length) throw new SshSigError('Truncated SSH data');
    const out = this.buf.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
  u8(): number {
    return this.bytes(1)[0]!;
  }
  u32(): number {
    return this.bytes(4).readUInt32BE(0);
  }
  string(): Buffer {
    return this.bytes(this.u32());
  }
  text(): string {
    const b = this.string();
    // names in SSH data are ASCII; anything else is not a signature Steward reads
    if (![...b].every((c) => c >= 0x20 && c < 0x7f)) throw new SshSigError('Unexpected characters in SSH data');
    return b.toString('ascii');
  }
}

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
};
const sshString = (v: Buffer | string) => {
  const b = Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8');
  return Buffer.concat([u32(b.length), b]);
};

export interface SshPublicKey {
  type: SshKeyType;
  /** The 32-byte Ed25519 public key */
  key: Buffer;
  /** Hardware keys: the FIDO application (normally "ssh:") */
  application?: string;
  /** The key in SSH wire format (what the fingerprint and the comparison use) */
  blob: Buffer;
}

/** Parses an SSH public key blob (wire format). */
export function parsePublicKeyBlob(blob: Buffer): SshPublicKey {
  const w = new Wire(blob);
  const type = w.text();
  if (type !== SSH_ED25519 && type !== SK_SSH_ED25519)
    throw new SshSigError(`Key type ${type.slice(0, 60)} is not supported – use ssh-ed25519 or sk-ssh-ed25519@openssh.com`, 'SSHSIG_KEY_TYPE');
  const key = w.string();
  if (key.length !== 32) throw new SshSigError('An Ed25519 public key has 32 bytes');
  const application = type === SK_SSH_ED25519 ? w.text() : undefined;
  if (!w.done) throw new SshSigError('Unexpected data after the public key');
  return { type, key: Buffer.from(key), ...(application !== undefined ? { application } : {}), blob: Buffer.from(blob) };
}

const KEY_LINE_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Parses one line of an OpenSSH public key file (`ssh-ed25519 AAAA… comment`, as in `id_ed25519.pub`
 * or `authorized_keys` without options). The type named in the line must match the blob.
 */
export function parsePublicKeyLine(line: string): SshPublicKey & { comment: string } {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2 || line.length > 2000) throw new SshSigError('Expected an OpenSSH public key line: "ssh-ed25519 AAAA… comment"');
  const [type, b64, ...rest] = parts as [string, string, ...string[]];
  if (type !== SSH_ED25519 && type !== SK_SSH_ED25519)
    throw new SshSigError(`Key type ${type.slice(0, 60)} is not supported – use ssh-ed25519 or sk-ssh-ed25519@openssh.com`, 'SSHSIG_KEY_TYPE');
  if (!KEY_LINE_BASE64.test(b64)) throw new SshSigError('The key is not valid base64');
  const k = parsePublicKeyBlob(Buffer.from(b64, 'base64'));
  if (k.type !== type) throw new SshSigError('The key type of the line does not match the key');
  return { ...k, comment: rest.join(' ').slice(0, 200) };
}

/** The key as an OpenSSH line without comment: `ssh-ed25519 AAAA…`. */
export const publicKeyLine = (k: Pick<SshPublicKey, 'type' | 'blob'>) => `${k.type} ${k.blob.toString('base64')}`;

/** The fingerprint `ssh-keygen -l` prints: `SHA256:` and the unpadded base64 of the SHA-256 of the key blob. */
export function sshFingerprint(blob: Buffer): string {
  return `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

export interface SshSignature {
  publicKey: SshPublicKey;
  namespace: string;
  hashAlgorithm: 'sha256' | 'sha512';
  /** The signature's own type (equals the key type) */
  signatureType: SshKeyType;
  /** Raw Ed25519 signature (64 bytes) */
  signature: Buffer;
  /** Hardware keys: FIDO flags and counter */
  flags?: number;
  counter?: number;
}

/** Removes the armour and decodes the base64 (lines of any length, LF or CRLF). */
export function dearmour(text: string): Buffer {
  if (text.length > MAX_ARMOUR_BYTES) throw new SshSigError('The signature file is too large');
  const lines = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines[0] !== SSHSIG_ARMOUR_BEGIN || lines.at(-1) !== SSHSIG_ARMOUR_END) throw new SshSigError('Not an SSH signature (armour missing)');
  const body = lines.slice(1, -1).join('');
  if (!body || !KEY_LINE_BASE64.test(body)) throw new SshSigError('The signature is not valid base64');
  return Buffer.from(body, 'base64');
}

/** Parses an armoured SSHSIG signature. Checks the structure only – `verifySshSig` checks the signature. */
export function parseSshSig(text: string): SshSignature {
  const w = new Wire(dearmour(text));
  if (w.bytes(6).toString('latin1') !== 'SSHSIG') throw new SshSigError('Not an SSH signature (magic)');
  const version = w.u32();
  if (version !== 1) throw new SshSigError(`SSH signature version ${version} is not supported`);
  const publicKey = parsePublicKeyBlob(w.string());
  const namespace = w.text();
  w.string(); // reserved: empty in every current version, signed as it is
  const hash = w.text();
  if (hash !== 'sha256' && hash !== 'sha512') throw new SshSigError(`Hash algorithm ${hash.slice(0, 30)} is not supported`, 'SSHSIG_HASH');
  const sigBlob = w.string();
  if (!w.done) throw new SshSigError('Unexpected data after the signature');
  const s = new Wire(sigBlob);
  const signatureType = s.text();
  if (signatureType !== publicKey.type) throw new SshSigError('The signature type does not match the key', 'SSHSIG_KEY_TYPE');
  const signature = Buffer.from(s.string());
  if (signature.length !== 64) throw new SshSigError('An Ed25519 signature has 64 bytes');
  let flags: number | undefined;
  let counter: number | undefined;
  if (signatureType === SK_SSH_ED25519) {
    flags = s.u8();
    counter = s.u32();
  }
  if (!s.done) throw new SshSigError('Unexpected data after the signature');
  return {
    publicKey,
    namespace,
    hashAlgorithm: hash,
    signatureType: signatureType as SshKeyType,
    signature,
    ...(flags !== undefined ? { flags, counter } : {}),
  };
}

/** The bytes the key signed: the SSHSIG preamble with the namespace and the hash of the message. */
export function signedData(namespace: string, hashAlgorithm: 'sha256' | 'sha512', message: Buffer, reserved = Buffer.alloc(0)): Buffer {
  const h = crypto.createHash(hashAlgorithm).update(message).digest();
  return Buffer.concat([Buffer.from('SSHSIG', 'latin1'), sshString(namespace), sshString(reserved), sshString(hashAlgorithm), sshString(h)]);
}

/** What a hardware key signs: SHA256(application) ‖ flags ‖ counter ‖ SHA256(data). */
export function skSignedData(application: string, flags: number, counter: number, data: Buffer): Buffer {
  return Buffer.concat([
    crypto.createHash('sha256').update(application, 'utf8').digest(),
    Buffer.from([flags & 0xff]),
    u32(counter),
    crypto.createHash('sha256').update(data).digest(),
  ]);
}

export function ed25519PublicKey(raw: Buffer): crypto.KeyObject {
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
}

export interface VerifiedSshSig {
  fingerprint: string;
  keyType: SshKeyType;
  hashAlgorithm: 'sha256' | 'sha512';
  /** Hardware keys: the FIDO counter */
  counter?: number;
}

/**
 * Verifies an armoured SSHSIG signature of `message` in `namespace` by one of `trusted` (key blobs).
 * The key inside the signature must be one of them (compared as wire blobs); the caller decides
 * what a key is trusted for. Throws SshSigError when anything does not hold.
 */
export function verifySshSig(armoured: string, message: Buffer, namespace: string, trusted: Buffer[]): VerifiedSshSig {
  const sig = parseSshSig(armoured);
  if (sig.namespace !== namespace)
    throw new SshSigError(`The signature is for namespace "${sig.namespace.slice(0, 60)}", not "${namespace}"`, 'SSHSIG_NAMESPACE');
  if (!trusted.some((t) => t.length === sig.publicKey.blob.length && crypto.timingSafeEqual(t, sig.publicKey.blob)))
    throw new SshSigError(`The signing key ${sshFingerprint(sig.publicKey.blob)} is not a trusted key`, 'SSHSIG_INVALID');
  let data = signedData(namespace, sig.hashAlgorithm, message);
  if (sig.signatureType === SK_SSH_ED25519) {
    if (!((sig.flags ?? 0) & SK_USER_PRESENT))
      throw new SshSigError('The hardware key signature was made without a touch (user presence)', 'SSHSIG_USER_PRESENCE');
    data = skSignedData(sig.publicKey.application ?? '', sig.flags ?? 0, sig.counter ?? 0, data);
  }
  let ok: boolean;
  try {
    ok = crypto.verify(null, data, ed25519PublicKey(sig.publicKey.key), sig.signature);
  } catch {
    ok = false; // a malformed key or signature is a failed verification, never an exception the caller has to know
  }
  if (!ok) throw new SshSigError('The signature does not match the file', 'SSHSIG_INVALID');
  return {
    fingerprint: sshFingerprint(sig.publicKey.blob),
    keyType: sig.signatureType,
    hashAlgorithm: sig.hashAlgorithm,
    ...(sig.counter !== undefined ? { counter: sig.counter } : {}),
  };
}

// ---------- writing (tests and the CLI's self-check only; Steward never holds a publisher's private key) ----------

/** The armoured form of a signature blob, wrapped at 70 characters like ssh-keygen. */
export function armour(blob: Buffer): string {
  return `${SSHSIG_ARMOUR_BEGIN}\n${(blob.toString('base64').match(/.{1,70}/g) ?? []).join('\n')}\n${SSHSIG_ARMOUR_END}\n`;
}

/** Builds an SSHSIG blob from its parts (for test vectors of hardware keys, which tests cannot touch). */
export function sshSigBlob(o: { publicKey: Buffer; namespace: string; hashAlgorithm: string; signature: Buffer; reserved?: Buffer; version?: number }): Buffer {
  return Buffer.concat([
    Buffer.from('SSHSIG', 'latin1'),
    u32(o.version ?? 1),
    sshString(o.publicKey),
    sshString(o.namespace),
    sshString(o.reserved ?? Buffer.alloc(0)),
    sshString(o.hashAlgorithm),
    sshString(o.signature),
  ]);
}

export const encodeSsh = { u32, string: sshString };
