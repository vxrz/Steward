/**
 * Account recovery on the server itself, for when nobody can sign in as an administrator:
 *
 *   steward admin list-admins [--json]                      (desktop executable)
 *   steward admin reset-password <username> [--activate]
 *   npm run admin -- reset-password <username>              (from the source tree)
 *
 * It needs local access to the data folder and the master passphrase (SM_MASTER_PASSPHRASE[_FILE],
 * --passphrase-stdin, or a prompt), so it gives no more access than someone who can already read
 * the data folder and unlock the vault. Steward must be stopped. Every change is written to the
 * audit log with the operating-system account that ran the command.
 */
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { EXIT_FAILURE, EXIT_OK, UsageError, parseCli, usageFailure } from './args.js';

const help = (command: string) => `Account recovery for Steward (run on the server, with Steward stopped).

Usage:
  ${command} list-admins [options]
  ${command} reset-password <username> [options]

Commands:
  list-admins                 List the administrator accounts and whether they can sign in
  reset-password <username>   Set a one-time password for a local account; it must be changed
                              at the next sign-in. Signs out all sessions of the account.

Options:
  --activate            With reset-password: also reactivate a deactivated account
  --data-dir <path>     Data folder (default: $SM_DATA_DIR or the per-user folder)
  --passphrase-stdin    Read the master passphrase from standard input
  --json                Machine-readable output
  -h, --help            Show this help

The master passphrase comes from SM_MASTER_PASSPHRASE_FILE / SM_MASTER_PASSPHRASE,
--passphrase-stdin, or a prompt (when run in a terminal).

Examples:
  ${command} list-admins
  ${command} reset-password admin
  SM_MASTER_PASSPHRASE_FILE=/run/secrets/steward ${command} reset-password alice --activate

Exit status: 0 = ok, 1 = failure (wrong passphrase, unknown account, Steward still running), 2 = usage error.
`;

const OPTIONS = {
  activate: { type: 'boolean' },
  'data-dir': { type: 'string' },
  'passphrase-stdin': { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

class Failure extends Error {}

/** Set once the database is open, so it is closed again (PostgreSQL: releases the lock). */
let closeDb: (() => void) | undefined;

/** Reads a line without echoing it (the terminal shows nothing while typing). */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void };
    let asked = false;
    out._writeToOutput = (s: string) => {
      if (!asked) {
        process.stderr.write(s);
        asked = true;
      }
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });
    rl.on('SIGINT', () => {
      rl.close();
      reject(new Failure('cancelled'));
    });
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === 'EPERM';
  }
}

/** The OS account and machine, recorded as the actor in the audit log. */
function actor(): string {
  let user = 'unknown';
  try {
    user = os.userInfo().username;
  } catch {
    /* no passwd entry (containers) */
  }
  return `cli:${user}@${os.hostname()}`;
}

export async function runAdmin(argv: string[], command = 'steward admin'): Promise<number> {
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
  if (sub !== 'list-admins' && sub !== 'reset-password')
    return usageFailure(new UsageError(`unknown command '${sub}'`, 'Commands: list-admins, reset-password'), command);
  if (sub === 'reset-password' && rest.length !== 1) return usageFailure(new UsageError('reset-password takes exactly one username'), command);
  if (sub === 'list-admins' && rest.length) return usageFailure(new UsageError(`unexpected argument '${rest[0]}'`), command);
  if (values.activate && sub !== 'reset-password') return usageFailure(new UsageError('--activate only works with reset-password'), command);

  // before config.ts is evaluated
  if (values['data-dir']) process.env.SM_DATA_DIR = path.resolve(values['data-dir']);
  process.env.SM_LOG_LEVEL ??= 'warn';

  try {
    return await execute(sub, rest[0], values);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (values.json) process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
    process.stderr.write(`error: ${msg}\n`);
    return EXIT_FAILURE;
  } finally {
    closeDb?.();
  }
}

