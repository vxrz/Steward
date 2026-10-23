/**
 * Offline check of an exported audit log against a signed checkpoint – no server, no vault,
 * no database needed. Run with --help for usage.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AuditCheckpoint, AuditEntry } from '@sm/shared';
import { DIGEST_SEED, GENESIS, checkpointPayload, digestStep } from '../audit.js';
import { publicKeyFingerprint, verifySignature } from '../vault.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, UsageError, palette, parseCli, usageFailure } from './args.js';
import { config } from '../config.js';

const COMMAND = 'npm run audit:verify-export --';

const HELP = `Check an exported Steward audit log offline against a signed checkpoint.

Usage:
  npm run audit:verify-export -- --file <export> [--public-key <key>] [--anchor <checkpoint> ...] [options]

The export is the JSON export of the audit page ("JSON with signed checkpoint",
GET /api/audit/export?format=json) or a JSON-lines export (then pass the checkpoint
with --anchor). Checks: the entries form an unbroken chain (sequence numbers and
previous-entry hashes), every checkpoint's Ed25519 signature is valid for the public key,
and the entries up to each checkpoint are exactly the ones it covers (SHA-256 digest).
The HMAC of each entry needs the vault key and is checked by the server (Audit log → Verify).

Options:
  --file <path>          The export (JSON or JSON lines); "-" reads standard input
  --public-key <key>     The installation's public key you trust: a PEM file, PEM text or base64;
                         default: the key inside the export (then compare its fingerprint yourself)
  --anchor <checkpoint>  A checkpoint kept elsewhere (SIEM line, e-mail, file); a path or the JSON
                         itself. Repeat for several. The export must contain that entry unchanged.
  --json                 Print the result as JSON
  -q, --quiet            Only print problems and the summary
  -h, --help             Show this help
  -V, --version          Print the version

Examples:
  npm run audit:verify-export -- --file audit-log.json --public-key steward-audit-public-key.pem
  npm run audit:verify-export -- --file audit-log.jsonl --anchor checkpoint-from-siem.json --public-key key.pem
  npm run --silent audit:verify-export -- --file audit-log.json --json > result.json

Exit status: 0 = the export is consistent with all checkpoints, 1 = a check failed,
2 = usage error or unreadable input.
`;

export interface VerifyExportResult {
  ok: boolean;
  entries: number;
  firstSeq: number | null;
  lastSeq: number | null;
  publicKey: { source: 'option' | 'export'; fingerprint: string } | null;
  checkpoints: { source: string; seq: number; ts?: string; ok: boolean; message: string }[];
  /** Entries after the newest valid checkpoint (not covered by a signature yet) */
  uncovered: number;
  problems: string[];
}

function readText(p: string): string {
  return p === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(p, 'utf8');
}

function parseExport(text: string): { entries: AuditEntry[]; checkpoint: AuditCheckpoint | null; publicKey: string | null } {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && !trimmed.includes('\n{')) {
    const doc = JSON.parse(trimmed) as { format?: string; entries?: AuditEntry[]; checkpoint?: AuditCheckpoint | null; publicKeyPem?: string | null };
    if (Array.isArray(doc.entries)) return { entries: doc.entries, checkpoint: doc.checkpoint ?? null, publicKey: doc.publicKeyPem ?? null };
  }
  const entries = trimmed
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l) as AuditEntry;
      } catch {
        throw new UsageError(`line ${i + 1} of the export is not JSON`);
      }
    });
  return { entries, checkpoint: null, publicKey: null };
}

function parseCheckpoint(text: string): AuditCheckpoint {
  const t = text.trim();
  for (const c of [t, ...t.split(/\r?\n/).filter(Boolean).reverse()]) {
    try {
      const v = JSON.parse(c) as Record<string, unknown>;
      const cp = (v.checkpoint ?? v.auditCheckpoint ?? (v.action === 'audit.checkpoint' ? v.details : v)) as AuditCheckpoint;
      if (cp && typeof cp.seq === 'number' && typeof cp.hash === 'string') return cp;
    } catch {
      /* next candidate */
    }
  }
  throw new UsageError('an --anchor is not a checkpoint (JSON with seq, hash, digest and signature)');
}

