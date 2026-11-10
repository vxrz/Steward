import { EVIDENCE_PACK_FORMAT, type AuditCheckpoint, type AuditEntry } from '@sm/shared';
import { DIGEST_SEED, checkpointPayload, digestStep } from '../audit.js';
import { publicKeyFingerprint, verifySignature } from '../vault.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { verifyArchive } from '../audit-archive-verify.js';
import { ZipFormatError, ZipReader, type ZipEntry } from './zip.js';

/**
 * Offline check of an evidence pack (no server, vault or database needed):
 *  1. manifest.json is signed (manifest.sig, Ed25519) by the key given with --public-key, by the key
 *     in public-key.pem when its fingerprint is the one given with --fingerprint, or by the key in
 *     public-key.pem at all. Only the first two prove the pack comes from the installation: anyone can
 *     sign a pack with a key of their own, so the third is "valid for an UNTRUSTED key" unless the
 *     auditor accepts the pack's key on purpose (--trust-pack-key, after comparing the fingerprint);
 *  2. every file listed in the manifest is in the ZIP with exactly that size and SHA-256, and the
 *     ZIP holds no other files (and no bytes outside its entries);
 *  3. the audit log excerpt (when present) is an unbroken chain whose public digest, continued from
 *     its start digest, reaches the signed checkpoint included in the pack.
 */

export const PACK_META_FILES = ['manifest.json', 'manifest.sig', 'public-key.pem'];
export const AUDIT_EXCERPT_FILE = 'audit/audit-log-excerpt.json';
/**
 * Manifests of version 2 are signed with this prefix (domain separation: the same key signs the audit
 * checkpoints, whose payload is canonical JSON and never starts with it). Version 1 manifests (packs
 * built before) were signed without a prefix and still verify.
 */
export const MANIFEST_SIGNATURE_DOMAIN = 'steward-evidence-manifest-v2\n';
/**
 * A signed statement of applicability (0.17.0, ADR 0029 part 2): the evidence-pack format and key, its own domain – a
 * manifest of kind "soa" is signed with this prefix, so an SoA signature never passes for an evidence pack's.
 */
export const SOA_SIGNATURE_DOMAIN = 'steward-soa-manifest-v1\n';

export interface PackManifest {
  format: typeof EVIDENCE_PACK_FORMAT;
  version: 1 | 2;
  /** "soa": a signed statement of applicability (signed under SOA_SIGNATURE_DOMAIN); absent: an evidence pack */
  kind?: 'soa';
  pack: Record<string, unknown> & { id: string; title: string; from: string; to: string; createdAt: string; createdBy: string };
  keyFingerprint: string;
  files: { path: string; size: number; sha256: string }[];
}

export interface AuditExcerpt {
  format: 'steward-audit-excerpt';
  version: 1;
  /** Digest of the public digest chain before the first entry of the excerpt */
  startDigest: string;
  entries: AuditEntry[];
  checkpoint: AuditCheckpoint | null;
  /**
   * Entries of the period that were archived and deleted from the database (0.4.0): their archives, oldest first; the
   * last one ends at the signed checkpoint the excerpt continues. `path`: the archive in the pack (null: not included,
   * e.g. the file was moved out of the data folder).
   */
  archives?: { file: string; path: string | null; firstSeq: number; lastSeq: number; sha256: string; checkpoint: AuditCheckpoint }[];
}

export interface PackVerifyResult {
  /** "soa": a signed statement of applicability; "pack": an evidence pack */
  kind?: 'pack' | 'soa';
  /** The pack is intact: signature valid for the key used, every file as listed, the audit excerpt reaches its checkpoint */
  ok: boolean;
  /** The key is one the auditor trusts: given with --public-key, the fingerprint given with --fingerprint, or accepted with --trust-pack-key */
  trusted: boolean;
  trust: 'public-key' | 'fingerprint' | 'pack-key-accepted' | 'untrusted';
  pack: PackManifest['pack'] | null;
  publicKey: { source: 'option' | 'pack'; fingerprint: string } | null;
  signatureOk: boolean;
  files: { listed: number; ok: number };
  audit: {
    present: boolean;
    ok: boolean;
    entries: number;
    checkpointSeq: number | null;
    message: string;
    /** Archives of the period in the pack (entries archived and deleted from the database) */
    archives?: { file: string; ok: boolean; message: string }[];
  } | null;
  problems: string[];
}

