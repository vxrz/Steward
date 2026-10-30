/**
 * Offline tools for backups (#117) – no server, vault or database needed, only the backup passphrase.
 * `npm run backup -- decrypt <file.smbackup> --out <file.zip>` / `npm run backup -- verify <file.smbackup>`,
 * in the container `node --import tsx server/src/cli/backup.ts …`, in the desktop app `steward backup …`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { BRAND } from '@sm/shared';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, UsageError, palette, parseCli, usageFailure } from './args.js';
import { config } from '../config.js';
import { decryptFile, deriveBackupKey, keyIdOf, readHeader } from '../backup/crypto.js';
import { checkArchive } from '../backup/archive.js';

const help = (command: string) => `Decrypt and check ${BRAND.name} backups offline.

Usage:
  ${command} decrypt <backup.smbackup> --out <backup.zip>
  ${command} verify <backup.smbackup>
  ${command} info <backup.smbackup>

Commands:
  decrypt   Decrypt a backup into its ZIP archive (manifest.json, database/, data/) and check every file
            against the manifest. Restore from it as described in docs/BACKUPS.md.
  verify    Decrypt into a temporary file, check every file against the manifest and remove it again.
  info      Show the unencrypted header: when, which Steward version, which key (no passphrase needed).

The backup passphrase is read from the file in --passphrase-file, from $SM_BACKUP_PASSPHRASE, or asked for.

Options:
  --out <file>              Where decrypt writes the ZIP (must not exist)
  --passphrase-file <file>  Read the backup passphrase from this file (first line)
  --json                    Print the result as JSON
  -h, --help                Show this help
  -V, --version             Print the version

Exit status: 0 = decrypted and intact, 1 = wrong passphrase, changed or broken file, 2 = usage error.
`;

async function ask(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new UsageError('no backup passphrase: pass --passphrase-file or set SM_BACKUP_PASSPHRASE');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  // do not echo the passphrase
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  let asked = false;
  out._writeToOutput = (s: string) => {
    if (!asked) {
      process.stderr.write(s);
      asked = true;
    }
  };
  try {
    return await new Promise<string>((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
    process.stderr.write('\n');
  }
}

async function passphrase(file: string | undefined): Promise<string> {
  if (file) return fs.readFileSync(file, 'utf8').split(/\r?\n/)[0] ?? '';
  if (process.env.SM_BACKUP_PASSPHRASE) return process.env.SM_BACKUP_PASSPHRASE;
  return ask('Backup passphrase: ');
}

export async function runBackupCli(argv: string[], command: string): Promise<number> {
  let parsed;
  try {
    parsed = parseCli(
      argv,
      {
        out: { type: 'string' },
        'passphrase-file': { type: 'string' },
        json: { type: 'boolean' },
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
  const [cmd, file, ...rest] = positionals;
  if (!cmd || !['decrypt', 'verify', 'info'].includes(cmd))
    return usageFailure(new UsageError(cmd ? `unknown command '${cmd}'` : 'missing command', "Use 'decrypt', 'verify' or 'info'"), command);
  if (!file || rest.length) return usageFailure(new UsageError(file ? 'pass exactly one backup file' : 'the backup file is missing'), command);
  if (cmd === 'decrypt' && !values.out) return usageFailure(new UsageError('decrypt needs --out <file.zip>'), command);
  if (!fs.existsSync(file)) {
    process.stderr.write(`error: ${file} does not exist\n`);
    return EXIT_USAGE;
  }
  let header;
  try {
    ({ header } = await readHeader(file));
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    return EXIT_FAILURE;
  }
  if (cmd === 'info') {
    if (values.json) process.stdout.write(JSON.stringify(header, null, 2) + '\n');
    else
      console.log(
        `${header.info?.product ?? BRAND.name} backup of ${header.createdAt} (version ${header.info?.version ?? '?'}, ${header.info?.database ?? '?'}), key ${header.keyId}`,
      );
    return EXIT_OK;
  }
  if (values.out && fs.existsSync(values.out)) {
    process.stderr.write(`error: ${values.out} exists already\n`);
    return EXIT_USAGE;
  }
  let pass: string;
  try {
    pass = await passphrase(values['passphrase-file']);
  } catch (e) {
    if (e instanceof UsageError) return usageFailure(e, command);
    throw e;
  }
  const key = await deriveBackupKey(pass, header.kdf);
  const c = palette();
  const err = palette(process.stderr);
  if (keyIdOf(key) !== header.keyId) {
    process.stderr.write(`${err.red('FAIL')} wrong backup passphrase (this backup needs key ${header.keyId})\n`);
    return EXIT_FAILURE;
  }
  const tmpDir = cmd === 'verify' ? fs.mkdtempSync(path.join(os.tmpdir(), 'steward-backup-')) : null;
  const out = values.out ?? path.join(tmpDir!, 'backup.zip');
  try {
    await decryptFile(file, out, key);
    const check = await checkArchive(out);
    if (values.json) process.stdout.write(JSON.stringify({ ok: check.ok, header, manifest: check.manifest, steps: check.steps }, null, 2) + '\n');
    else {
      console.log(`${c.green('ok')}   decrypted and authenticated (key ${header.keyId})`);
      for (const s of check.steps)
        (s.ok ? console.log : (m: string) => process.stderr.write(`${m}\n`))(`${s.ok ? c.green('ok') : err.red('FAIL')}   ${s.name}: ${s.message}`);
      if (check.ok) console.log(c.green(cmd === 'decrypt' ? `The backup is intact: ${out}` : 'The backup is intact.'));
      else console.log(err.red('The backup does NOT verify.'));
    }
    if (!check.ok && cmd === 'decrypt') fs.rmSync(out, { force: true });
    return check.ok ? EXIT_OK : EXIT_FAILURE;
  } catch (e) {
    process.stderr.write(`${err.red('FAIL')} ${(e as Error).message}\n`);
    return EXIT_FAILURE;
  } finally {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  // no top-level await: the desktop executable bundles this file as CommonJS
  void runBackupCli(process.argv.slice(2), 'npm run backup --').then((code) => (process.exitCode = code));
}