function readKey(v: string): string {
  if (v.includes('BEGIN PUBLIC KEY')) return v;
  if (fs.existsSync(v)) return fs.readFileSync(v, 'utf8');
  return v.trim();
}

export function verifyExport(input: {
  entries: AuditEntry[];
  checkpoints: { source: string; cp: AuditCheckpoint }[];
  publicKey: string | null;
  keySource: 'option' | 'export';
}): VerifyExportResult {
  const problems: string[] = [];
  const entries = [...input.entries].sort((a, b) => a.seq - b.seq);
  const bySeq = new Map(entries.map((e) => [e.seq, e]));
  // chain linkage and the public digest up to each entry
  const digests = new Map<number, string>();
  let digest = DIGEST_SEED;
  let prev: AuditEntry | undefined;
  let chainOk = entries.length === 0 || entries[0]!.seq === 1;
  if (entries.length && entries[0]!.seq !== 1) problems.push(`The export starts at entry #${entries[0]!.seq}, not #1 – checkpoints cannot be checked`);
  for (const e of entries) {
    if (prev && e.seq !== prev.seq + 1) {
      problems.push(`Entry #${prev.seq + 1} is missing`);
      chainOk = false;
      break;
    }
    const expectedPrev = prev ? prev.hash : GENESIS;
    if (e.prevHash !== undefined && e.prevHash !== expectedPrev) {
      problems.push(`Entry #${e.seq} does not link to entry #${e.seq - 1} (prevHash differs)`);
      chainOk = false;
      break;
    }
    if (e.prevHash === undefined) {
      problems.push('The export has no prevHash fields – export it again with this version');
      chainOk = false;
      break;
    }
    digest = digestStep(digest, e);
    digests.set(e.seq, digest);
    prev = e;
  }
  const key = input.publicKey;
  let fingerprint: string | null = null;
  if (key) {
    try {
      const der = key.includes('BEGIN') ? key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '') : key;
      fingerprint = publicKeyFingerprint(der);
    } catch {
      problems.push('The public key cannot be read');
    }
  } else problems.push('No public key: pass --public-key (or use the JSON export, which contains it)');
  const results: VerifyExportResult['checkpoints'] = [];
  let covered = 0;
  for (const { source, cp } of input.checkpoints) {
    const fail = (message: string) => {
      results.push({ source, seq: cp.seq, ts: cp.ts, ok: false, message });
      problems.push(`${source}: ${message}`);
    };
    const { signature, ...body } = cp;
    if (!key || !signature || !verifySignature(key, checkpointPayload(body), signature)) {
      fail(`checkpoint #${cp.seq}: the signature is invalid for this public key`);
      continue;
    }
    if (fingerprint && cp.keyFingerprint && cp.keyFingerprint !== fingerprint) {
      fail(`checkpoint #${cp.seq} names key ${cp.keyFingerprint}, the public key is ${fingerprint}`);
      continue;
    }
    const e = bySeq.get(cp.seq);
    if (!e) {
      fail(`entry #${cp.seq} is not in the export – entries were removed (the export ends at #${entries.at(-1)?.seq ?? 0})`);
      continue;
    }
    if (e.hash !== cp.hash) {
      fail(`entry #${cp.seq} differs from the checkpoint (hash)`);
      continue;
    }
    if (!chainOk || digests.get(cp.seq) !== cp.digest) {
      fail(`entries 1–${cp.seq} differ from what the checkpoint covers (digest)`);
      continue;
    }
    if (cp.count !== cp.seq) {
      fail(`checkpoint #${cp.seq} counts ${cp.count} entries`);
      continue;
    }
    covered = Math.max(covered, cp.seq);
    results.push({ source, seq: cp.seq, ts: cp.ts, ok: true, message: `entries 1–${cp.seq} match the signed checkpoint of ${cp.ts}` });
  }
  if (!input.checkpoints.length) problems.push('No checkpoint to check against: use the JSON export or pass --anchor');
  const lastSeq = entries.at(-1)?.seq ?? null;
  return {
    ok: problems.length === 0,
    entries: entries.length,
    firstSeq: entries[0]?.seq ?? null,
    lastSeq,
    publicKey: fingerprint ? { source: input.keySource, fingerprint } : null,
    checkpoints: results,
    uncovered: lastSeq === null ? 0 : lastSeq - covered,
    problems,
  };
}

