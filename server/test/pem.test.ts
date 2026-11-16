import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isMultilineSecret } from '@sm/shared';
import { PEM_MAX_CHARS, dekInfoIvHexLength, normalizePem, pemPassphrase, readPrivateKey } from '../src/platforms/pem.js';
import { certificateThumbprints, privateKeyOf } from '../src/platforms/jwt.js';
import { selfSigned } from './certs.js';
import { timeLimit } from './time.js';

/**
 * PEM secrets pasted into a single-line field (0.26.2): the browser dropped the line breaks, so a key was stored on
 * one line and could not be read. normalizePem restores every block; keys are generated here, never committed.
 */

const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
const PASS = 'correct horse battery staple';

const fingerprint = (k: crypto.KeyObject) =>
  crypto
    .createHash('sha256')
    .update(crypto.createPublicKey(k).export({ type: 'spki', format: 'der' }))
    .digest('base64');

/** Every format the key-pair JWT accepts, with the passphrase it needs. */
const FORMATS: { name: string; key: crypto.KeyObject; pem: string; passphrase?: string }[] = [
  { name: 'PKCS#8', key: rsa, pem: rsa.export({ type: 'pkcs8', format: 'pem' }) as string },
  { name: 'PKCS#8 EC', key: ec, pem: ec.export({ type: 'pkcs8', format: 'pem' }) as string },
  {
    name: 'encrypted PKCS#8',
    key: rsa,
    pem: rsa.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: PASS }) as string,
    passphrase: PASS,
  },
  { name: 'PKCS#1', key: rsa, pem: rsa.export({ type: 'pkcs1', format: 'pem' }) as string },
  { name: 'SEC1 EC', key: ec, pem: ec.export({ type: 'sec1', format: 'pem' }) as string },
  ...(['aes-128-cbc', 'aes-192-cbc', 'aes-256-cbc', 'des-ede3-cbc'] as const).map((cipher) => ({
    name: `PKCS#1 ${cipher}`,
    key: rsa,
    pem: rsa.export({ type: 'pkcs1', format: 'pem', cipher, passphrase: PASS }) as string,
    passphrase: PASS,
  })),
];

const stripped = (pem: string) => pem.replace(/\r?\n/g, '');
const spaced = (pem: string) => pem.replace(/\r?\n/g, ' ');

