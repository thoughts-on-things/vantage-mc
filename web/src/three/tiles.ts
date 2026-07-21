// TileManager — streams a tiled world render around a moving focus point.
//
// Given a manifest, it keeps the tiles nearest the camera loaded (nearest-first
// fetch queue with bounded concurrency), unloads what falls out of range
// (with hysteresis so the boundary doesn't thrash), and shares ONE terrain
// material + ONE water material across every tile — one shader program total,
// uniforms (biome mix, fog, light) in lock-step, two draw calls per tile.
//
// It also answers the world-level queries the viewer needs across tiles:
// terrain height under a point (the controls' terrain-riding pivot), biome
// picking along a ray (hover), and an aggregated biome summary (the legend).

import * as THREE from 'three';
import {
  LOWRES_EMPTY,
  maybeInflate,
  parseLowresTile,
  parseTile,
  parseTileQuantized,
  summarizeBiomes,
  summarizeSurfaceBiomes,
  tileKey,
  type BiomeEntry,
  type LowresLevel,
  type ManifestTile,
  type Rgb,
  type SurfaceMap,
  type WorldFetch,
  type WorldManifest,
} from '../core/index.js';
import { Emitter } from './emitter.js';
import { ImpostorLayer } from './impostors.js';
import { applyCaveRange, buildLowresMesh, buildQuantizedTileMeshes, buildTileMeshes, isSharedQuadIndex, sharedQuadIndex, type TileMeshes } from './terrain.js';
import { admitTiles, nearbyTiles } from './streaming.js';
import { TileByteCache } from './tilecache.js';

export interface TileManagerOptions {
  manifest: WorldManifest;
  /** Fetch a file by manifest-relative path — a {@link WorldSource}'s `fetch`
   *  (HTTP, a local folder, …). Tile paths are passed through verbatim. */
  fetch: WorldFetch;
  scene: THREE.Scene;
  /** The shared terrain shader (from {@link createTerrainMaterial}). */
  material: THREE.ShaderMaterial;
  /** The shared water shader (from {@link createWaterMaterial}). */
  waterMaterial: THREE.ShaderMaterial;
  /** The shared atlas-lit shader (from {@link createLightmappedMaterial});
   *  required to draw VTL8+ tiles' lightmapped geometry (manifest format 4+). */
  lmMaterial?: THREE.ShaderMaterial;
  /** The shared lowres LOD shader (from {@link createLowresMaterial}); required
   *  to stream a format-2 manifest's lowres pyramid. */
  lowresMaterial?: THREE.ShaderMaterial;
  /** Biome palette indexed by the manifest's biome ids. */
  palette: Rgb[];
  /** Stream-in radius around the focus, in blocks. Default `768`. */
  viewDistance?: number;
  /** Hard cap on resident tiles (nearest win). Default `120` (fills the
   *  default view-distance disc; matches the settings panel's "med" preset). */
  maxTiles?: number;
  /** Concurrent tile fetches. Default `6` — enough to keep an on-demand
   *  server's bake slots saturated while staying within a browser's
   *  per-origin HTTP/1.1 connection budget. */
  concurrency?: number;
  /** Estimated CPU/GPU residency budget in bytes. Unlike `maxTiles`, this
   *  accounts for large and small tiles having very different geometry. One
   *  nearest oversized tile is allowed for forward progress. Default `512 MiB`. */
  maxBytes?: number;
  /** Budget for evicted tiles' compressed payloads, in bytes. Tiles leaving
   *  the streaming ring keep their fetched bytes here so panning back
   *  rebuilds them without a network round-trip (or an on-demand server
   *  re-bake). `0` disables. Default `192 MiB` (~400 typical tiles). */
  tileCacheBytes?: number;
  /** Live/on-demand renders grow the shared texture atlas in viewport order, so
   *  a fetched tile can reference layers the atlas doesn't have yet. When set,
   *  the manager widens the atlas (awaiting this) before building a tile that
   *  needs newer layers, so nothing is ever drawn against a missing-texture
   *  atlas. Returns the atlas layer count now loaded. Omitted for a
   *  static/complete render, whose atlas never grows. */
  ensureAtlas?: (layers: number) => Promise<number>;
  /** The renderer, enabling map memory for worlds WITHOUT a lowres pyramid
   *  (live bakes, `vantage server`): evicted tiles are snapshotted into a
   *  shared atlas and persist as cheap textured impostors, so everywhere the
   *  camera has been stays visible when zoomed out. See `mapMemory`. */
  renderer?: THREE.WebGLRenderer;
  /** Map-memory impostor resolution in pixels per (128-block) tile — the
   *  quality knob for remembered terrain. `0` disables. Default `64`
   *  (a 2048² atlas remembering 1024 tiles ≈ 22 MB of GPU memory). Ignored
   *  when the manifest ships a lowres pyramid (that covers the whole world
   *  already) or without `renderer`. */
  mapMemory?: number;
}

/** Live totals across resident tiles. */
export interface TileStats {
  /** Hires tiles fully loaded (in the scene). */
  loaded: number;
  /** Tiles currently fetching/decoding (hires + lowres). */
  loading: number;
  /** Total hires tiles in the manifest. */
  total: number;
  /** Lowres LOD tiles resident. */
  lowres: number;
  /** Tiles remembered as map-memory impostors (streamed worlds without a
   *  lowres pyramid). */
  remembered: number;
  vertexCount: number;
  triangleCount: number;
  /** Compressed bytes fetched and resident. */
  bytes: number;
  /** Estimated CPU/GPU bytes held by resident and upload-pending resources. */
  residentBytes: number;
  /** Compressed payloads retained for instant revisits (the tile byte cache). */
  cachedBytes: number;
}

interface TileEvents extends Record<string, unknown> {
  /** A tile finished loading or was unloaded; payload = live stats. */
  change: TileStats;
}

interface Record_ {
  ref: ManifestTile;
  /** Pyramid level: 0 = hires, ≥1 = lowres LOD ring. */
  level: number;
  /** `built` = decoded and meshed, queued for its staggered scene insertion.
   *  `failed` retries with backoff while still in view; `empty` never does. */
  state: 'loading' | 'built' | 'ready' | 'failed' | 'empty';
  /** For `failed`: earliest time (performance.now()) to retry the fetch. */
  retryAt?: number;
  abort?: AbortController;
  terrain?: THREE.Mesh;
  /** When the tile entered the scene — drives its stream-in fade. Undefined
   *  means "no fade" (already fully opaque). */
  fadeStart?: number;
  /** VTL8+: the atlas-lit solid tail (drawn with the lightmapped material). */
  terrainLm?: THREE.Mesh;
  /** VTL8+: the tile's lightmap texture, disposed with the tile. */
  lightmapTex?: THREE.DataTexture;
  water?: THREE.Mesh;
  surface?: SurfaceMap;
  /** Lowres heightfield data, kept for the zoomed-out pivot height fallback. */
  low?: { originX: number; originZ: number; span: number; width: number; depth: number; heights: Int16Array };
  biomes?: BiomeEntry[];
  vertexCount: number;
  triangleCount: number;
  /** Estimated retained CPU/GPU bytes for this record. */
  memoryBytes: number;
}

