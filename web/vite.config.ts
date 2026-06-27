import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server + demo build. The demo (demo/, index.html) imports the package
// straight from src/ so editing the library hot-reloads. Runtime-fetched tiles
// live in public/ and are served at the web root (e.g. /terrain.vtile).
export default defineConfig({
  plugins: [react()],
  server: { port: 8753, host: '127.0.0.1' },
  build: { outDir: 'dist-demo' },
});
