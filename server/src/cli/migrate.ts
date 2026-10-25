/**
 * Moving an instance on the command line (Steward stopped; see server/src/migration):
 *
 *   steward migrate export --out steward.smig                     on the source (e.g. the desktop app)
 *   steward migrate inspect steward.smig [--mapping-template m.json]   on the target: dry run
 *   steward migrate import steward.smig --mapping m.json --fingerprint <fp>
 *   npm run migrate -- …                                           from the source tree
 *
 * Like `steward admin`, it needs the data folder and the master passphrase of the instance it runs on.
 * The package itself is protected with a transfer passphrase (both instances have their own master passphrase).
 */
import fs from 'node:fs';
import path from 'node:path';
import { EXIT_FAILURE, EXIT_OK, UsageError, parseCli, usageFailure } from './args.js';
import { Failure, actor, alive, promptHidden, readStdin } from './admin.js';

const help = (command: string) => `Move a Steward instance to another one (run on the server, with Steward stopped).

Usage:
  ${command} export --out <file> [options]
  ${command} inspect <file> [--mapping-template <file>] [options]
  ${command} import <file> --mapping <file> --fingerprint <fingerprint> [options]

Commands:
  export     Write a migration package of this instance: all data, stored files and the audit log,
             protected with a transfer passphrase and signed with this instance's key.
  inspect    Check a package against this instance (dry run): signature, content, audit history,
             what comes in, what is refused, and suggestions for the identity mapping.
             --mapping-template writes the suggestions as a mapping file to edit.
  import     Import a package with a complete identity mapping (every user and team of the
             package). --fingerprint is the source key's fingerprint as the source shows it
             (export output, or Audit log → Anchoring): all 32 characters.

Options:
  --out <file>                    With export: the package to write (must not exist)
  --mapping <file>                With import: the identity mapping (JSON, see docs/INSTALL.md)
  --mapping-template <file>       With inspect: write a mapping file with the suggestions
  --fingerprint <fp>              With import: the source key's fingerprint, read on the source
  --transfer-passphrase-file <f>  Read the transfer passphrase from a file (else SM_TRANSFER_PASSPHRASE or a prompt)
  --data-dir <path>               Data folder (default: $SM_DATA_DIR or the per-user folder)
  --passphrase-stdin              Read the master passphrase from standard input
  --json                          Machine-readable output
  -h, --help                      Show this help

The master passphrase comes from SM_MASTER_PASSPHRASE_FILE / SM_MASTER_PASSPHRASE,
--passphrase-stdin, or a prompt (when run in a terminal).

Examples:
  ${command} export --out ~/steward-move.smig
  ${command} inspect steward-move.smig --mapping-template mapping.json
  ${command} import steward-move.smig --mapping mapping.json --fingerprint 1a2b:3c4d:…

Exit status: 0 = ok, 1 = failure (wrong passphrase, refused package or mapping, Steward still running), 2 = usage error.
`;