/** Checks the audit excerpt: chain linkage and the public digest up to the signed checkpoint. */
export function verifyExcerpt(x: AuditExcerpt, publicKey: string): { ok: boolean; message: string } {
  const cp = x.checkpoint;
  if (!cp) return { ok: false, message: 'The excerpt has no signed checkpoint' };
  const { signature, ...body } = cp;
  if (!signature || !verifySignature(publicKey, checkpointPayload(body), signature))
    return { ok: false, message: `The checkpoint #${cp.seq} signature is invalid for the pack key` };
  const entries = [...x.entries].sort((a, b) => a.seq - b.seq);
  if (!entries.length) return { ok: false, message: 'The excerpt has no entries' };
  if (entries[0]!.seq === 1 && x.startDigest !== DIGEST_SEED) return { ok: false, message: 'The start digest of an excerpt from entry #1 must be the seed' };
  let digest = x.startDigest;
  let prev: AuditEntry | undefined;
  for (const e of entries) {
    if (prev && e.seq !== prev.seq + 1) return { ok: false, message: `Entry #${prev.seq + 1} is missing from the excerpt` };
    if (prev && e.prevHash !== prev.hash) return { ok: false, message: `Entry #${e.seq} does not link to entry #${prev.seq}` };
    digest = digestStep(digest, e);
    if (e.seq === cp.seq) {
      if (e.hash !== cp.hash || digest !== cp.digest)
        return { ok: false, message: `Entries #${entries[0]!.seq}–#${cp.seq} differ from what checkpoint #${cp.seq} covers` };
      return { ok: true, message: `Entries #${entries[0]!.seq}–#${cp.seq} match the signed checkpoint of ${cp.ts}` };
    }
    prev = e;
  }
  return { ok: false, message: `The excerpt ends before the checkpoint entry #${cp.seq}` };
}

/**
 * The archives an excerpt names: each one in the pack verifies (signature, files, chain to its checkpoints), is the
 * archive the excerpt lists (SHA-256, end checkpoint), and they link up – each starts where the one before ends, the
 * last ends where the excerpt starts.
 */
