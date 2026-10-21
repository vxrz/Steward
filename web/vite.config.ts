import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = `http://127.0.0.1:${process.env.SM_PORT ?? 4310}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: { '/api': target, '/mock': target },
    fs: { allow: ['..'] },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000 },
});