describe('normalizePem', () => {
  it('keeps a well-formed PEM unchanged, also with CRLF', () => {
    for (const f of FORMATS) {
      expect(normalizePem(f.pem), f.name).toBe(f.pem);
      const crlf = f.pem.replace(/\n/g, '\r\n');
      expect(normalizePem(crlf), f.name).toBe(crlf);
    }
    expect(normalizePem('')).toBe('');
    expect(normalizePem('not a key')).toBe('not a key');
  });

  it('restores every format with the line breaks removed or replaced by spaces', () => {
    for (const f of FORMATS) {
      // OpenSSL cannot read it on one line – what the owner reported
      expect(() => crypto.createPrivateKey({ key: stripped(f.pem), format: 'pem', ...(f.passphrase ? { passphrase: f.passphrase } : {}) }), f.name).toThrow();
      for (const broken of [stripped(f.pem), spaced(f.pem), `  ${spaced(f.pem)}  `, f.pem.replace(/\n/g, '\r')]) {
        // the exact text of the file: BEGIN line, headers, an empty line, the body wrapped at 64 characters, END line
        expect(normalizePem(broken), f.name).toBe(f.pem);
        expect(fingerprint(readPrivateKey(broken, f.passphrase)), f.name).toBe(fingerprint(f.key));
      }
    }
  });

  it('finds the IV of a DEK-Info header by the cipher, also when the body starts with hex digits', () => {
    expect(dekInfoIvHexLength('AES-128-CBC')).toBe(32);
    expect(dekInfoIvHexLength('AES-256-CBC')).toBe(32);
    expect(dekInfoIvHexLength('DES-EDE3-CBC')).toBe(16);
    expect(dekInfoIvHexLength('DES-CBC')).toBe(16);
    expect(() => dekInfoIvHexLength('NO-SUCH-CIPHER')).toThrow(/cipher Steward does not know/);
    const iv = '0123456789ABCDEF0123456789ABCDEF';
    const body = 'ABCDEF0123456789abcdef+/'.repeat(4);
    const pem = `-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC,${iv}\n\n${body.slice(0, 64)}\n${body.slice(64)}\n-----END RSA PRIVATE KEY-----\n`;
    expect(normalizePem(stripped(pem))).toBe(pem);
    expect(normalizePem(spaced(pem))).toBe(pem);
    const des = pem.replace(`AES-256-CBC,${iv}`, 'DES-EDE3-CBC,0011223344556677');
    expect(normalizePem(stripped(des))).toBe(des);
    // headers that cannot be repaired say so, without the key
    expect(() => normalizePem(stripped(pem.replace(`AES-256-CBC,${iv}`, 'AES-256-CBC,0123')))).toThrow(/IV in the PEM header DEK-Info is not hexadecimal/);
    expect(() => normalizePem(stripped(pem.replace(/DEK-Info: .*\n/, '')))).toThrow(/no DEK-Info header/);
    expect(() => normalizePem('-----BEGIN PRIVATE KEY----- Comment: x MIIB -----END PRIVATE KEY-----')).toThrow(/header other than Proc-Type/);
    expect(() => normalizePem('-----BEGIN PRIVATE KEY----- MII*B -----END PRIVATE KEY-----')).toThrow(/The body of a PEM block is not base64/);
  });

  it('restores each block of a certificate chain', () => {
    const a = selfSigned('leaf.example').cert;
    const b = selfSigned('ca.example').cert;
    const chain = a + b;
    expect(normalizePem(chain)).toBe(chain);
    expect(normalizePem(stripped(chain))).toBe(chain);
    expect(normalizePem(spaced(chain))).toBe(chain);
    // one block broken, one intact: only the broken one is rebuilt, each starts on its own line
    expect(normalizePem(a + stripped(b))).toBe(chain);
    expect(normalizePem(stripped(a) + b)).toBe(chain);
    const thumbprints = certificateThumbprints(a);
    expect(certificateThumbprints(stripped(a))).toEqual(thumbprints);
    // text outside the blocks: whitespace is dropped, other text (openssl's "Bag Attributes") kept
    expect(normalizePem(`Bag Attributes friendlyName: leaf ${stripped(a)}`)).toBe(`Bag Attributes friendlyName: leaf \n${a}`);
  });

  it('refuses an oversized text, and a long hostile one takes linear time', () => {
    expect(() => normalizePem('A'.repeat(PEM_MAX_CHARS + 1))).toThrow(/too long \(max\. 64 KB\)/);
    const n = PEM_MAX_CHARS - 100;
    const hostile = [
      '-----BEGIN '.repeat(Math.floor(n / 11)),
      '-----BEGIN X-----'.repeat(Math.floor(n / 17)),
      `-----BEGIN PRIVATE KEY-----${'Proc-Type:'.repeat(Math.floor(n / 10) - 6)}`,
      `-----BEGIN RSA PRIVATE KEY-----Proc-Type: 4,ENCRYPTEDDEK-Info: ${'A'.repeat(n - 120)}-----END RSA PRIVATE KEY-----`,
      `-----BEGIN PRIVATE KEY-----${' '.repeat(n - 60)}x-----END PRIVATE KEY-----`,
      `${'-----BEGIN A----- '.repeat(Math.floor(n / 40))}${'-----END A-----'.repeat(Math.floor(n / 40))}`,
    ];
    const started = performance.now();
    for (const h of hostile) {
      expect(h.length).toBeLessThanOrEqual(PEM_MAX_CHARS);
      try {
        normalizePem(h);
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
      }
    }
    expect(performance.now() - started).toBeLessThan(timeLimit(250));
  });

  it('round trip: any key with its line breaks dropped or replaced reads as the same key', () => {
    for (let i = 0; i < 12; i++) {
      const k = crypto.generateKeyPairSync('ec', { namedCurve: i % 2 ? 'P-384' : 'P-256' }).privateKey;
      const encrypted = i % 3 === 0;
      const pem = k.export({
        type: i % 2 ? 'pkcs8' : 'sec1',
        format: 'pem',
        ...(encrypted ? { cipher: i % 4 ? 'aes-128-cbc' : 'des-ede3-cbc', passphrase: PASS } : {}),
      }) as string;
      // a random mix of what a browser or an editor makes of the line breaks
      const mangled = pem.replace(/\n/g, () => ['', ' ', '\t', '  ', '\r'][crypto.randomInt(5)]!);
      expect(fingerprint(readPrivateKey(mangled, encrypted ? PASS : undefined))).toBe(fingerprint(k));
    }
  });
});

