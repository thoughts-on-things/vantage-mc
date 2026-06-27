# vantage-mc

The web frontend for [Vantage](../README.md) — render a Minecraft (Java) world as
a fast, beautiful, navigable 3D map in the browser. The native Zig generator bakes
versioned binary tiles (`.vtile` / `.vtexarr`); this package streams and shades
them with three.js.

It ships in three layers so you can enter at whatever altitude you need:

| Import | What it is | Depends on |
| --- | --- | --- |
| `vantage-mc/core` | Zero-dependency, isomorphic decoder for the binary tile format | — |
| `vantage-mc/three` (also the default `vantage-mc`) | three.js meshes/materials + a framework-agnostic viewer engine | `three` |
| `vantage-mc/react` | Drop-in React components | `three`, `react` |

## Install

```sh
npm install vantage-mc three          # core + engine
npm install react react-dom           # if you use vantage-mc/react
```

`three`, `react`, and `react-dom` are peer dependencies — you bring your own.

## Quick start (React)

The whole map in one component. Point it at the tiles the generator produced
(`just render <save>` writes them to `web/public/`).

```tsx
import { VantageViewer, BiomeLayer } from 'vantage-mc/react';

export function Map() {
  return (
    <div style={{ width: '100%', height: '100vh' }}>
      <VantageViewer tile="/terrain.vtile" textures="/terrain.vtexarr">
        <BiomeLayer legend hover />
      </VantageViewer>
    </div>
  );
}
```

`<VantageViewer>` fills its parent, loads and frames the tile, and provides the
engine state to children via context. `<BiomeLayer>` adds the interactive biome
legend (click to isolate, hover the map to identify, press `B` to toggle).

Reach the engine for custom UI with the `useVantage()` hook or a `ref`:

```tsx
import { useVantage } from 'vantage-mc/react';

function Stats() {
  const { info, biomes, hoveredBiome } = useVantage();
  return <span>{info?.triangleCount.toLocaleString()} tris · {biomes.length} biomes</span>;
}
```

## As a backend — your own three.js scene

Skip the engine and drop Vantage meshes into a scene you control (your own
camera, lighting, post-processing):

```ts
import { parseTile, parseTextureArray } from 'vantage-mc/core';
import { buildTerrain } from 'vantage-mc/three';

const tile = parseTile(await (await fetch('/terrain.vtile')).arrayBuffer());
const tex = parseTextureArray(await (await fetch('/terrain.vtexarr')).arrayBuffer());

const { terrain, water, bounds, shader } = buildTerrain(tile, tex);
scene.add(terrain);
if (water) scene.add(water);

// `shader` exposes the live uniforms: biome mix, fog, light direction.
shader!.uniforms.uBiomeMix.value = 1; // recolour by biome
```

Or the batteries-included engine without React:

```ts
import { VantageViewer } from 'vantage-mc/three';

const viewer = await VantageViewer.mount('#app', {
  tile: '/terrain.vtile',
  textures: '/terrain.vtexarr',
});
viewer.setBiomeLayer(true);
viewer.on('hover', (biomeId) => { /* ... */ });
```

## Just the format

`vantage-mc/core` has no dependencies and runs anywhere (browser, worker, Node) —
use it to inspect or transcode tiles without a renderer:

```ts
import { parseTile, summarizeBiomes } from 'vantage-mc/core';

const tile = parseTile(buffer);
console.log(tile.magic, tile.vertexCount, tile.indexCount / 3, 'tris');
for (const b of summarizeBiomes(tile)) console.log(b.label, `${Math.round(b.fraction * 100)}%`);
```

The decoder handles every tile version the generator emits (`VTL1`–`VTL5`) and
returns only the fields a given version carries (`textured`, `hasBiome`, `fluid`,
`surface`).

## API surface

**`vantage-mc/core`** — `parseTile`, `parseTextureArray`, `summarizeBiomes`,
`biomePalette`, `stripNamespace`, `ByteReader`; types `DecodedTile`, `MeshSection`,
`SurfaceMap`, `DecodedTextureArray`, `BiomeEntry`, `Rgb`.

**`vantage-mc/three`** — `buildTerrain`, `createTerrainMaterial`,
`createWaterMaterial`, `createSky`, `pickBiome`, `VantageViewer` (engine);
types `TerrainObjects`, `VantageViewerOptions`, `LoadOptions`, `TileInfo`,
`ViewMode`. Re-exports all of `core`.

**`vantage-mc/react`** — `<VantageViewer>`, `<BiomeLayer>`, `useVantage`,
`injectStyles`; types `VantageViewerProps`, `BiomeLayerProps`,
`VantageContextValue`.

## Develop

This directory is both the published package and its demo (the reference
consumer in [`demo/`](./demo/main.tsx)).

```sh
npm install
npm run dev        # Vite dev server at http://127.0.0.1:8753 (serves public/)
npm run typecheck  # tsc --noEmit
npm run build      # tsup → dist/ (ESM + .d.ts for each entry)
```

From the repo root the [`Justfile`](../Justfile) wraps the loop:
`just render "<save>"` bakes tiles into `public/`, then `just serve` runs the
dev server.

The generator and this package are decoupled by the **versioned binary tile
contract** ([`src/core/format.ts`](./src/core/format.ts)): the frontend only
needs the format, never the world — so a new Minecraft version "just works"
once the generator can read it.
