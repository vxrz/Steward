/**
 * `steward library` – build, sign, verify and pack a shared procedure library (ADR 0014, docs/LIBRARIES.md).
 * `npm run library -- <command> <folder> …`. Steward never holds a publisher's private key: `sign` only calls
 * `ssh-keygen -Y sign -n steward-library` (OpenSSH 8.1 or newer).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BRAND, BUILT_IN_PUBLISHER_KEYS, LIBRARY_RELEASE_FILE, LIBRARY_SIGNATURE_FILE, LIBRARY_SIGNATURE_NAMESPACE } from '@sm/shared';
import { config } from '../config.js';
import { EXIT_FAILURE, EXIT_OK, UsageError, palette, parseCli, usageFailure } from './args.js';
import { buildRelease, zipRelease } from '../libraries/build.js';
import { manifestJsonSchema } from '../libraries/manifest.js';
import { readFolder, verifyRelease } from '../libraries/releases.js';
import { parsePublicKeyLine, sshFingerprint } from '../libraries/sshsig.js';
import type { TrustedKey } from '../libraries/trust.js';

const help = (COMMAND: string) => `Build, sign, verify and pack a ${BRAND.name} library.

Usage:
  ${COMMAND} build <folder>                    check every item, write <folder>/release.json
  ${COMMAND} sign <folder> -f <private key>    sign release.json with ssh-keygen (writes release.json.sig)
  ${COMMAND} verify <folder> --key <file|line> verify signature and files against a public key
  ${COMMAND} pack <folder> -o <file.zip>       a .zip of the release, for uploading into an installation
  ${COMMAND} schema [--check]                  write docs/libraries/steward-library-1.schema.json

Options:
  -f, --file <key>     Private key for "sign" (ed25519 or a hardware key, sk-ssh-ed25519)
  --key <file|line>    Public key(s) for "verify": an OpenSSH .pub file or "ssh-ed25519 AAAA…" (repeatable);
                       without it the built-in keys of this ${BRAND.name} version are used
  --publisher <id>     "verify": the publisher the keys belong to (default: the release's)
  -o, --out <file>     "pack": the .zip to write (must not exist)
  --check              "schema": exit 1 when the committed file is outdated
  -h, --help           Show this help
  -V, --version        Print the version

Examples:
  ${COMMAND} build examples/libraries/example-access-reviews
  ${COMMAND} sign examples/libraries/example-access-reviews -f ~/.ssh/id_ed25519_sk
  ${COMMAND} verify my-library --key publisher.pub

Exit status: 0 = done / the release verifies, 1 = a check failed, 2 = usage error.
`;

const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);

function readKeys(values: string[], publisher: string): TrustedKey[] {
  const lines = values
    .flatMap((v) => (fs.existsSync(v) ? fs.readFileSync(v, 'utf8').split(/\r?\n/) : [v]))
    .filter((l) => l.trim() && !l.trim().startsWith('#'));
  return lines.map((l) => {
    const k = parsePublicKeyLine(l);
    return {
      id: 'cli',
      publisherId: publisher,
      publisherName: publisher,
      libraries: [],
      blob: k.blob,
      fingerprint: sshFingerprint(k.blob),
      state: 'active' as const,
      expiresAt: null,
      builtIn: false,
    };
  });
}

/** `command`: how the user called it (npm script or the desktop executable's `steward library`). */
export async function main(argv: string[], COMMAND = 'npm run library --'): Promise<number> {
  let parsed;
  try {
    parsed = parseCli(
      argv,
      {
        file: { type: 'string', short: 'f' },
        key: { type: 'string', multiple: true },
        publisher: { type: 'string' },
        out: { type: 'string', short: 'o' },
        check: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'V' },
      },
      { positionals: true },
    );
  } catch (e) {
    if (e instanceof UsageError) return usageFailure(e, COMMAND);
    throw e;
  }
  const { values, positionals } = parsed;
  if (values.help || !positionals.length) {
    process.stdout.write(help(COMMAND));
    return values.help ? EXIT_OK : usageFailure(new UsageError('a command is needed: build, sign, verify, pack or schema'), COMMAND);
  }
  if (values.version) {
    out(config.version);
    return EXIT_OK;
  }
  const c = palette(process.stdout);
  const [cmd, folderArg] = positionals as [string, string | undefined];
  if (cmd === 'schema') {
    // the desktop executable has no source checkout to write into
    if (!import.meta.dirname) return usageFailure(new UsageError('schema: only in a source checkout (npm run library -- schema)'), COMMAND);
    const file = path.resolve(import.meta.dirname, '../../../docs/libraries/steward-library-1.schema.json');
    const text = `${JSON.stringify(manifestJsonSchema(), null, 2)}\n`;
    if (values.check) {
      if ((fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '') !== text) {
        err(`${path.relative(process.cwd(), file)} is outdated – run npm run library -- schema`);
        return EXIT_FAILURE;
      }
      out('library manifest schema up to date');
      return EXIT_OK;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    out(`wrote ${path.relative(process.cwd(), file)}`);
    return EXIT_OK;
  }
  if (!['build', 'sign', 'verify', 'pack'].includes(cmd))
    return usageFailure(new UsageError(`unknown command '${cmd}'`, 'Commands: build, sign, verify, pack, schema'), COMMAND);
  if (!folderArg || !fs.existsSync(folderArg) || !fs.statSync(folderArg).isDirectory())
    return usageFailure(new UsageError(`${cmd}: a library folder is needed${folderArg ? ` (${folderArg} is not one)` : ''}`), COMMAND);
  const folder = path.resolve(folderArg);
  try {
    switch (cmd) {
      case 'build': {
        const r = await buildRelease(readFolder(folder));
        fs.writeFileSync(path.join(folder, LIBRARY_RELEASE_FILE), r.releaseJson);
        // an old signature belongs to the old release.json
        if (fs.existsSync(path.join(folder, LIBRARY_SIGNATURE_FILE))) {
          fs.rmSync(path.join(folder, LIBRARY_SIGNATURE_FILE));
          out(`${c.yellow('⚠')} removed the old ${LIBRARY_SIGNATURE_FILE} – sign the new release.json`);
        }
        out(`${c.green('✔')} ${LIBRARY_RELEASE_FILE} written: ${r.files} file(s), ${r.items} item(s)`);
        out(`  next: ${COMMAND} sign ${folderArg} -f <private key>`);
        return EXIT_OK;
      }
      case 'sign': {
        if (!values.file) return usageFailure(new UsageError('sign: -f <private key> is needed'), COMMAND);
        const release = path.join(folder, LIBRARY_RELEASE_FILE);
        if (!fs.existsSync(release)) return usageFailure(new UsageError(`sign: ${LIBRARY_RELEASE_FILE} is missing – run build first`), COMMAND);
        fs.rmSync(`${release}.sig`, { force: true });
        // ssh-keygen asks for the passphrase or the touch of a hardware key itself; Steward never sees the key
        const r = spawnSync('ssh-keygen', ['-Y', 'sign', '-n', LIBRARY_SIGNATURE_NAMESPACE, '-f', values.file, release], { stdio: 'inherit' });
        if (r.error) {
          err(`ssh-keygen could not run: ${r.error.message} – OpenSSH 8.1 or newer is needed`);
          return EXIT_FAILURE;
        }
        if (r.status !== 0) return EXIT_FAILURE;
        out(`${c.green('✔')} ${LIBRARY_SIGNATURE_FILE} written`);
        return EXIT_OK;
      }
      case 'verify': {
        const files = readFolder(folder);
        const manifestPublisher = JSON.parse(files.get(LIBRARY_RELEASE_FILE)?.toString('utf8') ?? '{}').publisher as string | undefined;
        const publisher = values.publisher ?? manifestPublisher ?? '';
        const keys = values.key?.length
          ? readKeys(values.key, publisher)
          : BUILT_IN_PUBLISHER_KEYS.map((b) => readKeys([b.key], b.publisher)[0]!).filter(Boolean);
        if (!keys.length) {
          err(`no key to verify with: pass --key (this ${BRAND.name} version has no built-in publisher key yet)`);
          return EXIT_FAILURE;
        }
        const v = await verifyRelease(files, { keys });
        out(
          `${c.green('✔')} ${v.release.library} ${v.release.release} (${v.release.publisher}): signed with ${v.key.fingerprint}, ${v.release.files.length} file(s), ${v.items.length} item(s)`,
        );
        out(`  release.json SHA-256 ${v.sha256}`);
        return EXIT_OK;
      }
      case 'pack': {
        if (!values.out) return usageFailure(new UsageError('pack: -o <file.zip> is needed'), COMMAND);
        const files = readFolder(folder);
        if (!files.has(LIBRARY_SIGNATURE_FILE)) out(`${c.yellow('⚠')} the release is not signed – an installation refuses it`);
        await zipRelease(files, path.resolve(values.out));
        out(`${c.green('✔')} ${values.out} written (${files.size} file(s))`);
        return EXIT_OK;
      }
    }
  } catch (e) {
    err(`${c.red('✘')} ${(e as Error).message}`);
    return EXIT_FAILURE;
  }
  return EXIT_OK;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  // no top-level await: the desktop executable bundles this file as CommonJS
  void main(process.argv.slice(2)).then((code) => (process.exitCode = code));
}
