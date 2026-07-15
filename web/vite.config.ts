import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server + demo build. The demo (demo/, index.html) imports the package
// straight from src/ so editing the library hot-reloads. Runtime-fetched tiles
// live in public/ and are served at the web root (e.g. /terrain.vtile).
export default defineConfig({
  plugins: [react()],
  // PORT lets a harness (or `PORT=… npm run dev`) pick a free port; 8753 stays
  // the human-friendly default (`just serve`).
  server: { port: Number(process.env['PORT']) || 8753, host: '127.0.0.1' },
  // Three.js is the app, not an accidentally eager dependency. Keep builds
  // quiet unless the single demo bundle grows materially beyond today's size.
  build: { outDir: 'dist-demo', chunkSizeWarningLimit: 800 },
});