async function execute(
  sub: string,
  username: string | undefined,
  values: { activate?: boolean; 'passphrase-stdin'?: boolean; json?: boolean },
): Promise<number> {
  await import('../bootstrap.js');
  const fs = await import('node:fs');
  const { config } = await import('../config.js');
  const { instanceFile, verifyInstance } = await import('../instance.js');

  // Steward running on this data folder? (The running server keeps its own copy of sessions and throttles.)
  if (fs.existsSync(instanceFile())) {
    try {
      const inst = JSON.parse(fs.readFileSync(instanceFile(), 'utf8')) as { url?: string; pid?: number };
      if (inst.url && (await verifyInstance(inst.url, config.dataDir, 3000)) === 'ok') {
        throw new Failure(`Steward is running at ${inst.url} with this data folder – stop it first`);
      }
      // not answering, but its process is still there (hanging, or starting up)
      if (inst.pid && inst.pid !== process.pid && alive(inst.pid)) {
        throw new Failure(`Steward (process ${inst.pid}) seems to be running with this data folder – stop it first (if it is not, delete ${instanceFile()})`);
      }
    } catch (e) {
      if (e instanceof Failure) throw e;
    }
  }

  const { vault } = await import('../vault.js');
  if (!vault().initialized) throw new Failure(`no Steward installation in ${config.dataDir} (no vault.json) – use --data-dir or SM_DATA_DIR`);

  const { db } = await import('../db.js');
  const d = db(); // opens the database and applies pending migrations; on PostgreSQL this fails while the server holds its lock
  closeDb = () => d.close();
  const { connectVaultToDatabase } = await import('../vault-rotation.js');
  connectVaultToDatabase();

  let passphrase = config.masterPassphrase;
  if (!passphrase && values['passphrase-stdin']) passphrase = await readStdin();
  if (!passphrase && process.stdin.isTTY) passphrase = await promptHidden('Master passphrase: ');
  if (!passphrase) throw new Failure('the master passphrase is needed: set SM_MASTER_PASSPHRASE_FILE, use --passphrase-stdin or run in a terminal');
  try {
    await vault().unlock(passphrase);
  } catch (e) {
    if ((e as { code?: string }).code === 'WRONG_PASSPHRASE') throw new Failure('wrong master passphrase');
    throw e;
  }
  const { flushPendingAudit } = await import('../audit.js');
  flushPendingAudit();

  const users = await import('../auth/users.js');
  if (sub === 'list-admins') {
    const admins = users.listUsers().filter((u) => u.roles.includes('admin'));
    if (values.json) {
      process.stdout.write(
        JSON.stringify({
          ok: true,
          admins: admins.map((u) => ({
            username: u.username,
            displayName: u.displayName,
            active: u.active,
            authSource: u.authSource,
            lastLoginAt: u.lastLoginAt,
          })),
        }) + '\n',
      );
    } else if (!admins.length) {
      process.stdout.write('No administrator accounts.\n');
    } else {
      for (const u of admins) {
        const notes = [u.active ? '' : 'deactivated', u.authSource === 'local' ? '' : `single sign-on (${u.authSource})`].filter(Boolean);
        process.stdout.write(`${u.username}  ${u.displayName}${notes.length ? `  [${notes.join(', ')}]` : ''}  last sign-in: ${u.lastLoginAt ?? 'never'}\n`);
      }
    }
    return EXIT_OK;
  }

  const user = users.findUserByName(username!);
  if (!user) throw new Failure(`no account '${username}' (list the administrators with 'list-admins')`);
  if (user.authSource !== 'local') throw new Failure(`'${user.username}' signs in with single sign-on and has no password`);
  if (!user.active && !values.activate) throw new Failure(`'${user.username}' is deactivated – add --activate to reactivate it`);
  const by = actor();
  const temp = users.recoverAccount(user.id, { actor: by, activate: !!values.activate });
  if (values.json) {
    process.stdout.write(JSON.stringify({ ok: true, username: user.username, temporaryPassword: temp, reactivated: !user.active }) + '\n');
  } else {
    process.stdout.write(
      `One-time password for '${user.username}': ${temp}\n` +
        `${user.active ? '' : 'The account was reactivated. '}Sign in with it; Steward then asks for a new password. All sessions of the account were signed out.\n` +
        `Recorded in the audit log as ${by}.\n`,
    );
  }
  return EXIT_OK;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  // no top-level await: the desktop executable bundles this file as CommonJS
  void runAdmin(process.argv.slice(2), 'npm run admin --').then((code) => (process.exitCode = code));
}
