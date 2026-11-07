import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  armour,
  encodeSsh,
  parsePublicKeyLine,
  parseSshSig,
  signedData,
  skSignedData,
  sshFingerprint,
  sshSigBlob,
  verifySshSig,
  SK_SSH_ED25519,
} from '../src/libraries/sshsig.js';

/**
 * The SSHSIG parser against real `ssh-keygen -Y sign` output. The fixtures in test/fixtures/sshsig were
 * made with OpenSSH 9.6 (public keys and signatures only – the private test keys were thrown away):
 *
 *   ssh-keygen -t ed25519 -f a; ssh-keygen -Y sign -n steward-library -f a message.json            → a-sha512.sig
 *   ssh-keygen -Y sign -n steward-library -O hashalg=sha256 -f a message.json                        → a-sha256.sig
 *   ssh-keygen -Y sign -n git -f a message.json                                                       → a-git-namespace.sig
 *   ssh-keygen -t ed25519 -f b; ssh-keygen -Y sign -n steward-library -f b message.json            → b-sha512.sig
 *
 * Hardware keys (sk-ssh-ed25519) cannot be touched in a test: their signatures are built here with a
 * software Ed25519 key in the FIDO layout, and – where ssh-keygen is installed – checked with
 * `ssh-keygen -Y verify`, so the layout is OpenSSH's and not only ours.
 */

const FX = path.join(import.meta.dirname, 'fixtures', 'sshsig');
const read = (f: string) => fs.readFileSync(path.join(FX, f));
const NS = 'steward-library';
const message = read('message.json');
const keyA = parsePublicKeyLine(read('a.pub').toString('utf8'));
const keyB = parsePublicKeyLine(read('b.pub').toString('utf8'));
const hasSshKeygen = spawnSync('ssh-keygen', ['-?'], { stdio: 'ignore' }).error === undefined;

