/**
 * Account recovery on the server itself, for when nobody can sign in as an administrator:
 *
 *   steward admin list-admins [--json]                      (desktop executable)
 *   steward admin reset-password <username> [--activate]
 *   steward admin emergency-access <username> [--minutes 60]
 *   steward admin password-login all|adminsOnly|none
 *   npm run admin -- reset-password <username>              (from the source tree)
 *
 * It needs local access to the data folder and the master passphrase (SM_MASTER_PASSPHRASE[_FILE],
 * --passphrase-stdin, or a prompt), so it gives no more access than someone who can already read
 * the data folder and unlock the vault. Steward must be stopped – except for emergency-access, which
 * hands a grant signed with the vault's key to the running server over loopback (auth/emergency.ts).
 * Every change is written to the audit log with the operating-system account that ran the command.
 */
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { EXIT_FAILURE, EXIT_OK, UsageError, parseCli, usageFailure } from './args.js';

const help = (command: string) => `Account recovery for Steward (run on the server).

Usage:
  ${command} list-admins [options]
  ${command} reset-password <username> [options]
  ${command} emergency-access <username> [--minutes <n>] [options]
  ${command} password-login all|adminsOnly|none [options]

Commands:
  list-admins                   List the administrator accounts and how they can sign in
  reset-password <username>     Set a one-time password for a local account; it must be changed
                                at the next sign-in. Signs out all sessions of the account.
  emergency-access <username>   Print a one-time sign-in link for an administrator (local or single
                                sign-on account) that works once within the window, also when
                                password sign-in is turned off. The session is marked as emergency
                                access, lasts at most one hour, and the other administrators are told.
                                Works while Steward is running (on this machine) or stopped.
  password-login <mode>         Who may sign in with a password: all, adminsOnly or none (single
                                sign-on only). Signs out password sessions the new mode refuses.

Options:
  --activate            With reset-password: also reactivate a deactivated account
  --minutes <n>         With emergency-access: the window in minutes (default 60, at most 1440)
  --data-dir <path>     Data folder (default: $SM_DATA_DIR or the per-user folder)
  --passphrase-stdin    Read the master passphrase from standard input
  --json                Machine-readable output
  -h, --help            Show this help

The master passphrase comes from SM_MASTER_PASSPHRASE_FILE / SM_MASTER_PASSPHRASE,
--passphrase-stdin, or a prompt (when run in a terminal). Except for emergency-access,
Steward must be stopped.

Examples:
  ${command} list-admins
  ${command} reset-password admin
  ${command} emergency-access alice --minutes 30
  ${command} password-login adminsOnly
  SM_MASTER_PASSPHRASE_FILE=/run/secrets/steward ${command} reset-password alice --activate

Exit status: 0 = ok, 1 = failure (wrong passphrase, unknown account, Steward still running), 2 = usage error.
`;

const COMMANDS = ['list-admins', 'reset-password', 'emergency-access', 'password-login'] as const;
type Command = (typeof COMMANDS)[number];

const OPTIONS = {
  activate: { type: 'boolean' },
  minutes: { type: 'string' },
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
  if (!(COMMANDS as readonly string[]).includes(sub))
    return usageFailure(new UsageError(`unknown command '${sub}'`, `Commands: ${COMMANDS.join(', ')}`), command);
  if ((sub === 'reset-password' || sub === 'emergency-access') && rest.length !== 1)
    return usageFailure(new UsageError(`${sub} takes exactly one username`), command);
  if (sub === 'password-login' && (rest.length !== 1 || !['all', 'adminsOnly', 'none'].includes(rest[0]!)))
    return usageFailure(new UsageError('password-login takes one of: all, adminsOnly, none'), command);
  if (sub === 'list-admins' && rest.length) return usageFailure(new UsageError(`unexpected argument '${rest[0]}'`), command);
  if (values.activate && sub !== 'reset-password') return usageFailure(new UsageError('--activate only works with reset-password'), command);
  if (values.minutes !== undefined && sub !== 'emergency-access') return usageFailure(new UsageError('--minutes only works with emergency-access'), command);
  const minutes = values.minutes === undefined ? 60 : /^\d{1,5}$/.test(values.minutes) ? Number(values.minutes) : NaN;
  if (!(minutes >= 1 && minutes <= 1440)) return usageFailure(new UsageError('--minutes must be a whole number from 1 to 1440'), command);

  // before config.ts is evaluated
  if (values['data-dir']) process.env.SM_DATA_DIR = path.resolve(values['data-dir']);
  process.env.SM_LOG_LEVEL ??= 'warn';

  try {
    return await execute(sub as Command, rest[0], { ...values, minutes });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (values.json) process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
    process.stderr.write(`error: ${msg}\n`);
    return EXIT_FAILURE;
  } finally {
    closeDb?.();
  }
}

