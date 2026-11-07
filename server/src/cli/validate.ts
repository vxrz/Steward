/**
 * Validate process, dashboard and monitor definitions (YAML/JSON) – for CI and for
 * reviewing changes to the example library. Run with --help for usage.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  BUILT_IN_PUBLISHER_KEYS,
  BUNDLE_FORMATS,
  CONNECTOR_FORMATS,
  LIBRARY_MANIFEST_FORMAT,
  LIBRARY_RELEASE_FILE,
  LIBRARY_RELEASE_FORMAT,
  LIBRARY_SIGNATURE_FILE,
  WEBHOOK_TRIGGER_EXAMPLE_KIND,
  dashboardDefinitionSchema,
  validateProcess,
  webhookTriggerExampleSchema,
} from '@sm/shared';
import { validateMonitorFile } from '../monitors/validation.js';
import { plantFileSchema } from '../plant/format.js';
import { bundleFileSchema, looksLikeBundle } from '../onboarding/bundleSchema.js';
import { config } from '../config.js';
import { MAX_DEFINITION_TEXT } from '../util.js';
import { parseYaml } from '../yaml-safe.js';
import { factsOf, lintContract, parseContract } from '../datacontracts/odcs.js';
import { EXIT_FAILURE, EXIT_OK, UsageError, palette, parseCli, usageFailure } from './args.js';

const COMMAND = 'npm run validate --';

const HELP = `Validate Steward process, dashboard and monitor definitions and data contracts (YAML or JSON).

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
  kind:
    | 'process'
    | 'dashboard'
    | 'monitor'
    | 'monitor template'
    | 'bundle'
    | 'template bundle'
    | 'plant registry'
    | 'webhook trigger'
    | 'data contract'
    | 'library'
    | 'library release'
    | 'record type'
    | 'connector type'
    | 'unreadable';
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
  // a shared procedure library (#238, examples/libraries): the folder of its manifest – items, release.json, signature
  if (obj && typeof obj === 'object' && obj.format === LIBRARY_MANIFEST_FORMAT) return validateLibrary(file, rel);
  // release.json is checked together with its manifest (above)
  if (obj && typeof obj === 'object' && obj.format === LIBRARY_RELEASE_FORMAT)
    return { file: rel, kind: 'library release', ok: true, errors: [], warnings: [] };
  if (obj && typeof obj === 'object' && (CONNECTOR_FORMATS as readonly unknown[]).includes(obj.format)) {
    try {
      const { parseConnectorPackage } = await import('../platforms/connectors.js');
      const pkg = parseConnectorPackage(raw);
      return { file: rel, kind: 'connector type', ok: true, count: pkg.specs.length, errors: [], warnings: [] };
    } catch (e) {
      return { file: rel, kind: 'connector type', ok: false, errors: [(e as Error).message], warnings: [] };
    }
  }
  if (obj && typeof obj === 'object' && (BUNDLE_FORMATS as readonly unknown[]).includes(obj.format)) {
    return { file: rel, kind: 'bundle', ok: true, errors: [], warnings: [] };
  }
  // a template bundle (v0.4.0, examples/bundles): processes, dashboards and monitors set up together
  if (looksLikeBundle(obj)) {
    const r = bundleFileSchema.safeParse(raw);
    return r.success
      ? {
          file: rel,
          kind: 'template bundle',
          ok: true,
          count: r.data.processes.length + r.data.dashboards.length + r.data.monitors.length,
          errors: [],
          warnings: [],
        }
      : { file: rel, kind: 'template bundle', ok: false, errors: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`), warnings: [] };
  }
  // a plant registry file (#218, examples/plant): version 1 with sites, a site or assets – checked against its format;
  // since part 2 (#219) also device profiles, KPI definitions and assignments; since part 3 (#220) OT networks
  const PLANT_KEYS = [
    'sites',
    'site',
    'assets',
    'device_profiles',
    'device_profile',
    'kpi_definitions',
    'kpi_definition',
    'assignments',
    'assignment',
    'ot_networks',
    'ot_network',
    'asset_networks',
    'asset_network',
  ];
  if (obj && typeof obj === 'object' && 'version' in obj && PLANT_KEYS.some((k) => k in obj)) {
    const r = plantFileSchema.safeParse(raw);
    if (!r.success)
      return { file: rel, kind: 'plant registry', ok: false, errors: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`), warnings: [] };
    const sites = r.data.sites ?? (r.data.site ? [r.data.site] : []);
    const one = <T>(many: T[] | undefined, single: T | undefined) => many?.length ?? (single ? 1 : 0);
    const count =
      sites.length +
      sites.reduce((n, x) => n + (x.assets?.length ?? 0), 0) +
      (r.data.assets?.length ?? 0) +
      one(r.data.device_profiles, r.data.device_profile) +
      one(r.data.kpi_definitions, r.data.kpi_definition) +
      one(r.data.assignments, r.data.assignment) +
      [...(r.data.ot_networks ?? []), ...(r.data.ot_network ? [r.data.ot_network] : [])].reduce(
        (n, x) => n + (x.vlans?.length ?? 0) + (x.zones?.length ?? 0) + (x.conduits?.length ?? 0),
        0,
      ) +
      [...(r.data.asset_networks ?? []), ...(r.data.asset_network ? [r.data.asset_network] : [])].reduce(
        (n, x) => n + (x.devices?.length ?? 0) + (x.data_paths?.length ?? 0) + (x.checks ? 1 : 0),
        0,
      );
    return { file: rel, kind: 'plant registry', ok: true, count, errors: [], warnings: [] };
  }
  // an example webhook trigger (0.9.0, examples/triggers): its format, and its mapping against the process template
  if (obj && obj.kind === WEBHOOK_TRIGGER_EXAMPLE_KIND) return validateTriggerExample(file, rel, raw);
  // an ODCS v3 data contract (#221, examples/data-contracts): read within the limits of Steward and checked against the
  // JSON Schema of ODCS v3.0.2, as on save
  if (obj && typeof obj === 'object' && obj.kind === 'DataContract') {
    const p = parseContract(fs.readFileSync(file, 'utf8'));
    const findings = p.problems.length ? p.problems : lintContract(p.doc);
    const errors = findings.filter((f) => f.severity === 'error').map((f) => `${f.path}: ${f.message}`);
    const count = p.problems.length ? undefined : factsOf(p.doc).schemas.length;
    return {
      file: rel,
      kind: 'data contract',
      ok: !errors.length,
      count,
      errors,
      warnings: findings.filter((f) => f.severity !== 'error').map((f) => `${f.path}: ${f.message}`),
    };
  }
  // a record type (Git sync and libraries: kind recordType)
  if (obj && obj.kind === 'recordType') {
    const { typeInput } = await import('../records/types.js');
    const { kind: _k, ...rest } = obj;
    const r = typeInput.safeParse(rest);
    return r.success
      ? { file: rel, kind: 'record type', ok: true, count: r.data.fields.length, errors: [], warnings: [] }
      : { file: rel, kind: 'record type', ok: false, errors: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`), warnings: [] };
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

/**
 * A library folder: every item checks, release.json is what `npm run library -- build` writes now (not outdated),
 * and a signature verifies – against the built-in keys or a TEST-PUBLISHER-KEY.pub next to the folder (a test key,
 * named as such in the output: no installation trusts it by default).
 */