describe('SSHSIG from ssh-keygen', () => {
  it('reads the public key line and prints the fingerprint ssh-keygen -l prints', () => {
    expect(keyA.type).toBe('ssh-ed25519');
    expect(keyA.comment).toContain('test key');
    expect(sshFingerprint(keyA.blob)).toBe('SHA256:ogoXS961yWAfQamKgATrrMqqG/9lrKdjMpmGjl2G8P8');
  });

  it('verifies the default (sha512) and the sha256 signature', () => {
    for (const f of ['a-sha512.sig', 'a-sha256.sig']) {
      const r = verifySshSig(read(f).toString('utf8'), message, NS, [keyA.blob]);
      expect(r.fingerprint).toBe(sshFingerprint(keyA.blob));
      expect(r.keyType).toBe('ssh-ed25519');
      expect(r.hashAlgorithm).toBe(f.includes('256') ? 'sha256' : 'sha512');
    }
  });

  it('refuses a changed file', () => {
    const changed = Buffer.from(message.toString('utf8').replace('1.0.0', '1.0.1'));
    expect(() => verifySshSig(read('a-sha512.sig').toString('utf8'), changed, NS, [keyA.blob])).toThrow(/does not match/);
    expect(() => verifySshSig(read('a-sha512.sig').toString('utf8'), Buffer.concat([message, Buffer.from(' ')]), NS, [keyA.blob])).toThrow(/does not match/);
  });

  it('refuses another namespace (a Git commit signature made with the same key)', () => {
    expect(() => verifySshSig(read('a-git-namespace.sig').toString('utf8'), message, NS, [keyA.blob])).toThrow(
      expect.objectContaining({ code: 'SSHSIG_NAMESPACE' }),
    );
  });

  it('refuses a key that is not trusted, even with a good signature', () => {
    expect(() => verifySshSig(read('b-sha512.sig').toString('utf8'), message, NS, [keyA.blob])).toThrow(/not a trusted key/);
    expect(verifySshSig(read('b-sha512.sig').toString('utf8'), message, NS, [keyA.blob, keyB.blob]).fingerprint).toBe(sshFingerprint(keyB.blob));
    expect(() => verifySshSig(read('a-sha512.sig').toString('utf8'), message, NS, [])).toThrow(/not a trusted key/);
  });

  it('refuses a signature whose key was swapped for a trusted one', () => {
    // b's signature with a's key inside: the key is trusted, the signature is not a's
    const sig = parseSshSig(read('b-sha512.sig').toString('utf8'));
    const forged = armour(
      sshSigBlob({
        publicKey: keyA.blob,
        namespace: NS,
        hashAlgorithm: 'sha512',
        signature: Buffer.concat([encodeSsh.string('ssh-ed25519'), encodeSsh.string(sig.signature)]),
      }),
    );
    expect(() => verifySshSig(forged, message, NS, [keyA.blob])).toThrow(/does not match/);
  });

  it('refuses truncated and damaged armour', () => {
    const text = read('a-sha512.sig').toString('utf8');
    const lines = text.trim().split('\n');
    expect(() => verifySshSig(lines.slice(0, -1).join('\n'), message, NS, [keyA.blob])).toThrow(/armour/);
    expect(() => verifySshSig([lines[0], lines[1], lines.at(-1)].join('\n'), message, NS, [keyA.blob])).toThrow(/Truncated|base64/);
    expect(() => verifySshSig(text.replace('U1NIU0lH', 'U1NIU0lI'), message, NS, [keyA.blob])).toThrow(/magic/);
    expect(() => verifySshSig('', message, NS, [keyA.blob])).toThrow();
    expect(() => verifySshSig(text.replace(/\n-----END/, '!!\n-----END'), message, NS, [keyA.blob])).toThrow(/base64/);
    expect(() => verifySshSig('x'.repeat(20_000), message, NS, [keyA.blob])).toThrow(/too large/);
    // CRLF line ends are fine
    expect(verifySshSig(text.replace(/\n/g, '\r\n'), message, NS, [keyA.blob]).keyType).toBe('ssh-ed25519');
  });

  it('refuses other versions, hash algorithms, key types and trailing data', () => {
    const sig = parseSshSig(read('a-sha512.sig').toString('utf8'));
    const sigField = Buffer.concat([encodeSsh.string('ssh-ed25519'), encodeSsh.string(sig.signature)]);
    const base = { publicKey: keyA.blob, namespace: NS, hashAlgorithm: 'sha512', signature: sigField };
    expect(() => parseSshSig(armour(sshSigBlob({ ...base, version: 2 })))).toThrow(/version 2/);
    expect(() => parseSshSig(armour(sshSigBlob({ ...base, hashAlgorithm: 'sha1' })))).toThrow(/sha1/);
    expect(() => parseSshSig(armour(Buffer.concat([sshSigBlob(base), Buffer.from([0])])))).toThrow(/after the signature/);
    const rsaKey = Buffer.concat([encodeSsh.string('ssh-rsa'), encodeSsh.string(Buffer.from([1, 0, 1])), encodeSsh.string(Buffer.alloc(64))]);
    expect(() => parseSshSig(armour(sshSigBlob({ ...base, publicKey: rsaKey })))).toThrow(/ssh-rsa is not supported/);
    expect(() => parsePublicKeyLine('ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ comment')).toThrow(/not supported/);
    expect(() => parsePublicKeyLine(`sk-ssh-ed25519@openssh.com ${keyA.blob.toString('base64')}`)).toThrow(/does not match/);
    const wrongSigType = Buffer.concat([encodeSsh.string('ssh-rsa'), encodeSsh.string(sig.signature)]);
    expect(() => parseSshSig(armour(sshSigBlob({ ...base, signature: wrongSigType })))).toThrow(/does not match the key/);
  });
});