async function verifyPackArchives(
  zip: ZipReader,
  x: AuditExcerpt,
  key: string,
  listed: Map<string, PackManifest['files'][number]>,
): Promise<{ results: { file: string; ok: boolean; message: string }[]; problems: string[] }> {
  const results: { file: string; ok: boolean; message: string }[] = [];
  const problems: string[] = [];
  const list = [...x.archives!].sort((a, b) => a.firstSeq - b.firstSeq);
  for (let i = 0; i < list.length; i++) {
    const a = list[i]!;
    const next = list[i + 1];
    if (next && next.firstSeq !== a.lastSeq + 1) problems.push(`${next.file} does not continue ${a.file}`);
    if (!next && (a.lastSeq + 1 !== x.entries[0]?.seq || a.checkpoint.digest !== x.startDigest || a.checkpoint.hash !== x.entries[0]?.prevHash))
      problems.push(`${a.file} does not end where the excerpt starts`);
    if (!a.path) {
      results.push({
        file: a.file,
        ok: true,
        message: `Entries #${a.firstSeq}–#${a.lastSeq} are in ${a.file} (not in the pack – verify it with steward audit verify-archive)`,
      });
      continue;
    }
    const e = zip.find(a.path);
    if (!e || listed.get(a.path)?.sha256 !== a.sha256) {
      problems.push(`${a.file} is not in the pack as listed`);
      results.push({ file: a.file, ok: false, message: 'missing or different' });
      continue;
    }
    // a folder of its own (mkdtemp: unique, mode 0700), removed with the archive afterwards
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-archive-'));
    const tmp = path.join(dir, 'archive.zip');
    try {
      await pipeline(await zip.stream(e), fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
      const v = await verifyArchive(tmp, { publicKey: key });
      const endOk = v.end?.seq === a.checkpoint.seq && v.end.hash === a.checkpoint.hash && v.end.digest === a.checkpoint.digest;
      if (!v.ok) problems.push(`${a.file}: ${v.message}`);
      else if (!endOk) problems.push(`${a.file} does not end at the checkpoint the excerpt names`);
      results.push({ file: a.file, ok: v.ok && endOk, message: v.message });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return { results, problems };
}

const pemToDer = (k: string) => (k.includes('BEGIN') ? k.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '') : k.trim());
/** Fingerprints compared as hex digits (colons, spaces and case do not matter). */
export const normFingerprint = (f: string): string => f.toLowerCase().replace(/[^0-9a-f]/g, '');

export interface VerifyOptions {
  /** The installation's public key (PEM or base64 SPKI) – the pack must be signed with it */
  publicKey?: string | null;
  /** The installation's key fingerprint – the key in the pack must have it */
  fingerprint?: string | null;
  /** Accept the key in the pack (the auditor compared its fingerprint some other way) */
  trustPackKey?: boolean;
}

export async function verifyPack(file: string, o: VerifyOptions = {}): Promise<PackVerifyResult> {
  const problems: string[] = [];
  const res: PackVerifyResult = {
    ok: false,
    trusted: false,
    trust: 'untrusted',
    pack: null,
    publicKey: null,
    signatureOk: false,
    files: { listed: 0, ok: 0 },
    audit: null,
    problems,
  };
  let zip: ZipReader;
  try {
    zip = await ZipReader.open(file);
  } catch (e) {
    if (!(e instanceof ZipFormatError)) throw e;
    problems.push(`The ZIP file is malformed: ${e.message}`);
    return res;
  }
  const get = (n: string) => zip.find(n);
  const manifestEntry = get('manifest.json');
  const sigEntry = get('manifest.sig');
  if (!manifestEntry || !sigEntry) {
    problems.push('manifest.json or manifest.sig is missing – this is not a Steward evidence pack');
    return res;
  }
  const manifestBytes = await zip.read(manifestEntry, 32 * 1024 * 1024);
  let manifest: PackManifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8')) as PackManifest;
  } catch {
    problems.push('manifest.json is not JSON');
    return res;
  }
  if (manifest.format !== EVIDENCE_PACK_FORMAT || !Array.isArray(manifest.files)) {
    problems.push('manifest.json is not an evidence pack manifest');
    return res;
  }
  if (manifest.version !== 1 && manifest.version !== 2) {
    problems.push(`manifest.json has the unknown version ${String(manifest.version).slice(0, 20)} – use a newer verifier`);
    return res;
  }
  res.pack = manifest.pack ?? null;
  res.kind = manifest.kind === 'soa' ? 'soa' : 'pack';
  const keyEntry = get('public-key.pem');
  const packKey = keyEntry ? (await zip.read(keyEntry, 16 * 1024)).toString('utf8') : null;
  const key = o.publicKey ?? packKey;
  if (!key) {
    problems.push('No public key: the pack has no public-key.pem – pass --public-key');
    return res;
  }
  let fingerprint: string;
  try {
    fingerprint = publicKeyFingerprint(pemToDer(key));
  } catch {
    problems.push('The public key cannot be read');
    return res;
  }
  res.publicKey = { source: o.publicKey ? 'option' : 'pack', fingerprint };
  if (o.publicKey) res.trust = 'public-key';
  else if (o.fingerprint) {
    if (normFingerprint(o.fingerprint) === normFingerprint(fingerprint)) res.trust = 'fingerprint';
    else problems.push(`The pack is signed with the key ${fingerprint}, not with the trusted key ${o.fingerprint}`);
  } else if (o.trustPackKey) res.trust = 'pack-key-accepted';
  const signature = (await zip.read(sigEntry, 16 * 1024)).toString('utf8').trim();
  if (manifest.kind !== undefined && manifest.kind !== 'soa') {
    problems.push(`manifest.json has the unknown kind ${String(manifest.kind).slice(0, 20)} – use a newer verifier`);
    return res;
  }
  // the kind is part of the signed bytes: a manifest cannot change its domain without breaking the signature
  const domain = manifest.kind === 'soa' ? SOA_SIGNATURE_DOMAIN : MANIFEST_SIGNATURE_DOMAIN;
  const signed = manifest.version === 1 && !manifest.kind ? manifestBytes : Buffer.concat([Buffer.from(domain, 'utf8'), manifestBytes]);
  res.signatureOk = verifySignature(key, signed, signature);
  if (!res.signatureOk) problems.push('The manifest signature is invalid for this public key (the manifest was changed or signed by another key)');
  if (manifest.keyFingerprint && manifest.keyFingerprint !== fingerprint)
    problems.push(`The manifest names key ${manifest.keyFingerprint}, the public key is ${fingerprint}`);

  const listed = new Map<string, PackManifest['files'][number]>();
  for (const f of manifest.files) {
    if (listed.has(f.path)) problems.push(`${f.path} is listed twice in the manifest`);
    listed.set(f.path, f);
  }
  res.files.listed = listed.size;
  const seen = new Set<string>();
  for (const e of zip.entries) {
    if (seen.has(e.name)) problems.push(`${e.name} appears twice in the ZIP file`);
    seen.add(e.name);
    if (PACK_META_FILES.includes(e.name)) continue;
    if (!listed.has(e.name)) problems.push(`${e.name} is in the pack but not in the signed manifest (added later)`);
  }
  for (const f of listed.values()) {
    const e: ZipEntry | undefined = get(f.path);
    if (!e) {
      problems.push(`${f.path} is listed in the manifest but missing from the pack`);
      continue;
    }
    if (e.usize !== f.size) {
      problems.push(`${f.path} was changed (its size differs from the manifest)`);
      continue;
    }
    try {
      const d = await zip.digest(e, Math.max(f.size, 0));
      if (d.size !== f.size || d.sha256 !== f.sha256) problems.push(`${f.path} was changed (SHA-256 or size differs from the manifest)`);
      else if (!d.crcOk) problems.push(`${f.path} is damaged (CRC)`);
      else res.files.ok++;
    } catch (err) {
      problems.push(`${f.path} cannot be read: ${(err as Error).message}`);
    }
  }

  const excerptEntry = get(AUDIT_EXCERPT_FILE);
  if (excerptEntry) {
    try {
      const x = JSON.parse((await zip.read(excerptEntry, 512 * 1024 * 1024)).toString('utf8')) as AuditExcerpt;
      const r = verifyExcerpt(x, key);
      res.audit = { present: true, ok: r.ok, entries: x.entries?.length ?? 0, checkpointSeq: x.checkpoint?.seq ?? null, message: r.message };
      if (!r.ok) problems.push(`Audit log excerpt: ${r.message}`);
      if (Array.isArray(x.archives) && x.archives.length) {
        const a = await verifyPackArchives(zip, x, key, listed);
        res.audit.archives = a.results;
        for (const p of a.problems) problems.push(`Audit archive: ${p}`);
        if (a.problems.length) res.audit.ok = false;
      }
    } catch (err) {
      res.audit = { present: true, ok: false, entries: 0, checkpointSeq: null, message: (err as Error).message };
      problems.push(`Audit log excerpt cannot be read: ${(err as Error).message}`);
    }
  }
  res.ok = problems.length === 0;
  res.trusted = res.ok && res.trust !== 'untrusted';
  return res;
}