async function validateLibrary(file: string, rel: string): Promise<FileResult> {
  const { buildRelease } = await import('../libraries/build.js');
  const { readFolder, verifyRelease } = await import('../libraries/releases.js');
  const { parsePublicKeyLine, sshFingerprint } = await import('../libraries/sshsig.js');
  const dir = path.dirname(file);
  const errors: string[] = [];
  const warnings: string[] = [];
  let count: number | undefined;
  try {
    const files = readFolder(dir);
    const built = await buildRelease(files);
    count = built.items;
    const current = files.get(LIBRARY_RELEASE_FILE)?.toString('utf8');
    if (current === undefined) warnings.push(`${LIBRARY_RELEASE_FILE} is missing – run npm run library -- build ${path.relative(process.cwd(), dir)}`);
    else if (current !== built.releaseJson) errors.push(`${LIBRARY_RELEASE_FILE} is outdated – run npm run library -- build, then sign again`);
    else if (!files.has(LIBRARY_SIGNATURE_FILE)) warnings.push('not signed – an installation refuses it');
    else {
      const testKeyFile = path.join(path.dirname(dir), 'TEST-PUBLISHER-KEY.pub');
      const test = fs.existsSync(testKeyFile)
        ? fs
            .readFileSync(testKeyFile, 'utf8')
            .split(/\r?\n/)
            .filter((l) => l.trim() && !l.startsWith('#'))
        : [];
      const publisher = (JSON.parse(current) as { publisher: string }).publisher;
      const keys = [
        ...BUILT_IN_PUBLISHER_KEYS.map((b) => ({ line: b.key, publisher: b.publisher, test: false })),
        ...test.map((line) => ({ line, publisher, test: true })),
      ].map((k) => {
        const blob = parsePublicKeyLine(k.line).blob;
        return {
          id: k.test ? 'test' : 'builtin',
          publisherId: k.publisher,
          publisherName: k.publisher,
          libraries: [],
          blob,
          fingerprint: sshFingerprint(blob),
          state: 'active' as const,
          expiresAt: null,
          builtIn: !k.test,
        };
      });
      const v = await verifyRelease(files, { keys });
      if (!v.key.builtIn) warnings.push(`signed with the TEST key ${v.key.fingerprint} (TEST-PUBLISHER-KEY.pub) – no installation trusts it by default`);
    }
  } catch (e) {
    errors.push((e as Error).message);
  }
  return { file: rel, kind: 'library', ok: !errors.length, count, errors, warnings };
}

