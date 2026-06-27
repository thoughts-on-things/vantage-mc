# Vantage

[![CI](https://github.com/thoughts-on-things/vantage-mc/actions/workflows/ci.yml/badge.svg)](https://github.com/thoughts-on-things/vantage-mc/actions/workflows/ci.yml)

A high-performance Minecraft (Java Edition) world → 3D web map renderer, written in Zig.

Vantage turns a Minecraft world into a fast, beautiful, navigable 3D map in the
browser. It is a from-scratch reimagining of [BlueMap](https://github.com/BlueMap-Minecraft/BlueMap)
with four ordered goals:

1. **Performance** — generate maps of large worlds as fast as possible, using as
   little CPU, RAM, and disk as possible.
2. **Correctness** — render the world as faithfully as the live in-game view.
3. **Usability** — never break across Minecraft updates; trivial to deploy and scale.
4. **Fidelity** — modern, configurable, high-quality rendering. The next leap.

The design: a **native Zig generator** (multithreaded, arena-per-region, SIMD hot
paths) bakes quantized, indexed geometry tiles; a **thin web renderer**
(three.js, WebGL2 + WebGPU) streams and shades them; an optional **live daemon +
companion plugin** push real-time player and block-edit updates onto the 3D map.

See **[DESIGN.md](./DESIGN.md)** for the full architecture, decisions, and roadmap.

## Status

Early, but it draws — with real textures **and biome-aware colour, plus an
interactive biome layer.** **Phases 0–2 (core) and the biome layer are complete.**

- **P0 — parsing spike:** reads real Anvil region files, decompresses chunks
  (zlib via C interop), parses NBT, and unpacks the paletted block-state arrays.
- **P1 — vertical slice:** the full tracer bullet, *world file → pixels in a
  browser.* Dense block grid → **culled, indexed** cube mesh → versioned binary
  tile (`VTL1`) → three.js viewer.
- **P2 — model & texture resolver:** the vanilla resource pipeline —
  blockstate → variant → model parent-chain → resolved elements/faces with
  textures, UVs, cullface, rotation, tint. Decodes vanilla PNGs (vendored
  stb_image) into a **texture array**, and a textured mesher emits geometry with
  per-face texture layers sampled by a WebGL2 `sampler2DArray` shader. Remaining
  P2 hardening (state-accurate variants, multipart, KTX2, asset auto-download)
  is in progress.
- **P2.5 — biomes & the first interactive layer:** parses Anvil biome data,
  tints grass/foliage/water by **real biome colour** (plains-green vs
  savanna-gold, via the vanilla temperature/downfall colormap), and ships a
  toggleable **biome layer** in the viewer (`B` key) — terrain recoloured by
  biome with relief preserved, plus a clickable legend that isolates a biome.
  Biome borders read at a glance. The tile gains a per-vertex biome id (`VTL3`).

Textured render of the beacon 1.21.4 world (stone→deepslate strata, grass, acacia trees):

![P2 render — textured terrain](./docs/p2-render.png)

<details><summary>P1 flat-color render (for comparison)</summary>

![P1 render — flat-color terrain](./docs/p1-render.png)
</details>

## Build & run

Requires [Zig](https://ziglang.org) `0.16.0`. A [`Justfile`](./Justfile) wraps the
common tasks ([`just`](https://just.systems): `brew install just`):

```sh
just            # list every recipe
just build      # build the binary into zig-out/bin
just test       # run unit tests
just fmt        # format sources   ·   just ci = fmt-check + test + build
```

### Render terrain in the browser

Textured (P2) — needs extracted assets + biome data (Minecraft 26.2+; see
`just extract <client.jar>` and the note below):

```sh
just demo                     # mesh the demo area into web/ and serve the viewer
# → http://127.0.0.1:8753/index.html
#   drag to orbit · scroll to zoom · press B for the biome layer · hover to identify

# Or step by step, with an explicit region / area:
just region=path/to/r.0.0.mca range='0 0 10 15' mesh
just serve
```

The raw binary works too, without `just`:

```sh
zig build
./zig-out/bin/vantage meshtex path/to/region/r.0.0.mca web/terrain.vtile \
    ~/.cache/vantage/assets/26.2/assets/minecraft 0 0 10 15
( cd web && python3 -m http.server 8753 )
```

Flat-color (P1, no assets needed): use `mesh` instead of `meshtex` and drop the
assets argument. The viewer auto-detects the tile version.

> Everything version-specific is read from the jar — models, textures, the biome
> colormaps, **and the biome definitions (`data/minecraft/worldgen/biome`) and
> names (`lang/en_us.json`)** — so pointing at a new version's jar "just works"
> with no code changes. Extraction is currently manual (auto-download is a pending
> P2 slice); `just extract <client.jar>` pulls exactly what's needed, or by hand:
>
> ```sh
> unzip -oq <client>.jar \
>   'assets/minecraft/blockstates/*' 'assets/minecraft/models/block/*' \
>   'assets/minecraft/textures/block/*' 'assets/minecraft/textures/colormap/*' \
>   'assets/minecraft/lang/en_us.json' 'data/minecraft/worldgen/biome/*' \
>   -d ~/.cache/vantage/assets/26.2
> ```
>
> The generator derives the `data/minecraft` path from the `assets/minecraft` path
> you pass. If the biome data isn't present it still renders, using temperate
> defaults, and says so.

```
region:    .../r.0.0.mca
chunks:    176 loaded, 0 missing  (range 0,0..10,15)
blocks:    39 distinct, 4 biomes
grid:      176 x 384 x 256 blocks  (minY=-64)
textures:  41 layers (16x16)
mesh:      291312 vertices, 145656 triangles
tile:      web/terrain.vtile  (12235211 bytes)
texarray:  web/terrain.vtexarr  (42004 bytes)
biome tints (grass / foliage / water):
  savanna                      #bfb755 / #aea42a / #3f76e4
  plains                       #91bd59 / #77ab2f / #3f76e4
```

### Inspect a chunk's blocks (or biomes)

```sh
./zig-out/bin/vantage histo  path/to/world/region/r.0.0.mca 0 0          # block histogram
./zig-out/bin/vantage biomes path/to/world/region/r.0.0.mca 0 0 31 31    # biome histogram
```

```
chunk (0,0): DataVersion=4189, 24 sections
non-air blocks: 38040
distinct types: 26
top blocks:
      16663  minecraft:stone
      14948  minecraft:deepslate
        ...
```

## License

TBD.
