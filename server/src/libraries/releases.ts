import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONNECTOR_FORMATS,
  LIBRARY_LIMITS,
  LIBRARY_MANIFEST_FILE,
  LIBRARY_RELEASE_FILE,
  LIBRARY_SIGNATURE_FILE,
  LIBRARY_SIGNATURE_NAMESPACE,
  SYNC_KINDS,
  compareSemver,
  type LibraryItemKind,
  type LibraryRefusal,
  type LibraryReleaseSource,
  type LibraryReleaseState,
  type LibraryReleaseSummary,
  type ProcessDefinition,
} from '@sm/shared';
import { config } from '../config.js';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentActor } from '../auth/context.js';
import { HttpError, canonicalJson, newId, nowIso, parseJson, sha256 } from '../util.js';
import { findSecret } from '../credentials/secrets.js';
import { parseConnectorPackage } from '../platforms/connectors.js';
import { ZipFormatError, ZipLimitError, ZipReader, safeEntryName } from '../compliance/zip.js';
import { newerThan, parseData, parseFile } from '../sync/items.js';
import { issueList, isHiddenPath, libraryManifestSchema, releaseFileSchema, type LibraryManifest, type ReleaseFile } from './manifest.js';
import { parseSshSig, sshFingerprint, SshSigError, verifySshSig } from './sshsig.js';
import { keyStateOf, publisherName, trustedKeys, type TrustedKey } from './trust.js';

/**
 * Releases: verify a library folder against the trusted keys, stage it with Steward's own copy of its files, and
 * read that copy back (install, rollback – verified again each time). Nothing here applies an item.
 *
 * Verification (ADR 0014): release.json parses; release.json.sig is an SSHSIG signature in the namespace
 * `steward-library` by a trusted key of the release's publisher (active – retired keys only for copies staged
 * before; never revoked or expired); every file of the folder is listed with its size and SHA-256 and every listed
 * file is there (no extra, no missing file); the manifest agrees with release.json; every item parses with the Git
 * sync parser and holds no secret. A release that fails is not staged (library.release_refused).
 */

export type FileSet = Map<string, Buffer>;

export interface LibraryItem {
  path: string;
  kind: LibraryItemKind;
  identity: string;
  name: string;
  content: unknown;
  hash: string;
}

export interface VerifiedRelease {
  release: ReleaseFile;
  manifest: LibraryManifest;
  /** SHA-256 of release.json */
  sha256: string;
  key: TrustedKey;
  files: FileSet;
  items: LibraryItem[];
}

/** A refused release: 422 with the code; `detail` carries the English specifics (file, key) for the translated text. */
export function refusal(code: LibraryRefusal, message: string, ctx: Record<string, string | number> = {}): HttpError {
  return new HttpError(422, message, code, { detail: message.slice(0, 500), ...ctx });
}

/** Limits of a file set before anything is parsed. */
export function checkFileSet(files: FileSet): void {
  if (files.size > LIBRARY_LIMITS.maxFiles)
    throw refusal('LIBRARY_INVALID', `The library has ${files.size} files – more than the limit of ${LIBRARY_LIMITS.maxFiles}`);
  let total = 0;
  for (const [p, b] of files) {
    const max = p === LIBRARY_RELEASE_FILE ? LIBRARY_LIMITS.maxReleaseJsonBytes : LIBRARY_LIMITS.maxFileBytes;
    if (b.length > max) throw refusal('LIBRARY_INVALID', `${p} is ${b.length} bytes – larger than the limit of ${max}`);
    total += b.length;
  }
  if (total > LIBRARY_LIMITS.maxTotalBytes + LIBRARY_LIMITS.maxReleaseJsonBytes)
    throw refusal('LIBRARY_INVALID', `The files are larger than ${LIBRARY_LIMITS.maxTotalBytes} bytes together`);
}

const text = (b: Buffer) => b.toString('utf8');

