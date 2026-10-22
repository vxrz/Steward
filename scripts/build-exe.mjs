// Builds a single-file executable (Node.js "single executable application"):
// the server bundle, the built web UI, the example library and the report assets are embedded
// into a copy of the node binary. Run on each target OS (see release workflow).
//
//   npm run build && npm run build:exe   →   dist-exe/<name>[.exe]
//
// Progress goes to stderr, the result line to stdout. Exit status: 0 = built,
// 1 = build failed, 2 = usage error.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';

const HELP = `Build the single-file desktop executable for this OS and architecture.

Usage:
  npm run build:exe [-- options]
  node scripts/build-exe.mjs [options]

Run "npm run build" first (the built web UI is embedded). The result is
dist-exe/<name>[.exe]; Playwright (browser steps) is not embedded.

Options:
  -h, --help   Show this help

Exit status: 0 = built, 1 = build failed, 2 = usage error.
`;

try {
  const { values } = parseArgs({ options: { help: { type: 'boolean', short: 'h' } }, strict: true });
  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
} catch (e) {
  process.stderr.write(`error: ${e.message.replace(/\. To specify a positional argument.*$/s, '')}\nRun 'node scripts/build-exe.mjs --help' for usage.\n`);
  process.exit(2);
}

const step = (msg) => process.stderr.write(`• ${msg}\n`);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist-exe');
const work = path.join(out, 'work');
const brandSrc = fs.readFileSync(path.join(root, 'shared/src/brand.ts'), 'utf8');
const slug = /slug:\s*'([^']+)'/.exec(brandSrc)[1];
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const exe = path.join(out, `${slug}${isWin ? '.exe' : ''}`);

const webDist = path.join(root, 'web', 'dist');
if (!fs.existsSync(path.join(webDist, 'index.html'))) {
  console.error('web/dist is missing – run "npm run build" first.');
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

// 1. Bundle the server into one CommonJS file (SEA runs CommonJS).
step('Bundling the server');
await build({
  entryPoints: [path.join(root, 'server/src/desktop/launcher.ts')],
  outfile: path.join(work, 'app.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  // Browser automation needs a separate Playwright installation; not embedded.
  external: ['playwright', 'playwright-core', 'chromium-bidi', 'electron'],
  define: { 'import.meta.url': '__sm_import_meta_url', 'import.meta.dirname': '__dirname' },
  banner: { js: 'const __sm_import_meta_url = require("node:url").pathToFileURL(__filename).href;' },
  logLevel: 'warning',
});

// 2. Assets: web UI, example library, Swagger UI (API documentation page) and report assets, one asset per file plus a manifest.
const assets = {};
function addDir(dir, prefix) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const key = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) addDir(full, key);
    else assets[key] = full;
  }
}
addDir(webDist, 'web');
addDir(path.join(root, 'examples'), 'examples');
// @fastify/swagger-ui serves these files from disk, so they cannot be bundled by esbuild (see server/src/desktop/env.ts).
const swaggerUiStatic = path.join(path.dirname(createRequire(path.join(root, 'server', 'package.json')).resolve('@fastify/swagger-ui/package.json')), 'static');
for (const f of fs.readdirSync(swaggerUiStatic)) {
  if (!/\.(map|html)$/.test(f) && f !== 'swagger-ui.js') assets[`swagger-ui/${f}`] = path.join(swaggerUiStatic, f);
}
// PDF reports: fonts, default logo and the sRGB profile PDFKit embeds for PDF/A.
addDir(path.join(root, 'server', 'assets'), 'assets');
assets['assets/pdfkit/sRGB_IEC61966_2_1.icc'] = path.join(root, 'node_modules', 'pdfkit', 'js', 'data', 'sRGB_IEC61966_2_1.icc');
const manifestFile = path.join(work, 'manifest.json');
// SHA-256 of every file: the launcher re-checks the unpacked copy at each start (and unpacks it again when it was changed)
const sha256 = Object.fromEntries(Object.entries(assets).map(([k, f]) => [k, crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]));
fs.writeFileSync(manifestFile, JSON.stringify({ version, files: Object.keys(assets), sha256 }));
assets['manifest.json'] = manifestFile;

step(`Embedding ${Object.keys(assets).length} files`);
const seaConfig = path.join(work, 'sea-config.json');
// useCodeCache: V8 code cache of the bundle (~20% faster start: ~480 → ~380 ms to /api/health).
// Generated by this node binary, which is the one copied into the executable, so it always matches.
// (Node notes that import() is unavailable with it; the optional import('playwright') never resolves
// inside the executable anyway – browser steps report "not available" either way.)
// The bundle stays unminified so stack traces in the logs remain readable.
fs.writeFileSync(
  seaConfig,
  JSON.stringify(
    { main: path.join(work, 'app.cjs'), output: path.join(work, 'sea-prep.blob'), disableExperimentalSEAWarning: true, useCodeCache: true, useSnapshot: false, assets },
    null,
    2,
  ),
);
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: ['ignore', 2, 2] });

// 3. Copy the node binary and inject the blob.
step(`Injecting into a copy of ${path.basename(process.execPath)} ${process.version}`);
fs.copyFileSync(process.execPath, exe);
if (isMac) execFileSync('codesign', ['--remove-signature', exe], { stdio: ['ignore', 2, 2] });
const { inject } = createRequire(import.meta.url)(path.join(root, 'node_modules', 'postject'));
await inject(exe, 'NODE_SEA_BLOB', fs.readFileSync(path.join(work, 'sea-prep.blob')), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(isMac ? { machoSegmentName: 'NODE_SEA' } : {}),
});
if (isMac) execFileSync('codesign', ['--sign', '-', exe], { stdio: ['ignore', 2, 2] });
fs.rmSync(work, { recursive: true, force: true });

const mb = (fs.statSync(exe).size / 1024 / 1024).toFixed(0);
console.log(`Built ${path.relative(root, exe)} (${mb} MB, ${Object.keys(assets).length} embedded files)`);
