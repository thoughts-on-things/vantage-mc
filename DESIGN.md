# Vantage — Design

> A high-performance Minecraft (Java Edition) world → 3D web map renderer in Zig.
> A from-scratch reimagining of BlueMap, faster and more beautiful.

## 0. Goals (ordered)

1. **Performance** — *the single most important goal.* Generating a map of a large
   world must be as fast as possible while using as little CPU/RAM/disk as possible.
2. **Correctness** — the rendered world should match the live in-game view.
3. **Usability** — rendering must not break across Minecraft updates; updating
   must be easy and scalable.
4. **Fidelity** — modern, configurable, high-quality rendering. When possible, be
   the next leap in how Minecraft worlds look on the web.

**Non-goals (initially):** Bedrock Edition; Minecraft versions before 1.18; a
Java server *plugin* as the primary integration; reproducing the 20-tick world
simulation (flowing-water frames, redstone animation) on the map.

## 1. Why — the gap

BlueMap is the incumbent 3D web map. It does the right thing at the macro level
(a backend bakes geometry; a three.js frontend streams and shades it) but bleeds
on every one of our goals. Its actual pipeline, distilled from source:

- **Read**: Anvil `.mca` → BlueNBT (reflection) → chunk parser dispatched by
  `DataVersion` → paletted block-state/biome/heightmap unpacking.
- **Resolve**: downloads the vanilla jar, parses blockstates + model JSON (Gson),
  but stores each texture as a **base64 PNG data-URI** in one `textures.json` —
  no stitched atlas.
- **Mesh**: **per-block model emission, not greedy meshing**; per-face `cullface`
  culling; 3-neighbor AO, block+sky light, and biome tint baked per vertex/face.
- **Output**: hires (LOD 0) = 32×32-block tiles in **PRBM** — a **non-indexed**
  packed binary model (vertices duplicated → flat shading); lowres = a 3-level
  PNG pyramid encoding color + height + light.
- **Update**: N worker threads; per-chunk mod-time hashing; **re-renders the
  whole tile on any chunk change**; file or SQL storage.

### Where it bleeds — our attack surface

| BlueMap weakness | Consequence | Vantage lever |
|---|---|---|
| Non-indexed PRBM geometry | ~3× vertex bandwidth; 300 GB tile sets on big maps | Indexed + quantized vertices |
| Per-block meshing (no merging) | CPU-heavy, tiny-face explosion on dense builds | Hybrid greedy meshing |
| Base64 textures, no atlas/array | Payload bloat, no GPU texture efficiency | KTX2/Basis **texture arrays** |
| Java GC churn (per-vertex objects) | RAM creep 5→16 GB, OOM on long renders | Zig **arena-per-region**, no GC |
| Whole-tile re-render on any change | Wasteful incremental updates | Re-mesh minimal sub-units |
| Flat baked vertex light only | Visual ceiling | Baked AO + SSAO + soft shadows + atmosphere |
| Semi-static; no live players/entities in 3D | The unfilled product gap | Live overlay + streamed edits |
| HOCON config, manual asset-download opt-in | Setup friction | One binary, sane defaults |

