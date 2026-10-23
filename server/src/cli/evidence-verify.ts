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

/** The pack is intact, but signed with a key nobody vouched for (no --public-key, --fingerprint or --trust-pack-key). */
export const EXIT_UNTRUSTED = 3;

const help = (command: string) => `Check a ${BRAND.name} audit evidence pack offline.

Usage:
  ${command} <pack.zip> [--public-key <key> | --fingerprint <fp> | --trust-pack-key] [--json] [--quiet]

Checks:
  - manifest.json is signed (manifest.sig, Ed25519) by the installation's key,
  - every file in the pack has exactly the size and SHA-256 listed in the manifest,
    and the pack holds no other files,
  - the audit log excerpt (when included) reaches the signed audit checkpoint.

Anyone can sign a pack with a key of their own and put that key into the pack. So tell the check
which key you trust – get it from the installation (Audit log → Anchoring outside the database
shows the public key and its fingerprint to auditors and administrators):

Options:
  --public-key <key>  The installation's public key: a PEM file, PEM text or base64.
  --fingerprint <fp>  The fingerprint of the installation's key (e.g. 1a2b:3c4d:…); the key in the
                      pack must have it.
  --trust-pack-key    Accept the key in the pack (you compared its fingerprint yourself).
  --json              Print the result as JSON
  -q, --quiet         Only print problems, the key fingerprint and the summary
  -h, --help          Show this help
  -V, --version       Print the version

Examples:
  ${command} pack.zip --public-key steward-audit-public-key.pem
  ${command} pack.zip --fingerprint 1a2b:3c4d:5e6f:7a8b:9c0d:1e2f:3a4b:5c6d --json > result.json

Exit status: 0 = the pack is intact and signed with the trusted key, 1 = a check failed,
2 = usage error or unreadable file, 3 = the pack is intact but signed with a key you did not
confirm (pass --public-key, --fingerprint or --trust-pack-key).
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
        fingerprint: { type: 'string' },
        'trust-pack-key': { type: 'boolean' },
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
  if ([values['public-key'], values.fingerprint, values['trust-pack-key']].filter(Boolean).length > 1)
    return usageFailure(new UsageError('use only one of --public-key, --fingerprint and --trust-pack-key'), command);
  const file = positionals[0]!;
  if (!fs.existsSync(file)) {
    process.stderr.write(`error: ${file} does not exist\n`);
    return EXIT_USAGE;
  }
  let result;
  try {
    result = await verifyPack(file, {
      publicKey: values['public-key'] ? readKey(values['public-key']) : null,
      fingerprint: values.fingerprint ?? null,
      trustPackKey: !!values['trust-pack-key'],
    });
  } catch (e) {
    process.stderr.write(`error: cannot read ${file}: ${(e as Error).message}\n`);
    return EXIT_USAGE;
  }
  const code = !result.ok ? EXIT_FAILURE : result.trusted ? EXIT_OK : EXIT_UNTRUSTED;
  if (values.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return code;
  }
  const c = palette();
  const err = palette(process.stderr);
  if (!values.quiet && result.pack)
    console.log(`${result.pack.title} (${result.pack.id}), ${result.pack.from} – ${result.pack.to}, created by ${result.pack.createdBy}`);
  // the fingerprint is always shown: it is what the auditor compares with the installation's
  if (result.publicKey) {
    const how =
      result.trust === 'public-key'
        ? ' (the key you passed)'
        : result.trust === 'fingerprint'
          ? ' (matches the fingerprint you passed)'
          : result.trust === 'pack-key-accepted'
            ? ' (taken from the pack, accepted with --trust-pack-key)'
            : ' (taken from the pack)';
    console.log(`public key ${result.publicKey.fingerprint}${how}`);
  }
  if (!values.quiet) {
    if (result.signatureOk) console.log(`${c.green('ok')}   manifest signature`);
    console.log(
      `${result.files.ok === result.files.listed ? c.green('ok') : c.red('FAIL')}   ${result.files.ok} of ${result.files.listed} files match the manifest`,
    );
    if (result.audit?.ok) console.log(`${c.green('ok')}   audit log excerpt: ${result.audit.message}`);
  }
  for (const p of result.problems) process.stderr.write(`${err.red('FAIL')} ${p}\n`);
  if (!result.ok) console.log(err.red('The evidence pack does NOT verify.'));
  else if (!result.trusted) {
    process.stderr.write(
      `${err.yellow('UNTRUSTED')} The signature is valid for the key in the pack, but nothing shows that this is your installation's key: ` +
        `anyone can sign a pack with a key of their own. Compare the fingerprint ${result.publicKey?.fingerprint ?? ''} with the one under ` +
        `Audit log → Anchoring outside the database, then pass --fingerprint <fp> (or --public-key <file>).\n`,
    );
    console.log(err.yellow('The evidence pack is intact, but signed with an UNTRUSTED key.'));
  } else console.log(c.green('The evidence pack is intact.'));
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  // no top-level await: the desktop executable bundles this file as CommonJS
  void runEvidenceVerify(process.argv.slice(2), 'npm run evidence:verify --').then((code) => (process.exitCode = code));
}
