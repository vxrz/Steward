import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { AuditCheckpoint, AuditEntry } from '@sm/shared';
import { DIGEST_SEED, GENESIS, checkpointPayload, digestStep } from './audit.js';
import { publicKeyFingerprint, verifySignature } from './vault.js';
import { ZipFormatError, ZipReader } from './compliance/zip.js';

/**
 * Offline check of an audit archive (server/src/audit-archive.ts) – no server, vault or database needed, like the check
 * of an evidence pack:
 *  1. manifest.json is signed (manifest.sig, Ed25519, with the domain prefix below) by the trusted key (--public-key,
 *     --fingerprint, or the key in public-key.pem accepted with --trust-pack-key; otherwise "valid for an UNTRUSTED key"),
 *  2. every file listed in the manifest is in the ZIP with that size and SHA-256, and there are no other files,
 *  3. the entries form an unbroken chain from the archive's start (the signed checkpoint it continues, or #1) – each
 *     links to its predecessor's hash – and the public digest, continued over them, reaches every signed checkpoint
 *     in the archive (the epoch boundaries) and the signed checkpoint at its end.
 * Several archives are also checked for continuity: each one starts where the previous one ends.
 */

export const ARCHIVE_FORMAT = 'steward-audit-archive';
/** Domain separation: the same key signs checkpoints and evidence pack manifests. */
export const ARCHIVE_SIGNATURE_DOMAIN = 'steward-audit-archive-v1\n';
export const ARCHIVE_ENTRIES = 'entries.jsonl';
export const ARCHIVE_CHECKPOINTS = 'checkpoints.json';
const META_FILES = ['manifest.json', 'manifest.sig', 'public-key.pem'];

export interface ArchiveManifest {
  format: typeof ARCHIVE_FORMAT;
  version: 1;
  archive: {
    id: string;
    firstSeq: number;
    lastSeq: number;
    firstTs: string;
    lastTs: string;
    entries: number;
    epochs: number;
    /** The hash entry #firstSeq links to (GENESIS for #1) */
    startHash: string;
    /** The public digest before entry #firstSeq (the seed for #1) */
    startDigest: string;
    createdAt: string;
    createdBy: string;
  };
  /** The signed checkpoint the archive continues (the previous archive's end); null when it starts at #1 */
  startCheckpoint: AuditCheckpoint | null;
  /** The signed checkpoint at entry #lastSeq */
  endCheckpoint: AuditCheckpoint;
  keyFingerprint: string;
  files: { path: string; size: number; sha256: string }[];
}

export interface ArchiveVerifyResult {
  file: string;
  ok: boolean;
  trusted: boolean;
  trust: 'public-key' | 'fingerprint' | 'pack-key-accepted' | 'untrusted';
  archive: ArchiveManifest['archive'] | null;
  publicKey: { source: 'option' | 'archive'; fingerprint: string } | null;
  signatureOk: boolean;
  files: { listed: number; ok: number };
  entries: number;
  checkpoints: { count: number; ok: number };
  /** Where the archive starts and ends (for the continuity of several archives) */
  start: { seq: number; hash: string; digest: string } | null;
  end: { seq: number; hash: string; digest: string } | null;
  message: string;
  problems: string[];
}

export interface ArchiveVerifyOptions {
  publicKey?: string | null;
  fingerprint?: string | null;
  trustPackKey?: boolean;
}

/** Fingerprints compared as hex digits (colons, spaces and case do not matter). */
const normFingerprint = (f: string): string => f.toLowerCase().replace(/[^0-9a-f]/g, '');
const pemToDer = (k: string) => (k.includes('BEGIN') ? k.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '') : k.trim());

function checkpointValid(c: AuditCheckpoint | null | undefined, key: string): boolean {
  if (!c || typeof c.seq !== 'number' || typeof c.signature !== 'string') return false;
  const { signature, ...body } = c;
  return verifySignature(key, checkpointPayload(body), signature);
}

