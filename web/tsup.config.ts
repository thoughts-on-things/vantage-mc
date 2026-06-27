import { defineConfig } from 'tsup';

// Three entry points, each its own importable subpath:
//   vantage-mc/core   — zero-dep, isomorphic binary-format decoder
//   vantage-mc/three  — three.js renderer + framework-agnostic viewer engine
//   vantage-mc/react  — React drop-in components
// three / react stay external (peer dependencies of the consumer).
export default defineConfig({
  entry: {
    'core/index': 'src/core/index.ts',
    'three/index': 'src/three/index.ts',
    'react/index': 'src/react/index.ts',
  },
  format: ['esm'],
  target: 'es2022',
  dts: true,
  clean: true,
  treeshake: true,
  external: [/^three($|\/)/, /^react($|\/)/, /^react-dom($|\/)/],
});