/** Record key: hires tiles keep the plain tile key, lowres prefix their level. */
function recKey(level: number, x: number, z: number): string {
  return level === 0 ? tileKey(x, z) : `l${level}:${x},${z}`;
}

/** Free each attribute's CPU copy once it has been uploaded to the GPU — tiles
 *  are never raycast (picking runs on the surface maps), so the JS-heap copy of
 *  megabytes of geometry per tile serves no purpose after upload. */
function releaseAfterUpload(geom: THREE.BufferGeometry): void {
  function release(this: THREE.BufferAttribute): void {
    (this as { array: unknown }).array = null;
  }
  for (const name of Object.keys(geom.attributes)) {
    (geom.getAttribute(name) as THREE.BufferAttribute).onUpload(release);
  }
  // The shared quad index keeps its CPU array: other geometries may still
  // force a (re-)upload of the shared GPU buffer later.
  if (geom.index && !isSharedQuadIndex(geom.index)) geom.index.onUpload(release);
}

function arrayBytes(value: unknown): number {
  return ArrayBuffer.isView(value) ? value.byteLength : 0;
}

/** Count per-tile vertex/index storage. Shared indices are global and counted
 *  nowhere per tile; every other typed array becomes a same-sized GPU buffer. */
function geometryBytes(geom: THREE.BufferGeometry): number {
  let bytes = 0;
  for (const name of Object.keys(geom.attributes)) {
    bytes += arrayBytes((geom.getAttribute(name) as THREE.BufferAttribute).array);
  }
  if (geom.index && !isSharedQuadIndex(geom.index)) bytes += arrayBytes(geom.index.array);
  return bytes;
}

function textureBytes(texture: THREE.DataTexture | undefined): number {
  if (!texture) return 0;
  // Before first draw the bytes live on the CPU; after upload lightmapTexture
  // releases that source and the same-sized GPU allocation remains.
  const gpuBytes = texture.userData['vantageGpuBytes'];
  return typeof gpuBytes === 'number'
    ? gpuBytes
    : arrayBytes((texture.image as { data?: unknown }).data);
}

export class TileManager {
  private readonly opts: Required<Omit<TileManagerOptions, 'lowresMaterial' | 'lmMaterial' | 'ensureAtlas' | 'renderer' | 'mapMemory'>>;
  private readonly lowresMaterial: THREE.ShaderMaterial | null;
  private readonly lmMaterial: THREE.ShaderMaterial | null;
  /** Map memory (impostor snapshots of evicted tiles); null when the world
   *  ships a lowres pyramid, when disabled, or without a renderer. */
  private impostors: ImpostorLayer | null = null;
  /** Kept for live map-memory reconfiguration (resolution changes). */
  private readonly renderer: THREE.WebGLRenderer | null;
  /** Widens the shared atlas to cover a tile's layers before it's drawn (live
   *  renders only); null when the atlas is complete. */
  private readonly ensureAtlas: ((layers: number) => Promise<number>) | null;
  /** Best-known covered atlas layer count. `Infinity` disables the gate — a
   *  static render never grows its atlas. */
  private atlasLayers: number;
  private readonly index = new Map<string, ManifestTile>();
  private readonly records = new Map<string, Record_>();
  private readonly emitter = new Emitter<TileEvents>();
  private readonly tileBlocks: number;
  /** Lowres pyramid levels, finest first ([] when the manifest has none). */
  private readonly lowLevels: LowresLevel[];
  /** Tile-existence index per lowres level (for the coverage pass). */
  private readonly lowIndex = new Map<number, Map<string, ManifestTile>>();
  /** Set when residency changed and lowres visibility needs recomputing. */
  private coverageDirty = false;
  /** Tiles mid stream-in fade; drained by update(), keeps the viewer drawing. */
  private readonly fadingKeys = new Set<string>();

  private queue: { ref: ManifestTile; level: number }[] = [];
  /** Built tiles awaiting scene insertion — flushed ONE per update() call so
   *  multi-MB GPU uploads never pile into a single frame. */
  private pendingAdd: string[] = [];
  /** Built records still holding upload-pending typed arrays. Pumping pauses at
   *  one concurrency-window so decode cannot outrun GPU submission. */
  private pendingBuilt = 0;
  private inFlight = 0;
  private lastFocusX = Infinity;
  private lastFocusZ = Infinity;
  private disposed = false;
  /** Fetch-failure counts per record key, surviving record deletion so retry
   *  backoff escalates; cleared on success or unload (a fresh pan-in retries). */
  private failCounts = new Map<string, number>();
  private nextRetrySweep = 0;
  /** Learned tile weights survive eviction and make future admission byte-aware. */
  private readonly sizeHints = new Map<string, number>();
  private averageHiresBytes = 12 * 1024 * 1024;
  /** Distance² where the last plan ran out of budget (null = nothing cut).
   *  Derives {@link admittedRadius} — the honest hires frontier. */
  private planCutoffSq: number | null = null;
  /** When the last plan ran, so byte-estimate learning re-plans at a bounded
   *  rate instead of once per tile load. */
  private lastPlanMs = 0;
  /** Compressed tile payloads kept after eviction. A revisit rebuilds from
   *  here — no network fetch, no server re-bake. */
  private readonly byteCache: TileByteCache;
  /** Whether resident tiles draw their cave-dark tails (VTLA). The viewer's
   *  cave policy toggles this off while the camera is above ground with the
   *  depth slice closed. */
  private caveGeometry = true;
  private focusX = 0;
  private focusZ = 0;

  private biomesCache: BiomeEntry[] | null = null;
  private statsCache: TileStats | null = null;

  /** Y range of everything loaded so far, for ray-march bounds. */
  private minY = 0;
  private maxY = 320;

  constructor(options: TileManagerOptions) {
    const { lowresMaterial, lmMaterial, ensureAtlas, renderer, mapMemory, ...rest } = options;
    this.opts = {
      viewDistance: 768,
      // Sized to fill the whole view-distance disc for 128-block tiles
      // (π·(768/128)² ≈ 113) with a little slack — and to match the settings
      // panel's "med" preset exactly.
      maxTiles: 120,
      concurrency: 6,
      maxBytes: 512 * 1024 * 1024,
      tileCacheBytes: 192 * 1024 * 1024,
      ...rest,
    };
    this.byteCache = new TileByteCache(this.opts.tileCacheBytes);
    this.lowresMaterial = lowresMaterial ?? null;
    this.lmMaterial = lmMaterial ?? null;
    this.ensureAtlas = ensureAtlas ?? null;
    this.atlasLayers = ensureAtlas ? (options.manifest.textureLayers ?? 0) : Infinity;
    this.tileBlocks = options.manifest.tileBlocks;
    // Pre-size the shared quad index to the biggest section in the world, so
    // streaming never grows (= re-uploads) it mid-pan.
    if (options.manifest.maxSectionVerts) sharedQuadIndex(options.manifest.maxSectionVerts);
    for (const t of options.manifest.tiles) this.index.set(tileKey(t.x, t.z), t);
    this.lowLevels = this.lowresMaterial ? [...(options.manifest.lowres?.levels ?? [])].sort((a, b) => a.level - b.level) : [];
    for (const lvl of this.lowLevels) {
      this.lowIndex.set(lvl.level, new Map(lvl.tiles.map((t) => [tileKey(t.x, t.z), t])));
    }
    // Map memory: only worth spinning up when nothing else covers the world
    // beyond the streaming ring (a baked lowres pyramid does that better).
    this.renderer = renderer ?? null;
    const res = mapMemory ?? 64;
    if (renderer && res > 0 && !options.manifest.lowres) {
      this.impostors = new ImpostorLayer(renderer, options.scene, options.material, this.tileBlocks, res, this.readySurface);
      this.applyHazeFloor();
    }
  }