/** A software stand-in for a FIDO key: Ed25519 over the FIDO layout, as a hardware key signs. */
function skKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  const blob = Buffer.concat([encodeSsh.string(SK_SSH_ED25519), encodeSsh.string(raw), encodeSsh.string('ssh:')]);
  const sign = (msg: Buffer, flags: number, counter = 7, namespace = NS) => {
    const data = signedData(namespace, 'sha512', msg);
    const sig = crypto.sign(null, skSignedData('ssh:', flags, counter, data), privateKey);
    const sigField = Buffer.concat([encodeSsh.string(SK_SSH_ED25519), encodeSsh.string(sig), Buffer.from([flags]), encodeSsh.u32(counter)]);
    return armour(sshSigBlob({ publicKey: blob, namespace, hashAlgorithm: 'sha512', signature: sigField }));
  };
  return { blob, line: `${SK_SSH_ED25519} ${blob.toString('base64')} test-hardware-key`, sign };
}

describe('SSHSIG of hardware keys (sk-ssh-ed25519)', () => {
  it('verifies a signature with user presence and refuses one without', () => {
    const k = skKey();
    expect(parsePublicKeyLine(k.line).application).toBe('ssh:');
    const r = verifySshSig(k.sign(message, 0x01), message, NS, [k.blob]);
    expect(r).toMatchObject({ keyType: SK_SSH_ED25519, counter: 7 });
    expect(() => verifySshSig(k.sign(message, 0x00), message, NS, [k.blob])).toThrow(expect.objectContaining({ code: 'SSHSIG_USER_PRESENCE' }));
    // the flags are signed: setting the bit afterwards breaks the signature
    const noTouch = k.sign(message, 0x00);
    const blob = Buffer.from(noTouch.split('\n').slice(1, -2).join(''), 'base64');
    blob[blob.length - 5] = 0x01;
    expect(() => verifySshSig(armour(blob), message, NS, [k.blob])).toThrow(/does not match/);
    expect(() => verifySshSig(k.sign(message, 0x01), Buffer.from('other'), NS, [k.blob])).toThrow(/does not match/);
  });

  it.skipIf(!hasSshKeygen)('builds signatures in the layout ssh-keygen -Y verify accepts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-sshsig-'));
    try {
      const k = skKey();
      fs.writeFileSync(path.join(dir, 'allowed'), `publisher@test ${k.line}\n`);
      fs.writeFileSync(path.join(dir, 'msg'), message);
      fs.writeFileSync(path.join(dir, 'msg.sig'), k.sign(message, 0x01));
      const ok = spawnSync('ssh-keygen', ['-Y', 'verify', '-f', path.join(dir, 'allowed'), '-I', 'publisher@test', '-n', NS, '-s', path.join(dir, 'msg.sig')], {
        input: message,
      });
      expect(ok.status, ok.stderr.toString()).toBe(0);
      // (ssh-keygen -Y verify itself accepts an untouched signature; Steward is stricter and requires the touch, see above)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasSshKeygen)('verifies fresh ssh-keygen signatures of a new key (sha512 and sha256)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-sshsig-'));
    try {
      const key = path.join(dir, 'k');
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'throwaway', '-f', key]);
      const pub = parsePublicKeyLine(fs.readFileSync(`${key}.pub`, 'utf8'));
      const file = path.join(dir, 'release.json');
      for (const opts of [[], ['-O', 'hashalg=sha256']]) {
        fs.writeFileSync(file, `{"n":${Math.random()}}`);
        fs.rmSync(`${file}.sig`, { force: true });
        execFileSync('ssh-keygen', ['-Y', 'sign', '-n', NS, ...opts, '-f', key, file], { stdio: 'ignore' });
        expect(verifySshSig(fs.readFileSync(`${file}.sig`, 'utf8'), fs.readFileSync(file), NS, [pub.blob]).fingerprint).toBe(
          execFileSync('ssh-keygen', ['-l', '-f', `${key}.pub`])
            .toString()
            .split(' ')[1],
        );
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
