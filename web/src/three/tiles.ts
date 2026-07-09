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
  type WorldManifest,
} from '../core/index.js';
import { Emitter } from './emitter.js';
import { buildLowresMesh, buildQuantizedTileMeshes, buildTileMeshes, type TileMeshes } from './terrain.js';

export interface TileManagerOptions {
  manifest: WorldManifest;
  /** URL the manifest was fetched from — tile paths resolve relative to it. */
  baseUrl: string;
  scene: THREE.Scene;
  /** The shared terrain shader (from {@link createTerrainMaterial}). */
  material: THREE.ShaderMaterial;
  /** The shared water shader (from {@link createWaterMaterial}). */
  waterMaterial: THREE.ShaderMaterial;
  /** The shared lowres LOD shader (from {@link createLowresMaterial}); required
   *  to stream a format-2 manifest's lowres pyramid. */
  lowresMaterial?: THREE.ShaderMaterial;
  /** Biome palette indexed by the manifest's biome ids. */
  palette: Rgb[];
  /** Stream-in radius around the focus, in blocks. Default `768`. */
  viewDistance?: number;
  /** Hard cap on resident tiles (nearest win). Default `96`. */
  maxTiles?: number;
  /** Concurrent tile fetches. Default `4`. */
  concurrency?: number;
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
  vertexCount: number;
  triangleCount: number;
  /** Compressed bytes fetched and resident. */
  bytes: number;
}

interface TileEvents extends Record<string, unknown> {
  /** A tile finished loading or was unloaded; payload = live stats. */
  change: TileStats;
}

interface Record_ {
  ref: ManifestTile;
  /** Pyramid level: 0 = hires, ≥1 = lowres LOD ring. */
  level: number;
  /** `built` = decoded and meshed, queued for its staggered scene insertion. */
  state: 'loading' | 'built' | 'ready' | 'failed';
  abort?: AbortController;
  terrain?: THREE.Mesh;
  water?: THREE.Mesh;
  surface?: SurfaceMap;
  /** Lowres heightfield data, kept for the zoomed-out pivot height fallback. */
  low?: { originX: number; originZ: number; span: number; width: number; depth: number; heights: Int16Array };
  biomes?: BiomeEntry[];
  vertexCount: number;
  triangleCount: number;
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
  if (geom.index) geom.index.onUpload(release);
}

export class TileManager {
  private readonly opts: Required<Omit<TileManagerOptions, 'lowresMaterial'>>;
  private readonly lowresMaterial: THREE.ShaderMaterial | null;
  private readonly index = new Map<string, ManifestTile>();
  private readonly records = new Map<string, Record_>();
  private readonly emitter = new Emitter<TileEvents>();
  private readonly tileBlocks: number;
  /** Lowres pyramid levels, finest first ([] when the manifest has none). */
  private readonly lowLevels: LowresLevel[];

  private queue: { ref: ManifestTile; level: number }[] = [];
  /** Built tiles awaiting scene insertion — flushed ONE per update() call so
   *  multi-MB GPU uploads never pile into a single frame (the stutter fix). */
  private pendingAdd: string[] = [];
  private inFlight = 0;
  private lastFocusX = Infinity;
  private lastFocusZ = Infinity;
  private disposed = false;

  private biomesCache: BiomeEntry[] | null = null;
  private statsCache: TileStats | null = null;

  /** Y range of everything loaded so far, for ray-march bounds. */
  private minY = 0;
  private maxY = 320;

  constructor(options: TileManagerOptions) {
    const { lowresMaterial, ...rest } = options;
    this.opts = {
      viewDistance: 768,
      // Sized to fill the whole view-distance disc for 128-block tiles
      // (π·(768/128)² ≈ 113) with a little slack — and to match the settings
      // panel's "med" preset exactly.
      maxTiles: 120,
      concurrency: 4,
      ...rest,
    };
    this.lowresMaterial = lowresMaterial ?? null;
    this.tileBlocks = options.manifest.tileBlocks;
    for (const t of options.manifest.tiles) this.index.set(tileKey(t.x, t.z), t);
    this.lowLevels = this.lowresMaterial ? [...(options.manifest.lowres?.levels ?? [])].sort((a, b) => a.level - b.level) : [];
  }

  /** Tile span in blocks at a pyramid level (0 = hires). */
  private levelBlocks(level: number): number {
    if (level === 0) return this.tileBlocks;
    return this.lowLevels.find((l) => l.level === level)?.tileBlocks ?? this.tileBlocks * 2 ** level;
  }

