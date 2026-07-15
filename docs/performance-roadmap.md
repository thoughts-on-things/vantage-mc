# Performance architecture and roadmap

This document records the performance audit behind Vantage's memory-bounded
streaming work, the techniques implemented in the current change, and the
highest-value next steps. The invariant is strict: high-resolution terrain must
retain block geometry, texture selection, biome tint, saved sky/block light,
and ambient occlusion exactly. Approximation belongs only in an explicitly
lower LOD that is replaced before the error becomes visible.

## What the profile says

The dense 4,096-chunk demo is a useful stress case: 56 non-empty 8×8-chunk
tiles, 27,144,800 vertices, smooth light, full caves, and 20 low-resolution
tiles. Before the memory scheduler, 16 simultaneous tile arenas reached about
2,504 MiB. The first bounded version admitted five bakes under its 1,024 MiB
capacity and measured about 1,087 MiB.

The next profile exposed three less obvious costs:

- Compression dominated the remaining CPU. At gzip level 9, aggregate tile
  write/compress time was 21.3 CPU-seconds, versus 9.5 for geometry, 1.2 for
  lighting, and 0.9 for chunk reads. Level 7 reduced write CPU to 7.2 seconds
  while increasing the final payload by only about 5%.
- VTL8 lightmaps were 76.1 MiB of the 710.8 MiB raw tile stream. Their three
  on-disk channels expanded to 101.5 MiB of RGBA8 GPU texture data for the
  complete world. Sky and block light are intrinsically four-bit values.
- A lightmap's CPU pixels survived its upload. A view into a tile buffer can
  also keep that entire decompressed buffer alive after every geometry
  attribute has reached the GPU.

VTL9 therefore stores lossless `(sky << 4) | block` and full-byte AO planes,
uploads them as RG8, and manually bilinearly filters four *decoded* texels.
Filtering the packed byte first would mix the nibbles and is not equivalent.
The CPU lightmap source is released after upload, as geometry sources already
are. The native writer reserves its exact output once and writes quantized
streams directly, avoiding temporary arrays that an arena cannot reclaim.

Two repeated VTL9 runs measured 971–984 MiB peak and 5.01 seconds internal
wall time. The output is 685.4 MiB raw and 36.3 MiB gzip. Against the original
unbounded run, that is about **61% less peak host memory and 27% less wall
time**. Against the first bounded VTL8/gzip-9 run, it removes another 25.4 MiB
of raw lightmaps, halves steady GPU lightmap bytes, lowers measured peak by
about 10%, and cuts wall time by about one third.

The fidelity check compared all 56 real tiles across independently scheduled
renders. Geometry, referenced texture content, biome identity, surface maps,
and every sky/block/AO sample were equivalent; all 20 low-resolution tiles
were byte-identical. Texture and biome numeric IDs may differ because parallel
discovery currently assigns them in encounter order, but their resolved
content is identical.

## The target runtime

The end state is one scheduler, not a geometry queue plus unrelated texture,
entity, and overlay queues. Every resource is described by:

```text
(spatial key, kind, LOD, dependencies,
 estimated bytes, measured bytes,
 view error, foveal angle, time-to-camera,
 cancellation token, disposal callback)
```

Admission uses a global resident-byte capacity and separate transient
capacities for fetch, decode, and upload. A weighted fair queue prevents a
large geometry response from starving a tiny entity or texture dependency.
Measured costs replace estimates. Work that leaves the desired view set is
cancelled at every stage; completed resources enter a scan-resistant cache.

This extends the current bounded pipeline without making each new stream an
independent source of oversubscription.

## Next highest-value work

### 1. Error-driven, foveated HLOD traversal

Replace fixed distance rings with a real hierarchical traversal. Each LOD tile
should publish a bounding volume, compressed/resident byte estimates, and a
conservative `geometricError`: the maximum deviation between that tile and its
children. The client projects it to pixels:

```text
SSE = geometricError * viewportHeight /
      (2 * distance * tan(verticalFov / 2))
```

