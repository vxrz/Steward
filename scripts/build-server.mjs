// Compiles the server (TypeScript) into plain JavaScript modules in server/dist/, so production runs
// `node server/dist/index.js` without a TypeScript loader (tsx is a development tool).
//
//   npm run build:server     (part of "npm run build")
//
// One ES module per entry point, side by side in server/dist/ (two levels below the root like server/src/*.ts,
// see server/src/root-dir.ts):
//   index.js            the server
//   pdf-worker.js       the PDF worker thread (server/src/reports/pdf/pool.ts starts it next to the bundle)
//   healthcheck.js      the container HEALTHCHECK
//   admin.js, migrate.js, backup.js, db-copy.js, evidence-verify.js, audit-verify-export.js, mcp.js – the CLIs
// Our code and @sm/shared are bundled; packages from node_modules stay imports (the image installs the production
// dependencies), so their own files – Swagger UI assets, PDFKit data, the PostgreSQL driver the PG bridge worker
// loads, Playwright – are found where they are installed. The desktop executable has its own bundle (build-exe.mjs).
//
// Progress goes to stderr, the result line to stdout. Exit status: 0 = built, 1 = build failed, 2 = usage error.
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';

const HELP = `Compile the server into server/dist/ (plain JavaScript, no tsx needed at runtime).

Usage:
  npm run build:server
  node scripts/build-server.mjs [options]

Options:
  -h, --help      Show this help

Exit status: 0 = built, 1 = build failed, 2 = usage error.
`;

try {
  const { values } = parseArgs({ options: { help: { type: 'boolean', short: 'h' } }, strict: true });
  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
} catch (e) {
  process.stderr.write(`error: ${e.message.replace(/\. To specify a positional argument.*$/s, '')}\nRun 'node scripts/build-server.mjs --help' for usage.\n`);
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'server', 'src');
const out = path.join(root, 'server', 'dist');

/**
 * Packages stay imports from node_modules, except the workspace package @sm/shared (TypeScript sources) and packages
 * that only it depends on (installed in shared/node_modules, which server/dist cannot see) – those are bundled.
 */
const serverPackageDirs = [path.join(root, 'server', 'node_modules'), path.join(root, 'node_modules')];
const packageName = (p) => (p.startsWith('@') ? p.split('/').slice(0, 2).join('/') : p.split('/')[0]);
const externalPackages = {
  name: 'external-packages',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (path.isAbsolute(args.path)) return undefined;
      if (args.path.startsWith('node:') || builtinModules.includes(args.path)) return { path: args.path, external: true };
      const name = packageName(args.path);
      if (name === '@sm/shared') return undefined;
      if (serverPackageDirs.some((d) => fs.existsSync(path.join(d, name, 'package.json')))) return { path: args.path, external: true };
      return undefined; // e.g. @dagrejs/dagre of @sm/shared: bundled
    });
  },
};

/**
 * Entry points. A CLI module runs itself when it is the started file (`argv[1] === import.meta.filename`); in a bundle
 * every module shares the bundle's file name, so that guard is switched off (define below) and a small stub calls
 * the CLI instead – a module the bundle merely contains (cli/db-copy.ts in the server, cli/admin.ts in migrate.js)
 * never starts.
 */
const cli = (file, fn, command) => ({
  contents: `import { ${fn} } from './${file}';\nPromise.resolve(${fn}(process.argv.slice(2)${command ? `, ${JSON.stringify(command)}` : ''})).then((code) => { process.exitCode = code; });\n`,
});
const entries = {
  index: { file: 'index.ts' },
  'pdf-worker': { file: 'reports/pdf/worker-entry.ts' },
  healthcheck: { file: 'cli/healthcheck.ts' },
  mcp: { file: 'cli/mcp.ts' },
  admin: cli('admin.ts', 'runAdmin', 'node server/dist/admin.js'),
  migrate: cli('migrate.ts', 'runMigrate', 'node server/dist/migrate.js'),
  backup: cli('backup.ts', 'runBackupCli', 'node server/dist/backup.js'),
  'evidence-verify': cli('evidence-verify.ts', 'runEvidenceVerify', 'node server/dist/evidence-verify.js'),
  'audit-verify-export': cli('audit-verify-export.ts', 'main'),
  'audit-verify-archive': cli('audit-archive-verify.ts', 'runAuditArchiveVerify', 'node server/dist/audit-verify-archive.js'),
  'db-copy': cli('db-copy.ts', 'main'),
};

const step = (msg) => process.stderr.write(`• ${msg}\n`);
const t0 = Date.now();
fs.rmSync(out, { recursive: true, force: true });
step(`Compiling the server into ${path.relative(root, out)}/`);
try {
  await Promise.all(
    Object.entries(entries).map(([name, e]) =>
      build({
        ...(e.file
          ? { entryPoints: [path.join(src, e.file)] }
          : { stdin: { contents: e.contents, resolveDir: path.join(src, 'cli'), sourcefile: `${name}-entry.ts`, loader: 'ts' } }),
        outfile: path.join(out, `${name}.js`),
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node24',
        minify: false,
        // stack traces in the logs point at server/src (node --enable-source-maps in the image)
        sourcemap: 'linked',
        sourcesContent: false,
        legalComments: 'none',
        plugins: [externalPackages],
        define: { 'import.meta.filename': '"<bundle>"' },
        logLevel: 'warning',
      }),
    ),
  );
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
}
const kb = fs
  .readdirSync(out)
  .filter((f) => f.endsWith('.js'))
  .reduce((n, f) => n + fs.statSync(path.join(out, f)).size, 0);
console.log(`Built server/dist (${Object.keys(entries).length} entry points, ${(kb / 1024 / 1024).toFixed(1)} MB, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
