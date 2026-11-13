/**
 * Writes the JSON Schema (2020-12) of the data products file format to docs/data-products/data-products-1.schema.json,
 * or checks that the committed file is up to date (the tests check it too: dataproducts-transfer.test.ts).
 *
 *   npm run data-products:schema                write the file
 *   npm run data-products:schema -- --check     exit 1 when it is outdated
 */
import fs from 'node:fs';
import path from 'node:path';
import { dataProductsJsonSchema } from '../dataproducts/format.js';

const out = path.resolve(import.meta.dirname, '../../../docs/data-products/data-products-1.schema.json');
const text = JSON.stringify(dataProductsJsonSchema(), null, 2) + '\n';
if (process.argv.includes('--check')) {
  const now = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  if (now !== text) {
    process.stderr.write(`${path.relative(process.cwd(), out)} is outdated – run npx tsx server/src/cli/data-products-schema.ts\n`);
    process.exit(1);
  }
  process.stdout.write('data products schema up to date\n');
} else {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text);
  process.stdout.write(`wrote ${path.relative(process.cwd(), out)}\n`);
}
