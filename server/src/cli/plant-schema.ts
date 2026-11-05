/**
 * Writes the JSON Schema (2020-12) of the plant registry's import and export format to
 * docs/plant/plant-registry-1.schema.json, or checks that the committed file is up to date.
 *
 *   npm run plant:schema               write the file
 *   npm run plant:schema -- --check    exit 1 when it is outdated
 */
import fs from 'node:fs';
import path from 'node:path';
import { plantJsonSchema } from '../plant/format.js';

const out = path.resolve(import.meta.dirname, '../../../docs/plant/plant-registry-1.schema.json');
const text = JSON.stringify(plantJsonSchema(), null, 2) + '\n';
if (process.argv.includes('--check')) {
  const now = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  if (now !== text) {
    process.stderr.write(`${path.relative(process.cwd(), out)} is outdated – run npm run plant:schema\n`);
    process.exit(1);
  }
  process.stdout.write('plant registry schema up to date\n');
} else {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text);
  process.stdout.write(`wrote ${path.relative(process.cwd(), out)}\n`);
}
