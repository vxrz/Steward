import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { BRAND } from '../shared/src/brand';

const target = `http://127.0.0.1:${process.env.SM_PORT ?? 4310}`;

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
    transformIndexHtml: (html) => html.replaceAll('%BRAND_NAME%', BRAND.name).replaceAll('%BRAND_COLOR%', BRAND.color),
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

export default defineConfig({
  plugins: [react(), brand()],
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: { '/api': target, '/mock': target },
    fs: { allow: ['..'] },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000 },
});