/** release.json, the signature and the manifest – structure only, no trust. */
export function readReleaseFiles(files: FileSet): { release: ReleaseFile; releaseJson: Buffer; signature: string | null; manifest: LibraryManifest } {
  const releaseJson = files.get(LIBRARY_RELEASE_FILE);
  if (!releaseJson) throw refusal('LIBRARY_INVALID', `${LIBRARY_RELEASE_FILE} is missing – build the release with "steward library build"`);
  let raw: unknown;
  try {
    raw = JSON.parse(text(releaseJson));
  } catch (e) {
    throw refusal('LIBRARY_INVALID', `${LIBRARY_RELEASE_FILE}: not JSON (${(e as Error).message.slice(0, 200)})`);
  }
  const r = releaseFileSchema.safeParse(raw);
  if (!r.success) throw refusal('LIBRARY_INVALID', `${LIBRARY_RELEASE_FILE}: ${issueList(r.error.issues).join('; ')}`);
  const mText = files.get(LIBRARY_MANIFEST_FILE);
  if (!mText) throw refusal('LIBRARY_FILE_MISMATCH', `${LIBRARY_MANIFEST_FILE} is missing`);
  let mRaw: unknown;
  try {
    mRaw = parseData(text(mText), LIBRARY_MANIFEST_FILE);
  } catch (e) {
    throw refusal('LIBRARY_INVALID', `${LIBRARY_MANIFEST_FILE}: cannot parse (${(e as Error).message.slice(0, 200)})`);
  }
  const m = libraryManifestSchema.safeParse(mRaw);
  if (!m.success) throw refusal('LIBRARY_INVALID', `${LIBRARY_MANIFEST_FILE}: ${issueList(m.error.issues).join('; ')}`);
  const sig = files.get(LIBRARY_SIGNATURE_FILE);
  return { release: r.data, releaseJson, signature: sig ? text(sig) : null, manifest: m.data };
}

/**
 * The signature: by a trusted key of the release's publisher, over release.json, in the namespace steward-library.
 * `allowRetired`: Steward's own stored copy of a release (rollback, install of a release staged before the rotation).
 * `allowExpired`: only a rollback to a release that was installed before; an expired key stops every other install.
 */
export function checkSignature(
  release: ReleaseFile,
  releaseJson: Buffer,
  signature: string | null,
  o: { allowRetired?: boolean; allowExpired?: boolean; keys?: TrustedKey[]; today?: string } = {},
): TrustedKey {
  if (!signature) throw refusal('LIBRARY_SIGNATURE_INVALID', `${LIBRARY_SIGNATURE_FILE} is missing – the release is not signed`);
  let fingerprint: string;
  try {
    fingerprint = sshFingerprint(parseSshSig(signature).publicKey.blob);
  } catch (e) {
    throw refusal('LIBRARY_SIGNATURE_INVALID', `${LIBRARY_SIGNATURE_FILE}: ${(e as SshSigError).message}`);
  }
  const keys = o.keys ?? trustedKeys();
  const key = keys.find((k) => k.fingerprint === fingerprint);
  if (!key)
    throw refusal('LIBRARY_KEY_UNKNOWN', `The release is signed with the key ${fingerprint}, which is not a trusted key on this installation`, { fingerprint });
  try {
    verifySshSig(signature, releaseJson, LIBRARY_SIGNATURE_NAMESPACE, [key.blob]);
  } catch (e) {
    throw refusal('LIBRARY_SIGNATURE_INVALID', `The signature does not verify: ${(e as SshSigError).message}`, { fingerprint });
  }
  if (key.publisherId !== release.publisher)
    throw refusal('LIBRARY_KEY_UNKNOWN', `The key ${fingerprint} belongs to the publisher "${key.publisherId}", but the release names "${release.publisher}"`, {
      fingerprint,
      publisher: release.publisher,
    });
  if (key.state === 'revoked') throw refusal('LIBRARY_KEY_REVOKED', `The key ${fingerprint} of "${key.publisherName}" was revoked`, { fingerprint });
  if (key.state === 'retired' && !o.allowRetired)
    throw refusal('LIBRARY_KEY_RETIRED', `The key ${fingerprint} of "${key.publisherName}" was retired – new releases must be signed with its current key`, {
      fingerprint,
    });
  const today = o.today ?? new Date().toISOString().slice(0, 10);
  if (key.expiresAt && key.expiresAt < today && !o.allowExpired)
    throw refusal('LIBRARY_KEY_EXPIRED', `The key ${fingerprint} of "${key.publisherName}" expired on ${key.expiresAt}`, { fingerprint });
  if (key.libraries.length && !key.libraries.includes(release.library))
    throw refusal('LIBRARY_NOT_ALLOWED', `The publisher "${key.publisherName}" is trusted for ${key.libraries.join(', ')} only, not for "${release.library}"`, {
      library: release.library,
    });
  return key;
}

