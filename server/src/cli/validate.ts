/**
 * Validate process, dashboard and monitor definitions (YAML/JSON) – for CI and for
 * reviewing changes to the example library. Run with --help for usage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BUNDLE_FORMATS, dashboardDefinitionSchema, validateProcess } from '@sm/shared';
import { validateMonitorFile } from '../monitors/validation.js';
import { config } from '../config.js';
import { MAX_DEFINITION_TEXT } from '../util.js';
import { parseYaml } from '../yaml-safe.js';
import { EXIT_FAILURE, EXIT_OK, UsageError, palette, parseCli, usageFailure } from './args.js';

const COMMAND = 'npm run validate --';

const HELP = `Validate Steward process, dashboard and monitor definitions (YAML or JSON).

Usage:
  npm run validate [-- [options] [path ...]]

Paths can be files or folders (searched recursively for .yaml, .yml and .json).
Without a path the bundled example library (examples/) is checked.

Options:
  --json         Print the result as JSON (for scripts and CI)
  -q, --quiet    Only print errors and the summary
  -h, --help     Show this help
  -V, --version  Print the version

Examples:
  npm run validate
  npm run validate -- my-processes/ dashboards/ops.yaml
  npm run --silent validate -- --json processes/ > validation.json

Exit status: 0 = all definitions valid (warnings allowed), 1 = at least one invalid
definition, 2 = usage error (unknown option, path not found).
Colours are only used on a terminal; NO_COLOR=1 turns them off.
`;

export interface FileResult {
  file: string;
  kind: 'process' | 'dashboard' | 'monitor' | 'monitor template' | 'bundle' | 'unreadable';
  /** Nodes (process), widgets (dashboard) or checks (monitor). */
  ok: boolean;
  count?: number;
  errors: string[];
  warnings: string[];
}

function files(p: string): string[] {
  const st = fs.statSync(p);
  if (st.isDirectory()) return fs.readdirSync(p).flatMap((f) => files(path.join(p, f)));
  return /\.(ya?ml|json)$/i.test(p) ? [p] : [];
}

export async function validateFile(file: string): Promise<FileResult> {
  const rel = path.relative(process.cwd(), file) || file;
  let raw: unknown;
  try {
    const text = fs.readFileSync(file, 'utf8');
    raw = file.endsWith('.json') ? JSON.parse(text) : parseYaml(text, { maxBytes: MAX_DEFINITION_TEXT });
  } catch (e) {
    return { file: rel, kind: 'unreadable', ok: false, errors: [`cannot parse – ${(e as Error).message}`], warnings: [] };
  }
  const obj = raw as Record<string, unknown>;
  if (obj && typeof obj === 'object' && (BUNDLE_FORMATS as readonly unknown[]).includes(obj.format)) {
    return { file: rel, kind: 'bundle', ok: true, errors: [], warnings: [] };
  }
  if (obj && (obj.kind === 'monitor' || obj.kind === 'monitorTemplate')) {
    const r = await validateMonitorFile(obj);
    const kind = obj.kind === 'monitorTemplate' ? 'monitor template' : 'monitor';
    return { file: rel, kind, ok: r.ok, count: r.checks, errors: r.ok ? [] : r.issues, warnings: [] };
  }
  if (obj && Array.isArray(obj.widgets)) {
    const r = dashboardDefinitionSchema.safeParse(raw);
    return r.success
      ? { file: rel, kind: 'dashboard', ok: true, count: r.data.widgets.length, errors: [], warnings: [] }
      : { file: rel, kind: 'dashboard', ok: false, errors: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`), warnings: [] };
  }
  const r = validateProcess(raw);
  return {
    file: rel,
    kind: 'process',
    ok: r.ok,
    count: r.ok ? r.definition!.nodes.length : undefined,
    errors: r.ok ? [] : r.issues.map((i) => `${i.nodeId ? `[${i.nodeId}] ` : ''}${i.path} ${i.message}`),
    warnings: r.warnings.map((w) => `${w.nodeId ? `[${w.nodeId}] ` : ''}${w.message}`),
  };
}

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseCli(
      argv,
      {
        json: { type: 'boolean' },
        quiet: { type: 'boolean', short: 'q' },
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
  if (values.help) {
    process.stdout.write(HELP);
    return EXIT_OK;
  }
  if (values.version) {
    process.stdout.write(`${config.version}\n`);
    return EXIT_OK;
  }

  const targets = positionals.length ? positionals : [path.resolve(import.meta.dirname, '../../../examples')];
  const missing = targets.filter((t) => !fs.existsSync(t));
  if (missing.length) return usageFailure(new UsageError(`path not found: ${missing.join(', ')}`), COMMAND);

  const results: FileResult[] = [];
  for (const f of targets.flatMap(files).sort()) results.push(await validateFile(f));
  const errors = results.filter((r) => !r.ok).length;
  const warnings = results.reduce((n, r) => n + r.warnings.length, 0);

  if (values.json) {
    process.stdout.write(JSON.stringify({ ok: errors === 0, errors, warnings, files: results }, null, 2) + '\n');
    return errors ? EXIT_FAILURE : EXIT_OK;
  }
  const c = palette(process.stdout);
  const out: string[] = [];
  for (const r of results) {
    if (!r.ok) out.push(`${c.red('✘')} ${r.file}: ${r.errors.join('; ')}`);
    else if (!values.quiet) {
      if (r.kind === 'bundle') out.push(`${c.dim('•')} ${r.file}: bundle (skipped)`);
      else
        out.push(`${c.green('✔')} ${r.file}: ${r.kind}, ${r.count} ${r.kind === 'dashboard' ? 'widgets' : r.kind.startsWith('monitor') ? 'checks' : 'nodes'}`);
    }
    if (!values.quiet || !r.ok) for (const w of r.warnings) out.push(`  ${c.yellow('⚠')} ${w}`);
  }
  if (!results.length) out.push('No .yaml, .yml or .json files found.');
  out.push(`\n${errors ? c.red(`${errors} error(s)`) : '0 error(s)'}, ${warnings} warning(s)`);
  process.stdout.write(out.join('\n') + '\n');
  return errors ? EXIT_FAILURE : EXIT_OK;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = await main(process.argv.slice(2));
}
