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

Early. **Phase 0 (parsing spike) is complete**: Vantage reads real Anvil region
files, decompresses chunks (zlib via C interop), parses NBT, and unpacks the
paletted block-state arrays — validated against a live Paper 1.21.4 world.

## Build & run

Requires [Zig](https://ziglang.org) `0.16.0`.

```sh
zig build                 # build the `vantage` binary into zig-out/bin
zig build test            # run unit tests
zig build run -- <region.mca> [localX localZ]
```

Example — dump the block histogram of a chunk:

```sh
./zig-out/bin/vantage path/to/world/region/r.0.0.mca 0 0
```

```
chunk (0,0): compression=zlib, compressed=5698 bytes
decompressed NBT: 42794 bytes (7.5x)
DataVersion: 4189
sections: 24 (11 with non-air blocks)
non-air blocks: 38040
top blocks:
      16663  minecraft:stone
      14948  minecraft:deepslate
        ...
```

## License

TBD.
