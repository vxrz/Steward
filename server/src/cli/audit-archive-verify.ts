/**
 * Offline check of audit archives (server/src/audit-archive.ts) – no server, vault or database needed.
 * `npm run audit:verify-archive -- <archive.zip> …` or, in the desktop app, `steward audit verify-archive <archive.zip> …`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BRAND } from '@sm/shared';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, UsageError, palette, parseCli, usageFailure } from './args.js';
import { config } from '../config.js';
import { continuityProblems, verifyArchive, type ArchiveVerifyResult } from '../audit-archive-verify.js';

/** The archives are intact, but signed with a key nobody vouched for (no --public-key, --fingerprint or --trust-pack-key). */
export const EXIT_UNTRUSTED = 3;

const help = (command: string) => `Check ${BRAND.name} audit archives offline.

Usage:
  ${command} <archive.zip> [<archive.zip> …] [--public-key <key> | --fingerprint <fp> | --trust-pack-key] [--json] [--quiet]

An audit archive holds the entries of closed epochs of the audit log (Audit log → Archive; the files are in
<data folder>/audit-archives, uploaded copies are encrypted with the backup key – decrypt them first with
'${BRAND.slug} backup decrypt'). Checks:
  - manifest.json is signed (manifest.sig, Ed25519) by the installation's key,
  - every file in the archive has exactly the size and SHA-256 listed in the manifest, and there are no others,
  - the entries form an unbroken chain from where the archive starts (entry #1, or the signed checkpoint it
    continues), and their public digest reaches every signed checkpoint in the archive and the one at its end,
  - with several archives: each one starts where the one before it ends.
The HMAC of each entry needs the vault key and is checked by the server (Audit log → Verify, full).

Options:
  --public-key <key>  The installation's public key: a PEM file, PEM text or base64.
  --fingerprint <fp>  The fingerprint of the installation's key (e.g. 1a2b:3c4d:…); the key in the
                      archive must have it.
  --trust-pack-key    Accept the key in the archive (you compared its fingerprint yourself).
  --json              Print the result as JSON
  -q, --quiet         Only print problems and the summary
  -h, --help          Show this help
  -V, --version       Print the version

Examples:
  ${command} steward-audit-2026-10-000000001-000024311.zip --public-key steward-audit-public-key.pem
  ${command} audit-archives/*.zip --fingerprint 1a2b:3c4d:5e6f:7a8b:9c0d:1e2f:3a4b:5c6d --json > result.json

Exit status: 0 = every archive is intact, signed with the trusted key and (several) continuous,
1 = a check failed, 2 = usage error or unreadable file, 3 = intact but signed with a key you did not
confirm (pass --public-key, --fingerprint or --trust-pack-key).
`;

function readKey(v: string): string {
  if (v.includes('BEGIN PUBLIC KEY')) return v;
  if (fs.existsSync(v)) return fs.readFileSync(v, 'utf8');
  return v.trim();
}

export async function runAuditArchiveVerify(argv: string[], command: string): Promise<number> {
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
  if (!positionals.length) return usageFailure(new UsageError('the archive (ZIP file) is missing'), command);
  if ([values['public-key'], values.fingerprint, values['trust-pack-key']].filter(Boolean).length > 1)
    return usageFailure(new UsageError('use only one of --public-key, --fingerprint and --trust-pack-key'), command);
  const opts = {
    publicKey: values['public-key'] ? readKey(values['public-key']) : null,
    fingerprint: values.fingerprint ?? null,
    trustPackKey: !!values['trust-pack-key'],
  };
  const results: ArchiveVerifyResult[] = [];
  for (const file of positionals) {
    if (!fs.existsSync(file)) {
      process.stderr.write(`error: ${file} does not exist\n`);
      return EXIT_USAGE;
    }
    try {
      results.push(await verifyArchive(file, opts));
    } catch (e) {
      process.stderr.write(`error: cannot read ${file}: ${(e as Error).message}\n`);
      return EXIT_USAGE;
    }
  }
  const continuity = results.length > 1 ? continuityProblems(results) : [];
  const ok = results.every((r) => r.ok) && !continuity.length;
  const trusted = ok && results.every((r) => r.trusted);
  const code = !ok ? EXIT_FAILURE : trusted ? EXIT_OK : EXIT_UNTRUSTED;
  if (values.json) {
    process.stdout.write(JSON.stringify({ ok, trusted, archives: results, continuity }, null, 2) + '\n');
    return code;
  }
  const c = palette();
  const err = palette(process.stderr);
  for (const r of results) {
    const name = path.basename(r.file);
    if (r.ok && !values.quiet) console.log(`${c.green('ok')}   ${name}: ${r.message}`);
    for (const p of r.problems) process.stderr.write(`${err.red('FAIL')} ${name}: ${p}\n`);
  }
  for (const p of continuity) process.stderr.write(`${err.red('FAIL')} ${p}\n`);
  const fp = [...new Set(results.map((r) => r.publicKey?.fingerprint).filter(Boolean))];
  if (fp.length) console.log(`public key ${fp.join(', ')}`);
  if (!ok) console.log(err.red(results.length > 1 ? 'The archives do NOT verify.' : 'The archive does NOT verify.'));
  else if (!trusted) {
    process.stderr.write(
      `${err.yellow('UNTRUSTED')} The signature is valid for the key in the archive, but nothing shows that this is your installation's key. ` +
        `Compare the fingerprint ${fp.join(', ')} with the one under Audit log → Anchoring outside the database, then pass --fingerprint <fp> (or --public-key <file>).\n`,
    );
    console.log(err.yellow('Intact, but signed with an UNTRUSTED key.'));
  } else console.log(c.green(results.length > 1 ? `All ${results.length} archives are intact and continuous.` : 'The archive is intact.'));
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  // no top-level await: the desktop executable bundles this file as CommonJS
  void runAuditArchiveVerify(process.argv.slice(2), 'npm run audit:verify-archive --').then((code) => (process.exitCode = code));
}