  private distTo(t: ManifestTile, level: number, x: number, z: number): number {
    const tb = this.levelBlocks(level);
    return Math.hypot((t.x + 0.5) * tb - x, (t.z + 0.5) * tb - z);
  }

  /**
   * Re-plan streaming around the focus point (the controls' pivot / the fly
   * camera). Call every frame — it no-ops until the focus has moved a quarter
   * tile, so the cost is a cheap distance check.
   */
  update(focusX: number, focusZ: number): void {
    if (this.disposed) return;
    this.flushOne();
    // Re-plan only when the focus has moved a quarter tile; otherwise just keep
    // the fetch pipeline full. (The first call always plans: lastFocus = ∞.)
    const moved = Math.hypot(focusX - this.lastFocusX, focusZ - this.lastFocusZ);
    if (moved < this.tileBlocks / 4) {
      this.pump();
      return;
    }
    this.lastFocusX = focusX;
    this.lastFocusZ = focusZ;

    const { viewDistance, maxTiles } = this.opts;

    // Hires: the nearest maxTiles tiles within viewDistance of the focus.
    const desired: { t: ManifestTile; d: number }[] = [];
    for (const t of this.index.values()) {
      const d = this.distTo(t, 0, focusX, focusZ);
      if (d <= viewDistance) desired.push({ t, d });
    }
    desired.sort((a, b) => a.d - b.d);
    if (desired.length > maxTiles) desired.length = maxTiles;
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
      const outer = top ? Infinity : viewDistance * 2 ** lvl.level;
      const inner = top || i === 0 ? 0 : viewDistance * 2 ** (lvl.level - 1) * 0.85;
      const ring: { ref: ManifestTile; level: number; d: number }[] = [];
      for (const t of lvl.tiles) {
        const d = this.distTo(t, lvl.level, focusX, focusZ);
        if (d <= outer && d >= inner) ring.push({ ref: t, level: lvl.level, d });
      }
      ring.sort((a, b) => a.d - b.d);
      if (ring.length > 160) ring.length = 160; // per-level cap for huge worlds
      for (const r of ring) {
        lowDesired.push(r);
        desiredKeys.add(recKey(r.level, r.ref.x, r.ref.z));
      }
    }