  /** Surface map of a fully-streamed resident hires tile (the impostor layer
   *  stitches remembered rims onto live terrain with it). */
  private readonly readySurface = (key: string): SurfaceMap | undefined => {
    const rec = this.records.get(key);
    return rec?.level === 0 && rec.state === 'ready' ? rec.surface : undefined;
  };

  /** The radius hires tiles are actually resident to: the view distance,
   *  capped by whichever budget ran out first — the tile-count disc, or the
   *  byte budget's cut in the last admission plan. The viewer sizes fog and
   *  zoom off this so the frontier always reads as haze, never a cliff. */
  get admittedRadius(): number {
    const countRadius = this.tileBlocks * Math.sqrt(this.opts.maxTiles / Math.PI);
    const planRadius = this.planCutoffSq === null ? Infinity : Math.sqrt(this.planCutoffSq);
    return Math.min(this.opts.viewDistance, countRadius, planRadius);
  }

  /** Keep the impostor haze floor tracking the guaranteed-hires radius. */
  private applyHazeFloor(): void {
    this.impostors?.setHazeFloor(this.admittedRadius);
  }

  /** Tile span in blocks at a pyramid level (0 = hires). */
  private levelBlocks(level: number): number {
    if (level === 0) return this.tileBlocks;
    return this.lowLevels.find((l) => l.level === level)?.tileBlocks ?? this.tileBlocks * 2 ** level;
  }

  /** Squared distance from the focus to a tile centre. The re-plan compares
   *  and sorts distances over every manifest tile (potentially 10⁵ on a big
   *  world), so it stays in squared space — one sqrt per tile is the single
   *  hottest thing the planner does. */
  private distSqTo(t: ManifestTile, level: number, x: number, z: number): number {
    const tb = this.levelBlocks(level);
    const dx = (t.x + 0.5) * tb - x;
    const dz = (t.z + 0.5) * tb - z;
    return dx * dx + dz * dz;
  }

  /**
   * Re-plan streaming around the focus point (the controls' pivot / the fly
   * camera). Call every frame — it no-ops until the focus has moved a quarter
   * tile, so the cost is a cheap distance check.
   */
  update(focusX: number, focusZ: number): void {
    if (this.disposed) return;
    this.focusX = focusX;
    this.focusZ = focusZ;
    this.flushOne();
    this.retrySweep();
    // Drain one pending map-memory snapshot per frame (bounded GPU work).
    if (this.impostors?.update(focusX, focusZ)) {
      this.coverageDirty = true;
      this.invalidate();
      this.emitter.emit('change', this.stats);
    }
    // Retire finished fades: the tile is now fully opaque, so the lowres
    // underlay below it can finally be hidden (coverage re-runs).
    if (this.fadingKeys.size > 0) {
      const now = performance.now();
      for (const key of this.fadingKeys) {
        const rec = this.records.get(key);
        if (!rec || rec.fadeStart === undefined || now - rec.fadeStart >= TileManager.FADE_MS) {
          this.fadingKeys.delete(key);
          this.coverageDirty = true;
        }
      }
    }
    if (this.coverageDirty) this.applyCoverage();
    // Re-plan only when the focus has moved a quarter tile; otherwise just keep
    // the fetch pipeline full. (The first call always plans: lastFocus = ∞.)
    const priorX = this.lastFocusX;
    const priorZ = this.lastFocusZ;
    const moved = Math.hypot(focusX - priorX, focusZ - priorZ);
    if (moved < this.tileBlocks / 4) {
      this.pump();
      return;
    }
    const finitePrior = Number.isFinite(priorX) && Number.isFinite(priorZ);
    const dx = finitePrior ? focusX - priorX : 0;
    const dz = finitePrior ? focusZ - priorZ : 0;
    const travel = Math.hypot(dx, dz);
    const lookahead = travel > 0 ? Math.min(2, (this.tileBlocks * 2) / travel) : 0;
    const predictedX = focusX + dx * lookahead;
    const predictedZ = focusZ + dz * lookahead;
    this.lastFocusX = focusX;
    this.lastFocusZ = focusZ;

    const { viewDistance, maxTiles, maxBytes } = this.opts;

    // Hires: sparse regular-grid lookup makes planning O(visible tiles), then a
    // weighted admission pass respects both count and actual geometry budgets.
    // The lowres records and the map-memory atlas spend the same budget the
    // stats report, so admission can't overshoot maxBytes by their cost.
    let lowBytes = this.impostors?.gpuBytes ?? 0;
    for (const rec of this.records.values()) if (rec.level > 0) lowBytes += rec.memoryBytes;
    const hiresBytes = Math.max(1, maxBytes - lowBytes);
    const plan = admitTiles(
      nearbyTiles(this.index, this.tileBlocks, focusX, focusZ, viewDistance, predictedX, predictedZ),
      maxTiles,
      hiresBytes,
      (t) => this.sizeHints.get(tileKey(t.x, t.z)) ?? Math.max(this.averageHiresBytes, t.bytes * 20),
    );
    this.planCutoffSq = plan.cutoffSq;
    this.lastPlanMs = performance.now();
    this.applyHazeFloor(); // the honest hires frontier may have moved
    const desired = plan.admitted.map((candidate) => ({ t: candidate.ref, d: candidate.distanceSq }));
    const desiredKeys = new Set(desired.map(({ t }) => recKey(0, t.x, t.z)));

    // Lowres rings: level 1 underlays the whole hires disc out to 2× the view
    // distance (it doubles as the loading placeholder), each further level
    // takes the annulus out to twice the previous ring, and the coarsest level
    // is a blanket — always fully resident, so the whole world is visible from
    // any zoom the moment it loads (a few tiny tiles).
    const lowDesired: { ref: ManifestTile; level: number; d: number }[] = [];
    for (let i = 0; i < this.lowLevels.length; i++) {
      const lvl = this.lowLevels[i]!;
      const top = i === this.lowLevels.length - 1;
      const outerDistance = viewDistance * 2 ** lvl.level;
      const outer = top ? Infinity : outerDistance ** 2;
      const inner = top || i === 0 ? 0 : (viewDistance * 2 ** (lvl.level - 1) * 0.85) ** 2;
      const candidates = top
        ? lvl.tiles.map((ref) => ({ ref, distanceSq: this.distSqTo(ref, lvl.level, focusX, focusZ), priority: 0 }))
        : nearbyTiles(this.lowIndex.get(lvl.level)!, lvl.tileBlocks, focusX, focusZ, outerDistance, predictedX, predictedZ);
      const ring: { ref: ManifestTile; level: number; d: number }[] = candidates
        .filter((candidate) => candidate.distanceSq <= outer && candidate.distanceSq >= inner)
        .map((candidate) => ({ ref: candidate.ref, level: lvl.level, d: candidate.distanceSq }));
      ring.sort((a, b) => a.d - b.d);
      if (ring.length > 160) ring.length = 160; // per-level cap for huge worlds
      for (const r of ring) {
        lowDesired.push(r);
        desiredKeys.add(recKey(r.level, r.ref.x, r.ref.z));
      }
    }

    // Hires obey a real hard cap: stale fetches/builds are canceled immediately
    // and old resident tiles cannot accumulate inside a hysteresis halo. Lowres
    // stays hysteretic because its records are tiny and hide refinement gaps.
    for (const [key, rec] of this.records) {
      if (desiredKeys.has(key)) continue;
      if (rec.level === 0) {
        // Hysteresis for READY tiles just outside the plan: the admission
        // frontier breathes as byte estimates are learned and the camera
        // moves, and unloading on every breath re-fetches the same ring
        // tiles over and over — the boundary-flicker machine. They stay
        // until clearly behind the frontier; real memory pressure still
        // reclaims farthest-first via trimToMemoryBudget. Unfinished work
        // (loading/built/failed) outside the plan is still cancelled now.
        if (rec.state === 'ready') {
          const keep = this.admittedRadius * 1.15 + this.tileBlocks * 0.5;
          if (this.distSqTo(rec.ref, 0, focusX, focusZ) <= keep * keep) continue;
        }
        this.unload(key, rec);
        continue;
      }
      const top = this.lowLevels.length > 0 && rec.level === this.lowLevels[this.lowLevels.length - 1]!.level;
      if (top) continue; // the blanket never unloads
      const d = this.distSqTo(rec.ref, rec.level, focusX, focusZ);
      const keep = viewDistance * 2 ** rec.level * 1.25;
      if (d > keep * keep) this.unload(key, rec);
    }

    // Queue what's missing: the coarsest blanket first (whole-world coverage
    // for pennies), then hires nearest-first, then the finer lowres rings.
    const missing = (level: number, refs: { ref: ManifestTile }[]) =>
      refs.filter(({ ref }) => !this.records.has(recKey(level, ref.x, ref.z)));
    const topLevel = this.lowLevels.length > 0 ? this.lowLevels[this.lowLevels.length - 1]!.level : -1;
    this.queue = [
      ...missing(topLevel, lowDesired.filter((r) => r.level === topLevel)).map((r) => ({ ref: r.ref, level: topLevel })),
      ...missing(0, desired.map((e) => ({ ref: e.t }))).map((r) => ({ ref: r.ref, level: 0 })),
      ...lowDesired
        .filter((r) => r.level !== topLevel && !this.records.has(recKey(r.level, r.ref.x, r.ref.z)))
        .sort((a, b) => a.level - b.level || a.d - b.d)
        .map((r) => ({ ref: r.ref, level: r.level })),
    ].reverse(); // pump pops the highest-priority item in O(1)
    this.pump();
  }

