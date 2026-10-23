/**
 * Sandbox contract test for CI: asks a running Steward to call the
 * documented GET operations of a platform and compare them with its OpenAPI
 * specifications. Run with --help for usage.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ContractCheckResult } from '@sm/shared';
import { scrubString } from '@sm/shared';
import { config } from '../config.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, UsageError, palette, parseCli, usageFailure } from './args.js';

const COMMAND = 'npm run contract --';

const HELP = `Contract check: a running Steward calls every documented GET operation
(without required parameters) of a platform and compares the responses with
the platform's OpenAPI specifications.

Usage:
  npm run contract -- --platform <id> [options]

Options:
  --url <url>          Steward URL (default: $STEWARD_URL, $SM_URL or http://127.0.0.1:4310)
  --platform <id>      Platform id (default: $STEWARD_PLATFORM or $SM_PLATFORM)
  --token-file <path>  Read the API token from a file ("-" = standard input)
  --token <token>      API token (avoid: visible in shell history and process lists)
  --timeout <seconds>  Give up after this many seconds (default 300)
  --json               Print the raw result as JSON
  -h, --help           Show this help
  -V, --version        Print the version

The API token (smt_…, read scope is enough) is taken from --token-file,
$STEWARD_TOKEN or $SM_TOKEN – in that order of preference – and never printed.

Examples:
  export STEWARD_TOKEN=smt_…          # e.g. from your CI secret store
  npm run contract -- --platform sandbox-hub
  npm run --silent contract -- --url https://steward.corp.example --platform sandbox-hub --json > contract.json
  vault read -field=token secret/steward | npm run contract -- --token-file - --platform sandbox-hub

Exit status: 0 = all checked operations passed, 1 = at least one failed,
2 = usage error or the check could not run (server unreachable, HTTP error, invalid token).
`;

function readToken(file: string): string {
  const text = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(file), 'utf8');
  return text.trim();
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let values;
  try {
    ({ values } = parseCli(argv, {
      url: { type: 'string' },
      platform: { type: 'string' },
      token: { type: 'string' },
      'token-file': { type: 'string' },
      timeout: { type: 'string' },
      json: { type: 'boolean' },
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
    process.stdout.write(`${config.version}\n`);
    return EXIT_OK;
  }

  const url = (values.url ?? env.STEWARD_URL ?? env.SM_URL ?? 'http://127.0.0.1:4310').replace(/\/+$/, '');
  const platform = values.platform ?? env.STEWARD_PLATFORM ?? env.SM_PLATFORM;
  let token: string | undefined;
  try {
    token = values['token-file'] !== undefined ? readToken(values['token-file']) : (values.token ?? env.STEWARD_TOKEN ?? env.SM_TOKEN);
  } catch (e) {
    return usageFailure(new UsageError(`cannot read the token file: ${(e as Error).message}`), COMMAND);
  }
  if (values.token !== undefined) {
    process.stderr.write('warning: --token is visible in shell history and process lists; prefer STEWARD_TOKEN or --token-file\n');
  }
  const timeout = Number(values.timeout ?? 300);
  if (!Number.isFinite(timeout) || timeout <= 0) return usageFailure(new UsageError(`--timeout must be a positive number of seconds`), COMMAND);
  if (!platform) return usageFailure(new UsageError('no platform given', 'Pass --platform <id> or set STEWARD_PLATFORM.'), COMMAND);
  if (!token) return usageFailure(new UsageError('no API token given', 'Set STEWARD_TOKEN (or use --token-file).'), COMMAND);
  try {
    new URL(url);
  } catch {
    return usageFailure(new UsageError(`invalid --url '${url}'`), COMMAND);
  }

  const err = palette(process.stderr);
  const safe = (s: string) => scrubString(s, { secrets: [token!] });
  if (process.stderr.isTTY) process.stderr.write(err.dim(`Checking platform ${platform} on ${url} …\n`));
  let res: Response;
  try {
    res = await fetch(`${url}/api/platforms/${encodeURIComponent(platform)}/contract-check`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-sm-client': '1', 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(timeout * 1000),
    });
  } catch (e) {
    const cause = (e as Error & { cause?: Error }).cause?.message;
    process.stderr.write(`${err.red('✘')} Cannot reach ${url}: ${safe((e as Error).message)}${cause ? ` (${safe(cause)})` : ''}\n`);
    return EXIT_USAGE;
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 500);
    try {
      msg = (JSON.parse(text) as { error?: string }).error ?? msg;
    } catch {
      /* not JSON */
    }
    process.stderr.write(`${err.red('✘')} HTTP ${res.status}: ${safe(msg)}\n`);
    if (res.status === 401) process.stderr.write('  Check the API token (expired or revoked?).\n');
    return EXIT_USAGE;
  }
  const r = JSON.parse(text) as ContractCheckResult;
  if (values.json) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else {
    const c = palette(process.stdout);
    const out: string[] = [];
    for (const x of r.results) {
      out.push(`${x.ok ? c.green('✔') : c.red('✘')} ${x.method} ${x.path}${x.operationId ? ` (${x.operationId})` : ''} → ${x.status || 'error'}`);
      for (const p of x.problems) out.push(`    ${p}`);
    }
    out.push(`\n${r.checked} checked, ${r.passed} passed, ${r.failed ? c.red(`${r.failed} failed`) : '0 failed'}, ${r.skipped} skipped`);
    process.stdout.write(out.join('\n') + '\n');
  }
  if (r.checked === 0) process.stderr.write('warning: no GET operations without path parameters found – import an OpenAPI specification first.\n');
  return r.failed > 0 ? EXIT_FAILURE : EXIT_OK;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (e) => {
      process.stderr.write(`${(e as Error)?.stack ?? e}\n`);
      process.exitCode = EXIT_USAGE;
    },
  );
}