/** The master passphrase from the environment, standard input or a prompt. */
async function passphrase(values: { 'passphrase-stdin'?: boolean }, fromConfig: string | undefined): Promise<string> {
  let p = fromConfig;
  if (!p && values['passphrase-stdin']) p = await readStdin();
  if (!p && process.stdin.isTTY) p = await promptHidden('Master passphrase: ');
  if (!p) throw new Failure('the master passphrase is needed: set SM_MASTER_PASSPHRASE_FILE, use --passphrase-stdin or run in a terminal');
  return p;
}

async function unlockVault(p: string): Promise<void> {
  const { vault } = await import('../vault.js');
  try {
    await vault().unlock(p);
  } catch (e) {
    if ((e as { code?: string }).code === 'WRONG_PASSPHRASE') throw new Failure('wrong master passphrase');
    throw e;
  }
}

interface Values {
  activate?: boolean;
  'passphrase-stdin'?: boolean;
  json?: boolean;
  minutes: number;
}

async function execute(sub: Command, username: string | undefined, values: Values): Promise<number> {
  await import('../bootstrap.js');
  const fs = await import('node:fs');
  const { config, loopbackUrl } = await import('../config.js');
  const { instanceFile, verifyInstance } = await import('../instance.js');

  // Steward running on this data folder? (The running server keeps its own copy of sessions and throttles.)
  let running: { url: string; instanceId: string } | undefined;
  if (fs.existsSync(instanceFile())) {
    try {
      const inst = JSON.parse(fs.readFileSync(instanceFile(), 'utf8')) as { url?: string; pid?: number; instanceId?: string };
      if (inst.url && (await verifyInstance(inst.url, config.dataDir, 3000)) === 'ok') {
        if (sub !== 'emergency-access') throw new Failure(`Steward is running at ${inst.url} with this data folder – stop it first`);
        running = { url: inst.url, instanceId: String(inst.instanceId) };
      } else if (inst.pid && inst.pid !== process.pid && alive(inst.pid)) {
        // not answering, but its process is still there (hanging, or starting up)
        throw new Failure(`Steward (process ${inst.pid}) seems to be running with this data folder – stop it first (if it is not, delete ${instanceFile()})`);
      }
    } catch (e) {
      if (e instanceof Failure) throw e;
    }
  }

  const { vault } = await import('../vault.js');
  if (!vault().initialized) throw new Failure(`no Steward installation in ${config.dataDir} (no vault.json) – use --data-dir or SM_DATA_DIR`);

  const emergencyLink = (base: string, code: string) => `${base.replace(/\/+$/, '')}/emergency-access#code=${code}`;
  const printGrant = (g: { username: string; expiresAt: string; minutes: number }, link: string, mode: string) => {
    if (values.json) {
      process.stdout.write(JSON.stringify({ ok: true, username: g.username, link, expiresAt: g.expiresAt, minutes: g.minutes, mode }) + '\n');
    } else {
      process.stdout.write(
        `Emergency access for '${g.username}' until ${g.expiresAt} (${g.minutes} minute(s)), usable once:\n\n  ${link}\n\n` +
          `Open the link in a browser that reaches Steward${mode === 'stopped' ? ' once it runs again' : ''}. The session lasts at most one hour and is\n` +
          `marked as emergency access; the other administrators are notified. Fix the sign-in, then sign out.\n` +
          `Recorded in the audit log as ${actor()}.\n`,
      );
    }
  };

  if (running) {
    // emergency-access while Steward runs: a grant signed with the vault's key, sent over loopback (auth/emergency.ts)
    await unlockVault(await passphrase(values, config.masterPassphrase));
    const { makeSignedGrant, newCode, hashCode } = await import('../auth/emergency.js');
    const code = newCode();
    const body = makeSignedGrant({ instanceId: running.instanceId, username: username!, minutes: values.minutes, codeHash: hashCode(code), actor: actor() });
    let res: Response;
    try {
      res = await fetch(`${running.url}/api/auth/emergency/grant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sm-client': '1' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      throw new Failure(`Steward runs at ${running.url} but did not answer (${(e as Error).message}) – stop it and run the command again`);
    }
    const out = (await res.json().catch(() => ({}))) as { error?: string; username?: string; expiresAt?: string; minutes?: number };
    if (!res.ok) throw new Failure(`the running Steward refused: ${out.error ?? `HTTP ${res.status}`}`);
    printGrant({ username: out.username!, expiresAt: out.expiresAt!, minutes: out.minutes! }, emergencyLink(config.publicUrl ?? running.url, code), 'running');
    return EXIT_OK;
  }

  const { db } = await import('../db.js');
  const d = db(); // opens the database and applies pending migrations; on PostgreSQL this fails while the server holds its lock
  closeDb = () => d.close();
  const { connectVaultToDatabase } = await import('../vault-rotation.js');
  connectVaultToDatabase();

  await unlockVault(await passphrase(values, config.masterPassphrase));
  const { flushPendingAudit } = await import('../audit.js');
  flushPendingAudit();

  const users = await import('../auth/users.js');
  const settings = await import('../settings.js');
  const { listProviders } = await import('../auth/sso.js');
  const mode = settings.passwordLoginMode();
  if (sub === 'list-admins') {
    const { openGrants } = await import('../auth/emergency.js');
    const windows = openGrants();
    const providers = new Map(listProviders().map((p) => [p.id, p]));
    const admins = users.listUsers().filter((u) => u.roles.includes('admin'));
    /** How the account can sign in right now. */
    const ways = (u: (typeof admins)[number]) => {
      const out: string[] = [];
      if (!u.active) return out;
      if (u.authSource !== 'local') {
        if (providers.get(u.authSource)?.enabled) out.push('sso');
      } else if (mode !== 'none') out.push('password');
      if (windows.has(u.id)) out.push('emergency');
      return out;
    };
    if (values.json) {
      process.stdout.write(
        JSON.stringify({
          ok: true,
          passwordLogin: mode,
          admins: admins.map((u) => ({
            username: u.username,
            displayName: u.displayName,
            active: u.active,
            authSource: u.authSource,
            singleSignOn: u.authSource === 'local' ? null : (providers.get(u.authSource)?.displayName ?? u.authSource),
            signIn: ways(u),
            emergencyUntil: windows.get(u.id) ?? null,
            lastLoginAt: u.lastLoginAt,
          })),
        }) + '\n',
      );
    } else if (!admins.length) {
      process.stdout.write('No administrator accounts.\n');
    } else {
      process.stdout.write(`Password sign-in: ${mode}${settings.passwordLoginFromEnv() ? ' (set by SM_PASSWORD_LOGIN)' : ''}\n`);
      for (const u of admins) {
        const p = providers.get(u.authSource);
        const how = !u.active
          ? 'deactivated'
          : u.authSource !== 'local'
            ? `single sign-on (${p?.displayName ?? u.authSource}${p && !p.enabled ? ', provider disabled' : ''})`
            : mode === 'none'
              ? 'password (refused: single sign-on only)'
              : 'password';
        const window = windows.get(u.id) ? `, emergency access open until ${windows.get(u.id)}` : '';
        process.stdout.write(`${u.username}  ${u.displayName}  [${how}${window}]  last sign-in: ${u.lastLoginAt ?? 'never'}\n`);
      }
    }
    return EXIT_OK;
  }

  if (sub === 'password-login') {
    const next = username as 'all' | 'adminsOnly' | 'none';
    const env = settings.passwordLoginFromEnv();
    if (env) throw new Failure(`SM_PASSWORD_LOGIN=${env} is set for this installation and wins over the setting – change it there`);
    if (next !== 'all') {
      const enabled = listProviders().filter((p) => p.enabled);
      if (!enabled.length) throw new Failure('no single sign-on provider is enabled – nobody could sign in without a password');
      const ssoAdmins = users.listUsers().filter((u) => u.active && u.roles.includes('admin') && enabled.some((p) => p.id === u.authSource));
      if (next === 'none' && !ssoAdmins.length)
        throw new Failure(
          'no active administrator signs in with an enabled single sign-on provider – sign in once with single sign-on as an administrator first',
        );
    }
    const by = actor();
    const { audit } = await import('../audit.js');
    const { db: dbOf } = await import('../db.js');
    const ended = dbOf().tx(() => {
      settings.updateSettings({ passwordLogin: next });
      const n = mode === next ? 0 : users.endPasswordSessions(next);
      audit({
        actor: by,
        action: 'settings.updated',
        entityType: 'settings',
        summary: `Password sign-in ${mode} → ${next} set with the recovery command on the server${n ? ` (${n} password session(s) signed out)` : ''}`,
        details: { passwordLogin: next, via: 'cli', ...(n ? { sessionsEnded: n } : {}) },
      });
      return n;
    });
    if (values.json) process.stdout.write(JSON.stringify({ ok: true, passwordLogin: next, previous: mode, sessionsEnded: ended }) + '\n');
    else
      process.stdout.write(
        `Password sign-in: ${mode} → ${next}.${ended ? ` ${ended} password session(s) signed out.` : ''} Recorded in the audit log as ${by}.\n`,
      );
    return EXIT_OK;
  }

  if (sub === 'emergency-access') {
    const { createGrant, newCode, hashCode } = await import('../auth/emergency.js');
    const code = newCode();
    let g;
    try {
      g = createGrant({ username: username!, minutes: values.minutes, actor: actor(), codeHash: hashCode(code), via: 'cli' });
    } catch (e) {
      throw new Failure((e as Error).message);
    }
    printGrant(g, emergencyLink(config.publicUrl ?? loopbackUrl(), code), 'stopped');
    return EXIT_OK;
  }

  const user = users.findUserByName(username!);
  if (!user) throw new Failure(`no account '${username}' (list the administrators with 'list-admins')`);
  if (user.authSource !== 'local')
    throw new Failure(`'${user.username}' signs in with single sign-on and has no password – use 'emergency-access ${user.username}'`);
  if (mode === 'none')
    throw new Failure(
      `password sign-in is turned off (single sign-on only), so a password would not work – use 'emergency-access ${user.username}', or 'password-login all' first`,
    );
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