  private pump(): void {
    // Backpressure crosses fetch → decode → GPU upload, but as two SEPARATE
    // budgets: fetches run at full concurrency (an on-demand server bakes one
    // tile per in-flight request — an idle fetch slot is an idle server core),
    // while decoded-but-not-yet-inserted builds are bounded on their own so
    // fast I/O still can't pin the whole desired ring's typed arrays waiting
    // on the staggered per-frame GPU uploads.
    const maxPendingBuilt = Math.max(8, this.opts.concurrency * 2);
    while (this.inFlight < this.opts.concurrency && this.pendingBuilt < maxPendingBuilt && this.queue.length > 0) {
      const { ref, level } = this.queue.pop()!;
      // A continuous manifest can replace/remove a tile while an older plan is
      // still queued. Never start that stale request after reconciliation.
      if (level === 0 && this.index.get(tileKey(ref.x, ref.z)) !== ref) continue;
      if (level === 0) void this.loadTile(ref);
      else void this.loadLowres(ref, level);
    }
  }

  /** Whether anything already draws terrain under hires tile (x,z) — a
   *  remembered/queued impostor, or a resident lowres ring covering it. */
  private hasUnderlay(x: number, z: number): boolean {
    if (this.impostors?.has(tileKey(x, z))) return true;
    for (const lvl of this.lowLevels) {
      const f = 2 ** lvl.level;
      const rec = this.records.get(recKey(lvl.level, Math.floor(x / f), Math.floor(z / f)));
      if (rec?.state === 'ready') return true;
    }
    return false;
  }

  /** Insert built tiles into the scene at a bounded per-frame rate (via
   *  update()), so GPU buffer uploads are spread across frames instead of
   *  bursting. Normally one per frame; when a backlog builds (a big preset
   *  loading hundreds of tiles) it drains faster so the map sharpens in a
   *  couple of seconds instead of many. */
  private flushOne(): void {
    let budget = this.pendingAdd.length > 24 ? 3 : this.pendingAdd.length > 8 ? 2 : 1;
    while (this.pendingAdd.length > 0 && budget > 0) {
      const key = this.pendingAdd.shift()!;
      const rec = this.records.get(key);
      if (!rec || rec.state !== 'built') continue; // unloaded while queued
      rec.state = 'ready';
      this.pendingBuilt--;
      // Dissolve in rather than pop — but ONLY over an underlay (a lowres
      // ring, a remembered impostor, or a still-pinned outgoing capture).
      // The fade starts fully transparent, so over nothing it spends FADE_MS
      // showing the background through the dither: the "white square slowly
      // filling in" read at a pan's leading edge. With no underlay the tile
      // appears at full opacity immediately; with one, the hires lighting
      // eases in over the flat-lit stand-in — the "lighting pop-in" fix.
      if (rec.level !== 0 || this.hasUnderlay(rec.ref.x, rec.ref.z)) {
        rec.fadeStart = performance.now();
        this.fadingKeys.add(key);
      }
      this.opts.scene.add(rec.terrain!);
      if (rec.terrainLm) this.opts.scene.add(rec.terrainLm);
      if (rec.water) this.opts.scene.add(rec.water);
      // Remembered rims meet the live disc: snap adjacent impostor edges onto
      // this tile's real surface heights so the fidelity boundary doesn't step.
      if (rec.level === 0) this.impostors?.onHiresReady(rec.ref.x, rec.ref.z, rec.surface);
      this.coverageDirty = true;
      this.invalidate();
      this.emitter.emit('change', this.stats);
      budget--;
    }
    this.pump();
  }

  /** Stream-in fade length. Long enough to read as a dissolve, short enough
   *  that a fast pan still feels instant. */
  static readonly FADE_MS = 280;

  /** Whether any tile is mid stream-in fade — the viewer keeps drawing while
   *  true so the dissolve actually animates under render-on-demand. */
  get fading(): boolean {
    return this.fadingKeys.size > 0;
  }