export function main(argv = process.argv.slice(2)): number {
  let values;
  try {
    ({ values } = parseCli(argv, {
      file: { type: 'string' },
      'public-key': { type: 'string' },
      anchor: { type: 'string', multiple: true },
      json: { type: 'boolean' },
      quiet: { type: 'boolean', short: 'q' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'V' },
    }));
  } catch (e) {
    if (e instanceof UsageError) return usageFailure(e, COMMAND);
    throw e;
  }
  if (values.help) {
    process.stdout.write(HELP);
    return EXIT_OK;
  }
  if (values.version) {
    console.log(config.version);
    return EXIT_OK;
  }
  try {
    if (!values.file) throw new UsageError('--file is required', 'Pass the export, e.g. --file audit-log.json');
    let exported;
    try {
      exported = parseExport(readText(values.file));
    } catch (e) {
      if (e instanceof UsageError) throw e;
      throw new UsageError(`cannot read ${values.file}: ${(e as Error).message}`);
    }
    const checkpoints: { source: string; cp: AuditCheckpoint }[] = [];
    if (exported.checkpoint) checkpoints.push({ source: 'checkpoint in the export', cp: exported.checkpoint });
    for (const a of values.anchor ?? []) {
      let text: string;
      try {
        text = fs.existsSync(a) ? fs.readFileSync(a, 'utf8') : a;
      } catch (e) {
        throw new UsageError(`cannot read --anchor ${a}: ${(e as Error).message}`);
      }
      checkpoints.push({ source: fs.existsSync(a) ? `anchor ${a}` : 'anchor', cp: parseCheckpoint(text) });
    }
    const optionKey = values['public-key'] ? readKey(values['public-key']) : null;
    const result = verifyExport({
      entries: exported.entries,
      checkpoints,
      publicKey: optionKey ?? exported.publicKey,
      keySource: optionKey ? 'option' : 'export',
    });
    if (values.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return result.ok ? EXIT_OK : EXIT_FAILURE;
    }
    const c = palette();
    const err = palette(process.stderr);
    if (!values.quiet) {
      console.log(`${result.entries} entries (#${result.firstSeq ?? '–'}–#${result.lastSeq ?? '–'})`);
      if (result.publicKey)
        console.log(
          `public key ${result.publicKey.fingerprint}${result.publicKey.source === 'export' ? c.yellow(' (taken from the export – compare this fingerprint with the one you trust)') : ''}`,
        );
      for (const r of result.checkpoints) if (r.ok) console.log(`${c.green('ok')}   ${r.source}: ${r.message}`);
      if (result.uncovered > 0)
        console.log(c.dim(`${result.uncovered} newer entr${result.uncovered === 1 ? 'y is' : 'ies are'} not covered by a checkpoint yet`));
    }
    for (const p of result.problems) process.stderr.write(`${err.red('FAIL')} ${p}\n`);
    console.log(
      result.ok
        ? c.green(`The export is consistent with ${result.checkpoints.length} signed checkpoint(s).`)
        : err.red('The export does NOT match its checkpoints.'),
    );
    return result.ok ? EXIT_OK : EXIT_FAILURE;
  } catch (e) {
    if (e instanceof UsageError) return usageFailure(e, COMMAND);
    process.stderr.write(`error: ${(e as Error).message}\n`);
    return EXIT_USAGE;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) process.exitCode = main();
