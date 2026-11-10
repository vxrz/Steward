/**
 * Offline tools for backups (#117) – no server, vault or database needed, only the backup passphrase.
 * `npm run backup -- decrypt <file.smbackup> --out <file.zip>` / `npm run backup -- verify <file.smbackup>`,
 * in the container `node server/dist/backup.js …`, in the desktop app `steward backup …`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { BRAND } from '@sm/shared';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, UsageError, palette, parseCli, usageFailure } from './args.js';
import { config, env } from '../config.js';
import { decryptFile, deriveBackupKey, keyIdOf, readHeader, type BackupHeader } from '../backup/crypto.js';
import { checkArchive } from '../backup/archive.js';

const help = (command: string) => `Decrypt and check ${BRAND.name} backups offline.

Usage:
  ${command} decrypt <backup.smbackup> --out <backup.zip>
  ${command} verify <backup.smbackup>
  ${command} info <backup.smbackup>

Commands:
  decrypt   Decrypt a backup into its ZIP archive (manifest.json, database/, data/) and check every file
            against the manifest. Restore from it as described in docs/BACKUPS.md. Also decrypts an encrypted
            export file (docs/EXPORTS.md) or audit archive: authenticated, not checked as a backup.
  verify    Decrypt into a temporary file, check every file against the manifest and remove it again. Fails for a
            file that is not a backup (an export file or audit archive) and says what it is.
  info      Show the unencrypted header: when, which Steward version, which key, and the parts of the data folder
            the backup settings left out (no passphrase needed).

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

/**
 * What a file holds, from its authenticated header: a backup names `content: backup` (0.16.0) or nothing (older
 * backups); an export file `export` with its file name, an uploaded audit archive `audit-archives`.
 */
const isBackup = (h: BackupHeader): boolean => !h.info?.content || h.info.content === 'backup';
function contentOf(h: BackupHeader): string {
  const c = h.info?.content;
  if (!c || c === 'backup') return 'a backup';
  if (c === 'export') return `an export file${h.info?.file ? ` (${h.info.file})` : ''}`;
  if (c === 'audit-archives') return 'an audit archive';
  return `"${c}"`;
}

async function passphrase(file: string | undefined): Promise<string> {
  if (file) return fs.readFileSync(file, 'utf8').split(/\r?\n/)[0] ?? '';
  if (env.SM_BACKUP_PASSPHRASE) return env.SM_BACKUP_PASSPHRASE;
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
    else {
      console.log(
        `${header.info?.product ?? BRAND.name} backup of ${header.createdAt} (version ${header.info?.version ?? '?'}, ${header.info?.database ?? '?'}), key ${header.keyId}`,
      );
      // 0.16.0: parts the backup settings left out – a restore from this backup lacks them (docs/BACKUPS.md#contents)
      if (!isBackup(header)) console.log(`Content: ${contentOf(header)} – not a backup`);
      else if (header.info?.excluded) console.log(`Left out by the backup settings (a restore lacks them): ${header.info.excluded.split(',').join(', ')}`);
      else console.log('Contents: complete (database and the whole data folder)');
    }
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
    // not a backup archive (0.16.0): an export file or an audit archive names its content in the authenticated header.
    // `verify` is the check of a backup: it fails for them – one object in the bucket replaced by another file made with
    // the same key must not pass as an intact backup
    if (!isBackup(header) && cmd === 'verify') {
      const what = contentOf(header);
      if (values.json)
        process.stdout.write(JSON.stringify({ ok: false, header, content: header.info?.content, error: `not a backup: ${what}` }, null, 2) + '\n');
      process.stderr.write(
        `${err.red('FAIL')} not a backup: this is ${what} (decrypted and authenticated with key ${header.keyId}) – read it with 'decrypt --out <file>'\n`,
      );
      return EXIT_FAILURE;
    }
    // decrypting one: every chunk authenticated is the whole check; an audit archive is then checked with
    // `steward audit verify-archive`
    if (!isBackup(header)) {
      if (values.json) process.stdout.write(JSON.stringify({ ok: true, header, content: header.info?.content }, null, 2) + '\n');
      else {
        console.log(`${c.green('ok')}   decrypted and authenticated (key ${header.keyId})`);
        console.log(c.green(`The file (${header.info?.content}${header.info?.file ? `: ${header.info.file}` : ''}) is intact: ${out}`));
      }
      return EXIT_OK;
    }
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
