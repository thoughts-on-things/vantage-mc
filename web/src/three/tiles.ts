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
  maybeInflate,
  parseTile,
  summarizeBiomes,
  tileKey,
  type BiomeEntry,
  type ManifestTile,
  type Rgb,
  type SurfaceMap,
  type WorldManifest,
} from '../core/index.js';
import { Emitter } from './emitter.js';
import { buildTileMeshes } from './terrain.js';

export interface TileManagerOptions {
  manifest: WorldManifest;
  /** URL the manifest was fetched from — tile paths resolve relative to it. */
  baseUrl: string;
  scene: THREE.Scene;
  /** The shared terrain shader (from {@link createTerrainMaterial}). */
  material: THREE.ShaderMaterial;
  /** The shared water shader (from {@link createWaterMaterial}). */
  waterMaterial: THREE.ShaderMaterial;
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
  /** Tiles fully loaded (in the scene). */
  loaded: number;
  /** Tiles currently fetching/decoding. */
  loading: number;
  /** Total tiles in the manifest. */
  total: number;
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
  state: 'loading' | 'ready' | 'failed';
  abort?: AbortController;
  terrain?: THREE.Mesh;
  water?: THREE.Mesh;
  surface?: SurfaceMap;
  biomes?: BiomeEntry[];
  vertexCount: number;
  triangleCount: number;
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
  private readonly opts: Required<TileManagerOptions>;
  private readonly index = new Map<string, ManifestTile>();
  private readonly records = new Map<string, Record_>();
  private readonly emitter = new Emitter<TileEvents>();
  private readonly tileBlocks: number;

  private queue: ManifestTile[] = [];
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
    this.opts = {
      viewDistance: 768,
      maxTiles: 96,
      concurrency: 4,
      ...options,
    };
    this.tileBlocks = options.manifest.tileBlocks;
    for (const t of options.manifest.tiles) this.index.set(tileKey(t.x, t.z), t);
  }

  /** World-space XZ centre of a tile. */
  private tileCenter(t: ManifestTile): [number, number] {
    return [(t.x + 0.5) * this.tileBlocks, (t.z + 0.5) * this.tileBlocks];
  }

  private distTo(t: ManifestTile, x: number, z: number): number {
    const [cx, cz] = this.tileCenter(t);
    return Math.hypot(cx - x, cz - z);
  }

  /**
   * Re-plan streaming around the focus point (the controls' pivot / the fly
   * camera). Call every frame — it no-ops until the focus has moved a quarter
   * tile, so the cost is a cheap distance check.
   */
  update(focusX: number, focusZ: number): void {
    if (this.disposed) return;
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

    // Desired = nearest maxTiles tiles within viewDistance of the focus.
    const desired: { t: ManifestTile; d: number }[] = [];
    for (const t of this.index.values()) {
      const d = this.distTo(t, focusX, focusZ);
      if (d <= viewDistance) desired.push({ t, d });
    }
    desired.sort((a, b) => a.d - b.d);
    if (desired.length > maxTiles) desired.length = maxTiles;
    const desiredKeys = new Set(desired.map(({ t }) => tileKey(t.x, t.z)));

    // Unload with hysteresis: resident tiles stay until they fall outside
    // 1.25× the view distance (or the budget forces the farthest out).
    const keepDistance = viewDistance * 1.25;
    for (const [key, rec] of this.records) {
      if (desiredKeys.has(key)) continue;
      const d = this.distTo(rec.ref, focusX, focusZ);
      if (rec.state === 'loading') {
        // No longer wanted at all -> abort the fetch outright.
        if (d > keepDistance) this.unload(key, rec);
      } else if (rec.state === 'ready' && d > keepDistance) {
        this.unload(key, rec);
      }
    }

    // Queue what's missing, nearest first.
    this.queue = desired.filter(({ t }) => !this.records.has(tileKey(t.x, t.z))).map(({ t }) => t);
    this.pump();
  }

  private pump(): void {
    while (this.inFlight < this.opts.concurrency && this.queue.length > 0) {
      const ref = this.queue.shift()!;
      void this.loadTile(ref);
    }
  }

  private async loadTile(ref: ManifestTile): Promise<void> {
    const key = tileKey(ref.x, ref.z);
    if (this.records.has(key)) return;
    const abort = new AbortController();
    const rec: Record_ = { ref, state: 'loading', abort, vertexCount: 0, triangleCount: 0 };
    this.records.set(key, rec);
    this.inFlight++;
    try {
      const url = new URL(ref.path, this.opts.baseUrl).toString();
      const res = await fetch(url, { signal: abort.signal });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
      const tile = parseTile(await maybeInflate(await res.arrayBuffer()));
      if (this.disposed || rec.state !== 'loading') return; // unloaded mid-fetch

      // Summaries and bounds read the CPU arrays; do it all before the first
      // render so releaseAfterUpload can drop those arrays at upload time.
      rec.biomes = summarizeBiomes(tile, this.opts.palette);
      // Copy the (small) surface arrays out of the decoded buffer — as
      // zero-copy views they would pin the tile's entire multi-MB ArrayBuffer
      // in the JS heap for as long as the tile is resident.
      rec.surface = tile.surface
        ? { ...tile.surface, biome: tile.surface.biome.slice(), height: tile.surface.height.slice() }
        : undefined;
      const { terrain, water, bounds } = buildTileMeshes(tile, this.opts.palette, this.opts.material, this.opts.waterMaterial);
      terrain.geometry.computeBoundingSphere();
      releaseAfterUpload(terrain.geometry);
      if (water) {
        water.geometry.computeBoundingSphere();
        releaseAfterUpload(water.geometry);
      }
      rec.terrain = terrain;
      rec.water = water;
      rec.vertexCount = tile.vertexCount + (tile.fluid?.vertexCount ?? 0);
      rec.triangleCount = (tile.indexCount + (tile.fluid?.indexCount ?? 0)) / 3;
      rec.state = 'ready';
      this.minY = Math.min(this.minY, bounds.min.y);
      this.maxY = Math.max(this.maxY, bounds.max.y);
      this.opts.scene.add(terrain);
      if (water) this.opts.scene.add(water);
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
    let vertexCount = 0;
    let triangleCount = 0;
    let bytes = 0;
    for (const rec of this.records.values()) {
      if (rec.state === 'ready') {
        loaded++;
        vertexCount += rec.vertexCount;
        triangleCount += rec.triangleCount;
        bytes += rec.ref.bytes;
      } else if (rec.state === 'loading') loading++;
    }
    this.statsCache = { loaded, loading, total: this.index.size, vertexCount, triangleCount, bytes };
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
   *  pivot; null when no tile is resident there (or the column is empty). */
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
    return n === 0 ? null : sum / n;
  };

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
    for (const [key, rec] of [...this.records]) this.unload(key, rec);
    this.emitter.clear();
  }
}
