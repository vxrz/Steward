/**
 * Offline check of an audit evidence pack (ZIP) – no server, vault or database needed.
 * `npm run evidence:verify -- pack.zip` or, in the desktop app, `steward evidence verify pack.zip`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BRAND } from '@sm/shared';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, UsageError, palette, parseCli, usageFailure } from './args.js';
import { config } from '../config.js';
import { verifyPack } from '../compliance/evidence-verify.js';

const help = (command: string) => `Check a ${BRAND.name} audit evidence pack offline.

Usage:
  ${command} <pack.zip> [--public-key <key>] [--json] [--quiet]

Checks:
  - manifest.json is signed (manifest.sig, Ed25519) by the installation's key,
  - every file in the pack has exactly the size and SHA-256 listed in the manifest,
    and the pack holds no other files,
  - the audit log excerpt (when included) reaches the signed audit checkpoint.

Options:
  --public-key <key>  The installation's public key you trust: a PEM file, PEM text or base64.
                      Default: public-key.pem in the pack (then compare its fingerprint with the
                      one under Audit log → Anchoring of your installation).
  --json              Print the result as JSON
  -q, --quiet         Only print problems and the summary
  -h, --help          Show this help
  -V, --version       Print the version

Examples:
  ${command} steward-evidence-2026-10-22.zip
  ${command} pack.zip --public-key steward-audit-public-key.pem --json > result.json

Exit status: 0 = the pack is intact, 1 = a check failed, 2 = usage error or unreadable file.
`;

function readKey(v: string): string {
  if (v.includes('BEGIN PUBLIC KEY')) return v;
  if (fs.existsSync(v)) return fs.readFileSync(v, 'utf8');
  return v.trim();
}

export async function runEvidenceVerify(argv: string[], command: string): Promise<number> {
  let parsed;
  try {
    parsed = parseCli(
      argv,
      {
        'public-key': { type: 'string' },
        json: { type: 'boolean' },
        quiet: { type: 'boolean', short: 'q' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'V' },
      },
      { positionals: true },
    );
  } catch (e) {
    if (e instanceof UsageError) return usageFailure(e, command);
    throw e;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(help(command));
    return EXIT_OK;
  }
  if (values.version) {
    console.log(config.version);
    return EXIT_OK;
  }
  if (positionals.length !== 1) return usageFailure(new UsageError(positionals.length ? 'pass exactly one pack' : 'the pack (ZIP file) is missing'), command);
  const file = positionals[0]!;
  if (!fs.existsSync(file)) {
    process.stderr.write(`error: ${file} does not exist\n`);
    return EXIT_USAGE;
  }
  let result;
  try {
    result = await verifyPack(file, { publicKey: values['public-key'] ? readKey(values['public-key']) : null });
  } catch (e) {
    process.stderr.write(`error: cannot read ${file}: ${(e as Error).message}\n`);
    return EXIT_USAGE;
  }
  if (values.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result.ok ? EXIT_OK : EXIT_FAILURE;
  }
  const c = palette();
  const err = palette(process.stderr);
  if (!values.quiet) {
    if (result.pack) console.log(`${result.pack.title} (${result.pack.id}), ${result.pack.from} – ${result.pack.to}, created by ${result.pack.createdBy}`);
    if (result.publicKey)
      console.log(
        `public key ${result.publicKey.fingerprint}${result.publicKey.source === 'pack' ? c.yellow(' (taken from the pack – compare this fingerprint with the one you trust)') : ''}`,
      );
    if (result.signatureOk) console.log(`${c.green('ok')}   manifest signature`);
    console.log(
      `${result.files.ok === result.files.listed ? c.green('ok') : c.red('FAIL')}   ${result.files.ok} of ${result.files.listed} files match the manifest`,
    );
    if (result.audit?.ok) console.log(`${c.green('ok')}   audit log excerpt: ${result.audit.message}`);
  }
  for (const p of result.problems) process.stderr.write(`${err.red('FAIL')} ${p}\n`);
  console.log(result.ok ? c.green('The evidence pack is intact.') : err.red('The evidence pack does NOT verify.'));
  return result.ok ? EXIT_OK : EXIT_FAILURE;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  // no top-level await: the desktop executable bundles this file as CommonJS
  void runEvidenceVerify(process.argv.slice(2), 'npm run evidence:verify --').then((code) => (process.exitCode = code));
}