The wider field forces a trade between **liveness** (Dynmap — live but 2D, server-heavy),
**beauty** (BlueMap; Chunky's offline path-traced ceiling), and **lightness**
(squaremap — cheap, 2D). **Distant Horizons** / **FarPlaneTwo** are the LOD
blueprints (quadtree, per-column datapoints, zstd-compressed store). No tool wins
all axes. Vantage targets the intersection: BlueMap-or-better 3D, Distant-Horizons
LOD scaling, Dynmap liveness, uNmINeD-class parse speed, one-binary ergonomics.

## 2. Architecture

The highest-leverage decision: a **fast native generator + a thin web renderer**,
coupled by a **versioned binary tile contract**. Expensive work is amortized once
per export; the web side stays lean.

```
Minecraft world dir
  └─ Zig native generator  (multithreaded, arena-per-region, SIMD hot paths)
       region mmap → NBT parse → palette unpack  (libdeflate/zstd via C interop)
       → resource-pack model resolver  (loaded once, cached)
       → HYBRID mesher:  greedy-merge full-cube opaque faces;
                         per-block emit for stairs/fences/fluids/block-entities
       → bake AO + block/sky light + biome tint
       → LOD builder  (quadtree; per-column multi-layer heightmap lowres)
       → encoder:  INDEXED + quantized binary tiles + KTX2 texture array, zstd
       → storage  (file tree / object store) + versioned manifest
  └─ static web frontend  (three.js → WebGPU, WebGL2 fallback)
       SSE-driven quadtree streaming → geomorph LOD → frustum cull
       → post-FX: baked light + SSAO + soft shadows + atmosphere + water
  └─ optional live path:
       companion plugin (async event tap) ──▶ live daemon ──websocket──▶ browsers
       world-dir file-watch ────────────────▶ live daemon            (near-live fallback)
```

**Components**

- **Generator** (Zig) — the engine. Batch and incremental. Reads world files
  directly; never runs inside the JVM.
- **Tile store** — content-addressed, versioned tiles + a manifest. File tree
  first; object-store/SQL backends later.
- **Web renderer** — static SPA. Dual tier: WebGL2 floor, WebGPU ceiling.
- **Live daemon** — long-running generator mode that watches for changes and
  pushes updates to viewers over websocket.
- **Companion plugin** (thin, optional) — taps the running server's block/entity
  events and streams them to the daemon. Renders nothing; never blocks the tick.

## 3. Locked decisions

| Decision | Choice | Rationale / risk |
|---|---|---|
| Language | **Zig 0.16** | Speed, tight/predictable memory (arena-per-region), trivial C interop (libdeflate/zstd/stb), painless cross-compile to one static binary per OS, credible WASM. Risk: pre-1.0 churn — *mitigate by pinning the version and vendoring C deps over std.compress/std.Io.* No MC-domain libraries exist; we build NBT/Anvil/model-resolver/mesher ourselves (we would anyway). |
| Deployment | **Standalone daemon + CLI**; optional thin plugin | Keeps Zig out of the JVM; cleanest distribution. The plugin is just a live-event source (see §4). |
| Render tiers | **Dual WebGL2 + WebGPU** | WebGL2 = compatibility floor (incl. mobile); WebGPU = fidelity + GPU-driven leap. three.js TSL eases the two-path cost. |
| World scope | **Modern Java, 1.18+ first** | The current format (−64..320 height, paletted biomes). Older versions and Bedrock come later as separable modules. |
| Edition | **Java** | Bedrock (LevelDB + different format) is a separate pipeline, deferred. |

## 4. Liveness model

True live 3D is the flagship differentiator. It decomposes into tiers with very
different costs, which **degrade gracefully**.

- **Tier 1 — Live actors** (players, mobs, item frames). Not tiles — a handful-to-
  hundreds of moving points overlaid on the static world. Stream positions at
  2–5 Hz for entities near the camera; interpolate client-side for smooth motion.
  Cheap, world-size-independent. Render as billboarded skins/heads or simple models.
- **Tier 2 — Live block edits** (the prize). A block change dirties one
  chunk-column (+ boundary faces of ≤4 neighbors). Detect → re-mesh just that
  sub-unit → encode → push to viewers holding that tile → client hot-swaps
  geometry with a crossfade. Native re-mesh of one column is sub-ms to low-ms.
- **Tier 3 — Live environment** (time of day, sun angle, weather). Pure frontend
  shader uniforms. Free.
- **Non-goal** — reflecting 20-TPS world simulation on the map.

**The decisive constraint:** the change-event source caps latency. Watching
region files on disk only sees edits when the server flushes (minutes) → that is
**near-live**. **True live** needs in-memory events, so the optional **companion
plugin** taps block-update/entity events and ships the live chunk data to the
daemon over a local socket (async, never blocking the tick; bulk operations like
WorldEdit coalesce to a region re-render). No plugin → near-live via file-watch.

**Tier 2 latency budget:** edit → plugin event (ms) → per-chunk debounce
(100–250 ms) → ship chunk (local socket, ms) → native re-mesh (sub-ms–few ms) →
encode + zstd (ms) → websocket push (ms) → client swap (ms) ≈ **250–500 ms**.
Mesh once, broadcast to all viewers → cost scales with edit rate, not viewer count.

## 5. Generator pipeline

1. **Region read** — mmap `.mca`; parse the location table; per chunk read the
   5-byte header; decompress (zlib/gzip/none/lz4) via vendored C decompressors.
2. **NBT decode** — streaming/visitor parser (no intermediate tree in the hot
   path); dispatch by `DataVersion`. Unpack paletted block-states, biomes,
   heightmaps, and 4-bit light (the non-spanning post-1.16 layout).
3. **Resource resolution** (loaded once) — blockstates (variants/multipart) →
   model JSON (parent inheritance, elements/faces, rotation, uvlock, tintindex) →
   texture array + biome colormaps. Vanilla assets downloaded on first run
   (Mojang assets are not redistributable); custom resource packs layered on top.
4. **Mesh** — **hybrid**: greedy-merge full-opaque-cube faces (the bulk:
   stone/dirt/…) into large quads; emit complex/non-cuboid models (stairs,
   fences, panes, fluids, redstone, block entities) per-block. Cull faces against
   solid neighbors. Bake per-vertex AO, block/sky light, and biome tint.
5. **LOD** — quadtree over XZ; distant levels collapse columns to a multi-layer
   heightmap (top surface + dominant color/biome/light, extra layers for
   overhangs/water). Geometric error per tile drives screen-space-error selection.
6. **Encode** — indexed, quantized binary tiles (position as chunk-local ints,
   normal as 3 bits, packed AO/light, texture-array layer index); KTX2/Basis
   texture array; zstd transport. Emit a versioned manifest.
7. **Store** — file tree (nested dirs to cap fan-out) first; object-store/SQL later.
8. **Incremental** — fine-grained change detection; re-mesh only dirty
   chunk-columns (+ touched neighbor boundaries). This is also the Tier-2 live path.

## 6. Tile & format contract

The generator and frontend are decoupled by a **documented, versioned binary
contract** so each can evolve independently and updates never break a live map.
Direction (to be specified concretely in P1–P4):

- **Geometry**: indexed; quantized attributes; per-tile self-contained blob.
  Smallest viable vertex (~8 bytes): packed local position, 3-bit normal,
  texture-array layer, packed AO + block/sky light + tint.
- **Textures**: WebGL2 **texture arrays** (not a 2D atlas — avoids the Minecraft
  mip/seam bug and supports greedy-quad UV repeat); KTX2/Basis supercompression;
  `NEAREST` mag for the pixel-art look, mip/aniso min to kill distant shimmer.
- **Transport**: zstd; HTTP gzip/brotli over the wire.
- **Manifest**: schema version, tile pyramid extents, texture set, world metadata.

## 7. LOD & tiling

- **Quadtree** over the XZ plane; each node owns a fixed world footprint, doubling
  per level. Octree only if tall/floating builds justify vertical subdivision.
- **Screen-space-error** selection (project tile geometric error to pixels;
  refine where it exceeds a threshold) → bounded on-screen triangle budget
  regardless of world size. **HLOD**: a parent tile is one merged low-detail mesh
  replacing its children → O(log n) distant draws.
- **Anti-popping**: geomorph vertices toward the next level over distance/frames;
  dither/crossfade fallback. Match lowres column colors to the average of
  full-detail textures so distant terrain reads as the same world.

## 8. Rendering (frontend)

- three.js as the integration layer; **WebGPURenderer** where available, WebGL2
  fallback (TSL → WGSL or GLSL from one material graph).
- Per-tile single draw; CPU frustum-cull via the quadtree; instancing for props;
  GPU-driven `multiDrawIndirect` on the WebGPU tier where supported.
- **Fidelity stack (feasibility order):** baked AO + baked block/sky light →
  SSAO/GTAO contact shadows → cascaded soft sun shadows (near tiles) → sky/
  atmosphere → stylized reflective water → light PBR-ish materials with an IBL
  sky probe → optional baked GI irradiance volume. Real-time ray tracing is not
  yet feasible cross-browser — bake instead.

## 9. Roadmap

Tracer-bullet phases; each ends in something runnable and verifiable.

- **P0 — Parsing spike. ✅ DONE.** Read region → decompress (zlib/C interop) →
  parse NBT → unpack paletted block-states → block histogram. Validated on Paper
  1.21.4 (`DataVersion 4189`, 24 sections, correct distribution). Locked Zig 0.16.
- **P1 — Vertical slice (pixels). ✅ DONE.** Dense block-grid assembler (multi-
  chunk, cross-chunk culling) → naive culled **indexed** cube mesh → versioned
  binary tile (`VTL1`: positions, RGBA, normals, u32 indices) → three.js viewer.
  Block appearance is a curated per-block average-color table (a deliberate
  stand-in; the real vanilla-asset/texture resolver is P2). Validated on the
  beacon 1.21.4 world: a 176-chunk patch renders as recognizable terrain (grass/
  dirt/stone strata, acacia trees, caves, bedrock floor) matching the histogram.
  See `docs/p1-render.png`. New modules: `blocks.zig`, `chunk.zig`, `grid.zig`,
  `mesh.zig`, `tile.zig`; `web/` viewer.
- **P2 — Full model resolver. 🚧 CORE DONE.** Implemented (`model.zig`,
  `texture.zig`, textured path in `mesh.zig`, `VTL2` tile + `VTA1` texture array,
  `sampler2DArray` viewer shader): blockstate variants/multipart(all-parts),
  model parent inheritance, elements/faces, model + per-face texture rotation,
  uv defaults, `#texture` var resolution, cullface culling (rotation-correct),
  PNG decode (vendored stb_image), normalized texture-array build.
  Validated: beacon 1.21.4 renders with correct textures (`docs/p2-render.png`).
  *Remaining hardening:* state-accurate variant selection (block Properties →
  variant; today picks the default/first, so axis/facing blocks may mis-orient),
  real multipart `when` matching, proper leaf/glass transparency, KTX2/Basis
  supercompression, and **asset auto-download** (today: manual jar extract;
  Zig 0.16 has `std.http.Client.fetch` + `std.zip` to do it in-binary).
- **P2.5 — Biomes + interactive layers. ✅ DONE.** Biome data parsed from the
  Anvil 4×4×4 paletted arrays (`chunk.zig`), assembled into a quarter-resolution
  biome grid (`grid.zig`), and resolved to colour through a curated vanilla
  temperature/downfall table + the real grass/foliage colormap formula and
  per-biome water/overrides (`biome.zig`). The mesher tints each `tintindex`
  face by the biome at its block — true plains-green vs savanna-gold, no more
  fixed tint. The `VTL3` tile adds a per-vertex biome id + a biome legend, and
  the viewer ships a toggleable **biome layer** (`B` key / panel / `#biome`
  hash): terrain recoloured by biome with relief preserved, plus a clickable
  legend that isolates a biome. This is the first interactive map layer — biome
  borders read at a glance. *Later:* swamp/dark-forest special grass blending,
  a 2D top-down biome map, hover-to-identify, and natural-colour biome mode.
- **P3 — Mesher hardening.** Hybrid greedy meshing; AO + light bake; fluids,
  waterlogging, transparency sorting; block-entity placeholders. *Done = a full
  region renders correctly vs in-game / BlueMap reference.*
- **P4 — Tiling, LOD, incremental.** Quadtree pyramid; multi-layer heightmap
  lowres; fine-grained change detection + incremental re-mesh; storage + manifest.
  *Done = a large world streams with working LOD.*
- **P5 — Frontend maturity.** SSE LOD + geomorph; frustum cull; WebGPU tier;
  post-FX (SSAO, shadows, atmosphere, water); markers/UI.
- **P5.5 — Live actors (Tier 1).** Daemon websocket spine + interpolated player/
  entity overlay. *Done = players move on the 3D map in real time.*
- **P6 — Performance & scale.** Thread pool, SIMD hot paths; benchmark vs BlueMap
  on time / peak-RAM / disk; large-world soak test.
- **P7 — Live block edits (Tier 2) + ergonomics.** Companion plugin (async event
  tap); incremental re-mesh + push; graceful degradation; one-binary packaging.
- **Parallel / later:** multi-version back-support; custom resource packs;
  Bedrock; WASM client-side meshing.

## 10. Risks

- **Model-resolver surface area** (every block × every state) is the long pole for
  both correctness and update-resilience — the exact edge-case knowledge BlueMap
  has years on us with.
- **Block entities** (chests, signs, banners, beds, heads, shulkers) have no model
  JSON; each needs a hand-written renderer.
- **Hybrid-mesh merge boundaries** with per-face AO/tint/light are subtle.
- **Zig pre-1.0 churn** over a multi-year project (std.compress, std.Io,
  std.Thread.Pool, build API are the hotspots). Mitigate: pin the version, vendor
  C deps, budget one migration sprint per Zig release.
- **Vanilla asset redistribution** is disallowed → download on first run.

## 11. Tech notes

- **Zig 0.16 specifics** already encountered (this toolchain moves fast):
  `main(init: std.process.Init)`; args via `init.minimal.args.toSlice(arena)`;
  file I/O via `std.Io.Dir.cwd().readFileAlloc(io, path, gpa, .unlimited)` (the
  old `std.fs.cwd()` / `std.process.argsAlloc` are gone); `linkSystemLibrary` is
  on the module (`exe.root_module.linkSystemLibrary("z", .{})`), not the Compile
  step; `std.ArrayList(T) = .empty` with allocator-passing methods.
  More, from P1: file writes via `std.Io.Dir.cwd().writeFile(io, .{ .sub_path,
  .data })`; **`std.time.Timer` is gone** (timing goes through the `Io` clock now
  — we dropped instrumentation rather than chase it); `std.StaticStringMap(V)`
  with `.initComptime(.{ .{"k", v}, … })` + `.get` is the comptime perfect-hash
  table (block-color table). Reminder: a paletted section's bit width is
  `max(4, ceil(log2(len)))`, so a ≤16-entry palette is **4** bits, not 5.
- **Decompression**: system zlib via C interop today; vendor **libdeflate** /
  **zstd** for the production decode path. We deliberately avoid `std.compress`.
- **Test data**: the local `beacon` Paper 1.21.4 server world (which also has
  BlueMap installed) is a convenient correctness + visual-comparison reference.
