import crypto from 'node:crypto';

/**
 * A self-signed Ed25519 X.509 certificate built with node:crypto only (no
 * openssl): DER-encoded by hand, signed with a fresh key. For tests that need
 * a certificate with a chosen validity (e.g. one that expires in 10 days).
 */

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let x = n; x > 0; x >>= 8) bytes.unshift(x & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, body: Buffer) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
const int = (n: number) => {
  const bytes: number[] = [];
  for (let x = n; x > 0; x = Math.floor(x / 256)) bytes.unshift(x % 256);
  if (!bytes.length || bytes[0]! & 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
};
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));
const OID_ED25519 = Buffer.from([0x06, 0x03, 0x2b, 0x65, 0x70]);
const OID_CN = Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]);
const time = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, 'ascii'));
};

export function selfSignedCertificate(o: { commonName: string; notBefore?: Date; notAfter: Date; serial?: number }): {
  pem: string;
  der: Buffer;
  privateKeyPem: string;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const name = seq(set(seq(OID_CN, utf8(o.commonName))));
  const alg = seq(OID_ED25519);
  const tbs = seq(
    tlv(0xa0, int(2)),
    int(o.serial ?? 0x4242),
    alg,
    name,
    seq(time(o.notBefore ?? new Date(Date.now() - 86400000)), time(o.notAfter)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const sig = crypto.sign(null, tbs, privateKey);
  const der = seq(tbs, alg, tlv(0x03, Buffer.concat([Buffer.from([0]), sig])));
  const b64 = der
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .trim();
  return {
    pem: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`,
    der,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}
