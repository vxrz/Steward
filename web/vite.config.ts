import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { BRAND } from '../shared/src/brand';
import { buildInfo, thirdPartyLicenses } from '../scripts/build-info.mjs';

const target = `http://127.0.0.1:${process.env.SM_PORT ?? 4310}`;
const root = fileURLToPath(new URL('..', import.meta.url));
const version: string = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const build = buildInfo(root);

/** Production dependencies with their licences (About → Third-party licences), as /third-party-licenses.json. */
function licenses(): Plugin {
  const json = () => JSON.stringify(thirdPartyLicenses(root));
  return {
    name: 'sm-licenses',
    configureServer(server) {
      server.middlewares.use('/third-party-licenses.json', (_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(json());
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'third-party-licenses.json', source: json() });
    },
  };
}

/** Web app manifest and page title from the central brand settings. */
function brand(): Plugin {
  const manifest = {
    name: BRAND.name,
    short_name: BRAND.shortName,
    description: BRAND.tagline,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: BRAND.color,
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Tasks', url: '/tasks' },
      { name: 'Dashboards', url: '/dashboards' },
      { name: 'Runs', url: '/runs' },
    ],
  };
  const json = JSON.stringify(manifest, null, 2);
  return {
    name: 'sm-brand',
    // <base href="/">: the server replaces it with its base path (SM_BASE_PATH), so the relative asset URLs
    // of the build (base: './') and the app's runtime base work under any path prefix with one build
    transformIndexHtml: (html) =>
      html
        .replaceAll('%BRAND_NAME%', BRAND.name)
        .replaceAll('%BRAND_COLOR%', BRAND.color)
        .replace(/<head>/i, '<head>\n    <base href="/" />'),
    configureServer(server) {
      server.middlewares.use('/manifest.webmanifest', (_req, res) => {
        res.setHeader('content-type', 'application/manifest+json');
        res.end(json);
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'manifest.webmanifest', source: json });
    },
  };
}

/** Writes .br and .gz next to larger build files; the server serves them pre-compressed. */
function precompress(): Plugin {
  return {
    name: 'sm-precompress',
    apply: 'build',
    writeBundle(opts, bundle) {
      for (const f of Object.keys(bundle).filter((n) => /\.(js|css|svg|webmanifest|json)$/.test(n))) {
        const file = path.join(opts.dir!, f);
        const buf = fs.readFileSync(file);
        if (buf.length < 1024) continue;
        fs.writeFileSync(file + '.br', zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }));
        fs.writeFileSync(file + '.gz', zlib.gzipSync(buf, { level: 9 }));
      }
    },
  };
}

export default defineConfig({
  // relative asset URLs: resolved against the <base href> the server writes (see brand())
  base: './',
  plugins: [react(), brand(), licenses(), precompress()],
  // Version and build of the web UI (About page, footer; compared with the server's version)
  define: {
    __SM_VERSION__: JSON.stringify(version),
    __SM_BUILD_COMMIT__: JSON.stringify(build.commit),
    __SM_BUILD_DATE__: JSON.stringify(build.date),
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: { '/api': target, '/mock': target },
    fs: { allow: ['..'] },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      // The shared sources have no import-time side effects (constants, types, zod schemas), so a page
      // that only needs e.g. ROLES from the @sm/shared barrel does not pull in zod and dagre (~30 kB gzip).
      treeshake: { moduleSideEffects: (id) => !/[\\/]shared[\\/]src[\\/]/.test(id) },
    },
  },
});
