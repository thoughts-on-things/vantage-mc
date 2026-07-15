import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'vantage-mc/react': fileURLToPath(new URL('../web/src/react/index.ts', import.meta.url)),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: '127.0.0.1',
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  // Three.js intentionally lives in the lazy ViewerScreen chunk. Its size is
  // expected and does not affect library startup, so keep routine builds quiet.
  build: { target: 'es2021', minify: 'esbuild', sourcemap: true, chunkSizeWarningLimit: 600 },
});
