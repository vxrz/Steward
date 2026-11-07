import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { armour, encodeSsh, signedData, sshFingerprint, sshSigBlob } from '../../server/src/libraries/sshsig';
import { ZipWriter } from '../../server/src/compliance/zip';

/**
 * A signed library release for the UI tests (#238): a TEST key made per run (never trusted outside the test
 * server), release.json with the SHA-256 of every file, the SSHSIG signature, all of it as a .zip to upload.
 */

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
        )
      : v;

export function testKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  const blob = Buffer.concat([encodeSsh.string('ssh-ed25519'), encodeSsh.string(raw)]);
  return {
    line: `ssh-ed25519 ${blob.toString('base64')} e2e test key`,
    fingerprint: sshFingerprint(blob),
    sign(data: Buffer): string {
      const sig = crypto.sign(null, signedData('steward-library', 'sha512', data), privateKey);
      return armour(
        sshSigBlob({
          publicKey: blob,
          namespace: 'steward-library',
          hashAlgorithm: 'sha512',
          signature: Buffer.concat([encodeSsh.string('ssh-ed25519'), encodeSsh.string(sig)]),
        }),
      );
    },
  };
}

export async function signedZip(
  key: ReturnType<typeof testKey>,
  o: { library: string; publisher: string; release: string; name: string; items: Record<string, string> },
): Promise<Buffer> {
  const manifest = [
    'format: steward-library',
    'version: 1',
    `library: ${o.library}`,
    `name: ${o.name}`,
    `publisher: ${o.publisher}`,
    `release: ${o.release}`,
    'steward_min_version: 0.1.0',
    'licence: Apache-2.0',
    'description: A library of the UI tests.',
    'items:',
    ...Object.keys(o.items).map((p) => `  - ${p}`),
    'changelog:',
    `  - { release: ${o.release}, notes: Release of the UI tests. }`,
    '',
  ].join('\n');
  const files = new Map<string, Buffer>([
    ['steward-library.yaml', Buffer.from(manifest)],
    ...Object.entries(o.items).map(([p, t]) => [p, Buffer.from(t)] as [string, Buffer]),
  ]);
  const release = {
    format: 'steward-library-release',
    version: 1,
    library: o.library,
    publisher: o.publisher,
    release: o.release,
    steward_min_version: '0.1.0',
    files: [...files].map(([p, b]) => ({ path: p, size: b.length, sha256: sha(b) })).sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
  const releaseJson = Buffer.from(`${JSON.stringify(canonical(release))}\n`);
  files.set('release.json', releaseJson);
  files.set('release.json.sig', Buffer.from(key.sign(releaseJson)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-library-'));
  try {
    const out = path.join(dir, 'release.zip');
    const w = await ZipWriter.create(out);
    for (const [p, b] of files) await w.add(p, b, { compress: true });
    await w.finish();
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
