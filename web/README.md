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

The whole map in one component. Point it at the manifest the generator produced
(`just render <save>` writes `manifest.json` + `tiles/` + the texture array to
`web/public/`). Tiles stream in around the camera as the user pans — world size
doesn't matter.

```tsx
import { VantageViewer, BiomeLayer } from 'vantage-mc/react';

export function Map() {
  return (
    <div style={{ width: '100%', height: '100vh' }}>
      <VantageViewer world="/manifest.json">
        <BiomeLayer legend hover />
      </VantageViewer>
    </div>
  );
}
```

`<VantageViewer>` fills its parent, frames the world at its spawn point, and
provides the engine state to children via context. `<BiomeLayer>` adds the
interactive biome legend (click to isolate, hover the map to identify, press
`B` to toggle) — aggregated live across whatever tiles are resident. Add
`<SettingsPanel />` for a quality menu: low/med/high/ultra
presets plus view-distance, tile-budget, render-scale, and haze sliders, all
applied live (`viewer.setStreaming` re-plans in place, no reload). Or set the
ring up-front with `streaming={{ viewDistance: 1024, maxTiles: 128 }}`.

Format-2 manifests carry a **lowres LOD pyramid** (`.vlr` colored
heightfields): the viewer keeps coarse rings resident far beyond the hires
disc — level 1 also underlays it as a loading placeholder — so the whole world
stays visible at any zoom, right out to a satellite view.

A single standalone tile (from `vantage meshtex`) still works:

```tsx
<VantageViewer tile="/terrain.vtile" textures="/terrain.vtexarr" />
```

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
import { maybeInflate, parseTile, parseTextureArray } from 'vantage-mc/core';
import { buildTerrain } from 'vantage-mc/three';

const tile = parseTile(await maybeInflate(await (await fetch('/tiles/t.0.0.vtile')).arrayBuffer()));
const tex = parseTextureArray(await maybeInflate(await (await fetch('/terrain.vtexarr')).arrayBuffer()));

const { terrain, water, bounds, shader } = buildTerrain(tile, tex);
scene.add(terrain);
if (water) scene.add(water);

// `shader` exposes the live uniforms: biome mix, fog, light direction.
shader!.uniforms.uBiomeMix.value = 1; // recolour by biome
```

Or stream a whole world into your scene with `TileManager` (shared materials,
nearest-first fetch queue, distance-based unload, height/biome queries):

```ts
import { biomePalette, maybeInflate, parseManifest, parseTextureArray } from 'vantage-mc/core';
import { createTerrainMaterial, createWaterMaterial, TileManager } from 'vantage-mc/three';

const manifest = parseManifest(await (await fetch('/manifest.json')).json());
const tex = parseTextureArray(await maybeInflate(await (await fetch(manifest.textures)).arrayBuffer()));
const material = createTerrainMaterial(tex);
const tiles = new TileManager({
  manifest,
  baseUrl: location.origin + '/',
  scene,
  material,
  waterMaterial: createWaterMaterial(material),
  palette: biomePalette(manifest.biomes.length),
});
// each frame: keep the resident set centred on your camera
tiles.update(camera.position.x, camera.position.z);
```

Or the batteries-included engine without React:

```ts
import { VantageViewer } from 'vantage-mc/three';

const viewer = await VantageViewer.mount('#app', { world: '/manifest.json' });
viewer.setBiomeLayer(true);
viewer.on('hover', (biomeId) => { /* ... */ });
viewer.on('stats', ({ loaded, triangleCount }) => { /* streaming HUD */ });
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

The decoder handles every tile version the generator emits (`VTL1`–`VTL6`) and
returns only the fields a given version carries (`textured`, `hasBiome`, `fluid`,
`surface`). Tiles and the texture array ship gzip-wrapped on disk (~8× smaller);
`maybeInflate` sniffs the magic and inflates via the platform's native
`DecompressionStream` — a no-op when the server already handled it.

## API surface

**`vantage-mc/core`** — `parseTile`, `parseTextureArray`, `parseManifest`,
`maybeInflate`, `isGzip`, `tileKey`, `summarizeBiomes`, `biomePalette`,
`stripNamespace`, `ByteReader`; types `DecodedTile`, `MeshSection`,
`SurfaceMap`, `DecodedTextureArray`, `WorldManifest`, `ManifestTile`,
`BiomeEntry`, `Rgb`.

**`vantage-mc/three`** — `buildTerrain`, `buildTileMeshes`, `TileManager`,
`createTerrainMaterial`, `createWaterMaterial`, `createSky`, `pickBiome`,
`VantageViewer` (engine); types `TerrainObjects`, `TileMeshes`,
`TileManagerOptions`, `TileStats`, `VantageViewerOptions`, `LoadOptions`,
`StreamingSettings`, `TileInfo`, `ViewMode`. Re-exports all of `core`.

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