  /** Chain a per-draw uFade write onto each mesh's onBeforeRender (after the
   *  dequantize-uniform hook terrain.ts installs). Every TileManager mesh gets
   *  one — the materials are shared, so each draw must set its own fade. */
  private attachFade(rec: Record_, ...meshes: (THREE.Mesh | undefined)[]): void {
    for (const mesh of meshes) {
      if (!mesh) continue;
      const orig = mesh.onBeforeRender;
      mesh.onBeforeRender = (renderer, scene, camera, geometry, material, group) => {
        orig.call(mesh, renderer, scene, camera, geometry, material, group);
        const u = (material as THREE.ShaderMaterial).uniforms?.['uFade'];
        if (u) u.value = rec.fadeStart === undefined ? 1 : Math.min(1, (performance.now() - rec.fadeStart) / TileManager.FADE_MS);
      };
    }
  }

  /**
   * Hide every lowres tile whose footprint is fully SHOWN by finer data.
   * "Shown" is transitive, computed bottom-up: a hires tile shows its area by
   * being resident; a lowres tile's area is shown if the tile is resident OR
   * all of its existing children's areas are shown (so a coarse blanket tile
   * hides when hires covers it even if the middle rings were never fetched).
   *
   * This is what keeps the underlay honest: a smooth interpolated heightfield
   * coexisting with real voxel terrain leaks through everything hires
   * deliberately opens — cave-culled pockets, ravines, underwater cliffs,
   * gaps in tree canopies. Where finer data is on screen, the underlay is
   * simply switched off; it reappears the moment coverage breaks (unload,
   * ring edge, loading).
   */
  private applyCoverage(): void {
    this.coverageDirty = false;
    // Areas shown at the finer level, seeded with resident hires tiles. A tile
    // still fading in does NOT cover yet — its placeholder must keep showing
    // through the dissolve.
    let shown = new Set<string>();
    for (const [key, rec] of this.records) {
      if (rec.level === 0 && rec.state === 'ready' && !this.fadingKeys.has(key)) shown.add(tileKey(rec.ref.x, rec.ref.z));
    }
    // Map-memory impostors hide under exactly the hires tiles that cover them
    // (and pop back the moment one unloads).
    this.impostors?.applyCoverage(shown);
    let finerIndex: { has(key: string): boolean } = this.index;
    for (const lvl of this.lowLevels) {
      const shownHere = new Set<string>();
      for (const t of lvl.tiles) {
        let covered = true;
        for (let dz = 0; dz < 2 && covered; dz++) {
          for (let dx = 0; dx < 2 && covered; dx++) {
            const childKey = tileKey(t.x * 2 + dx, t.z * 2 + dz);
            // A child absent from the manifest is empty terrain — nothing to
            // cover there.
            if (finerIndex.has(childKey) && !shown.has(childKey)) covered = false;
          }
        }
        const rec = this.records.get(recKey(lvl.level, t.x, t.z));
        const ready = rec?.state === 'ready';
        if (ready && rec!.terrain) rec!.terrain.visible = !covered;
        if (ready || covered) shownHere.add(tileKey(t.x, t.z));
      }
      shown = shownHere;
      finerIndex = this.lowIndex.get(lvl.level) ?? new Set<string>();
    }
  }

  /** Ingest tiles a progressive render has newly published. Unknown tiles join
   *  the streaming index and force a re-plan so they stream in on the next
   *  update(); already-known tiles are ignored. Returns whether anything was
   *  added. */
  addTiles(tiles: ManifestTile[]): boolean {
    return this.reconcileTiles(tiles, false);
  }

  /** Reconcile the complete hires index from a continuous server manifest.
   *  Revision changes evict only affected resident tiles; removed coordinates
   *  disappear. Unchanged terrain remains on the GPU without a network fetch. */
  syncTiles(tiles: ManifestTile[]): boolean {
    return this.reconcileTiles(tiles, true);
  }

  private reconcileTiles(tiles: ManifestTile[], prune: boolean): boolean {
    let changed = false;
    const incoming = prune ? new Set(tiles.map((tile) => tileKey(tile.x, tile.z))) : null;
    if (incoming) {
      for (const [key] of this.index) {
        if (incoming.has(key)) continue;
        this.index.delete(key);
        const rec = this.records.get(key);
        if (rec) this.unload(key, rec);
        // Gone from the manifest = gone from the world; forget the snapshot
        // and the cached payload too.
        this.impostors?.remove(key);
        this.byteCache.drop(key);
        changed = true;
      }
    }
    for (const t of tiles) {
      const k = tileKey(t.x, t.z);
      const previous = this.index.get(k);
      if (!previous) {
        this.index.set(k, t);
        changed = true;
      } else if (t.revision !== previous.revision) {
        this.index.set(k, t);
        const rec = this.records.get(k);
        if (rec) this.unload(k, rec);
        this.byteCache.drop(k); // the cached payload is for the old revision
        changed = true;
      } else {
        // Same source generation: refresh size/path metadata in place so
        // queued references remain current and live-bake byte estimates can
        // advance from zero without evicting resident geometry.
        previous.path = t.path;
        previous.bytes = t.bytes;
      }
    }
    if (changed) {
      this.lastFocusX = Infinity; // re-plan around the (unchanged) focus next update
      this.lastFocusZ = Infinity;
      this.invalidate();
      this.emitter.emit('change', this.stats); // the tile set moved — refresh the readout
    }
    return changed;
  }

  /** Install the lowres pyramid once a progressive render finishes (its earlier
   *  manifests carried no lowres). No-op without a lowres material, or if a
   *  pyramid is already present. Forces a re-plan so the coarse rings stream in. */
  ingestLowres(lowres: { grid: number; levels: LowresLevel[] }): void {
    if (!this.lowresMaterial || this.lowLevels.length > 0) return;
    const levels = [...lowres.levels].sort((a, b) => a.level - b.level);
    this.lowLevels.push(...levels);
    for (const lvl of levels) this.lowIndex.set(lvl.level, new Map(lvl.tiles.map((t) => [tileKey(t.x, t.z), t])));
    // The baked pyramid covers the whole world at real fidelity — retire the
    // provisional map memory in its favour.
    this.impostors?.dispose();
    this.impostors = null;
    this.lastFocusX = Infinity;
    this.lastFocusZ = Infinity;
    this.coverageDirty = true;
    this.invalidate();
  }

  /** Show or hide every resident tile's cave-dark geometry (VTLA tiles order
   *  it as a contiguous tail per mesh, so hiding is a shorter draw range —
   *  same draw calls, fewer vertices shaded). Tiles built while hidden come up
   *  hidden. Tiles without a cave tail (older formats, all-surface tiles) are
   *  untouched. Returns whether anything changed (the caller redraws). */
  setCaveGeometry(visible: boolean): boolean {
    if (this.caveGeometry === visible) return false;
    this.caveGeometry = visible;
    for (const rec of this.records.values()) {
      if (rec.level !== 0) continue; // lowres heightfields carry no caves
      applyCaveRange(rec.terrain, visible);
      applyCaveRange(rec.terrainLm, visible);
      applyCaveRange(rec.water, visible);
    }
    return true;
  }

