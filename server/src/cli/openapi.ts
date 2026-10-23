/**
 * Writes the OpenAPI 3.1 description of the public API (/api/v1) to
 * docs/openapi.json, or checks that the committed file is up to date (CI).
 *
 *   npm run openapi                   write docs/openapi.json
 *   npm run openapi -- --check        exit 1 when docs/openapi.json is outdated
 *   npm run openapi -- --stdout       print the document instead
 */
import fs from 'node:fs';
import path from 'node:path';

const HELP = `Usage: npm run openapi -- [options]

Generates the OpenAPI 3.1 document of the public API (/api/v1) from the route schemas.

Options:
  --check         Compare with the output file instead of writing it; exit 1 when it is outdated
  --out <file>    Output file (default: docs/openapi.json)
  --stdout        Print the document to stdout instead of writing a file
  -h, --help      Show this help

Exit codes: 0 success (or up to date), 1 outdated (--check), 2 usage error or failure.
`;

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
if (has('-h') || has('--help')) {
  process.stdout.write(HELP);
  process.exit(0);
}
const known = new Set(['--check', '--stdout', '--out']);
let out = path.resolve(import.meta.dirname, '../../../docs/openapi.json');
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === '--out') {
    const v = argv[++i];
    if (!v) {
      process.stderr.write('openapi: --out needs a file name\n\n' + HELP);
      process.exit(2);
    }
    out = path.resolve(v);
  } else if (!known.has(a)) {
    process.stderr.write(`openapi: unknown option "${a}"\n\n${HELP}`);
    process.exit(2);
  }
}

// The operational log writes to stdout; keep it quiet so --stdout output stays a clean document.
process.env.SM_LOG_LEVEL ??= 'silent';
await import('../bootstrap.js');

try {
  const { buildOpenApiDocument } = await import('../api/index.js');
  const text = JSON.stringify(await buildOpenApiDocument(), null, 2) + '\n';
  const rel = path.relative(process.cwd(), out) || out;
  if (has('--stdout')) {
    process.stdout.write(text);
  } else if (has('--check')) {
    const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
    if (current === text) {
      process.stderr.write(`✔ ${rel} is up to date\n`);
    } else {
      process.stderr.write(`✘ ${rel} is ${current === null ? 'missing' : 'outdated'} – run "npm run openapi" and commit the result\n`);
      process.exit(1);
    }
  } else {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, text);
    process.stderr.write(`✔ wrote ${rel}\n`);
  }
} catch (e) {
  process.stderr.write(`openapi: ${(e as Error).stack ?? e}\n`);
  process.exit(2);
}