Refine only while SSE exceeds the quality threshold. If the desired set would
exceed memory, raise the threshold until it fits, rather than loading detail
and evicting it immediately. This follows the error/refinement model in the
[OGC 3D Tiles specification](https://docs.ogc.org/cs/22-025r4/22-025r4.html).

Add a center-view cone and temporarily relax SSE outside it while the camera
is moving. Restore normal error after a short stillness delay. Cesium's
[foveated SSE implementation](https://cesium.com/downloads/cesiumjs/releases/1.115/Build/Documentation/Cesium3DTileset.html)
is the reference behavior: center tiles arrive first without permanently
reducing edge quality. Velocity lookahead becomes a deadline signal, not a
replacement for view error.

The existing low-resolution coverage rules already provide crack-free
replacement: a parent remains visible until all required children are ready.
Geometric morphing is useful for smooth heightfields, but block-exact hires
should dissolve over the parent rather than move block vertices.

### 2. Worker decode with closed-loop backpressure

Move inflate, delta decode, atlas interleave, and manifest-independent parsing
to a small Web Worker pool. Transfer buffers rather than clone them. Keep GPU
object creation on the main thread and retain the current one-to-three uploads
per frame.

Concurrency should use additive-increase/multiplicative-decrease rather than a
static device preset:

- start from a conservative value derived from the
  [Device Memory API](https://www.w3.org/TR/device-memory/);
- increase after a stable window with spare frame time;
- halve on a long task, missed-frame streak, memory-pressure signal, or upload
  backlog;
- schedule non-visible maintenance with
  [`requestIdleCallback`](https://www.w3.org/TR/requestidlecallback/) or
  prioritized task scheduling when available;
- observe main-thread stalls through the
  [Long Tasks API](https://www.w3.org/TR/longtasks-1/).

This makes a fast desktop fill its pipeline while a phone converges to one
decode/upload without a separate hand-tuned quality table.

### 3. Deterministic content-addressed incremental baking

Repeated whole-world renders should be proportional to what changed. A tile's
key should hash:

- raw NBT for its core chunks and one-chunk apron;
- relevant entity-region chunks;
- asset/resource-pack content;
- mesher and format version;
- light, cave, biome-blend, and tile-size settings.

Store the tile by content hash and make the manifest a small dependency graph.
Merkle parents let low-resolution ancestors rebuild only along changed paths.
The prerequisite is stable texture and biome IDs: encounter-order assignment
must become content/name-derived, or an unchanged tile can be byte-different
after a different parallel schedule. Atomic publication keeps readers on the
old graph until all new dependencies exist.

For actively edited worlds this is likely the largest latency and energy win
available: zero work for unchanged tiles beats making every bake faster.

### 4. Bit-parallel meshing and slab working sets

The current greedy mesher already removes hidden faces, merges rectangles, and
uses quantized canonical quads. Its next CPU step is to make occupancy and face
extraction word-parallel:

1. decode opaque/transparent occupancy into 64-bit bit planes;
2. derive six face masks with shifts and boolean operations;
3. group masks by material/tint/light contract;
4. extract maximal rectangles with trailing-zero/count operations;
5. emit the existing exact VTL streams.

Implementations such as
[binary-greedy-mesher](https://github.com/TanTanDev/binary_greedy_mesher_demo)
demonstrate the approach. Vantage's material models, fluids, biome tint, and
lightmap patches make the merge key richer, so this must be introduced behind
semantic/golden comparisons rather than copied wholesale.

After that, process vertical 16-block slabs with a one-slab halo. Preserve
greedy runs that cross the slab boundary in a small continuation table. This
makes the dense occupancy/light working set depend on tile area and a few
sections, not total world height, while retaining identical quads. Mesh output
still dominates dense-grid memory on pathological tiles, so emission should
write bounded mesh pages rather than one ever-growing in-memory mesh.

### 5. A byte-weighted decoded-chunk cache

The demo decodes 6,084 chunk instances for 4,096 unique chunks because tile
aprons overlap: 48.5% extra decode work. Reads are not the dominant phase on
this world, so a large unconditional LRU would spend memory for little gain.

Use keyed singleflight plus a small byte-weighted Window TinyLFU cache. Its
frequency sketch and probation window resist the sequential scans that evict
hot boundary chunks from LRU; Caffeine documents the
[W-TinyLFU design and trace results](https://github.com/ben-manes/caffeine/wiki/Efficiency).
[ARC](https://research.ibm.com/publications/arc-a-self-tuning-low-overhead-replacement-cache)
is another scan-resistant recency/frequency policy, but its ghost metadata and
uniform-page model are less natural for variable-size decoded chunks.

Admission must charge actual decoded bytes, and the cache must live inside the
same backend memory capacity as bake arenas. Start at roughly one worker's
budget and keep it only if trace replay shows a worthwhile hit rate.

### 6. Server scheduling and transport

The live bake semaphore bounds expensive work, but one detached native thread
per connection still permits unbounded connection stacks. Move sockets onto a
bounded event loop or connection pool, with separate quotas for connections,
active responses, bakes, and cached bytes. Track the waiter count on a
singleflight bake and cooperatively cancel it if every requester disconnects.

For remote hosting:

- send center/visible tiles with higher HTTP urgency and prefetch/outer LODs
  lower; [RFC 9218](https://www.rfc-editor.org/rfc/rfc9218.html) defines
  urgency 0–7, incremental responses, and reprioritization for HTTP/2 and 3;
- consider region bundles with a compact offset index and HTTP Range requests
  when per-file metadata/request overhead becomes material;
- keep independently cancelable ranges/pages—one giant archive recreates the
  all-or-nothing memory and latency problem;
- use immutable content hashes and CDN caching for static artifacts.

Compression should remain measured by format and deployment. Gzip 7 is the
current local Pareto point. CDN content encoding may make Brotli or Zstandard
attractive, but a browser-WASM decoder is not automatically a win once its
download, memory, and main-thread costs are included.

### 7. Texture pages for high-resolution resource packs

Vanilla's 16×16 texture array is small, so geometry and lightmaps deserve
priority. High-resolution resource packs change that. KTX2 supports GPU-ready
formats, supercompression, and small-mip-first streaming; see the
[KTX 2 specification](https://registry.khronos.org/KTX/specs/2.0/ktxspec.v2.html).

Split textures into content-addressed pages and let tiles declare page
dependencies. Stream coarse mips first, then sharpen visible/foveal pages.
ETC1S/UASTC/Basis targets are not bit-exact RGBA, so pixel-exact mode should
retain uncompressed RGBA8 or a lossless KTX2 payload. Compressed GPU targets
should be an explicit quality/storage option, not a silent default.

### 8. Entity and block-entity streams

Entities must not be baked into terrain tiles. Index entity-region chunks and
embedded block entities separately, then feed them to the unified scheduler:

- near: complete NBT-backed representation and exact model/state;
- mid: instanced models sharing geometry/materials;
- far: conservative cluster/impostor metadata, replaced before its projected
  error is visible;
- inactive/out of view: compact serialized records only.

Changes to entities then invalidate an entity page, not megabytes of terrain.
Per-type pools and instancing prevent thousands of identical chests, signs, or
item frames from becoming thousands of materials and draw calls. Animation and
simulation updates get a time budget separate from fetch/decode capacity.

### 9. WebGPU meshlets and occlusion—not a mandatory rewrite

A future WebGPU renderer can page opaque terrain into meshlets, store their
bounds/normal cones, cull them in compute against the frustum and a hierarchical
depth buffer, and issue indirect draws. The
[meshoptimizer implementation](https://github.com/zeux/meshoptimizer) provides
meshlet construction, cache/fetch optimization, quantization, and
attribute-aware simplification. The current
[WebGPU specification](https://www.w3.org/TR/webgpu/) includes indirect draws
and occlusion queries.

This is most valuable for cave view, dense forests, and long oblique views
where tile-level frustum culling leaves substantial hidden geometry. It is not
the first move for top-down maps where about two draws per tile and coarse
frustum culling are already effective. Keep WebGL2 as the compatibility path;
instrument GPU time and rejected clusters before making WebGPU the default.

For low-resolution meshes only, meshoptimizer's attribute-aware simplification
with locked tile borders can replace regular heightfields where it yields a
better triangle/error curve. Never simplify hires block silhouettes.

## Techniques that are interesting but not the primary path

- **Geometry clipmaps** cache nested viewer-centered grids and refill them
  incrementally, yielding bounded memory and temporal continuity. The
  [original work](https://hhoppe.com/proj/geomclipmap/) strongly validates the
  current low-resolution ring direction. Content-error HLOD is a better fit
  for sparse, cave-bearing block terrain than a pure fixed grid, but clipmap
  update rules remain useful for the far-field height layer.
- **Transvoxel** uses transition cells to join Marching Cubes isosurfaces at
  different resolutions; see the
  [algorithm description](https://transvoxel.org/). Vantage renders discrete
  block faces, not a smooth scalar isosurface, so parent coverage/skirts or
  block-aware boundary meshes are simpler and more faithful.
- **Sparse voxel DAGs** can reduce repeated binary occupancy by orders of
  magnitude and traverse it directly, as shown by
  [High Resolution Sparse Voxel DAGs](https://research.chalmers.se/publication/182658).
  Minecraft's material, texture, biome, light, fluid, and block-entity
  attributes greatly reduce subtree identity, while adopting a DAG implies a
  new GPU ray renderer and content pipeline. It is a compelling experimental
  far-field or server query representation, not the next production frontend.
- **Lossy geometry/texture compression** is appropriate only where a measured
  projected-error bound hides it. Disk size alone is not a reason to alter
  near-field block silhouettes, UV repetition, saved light, or pixel art.

## Required gates for every optimization

1. Semantic fidelity: compare resolved texture content and biome names, not
   schedule-dependent numeric IDs; compare every light/AO sample.
2. Bounded memory: report backend peak working set and viewer CPU/GPU resident
   bytes on the same fixture and capacity.
3. Responsiveness: report p95/p99 frame time, long tasks, and upload backlog
   during a scripted high-speed pan—not just average FPS while stationary.
4. Streaming quality: report center-tile time, bytes fetched before first sharp
   view, cancellation waste, and visible lowres-to-hires replacement delay.
5. Cache value: replay representative pan/edit traces and compare hit rate,
   bytes saved, invalidation work, and metadata overhead against no cache.
6. End-to-end cost: include bake CPU, wire bytes, decode CPU, GPU bytes, and
   shader time. Moving cost between columns is not automatically an
   improvement.
