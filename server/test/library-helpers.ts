import crypto from 'node:crypto';
import YAML from 'yaml';
import { LIBRARY_RELEASE_FILE, LIBRARY_SIGNATURE_FILE, LIBRARY_SIGNATURE_NAMESPACE } from '@sm/shared';
import { armour, encodeSsh, signedData, skSignedData, sshFingerprint, sshSigBlob } from '../src/libraries/sshsig.js';
import type { FileSet } from '../src/libraries/releases.js';

/**
 * Library releases for the tests: a software Ed25519 key that signs in the SSHSIG format (the layout is checked
 * against real ssh-keygen output in libraries-sshsig.test.ts), and folders built with the same code as
 * `steward library build`. TEST KEYS ONLY – generated per test run, never trusted anywhere.
 *
 * The build code is imported when used: it loads the configuration, which startTestServer sets up first.
 */

export interface TestKey {
  line: string;
  fingerprint: string;
  sign(data: Buffer, o?: { namespace?: string; flags?: number }): string;
}

export function testKey(o: { hardware?: boolean; comment?: string } = {}): TestKey {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  const type = o.hardware ? 'sk-ssh-ed25519@openssh.com' : 'ssh-ed25519';
  const blob = Buffer.concat([encodeSsh.string(type), encodeSsh.string(raw), ...(o.hardware ? [encodeSsh.string('ssh:')] : [])]);
  return {
    line: `${type} ${blob.toString('base64')} ${o.comment ?? 'test key – never trusted'}`,
    fingerprint: sshFingerprint(blob),
    sign(data, s = {}) {
      const ns = s.namespace ?? LIBRARY_SIGNATURE_NAMESPACE;
      const signed = signedData(ns, 'sha512', data);
      let sig: Buffer;
      if (o.hardware) {
        const flags = s.flags ?? 0x01;
        const raw2 = crypto.sign(null, skSignedData('ssh:', flags, 1, signed), privateKey);
        sig = Buffer.concat([encodeSsh.string(type), encodeSsh.string(raw2), Buffer.from([flags]), encodeSsh.u32(1)]);
      } else sig = Buffer.concat([encodeSsh.string(type), encodeSsh.string(crypto.sign(null, signed, privateKey))]);
      return armour(sshSigBlob({ publicKey: blob, namespace: ns, hashAlgorithm: 'sha512', signature: sig }));
    },
  };
}

export const GUEST_REVIEW = `id: guest-review
name: Guest review (library)
description: Lists the guests of the tenant and removes the ones nobody keeps.
connections:
  - slot: graph
    kind: microsoft-graph
steps:
  - id: read
    type: http
    name: Guests
    connection: graph
    method: GET
    path: /v1.0/users
    saveAs: guests
  - id: tell
    type: subprocess
    name: Tell the owner
    process: notify-owner
  - id: publish
    type: publish
    name: Publish
    dataset: library.guests
    rows: "vars.guests.body.value"
`;

export const NOTIFY_OWNER = `id: notify-owner
name: Notify the owner (library)
steps:
  - id: log
    type: log
    name: Note
    message: The review is done.
`;

export const APP_CREDENTIALS = `kind: monitor
key: library-app-credentials
name: App credentials (library)
intervalSeconds: 3600
checks:
  - id: app-credentials
    name: App secrets
    type: entra
    platform: idp
    mode: app-credentials
    withinDays: 30
`;

export const EXCEPTION_TYPE = `kind: recordType
key: AEX
name: Access exception
description: An exception from an access rule (library).
workflow: decision
fields:
  - { key: owner, label: Owner, kind: text, required: true }
`;

export interface LibrarySpec {
  library?: string;
  publisher?: string;
  release?: string;
  name?: string;
  stewardMin?: string;
  items?: Record<string, string>;
  references?: { platforms?: { ref: string; kind?: string; description?: string }[]; processes?: { ref: string; description?: string }[] };
  extra?: Record<string, string>;
}

export const DEFAULT_ITEMS = {
  'processes/guest-review.yaml': GUEST_REVIEW,
  'processes/notify-owner.yaml': NOTIFY_OWNER,
  'monitors/app-credentials.yaml': APP_CREDENTIALS,
  'record-types/access-exception.yaml': EXCEPTION_TYPE,
};

/** A library folder (manifest + items) and its release.json, built like `steward library build`. Not signed. */
export async function buildFolder(spec: LibrarySpec = {}): Promise<FileSet> {
  const items = spec.items ?? DEFAULT_ITEMS;
  const manifest = {
    format: 'steward-library',
    version: 1,
    library: spec.library ?? 'test-access-reviews',
    name: spec.name ?? 'Access reviews (test)',
    publisher: spec.publisher ?? 'test-publisher',
    release: spec.release ?? '1.0.0',
    steward_min_version: spec.stewardMin ?? '0.1.0',
    licence: 'Apache-2.0',
    description: 'A library for the tests.',
    items: Object.keys(items),
    references: {
      platforms: spec.references?.platforms ?? [{ ref: 'idp', kind: 'microsoft-graph', description: 'The tenant' }],
      processes: spec.references?.processes ?? [],
    },
    changelog: [{ release: spec.release ?? '1.0.0', notes: 'Release for the tests.' }],
  };
  const files: FileSet = new Map([['steward-library.yaml', Buffer.from(YAML.stringify(manifest))]]);
  for (const [p, t] of Object.entries({ ...items, ...(spec.extra ?? {}) })) files.set(p, Buffer.from(t));
  const { buildRelease } = await import('../src/libraries/build.js');
  const built = await buildRelease(files);
  files.set(LIBRARY_RELEASE_FILE, Buffer.from(built.releaseJson));
  return files;
}

export function sign(files: FileSet, key: TestKey, o?: { namespace?: string; flags?: number }): FileSet {
  const out = new Map(files);
  out.set(LIBRARY_SIGNATURE_FILE, Buffer.from(key.sign(files.get(LIBRARY_RELEASE_FILE)!, o)));
  return out;
}

export async function signedRelease(key: TestKey, spec: LibrarySpec = {}): Promise<FileSet> {
  return sign(await buildFolder(spec), key);
}

/** The upload body of POST /api/library-releases/upload. */
export async function uploadBody(files: FileSet, fileName = 'library.zip'): Promise<{ fileName: string; content: string }> {
  const { zipBytes } = await import('../src/libraries/build.js');
  return { fileName, content: (await zipBytes(files)).toString('base64') };
}