  /** Live-tune streaming (view distance, tile budget, fetch concurrency,
   *  map-memory resolution). Takes effect on the next update(): the plan is
   *  recomputed from scratch. Changing `mapMemory` rebuilds the impostor
   *  atlas, which forgets remembered terrain (it re-accumulates as you pan). */
  configure(settings: { viewDistance?: number; maxTiles?: number; concurrency?: number; maxBytes?: number; tileCacheBytes?: number; mapMemory?: number }): void {
    if (settings.viewDistance !== undefined) this.opts.viewDistance = settings.viewDistance;
    if (settings.maxTiles !== undefined) this.opts.maxTiles = settings.maxTiles;
    if (settings.concurrency !== undefined) this.opts.concurrency = settings.concurrency;
    if (settings.maxBytes !== undefined) this.opts.maxBytes = settings.maxBytes;
    if (settings.tileCacheBytes !== undefined) {
      this.opts.tileCacheBytes = settings.tileCacheBytes;
      this.byteCache.setBudget(settings.tileCacheBytes);
    }
    if (settings.mapMemory !== undefined && settings.mapMemory !== this.mapMemoryResolution) {
      this.impostors?.dispose();
      this.impostors = null;
      if (this.renderer && settings.mapMemory > 0 && this.lowLevels.length === 0) {
        this.impostors = new ImpostorLayer(this.renderer, this.opts.scene, this.opts.material, this.tileBlocks, settings.mapMemory, this.readySurface);
      }
      this.invalidate();
    }
    this.applyHazeFloor(); // the guaranteed-hires disc moved with the budgets
    this.lastFocusX = Infinity; // force a re-plan on the next update()
    this.lastFocusZ = Infinity;
  }

  /** The active map-memory impostor resolution (0 = off/unavailable). */
  get mapMemoryResolution(): number {
    return this.impostors?.resolutionPx ?? 0;
  }

  /** How far remembered (impostor) terrain reaches from (x,z), in blocks —
   *  0 without map memory. The viewer sizes zoom range and fog off this so
   *  the remembered map is actually visible. */
  mapMemoryExtent(x: number, z: number): number {
    return this.impostors?.extentFrom(x, z) ?? 0;
  }

  /** The current stream-in radius, in blocks. */
  get viewDistance(): number {
    return this.opts.viewDistance;
  }

  /** The current resident-tile budget. */
  get maxTiles(): number {
    return this.opts.maxTiles;
  }

  /** The current estimated CPU+GPU residency budget. */
  get maxBytes(): number {
    return this.opts.maxBytes;
  }

