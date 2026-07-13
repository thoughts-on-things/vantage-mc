import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The embeddable standalone viewer (`npm run build:viewer` → dist-viewer/):
// the same app as the demo, but WITHOUT copying public/ — that's the local
// dev world render, not part of the app. `zig build` embeds dist-viewer into
// the vantage binary so `vantage serve` ships a complete map viewer.
export default defineConfig({
  plugins: [react()],
  publicDir: false,
  build: { outDir: 'dist-viewer', emptyOutDir: true },
});
