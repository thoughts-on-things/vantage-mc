# Vantage

[![CI](https://github.com/thoughts-on-things/vantage-mc/actions/workflows/ci.yml/badge.svg)](https://github.com/thoughts-on-things/vantage-mc/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A high-performance Minecraft (Java Edition) world → 3D web map renderer, written in Zig.

**[Explore Vantage](https://vantage.beacon-mc.io)** — launch the live viewer,
see cave slicing in action, compare real performance numbers, and download the
desktop app.

[Live site](https://vantage.beacon-mc.io) ·
[Download Vantage Desktop](https://vantage.beacon-mc.io/#desktop) ·
[Download the CLI](https://github.com/thoughts-on-things/vantage-mc/releases/latest) ·
[Embed the viewer](https://www.npmjs.com/package/@thoughts-on-things/vantage-mc)

Vantage turns a Minecraft world into a fast, beautiful, navigable 3D map in the
browser, built around four ordered goals:

1. **Performance** — generate maps of large worlds as fast as possible, using as
   little CPU, RAM, and disk as possible.
2. **Correctness** — render the world as faithfully as the live in-game view.
3. **Usability** — never break across Minecraft updates; trivial to deploy and scale.
4. **Fidelity** — modern, configurable, high-quality rendering.

## Choose how you use Vantage

### Vantage Desktop for Windows

The easiest way to map worlds on your own PC. Vantage Desktop finds Java
Edition saves from Minecraft, Prism, MultiMC, CurseForge, Modrinth, GDLauncher,
and Beacon, renders them locally, and opens them directly in the GPU viewer.
It includes cave-ready renders, native performance profiles, quality settings,
real map thumbnails, and a searchable world library—without a command line.

Save files are always read-only, generated maps stay in Vantage's local cache,
and nothing is uploaded. Download the signed installer from the
**[Vantage site](https://vantage.beacon-mc.io/#desktop)** or the
**[latest GitHub release](https://github.com/thoughts-on-things/vantage-mc/releases/latest)**.

### Vantage CLI for Windows, macOS, and Linux

Use the native CLI for automation, servers, static map generation, or the
fastest path from a save directory to deployable files. Release archives are
available for x86-64 and ARM64 where supported; the binary includes its own web
server and viewer, with no JVM or Node runtime required.

Go to the **[CLI quick start](#cli-quick-start)** or download a
**[prebuilt release](https://github.com/thoughts-on-things/vantage-mc/releases/latest)**.

### Viewer package for web apps

Already have Vantage render output? `@thoughts-on-things/vantage-mc` provides a
zero-dependency decoder, a Three.js engine, and drop-in React components for
streaming the map in your own application.

```sh
npm install @thoughts-on-things/vantage-mc three
```

See the **[viewer package guide](./web/README.md)** for framework and engine APIs.

### Multiplayer servers and launchers

`vantage server` runs beside a Minecraft Java server and turns its persisted
world into a continuously updating, on-demand tile stream. It is designed to
sit behind an authenticating host: the launcher backend or reverse proxy keeps
ownership of player identity and access, while Vantage remains a read-only,
bounded rendering data plane. Launchers can also connect directly through the
versioned bearer-authenticated protocol.

See the **[multiplayer architecture and host integration guide](./docs/server.md)**.

![Vantage — textured 3D terrain streaming in the browser](./docs/render-hero.jpg)

## How it works

A **native Zig generator** (no JVM, no GC, vendored C decompressors) reads a
world's region files directly and bakes quantized, indexed geometry tiles plus a
lowres LOD pyramid; a **thin web renderer** ([`@thoughts-on-things/vantage-mc`](./web/README.md) —
three.js, WebGL2) streams and shades them. The two sides are decoupled by a
versioned binary tile contract, so each can evolve independently.

- **Whole-world tiled streaming** — every populated chunk is baked into
  gzip-wrapped tiles + a manifest; the viewer streams them around the camera
  (nearest-first, distance-based unload), so world size doesn't matter.
- **GPU dequantization** — tiles upload in their on-disk quantized encoding and
  the vertex shader dequantizes, so arriving tiles cost the main thread nearly
  nothing and panning stays stutter-free.
- **Byte-bounded end to end** — native bakes, network/decode/upload staging,
  and viewer residency all have explicit capacities; see the
  [streaming design](./docs/streaming.md) and
  [performance roadmap](./docs/performance-roadmap.md).
- **LOD pyramid** — a quadtree of colored heightfields (~1% of the hires bytes)
  keeps the *entire* world visible: zoom out to a whole-world satellite view,
  never a fog wall.
- **Real assets, no hardcoding** — models, textures, biome colors, and display
  names are all read from the game's own files, so a new Minecraft version
  "just works".
- **Interactive layers** — biome layer with a clickable legend, lighting panel,
  quality presets, free-flight camera.
- **Shareable views** — the camera lives in the URL hash, so any view of the
  map is a deep link you can paste to someone.

| Whole-world satellite view (LOD pyramid) | Biome layer |
| --- | --- |
| ![Zoomed out to a whole-world satellite view](./docs/render-world.jpg) | ![The biome layer with its legend](./docs/render-biomes.jpg) |

Measured on a dense 7,225-chunk 1.21 world (Windows, 16 threads, ReleaseFast):
**~3.4 s** end-to-end for 81 tiles + a 3-level LOD pyramid, **~25 MB on disk**
(the compact quad encoding ships no index data, delta-codes positions, and
stores fixed-point UVs — 5× smaller than the previous format), streaming at
120+ FPS. Baked light and AO live in per-tile lightmap atlases, so greedy
meshing merges across lighting gradients: ~23% fewer vertices (~12.8M
triangles resident for the whole world) with per-block light fidelity intact.
Tiles render in parallel within the configured memory budget; `--gz` trades
size against write time (1..12, default 7, the measured latency/size knee).

## CLI quick start

Download the archive for your platform from the
**[latest release](https://github.com/thoughts-on-things/vantage-mc/releases/latest)**:

| Platform | Release asset |
| --- | --- |
| Windows x86-64 | `vantage-x86_64-windows.zip` |
| macOS Apple Silicon | `vantage-aarch64-macos.tar.gz` |
| macOS Intel | `vantage-x86_64-macos.tar.gz` |
| Linux ARM64 | `vantage-aarch64-linux.tar.gz` |
| Linux x86-64 | `vantage-x86_64-linux.tar.gz` |

Extract `vantage` (`vantage.exe` on Windows), put it somewhere on your `PATH`,
and confirm it is ready:

```sh
vantage --version
```

Building from source requires Zig and Node, but using a release binary does
not. Source setup, Just recipes, tests, and packaging live in
**[CONTRIBUTING.md](./CONTRIBUTING.md)**.

### 1. Extract assets

Vantage reads models, textures, and biome data straight from a Minecraft client
jar (Mojang's assets aren't redistributable, so you extract them once from your
own copy — anything from 1.18 up through the current year-versioned releases
works). If Minecraft is installed locally this happens **automatically on the
first render**; otherwise (or to re-extract) point the built-in extractor at
any client jar:

```sh
vantage extract                                      # newest jar in .minecraft/versions
vantage extract ~/.minecraft/versions/26.2/26.2.jar  # …or an explicit one
```

The subset a render needs lands in `~/.cache/vantage/assets/<version>` (a few
MB — blockstates, block models and textures, colormaps, biome data).

### 2. Render your world

Point it at a save folder (the one with `level.dat`). It finds the region files
and the extracted assets, renders **the whole populated world** as streamable
tiles, and shows a progress bar:

```sh
vantage render "~/.minecraft/saves/My World" --out my-map
vantage serve my-map --open      # → http://127.0.0.1:8268/
#   drag to pan · right-drag to orbit · scroll to zoom · B = biome layer
```

`vantage serve` is a tiny local web server with the whole viewer embedded in
the binary — no Node needed to view a map. Pass
`--host 0.0.0.0` to share the map with your local network.

The renderer only ever reads the world — it never writes to it. Useful flags:

- `--out <dir>` — output directory (default `web/public`).
- `--assets <dir>` — the extracted `assets/minecraft` directory (default:
  newest version under `~/.cache/vantage/assets`).
- `--radius <chunks>` — render only a window around spawn (quick previews).
- `--caves full|<y>` — cave-culling horizon (default 55): faces that only look
  into dark, sky-light-0 cells below this Y are skipped. Ocean and lake floors
  are always kept. `full` keeps every cave and enables the viewer's **cave
  view** — press `C` and slice the world at any Y. Costs disk (New World:
  25 → 47 MB gzipped), not bake time.
- `--tile-chunks <n>` — tile span in chunks (default 8 = 128×128 blocks).
- `--threads <n>` — upper bound on tile-render parallelism. By default Vantage
  uses the smaller of the logical-core count and its memory admission limit.
- `--memory <MiB>` — memory capacity available to concurrent tile bakes. The
  default is 1/8 of physical RAM, clamped to 512–1024 MiB; set this explicitly
  for containers or shared hosts. Vantage estimates each tile's working set
  from `--tile-chunks` and admits only as many bakes as fit both limits.
- `--light flat|smooth` — bake-time light quality (default `smooth`).
- `--biome-blend on|off` — vanilla-style biome tint gradients (default `on`).

### Or explore instantly, no full render — `vantage live`

Don't want to wait for a big world to bake? `vantage live` opens it in the
browser **now** and renders each tile on demand, the moment it scrolls into
view:

```sh
vantage live "~/.minecraft/saves/My World" --open   # → http://127.0.0.1:8268/
```

The whole populated map is listed up front, but a tile is only baked when you
look at it — so a 24 000-tile world is explorable in seconds instead of an
hour, with a bounded memory footprint (the world stays on disk and concurrent
bakes pass through the same `--threads` / `--memory` admission gate). Duplicate
requests for an in-flight tile share one bake. Tiles cache into `--out` (default
`web/public`) as they bake, so panning back is instant, and the cache doubles
as a partial `render` you can `serve` later. It takes the same world flags as
`render` (`--tile-chunks`, `--radius`, `--caves`, `--light`, `--biome-blend`,
`--gz`, `--threads`, `--memory`) plus `serve`'s `--port` / `--host` / `--open`.

`vantage render` is still the way to produce a self-contained static map to
deploy; `live` is for exploring one on your own machine without the wait.

### Render a multiplayer server — `vantage server`

From a checkout, the complete authenticated path is one command:

```sh
just server-dev
```

That builds Vantage, starts the sidecar against the bundled Java demo world,
generates a fresh 256-bit local bearer, starts the Vite viewer with the right
endpoint and credential, waits for both services, and opens the map. Tile
bakes and request logs remain visible in one terminal; `Ctrl+C` stops both
processes. To use a real server save:

```sh
just server-dev "C:\minecraft-server\world"
# macOS/Linux: just server-dev /srv/minecraft/world
```

Run `just server-dev-help` for ports, cache, scan interval, browser,
and build controls. CI and integration work can exercise the same stack without
a browser:

```sh
just server-smoke
```

The smoke run verifies protocol discovery, bearer rejection, exact-origin
CORS, continuous tile revisions, and one real lazy tile bake, then shuts down
cleanly. The generated development credential is loopback-only and ephemeral;
it is deliberately injected into the local viewer and must never be reused in
a deployed browser build.

Run the hardened, continuously updating form of the live renderer beside the
Minecraft server:

```sh
vantage server /srv/minecraft/world \
  --assets /srv/vantage/assets/minecraft \
  --out /var/cache/vantage/world
```

It binds to loopback by default for a session-authenticating reverse proxy. A
non-loopback bind requires a long bearer secret from an environment variable;
public deployments terminate TLS and enforce player/session policy at the
reverse proxy. Only tiles listed by the world manifest can trigger work,
concurrent bakes and connections are bounded, duplicate requests coalesce, and
changed region files invalidate only their overlapping map tiles.

The protocol, deployment examples, threat model, and host integration path are
in **[docs/server.md](./docs/server.md)**.

### 3. Deploy anywhere

The output is a static file tree (`manifest.json` + `tiles/` + one texture
array) — serve it from any web server or object store. The viewer is an
installable npm package, **[`@thoughts-on-things/vantage-mc`](./web/README.md)**, with three layers:
a zero-dependency tile decoder, a three.js renderer, and drop-in React
components:

```sh
npm install @thoughts-on-things/vantage-mc three
```

```tsx
import { VantageViewer, BiomeLayer } from '@thoughts-on-things/vantage-mc/react';

<VantageViewer world="/manifest.json">
  <BiomeLayer legend hover />
</VantageViewer>
```

See [`web/README.md`](./web/README.md) for the full API — including how to
stream tiles into your own three.js scene.

## CLI reference

`vantage render` is the main command; the rest are inspection and debug tools
(`vantage --help` prints the full usage):

```sh
vantage render  <save> [flags]                       # world → tiles + manifest + LOD pyramid
vantage live    <save> [flags]                       # explore now: tiles baked on demand as you look
vantage server  <save> [flags]                       # secure continuous data plane for multiplayer launchers
vantage serve   [render-dir] [--port n] [--host addr] [--open]   # host a render + the embedded viewer
vantage extract [client.jar]                         # populate the asset cache (auto-discovers the jar)
vantage meshtex <region.mca> <out.vtile> <assets> [cx0 cz0 cx1 cz1]
                                                     # textured mesh of one region window
vantage mesh    <region.mca> <out.vtile> [cx0 cz0 cx1 cz1]  # flat-color mesh, no assets needed
vantage histo   <region.mca> [localX localZ]         # block histogram for one chunk
vantage biomes  <region.mca> [cx0 cz0 cx1 cz1]       # biome histogram
vantage resolve <assets> <block> [state]             # debug: blockstate → model resolution
vantage texinfo <assets> <block...>                  # debug: texture lookups
```

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for the
dev setup, test loop, and PR guidelines.

## License

[MIT](./LICENSE). Vendored third-party code keeps its own license:
[libdeflate](./vendor/libdeflate/COPYING) (MIT) and
[stb_image](./vendor/stb/stb_image.h) (MIT / public domain, see the header).