/** Every file listed with its size and SHA-256, and no file that is not listed (mix and match). */
export function checkListedFiles(release: ReleaseFile, files: FileSet): void {
  const listed = new Map(release.files.map((f) => [f.path, f]));
  for (const [p, b] of files) {
    if (p === LIBRARY_RELEASE_FILE || p === LIBRARY_SIGNATURE_FILE) continue;
    const f = listed.get(p);
    if (!f) throw refusal('LIBRARY_FILE_MISMATCH', `${p} is not listed in ${LIBRARY_RELEASE_FILE}`, { path: p.slice(0, 200) });
    if (f.size !== b.length || f.sha256 !== sha256(b))
      throw refusal('LIBRARY_FILE_MISMATCH', `${p} differs from the file the publisher signed (size or SHA-256)`, { path: p.slice(0, 200) });
  }
  for (const f of release.files)
    if (!files.has(f.path))
      throw refusal('LIBRARY_FILE_MISMATCH', `${f.path} is listed in ${LIBRARY_RELEASE_FILE} but missing`, { path: f.path.slice(0, 200) });
}

/** One item file with the Git sync parser (processes, dashboards, monitors, record types) or as a connector type. */
export async function parseLibraryItem(p: string, content: Buffer): Promise<{ ok: true; item: LibraryItem } | { ok: false; errors: string[] }> {
  const t = text(content);
  const secret = findSecret(t);
  if (secret) return { ok: false, errors: [`${p} looks like it contains ${secret} – credentials never belong in a library`] };
  let raw: unknown;
  try {
    raw = parseData(t, p);
  } catch (e) {
    return { ok: false, errors: [`${p}: cannot parse (${(e as Error).message.slice(0, 200)})`] };
  }
  if (raw && typeof raw === 'object' && (CONNECTOR_FORMATS as readonly unknown[]).includes((raw as { format?: unknown }).format)) {
    try {
      const pkg = parseConnectorPackage(raw);
      return { ok: true, item: { path: p, kind: 'connector', identity: pkg.kind, name: pkg.label, content: pkg, hash: sha256(canonicalJson(pkg)) } };
    } catch (e) {
      return { ok: false, errors: [`${p}: ${(e as Error).message.slice(0, 500)}`] };
    }
  }
  const r = await parseFile(p, t, [...SYNC_KINDS]);
  if (!r.ok) return { ok: false, errors: r.errors.map((e) => `${p}: ${e}`) };
  if (r.item.kind === 'process') {
    const pins = (r.item.content as ProcessDefinition).nodes.filter((n) => n.type === 'subprocess' && (n as { version?: number }).version !== undefined);
    if (pins.length)
      return {
        ok: false,
        errors: [
          `${p}: sub-process steps ${pins.map((n) => n.id).join(', ')} pin a version – version numbers are local; Steward pins the library's own child at install`,
        ],
      };
  }
  return { ok: true, item: { ...r.item, path: p } };
}

/** All items of the manifest, parsed; ids unique per kind. Collects every problem before refusing. */
export async function parseItems(manifest: LibraryManifest, files: FileSet): Promise<LibraryItem[]> {
  const errors: string[] = [];
  const items: LibraryItem[] = [];
  for (const p of manifest.items) {
    const b = files.get(p);
    if (!b) {
      errors.push(`${p} is listed in ${LIBRARY_MANIFEST_FILE} but not part of the release`);
      continue;
    }
    const r = await parseLibraryItem(p, b);
    if (r.ok) items.push(r.item);
    else errors.push(...r.errors);
  }
  const seen = new Map<string, string>();
  for (const it of items) {
    const k = `${it.kind}:${it.identity.toLowerCase()}`;
    const other = seen.get(k);
    if (other) errors.push(`${it.path} and ${other} are the same ${it.kind} "${it.identity}"`);
    seen.set(k, it.path);
  }
  if (errors.length) throw refusal('LIBRARY_INVALID', `The release has invalid items: ${errors.slice(0, 10).join('; ')}`, { count: errors.length });
  return items;
}