/** An example trigger: the format; the process template next to it (../processes) must exist and have the mapped inputs. */
function validateTriggerExample(file: string, rel: string, raw: unknown): FileResult {
  const r = webhookTriggerExampleSchema.safeParse(raw);
  if (!r.success)
    return { file: rel, kind: 'webhook trigger', ok: false, errors: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`), warnings: [] };
  const mapped = Object.keys(r.data.inputMapping);
  const template = path.join(path.dirname(file), '..', 'processes', `${r.data.process}.yaml`);
  if (!fs.existsSync(template))
    return {
      file: rel,
      kind: 'webhook trigger',
      ok: true,
      count: mapped.length,
      errors: [],
      warnings: [`process template ${r.data.process} not found next to it`],
    };
  const def = validateProcess(parseYaml(fs.readFileSync(template, 'utf8'), { maxBytes: MAX_DEFINITION_TEXT }));
  const inputs = new Set((def.definition?.inputs ?? []).map((i) => i.name));
  const errors = def.ok
    ? mapped.filter((k) => !inputs.has(k)).map((k) => `inputMapping.${k}: the process ${r.data.process} has no input ${k}`)
    : [`process ${r.data.process} is not valid`];
  const missing = (def.definition?.inputs ?? []).filter((i) => i.required && !mapped.includes(i.name) && i.default === undefined).map((i) => i.name);
  if (missing.length) errors.push(`inputMapping: required inputs without a mapping or default: ${missing.join(', ')}`);
  return { file: rel, kind: 'webhook trigger', ok: errors.length === 0, count: mapped.length, errors, warnings: [] };
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
      else if (r.kind === 'library release') out.push(`${c.dim('•')} ${r.file}: library release (checked with its manifest)`);
      else
        out.push(
          `${c.green('✔')} ${r.file}: ${r.kind}, ${r.count} ${r.kind === 'dashboard' ? 'widgets' : r.kind.startsWith('monitor') ? 'checks' : r.kind === 'template bundle' ? 'items' : r.kind === 'plant registry' ? 'records' : r.kind === 'webhook trigger' ? 'mapped inputs' : r.kind === 'data contract' ? 'schema objects' : r.kind === 'library' ? 'items' : r.kind === 'record type' ? 'fields' : r.kind === 'connector type' ? 'API specs' : 'nodes'}`,
        );
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
