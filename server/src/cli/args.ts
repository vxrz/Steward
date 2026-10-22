/**
 * Small helpers shared by Steward's command-line tools (validate, contract,
 * desktop launcher), following https://clig.dev:
 * exit codes 0 = ok, 1 = failure/findings, 2 = usage error (or the check could not run);
 * unknown flags are usage errors with a hint; colours only on a TTY and never with NO_COLOR.
 */
import { parseArgs, type ParseArgsConfig } from 'node:util';

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

export class UsageError extends Error {
  constructor(
    message: string,
    public hint?: string,
  ) {
    super(message);
  }
}

type Options = NonNullable<ParseArgsConfig['options']>;

/** Edit distance (optimal string alignment). */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      // swapped neighbours ("jsno" → "json") count as one edit
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  return d[a.length]![b.length]!;
}

/** "Did you mean --json?" for a mistyped option. */
export function suggest(unknown: string, options: Options): string | undefined {
  const name = unknown.replace(/^-+/, '').split('=')[0]!;
  let best: string | undefined;
  let bestD = Infinity;
  for (const o of Object.keys(options)) {
    const dd = distance(name, o);
    if (dd < bestD) [best, bestD] = [o, dd];
  }
  return best && bestD <= Math.max(1, Math.floor(name.length / 3)) ? `--${best}` : undefined;
}

/** Strict parsing: unknown options and missing values become a UsageError. */
export function parseCli<O extends Options>(argv: string[], options: O, opts: { positionals?: boolean } = {}) {
  try {
    return parseArgs({ args: argv, options, strict: true, allowPositionals: opts.positionals ?? false });
  } catch (e) {
    const err = e as Error & { code?: string };
    const m = /'([^']+)'/.exec(err.message);
    if (err.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' && m) {
      const s = suggest(m[1]!, options);
      throw new UsageError(`unknown option '${m[1]}'`, s ? `Did you mean ${s}?` : undefined);
    }
    if (err.code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL' && m) throw new UsageError(`unexpected argument '${m[1]}'`);
    if (err.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') throw new UsageError(err.message.replace(/^Option '(.*?)'/, "option '$1'").replace(/\.$/, ''));
    throw new UsageError(err.message);
  }
}

/** Prints a usage error to stderr (with the "--help" pointer) and returns exit code 2. */
export function usageFailure(e: UsageError, command: string): number {
  process.stderr.write(`error: ${e.message}\n${e.hint ? `${e.hint}\n` : ''}Run '${command} --help' for usage.\n`);
  return EXIT_USAGE;
}

/** Colours for a stream: only on a TTY, never with NO_COLOR or TERM=dumb; FORCE_COLOR forces them on. */
export function palette(stream: NodeJS.WriteStream = process.stdout) {
  const env = process.env;
  const on =
    env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0'
      ? true
      : !env.NO_COLOR && env.TERM !== 'dumb' && !!stream.isTTY && env.FORCE_COLOR !== '0';
  const wrap = (code: number) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { enabled: on, red: wrap(31), green: wrap(32), yellow: wrap(33), dim: wrap(2), bold: wrap(1) };
}