/** Verifies a whole release folder (see the module comment). */
export async function verifyRelease(files: FileSet, o: { allowRetired?: boolean; allowExpired?: boolean; keys?: TrustedKey[] } = {}): Promise<VerifiedRelease> {
  checkFileSet(files);
  const { release, releaseJson, signature, manifest } = readReleaseFiles(files);
  const key = checkSignature(release, releaseJson, signature, o);
  checkListedFiles(release, files);
  for (const k of ['library', 'publisher', 'release', 'steward_min_version'] as const)
    if (manifest[k] !== release[k])
      throw refusal('LIBRARY_INVALID', `${LIBRARY_MANIFEST_FILE} names ${k} "${manifest[k]}", ${LIBRARY_RELEASE_FILE} "${release[k]}"`);
  const items = await parseItems(manifest, files);
  const listed = new Map<string, Buffer>();
  for (const f of release.files) listed.set(f.path, files.get(f.path)!);
  listed.set(LIBRARY_RELEASE_FILE, releaseJson);
  listed.set(LIBRARY_SIGNATURE_FILE, Buffer.from(signature!, 'utf8'));
  return { release, manifest, sha256: sha256(releaseJson), key, files: listed, items };
}

// ---------- reading a release: a folder (CLI), an uploaded .zip ----------

/** A library folder on disk (CLI): every regular file below it except hidden ones, symbolic links refused. */
export function readFolder(dir: string): FileSet {
  const out: FileSet = new Map();
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (isHiddenPath(p)) continue;
      if (e.isSymbolicLink()) throw refusal('LIBRARY_INVALID', `${p} is a symbolic link – a library holds plain files only`);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        if (out.size >= LIBRARY_LIMITS.maxFiles) throw refusal('LIBRARY_INVALID', `The folder has more than ${LIBRARY_LIMITS.maxFiles} files`);
        const st = fs.statSync(path.join(dir, p));
        if (st.size > LIBRARY_LIMITS.maxReleaseJsonBytes) throw refusal('LIBRARY_INVALID', `${p} is ${st.size} bytes – too large for a library`);
        out.set(p, fs.readFileSync(path.join(dir, p)));
      }
    }
  };
  walk('');
  return out;
}

/**
 * An uploaded .zip of a library folder: read with ZipReader (well-formed archives only, bounded inflation) and
 * safeEntryName. When every entry sits in one top folder (a zip of the folder itself), that folder is dropped.
 * Hidden files and macOS resource forks are left out, as on build.
 */
