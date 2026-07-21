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
others wait for the cached result. Under `--prebake` (the multiplayer server's
default), background workers spend idle bake slots on the unbaked tile nearest
the most recent viewer request, standing down whenever an interactive fetch is
waiting — the same coalescing makes a viewer request for a tile mid-prebake
join that bake instead of duplicating it.

The multiplayer server adds immutable world epochs. Its frequent change gate
stats region filenames, sizes, and mtimes; only an advancing fingerprint
causes 4 KiB location tables and populated-chunk metadata to be re-read. A
region-coordinate index gives each advertised tile an opaque revision derived
from the few regions intersecting its bake window and seam apron. In-flight
bakes retain their epoch, epoch swaps take a short mutex, cache writes are
atomic, and the viewer replaces only tiles whose revisions changed. See the
[multiplayer server design](./server.md).

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

Whichever budget binds, admission stays a contiguous nearest-first prefix:
the first unaffordable candidate ends the plan rather than being skipped for
cheaper, farther tiles. A skip would buy a few extra resident tiles at the
cost of holes mid-view, and it destroys the single frontier the renderer
relies on — the planner reports the admitted radius so fog and the map-memory
haze floor hug where high-resolution data really stops. Budget-cut plans
re-run as decoded sizes replace estimates, so the disc grows to whatever the
budget truly affords.

Evicted tiles keep their compressed payloads in a client-side LRU
(`tileCacheBytes`) keyed by tile revision. Panning back over explored terrain
rebuilds geometry from that cache with no network round-trip — and against an
on-demand server, no re-bake. Revision changes and manifest removals drop the
affected entries.

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

The profiled, ranked continuation of this design—including SSE/foveated HLOD,
worker backpressure, deterministic incremental baking, bit-parallel meshing,
entities, texture pages, and WebGPU meshlets—is in
[the performance architecture roadmap](./performance-roadmap.md).