describe('readPrivateKey', () => {
  const pkcs8Enc = FORMATS.find((f) => f.name === 'encrypted PKCS#8')!.pem;
  const pkcs1Enc = FORMATS.find((f) => f.name === 'PKCS#1 aes-256-cbc')!.pem;

  it('says what is wrong – never the key', () => {
    const message = (pem: string | undefined, pass?: string) => {
      try {
        readPrivateKey(pem, pass);
        return '';
      } catch (e) {
        return (e as Error).message;
      }
    };
    const body = rsa.export({ type: 'pkcs8', format: 'pem' }).toString().split('\n')[1]!;
    for (const pem of [pkcs8Enc, pkcs1Enc]) {
      const wrong = message(stripped(pem), 'wrong passphrase');
      expect(wrong).toMatch(/^The private key cannot be read \(secret privateKey\): the passphrase does not decrypt it – check the passphrase/);
      expect(message(stripped(pem))).toMatch(/it is encrypted and needs the secret privateKeyPassphrase/);
    }
    expect(message(undefined)).toBe('Secret "privateKey" (PEM) is not set');
    expect(message('  ')).toBe('Secret "privateKey" (PEM) is not set');
    const openssh = message('-----BEGIN OPENSSH PRIVATE KEY----- b3BlbnNzaC1rZXktdjEAAAAA -----END OPENSSH PRIVATE KEY-----');
    expect(openssh).toMatch(/this is an OpenSSH key – convert a copy of the key file to PEM with ssh-keygen -p -m PEM -f <copy>/);
    expect(message('PuTTY-User-Key-File-3: ssh-rsa\nEncryption: none')).toMatch(/PuTTY key/);
    const der = rsa.export({ type: 'pkcs8', format: 'der' }).toString('base64');
    const notPem = message(der);
    expect(notPem).toMatch(/PKCS#8 \(BEGIN PRIVATE KEY.*PKCS#1 \(BEGIN RSA PRIVATE KEY.*not an OpenSSH or PuTTY key, not DER/);
    expect(message(selfSigned('x.example').cert)).toMatch(/it holds CERTIFICATE, not a private key/);
    // an unknown label is not repeated: it could be part of a key
    expect(message('-----BEGIN MIIEVQIBADANBGKQHKIG-----\nAAAA\n-----END MIIEVQIBADANBGKQHKIG-----\n')).toMatch(/it holds no PEM block of a private key/);
    expect(message(`-----BEGIN PRIVATE KEY-----\nAAAA${body.slice(4)}\n-----END PRIVATE KEY-----\n`)).toMatch(/expected the text of a PEM file/);
    // no key material in any message
    for (const m of [notPem, openssh, message(stripped(pkcs8Enc), 'x'), message(`-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`)])
      expect(m).not.toContain(body.slice(10, 40));
    expect(notPem).not.toContain(der.slice(10, 40));
  });

  it('takes a passphrase pasted from a file: only a trailing CR/LF is dropped', () => {
    expect(pemPassphrase(undefined)).toBeUndefined();
    expect(pemPassphrase('\r\n')).toBeUndefined();
    expect(pemPassphrase(`${PASS}\r\n`)).toBe(PASS);
    expect(pemPassphrase(`${PASS}\n\n`)).toBe(PASS);
    // spaces and tabs are part of a passphrase
    expect(pemPassphrase(` ${PASS} \t\n`)).toBe(` ${PASS} \t`);
    expect(fingerprint(privateKeyOf(stripped(pkcs1Enc), `${PASS}\n`))).toBe(fingerprint(rsa));
    expect(() => privateKeyOf(stripped(pkcs1Enc), `${PASS} \n`)).toThrow(/check the passphrase/);
  });
});

describe('isMultilineSecret', () => {
  it('a PEM credential, a field marked multi-line, or a value with line breaks or a BEGIN line', () => {
    expect(isMultilineSecret('privateKey')).toBe(true);
    expect(isMultilineSecret(' tlsKey ')).toBe(true);
    expect(isMultilineSecret('password')).toBe(false);
    expect(isMultilineSecret('signingKey', '', [{ key: 'signingKey', multiline: true }])).toBe(true);
    expect(isMultilineSecret('signingKey', '-----BEGIN PRIVATE KEY-----')).toBe(true);
    expect(isMultilineSecret('note', 'a\nb')).toBe(true);
    expect(isMultilineSecret('token', 'abc')).toBe(false);
  });
});
