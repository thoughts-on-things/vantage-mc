import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The vantage.beacon-mc.io site. `vantage-mc` is linked from ../web (file:), so
// dedupe three/react — the linked package must share this app's instances.
// Relative base: the build works on any origin/subpath (github.io preview and
// the custom domain alike). The demo world's tiles are NOT part of the build:
// dev serves them from public/demo (see `just site-demo`), CI renders them
// straight into dist/demo after `vite build`.
export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: { dedupe: ['three', 'react', 'react-dom'] },
  server: { port: Number(process.env['PORT']) || 8754, host: '127.0.0.1' },
  // The lazy viewer chunk intentionally contains Three.js.
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: { input: ['index.html', 'server/index.html'] },
  },
});