  /** Fetch + decode one lowres LOD tile into a heightfield mesh. */
  private async loadLowres(ref: ManifestTile, level: number): Promise<void> {
    const key = recKey(level, ref.x, ref.z);
    if (this.records.has(key) || !this.lowresMaterial) return;
    const abort = new AbortController();
    const rec: Record_ = { ref, level, state: 'loading', abort, vertexCount: 0, triangleCount: 0, memoryBytes: 0 };
    this.records.set(key, rec);
    this.inFlight++;
    try {
      const tile = parseLowresTile(await maybeInflate(await this.opts.fetch(ref.path, abort.signal)));
      if (this.disposed || rec.state !== 'loading') return; // unloaded mid-fetch
      const mesh = buildLowresMesh(tile, this.lowresMaterial);
      if (!mesh) {
        rec.state = 'empty'; // all-empty tile: nothing to draw, never retry
        return;
      }
      // Coarser rings draw first (less overdraw); the dip in buildLowresMesh
      // keeps finer data winning the depth test wherever both are resident.
      mesh.renderOrder = -level;
      releaseAfterUpload(mesh.geometry);
      rec.terrain = mesh;
      this.attachFade(rec, mesh);
      // Keep the (36 KB) heightfield for the zoomed-out pivot-height fallback —
      // copied so it doesn't pin the decoded buffer.
      rec.low = {
        originX: tile.originX,
        originZ: tile.originZ,
        span: tile.span,
        width: tile.width,
        depth: tile.depth,
        heights: tile.heights.slice(),
      };
      rec.vertexCount = tile.width * tile.depth;
      rec.triangleCount = mesh.geometry.index!.count / 3;
      rec.memoryBytes = geometryBytes(mesh.geometry) + rec.low.heights.byteLength;
      rec.state = 'built';
      this.pendingBuilt++;
      this.failCounts.delete(key);
      this.pendingAdd.push(key);
      this.invalidate();
      this.emitter.emit('change', this.stats);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        this.markFailed(key, rec);
        console.warn(`vantage: lowres tile ${key} failed to load:`, e);
      }
    } finally {
      this.inFlight--;
      this.pump();
    }
  }

  /** A transient failure (network blip, 5xx) retries with exponential backoff
   *  while the tile stays in view — otherwise one blip is a permanent hole in
   *  the map until the user pans away and back. Capped so a genuinely bad tile
   *  (corrupt file, future format) settles instead of hammering the server.
   *  Attempt counts live outside the record because a retry deletes it. */
  private markFailed(key: string, rec: Record_): void {
    rec.state = 'failed';
    const attempts = (this.failCounts.get(key) ?? 0) + 1;
    this.failCounts.set(key, attempts);
    rec.retryAt = attempts >= 5 ? Infinity : performance.now() + 2000 * 2 ** (attempts - 1);
  }

  /** Re-queue failed records whose backoff has expired (cheap; throttled). */
  private retrySweep(): void {
    const now = performance.now();
    if (now < this.nextRetrySweep) return;
    this.nextRetrySweep = now + 500;
    for (const [key, rec] of this.records) {
      if (rec.state !== 'failed' || now < (rec.retryAt ?? Infinity)) continue;
      this.records.delete(key);
      this.queue.push({ ref: rec.ref, level: rec.level });
    }
  }

  private async loadTile(ref: ManifestTile): Promise<void> {
    const key = tileKey(ref.x, ref.z);
    if (this.records.has(key)) return;
    const abort = new AbortController();
    const rec: Record_ = { ref, level: 0, state: 'loading', abort, vertexCount: 0, triangleCount: 0, memoryBytes: 0 };
    this.records.set(key, rec);
    this.inFlight++;
    try {
      // Byte cache first: a tile that streamed out keeps its compressed
      // payload (per revision), so streaming back in skips the network — and
      // on an on-demand server, skips a whole tile re-bake.
      const cached = this.byteCache.get(key, ref.revision);
      const raw = cached ?? (await this.opts.fetch(ref.path, abort.signal));
      if (this.disposed || rec.state !== 'loading') return; // unloaded mid-fetch
      if (!cached) this.byteCache.put(key, raw, ref.revision);
      const buffer = await maybeInflate(raw);
      if (this.disposed || rec.state !== 'loading') return; // unloaded mid-inflate
      // A live server lists every populated tile up front, but some mesh to
      // nothing (all air / cave-culled / ungenerated) and come back empty. Mark
      // them empty — no geometry, never retry — instead of choking on a 0-byte
      // parse. (A batch render just omits such tiles from the manifest.)
      if (buffer.byteLength === 0) {
        rec.state = 'empty';
        return;
      }

      // VTL6 fast path: keep the on-disk quantized encoding as zero-copy views
      // and let the shared QUANTIZED shader dequantize — no per-vertex CPU work
      // at all, so decoding never causes a frame hitch. Older tile versions
      // take the classic expand-on-CPU path.
      let meshes: TileMeshes;
      const q = parseTileQuantized(buffer);
      if (q) {
        // Live render: this tile can reference atlas layers baked after our last
        // atlas fetch. Widen the atlas before building it, so its textures are
        // never sampled out of range. (No-op once the atlas covers them.)
        if (this.ensureAtlas) {
          let need = 0;
          for (const arr of [q.solid.layer, q.fluid.layer]) {
            for (let i = 0; i < arr.length; i++) if (arr[i]! >= need) need = arr[i]! + 1;
          }
          if (need > this.atlasLayers) {
            this.atlasLayers = await this.ensureAtlas(need);
            if (this.disposed || rec.state !== 'loading') return; // unloaded during the atlas fetch
          }
        }
        rec.biomes = summarizeSurfaceBiomes(q.surface, q.biomeNames, this.opts.palette);
        rec.surface = { ...q.surface, biome: q.surface.biome.slice(), height: q.surface.height.slice() };
        meshes = buildQuantizedTileMeshes(q, this.opts.material, this.opts.waterMaterial, this.lmMaterial ?? undefined);
        rec.vertexCount = q.solid.vertexCount + q.fluid.vertexCount;
        rec.triangleCount = (q.solid.indexCount + q.fluid.indexCount) / 3;
      } else {
        const tile = parseTile(buffer);
        rec.biomes = summarizeBiomes(tile, this.opts.palette);
        // Copy the (small) surface arrays out of the decoded buffer — as
        // zero-copy views they would pin the tile's entire multi-MB ArrayBuffer
        // in the JS heap for as long as the tile is resident.
        rec.surface = tile.surface
          ? { ...tile.surface, biome: tile.surface.biome.slice(), height: tile.surface.height.slice() }
          : undefined;
        meshes = buildTileMeshes(tile, this.opts.palette, this.opts.material, this.opts.waterMaterial);
        meshes.terrain.geometry.computeBoundingSphere();
        meshes.water?.geometry.computeBoundingSphere();
        rec.vertexCount = tile.vertexCount + (tile.fluid?.vertexCount ?? 0);
        rec.triangleCount = (tile.indexCount + (tile.fluid?.indexCount ?? 0)) / 3;
      }
      releaseAfterUpload(meshes.terrain.geometry);
      if (meshes.terrainLm) releaseAfterUpload(meshes.terrainLm.geometry);
      if (meshes.water) releaseAfterUpload(meshes.water.geometry);
      // Tiles built while cave geometry is hidden enter the scene hidden —
      // the draw range must be surface-only BEFORE the first draw.
      if (!this.caveGeometry) {
        applyCaveRange(meshes.terrain, false);
        applyCaveRange(meshes.terrainLm, false);
        applyCaveRange(meshes.water, false);
      }
      rec.terrain = meshes.terrain;
      rec.terrainLm = meshes.terrainLm;
      rec.lightmapTex = meshes.lightmapTex;
      rec.water = meshes.water;
      this.attachFade(rec, meshes.terrain, meshes.terrainLm, meshes.water);
      this.minY = Math.min(this.minY, meshes.bounds.min.y);
      this.maxY = Math.max(this.maxY, meshes.bounds.max.y);
      rec.memoryBytes =
        geometryBytes(meshes.terrain.geometry) +
        (meshes.terrainLm ? geometryBytes(meshes.terrainLm.geometry) : 0) +
        (meshes.water ? geometryBytes(meshes.water.geometry) : 0) +
        textureBytes(meshes.lightmapTex) +
        (rec.surface ? rec.surface.biome.byteLength + rec.surface.height.byteLength : 0);
      this.sizeHints.set(key, rec.memoryBytes);
      this.averageHiresBytes = this.averageHiresBytes * 0.875 + rec.memoryBytes * 0.125;
      // A budget-cut plan re-runs as real sizes are learned: decoded tiles
      // usually cost less than the conservative estimate, so the next plan
      // often affords more of the disc. Throttled — replanning after every
      // load makes the frontier breathe tile-by-tile, and each breath churns
      // the boundary ring.
      if (this.planCutoffSq !== null && performance.now() - this.lastPlanMs > 250) {
        this.lastFocusX = Infinity;
        this.lastFocusZ = Infinity;
      }
      // Don't insert into the scene here: adds are staggered one per frame so
      // several tiles finishing together can't stack their GPU uploads into a
      // single frame. update() flushes the queue.
      rec.state = 'built';
      this.pendingBuilt++;
      this.failCounts.delete(key);
      this.pendingAdd.push(key);
      this.trimToMemoryBudget();
      this.invalidate();
      this.emitter.emit('change', this.stats);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        // A failed parse must not be retried out of the byte cache — drop the
        // payload so the retry path goes back to the network for fresh bytes.
        this.byteCache.drop(key);
        this.markFailed(key, rec);
        console.warn(`vantage: tile ${key} failed to load:`, e);
      }
    } finally {
      this.inFlight--;
      this.pump();
    }
  }

  private unload(key: string, rec: Record_): void {
    const priorState = rec.state;
    // Async atlas/fetch continuations use this state check as their disposal
    // fence. Abort alone cannot stop a promise that is already resolving.
    rec.state = 'empty';
    rec.abort?.abort();
    if (priorState === 'built') this.pendingBuilt--;
    // Map memory: a fully-streamed hires tile leaving the ring hands its
    // meshes to the impostor layer (which renders one snapshot, then disposes
    // them) instead of vanishing. Remembered meshes STAY IN THE SCENE until
    // that snapshot lands — removing them here would open a background-
    // colored hole for every frame the capture queue hasn't drained yet, the
    // white-square wake a fast pan used to leave behind. Anything not worth
    // remembering — partial loads, lowres records — is disposed as before.
    const remember = this.impostors !== null && rec.level === 0 && priorState === 'ready' && rec.terrain !== undefined && rec.surface !== undefined;
    for (const mesh of [rec.terrain, rec.terrainLm, rec.water]) {
      if (!mesh) continue;
      if (remember) continue; // scene membership + disposal move to the impostor layer below
      this.opts.scene.remove(mesh);
      // Detach the shared quad index first: dispose() deletes the GPU buffers
      // of everything still attached, and the index is shared by every tile.
      if (isSharedQuadIndex(mesh.geometry.index)) mesh.geometry.setIndex(null);
      mesh.geometry.dispose();
    }
    if (remember) {
      rec.fadeStart = undefined; // capture at full opacity (uFade reads this)
      this.impostors!.capture(
        rec.ref.x,
        rec.ref.z,
        { terrain: rec.terrain, terrainLm: rec.terrainLm, water: rec.water, lightmapTex: rec.lightmapTex },
        rec.surface!,
        this.minY,
        this.maxY,
      );
    } else {
      rec.lightmapTex?.dispose();
    }
    this.records.delete(key);
    this.failCounts.delete(key);
    this.fadingKeys.delete(key);
    this.coverageDirty = true; // an uncovered lowres parent may need to reappear
    this.invalidate();
    this.emitter.emit('change', this.stats);
  }

  /** Correct estimation misses after a tile is decoded. Farthest hires records
   *  leave first; one nearest tile is always kept so an oversized outlier does
   *  not create an unload/refetch loop. Learned weights make the next plan fit. */
  private trimToMemoryBudget(): void {
    // The map-memory atlas is a fixed allocation inside the same budget the
    // stats report — tiles trim around it, keeping enforcement consistent.
    let total = this.impostors?.gpuBytes ?? 0;
    const hires: { key: string; rec: Record_; d: number }[] = [];
    for (const [key, rec] of this.records) {
      total += rec.memoryBytes;
      if (rec.level === 0 && rec.state !== 'failed' && rec.state !== 'empty') {
        hires.push({ key, rec, d: this.distSqTo(rec.ref, 0, this.focusX, this.focusZ) });
      }
    }
    // The unload hysteresis lets ready tiles linger past the plan frontier;
    // this is where their count is truly bounded (bytes AND a capped tile-
    // count overshoot), farthest first.
    const maxResident = Math.ceil(this.opts.maxTiles * 1.25);
    if ((total <= this.opts.maxBytes && hires.length <= maxResident) || hires.length <= 1) return;
    hires.sort((a, b) => b.d - a.d);
    let remaining = hires.length;
    for (const entry of hires) {
      if ((total <= this.opts.maxBytes && remaining <= maxResident) || remaining <= 1) break;
      total -= entry.rec.memoryBytes;
      remaining--;
      this.unload(entry.key, entry.rec);
    }
    // Re-admit with the newly learned byte weights on the next update.
    this.lastFocusX = Infinity;
    this.lastFocusZ = Infinity;
  }

  private invalidate(): void {
    this.biomesCache = null;
    this.statsCache = null;
  }

  // --- world-level queries ---------------------------------------------------

  /** Live totals across resident tiles. */
  get stats(): TileStats {
    if (this.statsCache) return this.statsCache;
    let loaded = 0;
    let loading = 0;
    let lowres = 0;
    let vertexCount = 0;
    let triangleCount = 0;
    let bytes = 0;
    let residentBytes = 0;
    for (const rec of this.records.values()) {
      residentBytes += rec.memoryBytes;
      if (rec.state === 'ready') {
        if (rec.level === 0) loaded++;
        else lowres++;
        vertexCount += rec.vertexCount;
        triangleCount += rec.triangleCount;
        bytes += rec.ref.bytes;
      } else if (rec.state === 'loading' || rec.state === 'built') loading++;
    }
    const remembered = this.impostors?.count ?? 0;
    if (this.impostors) residentBytes += this.impostors.gpuBytes;
    this.statsCache = { loaded, loading, total: this.index.size, lowres, remembered, vertexCount, triangleCount, bytes, residentBytes, cachedBytes: this.byteCache.size };
    return this.statsCache;
  }

  /** Aggregated biome share across every resident tile, most common first. */
  get biomes(): BiomeEntry[] {
    if (this.biomesCache) return this.biomesCache;
    const byId = new Map<number, BiomeEntry>();
    let total = 0;
    for (const rec of this.records.values()) {
      if (!rec.biomes) continue;
      for (const e of rec.biomes) {
        const agg = byId.get(e.id);
        if (agg) agg.count += e.count;
        else byId.set(e.id, { ...e });
        total += e.count;
      }
    }
    const out = [...byId.values()].sort((a, b) => b.count - a.count);
    const denom = total || 1;
    for (const e of out) e.fraction = e.count / denom;
    this.biomesCache = out;
    return out;
  }

  /** The surface map cell under world (x,z), from whichever tile owns it. */
  private surfaceAt(x: number, z: number): { surf: SurfaceMap; idx: number } | null {
    const rec = this.records.get(tileKey(Math.floor(x / this.tileBlocks), Math.floor(z / this.tileBlocks)));
    const surf = rec?.state === 'ready' ? rec.surface : undefined;
    if (!surf) return null;
    const cx = Math.floor(x - surf.originX);
    const cz = Math.floor(z - surf.originZ);
    if (cx < 0 || cz < 0 || cx >= surf.width || cz >= surf.depth) return null;
    return { surf, idx: cz * surf.width + cx };
  }

  /** Lightly smoothed terrain height at world (x,z) for the terrain-riding
   *  pivot; falls back to the lowres heightfields (finest resident level)
   *  beyond the hires ring, so the pivot still rides the terrain when zoomed
   *  out. Null when nothing at all is resident there. */
  heightAt = (x: number, z: number): number | null => {
    const R = 2; // 5×5 smoothing window, matching the single-tile sampler
    let sum = 0;
    let n = 0;
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const hit = this.surfaceAt(x + dx, z + dz);
        if (!hit) continue;
        const h = hit.surf.height[hit.idx]!;
        if (h < 1) continue; // empty-column sentinel (matches the single-tile sampler)
        sum += h;
        n++;
      }
    }
    if (n > 0) return sum / n;
    return this.lowresHeightAt(x, z) ?? this.impostors?.heightAt(x, z) ?? null;
  };

  /** Height from the finest resident lowres level covering (x,z), or null. */
  private lowresHeightAt(x: number, z: number): number | null {
    for (const lvl of this.lowLevels) {
      const tb = lvl.tileBlocks;
      const rec = this.records.get(recKey(lvl.level, Math.floor(x / tb), Math.floor(z / tb)));
      const low = rec?.state === 'ready' ? rec.low : undefined;
      if (!low) continue;
      const cx = Math.min(Math.max(Math.floor((x - low.originX) / low.span), 0), low.width - 1);
      const cz = Math.min(Math.max(Math.floor((z - low.originZ) / low.span), 0), low.depth - 1);
      const h = low.heights[cz * low.width + cx]!;
      if (h !== LOWRES_EMPTY) return h;
    }
    return null;
  }

  /** March the ray across resident tiles' surface maps; the biome id at the
   *  first column the ray drops below, or -1. O(ray length), tile-count-free. */
  pickBiome(ray: THREE.Ray): number {
    // Bring the start point down to the terrain's Y band before marching.
    let t = 0;
    if (ray.origin.y > this.maxY + 2 && ray.direction.y < 0) {
      t = (this.maxY + 2 - ray.origin.y) / ray.direction.y;
    }
    const span = this.opts.viewDistance * 2.5;
    for (; t <= span; t += 0.5) {
      const x = ray.origin.x + ray.direction.x * t;
      const y = ray.origin.y + ray.direction.y * t;
      const z = ray.origin.z + ray.direction.z * t;
      if (y < this.minY - 2 && ray.direction.y < 0) return -1; // under everything
      const hit = this.surfaceAt(x, z);
      if (!hit) continue;
      const h = hit.surf.height[hit.idx]!;
      if (h >= 1 && y <= h + 1) return hit.surf.biome[hit.idx]!;
    }
    return -1;
  }

  // --- events / lifecycle ----------------------------------------------------

  on<K extends keyof TileEvents>(event: K, listener: (payload: TileEvents[K]) => void): () => void {
    return this.emitter.on(event, listener);
  }

  /** Abort every fetch, remove and dispose every mesh. */
  dispose(): void {
    this.disposed = true;
    this.queue = [];
    this.pendingAdd = [];
    // Kill map memory FIRST so unload() disposes outgoing meshes directly
    // instead of queueing captures that would never drain.
    this.impostors?.dispose();
    this.impostors = null;
    for (const [key, rec] of [...this.records]) this.unload(key, rec);
    this.byteCache.clear();
    this.emitter.clear();
  }
}