    // Unload with hysteresis: resident tiles stay until they fall outside
    // 1.25× their ring (or the budget forces the farthest out). Everything not
    // desired and beyond its keep ring goes: in-flight fetches abort,
    // built-but-not-inserted tiles drop, failures forget (so they can retry).
    for (const [key, rec] of this.records) {
      if (desiredKeys.has(key)) continue;
      const top = this.lowLevels.length > 0 && rec.level === this.lowLevels[this.lowLevels.length - 1]!.level;
      if (top) continue; // the blanket never unloads
      const d = this.distTo(rec.ref, rec.level, focusX, focusZ);
      const keep = rec.level === 0 ? viewDistance * 1.25 : viewDistance * 2 ** rec.level * 1.25;
      if (d > keep) this.unload(key, rec);
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
    ];
    this.pump();
  }

  private pump(): void {
    while (this.inFlight < this.opts.concurrency && this.queue.length > 0) {
      const { ref, level } = this.queue.shift()!;
      if (level === 0) void this.loadTile(ref);
      else void this.loadLowres(ref, level);
    }
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
      this.opts.scene.add(rec.terrain!);
      if (rec.water) this.opts.scene.add(rec.water);
      this.invalidate();
      this.emitter.emit('change', this.stats);
      budget--;
    }
  }

  /** Live-tune streaming (view distance, tile budget, fetch concurrency).
   *  Takes effect on the next update(): the plan is recomputed from scratch. */
  configure(settings: { viewDistance?: number; maxTiles?: number; concurrency?: number }): void {
    if (settings.viewDistance !== undefined) this.opts.viewDistance = settings.viewDistance;
    if (settings.maxTiles !== undefined) this.opts.maxTiles = settings.maxTiles;
    if (settings.concurrency !== undefined) this.opts.concurrency = settings.concurrency;
    this.lastFocusX = Infinity; // force a re-plan on the next update()
    this.lastFocusZ = Infinity;
  }

  /** The current stream-in radius, in blocks. */
  get viewDistance(): number {
    return this.opts.viewDistance;
  }

  /** The current resident-tile budget. */
  get maxTiles(): number {
    return this.opts.maxTiles;
  }

  /** Fetch + decode one lowres LOD tile into a heightfield mesh. */
  private async loadLowres(ref: ManifestTile, level: number): Promise<void> {
    const key = recKey(level, ref.x, ref.z);
    if (this.records.has(key) || !this.lowresMaterial) return;
    const abort = new AbortController();
    const rec: Record_ = { ref, level, state: 'loading', abort, vertexCount: 0, triangleCount: 0 };
    this.records.set(key, rec);
    this.inFlight++;
    try {
      const url = new URL(ref.path, this.opts.baseUrl).toString();
      const res = await fetch(url, { signal: abort.signal });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
      const tile = parseLowresTile(await maybeInflate(await res.arrayBuffer()));
      if (this.disposed || rec.state !== 'loading') return; // unloaded mid-fetch
      const mesh = buildLowresMesh(tile, this.lowresMaterial);
      if (!mesh) {
        rec.state = 'failed'; // all-empty tile: nothing to draw, don't retry
        return;
      }
      // Coarser rings draw first (less overdraw); the dip in buildLowresMesh
      // keeps finer data winning the depth test wherever both are resident.
      mesh.renderOrder = -level;
      releaseAfterUpload(mesh.geometry);
      rec.terrain = mesh;
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
      rec.state = 'built';
      this.pendingAdd.push(key);
      this.invalidate();
      this.emitter.emit('change', this.stats);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        rec.state = 'failed';
        console.warn(`vantage: lowres tile ${key} failed to load:`, e);
      }
    } finally {
      this.inFlight--;
      this.pump();
    }
  }

  private async loadTile(ref: ManifestTile): Promise<void> {
    const key = tileKey(ref.x, ref.z);
    if (this.records.has(key)) return;
    const abort = new AbortController();
    const rec: Record_ = { ref, level: 0, state: 'loading', abort, vertexCount: 0, triangleCount: 0 };
    this.records.set(key, rec);
    this.inFlight++;
    try {
      const url = new URL(ref.path, this.opts.baseUrl).toString();
      const res = await fetch(url, { signal: abort.signal });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
      const buffer = await maybeInflate(await res.arrayBuffer());
      if (this.disposed || rec.state !== 'loading') return; // unloaded mid-fetch

      // VTL6 fast path: keep the on-disk quantized encoding as zero-copy views
      // and let the shared QUANTIZED shader dequantize — no per-vertex CPU work
      // at all, so decoding never causes a frame hitch. Older tile versions
      // take the classic expand-on-CPU path.
      let meshes: TileMeshes;
      const q = parseTileQuantized(buffer);
      if (q) {
        rec.biomes = summarizeSurfaceBiomes(q.surface, q.biomeNames, this.opts.palette);
        rec.surface = { ...q.surface, biome: q.surface.biome.slice(), height: q.surface.height.slice() };
        meshes = buildQuantizedTileMeshes(q, this.opts.material, this.opts.waterMaterial);
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
      if (meshes.water) releaseAfterUpload(meshes.water.geometry);
      rec.terrain = meshes.terrain;
      rec.water = meshes.water;
      this.minY = Math.min(this.minY, meshes.bounds.min.y);
      this.maxY = Math.max(this.maxY, meshes.bounds.max.y);
      // Don't insert into the scene here: adds are staggered one per frame so
      // several tiles finishing together can't stack their GPU uploads into a
      // single frame. update() flushes the queue.
      rec.state = 'built';
      this.pendingAdd.push(key);
      this.invalidate();
      this.emitter.emit('change', this.stats);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        rec.state = 'failed';
        console.warn(`vantage: tile ${key} failed to load:`, e);
      }
    } finally {
      this.inFlight--;
      this.pump();
    }
  }

  private unload(key: string, rec: Record_): void {
    rec.abort?.abort();
    for (const mesh of [rec.terrain, rec.water]) {
      if (!mesh) continue;
      this.opts.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.records.delete(key);
    this.invalidate();
    this.emitter.emit('change', this.stats);
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
    for (const rec of this.records.values()) {
      if (rec.state === 'ready') {
        if (rec.level === 0) loaded++;
        else lowres++;
        vertexCount += rec.vertexCount;
        triangleCount += rec.triangleCount;
        bytes += rec.ref.bytes;
      } else if (rec.state === 'loading' || rec.state === 'built') loading++;
    }
    this.statsCache = { loaded, loading, total: this.index.size, lowres, vertexCount, triangleCount, bytes };
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
    return this.lowresHeightAt(x, z);
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
    for (const [key, rec] of [...this.records]) this.unload(key, rec);
    this.emitter.clear();
  }
}
