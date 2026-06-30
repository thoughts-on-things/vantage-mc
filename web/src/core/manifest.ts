// The tiled-map manifest (`map.json`) — the generator↔frontend contract for a
// streamed quadtree map. Emitted by the `vantage map` command (see src/tiling.zig);
// consumed by the streaming `VantageMap` viewer. Kept dependency-free so it can be
// read anywhere the core decoder runs.

/** One tile in the manifest: its quadtree address, file, cache-bust hash, vertex
 *  count, and world-space AABB (`minX,minY,minZ, maxX,maxY,maxZ`). */
export interface MapTile {
  /** Quadtree level: 0 = hires leaf; each step up doubles the footprint. */
  l: number;
  /** Tile X index at this level (world X = `x * tileSize * 2**l`). */
  x: number;
  /** Tile Z index at this level. */
  z: number;
  /** Tile file name, relative to the manifest's directory. */
  file: string;
  /** Content hash (hex) for cache-busting — appended as `?v=` on fetch. */
  h: string;
  /** Vertex count (solid + fluid), for budgeting/debugging. */
  v: number;
  /** World AABB: `[minX, minY, minZ, maxX, maxY, maxZ]`. Frustum culling + framing. */
  box: [number, number, number, number, number, number];
}

/** The whole-map manifest. */
export interface MapManifest {
  format: 'vantage-map';
  version: number;
  /** Tile geometry format magic (e.g. `VTL6`). */
  tileMagic: string;
  /** Hires leaf footprint in blocks. */
  tileSize: number;
  /** Neighbour-block apron each tile was meshed with (informational). */
  apron: number;
  /** Shared texture-array file, relative to the manifest's directory. */
  textures: string;
  /** World block bounds + Y extent. */
  world: { minX: number; minZ: number; maxX: number; maxZ: number; minY: number; maxY: number };
  /** Global biome legend (display names), indexed by biome id. */
  legend: string[];
  /** Every populated tile. */
  tiles: MapTile[];
}

/** A loaded manifest plus the base URL its tile/texture paths resolve against. */
export interface LoadedManifest {
  manifest: MapManifest;
  /** Directory URL of the manifest, with trailing slash (resolve `file`/`textures` against it). */
  baseUrl: string;
}

/** Fetch and parse a `map.json` manifest, returning it with its base URL. */
export async function loadManifest(url: string): Promise<LoadedManifest> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`vantage: ${r.status} ${r.statusText} for ${url}`);
  const manifest = (await r.json()) as MapManifest;
  if (manifest.format !== 'vantage-map') {
    throw new Error(`vantage: not a map manifest (format="${(manifest as { format?: string }).format}")`);
  }
  const baseUrl = url.slice(0, url.lastIndexOf('/') + 1);
  return { manifest, baseUrl };
}
