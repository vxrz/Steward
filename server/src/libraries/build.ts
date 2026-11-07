import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LIBRARY_LIMITS, LIBRARY_MANIFEST_FILE, LIBRARY_RELEASE_FILE, LIBRARY_RELEASE_FORMAT, LIBRARY_SIGNATURE_FILE } from '@sm/shared';
import { HttpError, sha256 } from '../util.js';
import { findSecret } from '../credentials/secrets.js';
import { ZipWriter } from '../compliance/zip.js';
import { libraryPathProblem, releaseJsonText } from './manifest.js';
import { checkFileSet, checkListedFiles, parseItems, readReleaseFiles, type FileSet } from './releases.js';

/**
 * `steward library build`: checks every item of a library folder and writes release.json – canonical JSON with
 * format, library, publisher, release, steward_min_version and every file with its path, size and SHA-256 (the
 * manifest included). The publisher then signs it with `ssh-keygen -Y sign -n steward-library -f <key> release.json`.
 */

export interface BuildResult {
  releaseJson: string;
  files: number;
  items: number;
}

/** Builds release.json for a folder's files (release.json and its signature are left out of the listing). */
export async function buildRelease(files: FileSet): Promise<BuildResult> {
  const own = new Map([...files].filter(([p]) => p !== LIBRARY_RELEASE_FILE && p !== LIBRARY_SIGNATURE_FILE));
  checkFileSet(own);
  for (const [p, b] of own) {
    const problem = libraryPathProblem(p);
    if (problem) throw new HttpError(422, `${p}: ${problem}`, 'LIBRARY_INVALID');
    // every text file of the release, not only the items: a credential has no place in a README either
    const secret = findSecret(b.toString('utf8'));
    if (secret) throw new HttpError(422, `${p} looks like it contains ${secret} – credentials never belong in a library`, 'LIBRARY_INVALID');
  }
  if (!own.has(LIBRARY_MANIFEST_FILE)) throw new HttpError(422, `${LIBRARY_MANIFEST_FILE} is missing`, 'LIBRARY_INVALID');
  // the manifest is read the way a verifying installation reads it (with a placeholder release.json)
  const placeholder = JSON.stringify({
    format: LIBRARY_RELEASE_FORMAT,
    version: 1,
    library: 'x',
    publisher: 'x',
    release: '0.0.0',
    steward_min_version: '0.0.0',
    files: [{ path: LIBRARY_MANIFEST_FILE, size: 0, sha256: '0'.repeat(64) }],
  });
  const { manifest } = readReleaseFiles(new Map([...own, [LIBRARY_RELEASE_FILE, Buffer.from(placeholder)]]));
  const items = await parseItems(manifest, own);
  const releaseJson = releaseJsonText({
    format: LIBRARY_RELEASE_FORMAT,
    version: 1,
    library: manifest.library,
    publisher: manifest.publisher,
    release: manifest.release,
    steward_min_version: manifest.steward_min_version,
    files: [...own].map(([p, b]) => ({ path: p, size: b.length, sha256: sha256(b) })),
  });
  if (Buffer.byteLength(releaseJson) > LIBRARY_LIMITS.maxReleaseJsonBytes) throw new HttpError(422, 'release.json would be too large', 'LIBRARY_INVALID');
  // what is written must read back: the same checks as a verifying installation (except the signature)
  const { release } = readReleaseFiles(new Map([...own, [LIBRARY_RELEASE_FILE, Buffer.from(releaseJson)]]));
  checkListedFiles(release, own);
  return { releaseJson, files: own.size, items: items.length };
}

/** A .zip of a release (for the upload into an installation that cannot reach the Git host). */
export async function zipRelease(files: FileSet, out: string): Promise<void> {
  const w = await ZipWriter.create(out);
  try {
    for (const [p, b] of [...files].sort(([a], [b2]) => (a < b2 ? -1 : 1))) await w.add(p, b, { compress: true });
    await w.finish();
  } catch (e) {
    await w.abort();
    throw e;
  }
}

/** The .zip of a release as bytes (tests, the CLI's "pack"). */
export async function zipBytes(files: FileSet): Promise<Buffer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-library-zip-'));
  try {
    const f = path.join(dir, 'release.zip');
    await zipRelease(files, f);
    return fs.readFileSync(f);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
