# Memory-bounded streaming

Vantage treats memory as a capacity to schedule, not as a side effect to
observe after a render fails. The backend and viewer use the same three-stage
model:

1. discover cheap metadata;
2. admit a bounded amount of expensive work;
3. evict or checkpoint data as soon as the next stage owns it.

## Backend

Region discovery retains only each region's 4 KiB location table. Chunk NBT is
read on demand into a per-tile arena. The number of simultaneously live arenas
is:

```text
min(logical cores, --threads, pending tiles, --memory / estimated tile bytes)
```

The estimate scales with the square of `--tile-chunks` and includes the dense
voxel grid, NBT decode state, lighting and meshing scratch, output mesh, and
compression overlap. `--threads` is an upper bound rather than permission to
allocate one large arena for every core. `--memory` is an explicit deployment
control; its adaptive default leaves most physical memory to the operating
system, page cache, and viewer.

Low-resolution color maps used to remain in the render's root arena until the
entire world pyramid was complete. They are now small checkpoint files under a
temporary `.vantage-lod` directory. Each LOD pass reads at most four children,
writes their parent, and deletes the previous level. The bulk retained heap
therefore depends on tile size and admitted concurrency; only compact manifest
and coordinate metadata continue to scale with world area.

The live server applies the same bake semaphore. A keyed in-flight set also
coalesces concurrent requests for the same tile: one request bakes while the
others wait for the cached result.

## Viewer

The viewer plans from the coordinate grid around the camera, so a replan is
proportional to the visible search radius rather than every tile in a huge
manifest. Priorities blend current-camera distance with a bounded lookahead
derived from camera motion.

Admission is constrained by both `maxTiles` and `maxBytes`. Initially the
planner uses compressed size plus a conservative expansion factor. Once a tile
has been decoded, its geometry attributes, indices, lightmaps, surface maps,
and height data become a size hint; an exponentially weighted mean covers new
tiles. If actual residency crosses the budget, the farthest high-resolution
tiles are evicted first.

Fetch/decode concurrency and the built-but-not-uploaded queue are separately
bounded. This backpressure matters because decoded typed arrays can be much
larger than their gzip payloads. Stale queued and in-flight work is cancelled
on every replan, while the nearest tile is always admitted to preserve forward
progress even when one tile exceeds the nominal budget.

Low-resolution rings remain available as placeholders and overview terrain.
They participate in measured residency, while high-resolution tiles are the
evictable detail layer.

## Extending the scheduler

Future independently streamed resources—entities, block entities, overlays,
or richer texture pages—should expose three values to the same planner:

- a camera-dependent priority;
- an estimated and then measured byte weight;
- a cancellation/disposal handle.

Keeping these properties at the resource boundary lets new streams share one
global capacity instead of adding independent queues that can collectively
oversubscribe the host.
