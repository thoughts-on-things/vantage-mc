# Vantage

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

Early, but it draws. **Phases 0 and 1 are complete.**

- **P0 — parsing spike:** reads real Anvil region files, decompresses chunks
  (zlib via C interop), parses NBT, and unpacks the paletted block-state arrays.
- **P1 — vertical slice:** the full tracer bullet, *world file → pixels in a
  browser.* The native generator assembles chunks into a dense block grid, emits
  a naive **culled, indexed** cube mesh (per-block flat colors as a stand-in for
  the P2 texture resolver), and writes a versioned binary tile (`VTL1`); a thin
  three.js viewer streams and renders it.

Validated against a live Paper 1.21.4 world:

![P1 render — a patch of real terrain](./docs/p1-render.png)

## Build & run

Requires [Zig](https://ziglang.org) `0.16.0`.

```sh
zig build                 # build the `vantage` binary into zig-out/bin
zig build test            # run unit tests
```

### Render terrain in the browser (P1)

```sh
# 1. Mesh a rectangle of chunks (region-local coords 0..31, inclusive) into a tile.
./zig-out/bin/vantage mesh path/to/world/region/r.0.0.mca web/terrain.vtile 0 0 10 15

# 2. Serve the viewer and open it.
( cd web && python3 -m http.server 8753 )
# → http://127.0.0.1:8753/index.html   (drag to orbit, scroll to zoom)
```

```
region:    .../r.0.0.mca
chunks:    176 loaded, 0 missing  (range 0,0..10,15)
grid:      176 x 384 x 256 blocks  (minY=-64)
mesh:      272312 vertices, 68078 quads, 136156 triangles
tile:      web/terrain.vtile  (7080128 bytes)
```

### Inspect a chunk's blocks

```sh
./zig-out/bin/vantage histo path/to/world/region/r.0.0.mca 0 0
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