/** Reads the lines of a (large) entry one by one, with the SHA-256 and size of its bytes. */
async function* lines(zip: ZipReader, name: string, out: { sha256?: string; size: number }): AsyncGenerator<string> {
  const e = zip.find(name)!;
  const hash = crypto.createHash('sha256');
  const decoder = new StringDecoder('utf8');
  let rest = '';
  for await (const chunk of (await zip.stream(e)) as AsyncIterable<Buffer>) {
    hash.update(chunk);
    out.size += chunk.length;
    const text = rest + decoder.write(chunk);
    let at = 0;
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', at)) {
      const line = text.slice(at, i);
      at = i + 1;
      if (line.trim()) yield line;
    }
    rest = text.slice(at);
  }
  rest += decoder.end();
  if (rest.trim()) yield rest;
  out.sha256 = hash.digest('hex');
}

export async function verifyArchive(file: string, o: ArchiveVerifyOptions = {}): Promise<ArchiveVerifyResult> {
  const problems: string[] = [];
  const res: ArchiveVerifyResult = {
    file,
    ok: false,
    trusted: false,
    trust: 'untrusted',
    archive: null,
    publicKey: null,
    signatureOk: false,
    files: { listed: 0, ok: 0 },
    entries: 0,
    checkpoints: { count: 0, ok: 0 },
    start: null,
    end: null,
    message: '',
    problems,
  };
  const done = (message: string) => {
    res.ok = problems.length === 0;
    res.trusted = res.ok && res.trust !== 'untrusted';
    res.message = res.ok ? message : problems[0]!;
    return res;
  };
  let zip: ZipReader;
  try {
    zip = await ZipReader.open(file);
  } catch (e) {
    if (!(e instanceof ZipFormatError)) throw e;
    problems.push(`The ZIP file is malformed: ${e.message}`);
    return done('');
  }
  const manifestEntry = zip.find('manifest.json');
  const sigEntry = zip.find('manifest.sig');
  if (!manifestEntry || !sigEntry) {
    problems.push('manifest.json or manifest.sig is missing – this is not a Steward audit archive');
    return done('');
  }
  const manifestBytes = await zip.read(manifestEntry, 4 * 1024 * 1024);
  let m: ArchiveManifest;
  try {
    m = JSON.parse(manifestBytes.toString('utf8')) as ArchiveManifest;
  } catch {
    problems.push('manifest.json is not JSON');
    return done('');
  }
  if (m.format !== ARCHIVE_FORMAT || !Array.isArray(m.files) || !m.archive || !m.endCheckpoint) {
    problems.push('manifest.json is not an audit archive manifest');
    return done('');
  }
  if (m.version !== 1) {
    problems.push(`manifest.json has the unknown version ${String(m.version).slice(0, 20)} – use a newer verifier`);
    return done('');
  }
  res.archive = m.archive;

  // 1. signature and trust
  const keyEntry = zip.find('public-key.pem');
  const packKey = keyEntry ? (await zip.read(keyEntry, 16 * 1024)).toString('utf8') : null;
  const key = o.publicKey ?? packKey;
  if (!key) {
    problems.push('No public key: the archive has no public-key.pem – pass --public-key');
    return done('');
  }
  let fingerprint: string;
  try {
    fingerprint = publicKeyFingerprint(pemToDer(key));
  } catch {
    problems.push('The public key cannot be read');
    return done('');
  }
  res.publicKey = { source: o.publicKey ? 'option' : 'archive', fingerprint };
  if (o.publicKey) res.trust = 'public-key';
  else if (o.fingerprint) {
    if (normFingerprint(o.fingerprint) === normFingerprint(fingerprint)) res.trust = 'fingerprint';
    else problems.push(`The archive is signed with the key ${fingerprint}, not with the trusted key ${o.fingerprint}`);
  } else if (o.trustPackKey) res.trust = 'pack-key-accepted';
  const signature = (await zip.read(sigEntry, 16 * 1024)).toString('utf8').trim();
  res.signatureOk = verifySignature(key, Buffer.concat([Buffer.from(ARCHIVE_SIGNATURE_DOMAIN, 'utf8'), manifestBytes]), signature);
  if (!res.signatureOk) problems.push('The manifest signature is invalid for this public key (the manifest was changed or signed by another key)');
  if (m.keyFingerprint && m.keyFingerprint !== fingerprint) problems.push(`The manifest names key ${m.keyFingerprint}, the public key is ${fingerprint}`);

  // 2. files
  const listed = new Map(m.files.map((f) => [f.path, f]));
  res.files.listed = listed.size;
  const seen = new Set<string>();
  for (const e of zip.entries) {
    if (seen.has(e.name)) problems.push(`${e.name} appears twice in the ZIP file`);
    seen.add(e.name);
    if (!META_FILES.includes(e.name) && !listed.has(e.name)) problems.push(`${e.name} is in the archive but not in the signed manifest (added later)`);
  }
  for (const f of listed.values()) {
    const e = zip.find(f.path);
    if (!e) problems.push(`${f.path} is listed in the manifest but missing from the archive`);
    else if (f.path !== ARCHIVE_ENTRIES) {
      const d = await zip.digest(e, Math.max(f.size, 0)).catch((err: Error) => ({ sha256: '', size: -1, crcOk: false, err }));
      if (d.sha256 !== f.sha256 || d.size !== f.size || !d.crcOk) problems.push(`${f.path} was changed (SHA-256 or size differs from the manifest)`);
      else res.files.ok++;
    }
  }
  if (!listed.has(ARCHIVE_ENTRIES) || !zip.find(ARCHIVE_ENTRIES)) {
    problems.push(`${ARCHIVE_ENTRIES} is missing`);
    return done('');
  }

  // 3. checkpoints and the chain
  const a = m.archive;
  const end = m.endCheckpoint;
  if (!checkpointValid(end, key)) problems.push(`The end checkpoint #${end.seq} has an invalid signature`);
  if (end.seq !== a.lastSeq) problems.push(`The end checkpoint covers entry #${end.seq}, the archive ends at #${a.lastSeq}`);
  if (a.firstSeq === 1) {
    if (a.startHash !== GENESIS || a.startDigest !== DIGEST_SEED)
      problems.push('An archive from entry #1 must start from the genesis hash and the seed digest');
    if (m.startCheckpoint) problems.push('An archive from entry #1 cannot continue a checkpoint');
  } else {
    const s = m.startCheckpoint;
    if (!s) problems.push(`The archive starts at entry #${a.firstSeq} but names no signed checkpoint it continues`);
    else if (!checkpointValid(s, key)) problems.push(`The start checkpoint #${s.seq} has an invalid signature`);
    else if (s.seq !== a.firstSeq - 1 || s.hash !== a.startHash || s.digest !== a.startDigest)
      problems.push(`The start checkpoint #${s.seq} does not match where the archive starts (entry #${a.firstSeq})`);
  }
  let checkpoints: AuditCheckpoint[] = [];
  const cpEntry = zip.find(ARCHIVE_CHECKPOINTS);
  if (cpEntry) {
    try {
      checkpoints = JSON.parse((await zip.read(cpEntry, 64 * 1024 * 1024)).toString('utf8')) as AuditCheckpoint[];
      if (!Array.isArray(checkpoints)) throw new Error('not a list');
    } catch (e) {
      problems.push(`${ARCHIVE_CHECKPOINTS} cannot be read: ${(e as Error).message}`);
      checkpoints = [];
    }
  }
  res.checkpoints.count = checkpoints.length;
  const bySeq = new Map<number, AuditCheckpoint[]>();
  for (const c of checkpoints) {
    if (!checkpointValid(c, key)) problems.push(`Checkpoint #${c?.seq} has an invalid signature`);
    else if (c.seq < a.firstSeq || c.seq > a.lastSeq) problems.push(`Checkpoint #${c.seq} lies outside the archive (#${a.firstSeq}–#${a.lastSeq})`);
    else bySeq.set(c.seq, [...(bySeq.get(c.seq) ?? []), c]);
  }
  let prev = { seq: a.firstSeq - 1, hash: a.startHash };
  let digest = a.startDigest;
  let chainProblem: string | null = null;
  const bytes = { size: 0 } as { sha256?: string; size: number };
  try {
    await walk();
  } catch (e) {
    problems.push(`${ARCHIVE_ENTRIES} cannot be read: ${(e as Error).message}`);
    return done('');
  }
  async function walk(): Promise<void> {
    for await (const line of lines(zip, ARCHIVE_ENTRIES, bytes)) {
      if (chainProblem) continue; // keep reading for the file's SHA-256
      let e: AuditEntry;
      try {
        e = JSON.parse(line) as AuditEntry;
      } catch {
        chainProblem = `Line ${res.entries + 1} of ${ARCHIVE_ENTRIES} is not JSON`;
        continue;
      }
      res.entries++;
      if (e.seq !== prev.seq + 1) chainProblem = `Entry #${prev.seq + 1} is missing from the archive`;
      else if (e.prevHash !== prev.hash) chainProblem = `Entry #${e.seq} does not link to entry #${prev.seq}`;
      else {
        digest = digestStep(digest, e);
        for (const c of bySeq.get(e.seq) ?? []) {
          if (c.hash !== e.hash || c.digest !== digest) chainProblem = `Entries up to #${e.seq} differ from what the signed checkpoint #${c.seq} covers`;
          else res.checkpoints.ok++;
        }
        prev = { seq: e.seq, hash: e.hash };
      }
    }
  }
  const ef = listed.get(ARCHIVE_ENTRIES)!;
  if (bytes.sha256 !== ef.sha256 || bytes.size !== ef.size) problems.push(`${ARCHIVE_ENTRIES} was changed (SHA-256 or size differs from the manifest)`);
  else res.files.ok++;
  if (chainProblem) problems.push(chainProblem);
  else if (prev.seq !== a.lastSeq) problems.push(`The archive ends at entry #${prev.seq}, not at #${a.lastSeq}`);
  else if (prev.hash !== end.hash || digest !== end.digest) problems.push(`Entries #${a.firstSeq}–#${a.lastSeq} differ from what the end checkpoint covers`);
  if (res.entries !== a.entries) problems.push(`The archive has ${res.entries} entries, the manifest says ${a.entries}`);
  res.start = { seq: a.firstSeq - 1, hash: a.startHash, digest: a.startDigest };
  res.end = { seq: end.seq, hash: end.hash, digest: end.digest };
  return done(
    `Entries #${a.firstSeq}–#${a.lastSeq} (${res.entries}) match the signed checkpoint of ${end.ts}${checkpoints.length ? ` and ${res.checkpoints.ok} epoch checkpoints` : ''}`,
  );
}

/** Several archives: each verified, and each starting where the one before it ends. */
export function continuityProblems(results: ArchiveVerifyResult[]): string[] {
  const out: string[] = [];
  const sorted = results.filter((r) => r.start && r.end).sort((x, y) => x.start!.seq - y.start!.seq);
  for (let i = 1; i < sorted.length; i++) {
    const p = sorted[i - 1]!;
    const n = sorted[i]!;
    if (n.start!.seq !== p.end!.seq)
      out.push(`${n.file} starts after entry #${n.start!.seq}, but ${p.file} ends at #${p.end!.seq} – archives are missing or overlap`);
    else if (n.start!.hash !== p.end!.hash || n.start!.digest !== p.end!.digest) out.push(`${n.file} does not continue ${p.file} (hash or digest differs)`);
  }
  return out;
}
