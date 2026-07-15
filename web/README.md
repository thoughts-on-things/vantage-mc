# @thoughts-on-things/vantage-mc

The web frontend for [Vantage](../README.md) — render a Minecraft (Java) world as
a fast, beautiful, navigable 3D map in the browser. The native Zig generator bakes
versioned binary tiles (`.vtile` / `.vtexarr`); this package streams and shades
them with three.js.

It ships in three layers so you can enter at whatever altitude you need:

| Import | What it is | Depends on |
| --- | --- | --- |
| `@thoughts-on-things/vantage-mc/core` | Zero-dependency, isomorphic decoder for the binary tile format | — |
| `@thoughts-on-things/vantage-mc/three` (also the default package export) | three.js meshes/materials + a framework-agnostic viewer engine | `three` |
| `@thoughts-on-things/vantage-mc/react` | Drop-in React components | `three`, `react` |

## Install

```sh
npm install @thoughts-on-things/vantage-mc three
npm install react react-dom # if you use the React entry point
```

`three`, `react`, and `react-dom` are peer dependencies — you bring your own.
The package is ESM-only: CJS consumers need `"type": "module"` or a dynamic
`import()`.

## Quick start (React)

The whole map in one component. Point it at the manifest the generator produced
(`just render <save>` writes `manifest.json` + `tiles/` + the texture array to
`web/public/`). Tiles stream in around the camera as the user pans — world size
doesn't matter.

```tsx
import { VantageViewer, BiomeLayer } from '@thoughts-on-things/vantage-mc/react';

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
presets plus view-distance, tile-count, memory-budget, render-scale, and haze sliders, all
applied live (`viewer.setStreaming` re-plans in place, no reload). Or set the
ring up-front with
`streaming={{ viewDistance: 1024, maxTiles: 128, maxBytes: 512 * 1024 * 1024 }}`.
`maxTiles` is a count guard; `maxBytes` is the stronger residency limit for
worlds whose tile complexity varies widely.

The camera also lives in the URL hash (`#@x,y,z,dist,rot,tilt`), so **every
view is a shareable deep link**: the hash follows the camera (debounced,
`history.replaceState` — no history spam), a link opens at its saved view, and
pasting a new hash into the address bar pans there live. Pass
`urlState={false}` if your page owns its hash (e.g. a router); the plain
engine keeps it opt-in (`new VantageViewer(el, { urlState: true })`).

The viewer **renders on demand**: a frame draws only when something changed —
camera motion, tiles streaming in, a setting — plus a gentle 10 fps tick while
animated textures (water, lava) are on screen, so an idle map costs ~0 GPU/CPU
instead of a render loop. Input still draws the same frame it arrives. Pass
`renderOnDemand: false` to the engine if you drive per-frame effects off its
scene, or call `viewer.invalidate()` after mutating it externally.
`viewer.screenshot()` returns the current view as a PNG data URL (`<MapNav>`
has a button for it, next to its fullscreen toggle).

Worlds baked with `vantage render --caves full` get the **cave view**: a
depth slice that cuts the world at any Y. Toggle it with `C` or `<MapNav>`'s
layers button, set the depth with the `<DepthSlider>` gauge, and share it —
the slice is part of the URL hash (`#@x,y,z,dist,rot,tilt,sliceY`). Engine
API: `viewer.setSlice(y | null)`, `viewer.toggleSlice()`, `viewer.slice`,
`viewer.sliceRange`, `viewer.hasCaves`, and a `'slice'` event.

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
import { useVantage } from '@thoughts-on-things/vantage-mc/react';

function Stats() {
  const { info, biomes, hoveredBiome } = useVantage();
  return <span>{info?.triangleCount.toLocaleString()} tris · {biomes.length} biomes</span>;
}
```

## As a backend — your own three.js scene

Skip the engine and drop Vantage meshes into a scene you control (your own
camera, lighting, post-processing):

```ts
import { maybeInflate, parseTile, parseTextureArray } from '@thoughts-on-things/vantage-mc/core';
import { buildTerrain } from '@thoughts-on-things/vantage-mc/three';

const tile = parseTile(await maybeInflate(await (await fetch('/tiles/t.0.0.vtile')).arrayBuffer()));
const tex = parseTextureArray(await maybeInflate(await (await fetch('/terrain.vtexarr')).arrayBuffer()));

const { terrain, water, bounds, shader } = buildTerrain(tile, tex);
scene.add(terrain);
if (water) scene.add(water);

// `shader` exposes the live uniforms: biome mix, fog, light direction.
shader!.uniforms.uBiomeMix.value = 1; // recolour by biome
```

Or stream a whole world into your scene with `TileManager` (shared materials,
camera-lookahead priority, bounded fetch/decode/upload backpressure,
byte-weighted residency, height/biome queries):

```ts
import { biomePalette, maybeInflate, parseManifest, parseTextureArray } from '@thoughts-on-things/vantage-mc/core';
import { createTerrainMaterial, createWaterMaterial, TileManager } from '@thoughts-on-things/vantage-mc/three';

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
  maxBytes: 512 * 1024 * 1024,
});
// each frame: keep the resident set centred on your camera
tiles.update(camera.position.x, camera.position.z);
```

Or the batteries-included engine without React:

```ts
import { VantageViewer } from '@thoughts-on-things/vantage-mc/three';

const viewer = await VantageViewer.mount('#app', { world: '/manifest.json' });
viewer.setBiomeLayer(true);
viewer.on('hover', (biomeId) => { /* ... */ });
viewer.on('stats', ({ loaded, triangleCount, residentBytes }) => { /* streaming HUD */ });
```

## Just the format

`@thoughts-on-things/vantage-mc/core` has no dependencies and runs anywhere (browser, worker, Node) —
use it to inspect or transcode tiles without a renderer:

```ts
import { parseTile, summarizeBiomes } from '@thoughts-on-things/vantage-mc/core';

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

**`@thoughts-on-things/vantage-mc/core`** — `parseTile`, `parseTextureArray`, `parseManifest`,
`parseLowresTile`, `maybeInflate`, `isGzip`, `tileKey`, `summarizeBiomes`,
`biomePalette`, `stripNamespace`, `ByteReader`; types `DecodedTile`,
`MeshSection`, `SurfaceMap`, `DecodedTextureArray`, `WorldManifest`,
`ManifestTile`, `LowresTile`, `BiomeEntry`, `Rgb`.

**`@thoughts-on-things/vantage-mc/three`** — `buildTerrain`, `buildTileMeshes`,
`buildQuantizedTileMeshes`, `buildLowresMesh`, `TileManager`,
`createTerrainMaterial`, `createWaterMaterial`, `createLowresMaterial`,
`createSky`, `pickBiome`, `MapControls`, `VantageViewer` (engine),
`VANILLA_DISPLAY`, `DEFAULT_ORBIT_ANGLE`; types `TerrainObjects`,
`TileMeshes`, `TileManagerOptions`, `TileStats`, `VantageViewerOptions`,
`LoadOptions`, `StreamingSettings`, `LightSettings`, `DisplaySettings`,
`TileInfo`, `ViewMode`. Re-exports all of `core`.

**`@thoughts-on-things/vantage-mc/react`** — `<VantageViewer>`, `<BiomeLayer>`, `<SettingsPanel>`,
`<LightPanel>`, `<MapNav>`, `<DepthSlider>`, `<Reticle>`, `<Panel>`, `useVantage`,
`injectStyles`, `QUALITY_PRESETS`; types `VantageViewerProps`,
`BiomeLayerProps`, `SettingsPanelProps`, `VantageContextValue`,
`VantageStatus`. Re-exports the engine and core types.

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