const OPTIONS = {
  out: { type: 'string' },
  mapping: { type: 'string' },
  'mapping-template': { type: 'string' },
  fingerprint: { type: 'string' },
  'transfer-passphrase-file': { type: 'string' },
  'data-dir': { type: 'string' },
  'passphrase-stdin': { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

type Values = {
  out?: string;
  mapping?: string;
  'mapping-template'?: string;
  fingerprint?: string;
  'transfer-passphrase-file'?: string;
  'passphrase-stdin'?: boolean;
  json?: boolean;
};

let closeDb: (() => void) | undefined;

export async function runMigrate(argv: string[], command = 'steward migrate'): Promise<number> {
  let parsed;
  try {
    parsed = parseCli(argv, OPTIONS, { positionals: true });
  } catch (e) {
    if (e instanceof UsageError) return usageFailure(e, command);
    throw e;
  }
  const { values, positionals } = parsed;
  const [sub, ...rest] = positionals;
  if (values.help || !sub) {
    process.stdout.write(help(command));
    return values.help ? EXIT_OK : usageFailure(new UsageError('missing command'), command);
  }
  if (!['export', 'inspect', 'import'].includes(sub))
    return usageFailure(new UsageError(`unknown command '${sub}'`, 'Commands: export, inspect, import'), command);
  if (sub === 'export' && (rest.length || !values.out)) return usageFailure(new UsageError('export takes --out <file> and no other arguments'), command);
  if (sub !== 'export' && rest.length !== 1) return usageFailure(new UsageError(`${sub} takes exactly one package file`), command);
  if (sub === 'import' && (!values.mapping || !values.fingerprint))
    return usageFailure(new UsageError('import needs --mapping <file> and --fingerprint <fingerprint>'), command);
  if (values['mapping-template'] && sub !== 'inspect') return usageFailure(new UsageError('--mapping-template only works with inspect'), command);
  if (values.out && sub !== 'export') return usageFailure(new UsageError('--out only works with export'), command);

  // before config.ts is evaluated
  if ((values as { 'data-dir'?: string })['data-dir']) process.env.SM_DATA_DIR = path.resolve((values as { 'data-dir': string })['data-dir']);
  process.env.SM_LOG_LEVEL ??= 'warn';
  try {
    return await execute(sub as 'export' | 'inspect' | 'import', rest[0], values);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const problems = (e as { params?: { problems?: string[] } }).params?.problems;
    if (values.json) process.stdout.write(JSON.stringify({ ok: false, error: msg, ...(problems ? { problems } : {}) }) + '\n');
    if (problems?.length) process.stderr.write(`error: ${msg.split(':')[0]}:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
    else process.stderr.write(`error: ${msg}\n`);
    return EXIT_FAILURE;
  } finally {
    closeDb?.();
  }
}

async function transferPassphrase(values: Values, twice: boolean): Promise<string> {
  const file = values['transfer-passphrase-file'];
  if (file) return fs.readFileSync(path.resolve(file), 'utf8').replace(/\r?\n$/, '');
  if (process.env.SM_TRANSFER_PASSPHRASE) return process.env.SM_TRANSFER_PASSPHRASE;
  if (!process.stdin.isTTY) throw new Failure('the transfer passphrase is needed: --transfer-passphrase-file, SM_TRANSFER_PASSPHRASE or run in a terminal');
  const p = await promptHidden('Transfer passphrase (at least 12 characters): ');
  if (twice && (await promptHidden('Repeat the transfer passphrase: ')) !== p) throw new Failure('the transfer passphrases differ');
  return p;
}

async function execute(sub: 'export' | 'inspect' | 'import', file: string | undefined, values: Values): Promise<number> {
  await import('../bootstrap.js');
  const { config } = await import('../config.js');
  const { instanceFile, verifyInstance } = await import('../instance.js');
  if (fs.existsSync(instanceFile())) {
    try {
      const inst = JSON.parse(fs.readFileSync(instanceFile(), 'utf8')) as { url?: string; pid?: number };
      if (inst.url && (await verifyInstance(inst.url, config.dataDir, 3000)) === 'ok')
        throw new Failure(`Steward is running at ${inst.url} with this data folder – stop it first`);
      if (inst.pid && inst.pid !== process.pid && alive(inst.pid))
        throw new Failure(`Steward (process ${inst.pid}) seems to be running with this data folder – stop it first (if it is not, delete ${instanceFile()})`);
    } catch (e) {
      if (e instanceof Failure) throw e;
    }
  }
  const { vault } = await import('../vault.js');
  if (!vault().initialized)
    throw new Failure(`no Steward installation in ${config.dataDir} (no vault.json) – set it up first, or use --data-dir / SM_DATA_DIR`);
  const { db } = await import('../db.js');
  const d = db();
  closeDb = () => d.close();
  const { connectVaultToDatabase } = await import('../vault-rotation.js');
  connectVaultToDatabase();
  let master = config.masterPassphrase;
  if (!master && values['passphrase-stdin']) master = await readStdin();
  if (!master && process.stdin.isTTY) master = await promptHidden('Master passphrase of this instance: ');
  if (!master) throw new Failure('the master passphrase is needed: set SM_MASTER_PASSPHRASE_FILE, use --passphrase-stdin or run in a terminal');
  try {
    await vault().unlock(master);
  } catch (e) {
    if ((e as { code?: string }).code === 'WRONG_PASSPHRASE') throw new Failure('wrong master passphrase');
    throw e;
  }
  const { flushPendingAudit } = await import('../audit.js');
  flushPendingAudit();
  const out = (o: unknown, text: string) => process.stdout.write(values.json ? JSON.stringify({ ok: true, ...(o as object) }) + '\n' : text);

  if (sub === 'export') {
    const target = path.resolve(values.out!);
    const transfer = await transferPassphrase(values, true);
    const { exportPackage } = await import('../migration/export.js');
    const r = await exportPackage({
      out: target,
      transferPassphrase: transfer,
      actor: actor(),
      log: values.json ? undefined : (l) => process.stderr.write(l + '\n'),
    });
    out(
      { ...r, file: target },
      `Migration package written: ${target}\n` +
        `  ${r.rows} rows in ${r.tables} tables, ${r.files} files, ${r.auditEntries} audit entries, ${(r.size / 1024 / 1024).toFixed(1)} MB\n` +
        `  SHA-256:      ${r.sha256}\n` +
        `  Fingerprint:  ${r.fingerprint}   (enter it on the target to confirm the package – all 32 characters)\n` +
        (r.undecryptable ? `  Warning: ${r.undecryptable} credential(s) could not be decrypted here and are moved empty.\n` : '') +
        `Recorded in the audit log as ${actor()}. Keep the transfer passphrase apart from the file.\n`,
    );
    return EXIT_OK;
  }

  const { readPackage, buildPlan, applyImport } = await import('../migration/import.js');
  const pkg = await readPackage(path.resolve(file!), await transferPassphrase(values, false));
  try {
    const plan = buildPlan(pkg);
    if (sub === 'inspect') {
      if (values['mapping-template']) {
        const template = {
          users: Object.fromEntries(plan.users.map((u) => [u.username, u.suggestion])),
          teams: Object.fromEntries(plan.teams.map((t) => [t.name, t.suggestion])),
        };
        fs.writeFileSync(path.resolve(values['mapping-template']), JSON.stringify(template, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      }
      const lines = [
        `Package ${plan.packageId}  (${(plan.sizeBytes / 1024 / 1024).toFixed(1)} MB, SHA-256 ${plan.packageSha256})`,
        `Source:       ${'Steward'} ${plan.source.version}, exported ${plan.source.exportedAt} by ${plan.source.exportedBy} (${plan.source.database}) – confirm its key with --fingerprint as the source shows it`,
        `Content:      ${plan.counts.reduce((s, c) => s + c.rows, 0)} rows in ${plan.counts.length} tables, ${plan.files.count} files; ${plan.schema.migrationsToApply} migration(s) to apply`,
        `Audit log:    ${plan.history.ok ? 'verified' : 'NOT verified'} – ${plan.history.message}`,
        ...(plan.paused.length ? [`Paused:       ${plan.paused.map((p) => `${p.count} ${p.label}`).join(', ')} (turn them on after the import)`] : []),
        ...plan.blocking.map((b) => `BLOCKED:      ${b}`),
        ...plan.warnings.map((w) => `Warning:      ${w}`),
        '',
        'Users (source → suggestion):',
        ...plan.users.map(
          (u) =>
            `  ${u.username}${u.roles.includes('admin') ? ' [admin]' : ''} (${u.kind === 'sso' ? `sso${u.provider ? ` ${u.provider}` : ''}` : 'local'}${u.active ? '' : ', deactivated'}) → ${u.suggestion.action}${'to' in u.suggestion ? ` ${u.suggestion.to}` : 'username' in u.suggestion && u.suggestion.username ? ` ${u.suggestion.username}` : ''}${u.clash ? `  (a user "${u.clash.username}" exists here)` : ''}`,
        ),
        'Teams (source → suggestion):',
        ...plan.teams.map((t) => `  ${t.name} → ${t.suggestion.action}${'to' in t.suggestion ? ` ${t.suggestion.to}` : ''}`),
        ...(values['mapping-template']
          ? ['', `Mapping template written to ${path.resolve(values['mapping-template'])} – review it, set "confirm": true for administrators, then import.`]
          : []),
      ];
      out({ plan }, lines.join('\n') + '\n');
      return plan.blocking.length ? EXIT_FAILURE : EXIT_OK;
    }
    const mapping = JSON.parse(fs.readFileSync(path.resolve(values.mapping!), 'utf8')) as unknown;
    const r = await applyImport(pkg, { mapping: mapping as never, actor: actor(), confirmFingerprint: values.fingerprint! });
    out(
      r,
      `Imported: ${Object.values(r.counts).reduce((s, n) => s + n, 0)} rows, ${r.files} files, ${r.historyEntries} audit entries of the source (import ${r.importId}).\n` +
        (r.paused.length ? `Paused until you turn them on: ${r.paused.map((p) => `${p.count} ${p.label}`).join(', ')}.\n` : '') +
        r.temporaryPasswords.map((t) => `One-time password for '${t.username}': ${t.password}\n`).join('') +
        `Recorded in the audit log as ${actor()} (instance.imported). Start Steward and check Settings → Migration.\n`,
    );
    return EXIT_OK;
  } finally {
    pkg.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  // no top-level await: the desktop executable bundles this file as CommonJS
  void runMigrate(process.argv.slice(2), 'npm run migrate --').then((code) => (process.exitCode = code));
}
