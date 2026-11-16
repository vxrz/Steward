import crypto from 'node:crypto';

/** Test certificates: self-signed, the DER written by hand (no openssl), the key generated per test run – no key file is committed. */

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let x = n; x > 0; x >>= 8) bytes.unshift(x & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, body: Buffer) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const time = (d: Date) => tlv(0x17, Buffer.from(d.toISOString().slice(2, 19).replace(/[-:T]/g, '') + 'Z', 'ascii'));
export function selfSigned(cn: string): { cert: string; key: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sha256WithRsa = seq(Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]), Buffer.from([0x05, 0x00]));
  const name = seq(tlv(0x31, seq(Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]), tlv(0x0c, Buffer.from(cn)))));
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, Buffer.from([0x42])),
    sha256WithRsa,
    name,
    seq(time(new Date(Date.now() - 86400000)), time(new Date(Date.now() + 365 * 86400000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const der = seq(tbs, sha256WithRsa, tlv(0x03, Buffer.concat([Buffer.from([0]), crypto.sign('sha256', tbs, privateKey)])));
  const b64 = der
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .trim();
  return { cert: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`, key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}
