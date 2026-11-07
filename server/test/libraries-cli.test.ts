import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LIBRARY_RELEASE_FILE, LIBRARY_SIGNATURE_FILE } from '@sm/shared';
import { buildFolder, sign, testKey } from './library-helpers.js';

/**
 * `steward library` (build, verify, pack, schema), the example library under examples/libraries and its check in
 * `npm run validate`. Signing itself is ssh-keygen's (libraries-sshsig.test.ts checks its output).
 */

const ROOT = path.resolve(import.meta.dirname, '../..');
const EXAMPLE = path.join(ROOT, 'examples', 'libraries', 'example-access-reviews');
const TEST_KEY_FILE = path.join(ROOT, 'examples', 'libraries', 'TEST-PUBLISHER-KEY.pub');
let dir: string;
let output: string[];

async function run(...argv: string[]): Promise<number> {
  output = [];
  const w = (s: string | Uint8Array) => {
    output.push(String(s));
    return true;
  };
  const o = vi.spyOn(process.stdout, 'write').mockImplementation(w);
  const e = vi.spyOn(process.stderr, 'write').mockImplementation(w);
  try {
    const { main } = await import('../src/cli/library.js');
    return await main(argv);
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-library-cli-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function writeFolder(files: Map<string, Buffer>, to: string) {
  for (const [p, b] of files) {
    fs.mkdirSync(path.dirname(path.join(to, p)), { recursive: true });
    fs.writeFileSync(path.join(to, p), b);
  }
}

describe('npm run library', () => {
  it('builds release.json, verifies the signature with a given key and refuses a changed file', async () => {
    const key = testKey();
    const folder = path.join(dir, 'lib');
    const files = await buildFolder();
    files.delete(LIBRARY_RELEASE_FILE);
    writeFolder(files, folder);
    // hidden files are never part of a release
    fs.writeFileSync(path.join(folder, '.DS_Store'), 'x');
    expect(await run('build', folder)).toBe(0);
    const release = JSON.parse(fs.readFileSync(path.join(folder, LIBRARY_RELEASE_FILE), 'utf8'));
    expect(release).toMatchObject({ format: 'steward-library-release', library: 'test-access-reviews', release: '1.0.0' });
    expect(release.files.map((f: { path: string }) => f.path)).not.toContain('.DS_Store');
    // unsigned: no key, then a key that did not sign it
    expect(await run('verify', folder, '--key', testKey().line)).toBe(1);
    writeFolder(sign(new Map([[LIBRARY_RELEASE_FILE, fs.readFileSync(path.join(folder, LIBRARY_RELEASE_FILE))]]), key), folder);
    fs.writeFileSync(path.join(dir, 'k.pub'), `${key.line}\n`);
    expect(await run('verify', folder, '--key', path.join(dir, 'k.pub'))).toBe(0);
    expect(output.join('')).toContain(key.fingerprint);
    expect(await run('pack', folder, '-o', path.join(dir, 'lib.zip'))).toBe(0);
    expect(fs.statSync(path.join(dir, 'lib.zip')).size).toBeGreaterThan(100);
    fs.appendFileSync(path.join(folder, 'processes/notify-owner.yaml'), '\n# changed\n');
    expect(await run('verify', folder, '--key', path.join(dir, 'k.pub'))).toBe(1);
    expect(output.join('')).toMatch(/notify-owner\.yaml differs/);
    // a new build drops the old signature (it belongs to the old release.json)
    expect(await run('build', folder)).toBe(0);
    expect(fs.existsSync(path.join(folder, LIBRARY_SIGNATURE_FILE))).toBe(false);
  });

  it('answers usage errors with exit 2', async () => {
    expect(await run('frobnicate', dir)).toBe(2);
    expect(await run('build', path.join(dir, 'missing'))).toBe(2);
    expect(await run('sign', dir)).toBe(2);
  });

  it('keeps the published JSON Schema of the manifest up to date', async () => {
    expect(await run('schema', '--check'), 'docs/libraries/steward-library-1.schema.json is stale: npm run library -- schema').toBe(0);
  });
});

describe('the example library', () => {
  it('is signed with the test key, which is no built-in key', async () => {
    expect(await run('verify', EXAMPLE, '--key', TEST_KEY_FILE)).toBe(0);
    const { BUILT_IN_PUBLISHER_KEYS } = await import('@sm/shared');
    const test = fs.readFileSync(TEST_KEY_FILE, 'utf8');
    expect(test).toMatch(/TEST KEY/);
    for (const b of BUILT_IN_PUBLISHER_KEYS) expect(test).not.toContain(b.key.split(' ')[1]);
    // without a key (and no built-in key that signed it) it does not verify
    expect(await run('verify', EXAMPLE)).toBe(1);
  });

  it('is checked by npm run validate (items, release.json up to date, signature)', async () => {
    const { validateFile } = await import('../src/cli/validate.js');
    const r = await validateFile(path.join(EXAMPLE, 'steward-library.yaml'));
    expect(r).toMatchObject({ kind: 'library', ok: true, count: 4 });
    expect(r.warnings.join(' ')).toContain('TEST key');
    // an outdated release.json fails the check
    const copy = path.join(dir, 'example-copy', 'example-access-reviews');
    fs.cpSync(EXAMPLE, copy, { recursive: true });
    fs.appendFileSync(path.join(copy, 'README.md'), '\nmore\n');
    const bad = await validateFile(path.join(copy, 'steward-library.yaml'));
    expect(bad.ok).toBe(false);
    expect(bad.errors.join(' ')).toContain('outdated');
  });
});
