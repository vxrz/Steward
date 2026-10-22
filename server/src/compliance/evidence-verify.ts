import { EVIDENCE_PACK_FORMAT, type AuditCheckpoint, type AuditEntry } from '@sm/shared';
import { DIGEST_SEED, checkpointPayload, digestStep } from '../audit.js';
import { publicKeyFingerprint, verifySignature } from '../vault.js';
import { ZipReader, type ZipEntry } from './zip.js';

/**
 * Offline check of an evidence pack (no server, vault or database needed):
 *  1. manifest.json is signed (manifest.sig, Ed25519) by the key in public-key.pem – or by the key
 *     given with --public-key (compare the fingerprint with the one of your installation);
 *  2. every file listed in the manifest is in the ZIP with exactly that size and SHA-256, and the
 *     ZIP holds no other files;
 *  3. the audit log excerpt (when present) is an unbroken chain whose public digest, continued from
 *     its start digest, reaches the signed checkpoint included in the pack.
 */

export const PACK_META_FILES = ['manifest.json', 'manifest.sig', 'public-key.pem'];
export const AUDIT_EXCERPT_FILE = 'audit/audit-log-excerpt.json';

export interface PackManifest {
  format: typeof EVIDENCE_PACK_FORMAT;
  version: 1;
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
}

export interface PackVerifyResult {
  ok: boolean;
  pack: PackManifest['pack'] | null;
  publicKey: { source: 'option' | 'pack'; fingerprint: string } | null;
  signatureOk: boolean;
  files: { listed: number; ok: number };
  audit: { present: boolean; ok: boolean; entries: number; checkpointSeq: number | null; message: string } | null;
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

const pemToDer = (k: string) => (k.includes('BEGIN') ? k.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '') : k.trim());

export async function verifyPack(file: string, o: { publicKey?: string | null } = {}): Promise<PackVerifyResult> {
  const problems: string[] = [];
  const res: PackVerifyResult = { ok: false, pack: null, publicKey: null, signatureOk: false, files: { listed: 0, ok: 0 }, audit: null, problems };
  const zip = await ZipReader.open(file);
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
  res.pack = manifest.pack ?? null;
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
  const signature = (await zip.read(sigEntry, 16 * 1024)).toString('utf8').trim();
  res.signatureOk = verifySignature(key, manifestBytes, signature);
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
    } catch (err) {
      res.audit = { present: true, ok: false, entries: 0, checkpointSeq: null, message: (err as Error).message };
      problems.push(`Audit log excerpt cannot be read: ${(err as Error).message}`);
    }
  }
  res.ok = problems.length === 0;
  return res;
}