export async function readZip(buf: Buffer): Promise<FileSet> {
  if (buf.length > LIBRARY_LIMITS.maxUploadBytes) throw refusal('LIBRARY_INVALID', `The file is larger than ${LIBRARY_LIMITS.maxUploadBytes} bytes`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-library-'));
  const file = path.join(dir, 'upload.zip');
  try {
    fs.writeFileSync(file, buf, { mode: 0o600 });
    const zip = await ZipReader.open(file);
    const names: { name: string; e: (typeof zip.entries)[number] }[] = [];
    for (const e of zip.entries) {
      if (e.name.endsWith('/')) continue;
      const name = safeEntryName(e.name);
      if (name.split('/')[0] === '__MACOSX') continue;
      names.push({ name, e });
    }
    const tops = new Set(names.map((n) => (n.name.includes('/') ? n.name.split('/')[0] : '')));
    const strip = tops.size === 1 && !tops.has('') && !names.some((n) => n.name === LIBRARY_MANIFEST_FILE) ? `${[...tops][0]}/` : '';
    const out: FileSet = new Map();
    let total = 0;
    for (const { name, e } of names) {
      const p = strip ? name.slice(strip.length) : name;
      if (isHiddenPath(p)) continue;
      if (out.size >= LIBRARY_LIMITS.maxFiles) throw refusal('LIBRARY_INVALID', `The archive has more than ${LIBRARY_LIMITS.maxFiles} files`);
      const max = p === LIBRARY_RELEASE_FILE ? LIBRARY_LIMITS.maxReleaseJsonBytes : LIBRARY_LIMITS.maxFileBytes;
      const b = await zip.read(e, max);
      total += b.length;
      if (total > LIBRARY_LIMITS.maxTotalBytes + LIBRARY_LIMITS.maxReleaseJsonBytes)
        throw refusal('LIBRARY_INVALID', `The files are larger than ${LIBRARY_LIMITS.maxTotalBytes} bytes together`);
      if (out.has(p)) throw refusal('LIBRARY_INVALID', `${p} is in the archive twice`);
      out.set(p, b);
    }
    return out;
  } catch (e) {
    if (e instanceof ZipFormatError || e instanceof ZipLimitError || (e instanceof Error && e.message.startsWith('Invalid entry name')))
      throw refusal('LIBRARY_INVALID', `Not a usable .zip of a library folder: ${e.message.slice(0, 300)}`);
    throw e;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- staging and the stored copy ----------

export interface ReleaseRow {
  id: string;
  library: string;
  publisher_id: string;
  release_version: string;
  name: string;
  steward_min_version: string;
  release_sha256: string;
  key_fingerprint: string;
  source: string;
  manifest: string;
  files: string;
  state: LibraryReleaseState;
  staged_at: string;
  staged_by: string;
  installed_at: string | null;
  installed_by: string | null;
  install_request: string | null;
}

export const RELEASE_ID_RE = /^lrl_[A-Za-z0-9_-]{8,40}$/;

export function releaseRow(id: string): ReleaseRow | undefined {
  return RELEASE_ID_RE.test(id) ? db().get<ReleaseRow>('SELECT * FROM library_releases WHERE id = ?', id) : undefined;
}

export function requireRelease(id: string): ReleaseRow {
  const r = releaseRow(id);
  if (!r) throw new HttpError(404, 'Library release not found', 'LIBRARY_RELEASE_NOT_FOUND');
  return r;
}

/** Steward's stored copy of a release's files (path → bytes). */
export function storedFiles(r: ReleaseRow): FileSet {
  return new Map(Object.entries(parseJson<Record<string, string>>(r.files, {})).map(([p, b64]) => [p, Buffer.from(b64, 'base64')]));
}

/** The stored copy, verified again (rollback and install never trust the database alone). */
/**
 * The stored copy, verified again (rollback and install never trust the database alone). Retired keys are accepted
 * (the copy was staged before the rotation); an expired key only for `rollback` (a release that was installed before)
 * or `review` (the page shows why it cannot be installed); a revoked key never.
 */
export async function verifyStored(r: ReleaseRow, o: { rollback?: boolean; review?: boolean } = {}): Promise<VerifiedRelease> {
  const v = await verifyRelease(storedFiles(r), { allowRetired: true, allowExpired: !!(o.rollback || o.review) });
  if (v.sha256 !== r.release_sha256 || v.release.library !== r.library || v.release.release !== r.release_version)
    throw refusal('LIBRARY_FILE_MISMATCH', 'The stored copy of the release does not match what was staged');
  return v;
}

export function toReleaseSummary(r: ReleaseRow): LibraryReleaseSummary {
  const manifest = parseJson<Partial<LibraryManifest>>(r.manifest, {});
  return {
    id: r.id,
    library: r.library,
    name: r.name,
    publisherId: r.publisher_id,
    publisherName: publisherName(r.publisher_id),
    release: r.release_version,
    state: r.state,
    sha256: r.release_sha256,
    keyFingerprint: r.key_fingerprint,
    keyState: keyStateOf(r.key_fingerprint),
    stewardMinVersion: r.steward_min_version,
    needsVersion: newerThan(r.steward_min_version, config.version) ? r.steward_min_version : null,
    source: parseJson<LibraryReleaseSource>(r.source, { type: 'upload', fileName: '', sha256: '' }),
    stagedAt: r.staged_at,
    stagedBy: r.staged_by,
    installedAt: r.installed_at,
    installedBy: r.installed_by,
    items: manifest.items?.length ?? 0,
    installRequest: r.install_request
      ? (({ by, at, rollback }) => ({ by, at, rollback: !!rollback }))(
          parseJson<{ by: string; at: string; rollback?: boolean }>(r.install_request, { by: '', at: '' }),
        )
      : null,
  };
}

/** The publisher a library is bound to: by its first install (or, before one, by the first release staged). */
export function boundPublisher(library: string): string | null {
  const i = db().get<{ publisher_id: string }>('SELECT publisher_id FROM library_installs WHERE library = ?', library);
  if (i) return i.publisher_id;
  return (
    db().get<{ publisher_id: string }>('SELECT publisher_id FROM library_releases WHERE library = ? ORDER BY staged_at LIMIT 1', library)?.publisher_id ?? null
  );
}

export function installedVersion(library: string): string | null {
  return (
    db().get<{ release_version: string }>(
      'SELECT r.release_version FROM library_installs i JOIN library_releases r ON r.id = i.release_id WHERE i.library = ?',
      library,
    )?.release_version ?? null
  );
}

export function auditRefused(e: HttpError, ctx: { via: string; library?: string; release?: string; sourceId?: string; actor?: string }): void {
  audit({
    ...(ctx.actor ? { actor: ctx.actor } : {}),
    action: 'library.release_refused',
    entityType: 'library',
    entityId: ctx.library ?? ctx.sourceId ?? 'upload',
    summary: `Library release${ctx.library ? ` ${ctx.library}` : ''}${ctx.release ? ` ${ctx.release}` : ''} refused (${ctx.via}): ${e.message.slice(0, 300)}`,
    details: { code: e.code ?? null, via: ctx.via, sourceId: ctx.sourceId ?? null, ...(e.params ?? {}) },
  });
}

/**
 * Stages a verified release: bound to its publisher, above the installed release (downgrades and replays are refused),
 * the same version never with other content. Older staged releases of the library are superseded.
 */
export function stageRelease(v: VerifiedRelease, source: LibraryReleaseSource, actor = currentActor()): { row: ReleaseRow; staged: boolean } {
  const { library, release } = v.release;
  const bound = boundPublisher(library);
  if (bound && bound !== v.release.publisher)
    throw refusal(
      'LIBRARY_PUBLISHER_CHANGED',
      `The library "${library}" belongs to the publisher "${bound}" – a release by "${v.release.publisher}" is refused`,
      {
        library,
        publisher: bound,
      },
    );
  const existing = db().get<ReleaseRow>('SELECT * FROM library_releases WHERE library = ? AND release_version = ?', library, release);
  if (existing) {
    if (existing.release_sha256 === v.sha256) return { row: existing, staged: false };
    throw refusal('LIBRARY_FILE_MISMATCH', `Release ${release} of "${library}" was staged before with other content – a release is never replaced`, {
      library,
      release,
    });
  }
  const installed = installedVersion(library);
  if (installed && (compareSemver(release, installed) ?? 0) <= 0)
    throw refusal('LIBRARY_DOWNGRADE', `Release ${release} is not newer than the installed release ${installed} of "${library}"`, {
      library,
      release,
      installed,
    });
  const id = newId('lrl_');
  const ts = nowIso();
  const files = Object.fromEntries([...v.files].map(([p, b]) => [p, b.toString('base64')]));
  // only the newest staged release waits; an older one arriving later is kept as superseded
  const staged = db().all<{ id: string; release_version: string }>(
    "SELECT id, release_version FROM library_releases WHERE library = ? AND state = 'staged'",
    library,
  );
  const newer = staged.some((s) => (compareSemver(s.release_version, release) ?? 0) > 0);
  db().tx(() => {
    if (!newer) for (const s of staged) db().run("UPDATE library_releases SET state = 'superseded' WHERE id = ?", s.id);
    db().run(
      `INSERT INTO library_releases (id, library, publisher_id, release_version, name, steward_min_version, release_sha256, key_fingerprint, source, manifest, files, state, staged_at, staged_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      library,
      v.release.publisher,
      release,
      v.manifest.name,
      v.release.steward_min_version,
      v.sha256,
      v.key.fingerprint,
      JSON.stringify(source),
      JSON.stringify(v.manifest),
      JSON.stringify(files),
      newer ? 'superseded' : 'staged',
      ts,
      actor,
    );
    audit({
      actor,
      action: 'library.release_staged',
      entityType: 'library',
      entityId: library,
      summary: `Library release ${library} ${release} (${v.release.publisher}) staged for review from ${source.type === 'git' ? `tag ${source.tag} of ${source.sourceName}` : `upload ${source.fileName}`} – signed with ${v.key.fingerprint}`,
      details: {
        releaseId: id,
        release,
        publisher: v.release.publisher,
        releaseSha256: v.sha256,
        keyFingerprint: v.key.fingerprint,
        source,
        items: v.items.map((i) => ({ path: i.path, kind: i.kind, id: i.identity })),
      },
    });
  });
  return { row: requireRelease(id), staged: true };
}

/** Upload: verify and stage (designers and administrators; nothing is installed). */
export async function stageUpload(fileName: string, buf: Buffer): Promise<LibraryReleaseSummary> {
  const name = path.basename(fileName || 'library.zip').slice(0, 200);
  const digest = crypto.createHash('sha256').update(buf).digest('hex');
  let v: VerifiedRelease | undefined;
  try {
    v = await verifyRelease(await readZip(buf));
    return toReleaseSummary(stageRelease(v, { type: 'upload', fileName: name, sha256: digest }).row);
  } catch (e) {
    if (e instanceof HttpError && e.statusCode === 422) auditRefused(e, { via: `upload ${name}`, library: v?.release.library, release: v?.release.release });
    throw e;
  }
}
