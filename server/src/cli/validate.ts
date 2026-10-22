/**
 * Validate process and dashboard definitions (YAML/JSON) – for CI and for
 * reviewing changes to the example library.
 *   npm run validate                 (checks examples/)
 *   npm run validate -- path/to/file.yaml other/dir
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { BUNDLE_FORMATS, dashboardDefinitionSchema, validateProcess } from '@sm/shared';

const args = process.argv.slice(2);
const targets = args.length ? args : [path.resolve(import.meta.dirname, '../../../examples')];

function files(p: string): string[] {
  const st = fs.statSync(p);
  if (st.isDirectory()) return fs.readdirSync(p).flatMap((f) => files(path.join(p, f)));
  return /\.(ya?ml|json)$/i.test(p) ? [p] : [];
}

let errors = 0;
let warnings = 0;
for (const file of targets.flatMap(files).sort()) {
  const rel = path.relative(process.cwd(), file);
  let raw: unknown;
  try {
    const text = fs.readFileSync(file, 'utf8');
    raw = file.endsWith('.json') ? JSON.parse(text) : YAML.parse(text);
  } catch (e) {
    console.log(`✘ ${rel}: cannot parse – ${(e as Error).message}`);
    errors++;
    continue;
  }
  const obj = raw as Record<string, unknown>;
  if (obj && typeof obj === 'object' && (BUNDLE_FORMATS as readonly unknown[]).includes(obj.format)) {
    console.log(`• ${rel}: bundle (skipped)`);
    continue;
  }
  if (obj && Array.isArray(obj.widgets)) {
    const r = dashboardDefinitionSchema.safeParse(raw);
    if (r.success) console.log(`✔ ${rel}: dashboard, ${r.data.widgets.length} widgets`);
    else {
      errors++;
      console.log(`✘ ${rel}: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    continue;
  }
  const r = validateProcess(raw);
  if (r.ok) console.log(`✔ ${rel}: process, ${r.definition!.nodes.length} nodes`);
  else {
    errors++;
    console.log(`✘ ${rel}: ${r.issues.map((i) => `${i.nodeId ? `[${i.nodeId}] ` : ''}${i.path} ${i.message}`).join('; ')}`);
  }
  for (const w of r.warnings) {
    warnings++;
    console.log(`  ⚠ ${w.nodeId ? `[${w.nodeId}] ` : ''}${w.message}`);
  }
}
console.log(`\n${errors} error(s), ${warnings} warning(s)`);
process.exit(errors ? 1 : 0);
